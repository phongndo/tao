import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import { app } from 'electron'
import { resolveTaoStoragePaths } from '@tao/shared/storage-path'
import {
  TaodStreamFrameKind,
  type TaodStreamFrameKind as TaodStreamFrameKindValue,
} from '@tao/shared/taod-protocol'
import {
  encodeTaodResizePayload,
  encodeTaodStreamFrame,
  TaodStreamFrameParser,
  type TaodParsedStreamFrame,
} from './taod-stream'

const DEFAULT_CONNECT_TIMEOUT_MS = 500
const DEFAULT_START_TIMEOUT_MS = 3000
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 10_000
const DEFAULT_RESTART_BACKOFF_MS = 750
const CONTROL_RESPONSE_MAX_BYTES = 1024 * 1024

type TaodRequest = Record<string, unknown>

export type TaodControlResponse = {
  readonly id?: string
  readonly ok: boolean
  readonly session_id?: string
  readonly stream_id?: string
  readonly pid?: number
  readonly status?: string
  readonly cwd?: string
  readonly cols?: number
  readonly rows?: number
  readonly last_seq?: number
  readonly attach_kind?: string
  readonly agent_provider?: string
  readonly native_session_id?: string | null
  readonly removed_sessions?: number
  readonly removed_bytes?: number
  readonly error_message?: string
}

export type TaodCreateSessionInput = {
  readonly sessionId: string
  readonly terminalId: string
  readonly cols: number
  readonly rows: number
  readonly cwd?: string
  readonly argv?: readonly string[]
}

export type TaodAttachSessionInput = {
  readonly sessionId: string
  readonly terminalId?: string
  readonly cols?: number
  readonly rows?: number
  readonly cwd?: string
}

export type TaodCleanupSessionsInput = {
  readonly retainDays: number
  readonly maxSessionBytes: number
  readonly activeSessionIds?: readonly string[]
}

export type TaodPersistenceSettingsInput = {
  readonly enabled: boolean
  readonly persistInput: boolean
}

export type TaodSessionStreamEvents = {
  frame: [TaodParsedStreamFrame]
  error: [Error]
  close: []
}

let nextRequestNumber = 0

function nextRequestId(prefix: string): string {
  nextRequestNumber += 1
  return `${prefix}-${Date.now().toString(36)}-${nextRequestNumber.toString(36)}`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function responseError(response: TaodControlResponse): Error {
  return new Error(response.error_message ?? 'taod request failed')
}

function parseControlResponse(line: Buffer): TaodControlResponse {
  const parsed = JSON.parse(line.toString('utf8')) as TaodControlResponse
  if (!parsed || typeof parsed.ok !== 'boolean') throw new Error('Invalid taod control response')
  return parsed
}

function candidateTaodPaths(): string[] {
  const envPath = process.env.TAOD_PATH?.trim()
  const exeName = process.platform === 'win32' ? 'taod.exe' : 'taod'
  const appPath = safeAppPath()
  const cwd = process.cwd()

  return Array.from(
    new Set(
      [
        envPath,
        join(cwd, 'apps/daemon/zig-out/bin', exeName),
        join(cwd, '../daemon/zig-out/bin', exeName),
        join(cwd, '../../apps/daemon/zig-out/bin', exeName),
        appPath ? join(appPath, '../daemon/zig-out/bin', exeName) : null,
        appPath ? join(appPath, '../../daemon/zig-out/bin', exeName) : null,
        appPath ? join(appPath, 'bin', exeName) : null,
        typeof __dirname === 'string' ? join(__dirname, '../bin', exeName) : null,
        typeof __dirname === 'string'
          ? join(__dirname, '../../../daemon/zig-out/bin', exeName)
          : null,
        typeof __dirname === 'string'
          ? join(__dirname, '../../../../apps/daemon/zig-out/bin', exeName)
          : null,
        process.resourcesPath ? join(process.resourcesPath, exeName) : null,
        process.resourcesPath ? join(process.resourcesPath, 'bin', exeName) : null,
      ]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .map((value) => resolve(value)),
    ),
  )
}

function candidateTaodAdapterDirs(): string[] {
  const envPath = process.env.TAOD_ADAPTER_DIR?.trim()
  const appPath = safeAppPath()
  const cwd = process.cwd()

  return Array.from(
    new Set(
      [
        envPath,
        join(cwd, 'apps/daemon/adapters'),
        join(cwd, '../daemon/adapters'),
        join(cwd, '../../apps/daemon/adapters'),
        appPath ? join(appPath, '../daemon/adapters') : null,
        appPath ? join(appPath, '../../daemon/adapters') : null,
        appPath ? join(appPath, 'adapters') : null,
        typeof __dirname === 'string' ? join(__dirname, '../adapters') : null,
        typeof __dirname === 'string' ? join(__dirname, '../../../daemon/adapters') : null,
        typeof __dirname === 'string' ? join(__dirname, '../../../../apps/daemon/adapters') : null,
        process.resourcesPath ? join(process.resourcesPath, 'adapters') : null,
      ]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .map((value) => resolve(value)),
    ),
  )
}

function safeAppPath(): string | null {
  try {
    return app.getAppPath()
  } catch {
    return null
  }
}

function findTaodBinary(): string | null {
  for (const candidate of candidateTaodPaths()) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function findTaodAdapterDir(): string | null {
  for (const candidate of candidateTaodAdapterDirs()) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function defaultSocketPath(): string {
  return resolveTaoStoragePaths(homedir()).socket
}

function connectUnixSocket(socketPath: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = net.createConnection(socketPath)
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      rejectSocket(new Error(`Timed out connecting to taod at ${socketPath}`))
    }, timeoutMs)

    socket.once('connect', () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolveSocket(socket)
    })

    socket.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      rejectSocket(error)
    })
  })
}

