const urlInput = document.querySelector('#scan-url')
const scanButton = document.querySelector('#scan')
const scanning = document.querySelector('#scanning')
const message = document.querySelector('#message')
const results = document.querySelector('#results')
const itemsContainer = document.querySelector('#items')
const downloadButton = document.querySelector('#download')
let items = []

function applyCaptureTheme(settings) {
  const theme = settings.theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : settings.theme
  document.documentElement.dataset.theme = theme
}

window.internetManager.getDesktopSettings().then(applyCaptureTheme)
window.internetManager.onDesktopSettingsChanged(applyCaptureTheme)

document.querySelector('#close').addEventListener('click', () => window.internetManager.closeCapture())
window.internetManager.onClipboardUrl((url) => {
  urlInput.value = /^https?:\/\//i.test(url) ? url : ''
  if (urlInput.value) void scan()
})
scanButton.addEventListener('click', scan)
urlInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') void scan() })

async function scan() {
  const url = urlInput.value.trim()
  if (!/^https?:\/\//i.test(url)) {
    message.textContent = 'Geçerli bir HTTP/HTTPS bağlantısı gir.'
    message.hidden = false
    results.hidden = true
    return
  }
  scanning.hidden = false
  message.hidden = true
  results.hidden = true
  scanButton.disabled = true
  try {
    const response = await window.internetManager.scanUrl(url)
    items = Array.isArray(response?.items) ? response.items : []
    renderItems()
    results.hidden = false
    message.hidden = items.length > 0 && !response?.error
    message.textContent = response?.error || (items.length ? '' : 'Bu sayfada indirilebilir açık bir dosya bulunamadı.')
  } catch (error) {
    message.textContent = error.message || 'Bağlantı taranamadı.'
    message.hidden = false
  } finally {
    scanning.hidden = true
    scanButton.disabled = false
  }
}

function renderItems() {
  itemsContainer.replaceChildren()
  document.querySelector('#result-count').textContent = `${items.length} öğe`
  for (const [index, item] of items.entries()) {
    const row = document.createElement('label')
    row.className = 'item'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.dataset.index = index
    checkbox.addEventListener('change', updateDownloadButton)
    const details = document.createElement('div')
    const name = document.createElement('b')
    name.textContent = item.filename
    const meta = document.createElement('span')
    meta.textContent = `${item.category} · ${formatBytes(item.size)}`
    details.append(name, meta)
    row.append(checkbox, details)
    itemsContainer.append(row)
  }
  updateDownloadButton()
}

document.querySelector('#toggle-all').addEventListener('click', () => {
  const boxes = [...itemsContainer.querySelectorAll('input')]
  const shouldSelect = boxes.some((box) => !box.checked)
  for (const box of boxes) box.checked = shouldSelect
  updateDownloadButton()
})

downloadButton.addEventListener('click', async () => {
  const selected = [...itemsContainer.querySelectorAll('input:checked')].map((box) => items[Number(box.dataset.index)])
  downloadButton.disabled = true
  try {
    for (const item of selected) {
      const destination = await window.internetManager.chooseDestination(item.filename)
      if (!destination) continue
      await window.internetManager.startDownload({ url: item.url, destination, conflictPolicy: 'overwrite', speedLimit: 0 })
    }
    await window.internetManager.closeCapture()
  } catch (error) {
    message.textContent = error.message || 'Seçilen indirmeler başlatılamadı.'
    message.hidden = false
  } finally {
    updateDownloadButton()
  }
})

function updateDownloadButton() {
  downloadButton.disabled = !itemsContainer.querySelector('input:checked')
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'boyut bilinmiyor'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}
