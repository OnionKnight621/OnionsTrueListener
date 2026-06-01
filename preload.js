const { contextBridge, ipcRenderer } = require('electron');

// Міст renderer (аудіо/UI) ↔ main (GPU-транскрипція, хоткей, вставка)
contextBridge.exposeInMainWorld('whisper', {
  // ArrayBuffer PCM 16-bit mono 16kHz + код мови ('uk'|'en'|'auto') → { text, language, ms }
  transcribe: (arrayBuffer, language) =>
    ipcRenderer.invoke('whisper:transcribe', arrayBuffer, language),
});

contextBridge.exposeInMainWorld('actions', {
  // вставити текст у активне поле (clipboard + Ctrl+V)
  paste: (text) => ipcRenderer.invoke('paste:text', text),
  // скопіювати текст у буфер обміну (кнопка «Копіювати»)
  copy: (text) => ipcRenderer.invoke('app:copy', text),
});

// Події глобального push-to-talk хоткея
contextBridge.exposeInMainWorld('ptt', {
  onStart: (cb) => ipcRenderer.on('ptt:start', () => cb()),
  onStop: (cb) => ipcRenderer.on('ptt:stop', () => cb()),
});