function readNdjsonResponse(
  socket: net.Socket,
  timeoutMs: number,
): Promise<{ response: TaodControlResponse; tail: Buffer }> {
  return new Promise((resolveResponse, rejectResponse) => {
    let buffered = Buffer.alloc(0)
    let settled = false
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for taod control response'))
    }, timeoutMs)

    function cleanup() {
      clearTimeout(timeout)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }

    function reject(error: Error) {
      if (settled) return
      settled = true
      cleanup()
      rejectResponse(error)
    }

    function onData(chunk: Buffer) {
      buffered = buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffered, chunk])
      if (buffered.length > CONTROL_RESPONSE_MAX_BYTES) {
        reject(new Error('taod control response too large'))
        return
      }

      const newlineIndex = buffered.indexOf(0x0a)
      if (newlineIndex === -1) return

      try {
        const line = buffered.subarray(0, newlineIndex)
        const tail = Buffer.from(buffered.subarray(newlineIndex + 1))
        const response = parseControlResponse(line)
        if (settled) return
        settled = true
        socket.pause()
        cleanup()
        resolveResponse({ response, tail })
      } catch (error) {
        reject(normalizeError(error))
      }
    }

    function onError(error: Error) {
      reject(error)
    }

    function onClose() {
      reject(new Error('taod closed the control socket before responding'))
    }

    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

export class TaodSessionStream extends EventEmitter<TaodSessionStreamEvents> {
  private readonly parser = new TaodStreamFrameParser()
  private clientSeq = 0n
  private started = false

  constructor(
    private readonly socket: net.Socket,
    private readonly sessionId: string,
    private readonly initialTail: Buffer,
  ) {
    super()
    socket.on('data', (chunk) => this.handleChunk(Buffer.from(chunk)))
    socket.once('error', (error) => this.emit('error', normalizeError(error)))
    socket.once('close', () => this.emit('close'))
  }

  start(): void {
    if (this.started) return
    this.started = true
    if (this.initialTail.length > 0) this.handleChunk(this.initialTail)
    this.socket.resume()
  }

  writeInput(data: string | Buffer | Uint8Array): void {
    const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
    if (payload.length === 0 || this.socket.destroyed) return
    this.writeFrame(TaodStreamFrameKind.Input, payload)
  }

  resize(cols: number, rows: number): void {
    if (this.socket.destroyed) return
    this.writeFrame(TaodStreamFrameKind.Resize, encodeTaodResizePayload(cols, rows))
  }

