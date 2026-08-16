const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('syncApp', {
  chooseFolder: (kind) => ipcRenderer.invoke('choose-folder', kind),
  chooseSrtFile: () => ipcRenderer.invoke('choose-srt-file'),
  scanProject: (settings) => ipcRenderer.invoke('scan-project', settings),
  detectHardware: () => ipcRenderer.invoke('detect-hardware'),
  start: (settings) => ipcRenderer.invoke('start-processing', settings),
  cancel: () => ipcRenderer.invoke('cancel-processing'),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  resizeToContent: (height) => ipcRenderer.send('resize-window-to-content', height),
  onProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('processing-progress', listener);
    return () => ipcRenderer.removeListener('processing-progress', listener);
  }
});
