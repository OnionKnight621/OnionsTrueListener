const { app, BrowserWindow, session, ipcMain, clipboard, Menu, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const {
  initWhisper,
  toggleNativeLog,
  addNativeLogListener,
} = require('@fugood/whisper.node');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const { cleanup } = require('./cleanup');

// Safety net: log instead of popping the blocking "JS error" dialog (e.g. a
// stray stream callback firing during shutdown). Real bugs still hit the console.
process.on('uncaughtException', (err) => console.error('[uncaught]', err));

// ---------- Models ----------
// Models aren't bundled (too big for a release). They are downloaded on demand
// into userData; a dev copy sitting next to the code wins (so we don't re-fetch).
const MODEL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
const CATALOG = [
  { id: 'large-v3', file: 'ggml-large-v3.bin', gb: 3.1, label: 'Large-v3', note: 'Best quality · heavier (~3–4 GB VRAM)', recommended: 'normal' },
  { id: 'large-v3-turbo', file: 'ggml-large-v3-turbo.bin', gb: 1.6, label: 'Large-v3 Turbo', note: 'Almost as good · faster · lighter', recommended: 'smaller' },
  { id: 'medium', file: 'ggml-medium.bin', gb: 1.5, label: 'Medium', note: 'Decent · multilingual' },
  { id: 'small', file: 'ggml-small.bin', gb: 0.5, label: 'Small', note: 'Fast · weak at Ukrainian' },
];
const DEFAULT_MODEL = 'large-v3';

const modelById = (id) => CATALOG.find((m) => m.id === id);
const userModelDir = () => path.join(app.getPath('userData'), 'models');

// Resolved path for a model id: a dev copy next to the code wins, else userData.
function modelFilePath(id) {
  const m = modelById(id);
  if (!m) return null;
  const local = path.join(__dirname, 'models', m.file);
  return fs.existsSync(local) ? local : path.join(userModelDir(), m.file);
}
const isDownloaded = (id) => { const p = modelFilePath(id); return !!p && fs.existsSync(p); };
const activeModelId = () => loadConfig().model || DEFAULT_MODEL;
const modelPath = () => modelFilePath(activeModelId());

// ---------- Cleanup LLM (optional second pass) ----------
// Single hard-coded model for now; the model-picker UI comes later (see
// CLEANUP_MODEL_PLAN.md). Resolution mirrors whisper: a dev copy in ./models wins.
const LLM = {
  file: 'gemma-3-4b-it-Q4_K_M.gguf',
  label: 'Gemma 3 4B',
  url: 'https://huggingface.co/ggml-org/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf',
};
function llmModelPath() {
  const local = path.join(__dirname, 'models', LLM.file);
  return fs.existsSync(local) ? local : path.join(userModelDir(), LLM.file);
}
const llmDownloaded = () => fs.existsSync(llmModelPath());
const cleanupEnabled = () => !!loadConfig().cleanup;

let mainWindow = null;
let activeReq = null; // in-flight model download (so we can abort it on close)

// ---------- Push-to-talk hotkey ----------
// A hotkey is a set of keys that must be held simultaneously. This covers a
// single key (F9), modifier+key (Ctrl+Space) and modifier-only combos (Ctrl+Win).
let ptt = { keys: [UiohookKey.F9] };
let CONFIG_PATH = null; // set once app is ready

// Treat right-hand modifiers as their left-hand equivalent so the side doesn't matter.
const NORM = {};
if (UiohookKey.CtrlRight) NORM[UiohookKey.CtrlRight] = UiohookKey.Ctrl;
if (UiohookKey.AltRight) NORM[UiohookKey.AltRight] = UiohookKey.Alt;
if (UiohookKey.ShiftRight) NORM[UiohookKey.ShiftRight] = UiohookKey.Shift;
if (UiohookKey.MetaRight) NORM[UiohookKey.MetaRight] = UiohookKey.Meta;
const norm = (code) => (code in NORM ? NORM[code] : code);

const pressed = new Set(); // normalized keycodes currently held down

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function saveConfig(patch) {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...loadConfig(), ...patch }, null, 2)); } catch {}
}