  close(): void {
    this.socket.end()
    this.socket.destroy()
  }

  private writeFrame(kind: TaodStreamFrameKindValue, payload: Buffer): void {
    this.clientSeq += 1n
    const frame = encodeTaodStreamFrame({
      kind,
      sessionId: this.sessionId,
      seq: this.clientSeq,
      payload,
    })
    this.socket.write(frame)
  }

  private handleChunk(chunk: Buffer): void {
    try {
      for (const frame of this.parser.push(chunk)) {
        this.emit('frame', frame)
      }
    } catch (error) {
      this.emit('error', normalizeError(error))
      this.close()
    }
  }
}

export class TaodClient {
  private readonly socketPath: string
  private readonly connectTimeoutMs: number
  private readonly startTimeoutMs: number
  private readonly healthCheckIntervalMs: number
  private readonly restartBackoffMs: number
  private startPromise: Promise<void> | null = null
  private spawnedProcess: ChildProcess | null = null
  private healthTimer: ReturnType<typeof setInterval> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(
    options: {
      socketPath?: string
      connectTimeoutMs?: number
      startTimeoutMs?: number
      healthCheckIntervalMs?: number
      restartBackoffMs?: number
    } = {},
  ) {
    this.socketPath = options.socketPath ?? defaultSocketPath()
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS
    this.restartBackoffMs = options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS
  }

  async ensureRunning(): Promise<void> {
    if (this.disposed) throw new Error('taod client is disposed')
    this.startHealthChecks()
    if (await this.canConnect()) return

    this.startPromise ??= this.startDaemon().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  dispose(): void {
    this.disposed = true
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = null
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    // taod is intentionally detached and may keep live PTYs available across Electron restarts.
    // Disposing the client releases this process' handles without terminating the daemon.
    this.spawnedProcess?.removeAllListeners()
    this.spawnedProcess = null
  }

  async createSession(input: TaodCreateSessionInput): Promise<TaodControlResponse> {
    const response = await this.request({
      type: 'create',
      id: nextRequestId('create'),
      sessionId: input.sessionId,
      terminalId: input.terminalId,
      cols: input.cols,
      rows: input.rows,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.argv ? { argv: [...input.argv] } : {}),
    })
    if (!response.ok) throw responseError(response)
    return response
  }

