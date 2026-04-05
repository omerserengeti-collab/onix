const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('onix', {
  validateLicense: (key) => ipcRenderer.invoke('validate-license', key),
  buyLicense: () => ipcRenderer.invoke('buy-license'),
});
