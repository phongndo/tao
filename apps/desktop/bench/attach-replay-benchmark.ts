/**
 * Tau - attach/replay budget for taud.
 *
 * Launches a managed taud, creates a PTY session that emits output before any
 * subscriber attaches, waits until the daemon reports a pending replay backlog,
 * then measures attach response, current-screen snapshot, and 1 MiB replay time.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import { homedir, platform, tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveTauStoragePaths } from '@tau/shared/storage-path'
import { TaudStreamFrameKind } from '@tau/shared/taud-protocol'
import { TaudStreamFrameParser } from '../src/main/taud-stream'

type ControlResponse = Record<string, unknown>

type ManagedTaud = {
  readonly home: string
  readonly socketPath: string
  readonly child: ChildProcess
  readonly cleanup: () => Promise<void>
}

const benchDir = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(benchDir, '..')
const repoRoot = resolve(desktopRoot, '../..')

const TARGET_REPLAY_BYTES = positiveInt(process.env.TAU_ATTACH_REPLAY_BYTES, 1024 * 1024)
const ENFORCE = process.env.TAU_ATTACH_REPLAY_ENFORCE === '1'
const MAX_ATTACH_RESPONSE_MS = nonNegativeInt(process.env.TAU_ATTACH_MAX_RESPONSE_MS, 250)
const MAX_SNAPSHOT_MS = nonNegativeInt(process.env.TAU_ATTACH_MAX_SNAPSHOT_MS, 100)
const MAX_REPLAY_MS = nonNegativeInt(process.env.TAU_ATTACH_MAX_REPLAY_MS, 500)

let socketPath =
  process.env.TAUD_SOCKET_PATH || resolveTauStoragePaths(process.env.HOME || homedir()).socket

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

function findTaudBinary(): string | null {
  const exeName = process.platform === 'win32' ? 'taud.exe' : 'taud'
  const candidates = [
    process.env.TAUD_PATH,
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
      rejectSocket(new Error(`Timed out connecting to taud at ${socketPath}`))
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

async function writeAll(socket: net.Socket, payload: string, context: string): Promise<void> {
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
      rejectWrite(new Error(`taud closed socket while writing ${context}`))
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
      rejectResponse(new Error('Timeout waiting for taud response'))
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
      rejectResponse(new Error('taud closed socket before responding'))
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
        rejectResponse(new Error('Failed to parse taud response'))
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

async function startManagedTaud(): Promise<ManagedTaud> {
  const binaryPath = findTaudBinary()
  if (!binaryPath) throw new Error('taud binary not found; run pnpm --filter @tau/desktop build')

  const home = mkdtempSync(resolve(tmpdir(), 'tau-attach-replay-bench-'))
  socketPath = resolveTauStoragePaths(home).socket
  const adapters = resolve(desktopRoot, 'out/adapters')
  const child = spawn(binaryPath, [], {
    cwd: dirname(binaryPath),
    env: {
      ...process.env,
      HOME: home,
      TAUD_ADAPTER_DIR: adapters,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[taud stderr] ${chunk.toString('utf8')}`)
  })

  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const socket = await connectSocket(250)
      await sendJson(socket, { type: 'ping', id: 'attach-managed-ping' })
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
        throw new Error(`managed taud exited before socket became ready: ${child.exitCode}`)
      }
      await sleep(50)
    }
  }

  child.kill('SIGKILL')
  rmSync(home, { recursive: true, force: true })
  throw new Error('managed taud failed to start')
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

async function waitForPendingOutput(sessionId: string): Promise<number> {
  const deadline = Date.now() + 10_000
  let lastPendingBytes = 0
  while (Date.now() < deadline) {
    const ping = await control({ type: 'ping', id: 'attach-pending-ping' })
    const diagnostics = streamDiagnostics(ping)
    const pendingBytes = Number(
      diagnostics.pending_output_bytes ?? diagnostics.pendingOutputBytes ?? 0,
    )
    const pendingSessions = Number(
      diagnostics.pending_output_sessions ?? diagnostics.pendingOutputSessions ?? 0,
    )
    lastPendingBytes = Number.isFinite(pendingBytes) ? pendingBytes : 0
    if (pendingSessions > 0 && lastPendingBytes >= TARGET_REPLAY_BYTES) return lastPendingBytes
    await sleep(50)
  }
  throw new Error(
    `Timed out waiting for ${sessionId} pending replay bytes; last=${lastPendingBytes}`,
  )
}

async function killSession(sessionId: string): Promise<void> {
  try {
    await control({ type: 'kill', id: 'attach-kill', sessionId })
  } catch {
    // Best-effort cleanup. Managed taud teardown is the final safety net.
  }
}

function enforceBudget(label: string, value: number, max: number): void {
  if (!ENFORCE || max <= 0) return
  if (value > max) throw new Error(`${label} above budget: ${value.toFixed(2)} ms > ${max} ms`)
}

async function runAttachReplayBenchmark(): Promise<void> {
  const managed = await startManagedTaud()
  const sessionId = `attach-replay-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  let streamSocket: net.Socket | null = null

  try {
    console.log('Tau attach/replay benchmark (taud)')
    console.log('')
    console.log(`  Target replay bytes: ${TARGET_REPLAY_BYTES}`)
    console.log(`  Socket:              ${socketPath}`)
    console.log(`  Platform:            ${platform()} ${process.arch}`)
    console.log(`  Enforce:             ${ENFORCE ? 'yes' : 'no'}`)
    console.log('')

    const create = await control({
      type: 'create',
      id: 'attach-create',
      sessionId,
      terminalId: sessionId,
      workspaceId: 'attach-replay-workspace',
      cols: 120,
      rows: 40,
      argv: [
        '/usr/bin/env',
        'python3',
        '-c',
        `import os,sys,time\nchunk=b"x"*65536\nremaining=${TARGET_REPLAY_BYTES}\nwhile remaining>0:\n n=min(len(chunk), remaining)\n os.write(sys.stdout.fileno(), chunk[:n])\n remaining-=n\n sys.stdout.flush()\ntime.sleep(30)`,
      ],
    })
    if (!create.ok) {
      throw new Error(
        `failed to create session: ${String(create.error_message ?? 'unknown error')}`,
      )
    }

    const pendingBytes = await waitForPendingOutput(sessionId)

    streamSocket = await connectSocket()
    const attachStartedAt = now()
    const attach = await sendJson(streamSocket, {
      type: 'attach',
      id: 'attach-stream',
      sessionId,
      terminalId: sessionId,
      cols: 120,
      rows: 40,
    })
    const attachResponseMs = now() - attachStartedAt
    if (!attach.response.ok) {
      throw new Error(
        `failed to attach session: ${String(attach.response.error_message ?? 'unknown error')}`,
      )
    }

    const parser = new TaudStreamFrameParser()
    let snapshotMs: number | null = null
    let replayBytes = 0
    let replayMs: number | null = null

    const consume = (chunk: Buffer) => {
      for (const frame of parser.push(chunk)) {
        if (frame.sessionId !== sessionId) continue
        if (frame.kind === TaudStreamFrameKind.Snapshot && snapshotMs === null) {
          snapshotMs = now() - attachStartedAt
        }
        if (frame.kind === TaudStreamFrameKind.Output) {
          replayBytes += frame.payload.length
          if (replayBytes >= TARGET_REPLAY_BYTES && replayMs === null) {
            replayMs = now() - attachStartedAt
          }
        }
      }
    }

    if (attach.tail.length > 0) consume(attach.tail)

    await new Promise<void>((resolveReplay, rejectReplay) => {
      const timeout = setTimeout(() => {
        cleanup()
        rejectReplay(
          new Error(
            `Timed out waiting for replay: snapshot=${snapshotMs ?? 'none'}ms bytes=${replayBytes}`,
          ),
        )
      }, 10_000)
      const cleanup = () => {
        clearTimeout(timeout)
        streamSocket?.off('data', onData)
        streamSocket?.off('error', onError)
        streamSocket?.off('close', onClose)
      }
      const onData = (chunk: Buffer) => {
        consume(chunk)
        if (snapshotMs !== null && replayMs !== null) {
          cleanup()
          resolveReplay()
        }
      }
      const onError = (error: Error) => {
        cleanup()
        rejectReplay(error)
      }
      const onClose = () => {
        cleanup()
        rejectReplay(new Error('taud stream closed before replay completed'))
      }

      if (snapshotMs !== null && replayMs !== null) {
        cleanup()
        resolveReplay()
        return
      }
      streamSocket?.on('data', onData)
      streamSocket?.once('error', onError)
      streamSocket?.once('close', onClose)
      streamSocket?.resume()
    })

    console.log('Results')
    console.log(`  pending bytes before attach: ${pendingBytes}`)
    console.log(`  attach response:             ${attachResponseMs.toFixed(2)} ms`)
    console.log(`  current-screen snapshot:     ${snapshotMs!.toFixed(2)} ms`)
    console.log(`  replay bytes:                ${replayBytes}`)
    console.log(`  replay complete:             ${replayMs!.toFixed(2)} ms`)
    console.log('')

    enforceBudget('attach response latency', attachResponseMs, MAX_ATTACH_RESPONSE_MS)
    enforceBudget('current-screen snapshot latency', snapshotMs!, MAX_SNAPSHOT_MS)
    enforceBudget('attach replay latency', replayMs!, MAX_REPLAY_MS)
  } finally {
    streamSocket?.destroy()
    await killSession(sessionId)
    await managed.cleanup()
  }
}

runAttachReplayBenchmark().catch((error: unknown) => {
  console.error('\nBenchmark failed:', error)
  process.exit(1)
})
