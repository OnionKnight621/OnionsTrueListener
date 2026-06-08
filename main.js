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

// The model isn't bundled (too big for a release). Use a dev copy next to the
// code if present, otherwise the one downloaded into userData on first run.
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin';
const LOCAL_MODEL = path.join(__dirname, 'models', 'ggml-large-v3.bin');
const userModelPath = () => path.join(app.getPath('userData'), 'models', 'ggml-large-v3.bin');
const modelPath = () => (fs.existsSync(LOCAL_MODEL) ? LOCAL_MODEL : userModelPath());

let mainWindow = null;

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

// ---------- Whisper ----------
// Lazily create the context once and keep it warm.
let contextPromise = null;
function getContext() {
  if (!contextPromise) {
    console.log('[whisper] initializing CUDA context…');
    contextPromise = initWhisper({ filePath: modelPath(), useGpu: true }, 'cuda');
  }
  return contextPromise;
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

// ---------- Model download (first run) ----------
function downloadModel(onProgress) {
  return new Promise((resolve, reject) => {
    const dest = userModelPath();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.part';
    const file = fs.createWriteStream(tmp);
    const req = net.request(MODEL_URL); // net follows HTTPS redirects (HF -> CDN)
    req.on('response', (res) => {
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let done = 0;
      res.on('data', (chunk) => {
        done += chunk.length;
        if (!file.write(chunk)) { res.pause(); file.once('drain', () => res.resume()); }
        if (total) onProgress(done / total);
      });
      res.on('end', () => file.end(() => { fs.renameSync(tmp, dest); resolve(); }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

let downloading = false;
ipcMain.handle('model:status', () => ({ present: fs.existsSync(modelPath()) }));
ipcMain.handle('model:download', async () => {
  if (downloading) return { ok: false, error: 'already downloading' };
  downloading = true;
  try {
    await downloadModel((pct) => mainWindow?.webContents.send('model:progress', pct));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    downloading = false;
  }
});

// ---------- Frameless window controls ----------
ipcMain.on('win:minimize', () => mainWindow?.minimize());
ipcMain.on('win:close', () => {
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
  if (fs.existsSync(modelPath())) getContext(); // warm up only if the model is present

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
