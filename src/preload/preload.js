'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
  getStatus: () => ipcRenderer.invoke('dsh:get-status'),
  onError: (cb) => {
    const listener = (_event, message) => cb(message);
    ipcRenderer.on('dsh:error', listener);
    return () => ipcRenderer.removeListener('dsh:error', listener);
  },
  onSetupProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('setup:progress', listener);
    return () => ipcRenderer.removeListener('setup:progress', listener);
  },
});
