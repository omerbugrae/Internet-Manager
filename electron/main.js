const { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, Notification, safeStorage, screen, shell, Tray } = require('electron')
const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

let mainWindow = null
let captureWindow = null
let tray = null
let engine = null
let engineReady = false
const transferCache = new Map()
const pendingRequests = new Map()
let engineSettings = { maxConcurrent: 3, globalSpeedLimit: 0 }
let desktopSettings = null

const DEFAULT_DESKTOP_SETTINGS = {
  closeToTray: true,
  notifications: true,
  launchAtStartup: false,
  theme: 'system',
  language: 'tr'
}

const ACTIVITY_TYPES = new Set([
  'download.created', 'download.paused', 'download.retrying', 'download.completed',
  'download.cancelled', 'download.failed', 'upload.created', 'upload.paused',
  'upload.retrying', 'upload.completed', 'upload.cancelled', 'upload.failed',
  'upload.skipped', 'engine.error'
])

function pythonCommand() {
  if (app.isPackaged) {
    return {
      executable: path.join(process.resourcesPath, 'backend', 'internet-manager-engine.exe'),
      args: []
    }
  }

  const virtualEnvironmentPython = path.join(app.getAppPath(), 'venv', 'Scripts', 'python.exe')
  return {
    executable: existsSync(virtualEnvironmentPython) ? virtualEnvironmentPython : 'python',
    args: ['-u', path.join(app.getAppPath(), 'backend', 'main.py')]
  }
}

function sendToRenderer(message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('transfer:event', message)
  }
}

function updateTransferCache(message) {
  if (message.type === 'transfers.snapshot') {
    transferCache.clear()
    for (const transfer of message.transfers) transferCache.set(transfer.transferId, transfer)
    if (message.settings) engineSettings = message.settings
    return
  }
  if (message.type === 'settings.updated') {
    engineSettings = {
      maxConcurrent: message.maxConcurrent,
      globalSpeedLimit: message.globalSpeedLimit
    }
    return
  }
  if (message.type === 'download.created' || message.type === 'upload.created') {
    transferCache.set(message.transferId, message)
    return
  }
  if (!message.transferId) return
  const current = transferCache.get(message.transferId)
  if (!current) return
  const statusByEvent = {
    'download.started': 'downloading',
    'download.queued': 'waiting',
    'download.progress': 'downloading',
    'download.paused': 'paused',
    'download.retrying': 'retrying',
    'download.completed': 'completed',
    'download.cancelled': 'cancelled',
    'download.failed': 'failed',
    'upload.started': 'uploading',
    'upload.queued': 'waiting',
    'upload.progress': 'uploading',
    'upload.paused': 'paused',
    'upload.retrying': 'retrying',
    'upload.completed': 'completed',
    'upload.cancelled': 'cancelled',
    'upload.failed': 'failed',
    'upload.skipped': 'skipped'
  }
  transferCache.set(message.transferId, {
    ...current,
    ...message,
    status: statusByEvent[message.type] || current.status
  })
}

function profilesPath() {
  return path.join(app.getPath('userData'), 'profiles.json')
}

function loadProfileRecords() {
  try {
    return JSON.parse(readFileSync(profilesPath(), 'utf8'))
  } catch {
    return []
  }
}

function decryptConnection(record) {
  return JSON.parse(safeStorage.decryptString(Buffer.from(record.encrypted, 'base64')))
}

function publicProfile(record) {
  const connection = decryptConnection(record)
  delete connection.password
  delete connection.secret_access_key
  delete connection.session_token
  return { id: record.id, name: record.name, provider: record.provider, connection }
}

function saveProfileRecords(records) {
  const target = profilesPath()
  writeFileSync(target, JSON.stringify(records, null, 2), 'utf8')
}

function desktopSettingsPath() {
  return path.join(app.getPath('userData'), 'desktop-settings.json')
}

