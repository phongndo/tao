/**
 * Tau Terminal — VT Parser Benchmark
 *
 * Compares ghostty-web (Ghostty WASM parser) vs @xterm/xterm (JS parser)
 * by feeding identical terminal data to both and measuring parse throughput.
 *
 * Usage: npx tsx bench/benchmark.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')
const GHOSTTY_WEB_VERSION = '0.4.0-next.14.g6a1a50d'

// ─── Test Data Generators ───

function generateMixedData(sizeMB: number, ansiDensity = 0.3): Buffer {
  const target = sizeMB * 1024 * 1024
  const styles = [
    '\x1b[31m',
    '\x1b[32m',
    '\x1b[33m',
    '\x1b[34m',
    '\x1b[35m',
    '\x1b[36m',
    '\x1b[1m',
    '\x1b[3m',
    '\x1b[4m',
    '\x1b[0m',
    '\x1b[38;5;196m',
    '\x1b[48;5;22m',
    '\x1b[38;2;255;128;0m',
    '\x1b[48;2;0;0;128m',
    '\x1b[H',
    '\x1b[2J',
    '\x1b[K',
    '\x1b[10;20H',
  ]
  const chunks: Buffer[] = []
  let bytes = 0
  while (bytes < target) {
    let line = ''
    const len = 20 + Math.floor(Math.random() * 100)
    for (let i = 0; i < len && bytes < target; i++) {
      if (Math.random() < ansiDensity) {
        const s = styles[Math.floor(Math.random() * styles.length)]
        line += s
        bytes += s.length
      }
      line += String.fromCharCode(32 + Math.floor(Math.random() * 95))
      bytes++
    }
    line += '\r\n'
    bytes += 2
    chunks.push(Buffer.from(line, 'utf-8'))
  }
  return Buffer.concat(chunks)
}

// ─── Benchmark Helpers ───

interface Result {
  name: string
  engine: string
  sizeMB: number
  durationMs: number
  throughputMBps: number
}

function fmt(r: Result): string {
  return `${r.engine.padEnd(22)} ${r.durationMs.toFixed(1).padStart(8)}ms  ${r.throughputMBps.toFixed(1).padStart(8)} MB/s  (${r.name})`
}

function ensureGhosttyWasm(): string {
  if (process.env.TAU_GHOSTTY_WEB_WASM) {
    if (!fs.existsSync(process.env.TAU_GHOSTTY_WEB_WASM)) {
      throw new Error(`TAU_GHOSTTY_WEB_WASM does not exist: ${process.env.TAU_GHOSTTY_WEB_WASM}`)
    }
    return process.env.TAU_GHOSTTY_WEB_WASM
  }

  const localDependencyWasm = path.join(PROJECT_ROOT, 'node_modules/ghostty-web/ghostty-vt.wasm')
  if (fs.existsSync(localDependencyWasm)) return localDependencyWasm

  const cacheRoot = path.join(PROJECT_ROOT, '.bench-cache')
  const packageDir = path.join(cacheRoot, `ghostty-web-${GHOSTTY_WEB_VERSION}`, 'package')
  const cachedWasm = path.join(packageDir, 'ghostty-vt.wasm')
  if (fs.existsSync(cachedWasm)) return cachedWasm

  fs.mkdirSync(cacheRoot, { recursive: true })
  const tarball = execFileSync(
    'npm',
    ['pack', `ghostty-web@${GHOSTTY_WEB_VERSION}`, '--pack-destination', cacheRoot],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  )
    .trim()
    .split('\n')
    .filter((line) => line.endsWith('.tgz'))
    .at(-1)

  if (!tarball) {
    throw new Error(`npm pack did not produce a .tgz file for ghostty-web@${GHOSTTY_WEB_VERSION}`)
  }

  fs.rmSync(packageDir, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(packageDir), { recursive: true })
  execFileSync('tar', ['-xzf', path.join(cacheRoot, tarball), '-C', path.dirname(packageDir)], {
    stdio: 'ignore',
  })

  if (!fs.existsSync(cachedWasm)) {
    throw new Error(`ghostty-web package did not contain ${cachedWasm}`)
  }

  fs.rmSync(path.join(cacheRoot, tarball), { force: true })

  return cachedWasm
}

let ghosttyWasmPath: string | null = null

function getGhosttyWasmPath(): string {
  ghosttyWasmPath ??= ensureGhosttyWasm()
  return ghosttyWasmPath
}

// ─── xterm.js Benchmark ───

async function benchXtermJs(data: Buffer, label: string): Promise<Result> {
  const { Terminal } = await import('@xterm/xterm')

  // Warmup
  const warm = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
  await new Promise<void>((resolve) => warm.write('warmup\r\n', resolve))
  warm.dispose()

  // Actual test — use callback to measure real parse time
  const term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
  const start = performance.now()
  await new Promise<void>((resolve) => {
    term.write(data.toString('utf-8'), resolve)
  })
  const duration = performance.now() - start
  term.dispose()

  const sizeMB = data.length / 1024 / 1024
  return {
    name: label,
    engine: 'xterm.js (JS parser)',
    sizeMB,
    durationMs: duration,
    throughputMBps: sizeMB / (duration / 1000),
  }
}

// ─── ghostty-web (WASM) Benchmark ───

async function benchGhostty(data: Buffer, label: string): Promise<Result> {
  const wasmBin = fs.readFileSync(getGhosttyWasmPath())

  // Track ghostty log calls (some WASM builds log warnings)
  const logs: string[] = []
  const wasmModule = await WebAssembly.instantiate(wasmBin, {
    env: {
      log: (ptr: number, len: number) => {
        // Ghostty logs via this import — collect but don't print
        try {
          const mem = (wasmModule.instance.exports as any).memory as WebAssembly.Memory
          const bytes = new Uint8Array(mem.buffer, ptr, len)
          logs.push(new TextDecoder().decode(bytes))
        } catch {
          /* ignore */
        }
      },
    },
  })

  const exports = wasmModule.instance.exports as any
  const memory = exports.memory as WebAssembly.Memory

  // Create terminal
  const termHandle = exports.ghostty_terminal_new(120, 40)

  // Encode data
  const text = data.toString('utf-8')
  const encoded = new TextEncoder().encode(text)
  const dataPtr = exports.ghostty_wasm_alloc_u8_array(encoded.length)
  new Uint8Array(memory.buffer).set(encoded, dataPtr)

  // Benchmark
  const start = performance.now()
  exports.ghostty_terminal_write(termHandle, dataPtr, encoded.length)
  const duration = performance.now() - start

  // Cleanup
  exports.ghostty_wasm_free_u8_array(dataPtr, encoded.length)
  exports.ghostty_terminal_free(termHandle)

  const sizeMB = data.length / 1024 / 1024
  return {
    name: label,
    engine: 'ghostty-web (WASM)',
    sizeMB,
    durationMs: duration,
    throughputMBps: sizeMB / (duration / 1000),
  }
}

