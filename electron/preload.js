const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('internetManager', {
  chooseDestination: (suggestedName) => ipcRenderer.invoke('download:choose-destination', suggestedName),
  chooseDownloadFolder: () => ipcRenderer.invoke('download:choose-folder'),
  startDownload: (input) => ipcRenderer.invoke('download:start', input),
  bulkStartDownloads: (input) => ipcRenderer.invoke('download:bulk-start', input),
  parseBulkFile: () => ipcRenderer.invoke('bulk:parse-file'),
  probeUrls: (urls) => ipcRenderer.invoke('bulk:probe', urls),
  scheduleTransfer: (transferId, scheduledAt, repeatRule) => ipcRenderer.invoke('transfer:schedule', transferId, scheduledAt, repeatRule),
  getAutomation: () => ipcRenderer.invoke('automation:get'),
  updateAutomation: (input) => ipcRenderer.invoke('automation:update', input),
  reportNetworkStatus: (online) => ipcRenderer.invoke('network:changed', online),
  runSystemAction: (action) => ipcRenderer.invoke('system:action', action),
  listTemplates: () => ipcRenderer.invoke('templates:list'),
  saveTemplate: (template) => ipcRenderer.invoke('templates:save', template),
  deleteTemplate: (templateId) => ipcRenderer.invoke('templates:delete', templateId),
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
  pauseUpload: (transferId) => ipcRenderer.invoke('upload:pause', transferId),
  cancelUpload: (transferId) => ipcRenderer.invoke('upload:cancel', transferId),
  retryUpload: (transferId) => ipcRenderer.invoke('upload:retry', transferId),
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  saveProfile: (profile) => ipcRenderer.invoke('profiles:save', profile),
  deleteProfile: (profileId) => ipcRenderer.invoke('profiles:delete', profileId),
  exportProfiles: () => ipcRenderer.invoke('profiles:export'),
  importProfiles: () => ipcRenderer.invoke('profiles:import'),
  testProfile: (profileId) => ipcRenderer.invoke('profiles:test', profileId),
  listRemote: (profileId, path) => ipcRenderer.invoke('provider:list', profileId, path),
  copyText: (value) => ipcRenderer.invoke('clipboard:write', value),
  getDesktopSettings: () => ipcRenderer.invoke('desktop-settings:get'),
  updateDesktopSettings: (settings) => ipcRenderer.invoke('desktop-settings:update', settings),
  listActivity: () => ipcRenderer.invoke('activity:list'),
  clearActivity: () => ipcRenderer.invoke('activity:clear'),
  openTransfer: (transferId, mode) => ipcRenderer.invoke('transfer:open', transferId, mode),
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
  },
  onDesktopSettingsChanged: (callback) => {
    const listener = (_event, settings) => callback(settings)
    ipcRenderer.on('desktop-settings:changed', listener)
    return () => ipcRenderer.removeListener('desktop-settings:changed', listener)
  },
  onQuickAddUrls: (callback) => {
    const listener = (_event, urls) => callback(urls)
    ipcRenderer.on('quick-add:urls', listener)
    return () => ipcRenderer.removeListener('quick-add:urls', listener)
  },
  onQuickAddFiles: (callback) => {
    const listener = (_event, paths) => callback(paths)
    ipcRenderer.on('quick-add:files', listener)
    return () => ipcRenderer.removeListener('quick-add:files', listener)
  },
  onClipboardSuggestion: (callback) => {
    const listener = (_event, url) => callback(url)
    ipcRenderer.on('clipboard:suggestion', listener)
    return () => ipcRenderer.removeListener('clipboard:suggestion', listener)
  }
})