function loadDesktopSettings() {
  try {
    const saved = JSON.parse(readFileSync(desktopSettingsPath(), 'utf8'))
    return {
      closeToTray: typeof saved.closeToTray === 'boolean' ? saved.closeToTray : true,
      notifications: typeof saved.notifications === 'boolean' ? saved.notifications : true,
      launchAtStartup: typeof saved.launchAtStartup === 'boolean' ? saved.launchAtStartup : false,
      theme: ['system', 'light', 'dark'].includes(saved.theme) ? saved.theme : 'system',
      language: ['tr', 'en'].includes(saved.language) ? saved.language : 'tr'
    }
  } catch {
    return { ...DEFAULT_DESKTOP_SETTINGS }
  }
}

function saveDesktopSettings(settings) {
  writeFileSync(desktopSettingsPath(), JSON.stringify(settings, null, 2), 'utf8')
}

function activityPath() {
  return path.join(app.getPath('userData'), 'activity.json')
}

function loadActivity() {
  try {
    const entries = JSON.parse(readFileSync(activityPath(), 'utf8'))
    return Array.isArray(entries) ? entries : []
  } catch {
    return []
  }
}

function recordActivity(message) {
  if (!ACTIVITY_TYPES.has(message.type)) return
  try {
    const transfer = message.transferId ? transferCache.get(message.transferId) : null
    const entries = loadActivity()
    entries.unshift({
      id: crypto.randomUUID(),
      transferId: message.transferId || null,
      type: message.type,
      direction: transfer?.direction || (message.type.startsWith('upload.') ? 'upload' : 'download'),
      title: transfer
        ? path.basename(transfer.direction === 'upload' ? transfer.sourcePath : transfer.destination)
        : null,
      message: message.message || null,
      createdAt: new Date().toISOString()
    })
    writeFileSync(activityPath(), JSON.stringify(entries.slice(0, 500), null, 2), 'utf8')
  } catch (error) {
    console.error(`Aktivite günlüğü yazılamadı: ${error.message}`)
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  mainWindow.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

function createTray() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect x="2" y="2" width="28" height="28" rx="9" fill="#1d1d1f"/><path d="M8 11h16" stroke="#0a84ff" stroke-width="4" stroke-linecap="round"/><path d="M8 21h16" stroke="#ff9f0a" stroke-width="4" stroke-linecap="round"/><circle cx="24" cy="7" r="3" fill="#32d74b"/></svg>'
  const icon = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`).resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.setToolTip('Internet Manager')
  rebuildTrayMenu()
  tray.on('double-click', showMainWindow)
}

function rebuildTrayMenu() {
  if (!tray) return
  const english = desktopSettings?.language === 'en'
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: english ? 'Show Internet Manager' : 'Internet Manager’ı göster', click: showMainWindow },
    { label: english ? 'Smart capture' : 'Akıllı yakalama', click: () => void showCapturePanel() },
    { type: 'separator' },
    { label: english ? 'Quit' : 'Çıkış', click: () => { app.isQuitting = true; app.quit() } }
  ]))
}

function showTransferNotification(message) {
  if (!desktopSettings?.notifications || !Notification.isSupported()) return
  if (!['download.completed', 'download.failed', 'upload.completed', 'upload.failed'].includes(message.type)) return
  const transfer = transferCache.get(message.transferId)
  const title = transfer
    ? path.basename(transfer.direction === 'upload' ? transfer.sourcePath : transfer.destination)
    : 'Internet Manager'
  const completed = message.type.endsWith('.completed')
  const english = desktopSettings.language === 'en'
  try {
    const notification = new Notification({
      title,
      body: completed
        ? (english ? 'Transfer completed.' : 'Transfer tamamlandı.')
        : (message.message || (english ? 'Transfer failed.' : 'Transfer başarısız.'))
    })
    notification.on('click', showMainWindow)
    notification.show()
  } catch (error) {
    console.error(`Bildirim gösterilemedi: ${error.message}`)
  }
}

function titleBarOverlay() {
  const dark = desktopSettings?.theme === 'dark' || (desktopSettings?.theme === 'system' && nativeTheme.shouldUseDarkColors)
  return { color: dark ? '#1c1c1e' : '#f5f5f7', symbolColor: dark ? '#f5f5f7' : '#1d1d1f', height: 56 }
}

function windowBackground() {
  const dark = desktopSettings?.theme === 'dark' || (desktopSettings?.theme === 'system' && nativeTheme.shouldUseDarkColors)
  return dark ? '#1c1c1e' : '#f5f5f7'
}

function startEngine() {
  const command = pythonCommand()
  engine = spawn(command.executable, command.args, {
    cwd: app.getAppPath(),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      INTERNET_MANAGER_DATA_DIR: path.join(app.getPath('userData'), 'data')
    }
  })

  const output = createInterface({ input: engine.stdout })
  output.on('line', (line) => {
    try {
      const message = JSON.parse(line)
      if (message.type === 'engine.ready') engineReady = true
      if (message.requestId && pendingRequests.has(message.requestId)) {
        const pending = pendingRequests.get(message.requestId)
        pendingRequests.delete(message.requestId)
        clearTimeout(pending.timeout)
        if (message.type === 'engine.error') pending.reject(new Error(message.message))
        else if (message.type === 'engine.ack') pending.resolve(message.result)
      }
      updateTransferCache(message)
      recordActivity(message)
      showTransferNotification(message)
      if (!(message.type === 'engine.error' && message.requestId)) sendToRenderer(message)
    } catch {
      sendToRenderer({ type: 'engine.error', message: 'Transfer motorundan geçersiz yanıt alındı.' })
    }
  })

  engine.stderr.on('data', (chunk) => {
    console.error(`[python] ${chunk.toString().trimEnd()}`)
  })

  engine.on('error', () => {
    engineReady = false
    sendToRenderer({
      type: 'engine.error',
      message: 'Python transfer motoru başlatılamadı. Sanal ortamı ve bağımlılıkları kontrol edin.'
    })
  })

  engine.on('exit', (code) => {
    engineReady = false
    engine = null
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Transfer motoru kapandı.'))
    }
    pendingRequests.clear()
    if (!app.isQuitting && code !== 0) {
      sendToRenderer({ type: 'engine.error', message: 'Transfer motoru beklenmedik biçimde kapandı.' })
    }
  })
}

function sendCommand(type, payload = {}, timeoutMs = 10000) {
  if (!engine || !engine.stdin.writable) {
    throw new Error('Transfer motoru hazır değil.')
  }

  const requestId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId)
      reject(new Error('Transfer motoru zamanında yanıt vermedi.'))
    }, timeoutMs)
    pendingRequests.set(requestId, { resolve, reject, timeout })
    engine.stdin.write(`${JSON.stringify({ request_id: requestId, type, payload })}\n`)
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: windowBackground(),
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('close', (event) => {
    if (!app.isQuitting && desktopSettings?.closeToTray) {
      event.preventDefault()
      mainWindow.hide()
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })
}

async function showCapturePanel() {
  let url = ''
  try {
    const clipboardText = await clipboard.readText()
    url = typeof clipboardText === 'string' ? clipboardText.trim() : ''
  } catch (error) {
    console.error(`Pano okunamadı: ${error.message}`)
  }

  if (!captureWindow || captureWindow.isDestroyed()) {
    const area = screen.getPrimaryDisplay().workArea
    captureWindow = new BrowserWindow({
      width: 390, height: Math.min(680, area.height - 40),
      x: area.x + area.width - 410, y: area.y + 20,
      show: false, alwaysOnTop: true, skipTaskbar: true,
      frame: false, resizable: true, backgroundColor: windowBackground(),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
    captureWindow.loadFile(path.join(__dirname, 'renderer', 'capture.html'))
  }
  captureWindow.show()
  captureWindow.focus()
  if (captureWindow.webContents.isLoading()) {
    captureWindow.webContents.once('did-finish-load', () => captureWindow.webContents.send('capture:clipboard-url', url))
  } else {
    captureWindow.webContents.send('capture:clipboard-url', url)
  }
}

ipcMain.handle('download:choose-destination', async (_event, suggestedName) => {
  const safeName = typeof suggestedName === 'string' && suggestedName.trim()
    ? suggestedName.replace(/[<>:"/\\|?*]/g, '_')
    : 'download'

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'İndirilecek dosyayı kaydet',
    defaultPath: safeName
  })
  return result.canceled ? null : result.filePath
})

ipcMain.handle('upload:choose-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Yüklenecek dosyaları seç', properties: ['openFile', 'multiSelections']
  })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('download:start', async (_event, input) => {
  if (!input || typeof input.url !== 'string' || typeof input.destination !== 'string') {
    throw new Error('İndirme bilgileri eksik.')
  }
  if (!/^https?:\/\//i.test(input.url)) {
    throw new Error('Bağlantı http:// veya https:// ile başlamalı.')
  }

  const transferId = crypto.randomUUID()
  const result = await sendCommand('download.start', {
    transfer_id: transferId,
    url: input.url,
    destination: input.destination,
    conflict_policy: ['overwrite', 'rename', 'skip'].includes(input.conflictPolicy)
      ? input.conflictPolicy
      : 'overwrite',
    speed_limit: Number.isFinite(input.speedLimit) && input.speedLimit > 0
      ? Math.round(input.speedLimit)
      : 0
  })
  return { transferId, ...result }
})

ipcMain.handle('download:cancel', async (_event, transferId) => {
  if (typeof transferId !== 'string' || !transferId) return false
  await sendCommand('download.cancel', { transfer_id: transferId })
  return true
})

ipcMain.handle('download:pause', async (_event, transferId) => {
  if (typeof transferId !== 'string' || !transferId) return false
  await sendCommand('download.pause', { transfer_id: transferId })
  return true
})

ipcMain.handle('download:resume', async (_event, transferId) => {
  if (typeof transferId !== 'string' || !transferId) return false
  await sendCommand('download.resume', { transfer_id: transferId })
  return true
})

ipcMain.handle('download:retry', async (_event, transferId) => {
  if (typeof transferId !== 'string' || !transferId) return false
  await sendCommand('download.retry', { transfer_id: transferId })
  return true
})

ipcMain.handle('download:priority', async (_event, transferId, priority) => {
  if (typeof transferId !== 'string' || !Number.isInteger(priority)) return false
  await sendCommand('download.priority', { transfer_id: transferId, priority })
  return true
})

ipcMain.handle('transfers:bulk', async (_event, action, transferIds) => {
  if (!['pause', 'resume', 'cancel'].includes(action) || !Array.isArray(transferIds)) return false
  await sendCommand('transfers.bulk', { action, transfer_ids: transferIds })
  return true
})

ipcMain.handle('settings:update', async (_event, settings) => {
  const maxConcurrent = Number(settings?.maxConcurrent)
  const globalSpeedLimit = Number(settings?.globalSpeedLimit)
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 12) {
    throw new Error('Eşzamanlı transfer sayısı 1–12 arasında olmalı.')
  }
  if (!Number.isFinite(globalSpeedLimit) || globalSpeedLimit < 0) {
    throw new Error('Hız limiti geçerli değil.')
  }
  await sendCommand('settings.update', {
    max_concurrent: maxConcurrent,
    global_speed_limit: Math.round(globalSpeedLimit)
  })
  return true
})

ipcMain.handle('profiles:list', () => loadProfileRecords().map(publicProfile))

ipcMain.handle('profiles:save', (_event, profile) => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows güvenli depolama hizmeti kullanılamıyor.')
  if (!profile || !['sftp', 'webdav', 's3'].includes(profile.provider) || !profile.name?.trim()) {
    throw new Error('Profil bilgileri eksik.')
  }
  if (profile.provider === 'sftp' && (!profile.connection?.host || !profile.connection?.username)) {
    throw new Error('SFTP sunucusu ve kullanıcı adı gerekli.')
  }
  if (profile.provider === 'webdav' && (!/^https?:\/\//i.test(profile.connection?.url || '') || !profile.connection?.username)) {
    throw new Error('Geçerli WebDAV adresi ve kullanıcı adı gerekli.')
  }
  if (profile.provider === 's3' && (!profile.connection?.bucket || !profile.connection?.access_key_id)) {
    throw new Error('S3 bucket ve erişim anahtarı gerekli.')
  }
  if (profile.provider === 's3' && profile.connection?.endpoint_url && !/^https?:\/\//i.test(profile.connection.endpoint_url)) {
    throw new Error('S3 endpoint HTTP veya HTTPS adresi olmalı.')
  }
  const records = loadProfileRecords()
  const id = profile.id || crypto.randomUUID()
  const previous = records.find((item) => item.id === id)
  const previousConnection = previous?.provider === profile.provider ? decryptConnection(previous) : {}
  let connection
  if (profile.provider === 'sftp') {
    connection = {
      host: profile.connection.host, port: Number(profile.connection.port) || 22,
      username: profile.connection.username,
      password: profile.connection.password || previousConnection.password || ''
    }
  } else if (profile.provider === 'webdav') {
    connection = {
      url: profile.connection.url, username: profile.connection.username,
      password: profile.connection.password || previousConnection.password || ''
    }
  } else {
    connection = {
      endpoint_url: profile.connection.endpoint_url || '', region: profile.connection.region || '',
      bucket: profile.connection.bucket, access_key_id: profile.connection.access_key_id,
      secret_access_key: profile.connection.secret_access_key || previousConnection.secret_access_key || '',
      session_token: profile.connection.session_token || previousConnection.session_token || ''
    }
  }
  const record = {
    id, name: profile.name.trim(), provider: profile.provider,
    encrypted: safeStorage.encryptString(JSON.stringify(connection)).toString('base64')
  }
  const next = records.filter((item) => item.id !== id)
  next.push(record)
  saveProfileRecords(next)
  return publicProfile(record)
})

ipcMain.handle('profiles:delete', (_event, profileId) => {
  saveProfileRecords(loadProfileRecords().filter((item) => item.id !== profileId))
  return true
})

ipcMain.handle('profiles:export', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Bağlantı profillerini dışa aktar', defaultPath: 'internet-manager-profilleri.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePath) return 0
  const profiles = loadProfileRecords().map(publicProfile)
  writeFileSync(result.filePath, JSON.stringify({ formatVersion: 1, profiles }, null, 2), 'utf8')
  return profiles.length
})

ipcMain.handle('profiles:import', async () => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows güvenli depolama hizmeti kullanılamıyor.')
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Bağlantı profillerini içe aktar', properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePaths[0]) return 0
  const document = JSON.parse(readFileSync(result.filePaths[0], 'utf8'))
  if (document?.formatVersion !== 1 || !Array.isArray(document.profiles)) {
    throw new Error('Bu profil dosyasının biçimi desteklenmiyor.')
  }
  const records = loadProfileRecords()
  let imported = 0
  for (const profile of document.profiles) {
    if (!profile?.name || !['sftp', 'webdav', 's3'].includes(profile.provider) || typeof profile.connection !== 'object') continue
    const connection = { ...profile.connection }
    delete connection.password
    delete connection.secret_access_key
    delete connection.session_token
    records.push({
      id: crypto.randomUUID(), name: `${profile.name} (içe aktarıldı)`, provider: profile.provider,
      encrypted: safeStorage.encryptString(JSON.stringify(connection)).toString('base64')
    })
    imported += 1
  }
  saveProfileRecords(records)
  return imported
})

ipcMain.handle('profiles:test', async (_event, profileId) => {
  const record = loadProfileRecords().find((item) => item.id === profileId)
  if (!record) throw new Error('Bağlantı profili bulunamadı.')
  return sendCommand('profile.test', { provider: record.provider, connection: decryptConnection(record) }, 30000)
})

ipcMain.handle('provider:list', async (_event, profileId, remotePath) => {
  const record = loadProfileRecords().find((item) => item.id === profileId)
  if (!record) throw new Error('Bağlantı profili bulunamadı.')
  return sendCommand('provider.list', {
    provider: record.provider,
    connection: decryptConnection(record),
    path: typeof remotePath === 'string' ? remotePath : ''
  }, 30000)
})

ipcMain.handle('upload:start', async (_event, input) => {
  const profile = loadProfileRecords().find((item) => item.id === input?.profileId)
  if (!profile || typeof input.sourcePath !== 'string' || typeof input.remotePath !== 'string') {
    throw new Error('Yükleme bilgileri eksik.')
  }
  const transferId = crypto.randomUUID()
  return sendCommand('upload.start', {
    transfer_id: transferId, source_path: input.sourcePath, remote_path: input.remotePath,
    provider: profile.provider, profile_id: profile.id, connection: decryptConnection(profile),
    conflict_policy: ['overwrite', 'rename', 'skip'].includes(input.conflictPolicy) ? input.conflictPolicy : 'overwrite',
    speed_limit: Number.isFinite(input.speedLimit) ? Math.max(Math.round(input.speedLimit), 0) : 0
  })
})

ipcMain.handle('upload:cancel', async (_event, transferId) => {
  await sendCommand('upload.cancel', { transfer_id: transferId })
  return true
})

ipcMain.handle('upload:pause', async (_event, transferId) => {
  await sendCommand('upload.pause', { transfer_id: transferId })
  return true
})

ipcMain.handle('upload:retry', async (_event, transferId) => {
  const transfer = transferCache.get(transferId)
  const profile = loadProfileRecords().find((item) => item.id === transfer?.profileId)
  if (!profile) throw new Error('Bağlantı profili bulunamadı.')
  await sendCommand('upload.retry', { transfer_id: transferId, connection: decryptConnection(profile) })
  return true
})

ipcMain.handle('capture:scan', async (_event, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { items: [], error: 'Geçerli bir HTTP/HTTPS bağlantısı gir.' }
  }
  return sendCommand('scan.start', { url }, 45000)
})

ipcMain.handle('capture:close', () => {
  captureWindow?.hide()
  return true
})

ipcMain.handle('clipboard:write', async (_event, value) => {
  if (typeof value !== 'string' || !value) return false
  await clipboard.writeText(value)
  return true
})

ipcMain.handle('desktop-settings:get', () => desktopSettings)

ipcMain.handle('desktop-settings:update', (_event, input) => {
  desktopSettings = {
    closeToTray: Boolean(input?.closeToTray),
    notifications: Boolean(input?.notifications),
    launchAtStartup: Boolean(input?.launchAtStartup),
    theme: ['system', 'light', 'dark'].includes(input?.theme) ? input.theme : 'system',
    language: ['tr', 'en'].includes(input?.language) ? input.language : 'tr'
  }
  saveDesktopSettings(desktopSettings)
  app.setLoginItemSettings({
    openAtLogin: desktopSettings.launchAtStartup,
    path: process.execPath,
    args: app.isPackaged ? [] : [app.getAppPath()]
  })
  rebuildTrayMenu()
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitleBarOverlay(titleBarOverlay())
  mainWindow?.webContents.send('desktop-settings:changed', desktopSettings)
  return desktopSettings
})

ipcMain.handle('activity:list', () => loadActivity())
ipcMain.handle('activity:clear', () => {
  writeFileSync(activityPath(), '[]', 'utf8')
  return true
})

ipcMain.handle('transfer:open', async (_event, transferId, mode) => {
  const transfer = transferCache.get(transferId)
  if (!transfer) throw new Error('Transfer bulunamadı.')
  const target = transfer.direction === 'upload' ? transfer.sourcePath : transfer.destination
  if (typeof target !== 'string' || !target) throw new Error('Dosya yolu bulunamadı.')
  if (mode === 'folder') {
    shell.showItemInFolder(target)
    return true
  }
  const error = await shell.openPath(target)
  if (error) throw new Error(error)
  return true
})

ipcMain.handle('engine:status', () => ({
  ready: engineReady,
  transfers: [...transferCache.values()],
  settings: engineSettings
}))

app.whenReady().then(() => {
  app.setAppUserModelId('com.internetmanager.desktop')
  desktopSettings = loadDesktopSettings()
  startEngine()
  createWindow()
  createTray()
  nativeTheme.on('updated', () => {
    if (desktopSettings.theme === 'system' && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitleBarOverlay(titleBarOverlay())
    }
  })
  const captureShortcut = () => {
    void showCapturePanel().catch((error) => console.error(`Yakalama paneli açılamadı: ${error.message}`))
  }
  if (!globalShortcut.register('CommandOrControl+Alt+D', captureShortcut)) {
    console.error('Ctrl+Alt+D kısayolu başka bir uygulama tarafından kullanılıyor.')
  }

  app.on('activate', () => {
    showMainWindow()
  })
})

app.on('before-quit', () => {
  app.isQuitting = true
  if (engine && engine.stdin.writable) {
    try {
      void sendCommand('engine.shutdown')
    } catch {
      engine.kill()
    }
  }
})

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
