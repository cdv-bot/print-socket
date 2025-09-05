// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('printersAPI', {
  listPrinters: () => ipcRenderer.invoke('printers:list'),
  setDefault: (name) => ipcRenderer.invoke('printers:setDefault', name),
  printTest: (name) => ipcRenderer.invoke('printers:printTest', name),
  openLogs: () => ipcRenderer.invoke('app:openLogs')
});