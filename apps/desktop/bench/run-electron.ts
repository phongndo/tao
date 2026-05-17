import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronPath = require('electron') as string
const electronArgs = process.argv.slice(2)

if (electronArgs.length === 0) {
  console.error('Usage: tsx bench/run-electron.ts <entry.ts> [...args]')
  process.exit(1)
}

const nodeOptions = [process.env.NODE_OPTIONS, '--import tsx'].filter(Boolean).join(' ')
const child = spawn(electronPath, electronArgs, {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_OPTIONS: nodeOptions,
  },
})

child.on('error', (error) => {
  console.error(error)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
