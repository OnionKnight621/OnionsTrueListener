const { contextBridge, ipcRenderer } = require('electron');

// IPC bridge: renderer (audio/UI) <-> main (GPU transcription, hotkey, paste).
contextBridge.exposeInMainWorld('whisper', {
  // arrayBuffer: PCM 16-bit mono 16kHz; language: 'uk' | 'en' | 'auto' -> { text, language, ms }
  transcribe: (arrayBuffer, language) =>
    ipcRenderer.invoke('whisper:transcribe', arrayBuffer, language),
});

contextBridge.exposeInMainWorld('actions', {
  paste: (text) => ipcRenderer.invoke('paste:text', text),
  copy: (text) => ipcRenderer.invoke('app:copy', text),
});

contextBridge.exposeInMainWorld('ptt', {
  onStart: (cb) => ipcRenderer.on('ptt:start', () => cb()),
  onStop: (cb) => ipcRenderer.on('ptt:stop', () => cb()),
});

contextBridge.exposeInMainWorld('hotkey', {
  get: () => ipcRenderer.invoke('hotkey:get'),
  capture: () => ipcRenderer.invoke('hotkey:capture'),
});

contextBridge.exposeInMainWorld('win', {
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),
});

contextBridge.exposeInMainWorld('model', {
  status: () => ipcRenderer.invoke('model:status'),
  download: () => ipcRenderer.invoke('model:download'),
  onProgress: (cb) => ipcRenderer.on('model:progress', (_e, pct) => cb(pct)),
});
