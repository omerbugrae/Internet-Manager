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
      speedLimit: Math.max(Number(taskSpeedLimit.value) || 0, 0) * 1024
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
    <input class="transfer-select" type="checkbox" aria-label="Transferi seç" />
    <div class="file-glyph" aria-hidden="true">${record.direction === 'upload' ? '↑' : '↓'}</div>
    <div class="transfer-info">
      <p class="transfer-title"></p>
      <div class="transfer-meta"><span class="status"></span><span class="mode-badge"></span><span class="size"></span><span class="speed">—</span><span class="remaining">—</span></div>
      <div class="progress-track" role="progressbar" aria-label="İndirme ilerlemesi" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="progress-fill"></div></div>
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
  card.querySelector('.progress-track').setAttribute('aria-valuenow', String(Math.round(percent)))
  renderActions(transfer)
  transfer.active = ['waiting', 'downloading', 'uploading', 'retrying'].includes(transfer.status)
  updateBoard()
}

function renderActions(transfer) {
  const container = transfer.card.querySelector('.card-actions')
  container.replaceChildren()
  if (transfer.status === 'waiting') {
    const priority = document.createElement('div')
    priority.className = 'priority-controls'
    priority.append(actionButton('▲', () => changePriority(transfer, 1), 'priority-button'))
    priority.append(actionButton('▼', () => changePriority(transfer, -1), 'priority-button'))
    container.append(priority)
  }
  if (['waiting', 'downloading', 'uploading', 'retrying'].includes(transfer.status)) {
    if (transfer.direction !== 'upload') container.append(actionButton('Duraklat', () => performAction(transfer, 'pause')))
    container.append(actionButton('İptal', () => performAction(transfer, 'cancel')))
  } else if (transfer.status === 'paused') {
    container.append(actionButton(transfer.direction === 'upload' ? 'Yeniden bağlan' : 'Devam et', () => performAction(transfer, 'resume')))
    container.append(actionButton('İptal', () => performAction(transfer, 'cancel')))
  } else if (transfer.status === 'failed') {
    container.append(actionButton('Yeniden dene', () => performAction(transfer, 'retry')))
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

async function changePriority(transfer, change) {
  const next = Math.max(-100, Math.min(100, (transfer.priority || 0) + change))
  await window.internetManager.setPriority(transfer.transferId, next)
  transfer.priority = next
  showToast(`Kuyruk önceliği ${next} olarak ayarlandı.`)
}

async function performAction(transfer, action) {
  if (transfer.direction === 'upload') {
    try {
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
    setEngineStatus('ready', 'Motor hazır')
    return
  }
  if (message.type === 'transfers.snapshot') {
    for (const record of message.transfers) ensureTransfer(record)
    return
  }
  if (message.type === 'engine.error') {
    setEngineStatus('error', 'Motor hatası')
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
    'download.failed': 'failed'
    , 'upload.queued': 'waiting'
    , 'upload.started': 'uploading'
    , 'upload.progress': 'uploading'
    , 'upload.completed': 'completed'
    , 'upload.cancelled': 'cancelled'
    , 'upload.failed': 'failed'
    , 'upload.skipped': 'skipped'
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
  renderTransfer(transfer)

  if (message.restarted) showToast('Sunucu devam ettirmeyi desteklemedi; indirme güvenle baştan başladı.')
  if (message.type === 'download.completed') showToast(`${transfer.card.querySelector('.transfer-title').textContent} indirildi.`)
  if (message.type === 'download.failed') showToast(message.message)
  if (message.type === 'upload.completed') showToast(`${transfer.card.querySelector('.transfer-title').textContent} yüklendi.`)
  if (message.type === 'upload.failed') showToast(message.message)
})

function statusLabel(transfer) {
  const labels = {
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

function setEngineStatus(state, label) {
  engineStatus.className = `engine-status ${state}`
  engineStatus.querySelector('b').textContent = label
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
  if (ready) setEngineStatus('ready', 'Motor hazır')
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
        speedLimit: Math.max(Number(document.querySelector('#upload-speed-limit').value) || 0, 0) * 1024
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
  document.querySelector('#sftp-fields').classList.toggle('hidden', !isSftp)
  document.querySelector('#webdav-fields').classList.toggle('hidden', isSftp)
})
document.querySelectorAll('.close-profile-dialog').forEach((button) => button.addEventListener('click', () => profileDialog.close()))

document.querySelector('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const errorBox = document.querySelector('#profile-error')
  const provider = providerSelect.value
  const connection = provider === 'sftp'
    ? { host: document.querySelector('#profile-host').value.trim(), port: Number(document.querySelector('#profile-port').value), username: document.querySelector('#profile-username').value.trim(), password: document.querySelector('#profile-password').value }
    : { url: document.querySelector('#profile-url').value.trim(), username: document.querySelector('#profile-username').value.trim(), password: document.querySelector('#profile-password').value }
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
      try { await window.internetManager.testProfile(profile.id); showToast('Bağlantı başarılı.') }
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
  } else {
    document.querySelector('#profile-url').value = profile.connection.url || ''
  }
}
