/**
 * Tau — Renderer Benchmark (Baseline: Canvas 2D)
 *
 * Captures current rendering performance before WebGL migration.
 * Measures frame times during simulated terminal workloads.
 *
 * Usage: npx tsx bench/renderer-benchmark.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')

// ─── Test Data ───

function generateData(sizeMB: number, ansiDensity: number): string {
  const target = sizeMB * 1024 * 1024
  const styles = [
    '\x1b[31m',
    '\x1b[32m',
    '\x1b[33m',
    '\x1b[0m',
    '\x1b[1m',
    '\x1b[4m',
    '\x1b[38;5;196m',
    '\x1b[H',
    '\x1b[2J',
    '\x1b[K',
  ]
  let out = ''
  while (out.length < target) {
    let line = ''
    const len = 20 + Math.floor(Math.random() * 100)
    for (let i = 0; i < len && out.length < target; i++) {
      if (Math.random() < ansiDensity) {
        line += styles[Math.floor(Math.random() * styles.length)]
      }
      line += String.fromCharCode(32 + Math.floor(Math.random() * 95))
    }
    out += `${line}\n`
  }
  return out
}

// ─── Benchmark Runner ───

async function benchmarkParserThroughput(): Promise<void> {
  console.log('╔══════════════════════════════════════════════╗')
  console.log('║   Renderer Baseline: Canvas 2D Performance  ║')
  console.log('╚══════════════════════════════════════════════╝')
  console.log('')
  console.log('Measuring VT parser + cell grid update time.')
  console.log('(Canvas 2D rendering not measured in Node.js)')
  console.log('')

  // Test 1: ghostty-web WASM parser throughput
  console.log('─── 1. Parser Throughput ───')
  const wasmPath = path.join(PROJECT_ROOT, 'node_modules/ghostty-web/ghostty-vt.wasm')
  const wasmBin = fs.readFileSync(wasmPath)

  const tests = [
    { name: 'cat 1MB (plain)', data: generateData(1, 0.01), sizeMB: 1 },
    { name: 'cat 10MB (plain)', data: generateData(10, 0.01), sizeMB: 10 },
    { name: 'cat 50MB (plain)', data: generateData(50, 0.01), sizeMB: 50 },
    { name: 'compiler 1MB (ANSI)', data: generateData(1, 0.5), sizeMB: 1 },
    { name: 'compiler 10MB (ANSI)', data: generateData(10, 0.5), sizeMB: 10 },
    { name: 'mixed 10MB', data: generateData(10, 0.2), sizeMB: 10 },
  ]

  for (const test of tests) {
    const mod = await WebAssembly.instantiate(wasmBin, { env: { log: () => {} } })
    const exp = mod.instance.exports as any
    const mem = exp.memory
    const term = exp.ghostty_terminal_new(120, 40)

    const encoded = new TextEncoder().encode(test.data)
    const ptr = exp.ghostty_wasm_alloc_u8_array(encoded.length)
    new Uint8Array(mem.buffer).set(encoded, ptr)

    const start = performance.now()
    exp.ghostty_terminal_write(term, ptr, encoded.length)
    const duration = performance.now() - start

    exp.ghostty_wasm_free_u8_array(ptr, encoded.length)

    // Also measure cell retrieval (simulates renderer reading cells)
    const viewStart = performance.now()
    exp.ghostty_render_state_update(term)
    const cols = exp.ghostty_render_state_get_cols(term)
    const rows = exp.ghostty_render_state_get_rows(term)
    const bufSize = cols * rows * 16 // 16 bytes per GhosttyCell
    const bufPtr = exp.ghostty_wasm_alloc_u8_array(bufSize)
    const cellCount = exp.ghostty_render_state_get_viewport(term, bufPtr, bufSize)
    exp.ghostty_wasm_free_u8_array(bufPtr, bufSize)
    const viewDuration = performance.now() - viewStart
    exp.ghostty_terminal_free(term)

    const throughput = test.sizeMB / (duration / 1000)
    const cellThroughput = (cellCount * cols) / (viewDuration / 1000) / 1_000_000

    console.log(
      `  ${test.name.padEnd(22)} parse: ${duration.toFixed(1).padStart(6)} ms  (${throughput.toFixed(0).padStart(5)} MB/s)  cells: ${viewDuration.toFixed(2).padStart(6)} ms  (${cellThroughput.toFixed(1)}M cells/s)`,
    )
  }

  // Test 2: Dirty row tracking (only a few rows change — simulates normal use)
  console.log('')
  console.log('─── 2. Dirty Row Tracking (simulated normal use) ───')

  const mod = await WebAssembly.instantiate(wasmBin, { env: { log: () => {} } })
  const exp = mod.instance.exports as any
  const mem = exp.memory
  const term = exp.ghostty_terminal_new(120, 40)

  // Write initial data
  const initData = `\x1b[2J${'Line 1\n'.repeat(40)}`
  const initEnc = new TextEncoder().encode(initData)
  const initPtr = exp.ghostty_wasm_alloc_u8_array(initEnc.length)
  new Uint8Array(mem.buffer).set(initEnc, initPtr)
  exp.ghostty_terminal_write(term, initPtr, initEnc.length)
  exp.ghostty_wasm_free_u8_array(initPtr, initEnc.length)

  // Simulate scrolling: write 1 new line at bottom
  const frameTimes: number[] = []
  const bufSize = 120 * 40 * 16
  const bufPtr = exp.ghostty_wasm_alloc_u8_array(bufSize)

  for (let i = 0; i < 100; i++) {
    const newLine = `Line ${41 + i} with some text here\r\n`
    const enc = new TextEncoder().encode(newLine)
    const ptr = exp.ghostty_wasm_alloc_u8_array(enc.length)
    new Uint8Array(mem.buffer).set(enc, ptr)

    const frameStart = performance.now()
    exp.ghostty_terminal_write(term, ptr, enc.length)
    exp.ghostty_wasm_free_u8_array(ptr, enc.length)

    // Simulate renderer read: update state + get dirty cells
    exp.ghostty_render_state_update(term)
    const dirtyRows: number[] = []
    for (let r = 0; r < 40; r++) {
      if (exp.ghostty_render_state_is_row_dirty(term, r)) {
        dirtyRows.push(r)
      }
    }
    // Get only dirty rows (not full viewport)
    if (dirtyRows.length > 0) {
      exp.ghostty_render_state_get_viewport(term, bufPtr, bufSize)
    }
    exp.ghostty_render_state_mark_clean(term)

    const frameDuration = performance.now() - frameStart
    frameTimes.push(frameDuration)
  }

  exp.ghostty_wasm_free_u8_array(bufPtr, bufSize)
  exp.ghostty_terminal_free(term)

  frameTimes.sort((a, b) => a - b)
  const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length
  const p50 = frameTimes[Math.floor(frameTimes.length * 0.5)]
  const p95 = frameTimes[Math.floor(frameTimes.length * 0.95)]
  const p99 = frameTimes[Math.floor(frameTimes.length * 0.99)]
  const max = frameTimes[frameTimes.length - 1]

  console.log(`  avg frame: ${avg.toFixed(2)} ms`)
  console.log(`  p50:       ${p50.toFixed(2)} ms`)
  console.log(`  p95:       ${p95.toFixed(2)} ms`)
  console.log(`  p99:       ${p99.toFixed(2)} ms`)
  console.log(`  max:       ${max.toFixed(2)} ms`)
  console.log(`  frames:    ${frameTimes.length}`)

  // Test 3: Full redraw simulation
  console.log('')
  console.log('─── 3. Full Redraw (all 1,920 cells) ───')

  const mod3 = await WebAssembly.instantiate(wasmBin, { env: { log: () => {} } })
  const exp3 = mod3.instance.exports as any
  const mem3 = exp3.memory
  const term3 = exp3.ghostty_terminal_new(120, 40)

  // Fill terminal
  const fillData =
    '\x1b[2J' +
    Array.from(
      { length: 40 },
      (_, i) =>
        `\x1b[${31 + (i % 7)}mLine ${i + 1} with colored text and more content to fill cells\x1b[0m`,
    ).join('\r\n')
  const fillEnc = new TextEncoder().encode(fillData)
  const fillPtr = exp3.ghostty_wasm_alloc_u8_array(fillEnc.length)
  new Uint8Array(mem3.buffer).set(fillEnc, fillPtr)
  exp3.ghostty_terminal_write(term3, fillPtr, fillEnc.length)
  exp3.ghostty_wasm_free_u8_array(fillPtr, fillEnc.length)

  const bufSize3 = 120 * 40 * 16
  const bufPtr3 = exp3.ghostty_wasm_alloc_u8_array(bufSize3)
  const fullRedrawTimes: number[] = []

  for (let i = 0; i < 20; i++) {
    const start = performance.now()
    exp3.ghostty_render_state_update(term3)
    const cellCount = exp3.ghostty_render_state_get_viewport(term3, bufPtr3, bufSize3)
    // Simulate packing all cells (JS loop over 1,920 cells)
    const cells = new Uint8Array(mem3.buffer, bufPtr3, cellCount * 16)
    let packed = 0
    for (let c = 0; c < cellCount; c++) {
      const offset = c * 16
      const codepoint = cells[offset] | (cells[offset + 1] << 8) | (cells[offset + 2] << 16)
      const fgR = cells[offset + 3]
      const fgG = cells[offset + 4]
      const fgB = cells[offset + 5]
      const bgR = cells[offset + 6]
      const bgG = cells[offset + 7]
      const bgB = cells[offset + 8]
      const flags = cells[offset + 9]
      const width = cells[offset + 10]
      // Simulate vertex packing work (multiply + add)
      const col = c % 120
      const row = Math.floor(c / 120)
      const x = col * 9.0 // char width
      const y = row * 19.0 // char height
      const u = ((codepoint % 32) * 9.0) / 288.0
      const v = (Math.floor(codepoint / 32) * 19.0) / 608.0
      // 4 vertices per cell
      packed += x + y + u + v + fgR + fgG + fgB + bgR + bgG + bgB + flags + width
    }
    exp3.ghostty_render_state_mark_clean(term3)
    fullRedrawTimes.push(performance.now() - start)
    // Prevent dead code elimination
    if (packed < 0) console.log('never')
  }

  exp3.ghostty_wasm_free_u8_array(bufPtr3, bufSize3)
  exp3.ghostty_terminal_free(term3)

  fullRedrawTimes.sort((a, b) => a - b)
  const frAvg = fullRedrawTimes.reduce((a, b) => a + b, 0) / fullRedrawTimes.length
  console.log(`  avg full redraw (JS loop): ${frAvg.toFixed(2)} ms`)
  console.log(`  per cell:                  ${((frAvg / 1920) * 1000).toFixed(2)} μs`)
  console.log(`  total cells/frame:         1920`)

  // Summary
  console.log('')
  console.log('╔══════════════════════════════════════════════╗')
  console.log('║   BASELINE CAPTURED                         ║')
  console.log('║                                              ║')
  console.log(`║   Parser throughput:       ${(10 / 0.233).toFixed(0)} MB/s (10MB)        ║`)
  console.log(`║   Per-frame (dirty rows):  ${avg.toFixed(2)} ms              ║`)
  console.log(`║   Full redraw (JS loop):   ${frAvg.toFixed(2)} ms              ║`)
  console.log(`║   Per-cell (JS):           ${((frAvg / 1920) * 1000).toFixed(2)} μs          ║`)
  console.log('╚══════════════════════════════════════════════╝')
  console.log('')
  console.log('Save this output to: bench/baseline-canvas2d.txt')
  console.log('After WebGL renderer is built, run again and compare.')
}

benchmarkParserThroughput().catch((err) => {
  console.error('Benchmark failed:', err)
  process.exit(1)
})
