/**
 * Tao - direct taod terminal churn/RSS soak benchmark.
 *
 * CI mode intentionally runs a short smoke. Manual long runs can scale this up:
 *   TAO_SOAK_ITERATIONS=720 TAO_SOAK_BYTES=1048576 pnpm --filter @tao/desktop bench:soak
 */

import { execFile } from 'node:child_process'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import { homedir, platform, tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { resolveTaoStoragePaths } from '@tao/shared/storage-path'
import { TaodStreamFrameKind } from '@tao/shared/taod-protocol'
import { TaodStreamFrameParser } from '../src/main/taod-stream'

type ControlResponse = Record<string, unknown>

type ManagedTaod = {
  readonly home: string
  readonly socketPath: string
  readonly child: ChildProcess
  readonly cleanup: () => Promise<void>
}

type IterationMetric = {
  readonly iteration: number
  readonly outputBytes: number
  readonly durationMs: number
  readonly rssKb: number
}

const execFileAsync = promisify(execFile)

const benchDir = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(benchDir, '..')
const repoRoot = resolve(desktopRoot, '../..')

const ITERATIONS = positiveInt(process.env.TAO_SOAK_ITERATIONS, 5)
const OUTPUT_BYTES = positiveInt(process.env.TAO_SOAK_BYTES, 512 * 1024)
const ENFORCE = process.env.TAO_SOAK_ENFORCE === '1'
const MAX_RSS_GROWTH_KB = nonNegativeInt(process.env.TAO_SOAK_MAX_RSS_GROWTH_KB, 64 * 1024)
const MAX_ITERATION_MS = nonNegativeInt(process.env.TAO_SOAK_MAX_ITERATION_MS, 5000)
const MAX_PENDING_OUTPUT_BYTES = nonNegativeInt(process.env.TAO_SOAK_MAX_PENDING_OUTPUT_BYTES, 0)
const MAX_ACTIVE_SUBSCRIBERS = nonNegativeInt(process.env.TAO_SOAK_MAX_ACTIVE_SUBSCRIBERS, 0)

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

  const home = mkdtempSync(resolve(tmpdir(), 'tao-soak-bench-'))
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
      await sendJson(socket, { type: 'ping', id: 'soak-managed-ping' })
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

async function rssKb(pid: number): Promise<number> {
  const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)], {
    timeout: 3000,
    encoding: 'utf8',
  })
  const parsed = Number.parseInt(stdout.trim(), 10)
  if (!Number.isFinite(parsed)) throw new Error(`failed to parse RSS for pid ${pid}: ${stdout}`)
  return parsed
}

async function killSession(sessionId: string): Promise<void> {
  try {
    await control({ type: 'kill', id: `soak-kill-${sessionId}`, sessionId })
  } catch {
    // Best-effort cleanup. Managed taod teardown is the final safety net.
  }
}

function outputCommand(bytes: number): string {
  return `import os,sys,time\nchunk=b"x"*65536\nremaining=${bytes}\nwhile remaining>0:\n n=min(len(chunk), remaining)\n os.write(sys.stdout.fileno(), chunk[:n])\n remaining-=n\n sys.stdout.flush()\ntime.sleep(30)`
}

async function runIteration(iteration: number): Promise<IterationMetric> {
  const sessionId = `soak-${Date.now()}-${iteration}`
  let streamSocket: net.Socket | null = null
  const startedAt = now()

  try {
    const create = await control({
      type: 'create',
      id: `soak-create-${iteration}`,
      sessionId,
      terminalId: sessionId,
      workspaceId: 'soak-bench-workspace',
      cols: 120,
      rows: 40,
      argv: ['/usr/bin/env', 'python3', '-c', outputCommand(OUTPUT_BYTES)],
    })
    if (!create.ok) {
      throw new Error(
        `failed to create session ${iteration}: ${String(create.error_message ?? 'unknown error')}`,
      )
    }

    streamSocket = await connectSocket()
    const attach = await sendJson(streamSocket, {
      type: 'attach',
      id: `soak-attach-${iteration}`,
      sessionId,
      terminalId: sessionId,
      cols: 120,
      rows: 40,
    })
    if (!attach.response.ok) {
      throw new Error(
        `failed to attach session ${iteration}: ${String(attach.response.error_message ?? 'unknown error')}`,
      )
    }

    const parser = new TaodStreamFrameParser()
    let outputBytes = 0
    const consume = (chunk: Buffer) => {
      for (const frame of parser.push(chunk)) {
        if (frame.sessionId === sessionId && frame.kind === TaodStreamFrameKind.Output) {
          outputBytes += frame.payload.length
        }
      }
    }

    if (attach.tail.length > 0) consume(attach.tail)
    await new Promise<void>((resolveOutput, rejectOutput) => {
      const timeout = setTimeout(() => {
        cleanup()
        rejectOutput(
          new Error(
            `Timed out waiting for iteration ${iteration} output: ${outputBytes}/${OUTPUT_BYTES}`,
          ),
        )
      }, 15_000)
      const cleanup = () => {
        clearTimeout(timeout)
        streamSocket?.off('data', onData)
        streamSocket?.off('error', onError)
        streamSocket?.off('close', onClose)
      }
      const onData = (chunk: Buffer) => {
        consume(chunk)
        if (outputBytes >= OUTPUT_BYTES) {
          cleanup()
          resolveOutput()
        }
      }
      const onError = (error: Error) => {
        cleanup()
        rejectOutput(error)
      }
      const onClose = () => {
        cleanup()
        rejectOutput(new Error(`taod stream closed during iteration ${iteration}`))
      }

      if (outputBytes >= OUTPUT_BYTES) {
        cleanup()
        resolveOutput()
        return
      }
      streamSocket?.on('data', onData)
      streamSocket?.once('error', onError)
      streamSocket?.once('close', onClose)
      streamSocket?.resume()
    })

    streamSocket.destroy()
    streamSocket = null
    await killSession(sessionId)
    return {
      iteration,
      outputBytes,
      durationMs: now() - startedAt,
      rssKb: await rssKb(managedPid),
    }
  } finally {
    streamSocket?.destroy()
    await killSession(sessionId)
  }
}

