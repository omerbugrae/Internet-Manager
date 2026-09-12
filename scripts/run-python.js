const { existsSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const localPython = process.platform === 'win32'
  ? path.join(process.cwd(), 'venv', 'Scripts', 'python.exe')
  : path.join(process.cwd(), 'venv', 'bin', 'python')
const executable = existsSync(localPython) ? localPython : (process.platform === 'win32' ? 'python' : 'python3')
const result = spawnSync(executable, process.argv.slice(2), { stdio: 'inherit' })

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