// ─── Main ───

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║     Tau Terminal — VT Parser Performance Benchmark      ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log()
  console.log('Engine                    Duration   Throughput   Test')
  console.log('──────                    ────────   ──────────   ────')

  const results: { ghostty: Result; xterm: Result; speedup: number }[] = []

  // Test 1: "cat bigfile" — mostly plain text, 1MB
  const catData = generateMixedData(1, 0.01)
  const g1 = await benchGhostty(catData, 'cat 1MB (plain)')
  const x1 = await benchXtermJs(catData, 'cat 1MB (plain)')
  results.push({ ghostty: g1, xterm: x1, speedup: x1.durationMs / g1.durationMs })
  console.log(fmt(g1))
  console.log(fmt(x1))

  // Test 2: "compiler output" — heavy ANSI, 1MB
  const compData = generateMixedData(1, 0.5)
  const g2 = await benchGhostty(compData, 'compiler 1MB (ANSI-heavy)')
  const x2 = await benchXtermJs(compData, 'compiler 1MB (ANSI-heavy)')
  results.push({ ghostty: g2, xterm: x2, speedup: x2.durationMs / g2.durationMs })
  console.log(fmt(g2))
  console.log(fmt(x2))

  // Test 3: large file, 10MB
  const bigData = generateMixedData(10, 0.2)
  const g3 = await benchGhostty(bigData, 'large 10MB (mixed)')
  const x3 = await benchXtermJs(bigData, 'large 10MB (mixed)')
  results.push({ ghostty: g3, xterm: x3, speedup: x3.durationMs / g3.durationMs })
  console.log(fmt(g3))
  console.log(fmt(x3))

  // Test 4: burst of 1,000 tiny writes (latency-sensitive)
  console.log()
  console.log('─── Burst latency test (1,000 tiny writes) ───')

  const tinyChunks = Array.from({ length: 1000 }, () =>
    generateMixedData(0.01, 0.3).toString('utf-8'),
  )

  // Ghostty burst
  const wasmBin2 = fs.readFileSync(getGhosttyWasmPath())
  const mod2 = await WebAssembly.instantiate(wasmBin2, { env: { log: () => {} } })
  const exp2 = mod2.instance.exports as any
  const mem2 = exp2.memory as WebAssembly.Memory
  const th2 = exp2.ghostty_terminal_new(120, 40)

  const burstStartG = performance.now()
  for (const chunk of tinyChunks) {
    const enc = new TextEncoder().encode(chunk)
    const ptr = exp2.ghostty_wasm_alloc_u8_array(enc.length)
    new Uint8Array(mem2.buffer).set(enc, ptr)
    exp2.ghostty_terminal_write(th2, ptr, enc.length)
    exp2.ghostty_wasm_free_u8_array(ptr, enc.length)
  }
  const burstDurG = performance.now() - burstStartG
  exp2.ghostty_terminal_free(th2)

  // xterm burst
  const { Terminal: T2 } = await import('@xterm/xterm')
  const xt = new T2({ cols: 120, rows: 40, allowProposedApi: true })
  const burstStartX = performance.now()
  for (const chunk of tinyChunks) {
    await new Promise<void>((resolve) => xt.write(chunk, resolve))
  }
  const burstDurX = performance.now() - burstStartX
  xt.dispose()

  const burstSpeedup = burstDurX / burstDurG
  console.log(`  ghostty-web:  ${burstDurG.toFixed(1)} ms`)
  console.log(`  xterm.js:     ${burstDurX.toFixed(1)} ms`)
  results.push({
    ghostty: {
      name: 'burst',
      engine: 'ghostty-web (WASM)',
      sizeMB: 10,
      durationMs: burstDurG,
      throughputMBps: 0,
    },
    xterm: {
      name: 'burst',
      engine: 'xterm.js (JS)',
      sizeMB: 10,
      durationMs: burstDurX,
      throughputMBps: 0,
    },
    speedup: burstSpeedup,
  })

  // ─── Summary ───
  console.log()
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║                      SUMMARY                            ║')
  console.log('╠══════════════════════════════════════════════════════════╣')

  const avgSpeedup = results.reduce((s, r) => s + r.speedup, 0) / results.length
  for (const r of results) {
    console.log(`║  ${r.ghostty.name.padEnd(28)} ${r.speedup.toFixed(1)}× faster  ║`)
  }
  console.log(`╠══════════════════════════════════════════════════════════╣`)
  console.log(`║  Average speedup: ${avgSpeedup.toFixed(1)}×                              ║`)
  console.log(
    `║  ghostty-web peak: ${results[2].ghostty.throughputMBps.toFixed(0)} MB/s                        ║`,
  )
  console.log(
    `║  xterm.js peak:    ${results[2].xterm.throughputMBps.toFixed(0)} MB/s                        ║`,
  )
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log()
  console.log('Note: Benchmarks run in Node.js (headless, no rendering).')
  console.log(`ghostty-web baseline is loaded from npm package ${GHOSTTY_WEB_VERSION}`)
  console.log('without keeping ghostty-web in the desktop runtime dependency graph.')
}

main().catch((err) => {
  console.error('Benchmark failed:', err)
  process.exit(1)
})
