const SENSITIVE_KEY = /^(authorization|cookie|set-cookie|password|passwd|secret|secret_access_key|token|session_token|access[_-]?token|refresh[_-]?token|api[_-]?key)$/i
const SECRET_TEXT = /\b(authorization|password|passwd|secret(?:_access_key)?|session_token|access[_-]?token|refresh[_-]?token|api[_-]?key)\b\s*[:=]\s*([^\s,;]+)/gi

function redactUrl(value) {
  try {
    const url = new URL(value)
    if (url.username) url.username = '[redacted]'
    if (url.password) url.password = '[redacted]'
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key) || /^(sig|signature|x-amz-signature)$/i.test(key)) {
        url.searchParams.set(key, '[redacted]')
      }
    }
    return url.toString()
  } catch {
    return value
  }
}

function redactText(value) {
  return String(value)
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactUrl(url))
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(SECRET_TEXT, '$1=[redacted]')
}

function redact(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactText(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redact(item, seen))
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) ? '[redacted]' : redact(item, seen)
  ]))
}

module.exports = { redact, redactText }
