const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('api', {
  openDialog: () => ipcRenderer.invoke('dialog:open'),
  decode: (p) => ipcRenderer.invoke('audio:decode', p),
  pathForFile: (f) => webUtils.getPathForFile(f),
  exportBegin: (o) => ipcRenderer.invoke('export:begin', o),
  exportChunk: (b) => ipcRenderer.invoke('export:chunk', b),
  exportEnd: () => ipcRenderer.invoke('export:end'),
  exportCancel: () => ipcRenderer.invoke('export:cancel'),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  projectSave: (o) => ipcRenderer.invoke('project:save', o),
  projectOpen: (p) => ipcRenderer.invoke('project:open', p),
  micAccess: () => ipcRenderer.invoke('mic:access'),
  recBegin: () => ipcRenderer.invoke('rec:begin'),
  recChunk: (b) => ipcRenderer.invoke('rec:chunk', b),
  recEnd: (sr) => ipcRenderer.invoke('rec:end', sr),
  recCancel: () => ipcRenderer.invoke('rec:cancel'),
  enhance: (p, thr) => ipcRenderer.invoke('audio:enhance', p, thr),
  pickCover: () => ipcRenderer.invoke('cover:pick'),
  readCover: (p) => ipcRenderer.invoke('cover:read', p),
  autosaveWrite: (t) => ipcRenderer.invoke('autosave:write', t),
  autosaveRead: () => ipcRenderer.invoke('autosave:read'),
  autosaveClear: () => ipcRenderer.invoke('autosave:clear'),
  asrStatus: () => ipcRenderer.invoke('asr:status'),
  asrTranscribe: (p) => ipcRenderer.invoke('asr:transcribe', p),
  onAsrProgress: (cb) => {
    const f = (_e, d) => cb(d)
    ipcRenderer.on('asr:progress', f)
    return () => ipcRenderer.removeListener('asr:progress', f)
  },
})
