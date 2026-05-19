/**
 * Tao — Input Latency Benchmark via taod (Zig daemon)
 *
 * Measures keystroke-to-echo latency through the full taod pipeline:
 *   write → taod socket → Zig VT parser → binary stream output
 *
 * This replaces the old node-pty-era latency benchmark.
 *
 * Usage: npx tsx bench/latency-taod.ts [samples]
 *
 * Environment:
 *   TAOD_SOCKET_PATH - override Unix socket path (default: ~/.tao/run/taod.sock)
 */

import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'

const SAMPLES = parseInt(process.argv[2] || '100', 10)
const SOCKET_PATH = process.env.TAOD_SOCKET_PATH || join(homedir(), '.tao/run/taod.sock')

// ─── TASF Protocol Constants ───

const MAGIC = 0x54415346
const SESSION_ID_SIZE = 64
const HEADER_SIZE = 88

// ─── Helpers ───

function now(): number {
  return performance.now()
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]!
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function encodeStreamFrame(kind: number, sessionId: string, seq: bigint, payload: Buffer): Buffer {
  const totalLen = HEADER_SIZE + payload.length
  const buf = Buffer.alloc(totalLen)
  buf.writeUInt32BE(MAGIC, 0)
  buf.writeUInt16BE(1, 4) // version
  buf.writeUInt16BE(kind, 6)
  buf.fill(0, 8, 8 + SESSION_ID_SIZE)
  buf.write(sessionId, 8, SESSION_ID_SIZE, 'utf8')
  buf.writeBigUInt64BE(seq, 72)
  buf.writeUInt32BE(payload.length, 80)
  buf.writeUInt32BE(crc32(payload), 84)
  payload.copy(buf, HEADER_SIZE)
  return buf
}

function readPaddedSessionId(buffer: Buffer, offset: number): string {
  const text = buffer.toString('utf8', offset, offset + SESSION_ID_SIZE)
  const nulOffset = text.indexOf('\u0000')
  return nulOffset === -1 ? text : text.slice(0, nulOffset)
}

function connectSocket(timeoutMs = 3000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`Timed out connecting to taod at ${SOCKET_PATH}`))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function sendJson(
  socket: net.Socket,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    const timer = setTimeout(() => reject(new Error('Timeout waiting for taod response')), 5000)

    function onData(chunk: Buffer) {
      buffered = buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffered, chunk])
      const nl = buffered.indexOf(0x0a)
      if (nl === -1) return
      clearTimeout(timer)
      socket.off('data', onData)
      try {
        resolve(JSON.parse(buffered.subarray(0, nl).toString('utf8')))
      } catch {
        reject(new Error(`Failed to parse taod response`))
      }
    }
    socket.on('data', onData)
    socket.write(`${JSON.stringify(request)}\n`)
  })
}

// ─── Benchmark ───

