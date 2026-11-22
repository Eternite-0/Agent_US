'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codexDesktop', {
  isDesktop: true,
  platform: process.platform,
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onMaximizedChange: (cb) => {
    const handler = (_event, state) => cb(Boolean(state));
    ipcRenderer.on('window:maximized-changed', handler);
    return () => ipcRenderer.removeListener('window:maximized-changed', handler);
  },
  captureWindow: () => ipcRenderer.invoke('window:capture'),
  pickDirectory: () => ipcRenderer.invoke('dialog:pick-directory'),
});
