const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('api', {
  dataBase: ipcRenderer.sendSync('get-data-base'),
  uniGet: () => ipcRenderer.invoke('uni:get'),
  uniDetect: () => ipcRenderer.invoke('uni:detect'),
  uniBrowse: () => ipcRenderer.invoke('uni:browse'),
  uniSet: (dir) => ipcRenderer.invoke('uni:set', dir),
  uniUse: (r, l, k, f) => ipcRenderer.invoke('uni:use', r, l, k, f),
  uniUndo: () => ipcRenderer.invoke('uni:undo'),
  scan: () => ipcRenderer.invoke('data:scan'),
  importFiles: (region, lang, kind, paths) => ipcRenderer.invoke('data:import', region, lang, kind, paths),
  openData: () => ipcRenderer.invoke('data:open'),
  namesGet: () => ipcRenderer.invoke('names:get'),
  namesSet: (key, name) => ipcRenderer.invoke('names:set', key, name),
  readText: (region, lang, kind, file) => ipcRenderer.invoke('data:read', region, lang, kind, file),
  move: (fromKind, toKind, files) => ipcRenderer.invoke('data:move', fromKind, toKind, files),
  remove: (region, lang, kind, files) => ipcRenderer.invoke('data:delete', region, lang, kind, files),
  syncCheck: (mode) => ipcRenderer.invoke('sync:check', mode), // 'update' | 'all' | [paths]
  syncList: () => ipcRenderer.invoke('sync:list'),
  onSync: (cb) => {
    const h = (_e, ev) => cb(ev);
    ipcRenderer.on('sync:event', h);
    return () => ipcRenderer.removeListener('sync:event', h);
  },
  pathOf: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } }
});