const KEY_LABEL = {
  [UiohookKey.Ctrl]: 'Ctrl',
  [UiohookKey.Alt]: 'Alt',
  [UiohookKey.Shift]: 'Shift',
  [UiohookKey.Meta]: 'Win',
};
function keyName(code) {
  if (KEY_LABEL[code]) return KEY_LABEL[code];
  const entry = Object.entries(UiohookKey).find(([, v]) => v === code);
  return entry ? entry[0] : `Key#${code}`;
}
function pttDisplay(p) {
  const order = [UiohookKey.Ctrl, UiohookKey.Alt, UiohookKey.Shift, UiohookKey.Meta];
  const rank = (k) => { const i = order.indexOf(k); return i === -1 ? 99 : i; };
  return [...p.keys].sort((a, b) => rank(a) - rank(b)).map(keyName).join('+');
}
function comboSatisfied() {
  return ptt.keys.length > 0 && ptt.keys.every((k) => pressed.has(k));
}

// ---------- GPU / backend selection ----------
// Unified approach: CUDA only on Blackwell (our prebuilt is cc 12.0), Vulkan for
// every other GPU (NVIDIA 10xx+, AMD, Intel), CPU as a last resort.
// We DETECT the GPU up front rather than trying CUDA blindly — a cc-12.0 binary
// loads on an older card but aborts at kernel launch (uncatchable).
const VARIANT_LABEL = { cuda: 'CUDA', vulkan: 'Vulkan', default: 'CPU' };
let gpuInfo = null;        // { name, cc } or null
let plannedBackend = 'vulkan';
let activeBackend = null;  // confirmed once a context is built
let detectPromise = null;

function detectGpu() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=name,compute_cap', '--format=csv,noheader'],
      { windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const [name, cc] = stdout.trim().split('\n')[0].split(',').map((s) => s.trim());
        resolve({ name, cc: parseFloat(cc) });
      });
  });
}
async function detectBackend() {
  gpuInfo = await detectGpu();
  const forced = process.env.OTL_BACKEND; // e.g. OTL_BACKEND=vulkan for testing
  if (forced && VARIANT_LABEL[forced]) plannedBackend = forced;
  else plannedBackend = gpuInfo && gpuInfo.cc >= 12.0 ? 'cuda' : 'vulkan';
  return plannedBackend;
}
// Order to try: the planned backend first, then safe fallbacks. CUDA is only ever
// planned for Blackwell, so we never launch its kernels on an incompatible card.
function backendOrder() {
  const fallbacks = ['vulkan', 'default'];
  if (plannedBackend === 'cuda') return ['cuda', ...fallbacks];
  return [plannedBackend, ...fallbacks.filter((b) => b !== plannedBackend)];
}
function shortGpuName(n) {
  return (n || 'CPU').replace(/^NVIDIA\s+GeForce\s+/i, '').replace(/^NVIDIA\s+/i, '');
}
function gpuLabel() {
  return { name: shortGpuName(gpuInfo && gpuInfo.name), backend: VARIANT_LABEL[activeBackend || plannedBackend] };
}
function sendGpu() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('gpu:update', gpuLabel());
}

// ---------- Whisper ----------
let contextPromise = null;
function getContext() {
  if (contextPromise) return contextPromise;
  contextPromise = (async () => {
    for (const variant of backendOrder()) {
      try {
        console.log('[whisper] init', variant, '·', activeModelId());
        const ctx = await initWhisper({ filePath: modelPath(), useGpu: variant !== 'default' }, variant);
        activeBackend = variant;
        saveConfig({ backend: variant });
        sendGpu();
        return ctx;
      } catch (e) {
        console.warn('[whisper] backend', variant, 'failed:', e.message);
      }
    }
    throw new Error('no working whisper backend');
  })();
  return contextPromise;
}
async function releaseContext() {
  if (!contextPromise) return;
  const p = contextPromise;
  contextPromise = null;
  try { (await p).release(); } catch {}
}

// ---------- Paste into the focused field (clipboard + Ctrl+V) ----------
// In a packaged build the script lives in app.asar.unpacked (PowerShell can't read asar).
const HELPER = path.join(__dirname, 'win-paste.ps1').replace('app.asar', 'app.asar.unpacked');
let targetHwnd = 0; // foreground window captured when the hotkey was pressed

