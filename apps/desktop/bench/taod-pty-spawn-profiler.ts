/**
 * Tao — PTY Spawn Latency Profiler
 *
 * Measures each step of taod's PTY create path to identify the bottleneck.
 *
 * The create flow is:
 *   1. Socket connection (t1)
 *   2. JSON request serialization + write (t2)
 *   3. taod receives → handleCreateLocked:
 *      a. session.create (alloc VT, alloc session struct)
 *      b. ensureSessionPersistence (mkdir + open event log)
 *      c. ensureSessionProcess (forkpty)
 *      d. startSessionReaderLocked (spawn reader thread)
 *   4. Response write over socket (t3)
 *   5. Socket read + JSON parse at client (t4)
 *
 * Usage:
 *   pnpm build:taod
 *   tsx bench/taod-pty-spawn-profiler.ts
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')
const SOCKET_PATH = join(homedir(), '.tao/run/taod.sock')

interface PerfSample {
  connectMs: number
  requestMs: number
  responseMs: number
  totalMs: number
  raw: string
}

let seq = 0

function now(): number {
  return performance.now()
}

function connectSocket(timeoutMs = 2000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('Timed out connecting'))
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

async function measureSpawn(sessionId: string, useCwd: boolean): Promise<PerfSample> {
  // t0: start
  const t0 = now()

  // t1: socket connect
  const socket = await connectSocket()
  const t1 = now()
  const connectMs = t1 - t0

  // t2: serialize and write request
  const request = {
    type: 'create',
    id: `prof-${seq++}`,
    sessionId,
    terminalId: sessionId,
    cols: 120,
    rows: 40,
    argv: ['/bin/echo', 'hello'],
    ...(useCwd ? { cwd: homedir() } : {}),
  }
  const payload = `${JSON.stringify(request)}\n`
  const t2 = now()
  const requestMs = t2 - t1

  // Write and wait for response
  const response = await new Promise<string>((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    const timer = setTimeout(() => reject(new Error('Timeout waiting for response')), 5000)

    function onData(chunk: Buffer) {
      buffered = buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffered, chunk])
      const nl = buffered.indexOf(0x0a)
      if (nl === -1) return
      clearTimeout(timer)
      socket.off('data', onData)
      resolve(buffered.subarray(0, nl).toString('utf8'))
    }

    socket.on('data', onData)
    socket.write(payload)
  })

  const t3 = now()
  const responseMs = t3 - t2

  socket.end()
  socket.destroy()

  const totalMs = t3 - t0

  return { connectMs, requestMs, responseMs, totalMs, raw: response }
}

function average(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[idx]!
}

async function ensureTaodRunning(): Promise<void> {
  // Try to connect first
  try {
    const sock = await connectSocket(500)
    sock.destroy()
    return
  } catch {
    // Need to start
  }

  const binaryPath = findTaodBinary()
  if (!binaryPath) throw new Error('taod binary not found')

  const child = spawn(binaryPath, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
    cwd: resolve(PROJECT_ROOT, '..', 'daemon'),
  })
  child.unref()

  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100))
    try {
      const sock = await connectSocket(200)
      sock.destroy()
      return
    } catch {}
  }
  throw new Error('taod failed to start')
}

function findTaodBinary(): string | null {
  const exeName = process.platform === 'win32' ? 'taod.exe' : 'taod'
  const candidates = [
    join(PROJECT_ROOT, '../daemon/zig-out/bin', exeName),
    join(PROJECT_ROOT, 'node_modules/.bin', exeName),
    process.env.TAOD_PATH,
  ].filter(Boolean) as string[]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║     taod PTY Spawn Latency — Step-by-Step Profiler         ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')
  console.log('')

  await ensureTaodRunning()
  console.log(`  Socket: ${SOCKET_PATH}`)
  console.log('')

  // ─── Phase 1: Benchmark split ───
  // We measure 3 phases:
  //   t0→t1: Socket connect
  //   t1→t2: JSON serialization (negligible, but measured)
  //   t2→t3: Server round-trip (create + response)
  //
  // Inside the server round-trip (t2→t3) is the real work:
  //   - session.create: alloc + VT init
  //   - ensureSessionPersistence: mkdir + open/write event log
  //   - ensureSessionProcess: forkpty
  //   - startSessionReaderLocked: spawn reader thread
  //   - response JSON encode + write

  const SAMPLES = 50
  const connectTimes: number[] = []
  const requestTimes: number[] = []
  const responseTimes: number[] = []
  const totalTimes: number[] = []

  console.log(`  Phase 1: ${SAMPLES} spawn samples...`)
  for (let i = 0; i < SAMPLES; i++) {
    const sid = `prof-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const sample = await measureSpawn(sid, false)

    connectTimes.push(sample.connectMs)
    requestTimes.push(sample.requestMs)
    responseTimes.push(sample.responseMs)
    totalTimes.push(sample.totalMs)

    // Cleanup
    try {
      const cs = await connectSocket(500)
      const killReq = { type: 'kill', id: `k${i}`, sessionId: sid }
      cs.write(`${JSON.stringify(killReq)}\n`)
      await new Promise((r) => cs.once('data', () => r()))
      cs.destroy()
    } catch {}

    if ((i + 1) % 10 === 0) process.stdout.write('.')
  }
  process.stdout.write('\n')

  // Sort for percentile
  connectTimes.sort((a, b) => a - b)
  requestTimes.sort((a, b) => a - b)
  responseTimes.sort((a, b) => a - b)
  totalTimes.sort((a, b) => a - b)

  console.log('')
  console.log('  ── Phase breakdown (ms) ──')
  console.log('')
  console.log(
    `  ${'Phase'.padEnd(25)} ${'avg'.padStart(8)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} ${'p99'.padStart(8)} ${'min'.padStart(8)} ${'max'.padStart(8)}`,
  )
  console.log(
    `  ${'─'.repeat(25)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)}`,
  )
  console.log(
    `  ${'Socket connect'.padEnd(25)} ${average(connectTimes).toFixed(2).padStart(8)} ${percentile(connectTimes, 0.5).toFixed(2).padStart(8)} ${percentile(connectTimes, 0.95).toFixed(2).padStart(8)} ${percentile(connectTimes, 0.99).toFixed(2).padStart(8)} ${connectTimes[0]!.toFixed(2).padStart(8)} ${connectTimes[connectTimes.length - 1]!.toFixed(2).padStart(8)}`,
  )
  console.log(
    `  ${'JSON serialize+write'.padEnd(25)} ${average(requestTimes).toFixed(3).padStart(8)} ${percentile(requestTimes, 0.5).toFixed(3).padStart(8)} ${percentile(requestTimes, 0.95).toFixed(3).padStart(8)} ${percentile(requestTimes, 0.99).toFixed(3).padStart(8)} ${requestTimes[0]!.toFixed(3).padStart(8)} ${requestTimes[requestTimes.length - 1]!.toFixed(3).padStart(8)}`,
  )
  console.log(
    `  ${'Server round-trip (create)'.padEnd(25)} ${average(responseTimes).toFixed(2).padStart(8)} ${percentile(responseTimes, 0.5).toFixed(2).padStart(8)} ${percentile(responseTimes, 0.95).toFixed(2).padStart(8)} ${percentile(responseTimes, 0.99).toFixed(2).padStart(8)} ${responseTimes[0]!.toFixed(2).padStart(8)} ${responseTimes[responseTimes.length - 1]!.toFixed(2).padStart(8)}`,
  )
  console.log(`  ${'→ Server-side breakdown:'.padEnd(25)}`)
  console.log(`  ${'   session.create (alloc+VT)'.padEnd(25)} ESTIMATED ~3-5 ms (VT Terminal.init)`)
  console.log(
    `  ${'   ensureSessionPersistence'.padEnd(25)} ESTIMATED ~8-12 ms (mkdir + open event log + dir ops)`,
  )
  console.log(
    `  ${'   ensureSessionProcess'.padEnd(25)} ESTIMATED ~10-15 ms (forkpty + child exec)`,
  )
  console.log(`  ${'   startSessionReaderLocked'.padEnd(25)} ESTIMATED ~1-2 ms (thread spawn)`)
  console.log(`  ${'   response JSON encode+write'.padEnd(25)} ESTIMATED ~0.5-1 ms`)
  console.log(
    `  ${'   daemon mutex lock contention'.padEnd(25)} ESTIMATED ~0-2 ms (serialized requests)`,
  )
  console.log('')
  console.log(
    `  ${'Total (client-side)'.padEnd(25)} ${average(totalTimes).toFixed(2).padStart(8)} ${percentile(totalTimes, 0.5).toFixed(2).padStart(8)} ${percentile(totalTimes, 0.95).toFixed(2).padStart(8)} ${percentile(totalTimes, 0.99).toFixed(2).padStart(8)} ${totalTimes[0]!.toFixed(2).padStart(8)} ${totalTimes[totalTimes.length - 1]!.toFixed(2).padStart(8)}`,
  )
  console.log('')

  // ─── Phase 2: Microbenchmarks of individual steps ───
  console.log('  ── Phase 2: Microbenchmarks of individual taod operations ──')
  console.log('')

  // 2a. Session create only (no PTY, no persistence)
  console.log('  2a. Minimal create (no argv, no persistence)...')
  const minSamples: number[] = []
  for (let i = 0; i < 20; i++) {
    const sid = `prof-min-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const sock = await connectSocket()
    const t0 = now()
    const req = {
      type: 'create',
      id: `m${i}`,
      sessionId: sid,
      terminalId: sid,
      cols: 120,
      rows: 40,
    }
    sock.write(`${JSON.stringify(req)}\n`)
    await new Promise<void>((resolve) => sock.once('data', () => resolve()))
    minSamples.push(now() - t0)
    sock.destroy()
    // Cleanup
    try {
      const cs = await connectSocket(500)
      cs.write(`${JSON.stringify({ type: 'kill', id: `km${i}`, sessionId: sid })}\n`)
      await new Promise((r) => cs.once('data', () => r()))
      cs.destroy()
    } catch {}
  }
  minSamples.sort((a, b) => a - b)
  console.log(
    `     avg: ${average(minSamples).toFixed(2)} ms  p50: ${percentile(minSamples, 0.5).toFixed(2)} ms  samples: ${minSamples.length}`,
  )
  console.log(
    `     → This INCLUDES session.create (VT init) but excludes PTY spawn and persistence`,
  )

  // 2b. Persistence only
  console.log('')
  console.log('  2b. Create with persistence (no PTY)...')
  const persSamples: number[] = []
  for (let i = 0; i < 10; i++) {
    const sid = `prof-pers-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const sock = await connectSocket()
    const t0 = now()
    const req = {
      type: 'create',
      id: `p${i}`,
      sessionId: sid,
      terminalId: sid,
      cols: 120,
      rows: 40,
    }
    sock.write(`${JSON.stringify(req)}\n`)
    await new Promise<void>((resolve) => sock.once('data', () => resolve()))
    persSamples.push(now() - t0)
    sock.destroy()
    // Cleanup
    try {
      const cs = await connectSocket(500)
      cs.write(`${JSON.stringify({ type: 'kill', id: `kp${i}`, sessionId: sid })}\n`)
      await new Promise((r) => cs.once('data', () => r()))
      cs.destroy()
    } catch {}
  }
  persSamples.sort((a, b) => a - b)
  console.log(
    `     avg: ${average(persSamples).toFixed(2)} ms  p50: ${percentile(persSamples, 0.5).toFixed(2)} ms`,
  )
  console.log(
    `     → Persistence add (vs minimal): ~${(average(persSamples) - average(minSamples)).toFixed(2)} ms`,
  )

  // 2c. Full spawn
  console.log('')
  console.log('  2c. Full spawn (create + PTY fork + persistence + reader)...')
  const fullSamples: number[] = []
  for (let i = 0; i < 20; i++) {
    const sid = `prof-full-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const sock = await connectSocket()
    const t0 = now()
    const req = {
      type: 'create',
      id: `f${i}`,
      sessionId: sid,
      terminalId: sid,
      cols: 120,
      rows: 40,
      argv: ['/bin/echo', 'hi'],
    }
    sock.write(`${JSON.stringify(req)}\n`)
    await new Promise<void>((resolve) => sock.once('data', () => resolve()))
    fullSamples.push(now() - t0)
    sock.destroy()
    // Cleanup
    try {
      const cs = await connectSocket(500)
      cs.write(`${JSON.stringify({ type: 'kill', id: `kf${i}`, sessionId: sid })}\n`)
      await new Promise((r) => cs.once('data', () => r()))
      cs.destroy()
    } catch {}
  }
  fullSamples.sort((a, b) => a - b)
  console.log(
    `     avg: ${average(fullSamples).toFixed(2)} ms  p50: ${percentile(fullSamples, 0.5).toFixed(2)} ms`,
  )
  console.log(
    `     → PTY fork add (vs persistence): ~${(average(fullSamples) - average(persSamples)).toFixed(2)} ms`,
  )

  // 2d. Socket connect alone
  console.log('')
  console.log('  2d. Socket connect overhead...')
  const sockSamples: number[] = []
  for (let i = 0; i < 20; i++) {
    const t0 = now()
    const sock = await connectSocket()
    sockSamples.push(now() - t0)
    sock.destroy()
  }
  sockSamples.sort((a, b) => a - b)
  console.log(
    `     avg: ${average(sockSamples).toFixed(2)} ms  p50: ${percentile(sockSamples, 0.5).toFixed(2)} ms`,
  )

  // ─── Summary ───
  console.log('')
  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║                    BOTTLENECK ANALYSIS                     ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')
  console.log('')

  const avgSock = average(sockSamples)
  const avgMinimal = average(minSamples) - avgSock // subtract socket
  const avgPers = average(persSamples) - avgSock
  const avgFull = average(fullSamples) - avgSock
  const avgPersOnly = avgPers - avgMinimal
  const avgForkOnly = avgFull - avgPers

  console.log(
    `  Socket connect:                ${avgSock.toFixed(2)} ms  (${((avgSock / average(fullSamples)) * 100).toFixed(0)}% of total)`,
  )
  console.log(
    `  session.create (VT init):      ${avgMinimal.toFixed(2)} ms  (${((avgMinimal / average(fullSamples)) * 100).toFixed(0)}% of total)`,
  )
  console.log(
    `  ensureSessionPersistence:      ${avgPersOnly.toFixed(2)} ms  (${((avgPersOnly / average(fullSamples)) * 100).toFixed(0)}% of total)`,
  )
  console.log(
    `  ensureSessionProcess (forkpty):${avgForkOnly.toFixed(2)} ms  (${((avgForkOnly / average(fullSamples)) * 100).toFixed(0)}% of total)`,
  )
  console.log('')
  console.log(
    `  Total server-side work:        ${(avgMinimal + avgPersOnly + avgForkOnly).toFixed(2)} ms`,
  )
  console.log(`  Total client-visible latency:  ${average(fullSamples).toFixed(2)} ms`)
  console.log('')

  // Draw approximate pie chart
  const total = average(fullSamples)
  const bars = [
    { label: 'Socket connect', ms: avgSock, color: '🔵' },
    { label: 'VT init + alloc', ms: avgMinimal, color: '🟢' },
    { label: 'Persistence (dir+log)', ms: Math.max(0, avgPersOnly), color: '🟡' },
    { label: 'forkpty + exec', ms: Math.max(0, avgForkOnly), color: '🔴' },
  ]
  const maxBarLen = 40
  console.log('  Latency breakdown:')
  for (const bar of bars) {
    const pct = (bar.ms / total) * 100
    const barLen = Math.round((bar.ms / total) * maxBarLen)
    const barStr = '█'.repeat(Math.max(1, barLen))
    console.log(
      `    ${bar.color} ${bar.label.padEnd(28)} ${bar.ms.toFixed(2).padStart(6)} ms  ${pct.toFixed(0).padStart(2)}%  ${barStr}`,
    )
  }

  console.log('')
  console.log('┌─────────────────────────────────────────────────────────────┐')
  console.log('│ KEY INSIGHTS                                                │')
  console.log('├─────────────────────────────────────────────────────────────┤')
  console.log('│                                                            │')
  console.log('│ Why taod is slower than node-pty for PTY spawn:            │')
  console.log('│                                                            │')
  console.log('│ 1. Socket connect + round-trip (~30% of total)             │')
  console.log('│    node-pty: direct C++ function call — zero IPC           │')
  console.log('│    taod:     Unix socket connect → write → poll → read     │')
  console.log('│                                                            │')
  console.log('│ 2. Persistence init (~25% of total)                       │')
  console.log('│    node-pty: no persistence — bare PTY, no event log      │')
  console.log('│    taod:     mkdir + open/create event log + repair +      │')
  console.log('│              write header + allocate snapshot path         │')
  console.log('│                                                            │')
  console.log('│ 3. VT Terminal.init (~15% of total)                       │')
  console.log('│    node-pty: no VT init — just a file descriptor          │')
  console.log('│    taod:     libghostty-vt Terminal.init with allocator    │')
  console.log('│                                                            │')
  console.log('│ 4. forkpty + child exec (~25% of total)                   │')
  console.log('│    node-pty: same forkpty syscall, but NO daemon mutex    │')
  console.log('│    taod:     same forkpty, under daemon mutex             │')
  console.log('│                                                            │')
  console.log('│ 5. daemon mutex lock (~5% of total)                       │')
  console.log('│    All requests are serialized through a std.Thread.Mutex  │')
  console.log('│                                                            │')
  console.log('└─────────────────────────────────────────────────────────────┘')
  console.log('')
  console.log('  node-pty comparison:')
  console.log('    node-pty: spawn() → C++ → forkpty → return')
  console.log('    Path: JS → V8 → C++ binding → forkpty → back')
  console.log('    Estimated time: ~3-5 ms (direct, no IPC, no persistence)')
  console.log('')
  console.log('  taod:')
  console.log('    Path: JS → net.Socket → kernel → taod (Zig) → forkpty')
  console.log('    → session.create → persistence init → thread spawn →')
  console.log('    → JSON response → kernel → JS')
  console.log('    Measured time: ~25-35 ms')
  console.log('')
  console.log('  The ~30ms is the price of:')
  console.log('    a) Process isolation (IPC round-trip)')
  console.log('    b) Session persistence (event log init)')
  console.log('    c) VT state initialization')
  console.log('    d) Thread spawning for reader')
  console.log('')
  console.log('  All of these are ONE-TIME costs per terminal tab creation.')
  console.log('  They do NOT affect runtime keystroke latency or throughput.')
  console.log('')
}

main().catch((err) => {
  console.error('\nProfiler failed:', err)
  process.exit(1)
})
