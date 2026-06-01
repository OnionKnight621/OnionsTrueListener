const { app, BrowserWindow, session, ipcMain, clipboard, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const {
  initWhisper,
  toggleNativeLog,
  addNativeLogListener,
} = require('@fugood/whisper.node');
const { uIOhook, UiohookKey } = require('uiohook-napi');

const MODEL_PATH = path.join(__dirname, 'models', 'ggml-large-v3.bin');

let mainWindow = null;

// --- Push-to-talk хоткей (налаштовується з UI, дефолт F9) ---
// Хоткей = набір клавіш, що мають бути натиснуті ОДНОЧАСНО. Покриває одиночну
// клавішу (F9), модифікатор+клавішу (Ctrl+Space) і чисті модифікатори (Ctrl+Win).
// ptt = { keys: [keycode, ...] }
let ptt = { keys: [UiohookKey.F9] };
let CONFIG_PATH = null; // зʼявиться після app.ready

// Нормалізуємо праві модифікатори до лівих, щоб не вимагати конкретну сторону
const NORM = {};
if (UiohookKey.CtrlRight) NORM[UiohookKey.CtrlRight] = UiohookKey.Ctrl;
if (UiohookKey.AltRight) NORM[UiohookKey.AltRight] = UiohookKey.Alt;
if (UiohookKey.ShiftRight) NORM[UiohookKey.ShiftRight] = UiohookKey.Shift;
if (UiohookKey.MetaRight) NORM[UiohookKey.MetaRight] = UiohookKey.Meta;
const norm = (code) => (code in NORM ? NORM[code] : code);

const pressed = new Set(); // нормалізовані keycodes, що натиснуті зараз

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
// хоткей «натиснутий», якщо всі його клавіші зараз утримуються
function comboSatisfied() {
  return ptt.keys.length > 0 && ptt.keys.every((k) => pressed.has(k));
}

// --- Whisper: лінива ініціалізація + прогрів ---
let contextPromise = null;
function getContext() {
  if (!contextPromise) {
    console.log('[whisper] initializing CUDA context…');
    contextPromise = initWhisper({ filePath: MODEL_PATH, useGpu: true }, 'cuda');
  }
  return contextPromise;
}

// --- Вставка тексту в активне поле: clipboard + Ctrl+V (кирилиця-безпечно) ---
const HELPER = path.join(__dirname, 'win-paste.ps1');
let targetHwnd = 0; // активне вікно в момент натискання хоткея (куди вставляти)

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

// Запамʼятати активне вікно (на keydown, поки фокус ще на цільовому полі)
function captureForeground() {
  runHelper(['-Capture']).then((out) => {
    const sep = out.indexOf('|');
    const n = parseInt(sep >= 0 ? out.slice(0, sep) : out, 10);
    const title = sep >= 0 ? out.slice(sep + 1) : '';
    if (n) targetHwnd = n;
    console.log('[ptt] captured target hwnd:', targetHwnd, '| title:', JSON.stringify(title));
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 560,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // дозволяємо AudioContext працювати без кліку у вікні (для PTT)
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });

  mainWindow.loadFile('index.html');
}

// Транскрипція (main-процес, нативний CUDA-модуль)
ipcMain.handle('whisper:transcribe', async (_event, arrayBuffer, language) => {
  const context = await getContext();
  const t0 = Date.now();
  const { promise } = context.transcribeData(arrayBuffer, {
    language: language || 'uk', // основна мова диктовки (uk тримає англ. терміни всередині)
  });
  const result = await promise;
  const ms = Date.now() - t0;
  console.log(`[whisper] "${result.result?.trim()}" (${result.language}, ${ms}ms)`);
  return { text: (result.result || '').trim(), language: result.language, ms };
});

// Вставка тексту туди, де курсор
ipcMain.handle('paste:text', async (_event, text) => {
  if (!text) return false;
  console.log('[paste] into hwnd:', targetHwnd, '| text len:', text.length);
  const prev = clipboard.readText();
  clipboard.writeText(text);
  // повертаємо фокус на запамʼятоване вікно (де стояв курсор) і шлемо Ctrl+V
  const r = await runHelper(['-Hwnd', String(targetHwnd)]);
  console.log('[paste] helper:', r);
  // відновити попередній буфер трохи згодом (щоб встигла вставка)
  setTimeout(() => clipboard.writeText(prev), 800);
  return true;
});

// Копіювання тексту з UI у буфер обміну (для кнопки «Копіювати»)
ipcMain.handle('app:copy', (_event, text) => {
  if (text) clipboard.writeText(text);
  return true;
});

// --- Глобальний push-to-talk через uiohook ---
let pttDown = false;
// Режим захоплення хоткея: збираємо найбільший набір одночасно натиснутих клавіш,
// фіксуємо його, коли всі клавіші відпущено.
let capture = null; // { resolve, set:Set, max:Set, timer }

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

    // Режим захоплення нового хоткея
    if (capture) {
      if (e.keycode === UiohookKey.Escape) { finishCapture(null); return; } // скасувати
      capture.set.add(code);
      capture.max = new Set(capture.set); // запамʼятовуємо найбільший набір
      return;
    }

    pressed.add(code);
    if (!pttDown && comboSatisfied()) {
      pttDown = true;
      captureForeground(); // запамʼятати цільове поле, поки фокус ще там
      mainWindow?.webContents.send('ptt:start');
    }
  });

  uIOhook.on('keyup', (e) => {
    const code = norm(e.keycode);

    if (capture) {
      capture.set.delete(code);
      if (capture.set.size === 0 && capture.max && capture.max.size > 0) {
        finishCapture([...capture.max]); // всі клавіші відпущено → фіксуємо комбо
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

// Поточний хоткей для UI
ipcMain.handle('hotkey:get', () => ({ name: pttDisplay(ptt) }));

// Захоплення нового хоткея: натисни клавішу/комбо й відпусти (Esc — скасувати)
ipcMain.handle('hotkey:capture', () => {
  return new Promise((resolve) => {
    if (capture) finishCapture(null); // скасувати попереднє захоплення
    capture = { resolve, set: new Set(), max: null, timer: null };
    capture.timer = setTimeout(() => finishCapture(null), 10000);
  });
});

app.whenReady().then(() => {
  toggleNativeLog(true);
  addNativeLogListener((_level, text) => process.stdout.write(`[native] ${text}`));

  Menu.setApplicationMenu(null); // прибрати дефолтне меню File/Edit/View/Window

  // завантажити збережений хоткей (якщо є)
  CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
  const cfg = loadConfig();
  if (cfg.ptt && Array.isArray(cfg.ptt.keys) && cfg.ptt.keys.length) ptt = { keys: cfg.ptt.keys };

  createWindow();
  setupHotkey();
  getContext(); // прогрів моделі у фоні

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  try { uIOhook.stop(); } catch {}
  // форсований вихід: нативні треди (uiohook/whisper) інакше тримають процес
  // живим → ✕ «зависає» і доводиться вбивати через диспетчер задач
  app.exit(0);
});
