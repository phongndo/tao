/**
 * Tao — Input Latency Benchmark: ghostty-web (WASM)
 *
 * Measures PTY → WASM parser round-trip latency.
 * Usage: npx tsx bench/latency-tao.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pty from 'node-pty'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')
const RUNS = parseInt(process.argv[2] || '100', 10)

const WASM_PATH = path.join(PROJECT_ROOT, 'node_modules/ghostty-web/ghostty-vt.wasm')
const wasmBin = fs.readFileSync(WASM_PATH)
const mod = await WebAssembly.instantiate(wasmBin, { env: { log: () => {} } })
const exp = mod.instance.exports as any
const mem = exp.memory
const term = exp.ghostty_terminal_new(120, 40)

const shell = pty.spawn(process.env.SHELL || 'bash', [], {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd: process.env.HOME || process.cwd(),
  env: { ...process.env, TERM: 'xterm-256color' },
})

// Wait for shell prompt
await new Promise((r) => setTimeout(r, 500))

const latencies: number[] = []
for (let i = 0; i < RUNS; i++) {
  const start = performance.now()
  shell.write('x')
  await new Promise<void>((resolve) => {
    const h = (data: string) => {
      shell.removeListener('data', h)
      const enc = new TextEncoder().encode(data)
      const ptr = exp.ghostty_wasm_alloc_u8_array(enc.length)
      new Uint8Array(mem.buffer).set(enc, ptr)
      exp.ghostty_terminal_write(term, ptr, enc.length)
      exp.ghostty_wasm_free_u8_array(ptr, enc.length)
      resolve()
    }
    shell.on('data', h)
  })
  latencies.push(performance.now() - start)
}

shell.kill()
exp.ghostty_terminal_free(term)

latencies.sort((a, b) => a - b)
const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length
const p50 = latencies[Math.floor(latencies.length * 0.5)]
const p95 = latencies[Math.floor(latencies.length * 0.95)]
const p99 = latencies[Math.floor(latencies.length * 0.99)]

console.log(`  avg:  ${avg.toFixed(2)} ms`)
console.log(`  p50:  ${p50.toFixed(2)} ms`)
console.log(`  p95:  ${p95.toFixed(2)} ms`)
console.log(`  p99:  ${p99.toFixed(2)} ms`)
console.log(`  samples: ${latencies.length}`)
