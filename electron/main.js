const { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, safeStorage, screen } = require('electron')
const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

let mainWindow = null
let captureWindow = null
let engine = null
let engineReady = false
const transferCache = new Map()
const pendingRequests = new Map()
let engineSettings = { maxConcurrent: 3, globalSpeedLimit: 0 }

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
  return { id: record.id, name: record.name, provider: record.provider, connection }
}

function saveProfileRecords(records) {
  const target = profilesPath()
  writeFileSync(target, JSON.stringify(records, null, 2), 'utf8')
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
    backgroundColor: '#edf3f6',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#edf3f6',
      symbolColor: '#20313d',
      height: 44
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())
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
      frame: false, resizable: true, backgroundColor: '#edf3f6',
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
  if (!profile || !['sftp', 'webdav'].includes(profile.provider) || !profile.name?.trim()) {
    throw new Error('Profil bilgileri eksik.')
  }
  if (profile.provider === 'sftp' && (!profile.connection?.host || !profile.connection?.username)) {
    throw new Error('SFTP sunucusu ve kullanıcı adı gerekli.')
  }
  if (profile.provider === 'webdav' && (!/^https?:\/\//i.test(profile.connection?.url || '') || !profile.connection?.username)) {
    throw new Error('Geçerli WebDAV adresi ve kullanıcı adı gerekli.')
  }
  const records = loadProfileRecords()
  const id = profile.id || crypto.randomUUID()
  const previous = records.find((item) => item.id === id)
  const previousConnection = previous ? decryptConnection(previous) : {}
  const connection = { ...previousConnection, ...profile.connection }
  if (!profile.connection?.password) connection.password = previousConnection.password || ''
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

ipcMain.handle('profiles:test', async (_event, profileId) => {
  const record = loadProfileRecords().find((item) => item.id === profileId)
  if (!record) throw new Error('Bağlantı profili bulunamadı.')
  await sendCommand('profile.test', { provider: record.provider, connection: decryptConnection(record) })
  return true
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

ipcMain.handle('upload:retry', async (_event, transferId) => {
  const transfer = transferCache.get(transferId)
  const profile = loadProfileRecords().find((item) => item.id === transfer?.profileId)
  if (!profile) throw new Error('Bağlantı profili bulunamadı.')
  await sendCommand('upload.retry', { transfer_id: transferId, connection: decryptConnection(profile) })
  return true
})

ipcMain.handle('capture:scan', async (_event, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('Panoda geçerli bir HTTP/HTTPS bağlantısı yok.')
  return sendCommand('scan.start', { url }, 45000)
})

ipcMain.handle('capture:close', () => {
  captureWindow?.hide()
  return true
})

ipcMain.handle('engine:status', () => ({
  ready: engineReady,
  transfers: [...transferCache.values()],
  settings: engineSettings
}))

app.whenReady().then(() => {
  startEngine()
  createWindow()
  const captureShortcut = () => {
    void showCapturePanel().catch((error) => console.error(`Yakalama paneli açılamadı: ${error.message}`))
  }
  if (!globalShortcut.register('CommandOrControl+Alt+D', captureShortcut)) {
    console.error('Ctrl+Alt+D kısayolu başka bir uygulama tarafından kullanılıyor.')
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
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
