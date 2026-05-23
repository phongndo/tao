/**
 * Tao - Input latency benchmark via taod.
 *
 * Measures a small input token through:
 *   TS stream frame write -> Unix socket -> taod -> PTY -> echo process ->
 *   taod output frame -> TS stream parser.
 *
 * Use TAO_LATENCY_BENCH_MANAGED_TAOD=1 for CI/package smoke runs. That mode
 * launches the built taod binary under a temporary HOME and cleans it up.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import { homedir, platform, tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveTaoStoragePaths } from '@tao/shared/storage-path'
import { TaodStreamFrameKind } from '@tao/shared/taod-protocol'
import { encodeTaodStreamFrame, TaodStreamFrameParser } from '../src/main/taod-stream'

type ControlResponse = Record<string, unknown>

type ManagedTaod = {
  readonly home: string
  readonly socketPath: string
  readonly child: ChildProcess
  readonly cleanup: () => Promise<void>
}

const benchDir = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(benchDir, '..')
const repoRoot = resolve(desktopRoot, '../..')

const SAMPLES = positiveInt(process.argv[2] ?? process.env.TAO_LATENCY_BENCH_SAMPLES, 100)
const MANAGED_TAOD = process.env.TAO_LATENCY_BENCH_MANAGED_TAOD === '1'
const ENFORCE = process.env.TAO_LATENCY_BENCH_ENFORCE === '1'
const MAX_P50_MS = nonNegativeInt(process.env.TAO_LATENCY_MAX_P50_MS, 0)
const MAX_P95_MS = nonNegativeInt(process.env.TAO_LATENCY_MAX_P95_MS, 0)
const MAX_P99_MS = nonNegativeInt(process.env.TAO_LATENCY_MAX_P99_MS, 0)
const MAX_MAX_MS = nonNegativeInt(process.env.TAO_LATENCY_MAX_MAX_MS, 0)

let socketPath =
  process.env.TAOD_SOCKET_PATH || resolveTaoStoragePaths(process.env.HOME || homedir()).socket

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function now(): number {
  return performance.now()
}

function findTaodBinary(): string | null {
  const exeName = process.platform === 'win32' ? 'taod.exe' : 'taod'
  const candidates = [
    process.env.TAOD_PATH,
    resolve(desktopRoot, 'out/bin', exeName),
    resolve(repoRoot, 'apps/daemon/zig-out/bin', exeName),
  ].filter(Boolean) as string[]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function connectSocket(timeoutMs = 3000): Promise<net.Socket> {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = net.createConnection(socketPath)
    const timer = setTimeout(() => {
      socket.destroy()
      rejectSocket(new Error(`Timed out connecting to taod at ${socketPath}`))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolveSocket(socket)
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      rejectSocket(err)
    })
  })
}

async function writeAll(
  socket: net.Socket,
  payload: string | Buffer,
  context: string,
): Promise<void> {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    const cleanup = () => {
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const onError = (error: Error) => {
      cleanup()
      rejectWrite(error)
    }
    const onClose = () => {
      cleanup()
      rejectWrite(new Error(`taod closed socket while writing ${context}`))
    }
    socket.once('error', onError)
    socket.once('close', onClose)
    socket.write(payload, (error) => {
      cleanup()
      if (error) rejectWrite(error)
      else resolveWrite()
    })
  })
}

function sendJson(
  socket: net.Socket,
  request: Record<string, unknown>,
): Promise<{ response: ControlResponse; tail: Buffer }> {
  return new Promise((resolveResponse, rejectResponse) => {
    let buffered = Buffer.alloc(0)
    const timer = setTimeout(() => {
      cleanup()
      rejectResponse(new Error('Timeout waiting for taod response'))
    }, 5000)

    const cleanup = () => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const onError = (error: Error) => {
      cleanup()
      rejectResponse(error)
    }
    const onClose = () => {
      cleanup()
      rejectResponse(new Error('taod closed socket before responding'))
    }
    const onData = (chunk: Buffer) => {
      buffered = buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffered, chunk])
      const newline = buffered.indexOf(0x0a)
      if (newline === -1) return
      cleanup()
      try {
        const response = JSON.parse(buffered.subarray(0, newline).toString('utf8'))
        resolveResponse({ response, tail: buffered.subarray(newline + 1) })
      } catch {
        rejectResponse(new Error('Failed to parse taod response'))
      }
    }

    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
    void writeAll(socket, `${JSON.stringify(request)}\n`, 'control request').catch((error) => {
      cleanup()
      rejectResponse(error)
    })
  })
}

async function startManagedTaod(): Promise<ManagedTaod | null> {
  if (!MANAGED_TAOD) return null

  const binaryPath = findTaodBinary()
  if (!binaryPath) throw new Error('taod binary not found; run pnpm --filter @tao/desktop build')

  const home = mkdtempSync(resolve(tmpdir(), 'tao-latency-bench-'))
  socketPath = resolveTaoStoragePaths(home).socket
  const adapters = resolve(desktopRoot, 'out/adapters')
  const child = spawn(binaryPath, [], {
    cwd: dirname(binaryPath),
    env: {
      ...process.env,
      HOME: home,
      TAOD_ADAPTER_DIR: adapters,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[taod stderr] ${chunk.toString('utf8')}`)
  })

  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const socket = await connectSocket(250)
      await sendJson(socket, { type: 'ping', id: 'latency-managed-ping' })
      await closeControlSocket(socket)
      return {
        home,
        socketPath,
        child,
        cleanup: async () => {
          if (child.exitCode === null && !child.killed) {
            child.kill('SIGTERM')
            await Promise.race([
              new Promise((resolveExit) => child.once('exit', resolveExit)),
              sleep(1000),
            ])
            if (child.exitCode === null && !child.killed) child.kill('SIGKILL')
          }
          rmSync(home, { recursive: true, force: true })
        },
      }
    } catch {
      if (child.exitCode !== null) {
        rmSync(home, { recursive: true, force: true })
        throw new Error(`managed taod exited before socket became ready: ${child.exitCode}`)
      }
      await sleep(50)
    }
  }

  child.kill('SIGKILL')
  rmSync(home, { recursive: true, force: true })
  throw new Error('managed taod failed to start')
}

async function closeControlSocket(socket: net.Socket): Promise<void> {
  socket.end()
  socket.destroy()
}

async function killSession(sessionId: string): Promise<void> {
  try {
    const killSocket = await connectSocket(1000)
    await sendJson(killSocket, { type: 'kill', id: 'lat-kill', sessionId })
    await closeControlSocket(killSocket)
  } catch {
    // Best-effort cleanup. Managed taod cleanup will reap the process if the
    // control path is already gone.
  }
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
}

function enforceBudget(label: string, value: number, max: number): void {
  if (!ENFORCE || max <= 0) return
  if (value > max) {
    throw new Error(`${label} latency above budget: ${value.toFixed(2)} ms > ${max} ms`)
  }
}

async function runLatencyBenchmark(): Promise<void> {
  const managed = await startManagedTaod()
  const sessionId = `latency-bench-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  let streamSocket: net.Socket | null = null

  try {
    console.log('Tao input latency benchmark (taod)')
    console.log('')
    console.log(`  Samples:  ${SAMPLES}`)
    console.log(`  Socket:   ${socketPath}`)
    console.log(`  Platform: ${platform()} ${process.arch}`)
    console.log(`  Managed:  ${managed ? 'yes' : 'no'}`)
    console.log(`  Enforce:  ${ENFORCE ? 'yes' : 'no'}`)
    console.log('')

    const ctrlSocket = await connectSocket()
    const createResult = await sendJson(ctrlSocket, {
      type: 'create',
      id: 'lat-create',
      sessionId,
      terminalId: sessionId,
      workspaceId: 'latency-bench-workspace',
      cols: 120,
      rows: 40,
      argv: [
        '/usr/bin/env',
        'python3',
        '-c',
        'import os,sys,tty; fd=sys.stdin.fileno(); tty.setraw(fd); out=sys.stdout.fileno();\nwhile True:\n b=os.read(fd,1)\n if not b: break\n os.write(out,b)\n sys.stdout.flush()',
      ],
    })
    await closeControlSocket(ctrlSocket)

    if (!createResult.response.ok) {
      throw new Error(
        `failed to create session: ${String(createResult.response.error_message ?? 'unknown error')}`,
      )
    }

    streamSocket = await connectSocket()
    const attachResult = await sendJson(streamSocket, {
      type: 'attach',
      id: 'lat-attach',
      sessionId,
      terminalId: sessionId,
      cols: 120,
      rows: 40,
    })

    if (!attachResult.response.ok) {
      throw new Error(
        `failed to attach session: ${String(attachResult.response.error_message ?? 'unknown error')}`,
      )
    }

    const parser = new TaodStreamFrameParser()
    const latencies: number[] = []
    let seq = 0n
    let receivedTail = ''
    let pendingEcho: {
      token: string
      startedAt: number
      resolve: () => void
      reject: (error: Error) => void
    } | null = null

    const handleChunk = (chunk: Buffer) => {
      for (const frame of parser.push(chunk)) {
        if (frame.sessionId !== sessionId || frame.kind !== TaodStreamFrameKind.Output) continue
        receivedTail = (receivedTail + frame.payload.toString('utf8')).slice(-256)
        if (pendingEcho && receivedTail.includes(pendingEcho.token)) {
          latencies.push(now() - pendingEcho.startedAt)
          const resolveEcho = pendingEcho.resolve
          pendingEcho = null
          resolveEcho()
        }
      }
    }

    if (attachResult.tail.length > 0) handleChunk(attachResult.tail)
    streamSocket.on('data', handleChunk)
    streamSocket.once('error', (error) => {
      if (pendingEcho) pendingEcho.reject(error)
    })
    streamSocket.resume()

    for (let i = 0; i < SAMPLES; i++) {
      const token = `~${i.toString(36).padStart(4, '0')}~`
      await new Promise<void>((resolveEcho, rejectEcho) => {
        const timeout = setTimeout(() => {
          pendingEcho = null
          rejectEcho(new Error(`timed out waiting for echo token ${token}`))
        }, 2000)
        pendingEcho = {
          token,
          startedAt: now(),
          resolve: () => {
            clearTimeout(timeout)
            resolveEcho()
          },
          reject: (error) => {
            clearTimeout(timeout)
            pendingEcho = null
            rejectEcho(error)
          },
        }
        seq++
        streamSocket!.write(
          encodeTaodStreamFrame({
            kind: TaodStreamFrameKind.Input,
            sessionId,
            seq,
            payload: token,
          }),
        )
      })

      if ((i + 1) % 20 === 0) process.stdout.write('.')
    }
    process.stdout.write('\n')

    const sorted = [...latencies].sort((a, b) => a - b)
    const count = sorted.length
    const sum = sorted.reduce((a, b) => a + b, 0)
    const avg = sum / count
    const min = sorted[0] ?? 0
    const max = sorted[count - 1] ?? 0
    const p50 = percentile(sorted, 0.5)
    const p95 = percentile(sorted, 0.95)
    const p99 = percentile(sorted, 0.99)

    console.log('')
    console.log('Results')
    console.log(`  samples: ${count}`)
    console.log(`  avg:     ${avg.toFixed(2)} ms`)
    console.log(`  p50:     ${p50.toFixed(2)} ms`)
    console.log(`  p95:     ${p95.toFixed(2)} ms`)
    console.log(`  p99:     ${p99.toFixed(2)} ms`)
    console.log(`  min:     ${min.toFixed(2)} ms`)
    console.log(`  max:     ${max.toFixed(2)} ms`)
    console.log('')

    enforceBudget('p50', p50, MAX_P50_MS)
    enforceBudget('p95', p95, MAX_P95_MS)
    enforceBudget('p99', p99, MAX_P99_MS)
    enforceBudget('max', max, MAX_MAX_MS)
  } finally {
    streamSocket?.destroy()
    await killSession(sessionId)
    await managed?.cleanup()
  }
}

runLatencyBenchmark().catch((error: unknown) => {
  console.error('\nBenchmark failed:', error)
  process.exit(1)
})
