function icon(paths, size = 16) {
  return `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
}
const ICON_ARROW_DOWN = icon('<path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/>', 17)
const ICON_ARROW_UP = icon('<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>', 17)
const ICON_CHEVRON_UP = icon('<path d="M18 15l-6-6-6 6"/>', 11)
const ICON_CHEVRON_DOWN = icon('<path d="M6 9l6 6 6-6"/>', 11)
const ICON_FOLDER = icon('<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>', 15)
const ICON_FILE = icon('<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>', 15)
const ICON_CHEVRON_RIGHT = icon('<path d="M9 6l6 6-6 6"/>', 13)

const dialog = document.querySelector('#download-dialog')
const form = document.querySelector('#download-form')
const urlInput = document.querySelector('#download-url')
const destinationInput = document.querySelector('#download-destination')
const conflictPolicy = document.querySelector('#conflict-policy')
const taskSpeedLimit = document.querySelector('#task-speed-limit')
const chooseDestinationButton = document.querySelector('#choose-destination-button')
const formError = document.querySelector('#form-error')
const emptyState = document.querySelector('#empty-state')
const transferList = document.querySelector('#transfer-list')
const activeCount = document.querySelector('#active-count')
const engineStatus = document.querySelector('#engine-status')
const toast = document.querySelector('#toast')
const transfers = new Map()
let profiles = []
let uploadFiles = []
let editingProfileId = null
const uploadDialog = document.querySelector('#upload-dialog')
const profileDialog = document.querySelector('#profile-dialog')
const remoteDialog = document.querySelector('#remote-dialog')
let remoteBrowserPath = '/'
const settingsDialog = document.querySelector('#settings-dialog')
const activityDialog = document.querySelector('#activity-dialog')
const detailsDialog = document.querySelector('#details-dialog')
let desktopSettings = { closeToTray: true, notifications: true, launchAtStartup: false, theme: 'system', language: 'tr' }
let currentTransferFilter = 'all'
let detailsTransferId = null

const translations = {
  tr: {
    newDownload: 'Yeni indirme', newUpload: 'Yeni yükleme', allTransfers: 'Tüm transferler', downloads: 'İndirilenler', uploads: 'Yüklenenler',
    activity: 'Aktivite', settings: 'Ayarlar', desktopSettings: 'MASAÜSTÜ AYARLARI', settingsTitle: 'Uygulama sana ayak uydursun.',
    closeToTray: 'Kapatınca arka planda çalış', closeToTrayHelp: 'Pencere kapanır, transferler sistem tepsisinde sürer.',
    notifications: 'Bildirimler', notificationsHelp: 'Tamamlanan ve başarısız transferleri bildir.', launchAtStartup: 'Windows ile başlat',
    launchAtStartupHelp: 'Oturum açıldığında Internet Manager hazır olsun.', theme: 'Tema', language: 'Dil', themeSystem: 'Sistem', themeLight: 'Açık', themeDark: 'Koyu',
    shortcuts: 'Kısayollar', smartCapture: 'Akıllı yakalama', cancel: 'Vazgeç', saveSettings: 'Ayarları kaydet', activityLog: 'AKTİVİTE GÜNLÜĞÜ',
    activityTitle: 'Hattın yakın geçmişi.', all: 'Tümü', errors: 'Hatalar', clear: 'Temizle', transferDetails: 'TRANSFER AYRINTILARI', openFolder: 'Klasörü aç', openFile: 'Dosyayı aç',
    engineWaiting: 'Motor bekleniyor', engineReady: 'Motor hazır', engineError: 'Motor hatası', sidebarNote: 'Bağlantıyı bırak.\nRotayı biz yönetelim.',
    liveDesk: 'CANLI TRANSFER MASASI', heroLine1: 'Transferler', activeTransfer: 'aktif transfer',
    selectAll: 'Tümünü seç', pause: 'Duraklat', resume: 'Devam et', reconnect: 'Yeniden bağlan', retry: 'Yeniden dene', copyAddress: 'Adresi kopyala',
    cancelAction: 'İptal', concurrent: 'Eşzamanlı', globalLimit: 'Genel limit', unitMbps: 'MB/sn', apply: 'Uygula', details: 'Ayrıntılar',
    queueEmpty: 'KUYRUK BOŞ', emptyTitle: 'İlk rotayı oluştur.', emptyBody: 'Bir bağlantı ekle veya dosyayı pencereye bırak. Kuyruk, hız ve hedef tek masadan yönetilsin.', newRoute: 'Yeni rota',
    newDownloadEyebrow: 'YENİ İNDİRME', closeWindow: 'Pencereyi kapat', downloadHeading: 'Bağlantıyı nereye indirelim?', fileLink: 'Dosya bağlantısı',
    saveLocation: 'Kayıt konumu', noLocationChosen: 'Henüz bir konum seçilmedi', choose: 'Seç', ifSameName: 'Aynı isimde dosya varsa',
    overwrite: 'Üzerine yaz', renameNew: 'Yeni bir ad oluştur', skipThis: 'Bu indirmeyi atla', skip: 'Atla', taskSpeedLimit: 'Bu indirme için hız limiti',
    discard: 'Vazgeç', startDownload: 'İndirmeyi başlat',
    newUploadEyebrow: 'YENİ YÜKLEME', uploadHeading: 'Dosyaları hedefe gönder.', localFiles: 'Yerel dosyalar', noFileChosen: 'Dosya seçilmedi',
    connectionProfile: 'Bağlantı profili', manage: 'Yönet', remoteFolder: 'Uzak klasör', browse: 'Göz at',
    capabilityNoteDefault: 'Profil seçildiğinde hedef yetenekleri burada görünür.', uploadSpeedLimit: 'Yükleme hız limiti', startUpload: 'Yüklemeyi başlat',
    connectionProfileEyebrow: 'BAĞLANTI PROFİLİ', newTarget: 'Yeni hedef ekle.', profileName: 'Profil adı', protocol: 'Protokol',
    server: 'Sunucu', port: 'Port', webdavAddress: 'WebDAV adresi', username: 'Kullanıcı adı', password: 'Parola',
    s3Endpoint: 'S3 endpoint', optional: 'isteğe bağlı', region: 'Bölge', bucket: 'Bucket', accessKeyId: 'Access key ID',
    secretAccessKey: 'Secret access key', sessionToken: 'Session token', importProfiles: 'İçe aktar', exportProfiles: 'Dışa aktar',
    secretsNotWritten: 'Parolalar ve gizli anahtarlar dosyaya yazılmaz.', close: 'Kapat', saveProfile: 'Profili kaydet',
    remoteTargetEyebrow: 'UZAK HEDEF', addFolderToRoute: 'Klasörü rotaya ekle.', parentFolder: 'Üst klasör', foldersLoading: 'Klasörler getiriliyor…', selectThisFolder: 'Bu klasörü seç',
    transferFilters: 'Transfer filtreleri', s3Compatible: 'S3 uyumlu', activityFilter: 'Aktivite filtresi',
    selectTransfer: 'Transferi seç', downloadProgress: 'İndirme ilerlemesi'
  },
  en: {
    newDownload: 'New download', newUpload: 'New upload', allTransfers: 'All transfers', downloads: 'Downloads', uploads: 'Uploads',
    activity: 'Activity', settings: 'Settings', desktopSettings: 'DESKTOP SETTINGS', settingsTitle: 'Make the app work your way.',
    closeToTray: 'Keep running when closed', closeToTrayHelp: 'The window closes while transfers continue in the system tray.',
    notifications: 'Notifications', notificationsHelp: 'Notify when transfers complete or fail.', launchAtStartup: 'Launch with Windows',
    launchAtStartupHelp: 'Keep Internet Manager ready after sign-in.', theme: 'Theme', language: 'Language', themeSystem: 'System', themeLight: 'Light', themeDark: 'Dark',
    shortcuts: 'Shortcuts', smartCapture: 'Smart capture', cancel: 'Cancel', saveSettings: 'Save settings', activityLog: 'ACTIVITY LOG',
    activityTitle: 'The line’s recent history.', all: 'All', errors: 'Errors', clear: 'Clear', transferDetails: 'TRANSFER DETAILS', openFolder: 'Open folder', openFile: 'Open file',
    engineWaiting: 'Engine starting', engineReady: 'Engine ready', engineError: 'Engine error', sidebarNote: 'Let go of the connection.\nWe’ll manage the route.',
    liveDesk: 'LIVE TRANSFER DESK', heroLine1: 'Transfers', activeTransfer: 'active transfer',
    selectAll: 'Select all', pause: 'Pause', resume: 'Resume', reconnect: 'Reconnect', retry: 'Retry', copyAddress: 'Copy address',
    cancelAction: 'Cancel', concurrent: 'Concurrent', globalLimit: 'Global limit', unitMbps: 'MB/s', apply: 'Apply', details: 'Details',
    queueEmpty: 'QUEUE EMPTY', emptyTitle: 'Start your first route.', emptyBody: 'Add a link or drop a file onto the window. Queue, speed, and destination — one desk.', newRoute: 'New route',
    newDownloadEyebrow: 'NEW DOWNLOAD', closeWindow: 'Close window', downloadHeading: 'Where should we download this to?', fileLink: 'File link',
    saveLocation: 'Save location', noLocationChosen: 'No location chosen yet', choose: 'Choose', ifSameName: 'If a file with the same name exists',
    overwrite: 'Overwrite', renameNew: 'Create a new name', skipThis: 'Skip this download', skip: 'Skip', taskSpeedLimit: 'Speed limit for this download',
    discard: 'Discard', startDownload: 'Start download',
    newUploadEyebrow: 'NEW UPLOAD', uploadHeading: 'Send files to their destination.', localFiles: 'Local files', noFileChosen: 'No file chosen',
    connectionProfile: 'Connection profile', manage: 'Manage', remoteFolder: 'Remote folder', browse: 'Browse',
    capabilityNoteDefault: 'Destination capabilities appear here once a profile is chosen.', uploadSpeedLimit: 'Upload speed limit', startUpload: 'Start upload',
    connectionProfileEyebrow: 'CONNECTION PROFILE', newTarget: 'Add a new destination.', profileName: 'Profile name', protocol: 'Protocol',
    server: 'Server', port: 'Port', webdavAddress: 'WebDAV address', username: 'Username', password: 'Password',
    s3Endpoint: 'S3 endpoint', optional: 'optional', region: 'Region', bucket: 'Bucket', accessKeyId: 'Access key ID',
    secretAccessKey: 'Secret access key', sessionToken: 'Session token', importProfiles: 'Import', exportProfiles: 'Export',
    secretsNotWritten: 'Passwords and secret keys are never written to the file.', close: 'Close', saveProfile: 'Save profile',
    remoteTargetEyebrow: 'REMOTE TARGET', addFolderToRoute: 'Add a folder to the route.', parentFolder: 'Parent folder', foldersLoading: 'Fetching folders…', selectThisFolder: 'Select this folder',
    transferFilters: 'Transfer filters', s3Compatible: 'S3 compatible', activityFilter: 'Activity filter',
    selectTransfer: 'Select transfer', downloadProgress: 'Download progress'
  }
}

function t(key) {
  return translations[desktopSettings.language]?.[key] || translations.tr[key] || key
}

function showDialog() {
  form.reset()
  hideFormError()
  dialog.showModal()
  urlInput.focus()
}

function closeDialog() {
  dialog.close()
  hideFormError()
}

document.querySelector('#new-download-button').addEventListener('click', showDialog)
document.querySelector('#empty-download-button').addEventListener('click', showDialog)
document.querySelector('#new-upload-button').addEventListener('click', showUploadDialog)
document.querySelectorAll('.close-dialog').forEach((button) => {
  button.addEventListener('click', closeDialog)
})
dialog.addEventListener('cancel', () => hideFormError())

urlInput.addEventListener('change', () => {
  if (!destinationInput.value) chooseDestinationButton.focus()
})

chooseDestinationButton.addEventListener('click', async () => {
  const destination = await window.internetManager.chooseDestination(filenameFromUrl(urlInput.value))
  if (destination) destinationInput.value = destination
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  hideFormError()
  const url = urlInput.value.trim()

  if (!url || !urlInput.validity.valid || !/^https?:\/\//i.test(url)) {
    showFormError('Geçerli bir HTTP veya HTTPS bağlantısı girin.')
    urlInput.focus()
    return
  }
  if (!destinationInput.value) {
    showFormError('Dosyanın kaydedileceği konumu seçin.')
    chooseDestinationButton.focus()
    return
  }

  try {
    const result = await window.internetManager.startDownload({
      url,
      destination: destinationInput.value,
      conflictPolicy: conflictPolicy.value,
      speedLimit: Math.max(Number(taskSpeedLimit.value) || 0, 0) * 1024 * 1024
    })
    if (result.skipped) {
      closeDialog()
      showToast('Aynı adlı dosya zaten bulunduğu için indirme atlandı.')
      return
    }
    ensureTransfer({
      transferId: result.transferId,
      url,
      destination: result.destination || destinationInput.value,
      status: 'waiting',
      downloadedBytes: 0,
      totalBytes: null
    })
    closeDialog()
  } catch (error) {
    showFormError(error.message || 'İndirme başlatılamadı.')
  }
})

function filenameFromUrl(value) {
  try {
    const pathname = new URL(value).pathname
    return decodeURIComponent(pathname.split('/').filter(Boolean).pop() || 'download')
  } catch {
    return 'download'
  }
}

function ensureTransfer(record) {
  const existing = transfers.get(record.transferId)
  if (existing) {
    Object.assign(existing, record)
    renderTransfer(existing)
    return existing
  }

  const card = document.createElement('article')
  card.className = `transfer-card ${record.direction || 'download'}`
  card.dataset.transferId = record.transferId
  card.innerHTML = `
    <input class="transfer-select" type="checkbox" aria-label="${t('selectTransfer')}" />
    <div class="file-glyph" aria-hidden="true">${record.direction === 'upload' ? ICON_ARROW_UP : ICON_ARROW_DOWN}</div>
    <div class="transfer-info">
      <p class="transfer-title"></p>
      <div class="transfer-meta"><span class="status"></span><span class="mode-badge"></span><span class="size"></span><span class="speed">—</span><span class="remaining">—</span></div>
      <div class="progress-track" role="progressbar" aria-label="${t('downloadProgress')}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="progress-fill"></div></div>
    </div>
    <div class="card-actions"></div>`
  const transfer = {
    downloadedBytes: 0,
    totalBytes: null,
    status: 'waiting',
    active: false,
    ...record,
    card
  }
  transfers.set(record.transferId, transfer)
  transferList.append(card)
  renderTransfer(transfer)
  updateBoard()
  return transfer
}

function renderTransfer(transfer) {
  const { card } = transfer
  const visiblePath = transfer.direction === 'upload' ? transfer.sourcePath : transfer.destination
  const filename = visiblePath?.split(/[\\/]/).pop() || filenameFromUrl(transfer.url)
  const percent = transfer.totalBytes
    ? Math.min(transfer.downloadedBytes / transfer.totalBytes * 100, 100)
    : 0
  card.className = `transfer-card ${transfer.direction || 'download'} ${transfer.status}`
  card.querySelector('.transfer-title').textContent = filename
  card.querySelector('.status').textContent = statusLabel(transfer)
  card.querySelector('.mode-badge').textContent = transfer.mode === 'parallel'
    ? `${transfer.connections || 4} parça`
    : transfer.mode === 'single' ? 'tek bağlantı' : ''
  card.querySelector('.size').textContent = transfer.totalBytes
    ? `${formatBytes(transfer.downloadedBytes)} / ${formatBytes(transfer.totalBytes)}`
    : formatBytes(transfer.downloadedBytes)
  card.querySelector('.speed').textContent = transfer.speed || '—'
  card.querySelector('.remaining').textContent = transfer.remaining || '—'
  card.querySelector('.progress-fill').style.width = `${percent}%`
  card.querySelector('.progress-track').setAttribute('aria-label', transfer.direction === 'upload' ? 'Yükleme ilerlemesi' : 'İndirme ilerlemesi')
  card.querySelector('.progress-track').setAttribute('aria-valuenow', String(Math.round(percent)))
  renderActions(transfer)
  transfer.active = ['waiting', 'downloading', 'uploading', 'retrying'].includes(transfer.status)
  card.classList.toggle('filter-hidden', currentTransferFilter !== 'all' && (transfer.direction || 'download') !== currentTransferFilter)
  updateBoard()
}

function renderActions(transfer) {
  const container = transfer.card.querySelector('.card-actions')
  container.replaceChildren()
  container.append(actionButton(t('details'), () => showTransferDetails(transfer)))
  if (transfer.status === 'waiting') {
    const priority = document.createElement('div')
    priority.className = 'priority-controls'
    priority.append(iconButton(ICON_CHEVRON_UP, desktopSettings.language === 'en' ? 'Raise priority' : 'Önceliği artır', () => changePriority(transfer, 1), 'priority-button'))
    priority.append(iconButton(ICON_CHEVRON_DOWN, desktopSettings.language === 'en' ? 'Lower priority' : 'Önceliği azalt', () => changePriority(transfer, -1), 'priority-button'))
    container.append(priority)
  }
  if (['waiting', 'downloading', 'uploading', 'retrying'].includes(transfer.status)) {
    if (transfer.direction !== 'upload' || transfer.provider === 's3') {
      container.append(actionButton(t('pause'), () => performAction(transfer, 'pause')))
    }
    container.append(actionButton(t('cancelAction'), () => performAction(transfer, 'cancel')))
  } else if (transfer.status === 'paused') {
    container.append(actionButton(transfer.direction === 'upload' ? t('reconnect') : t('resume'), () => performAction(transfer, 'resume')))
    container.append(actionButton(t('cancelAction'), () => performAction(transfer, 'cancel')))
  } else if (transfer.status === 'failed') {
    container.append(actionButton(t('retry'), () => performAction(transfer, 'retry')))
  } else if (['pausing', 'cancelling'].includes(transfer.status)) {
    container.append(actionButton(t('cancelAction'), () => performAction(transfer, 'cancel')))
  }
  if (transfer.shareUrl) {
    container.append(actionButton(t('copyAddress'), async () => {
      await window.internetManager.copyText(transfer.shareUrl)
      showToast(desktopSettings.language === 'en' ? 'Remote object address copied to clipboard.' : 'Uzak nesne adresi panoya kopyalandı.')
    }))
  }
}

function actionButton(label, handler, className = 'action-button') {
  const button = document.createElement('button')
  button.className = className
  button.type = 'button'
  button.textContent = label
  button.addEventListener('click', handler)
  return button
}

function iconButton(iconHtml, ariaLabel, handler, className) {
  const button = document.createElement('button')
  button.className = className
  button.type = 'button'
  button.innerHTML = iconHtml
  button.setAttribute('aria-label', ariaLabel)
  button.addEventListener('click', handler)
  return button
}

async function changePriority(transfer, change) {
  const next = Math.max(-100, Math.min(100, (transfer.priority || 0) + change))
  await window.internetManager.setPriority(transfer.transferId, next)
  transfer.priority = next
  showToast(`Kuyruk önceliği ${next} olarak ayarlandı.`)
}

async function performAction(transfer, action) {
  if (transfer.direction === 'upload') {
    try {
      if (action === 'pause') await window.internetManager.pauseUpload(transfer.transferId)
      if (action === 'cancel') await window.internetManager.cancelUpload(transfer.transferId)
      if (action === 'retry') await window.internetManager.retryUpload(transfer.transferId)
      if (action === 'resume') await window.internetManager.retryUpload(transfer.transferId)
    } catch (error) {
      showToast(error.message || 'İşlem gönderilemedi.')
    }
    return
  }
  const api = {
    pause: window.internetManager.pauseDownload,
    resume: window.internetManager.resumeDownload,
    retry: window.internetManager.retryDownload,
    cancel: window.internetManager.cancelDownload
  }
  try {
    await api[action](transfer.transferId)
    if (action === 'pause') transfer.status = 'pausing'
    if (action === 'resume' || action === 'retry') transfer.status = 'waiting'
    if (action === 'cancel') transfer.status = 'cancelling'
    renderTransfer(transfer)
  } catch (error) {
    showToast(error.message || 'İşlem gönderilemedi.')
  }
}

window.internetManager.onTransferEvent((message) => {
  if (message.type === 'engine.ready') {
    setEngineStatus('ready', 'engineReady')
    return
  }
  if (message.type === 'transfers.snapshot') {
    for (const record of message.transfers) ensureTransfer(record)
    return
  }
  if (message.type === 'engine.error') {
    setEngineStatus('error', 'engineError')
    showToast(message.message)
    return
  }
  if (message.type === 'download.skipped') {
    showToast(message.message)
    return
  }
  if (message.type === 'download.created') {
    ensureTransfer(message)
    return
  }
  if (message.type === 'upload.created') {
    ensureTransfer(message)
    return
  }

  const transfer = transfers.get(message.transferId)
  if (!transfer) return
  const eventStatus = {
    'download.created': 'waiting',
    'download.started': 'downloading',
    'download.queued': 'waiting',
    'download.progress': 'downloading',
    'download.paused': 'paused',
    'download.retrying': 'retrying',
    'download.completed': 'completed',
    'download.cancelled': 'cancelled',
    'download.failed': 'failed',
    'upload.queued': 'waiting',
    'upload.started': 'uploading',
    'upload.progress': 'uploading',
    'upload.paused': 'paused',
    'upload.retrying': 'retrying',
    'upload.completed': 'completed',
    'upload.cancelled': 'cancelled',
    'upload.failed': 'failed',
    'upload.skipped': 'skipped'
  }
  transfer.status = eventStatus[message.type] || transfer.status
  const transferredBytes = message.uploadedBytes ?? message.downloadedBytes
  if (Number.isFinite(transferredBytes)) transfer.downloadedBytes = transferredBytes
  if (Number.isFinite(message.totalBytes)) transfer.totalBytes = message.totalBytes
  transfer.speed = message.type.endsWith('.progress')
    ? `${formatBytes(message.bytesPerSecond)}/sn`
    : '—'
  transfer.remaining = message.type.endsWith('.progress')
    ? formatRemaining(message.remainingSeconds)
    : '—'
  transfer.retryCount = message.retryCount ?? transfer.retryCount
  transfer.priority = message.priority ?? transfer.priority
  transfer.mode = message.mode ?? transfer.mode
  transfer.connections = message.connections ?? transfer.connections
  transfer.retryInSeconds = message.retryInSeconds
  transfer.error = message.message || transfer.error
  transfer.resumable = message.resumable ?? transfer.resumable
  transfer.shareUrl = message.shareUrl ?? transfer.shareUrl
  renderTransfer(transfer)

  if (message.restarted) showToast('Sunucu devam ettirmeyi desteklemedi; indirme güvenle baştan başladı.')
  if (message.type === 'download.completed') showToast(`${transfer.card.querySelector('.transfer-title').textContent} indirildi.`)
  if (message.type === 'download.failed') showToast(message.message)
  if (message.type === 'upload.completed') showToast(`${transfer.card.querySelector('.transfer-title').textContent} yüklendi.`)
  if (message.type === 'upload.failed') showToast(message.message)
  if (activityDialog.open && !message.type.endsWith('.progress')) void renderActivity()
})

function statusLabel(transfer) {
  const labels = desktopSettings.language === 'en' ? {
    waiting: 'Queued', downloading: 'Downloading', uploading: 'Uploading', paused: 'Paused',
    pausing: 'Pausing', retrying: `Retrying (${transfer.retryCount || 1}/3)`, completed: 'Completed',
    cancelled: 'Cancelled', cancelling: 'Cancelling', failed: 'Failed', skipped: 'Skipped'
  } : {
    waiting: 'Kuyrukta', downloading: 'İndiriliyor', uploading: 'Yükleniyor', paused: 'Duraklatıldı',
    pausing: 'Duraklatılıyor', retrying: `Yeniden deneniyor (${transfer.retryCount || 1}/3)`,
    completed: 'Tamamlandı', cancelled: 'İptal edildi', cancelling: 'İptal ediliyor',
    failed: 'Başarısız', skipped: 'Atlandı'
  }
  return labels[transfer.status] || transfer.status
}

function updateBoard() {
  const hasTransfers = transfers.size > 0
  emptyState.classList.toggle('hidden', hasTransfers)
  transferList.classList.toggle('hidden', !hasTransfers)
  activeCount.textContent = [...transfers.values()].filter((transfer) => transfer.active).length
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

function formatRemaining(seconds) {
  if (!Number.isFinite(seconds)) return 'Süre hesaplanıyor'
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} sn kaldı`
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} dk kaldı`
  return `${Math.floor(seconds / 3600)} sa ${Math.ceil(seconds % 3600 / 60)} dk kaldı`
}

let engineStatusKey = 'engineWaiting'

function setEngineStatus(state, labelKey) {
  engineStatusKey = labelKey
  engineStatus.className = `engine-status ${state}`
  engineStatus.querySelector('b').textContent = t(labelKey)
}

function showFormError(message) {
  formError.textContent = message
  formError.classList.remove('hidden')
}

function hideFormError() {
  formError.classList.add('hidden')
  formError.textContent = ''
}

let toastTimer
function showToast(message) {
  clearTimeout(toastTimer)
  toast.textContent = message
  toast.classList.remove('hidden')
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 5000)
}

window.internetManager.engineStatus().then(({ ready, transfers: cachedTransfers, settings }) => {
  if (ready) setEngineStatus('ready', 'engineReady')
  for (const record of cachedTransfers) ensureTransfer(record)
  if (settings) {
    document.querySelector('#max-concurrent').value = settings.maxConcurrent
    document.querySelector('#global-speed-limit').value = settings.globalSpeedLimit
      ? (settings.globalSpeedLimit / 1024 / 1024).toFixed(1)
      : 0
  }
})

function selectedTransferIds() {
  return [...transfers.values()]
    .filter((transfer) => transfer.card.querySelector('.transfer-select').checked)
    .map((transfer) => transfer.transferId)
}

async function runBulkAction(action) {
  const ids = selectedTransferIds()
  if (!ids.length) {
    showToast('Önce en az bir transfer seçin.')
    return
  }
  try {
    await window.internetManager.bulkAction(action, ids)
  } catch (error) {
    showToast(error.message || 'Toplu işlem gönderilemedi.')
  }
}

document.querySelector('#select-all').addEventListener('change', (event) => {
  for (const transfer of transfers.values()) {
    transfer.card.querySelector('.transfer-select').checked = event.target.checked
  }
})
document.querySelector('#bulk-pause').addEventListener('click', () => runBulkAction('pause'))
document.querySelector('#bulk-resume').addEventListener('click', () => runBulkAction('resume'))
document.querySelector('#bulk-cancel').addEventListener('click', () => runBulkAction('cancel'))

document.querySelector('#save-queue-settings').addEventListener('click', async () => {
  const maxConcurrent = Number(document.querySelector('#max-concurrent').value)
  const megabytesPerSecond = Number(document.querySelector('#global-speed-limit').value)
  try {
    await window.internetManager.updateSettings({
      maxConcurrent,
      globalSpeedLimit: Math.max(megabytesPerSecond || 0, 0) * 1024 * 1024
    })
    showToast('Kuyruk ayarları uygulandı.')
  } catch (error) {
    showToast(error.message || 'Ayarlar uygulanamadı.')
  }
})

async function refreshProfiles() {
  profiles = await window.internetManager.listProfiles()
  const select = document.querySelector('#upload-profile')
  select.replaceChildren()
  for (const profile of profiles) {
    const option = document.createElement('option')
    option.value = profile.id
    option.textContent = `${profile.name} · ${profile.provider.toUpperCase()}`
    select.append(option)
  }
  renderProfileList()
  updateUploadCapabilities()
}

async function showUploadDialog() {
  await refreshProfiles()
  document.querySelector('#upload-files').value = uploadFiles.length
    ? `${uploadFiles.length} dosya seçildi`
    : ''
  document.querySelector('#upload-error').classList.add('hidden')
  uploadDialog.showModal()
}

function closeUploadDialog() {
  uploadDialog.close()
}

document.querySelectorAll('.close-upload-dialog').forEach((button) => button.addEventListener('click', closeUploadDialog))
document.querySelector('#choose-upload-files').addEventListener('click', async () => {
  uploadFiles = await window.internetManager.chooseUploadFiles()
  document.querySelector('#upload-files').value = uploadFiles.length ? `${uploadFiles.length} dosya seçildi` : ''
})
document.querySelector('#upload-profile').addEventListener('change', updateUploadCapabilities)
document.querySelector('#manage-profiles').addEventListener('click', async () => {
  await refreshProfiles()
  profileDialog.showModal()
})

document.querySelector('#upload-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const errorBox = document.querySelector('#upload-error')
  if (!uploadFiles.length || !document.querySelector('#upload-profile').value) {
    errorBox.textContent = 'En az bir dosya ve bağlantı profili seçin.'
    errorBox.classList.remove('hidden')
    return
  }
  const folder = document.querySelector('#remote-path').value.trim() || '/'
  try {
    for (const sourcePath of uploadFiles) {
      const name = sourcePath.split(/[\\/]/).pop()
      const remotePath = `${folder.replace(/\/$/, '')}/${name}`
      await window.internetManager.startUpload({
        sourcePath, remotePath,
        profileId: document.querySelector('#upload-profile').value,
        conflictPolicy: document.querySelector('#upload-conflict').value,
        speedLimit: Math.max(Number(document.querySelector('#upload-speed-limit').value) || 0, 0) * 1024 * 1024
      })
    }
    uploadFiles = []
    closeUploadDialog()
  } catch (error) {
    errorBox.textContent = error.message || 'Yükleme başlatılamadı.'
    errorBox.classList.remove('hidden')
  }
})

window.addEventListener('dragover', (event) => event.preventDefault())
window.addEventListener('drop', async (event) => {
  event.preventDefault()
  uploadFiles = Array.from(event.dataTransfer.files, (file) => window.internetManager.droppedFilePath(file)).filter(Boolean)
  if (uploadFiles.length) await showUploadDialog()
})

const providerSelect = document.querySelector('#profile-provider')
providerSelect.addEventListener('change', () => {
  const isSftp = providerSelect.value === 'sftp'
  const isWebDav = providerSelect.value === 'webdav'
  const isS3 = providerSelect.value === 's3'
  document.querySelector('#sftp-fields').classList.toggle('hidden', !isSftp)
  document.querySelector('#webdav-fields').classList.toggle('hidden', !isWebDav)
  document.querySelector('#account-fields').classList.toggle('hidden', isS3)
  document.querySelector('#s3-fields').classList.toggle('hidden', !isS3)
})
document.querySelectorAll('.close-profile-dialog').forEach((button) => button.addEventListener('click', () => profileDialog.close()))
document.querySelector('#export-profiles').addEventListener('click', async () => {
  try {
    const count = await window.internetManager.exportProfiles()
    if (count) showToast(`${count} profil gizli bilgiler olmadan dışa aktarıldı.`)
  } catch (error) {
    showToast(error.message || 'Profiller dışa aktarılamadı.')
  }
})
document.querySelector('#import-profiles').addEventListener('click', async () => {
  try {
    const count = await window.internetManager.importProfiles()
    if (count) {
      await refreshProfiles()
      showToast(`${count} profil içe aktarıldı. Kullanmadan önce gizli bilgileri tamamlayın.`)
    }
  } catch (error) {
    showToast(error.message || 'Profiller içe aktarılamadı.')
  }
})

document.querySelector('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const errorBox = document.querySelector('#profile-error')
  const provider = providerSelect.value
  let connection
  if (provider === 'sftp') {
    connection = { host: document.querySelector('#profile-host').value.trim(), port: Number(document.querySelector('#profile-port').value), username: document.querySelector('#profile-username').value.trim(), password: document.querySelector('#profile-password').value }
  } else if (provider === 'webdav') {
    connection = { url: document.querySelector('#profile-url').value.trim(), username: document.querySelector('#profile-username').value.trim(), password: document.querySelector('#profile-password').value }
  } else {
    connection = {
      endpoint_url: document.querySelector('#profile-s3-endpoint').value.trim(),
      region: document.querySelector('#profile-s3-region').value.trim(),
      bucket: document.querySelector('#profile-s3-bucket').value.trim(),
      access_key_id: document.querySelector('#profile-s3-key').value.trim(),
      secret_access_key: document.querySelector('#profile-s3-secret').value,
      session_token: document.querySelector('#profile-s3-token').value
    }
  }
  try {
    await window.internetManager.saveProfile({ id: editingProfileId, name: document.querySelector('#profile-name').value, provider, connection })
    editingProfileId = null
    event.target.reset()
    providerSelect.dispatchEvent(new Event('change'))
    errorBox.classList.add('hidden')
    await refreshProfiles()
    showToast('Bağlantı profili güvenli biçimde kaydedildi.')
  } catch (error) {
    errorBox.textContent = error.message || 'Profil kaydedilemedi.'
    errorBox.classList.remove('hidden')
  }
})

function renderProfileList() {
  const list = document.querySelector('#profile-list')
  list.replaceChildren()
  for (const profile of profiles) {
    const row = document.createElement('div')
    row.className = 'profile-row'
    const name = document.createElement('b')
    name.textContent = profile.name
    const kind = document.createElement('span')
    kind.textContent = profile.provider.toUpperCase()
    row.append(name, kind)
    row.append(actionButton('Test', async () => {
      try {
        const capabilities = await window.internetManager.testProfile(profile.id)
        showToast(`Bağlantı başarılı · ${capabilityText(capabilities)}`)
      }
      catch (error) { showToast(error.message || 'Bağlantı kurulamadı.') }
    }))
    row.append(actionButton('Düzenle', () => editProfile(profile)))
    row.append(actionButton('Sil', async () => { await window.internetManager.deleteProfile(profile.id); await refreshProfiles() }))
    list.append(row)
  }
}

function editProfile(profile) {
  editingProfileId = profile.id
  document.querySelector('#profile-name').value = profile.name
  providerSelect.value = profile.provider
  providerSelect.dispatchEvent(new Event('change'))
  document.querySelector('#profile-username').value = profile.connection.username || ''
  document.querySelector('#profile-password').value = ''
  if (profile.provider === 'sftp') {
    document.querySelector('#profile-host').value = profile.connection.host || ''
    document.querySelector('#profile-port').value = profile.connection.port || 22
  } else if (profile.provider === 'webdav') {
    document.querySelector('#profile-url').value = profile.connection.url || ''
  } else {
    document.querySelector('#profile-s3-endpoint').value = profile.connection.endpoint_url || ''
    document.querySelector('#profile-s3-region').value = profile.connection.region || ''
    document.querySelector('#profile-s3-bucket').value = profile.connection.bucket || ''
    document.querySelector('#profile-s3-key').value = profile.connection.access_key_id || ''
    document.querySelector('#profile-s3-secret').value = ''
    document.querySelector('#profile-s3-token').value = ''
  }
}

function updateUploadCapabilities() {
  const profile = profiles.find((item) => item.id === document.querySelector('#upload-profile').value)
  const note = document.querySelector('#upload-capabilities')
  if (!profile) {
    note.textContent = 'Önce bir bağlantı profili oluştur.'
    return
  }
  const capabilities = profile.provider === 's3'
    ? { resume: true, browse: true, share_url: true }
    : { resume: false, browse: true, share_url: profile.provider === 'webdav' }
  note.textContent = `${profile.provider.toUpperCase()} · ${capabilityText(capabilities)}`
}

function capabilityText(capabilities) {
  const parts = [capabilities?.browse ? 'klasör gezme' : null, capabilities?.resume ? 'devam ettirme' : 'baştan yeniden deneme', capabilities?.share_url ? 'nesne adresi' : null]
  return parts.filter(Boolean).join(' · ')
}

document.querySelector('#browse-remote').addEventListener('click', async () => {
  if (!document.querySelector('#upload-profile').value) {
    document.querySelector('#upload-error').textContent = 'Önce bir bağlantı profili seçin.'
    document.querySelector('#upload-error').classList.remove('hidden')
    return
  }
  remoteBrowserPath = document.querySelector('#remote-path').value.trim() || '/'
  remoteDialog.showModal()
  await loadRemotePath(remoteBrowserPath)
})

async function loadRemotePath(path) {
  const list = document.querySelector('#remote-list')
  const error = document.querySelector('#remote-error')
  list.innerHTML = '<p class="remote-empty">Klasörler getiriliyor…</p>'
  error.classList.add('hidden')
  try {
    const result = await window.internetManager.listRemote(document.querySelector('#upload-profile').value, path)
    remoteBrowserPath = result.path || path || '/'
    document.querySelector('#remote-current-path').textContent = remoteBrowserPath || '/'
    list.replaceChildren()
    if (!result.entries.length) list.innerHTML = '<p class="remote-empty">Bu hedef boş.</p>'
    for (const entry of result.entries) {
      const row = document.createElement(entry.type === 'folder' ? 'button' : 'div')
      if (entry.type === 'folder') row.type = 'button'
      row.className = `remote-entry ${entry.type}`
      const isFolder = entry.type === 'folder'
      row.innerHTML = `<span aria-hidden="true">${isFolder ? ICON_FOLDER : ICON_FILE}</span><b></b><small>${isFolder ? ICON_CHEVRON_RIGHT : ''}</small>`
      row.querySelector('b').textContent = entry.name
      if (!isFolder) row.querySelector('small').textContent = formatBytes(entry.size)
      if (entry.type === 'folder') row.addEventListener('click', () => loadRemotePath(entry.path))
      list.append(row)
    }
  } catch (cause) {
    error.textContent = cause.message || 'Uzak klasörler getirilemedi.'
    error.classList.remove('hidden')
    list.replaceChildren()
  }
}

document.querySelector('#remote-up').addEventListener('click', () => {
  const parent = remoteBrowserPath.replace(/\/$/, '').split('/').slice(0, -1).join('/') || '/'
  void loadRemotePath(parent)
})
document.querySelector('#select-remote').addEventListener('click', () => {
  document.querySelector('#remote-path').value = remoteBrowserPath || '/'
  remoteDialog.close()
})
document.querySelector('#close-remote-dialog').addEventListener('click', () => remoteDialog.close())
document.querySelector('#cancel-remote').addEventListener('click', () => remoteDialog.close())

document.querySelectorAll('[data-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    currentTransferFilter = button.dataset.filter
    document.querySelectorAll('[data-filter]').forEach((item) => item.classList.toggle('active', item === button))
    for (const transfer of transfers.values()) renderTransfer(transfer)
  })
})

function applyTheme(theme) {
  const resolved = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme
  document.documentElement.dataset.theme = resolved
}

function applyLanguage() {
  document.documentElement.lang = desktopSettings.language
  for (const element of document.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.dataset.i18n)
  }
  for (const element of document.querySelectorAll('[data-i18n-placeholder]')) {
    element.placeholder = t(element.dataset.i18nPlaceholder)
  }
  for (const element of document.querySelectorAll('[data-i18n-aria]')) {
    element.setAttribute('aria-label', t(element.dataset.i18nAria))
  }
  engineStatus.querySelector('b').textContent = t(engineStatusKey)
  for (const transfer of transfers.values()) renderTransfer(transfer)
}

function fillSettingsForm() {
  document.querySelector('#setting-close-to-tray').checked = desktopSettings.closeToTray
  document.querySelector('#setting-notifications').checked = desktopSettings.notifications
  document.querySelector('#setting-launch-at-startup').checked = desktopSettings.launchAtStartup
  document.querySelector('#setting-theme').value = desktopSettings.theme
  document.querySelector('#setting-language').value = desktopSettings.language
}

function showSettingsDialog() {
  fillSettingsForm()
  if (!settingsDialog.open) settingsDialog.showModal()
}

document.querySelector('#settings-button').addEventListener('click', showSettingsDialog)
document.querySelectorAll('.close-settings-dialog').forEach((button) => button.addEventListener('click', () => settingsDialog.close()))
document.querySelector('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  try {
    desktopSettings = await window.internetManager.updateDesktopSettings({
      closeToTray: document.querySelector('#setting-close-to-tray').checked,
      notifications: document.querySelector('#setting-notifications').checked,
      launchAtStartup: document.querySelector('#setting-launch-at-startup').checked,
      theme: document.querySelector('#setting-theme').value,
      language: document.querySelector('#setting-language').value
    })
    applyTheme(desktopSettings.theme)
    applyLanguage()
    settingsDialog.close()
    showToast(desktopSettings.language === 'en' ? 'Desktop settings saved.' : 'Masaüstü ayarları kaydedildi.')
  } catch (error) {
    showToast(error.message || 'Ayarlar kaydedilemedi.')
  }
})

async function showActivityDialog() {
  if (!activityDialog.open) activityDialog.showModal()
  await renderActivity()
}

async function renderActivity() {
  const list = document.querySelector('#activity-list')
  const filter = document.querySelector('#activity-filter').value
  const entries = await window.internetManager.listActivity()
  const visible = entries.filter((entry) => {
    if (filter === 'all') return true
    if (filter === 'error') return entry.type.endsWith('.failed') || entry.type === 'engine.error'
    return entry.direction === filter
  })
  list.replaceChildren()
  if (!visible.length) {
    const empty = document.createElement('p')
    empty.className = 'remote-empty activity-empty'
    empty.textContent = desktopSettings.language === 'en' ? 'No activity matches this filter.' : 'Bu filtreye uyan aktivite yok.'
    list.append(empty)
    return
  }
  for (const entry of visible) {
    const row = document.createElement('article')
    row.className = `activity-entry ${entry.direction}`
    const mark = document.createElement('span')
    mark.className = 'activity-mark'
    mark.innerHTML = entry.direction === 'upload' ? ICON_ARROW_UP : ICON_ARROW_DOWN
    const copy = document.createElement('div')
    const title = document.createElement('b')
    title.textContent = entry.title || 'Internet Manager'
    const description = document.createElement('p')
    description.textContent = activityLabel(entry)
    copy.append(title, description)
    const time = document.createElement('time')
    time.dateTime = entry.createdAt
    time.textContent = new Intl.DateTimeFormat(desktopSettings.language, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(entry.createdAt))
    row.append(mark, copy, time)
    list.append(row)
  }
}

function activityLabel(entry) {
  if (entry.message) return entry.message
  const english = desktopSettings.language === 'en'
  const labels = english ? {
    'download.created': 'Download added', 'download.paused': 'Download paused', 'download.completed': 'Download completed',
    'download.cancelled': 'Download cancelled', 'upload.created': 'Upload added', 'upload.paused': 'Upload paused',
    'upload.completed': 'Upload completed', 'upload.cancelled': 'Upload cancelled', 'upload.skipped': 'Upload skipped'
  } : {
    'download.created': 'İndirme eklendi', 'download.paused': 'İndirme duraklatıldı', 'download.completed': 'İndirme tamamlandı',
    'download.cancelled': 'İndirme iptal edildi', 'upload.created': 'Yükleme eklendi', 'upload.paused': 'Yükleme duraklatıldı',
    'upload.completed': 'Yükleme tamamlandı', 'upload.cancelled': 'Yükleme iptal edildi', 'upload.skipped': 'Yükleme atlandı'
  }
  return labels[entry.type] || entry.type
}

document.querySelector('#activity-button').addEventListener('click', () => void showActivityDialog())
document.querySelector('.close-activity-dialog').addEventListener('click', () => activityDialog.close())
document.querySelector('#activity-filter').addEventListener('change', () => void renderActivity())
document.querySelector('#clear-activity').addEventListener('click', async () => {
  await window.internetManager.clearActivity()
  await renderActivity()
})

function showTransferDetails(transfer) {
  detailsTransferId = transfer.transferId
  const visiblePath = transfer.direction === 'upload' ? transfer.sourcePath : transfer.destination
  document.querySelector('#details-title').textContent = visiblePath?.split(/[\\/]/).pop() || transfer.url || 'Transfer'
  const values = [
    [desktopSettings.language === 'en' ? 'Status' : 'Durum', statusLabel(transfer)],
    [desktopSettings.language === 'en' ? 'Direction' : 'Yön', transfer.direction === 'upload' ? t('uploads') : t('downloads')],
    [desktopSettings.language === 'en' ? 'Progress' : 'İlerleme', `${formatBytes(transfer.downloadedBytes)} / ${formatBytes(transfer.totalBytes)}`],
    [desktopSettings.language === 'en' ? 'Local path' : 'Yerel yol', visiblePath || '—'],
    [desktopSettings.language === 'en' ? 'Remote path' : 'Uzak yol', transfer.remotePath || transfer.url || '—'],
    ['Provider', transfer.provider?.toUpperCase() || 'HTTP'],
    [desktopSettings.language === 'en' ? 'Created' : 'Oluşturuldu', transfer.createdAt ? new Date(transfer.createdAt).toLocaleString(desktopSettings.language) : '—']
  ]
  const grid = document.querySelector('#details-grid')
  grid.replaceChildren()
  for (const [label, value] of values) {
    const term = document.createElement('dt')
    const description = document.createElement('dd')
    term.textContent = label
    description.textContent = value
    grid.append(term, description)
  }
  const error = document.querySelector('#details-error')
  error.textContent = transfer.error || ''
  error.classList.toggle('hidden', !transfer.error)
  document.querySelector('#open-transfer-file').disabled = transfer.direction !== 'upload' && transfer.status !== 'completed'
  detailsDialog.showModal()
}

document.querySelector('.close-details-dialog').addEventListener('click', () => detailsDialog.close())
document.querySelector('#open-transfer-folder').addEventListener('click', async () => {
  try { await window.internetManager.openTransfer(detailsTransferId, 'folder') }
  catch (error) { showToast(error.message || 'Klasör açılamadı.') }
})
document.querySelector('#open-transfer-file').addEventListener('click', async () => {
  try { await window.internetManager.openTransfer(detailsTransferId, 'file') }
  catch (error) { showToast(error.message || 'Dosya açılamadı.') }
})

document.addEventListener('keydown', (event) => {
  if (!event.ctrlKey || event.altKey) return
  if (event.key.toLowerCase() === 'n' && event.shiftKey) {
    event.preventDefault()
    void showUploadDialog()
  } else if (event.key.toLowerCase() === 'n') {
    event.preventDefault()
    showDialog()
  } else if (event.key === ',') {
    event.preventDefault()
    showSettingsDialog()
  } else if (event.key.toLowerCase() === 'l') {
    event.preventDefault()
    void showActivityDialog()
  }
})

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (desktopSettings.theme === 'system') applyTheme('system')
})

window.internetManager.onDesktopSettingsChanged((settings) => {
  desktopSettings = settings
  applyTheme(settings.theme)
  applyLanguage()
})

window.internetManager.getDesktopSettings().then((settings) => {
  desktopSettings = settings
  applyTheme(settings.theme)
  applyLanguage()
})
