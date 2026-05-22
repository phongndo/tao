/**
 * Tao - direct taod input-priority benchmark under a slow output subscriber.
 *
 * Launches managed taod, creates one PTY session, attaches a fast stream and an
 * intentionally unread slow stream, floods terminal output, then measures input
 * echo latency through the fast stream while taod drops the slow subscriber.
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

const SAMPLES = positiveInt(process.env.TAO_INPUT_PRIORITY_SAMPLES, 20)
const FLOOD_BYTES = positiveInt(process.env.TAO_INPUT_PRIORITY_FLOOD_BYTES, 8 * 1024 * 1024)
const MIN_OUTPUT_BYTES = positiveInt(
  process.env.TAO_INPUT_PRIORITY_MIN_OUTPUT_BYTES,
  Math.min(FLOOD_BYTES, 1024 * 1024),
)
const ENFORCE = process.env.TAO_INPUT_PRIORITY_ENFORCE === '1'
const MAX_P50_MS = nonNegativeInt(process.env.TAO_INPUT_PRIORITY_MAX_P50_MS, 0)
const MAX_P95_MS = nonNegativeInt(process.env.TAO_INPUT_PRIORITY_MAX_P95_MS, 500)
const MAX_MAX_MS = nonNegativeInt(process.env.TAO_INPUT_PRIORITY_MAX_MAX_MS, 1000)
const MIN_SLOW_DROPS = nonNegativeInt(process.env.TAO_INPUT_PRIORITY_MIN_SLOW_DROPS, 1)

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
    socket.once('error', (error) => {
      clearTimeout(timer)
      rejectSocket(error)
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

async function closeSocket(socket: net.Socket): Promise<void> {
  socket.end()
  socket.destroy()
}

async function startManagedTaod(): Promise<ManagedTaod> {
  const binaryPath = findTaodBinary()
  if (!binaryPath) throw new Error('taod binary not found; run pnpm --filter @tao/desktop build')

  const home = mkdtempSync(resolve(tmpdir(), 'tao-input-priority-bench-'))
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
      await sendJson(socket, { type: 'ping', id: 'input-priority-managed-ping' })
      await closeSocket(socket)
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

async function control(request: Record<string, unknown>): Promise<ControlResponse> {
  const socket = await connectSocket()
  try {
    const { response } = await sendJson(socket, request)
    return response
  } finally {
    await closeSocket(socket)
  }
}

function streamDiagnostics(response: ControlResponse): Record<string, unknown> {
  const diagnostics = response.stream_diagnostics ?? response.streamDiagnostics
  return typeof diagnostics === 'object' && diagnostics !== null
    ? (diagnostics as Record<string, unknown>)
    : {}
}

function numberDiagnostic(
  diagnostics: Record<string, unknown>,
  snakeKey: string,
  camelKey: string,
): number {
  const value = diagnostics[snakeKey] ?? diagnostics[camelKey]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

async function killSession(sessionId: string): Promise<void> {
  try {
    await control({ type: 'kill', id: `input-priority-kill-${sessionId}`, sessionId })
  } catch {
    // Best-effort cleanup. Managed taod teardown is the final safety net.
  }
}

function priorityCommand(floodBytes: number): string {
  return `IFS= read -r _; echo READY; python3 -c 'import os,time
chunk=b"x"*1024
remaining=${floodBytes}
while remaining>0:
 n=min(len(chunk), remaining)
 os.write(1, chunk[:n])
 remaining-=n
 time.sleep(0.001)
' & cat`
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
}

function enforceMax(label: string, value: number, max: number): void {
  if (!ENFORCE || max <= 0) return
  if (value > max) {
    throw new Error(`${label} above budget: ${value.toFixed(2)} ms > ${max} ms`)
  }
}

function enforceMin(label: string, value: number, min: number): void {
  if (!ENFORCE) return
  if (value < min) throw new Error(`${label} below budget: ${value} < ${min}`)
}

async function attachStream(
  sessionId: string,
  id: string,
): Promise<{ socket: net.Socket; tail: Buffer }> {
  const socket = await connectSocket()
  const attach = await sendJson(socket, {
    type: 'attach',
    id,
    sessionId,
    terminalId: sessionId,
    cols: 120,
    rows: 40,
  })
  if (!attach.response.ok) {
    socket.destroy()
    throw new Error(
      `failed to attach ${id}: ${String(attach.response.error_message ?? 'unknown error')}`,
    )
  }
  return { socket, tail: attach.tail }
}

async function runInputPriorityBenchmark(): Promise<void> {
  const managed = await startManagedTaod()
  const sessionId = `input-priority-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  let fastSocket: net.Socket | null = null
  let slowSocket: net.Socket | null = null

  try {
    console.log('Tao input-priority benchmark under slow subscriber')
    console.log('')
    console.log(`  Samples:     ${SAMPLES}`)
    console.log(`  Flood bytes: ${FLOOD_BYTES}`)
    console.log(`  Min output:  ${MIN_OUTPUT_BYTES}`)
    console.log(`  Socket:      ${socketPath}`)
    console.log(`  Platform:    ${platform()} ${process.arch}`)
    console.log(`  Enforce:     ${ENFORCE ? 'yes' : 'no'}`)
    console.log('')

    const initialPing = await control({ type: 'ping', id: 'input-priority-initial-ping' })
    const initialDiagnostics = streamDiagnostics(initialPing)
    const initialSlowDrops = numberDiagnostic(
      initialDiagnostics,
      'slow_subscriber_drops_total',
      'slowSubscriberDropsTotal',
    )

    const create = await control({
      type: 'create',
      id: 'input-priority-create',
      sessionId,
      terminalId: sessionId,
      workspaceId: 'input-priority-bench-workspace',
      cols: 120,
      rows: 40,
      argv: ['/bin/sh', '-c', priorityCommand(FLOOD_BYTES)],
    })
    if (!create.ok) {
      throw new Error(
        `failed to create session: ${String(create.error_message ?? 'unknown error')}`,
      )
    }

    const slowAttach = await attachStream(sessionId, 'input-priority-slow-attach')
    slowSocket = slowAttach.socket
    slowSocket.pause()

    const fastAttach = await attachStream(sessionId, 'input-priority-fast-attach')
    fastSocket = fastAttach.socket

    const parser = new TaodStreamFrameParser()
    const latencies: number[] = []
    let seq = 0n
    let receivedTail = ''
    let outputBytes = 0
    let pendingEcho: {
      token: string
      startedAt: number
      recordLatency: boolean
      resolve: () => void
      reject: (error: Error) => void
    } | null = null

    const handleChunk = (chunk: Buffer) => {
      for (const frame of parser.push(chunk)) {
        if (frame.sessionId !== sessionId || frame.kind !== TaodStreamFrameKind.Output) continue
        outputBytes += frame.payload.length
        const text = frame.payload.toString('utf8')
        const combined = receivedTail + text
        if (pendingEcho && combined.includes(pendingEcho.token)) {
          if (pendingEcho.recordLatency) latencies.push(now() - pendingEcho.startedAt)
          const resolveEcho = pendingEcho.resolve
          pendingEcho = null
          resolveEcho()
        }
        receivedTail = combined.slice(-4096)
      }
    }

    if (fastAttach.tail.length > 0) handleChunk(fastAttach.tail)
    fastSocket.on('data', handleChunk)
    fastSocket.once('error', (error) => {
      if (pendingEcho) pendingEcho.reject(error)
    })
    fastSocket.resume()

    await new Promise<void>((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => {
        pendingEcho = null
        rejectReady(new Error('timed out waiting for READY marker after starting flood'))
      }, 3000)
      pendingEcho = {
        token: 'READY',
        startedAt: now(),
        recordLatency: false,
        resolve: () => {
          clearTimeout(timeout)
          resolveReady()
        },
        reject: (error) => {
          clearTimeout(timeout)
          pendingEcho = null
          rejectReady(error)
        },
      }
      seq++
      void writeAll(
        fastSocket!,
        encodeTaodStreamFrame({
          kind: TaodStreamFrameKind.Input,
          sessionId,
          seq,
          payload: 'GO\n',
        }),
        'start flood input frame',
      ).catch((error) => {
        clearTimeout(timeout)
        pendingEcho = null
        rejectReady(error)
      })
    })
    await new Promise<void>((resolveOutput, rejectOutput) => {
      const timeout = setTimeout(() => {
        rejectOutput(
          new Error(`timed out waiting for flood output: ${outputBytes}/${MIN_OUTPUT_BYTES}`),
        )
      }, 5000)
      const check = () => {
        if (outputBytes >= MIN_OUTPUT_BYTES) {
          clearTimeout(timeout)
          resolveOutput()
          return
        }
        setTimeout(check, 25)
      }
      check()
    })

    for (let i = 0; i < SAMPLES; i++) {
      const token = `probe-${i.toString(36).padStart(4, '0')}-${Date.now()}`
      await new Promise<void>((resolveEcho, rejectEcho) => {
        const timeout = setTimeout(() => {
          pendingEcho = null
          rejectEcho(new Error(`timed out waiting for echo token ${token.trim()}`))
        }, 3000)
        pendingEcho = {
          token,
          startedAt: now(),
          recordLatency: true,
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
        fastSocket!.write(
          encodeTaodStreamFrame({
            kind: TaodStreamFrameKind.Input,
            sessionId,
            seq,
            payload: `${token}\n`,
          }),
        )
      })
      if ((i + 1) % 10 === 0) process.stdout.write('.')
    }
    process.stdout.write('\n')

    await sleep(200)
    const finalPing = await control({ type: 'ping', id: 'input-priority-final-ping' })
    const finalDiagnostics = streamDiagnostics(finalPing)
    const finalSlowDrops = numberDiagnostic(
      finalDiagnostics,
      'slow_subscriber_drops_total',
      'slowSubscriberDropsTotal',
    )
    const activeSubscribers = numberDiagnostic(
      finalDiagnostics,
      'active_subscribers',
      'activeSubscribers',
    )
    const slowDrops = finalSlowDrops - initialSlowDrops
    const sorted = [...latencies].sort((a, b) => a - b)
    const count = sorted.length
    const avg = sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, count)
    const p50 = percentile(sorted, 0.5)
    const p95 = percentile(sorted, 0.95)
    const max = sorted[count - 1] ?? 0

    console.log('')
    console.log('Results')
    console.log(`  samples:                ${count}`)
    console.log(`  output bytes observed:  ${outputBytes}`)
    console.log(`  avg echo:               ${avg.toFixed(2)} ms`)
    console.log(`  p50 echo:               ${p50.toFixed(2)} ms`)
    console.log(`  p95 echo:               ${p95.toFixed(2)} ms`)
    console.log(`  max echo:               ${max.toFixed(2)} ms`)
    console.log(`  slow subscriber drops:  ${slowDrops}`)
    console.log(`  active subscribers:     ${activeSubscribers}`)
    console.log('')

    enforceMax('p50 echo latency', p50, MAX_P50_MS)
    enforceMax('p95 echo latency', p95, MAX_P95_MS)
    enforceMax('max echo latency', max, MAX_MAX_MS)
    enforceMin('slow subscriber drops', slowDrops, MIN_SLOW_DROPS)
  } finally {
    fastSocket?.destroy()
    slowSocket?.destroy()
    await killSession(sessionId)
    await managed.cleanup()
  }
}

runInputPriorityBenchmark().catch((error: unknown) => {
  console.error('\nBenchmark failed:', error)
  process.exit(1)
})
