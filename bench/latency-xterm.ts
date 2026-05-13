/**
 * xterm.js — Input Latency Benchmark (JS parser)
 *
 * Measures PTY → xterm.js parser round-trip latency.
 * Usage: npx tsx bench/latency-xterm.ts
 */

import pty from 'node-pty'
import xterm from '@xterm/xterm'

const { Terminal } = xterm

const RUNS = parseInt(process.argv[2] || '100', 10)

const shell = pty.spawn(process.env.SHELL || 'bash', [], {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd: process.env.HOME || process.cwd(),
  env: { ...process.env, TERM: 'xterm-256color' },
})

const term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })

// Wait for shell prompt
await new Promise((r) => setTimeout(r, 500))

const latencies: number[] = []
for (let i = 0; i < RUNS; i++) {
  const start = performance.now()
  shell.write('x')
  await new Promise<void>((resolve) => {
    const h = (data: string) => {
      shell.removeListener('data', h)
      term.write(data, resolve)
    }
    shell.on('data', h)
  })
  latencies.push(performance.now() - start)
}

shell.kill()
term.dispose()

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