  async attachSession(input: TaodAttachSessionInput): Promise<{
    response: TaodControlResponse
    stream: TaodSessionStream
  }> {
    await this.ensureRunning()
    const socket = await connectUnixSocket(this.socketPath, this.connectTimeoutMs)

    const request = {
      type: 'attach',
      id: nextRequestId('attach'),
      sessionId: input.sessionId,
      ...(input.terminalId ? { terminalId: input.terminalId } : {}),
      ...(input.cols ? { cols: input.cols } : {}),
      ...(input.rows ? { rows: input.rows } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
    }

    socket.write(`${JSON.stringify(request)}\n`)
    const { response, tail } = await readNdjsonResponse(socket, this.connectTimeoutMs)
    if (!response.ok) {
      socket.destroy()
      throw responseError(response)
    }

    return {
      response,
      stream: new TaodSessionStream(socket, input.sessionId, tail),
    }
  }

  async resizeSession(sessionId: string, cols: number, rows: number): Promise<TaodControlResponse> {
    const response = await this.request({
      type: 'resize',
      id: nextRequestId('resize'),
      sessionId,
      cols,
      rows,
    })
    if (!response.ok) throw responseError(response)
    return response
  }

  async detachSession(sessionId: string): Promise<void> {
    const response = await this.request({ type: 'detach', id: nextRequestId('detach'), sessionId })
    if (!response.ok) throw responseError(response)
  }

  async killSession(sessionId: string): Promise<void> {
    const response = await this.request({ type: 'kill', id: nextRequestId('kill'), sessionId })
    if (!response.ok) throw responseError(response)
  }

  async clearHistory(sessionIds?: readonly string[]): Promise<TaodControlResponse> {
    const response = await this.request({
      type: 'clear-history',
      id: nextRequestId('clear-history'),
      ...(sessionIds ? { sessionIds: [...sessionIds] } : {}),
    })
    if (!response.ok) throw responseError(response)
    return response
  }

  async cleanupSessions(input: TaodCleanupSessionsInput): Promise<TaodControlResponse> {
    const response = await this.request({
      type: 'cleanup',
      id: nextRequestId('cleanup'),
      retainDays: input.retainDays,
      maxSessionBytes: input.maxSessionBytes,
      ...(input.activeSessionIds ? { activeSessionIds: [...input.activeSessionIds] } : {}),
    })
    if (!response.ok) throw responseError(response)
    return response
  }

  async configurePersistence(input: TaodPersistenceSettingsInput): Promise<TaodControlResponse> {
    const response = await this.request({
      type: 'configure-persistence',
      id: nextRequestId('configure-persistence'),
      persistenceEnabled: input.enabled,
      persistInput: input.persistInput,
    })
    if (!response.ok) throw responseError(response)
    return response
  }

  private async canConnect(): Promise<boolean> {
    try {
      await this.request({ type: 'ping', id: nextRequestId('ping') }, { ensure: false })
      return true
    } catch {
      return false
    }
  }

  private async startDaemon(): Promise<void> {
    if (await this.canConnect()) return

    const binaryPath = findTaodBinary()
    if (!binaryPath) {
      throw new Error(
        `taod binary not found. Checked: ${candidateTaodPaths().join(', ') || '(none)'}`,
      )
    }

    if (
      !this.spawnedProcess ||
      this.spawnedProcess.exitCode !== null ||
      this.spawnedProcess.killed
    ) {
      const adapterDir = findTaodAdapterDir()
      const child = spawn(binaryPath, [], {
        // Detached/unref'd by design: taod owns PTYs and should survive renderer/app restarts.
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          ...(adapterDir ? { TAOD_ADAPTER_DIR: adapterDir } : {}),
        },
        cwd: dirname(binaryPath),
      })
      this.spawnedProcess = child
      child.once('exit', (code, signal) => {
        if (this.spawnedProcess === child) this.spawnedProcess = null
        if (!this.disposed) {
          this.scheduleRestart(`taod exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`)
        }
      })
      child.once('error', (error) => {
        if (this.spawnedProcess === child) this.spawnedProcess = null
        if (!this.disposed) this.scheduleRestart(`taod process error: ${error.message}`)
      })
      child.unref()
    }

    const deadline = Date.now() + this.startTimeoutMs
    let lastError: unknown = null
    while (Date.now() < deadline) {
      try {
        if (await this.canConnect()) return
      } catch (error) {
        lastError = error
      }
      await delay(75)
    }

    throw new Error(`Timed out waiting for taod to start: ${String(lastError ?? 'no response')}`)
  }

  private startHealthChecks(): void {
    if (this.healthCheckIntervalMs <= 0 || this.healthTimer) return

    this.healthTimer = setInterval(() => {
      void this.runHealthCheck()
    }, this.healthCheckIntervalMs)
    this.healthTimer.unref?.()
  }

  private async runHealthCheck(): Promise<void> {
    if (this.disposed || this.startPromise) return
    if (await this.canConnect()) return
    this.scheduleRestart('taod health check failed')
  }

  private scheduleRestart(reason: string): void {
    if (this.disposed || this.restartTimer) return

    console.warn(`[taod-client] ${reason}; scheduling restart`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.ensureRunning().catch((error) => {
        console.warn('[taod-client] taod restart failed:', error)
      })
    }, this.restartBackoffMs)
    this.restartTimer.unref?.()
  }

  private async request(
    request: TaodRequest,
    options: { ensure?: boolean } = {},
  ): Promise<TaodControlResponse> {
    if (options.ensure !== false) await this.ensureRunning()

    const socket = await connectUnixSocket(this.socketPath, this.connectTimeoutMs)
    try {
      socket.write(`${JSON.stringify(request)}\n`)
      const { response } = await readNdjsonResponse(socket, this.connectTimeoutMs)
      return response
    } finally {
      socket.end()
      socket.destroy()
    }
  }
}