let managedPid = 0

function enforceBudget(label: string, value: number, max: number, unit: string): void {
  if (!ENFORCE || max <= 0) return
  if (value > max) throw new Error(`${label} above budget: ${value.toFixed(2)} ${unit} > ${max}`)
}

async function runSoakBenchmark(): Promise<void> {
  const managed = await startManagedTaod()
  managedPid = managed.child.pid ?? 0
  if (managedPid <= 0) throw new Error('managed taod pid was not available')

  try {
    const initialRssKb = await rssKb(managedPid)
    const metrics: IterationMetric[] = []

    console.log('Tao taod terminal soak benchmark')
    console.log('')
    console.log(`  Iterations: ${ITERATIONS}`)
    console.log(`  Output:     ${OUTPUT_BYTES} bytes/iteration`)
    console.log(`  Socket:     ${socketPath}`)
    console.log(`  Platform:   ${platform()} ${process.arch}`)
    console.log(`  taod pid:   ${managedPid}`)
    console.log(`  Enforce:    ${ENFORCE ? 'yes' : 'no'}`)
    console.log('')

    for (let iteration = 1; iteration <= ITERATIONS; iteration++) {
      const metric = await runIteration(iteration)
      metrics.push(metric)
      console.log(
        `  ${String(iteration).padStart(3)}  ${metric.durationMs.toFixed(2).padStart(8)} ms  ${String(metric.outputBytes).padStart(9)} bytes  rss ${String(metric.rssKb).padStart(8)} KiB`,
      )
    }

    await sleep(100)
    const finalRssKb = await rssKb(managedPid)
    const rssGrowthKb = finalRssKb - initialRssKb
    const finalPing = await control({ type: 'ping', id: 'soak-final-ping' })
    const diagnostics = streamDiagnostics(finalPing)
    const pendingOutputBytes = Number(
      diagnostics.pending_output_bytes ?? diagnostics.pendingOutputBytes ?? 0,
    )
    const activeSubscribers = Number(
      diagnostics.active_subscribers ?? diagnostics.activeSubscribers ?? 0,
    )
    const maxIterationMs = Math.max(...metrics.map((metric) => metric.durationMs))
    const avgIterationMs =
      metrics.reduce((sum, metric) => sum + metric.durationMs, 0) / Math.max(1, metrics.length)

    console.log('')
    console.log('Results')
    console.log(`  initial RSS:          ${initialRssKb} KiB`)
    console.log(`  final RSS:            ${finalRssKb} KiB`)
    console.log(`  RSS growth:           ${rssGrowthKb} KiB`)
    console.log(`  avg iteration:        ${avgIterationMs.toFixed(2)} ms`)
    console.log(`  max iteration:        ${maxIterationMs.toFixed(2)} ms`)
    console.log(`  active subscribers:   ${activeSubscribers}`)
    console.log(`  pending output bytes: ${pendingOutputBytes}`)
    console.log('')

    enforceBudget('RSS growth', Math.max(0, rssGrowthKb), MAX_RSS_GROWTH_KB, 'KiB')
    enforceBudget('max iteration', maxIterationMs, MAX_ITERATION_MS, 'ms')
    enforceBudget('active subscribers', activeSubscribers, MAX_ACTIVE_SUBSCRIBERS, 'subscribers')
    enforceBudget('pending output', pendingOutputBytes, MAX_PENDING_OUTPUT_BYTES, 'bytes')
  } finally {
    await managed.cleanup()
  }
}

runSoakBenchmark().catch((error: unknown) => {
  console.error('\nBenchmark failed:', error)
  process.exit(1)
})