function runHelper(args) {
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', HELPER, ...args],
      { windowsHide: true },
      (_err, stdout) => resolve((stdout || '').trim())
    );
  });
}

// Remember the target window on key-down, while it still has focus.
// The helper returns "HWND|Title"; parseInt reads the leading handle.
function captureForeground() {
  runHelper(['-Capture']).then((out) => {
    const n = parseInt(out, 10);
    if (n) targetHwnd = n;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 680,
    height: 470,
    useContentSize: true,
    frame: false, // custom pixel-art chrome
    resizable: false,
    backgroundColor: '#120e24',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required', // let AudioContext run without an in-window click
    },
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('close', () => { try { activeReq?.abort(); } catch {} });
  mainWindow.on('closed', () => { mainWindow = null; });
}

ipcMain.handle('whisper:transcribe', async (_event, arrayBuffer, language) => {
  const context = await getContext();
  const t0 = Date.now();
  const { promise } = context.transcribeData(arrayBuffer, {
    language: language || 'uk', // 'uk' keeps embedded English terms inside Ukrainian speech
  });
  const result = await promise;
  const ms = Date.now() - t0;
  console.log(`[whisper] "${result.result?.trim()}" (${result.language}, ${ms}ms)`);
  return { text: (result.result || '').trim(), language: result.language, ms };
});

// ---------- Cleanup LLM ----------
ipcMain.handle('cleanup:info', () => ({
  label: LLM.label, downloaded: llmDownloaded(), enabled: cleanupEnabled(),
}));

ipcMain.handle('cleanup:setEnabled', (_e, on) => {
  saveConfig({ cleanup: !!on });
  return { enabled: cleanupEnabled() };
});

// Tidy the transcript. No-op (returns the input) unless enabled and downloaded —
// cleanup.js itself also fails open, so paste is never blocked by the LLM.
ipcMain.handle('cleanup:run', async (_e, text) => {
  if (!cleanupEnabled() || !llmDownloaded()) return text;
  return cleanup(text, llmModelPath());
});

ipcMain.handle('paste:text', async (_event, text) => {
  if (!text) return false;
  clipboard.writeText(text); // also serves as auto-copy / manual-paste fallback
  await runHelper(['-Hwnd', String(targetHwnd)]);
  return true;
});

ipcMain.handle('app:copy', (_event, text) => {
  if (text) clipboard.writeText(text);
  return true;
});

// ---------- Model management ----------
function downloadToFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.part';
    const file = fs.createWriteStream(tmp);
    const req = net.request(url); // net follows HTTPS redirects (HF -> CDN)
    activeReq = req;
    const finish = (fn) => { activeReq = null; fn(); };
    req.on('response', (res) => {
      if (res.statusCode !== 200) { finish(() => reject(new Error('HTTP ' + res.statusCode))); return; }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let done = 0;
      res.on('data', (chunk) => {
        done += chunk.length;
        if (!file.write(chunk)) { res.pause(); file.once('drain', () => res.resume()); }
        if (total) onProgress(done / total);
      });
      res.on('end', () => file.end(() => finish(() => { fs.renameSync(tmp, dest); resolve(); })));
      res.on('error', (e) => finish(() => reject(e)));
    });
    req.on('abort', () => finish(() => reject(new Error('aborted'))));
    req.on('error', (e) => finish(() => reject(e)));
    req.end();
  });
}

let downloading = false;

// Full model list with download/active flags, for the UI.
ipcMain.handle('model:list', () => ({
  active: activeModelId(),
  items: CATALOG.map((m) => ({
    id: m.id, label: m.label, note: m.note, gb: m.gb,
    recommended: m.recommended || null,
    downloaded: isDownloaded(m.id),
  })),
}));

ipcMain.handle('model:download', async (_e, id) => {
  const m = modelById(id);
  if (!m) return { ok: false, error: 'unknown model' };
  if (downloading) return { ok: false, error: 'already downloading' };
  downloading = true;
  try {
    const dest = path.join(userModelDir(), m.file);
    await downloadToFile(MODEL_BASE + m.file, dest, (pct) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('model:progress', { id, pct });
      }
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    downloading = false;
  }
});

