const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('internetManager', {
  chooseDestination: (suggestedName) => ipcRenderer.invoke('download:choose-destination', suggestedName),
  startDownload: (input) => ipcRenderer.invoke('download:start', input),
  pauseDownload: (transferId) => ipcRenderer.invoke('download:pause', transferId),
  resumeDownload: (transferId) => ipcRenderer.invoke('download:resume', transferId),
  retryDownload: (transferId) => ipcRenderer.invoke('download:retry', transferId),
  cancelDownload: (transferId) => ipcRenderer.invoke('download:cancel', transferId),
  setPriority: (transferId, priority) => ipcRenderer.invoke('download:priority', transferId, priority),
  bulkAction: (action, transferIds) => ipcRenderer.invoke('transfers:bulk', action, transferIds),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),
  chooseUploadFiles: () => ipcRenderer.invoke('upload:choose-files'),
  droppedFilePath: (file) => webUtils.getPathForFile(file),
  startUpload: (input) => ipcRenderer.invoke('upload:start', input),
  cancelUpload: (transferId) => ipcRenderer.invoke('upload:cancel', transferId),
  retryUpload: (transferId) => ipcRenderer.invoke('upload:retry', transferId),
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  saveProfile: (profile) => ipcRenderer.invoke('profiles:save', profile),
  deleteProfile: (profileId) => ipcRenderer.invoke('profiles:delete', profileId),
  testProfile: (profileId) => ipcRenderer.invoke('profiles:test', profileId),
  scanUrl: (url) => ipcRenderer.invoke('capture:scan', url),
  closeCapture: () => ipcRenderer.invoke('capture:close'),
  onClipboardUrl: (callback) => {
    const listener = (_event, url) => callback(url)
    ipcRenderer.on('capture:clipboard-url', listener)
    return () => ipcRenderer.removeListener('capture:clipboard-url', listener)
  },
  engineStatus: () => ipcRenderer.invoke('engine:status'),
  onTransferEvent: (callback) => {
    const listener = (_event, message) => callback(message)
    ipcRenderer.on('transfer:event', listener)
    return () => ipcRenderer.removeListener('transfer:event', listener)
  }
})
