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

contextBridge.exposeInMainWorld('gpu', {
  info: () => ipcRenderer.invoke('gpu:info'),
  onUpdate: (cb) => ipcRenderer.on('gpu:update', (_e, data) => cb(data)),
});

contextBridge.exposeInMainWorld('model', {
  list: () => ipcRenderer.invoke('model:list'),
  download: (id) => ipcRenderer.invoke('model:download', id),
  setActive: (id) => ipcRenderer.invoke('model:setActive', id),
  remove: (id) => ipcRenderer.invoke('model:delete', id),
  onProgress: (cb) => ipcRenderer.on('model:progress', (_e, data) => cb(data)),
});
