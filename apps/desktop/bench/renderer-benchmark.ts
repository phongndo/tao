import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electronPath = require('electron') as string
const __dirname = dirname(fileURLToPath(import.meta.url))
const entry = resolve(__dirname, 'xterm-webgl-benchmark.ts')
const nodeOptions = [process.env.NODE_OPTIONS, '--import tsx'].filter(Boolean).join(' ')

const child = spawn(electronPath, [entry], {
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