async function runLatencyBenchmark() {
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║   Tao — Input Latency Benchmark (taod Zig daemon)      ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log('')
  console.log(`  Samples:  ${SAMPLES}`)
  console.log(`  Socket:   ${SOCKET_PATH}`)
  console.log(`  Platform: ${platform()} ${process.arch}`)
  console.log('')

  // Step 1: Create a session with a simple echo shell
  console.log('─── 1. Creating echo shell session ───')

  const sessionId = `latency-bench-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

  const ctrlSocket = await connectSocket()
  const createResp = await sendJson(ctrlSocket, {
    type: 'create',
    id: 'lat-create',
    sessionId,
    terminalId: sessionId,
    cols: 120,
    rows: 40,
    argv: ['/bin/sh', '-c', 'while IFS= read -r c; do printf "%s" "$c"; done'],
  })
  ctrlSocket.end()
  ctrlSocket.destroy()

  if (!createResp.ok) {
    console.error(`  Failed to create session: ${createResp.error_message || 'unknown error'}`)
    process.exit(1)
  }
  console.log(`  Session created: ${sessionId}`)

  // Wait for shell to initialize
  await new Promise((r) => setTimeout(r, 300))

  // Step 2: Attach to get streaming socket
  console.log('')
  console.log('─── 2. Attaching to stream socket ───')

  const streamSocket = await connectSocket()
  const attachResp = await sendJson(streamSocket, {
    type: 'attach',
    id: 'lat-attach',
    sessionId,
  })

  if (!attachResp.ok) {
    console.error(`  Failed to attach: ${attachResp.error_message || 'unknown error'}`)
    process.exit(1)
  }
  console.log(`  Attached. Starting latency measurements...`)

  // The attach response is followed by binary stream frames on the same socket

  // Step 3: Measure latency
  console.log('')
  console.log('─── 3. Measuring keystroke echo latency ───')

  const latencies: number[] = []
  let seq = 0n
  let echoBuf = Buffer.alloc(0)
  let pendingEcho: { byte: string; resolve: () => void } | null = null

  // Process incoming binary frames
  streamSocket.on('data', (chunk: Buffer) => {
    echoBuf = echoBuf.length === 0 ? Buffer.from(chunk) : Buffer.concat([echoBuf, chunk])

    // Parse all complete frames
    while (true) {
      if (echoBuf.length < HEADER_SIZE) break
      const magic = echoBuf.readUInt32BE(0)
      if (magic !== MAGIC) {
        echoBuf = echoBuf.subarray(1)
        continue
      }
      const kind = echoBuf.readUInt16BE(6)
      const sess_id = readPaddedSessionId(echoBuf, 8)
      const length = echoBuf.readUInt32BE(80)
      const frameSize = HEADER_SIZE + length
      if (echoBuf.length < frameSize) break

      if (sess_id === sessionId && kind === 1 && pendingEcho) {
        const payload = echoBuf.subarray(HEADER_SIZE, frameSize)
        const text = payload.toString('utf8')
        if (text.includes(pendingEcho.byte)) {
          const elapsed = now() - startTime
          latencies.push(elapsed)
          const resolve = pendingEcho.resolve
          pendingEcho = null
          resolve()
        }
      }

      echoBuf = echoBuf.subarray(frameSize)
    }
  })

  streamSocket.once('error', (err) => {
    console.error('  Stream error:', err.message)
  })

  let startTime = 0

  // Send individual bytes and time echo
  for (let i = 0; i < SAMPLES; i++) {
    const byte = String.fromCharCode(97 + (i % 26)) // a-z cycling
    const payload = Buffer.from(byte, 'utf8')

    await new Promise<void>((resolve) => {
      pendingEcho = { byte, resolve }
      startTime = now()
      seq++
      const frame = encodeStreamFrame(2, sessionId, seq, payload) // 2 = Input
      streamSocket.write(frame)
    })

    if ((i + 1) % 20 === 0) process.stdout.write('.')
  }
  process.stdout.write('\n')

  // Cleanup
  streamSocket.end()
  streamSocket.destroy()

  const killSocket = await connectSocket(1000)
  await sendJson(killSocket, { type: 'kill', id: 'lat-kill', sessionId })
  killSocket.end()
  killSocket.destroy()

  // ─── Results ───
  latencies.sort((a, b) => a - b)
  const count = latencies.length
  const sum = latencies.reduce((a, b) => a + b, 0)
  const avg = sum / count
  const min = latencies[0]!
  const max = latencies[count - 1]!
  const p50 = latencies[Math.min(count - 1, Math.floor(count * 0.5))]
  const p95 = latencies[Math.min(count - 1, Math.floor(count * 0.95))]
  const p99 = latencies[Math.min(count - 1, Math.floor(count * 0.99))]

  console.log('')
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║                      RESULTS                           ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log('')
  console.log('  taod (Zig daemon) — full pipeline latency:')
  console.log('    write → socket → taod → PTY → echo → taod → output frame')
  console.log('')
  console.log(`    samples: ${count}`)
  console.log(`    avg:     ${avg.toFixed(2)} ms`)
  console.log(`    p50:     ${p50.toFixed(2)} ms`)
  console.log(`    p95:     ${p95.toFixed(2)} ms`)
  console.log(`    p99:     ${p99.toFixed(2)} ms`)
  console.log(`    min:     ${min.toFixed(2)} ms`)
  console.log(`    max:     ${max.toFixed(2)} ms`)
  console.log('')
  console.log('  ── Comparison with node-pty era ──')
  console.log('')
  console.log('  Old benchmark (node-pty + ghostty-web WASM):')
  console.log('    avg: ~2-4 ms    p50: ~2-3 ms    p95: ~4-6 ms    p99: ~6-10 ms')
  console.log('')
  console.log('  New benchmark (taod Zig daemon + libghostty-vt native):')
  console.log(
    `    avg: ${avg.toFixed(2)} ms    p50: ${p50.toFixed(2)} ms    p95: ${p95.toFixed(2)} ms    p99: ${p99.toFixed(2)} ms`,
  )
  console.log('')
  console.log('  Note: The old benchmark measured PTY→parser latency directly')
  console.log('  (no Electron, no socket IPC). The new benchmark includes the')
  console.log('  full taod pipeline: write → Unix socket → Zig VT parse →')
  console.log('  binary stream → read. The extra IPC hop adds ~1-3ms.')
  console.log('')
  console.log('  The key advantage of taod is NOT raw latency — it is:')
  console.log('  1. No V8 GC pauses (predictable p99/p999)')
  console.log('  2. Separate process (survives Electron restart)')
  console.log('  3. Native VT parsing (higher throughput)')
  console.log('  4. Binary stream protocol (lower overhead)')
  console.log('')
}

runLatencyBenchmark().catch((err) => {
  console.error('\nBenchmark failed:', err)
  process.exit(1)
})