// Switch the active model; the context is rebuilt lazily on next transcription.
ipcMain.handle('model:setActive', async (_e, id) => {
  if (!modelById(id)) return { ok: false, error: 'unknown model' };
  if (id !== activeModelId()) {
    saveConfig({ model: id });
    await releaseContext();
  }
  return { ok: true };
});

ipcMain.handle('model:delete', async (_e, id) => {
  const m = modelById(id);
  if (!m) return { ok: false, error: 'unknown model' };
  if (id === activeModelId()) await releaseContext(); // free the file handle first
  try { fs.rmSync(path.join(userModelDir(), m.file), { force: true }); } catch {}
  return { ok: true };
});

ipcMain.handle('gpu:info', async () => { await detectPromise; return gpuLabel(); });

// ---------- Frameless window controls ----------
ipcMain.on('win:minimize', () => mainWindow?.minimize());
ipcMain.on('win:close', () => {
  try { activeReq?.abort(); } catch {}
  try { uIOhook.stop(); } catch {}
  app.exit(0);
});

// ---------- Global push-to-talk via uiohook ----------
let pttDown = false;
// While capturing a new hotkey we record the largest set of keys held at once
// and commit it when every key is released.
let capture = null;

function finishCapture(keys) {
  if (!capture) return;
  const { resolve, timer } = capture;
  clearTimeout(timer);
  capture = null;
  if (!keys || keys.length === 0) {
    resolve({ name: pttDisplay(ptt), cancelled: true });
    return;
  }
  ptt = { keys };
  saveConfig({ ptt });
  console.log('[ptt] hotkey set to:', pttDisplay(ptt));
  resolve({ name: pttDisplay(ptt) });
}

function setupHotkey() {
  uIOhook.on('keydown', (e) => {
    const code = norm(e.keycode);

    if (capture) {
      if (e.keycode === UiohookKey.Escape) { finishCapture(null); return; }
      capture.set.add(code);
      capture.max = new Set(capture.set);
      return;
    }

    pressed.add(code);
    if (!pttDown && comboSatisfied()) {
      pttDown = true;
      captureForeground();
      mainWindow?.webContents.send('ptt:start');
    }
  });

  uIOhook.on('keyup', (e) => {
    const code = norm(e.keycode);

    if (capture) {
      capture.set.delete(code);
      if (capture.set.size === 0 && capture.max && capture.max.size > 0) {
        finishCapture([...capture.max]);
      }
      return;
    }

    pressed.delete(code);
    if (pttDown && !comboSatisfied()) {
      pttDown = false;
      mainWindow?.webContents.send('ptt:stop');
    }
  });

  uIOhook.start();
  console.log('[ptt] global hotkey active:', pttDisplay(ptt));
}

ipcMain.handle('hotkey:get', () => ({ name: pttDisplay(ptt) }));

// Capture a new hotkey: press a key/combo and release (Esc cancels).
ipcMain.handle('hotkey:capture', () => {
  return new Promise((resolve) => {
    if (capture) finishCapture(null);
    capture = { resolve, set: new Set(), max: null, timer: null };
    capture.timer = setTimeout(() => finishCapture(null), 10000);
  });
});

app.whenReady().then(() => {
  toggleNativeLog(true);
  addNativeLogListener((_level, text) => process.stdout.write(`[native] ${text}`));

  Menu.setApplicationMenu(null);

  CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
  const cfg = loadConfig();
  if (cfg.ptt && Array.isArray(cfg.ptt.keys) && cfg.ptt.keys.length) ptt = { keys: cfg.ptt.keys };

  createWindow();
  setupHotkey();

  // Detect the GPU/backend, then warm up the model if it's already present.
  detectPromise = detectBackend().then(() => {
    sendGpu();
    if (fs.existsSync(modelPath())) getContext();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  try { uIOhook.stop(); } catch {}
  // Force exit: the native threads (uiohook/whisper) otherwise keep the process
  // alive, so ✕ would hang and require Task Manager to kill it.
  app.exit(0);
});
