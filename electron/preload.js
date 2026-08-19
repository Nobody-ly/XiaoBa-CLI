const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('catscoDesktop', {
  selectFiles: () => ipcRenderer.invoke('catsco:select-files'),
  openWebApp: () => ipcRenderer.invoke('catsco:open-webapp'),
  hideWindow: () => ipcRenderer.invoke('catsco:hide-window'),
});
