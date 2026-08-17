'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
  getStatus: () => ipcRenderer.invoke('dsh:get-status'),
  onError: (cb) => {
    const listener = (_event, message) => cb(message);
    ipcRenderer.on('dsh:error', listener);
    return () => ipcRenderer.removeListener('dsh:error', listener);
  },
});
