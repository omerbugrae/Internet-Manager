const assert = require('node:assert/strict')
const { redact, redactText } = require('../electron/security')

const result = redact({
  password: 'do-not-leak',
  authorization: 'Bearer abc.def',
  nested: { session_token: 'token', safe: 'visible' },
  url: 'https://user:pass@example.test/file?token=secret&part=1'
})

assert.equal(result.password, '[redacted]')
assert.equal(result.authorization, '[redacted]')
assert.equal(result.nested.session_token, '[redacted]')
assert.equal(result.nested.safe, 'visible')
assert.doesNotMatch(JSON.stringify(result), /do-not-leak|abc\.def|secret/)
assert.doesNotMatch(redactText('Authorization: Bearer abc123'), /abc123/)
