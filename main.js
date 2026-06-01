const { app, BrowserWindow, session, ipcMain, clipboard, Menu } = require('electron');
const path = require('path');
const { execFile } = require('child_process');
const {
  initWhisper,
  toggleNativeLog,
  addNativeLogListener,
} = require('@fugood/whisper.node');
const { uIOhook, UiohookKey } = require('uiohook-napi');

const MODEL_PATH = path.join(__dirname, 'models', 'ggml-large-v3.bin');
const PTT_KEY = UiohookKey.F9; // push-to-talk: тримай F9

let mainWindow = null;

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
let targetHwnd = 0; // активне вікно в момент натискання F9 (куди вставляти)

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
    const n = parseInt(out, 10);
    if (n) targetHwnd = n;
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
  const prev = clipboard.readText();
  clipboard.writeText(text);
  // повертаємо фокус на запамʼятоване вікно (де стояв курсор) і шлемо Ctrl+V
  await runHelper(['-Hwnd', String(targetHwnd)]);
  // відновити попередній буфер трохи згодом (щоб встигла вставка)
  setTimeout(() => clipboard.writeText(prev), 600);
  return true;
});

// Копіювання тексту з UI у буфер обміну (для кнопки «Копіювати»)
ipcMain.handle('app:copy', (_event, text) => {
  if (text) clipboard.writeText(text);
  return true;
});

// --- Глобальний push-to-talk через uiohook ---
let pttDown = false;
function setupHotkey() {
  uIOhook.on('keydown', (e) => {
    if (e.keycode === PTT_KEY && !pttDown) {
      pttDown = true;
      captureForeground(); // запамʼятати цільове поле, поки фокус ще там
      mainWindow?.webContents.send('ptt:start');
    }
  });
  uIOhook.on('keyup', (e) => {
    if (e.keycode === PTT_KEY && pttDown) {
      pttDown = false;
      mainWindow?.webContents.send('ptt:stop');
    }
  });
  uIOhook.start();
  console.log('[ptt] global hotkey active: hold F9 to dictate');
}

app.whenReady().then(() => {
  toggleNativeLog(true);
  addNativeLogListener((_level, text) => process.stdout.write(`[native] ${text}`));

  Menu.setApplicationMenu(null); // прибрати дефолтне меню File/Edit/View/Window
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
