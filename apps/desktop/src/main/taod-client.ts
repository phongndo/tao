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
import type {
  GitStatus,
  WorkspaceRecord,
  WorkspaceWorktree,
  WorkspaceWorktreeState,
} from '@tao/shared/workspace'

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
  readonly branches?: unknown
  readonly error_code?: string
  readonly error_message?: string
}

type TaodRawControlResponse = TaodControlResponse & Record<string, unknown>

type RawGitStatus = {
  readonly changed?: unknown
  readonly staged?: unknown
}

type RawWorktree = {
  readonly id?: unknown
  readonly workspace_id?: unknown
  readonly workspaceId?: unknown
  readonly title?: unknown
  readonly folder_name?: unknown
  readonly folderName?: unknown
  readonly path?: unknown
  readonly branch?: unknown
  readonly base_branch?: unknown
  readonly baseBranch?: unknown
  readonly target_branch?: unknown
  readonly targetBranch?: unknown
  readonly state?: unknown
  readonly order_index?: unknown
  readonly orderIndex?: unknown
  readonly last_active_tab_id?: unknown
  readonly lastActiveTabId?: unknown
  readonly last_error?: unknown
  readonly lastError?: unknown
  readonly created_by?: unknown
  readonly createdBy?: unknown
  readonly git_status?: unknown
  readonly gitStatus?: unknown
}

type RawWorkspace = {
  readonly id?: unknown
  readonly name?: unknown
  readonly root_path?: unknown
  readonly rootPath?: unknown
  readonly git_common_dir?: unknown
  readonly gitCommonDir?: unknown
  readonly workspace_slug?: unknown
  readonly workspaceSlug?: unknown
  readonly default_branch?: unknown
  readonly defaultBranch?: unknown
  readonly branch?: unknown
  readonly order_index?: unknown
  readonly orderIndex?: unknown
  readonly last_active_tab_id?: unknown
  readonly lastActiveTabId?: unknown
  readonly git_status?: unknown
  readonly gitStatus?: unknown
  readonly worktrees?: unknown
}

export type TaodCreateSessionInput = {
  readonly sessionId: string
  readonly terminalId: string
  readonly workspaceId: string
  readonly worktreeId?: string
  readonly cols: number
  readonly rows: number
  readonly cwd?: string
  readonly argv?: readonly string[]
}

export type TaodAttachSessionInput = {
  readonly sessionId: string
  readonly terminalId?: string
  readonly workspaceId?: string
  readonly worktreeId?: string
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

export type TaodAddWorkspaceInput = {
  readonly rootPath: string
  readonly workspaceId?: string
  readonly name?: string
  readonly orderIndex?: number
}

export type TaodCreateWorktreeInput = {
  readonly workspaceId: string
  readonly baseBranch?: string
  readonly targetBranch?: string
  readonly branch?: string
  readonly folderName?: string
  readonly startPoint?: string
  readonly title?: string
}

export type TaodRemoveWorktreeInput = {
  readonly worktreeId: string
  readonly force?: boolean
  readonly deleteBranch?: boolean
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
  const error = new Error(response.error_message ?? 'taod request failed') as Error & {
    code?: string
  }
  error.code = response.error_code
  return error
}

function parseControlResponse(line: Buffer): TaodRawControlResponse {
  const parsed = JSON.parse(line.toString('utf8')) as TaodRawControlResponse
  if (!parsed || typeof parsed.ok !== 'boolean') throw new Error('Invalid taod control response')
  return parsed
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalNullableString(value: unknown): string | null | undefined {
  return value === null ? null : optionalString(value)
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

const VALID_WORKTREE_STATES = new Set<WorkspaceWorktreeState>([
  'creating',
  'active',
  'missing',
  'removing',
  'archived',
  'error',
  'untracked',
])

function isWorkspaceWorktreeState(value: string): value is WorkspaceWorktreeState {
  return VALID_WORKTREE_STATES.has(value as WorkspaceWorktreeState)
}

function normalizeGitStatus(value: unknown): GitStatus | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as RawGitStatus
  return {
    changed: numberOr(raw.changed, 0),
    staged: numberOr(raw.staged, 0),
  }
}

function normalizeWorktree(value: unknown): WorkspaceWorktree {
  if (!value || typeof value !== 'object') throw new Error('Invalid taod worktree')
  const raw = value as RawWorktree
  const id = optionalString(raw.id)
  const workspaceId = optionalString(raw.workspace_id ?? raw.workspaceId)
  const folderName = optionalString(raw.folder_name ?? raw.folderName)
  const path = optionalString(raw.path)
  const branch = optionalString(raw.branch)
  const state = optionalString(raw.state)
  if (!id || !workspaceId || !folderName || !path || !branch || !state) {
    throw new Error('Invalid taod worktree')
  }
  if (!isWorkspaceWorktreeState(state)) {
    throw new Error('Invalid taod worktree')
  }

  return {
    id,
    workspaceId,
    title: optionalNullableString(raw.title),
    folderName,
    path,
    branch,
    baseBranch: optionalNullableString(raw.base_branch ?? raw.baseBranch),
    targetBranch: optionalNullableString(raw.target_branch ?? raw.targetBranch),
    state,
    orderIndex: numberOr(raw.order_index ?? raw.orderIndex, 0),
    lastActiveTabId: optionalNullableString(raw.last_active_tab_id ?? raw.lastActiveTabId),
    lastError: optionalNullableString(raw.last_error ?? raw.lastError),
    createdBy: optionalString(raw.created_by ?? raw.createdBy) ?? 'tao',
    gitStatus: normalizeGitStatus(raw.git_status ?? raw.gitStatus) ?? null,
  }
}

function normalizeWorkspace(value: unknown): WorkspaceRecord {
  if (!value || typeof value !== 'object') throw new Error('Invalid taod workspace')
  const raw = value as RawWorkspace
  const id = optionalString(raw.id)
  const name = optionalString(raw.name)
  const rootPath = optionalString(raw.root_path ?? raw.rootPath)
  const workspaceSlug = optionalString(raw.workspace_slug ?? raw.workspaceSlug)
  if (!id || !name || !rootPath || !workspaceSlug) throw new Error('Invalid taod workspace')
  const rawWorktrees = Array.isArray(raw.worktrees) ? raw.worktrees : []

  return {
    id,
    name,
    rootPath,
    gitCommonDir: optionalNullableString(raw.git_common_dir ?? raw.gitCommonDir),
    workspaceSlug,
    defaultBranch: optionalNullableString(raw.default_branch ?? raw.defaultBranch),
    branch: optionalNullableString(raw.branch),
    orderIndex: numberOr(raw.order_index ?? raw.orderIndex, 0),
    lastActiveTabId: optionalNullableString(raw.last_active_tab_id ?? raw.lastActiveTabId),
    gitStatus: normalizeGitStatus(raw.git_status ?? raw.gitStatus) ?? null,
    worktrees: rawWorktrees.map(normalizeWorktree),
  }
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
): Promise<{ response: TaodRawControlResponse; tail: Buffer }> {
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
      workspaceId: input.workspaceId,
      ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
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
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
      ...(input.cols ? { cols: input.cols } : {}),
      ...(input.rows ? { rows: input.rows } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
    }

    socket.write(`${JSON.stringify(request)}\n`)
    let response: TaodControlResponse
    let tail: Buffer
    try {
      ;({ response, tail } = await readNdjsonResponse(socket, this.connectTimeoutMs))
    } catch (error) {
      socket.end()
      socket.destroy()
      throw error
    }
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

  async listWorkspaces(): Promise<readonly WorkspaceRecord[]> {
    const response = await this.request({
      type: 'workspace.list',
      id: nextRequestId('workspace-list'),
    })
    if (!response.ok) throw responseError(response)
    const workspaces = response.workspaces
    if (!Array.isArray(workspaces)) throw new Error('Invalid workspace.list response')
    return workspaces.map(normalizeWorkspace)
  }

  async addWorkspace(input: TaodAddWorkspaceInput): Promise<WorkspaceRecord> {
    const response = await this.request({
      type: 'workspace.add',
      id: nextRequestId('workspace-add'),
      rootPath: input.rootPath,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(typeof input.orderIndex === 'number' ? { orderIndex: input.orderIndex } : {}),
    })
    if (!response.ok) throw responseError(response)
    return normalizeWorkspace(response.workspace)
  }

  async refreshWorkspace(workspaceId: string): Promise<WorkspaceRecord> {
    const response = await this.request({
      type: 'workspace.refresh',
      id: nextRequestId('workspace-refresh'),
      workspaceId,
    })
    if (!response.ok) throw responseError(response)
    return normalizeWorkspace(response.workspace)
  }

  async removeWorkspace(workspaceId: string): Promise<void> {
    const response = await this.request({
      type: 'workspace.remove',
      id: nextRequestId('workspace-remove'),
      workspaceId,
    })
    if (!response.ok) throw responseError(response)
  }

  async listBranches(rootPath: string): Promise<string[]> {
    const response = await this.request({
      type: 'workspace.branches',
      id: nextRequestId('workspace-branches'),
      rootPath,
    })
    if (!response.ok) throw responseError(response)
    return stringArray(response.branches)
  }

  async createWorktree(input: TaodCreateWorktreeInput): Promise<WorkspaceWorktree> {
    const response = await this.request({
      type: 'worktree.create',
      id: nextRequestId('worktree-create'),
      workspaceId: input.workspaceId,
      ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
      ...(input.targetBranch ? { targetBranch: input.targetBranch } : {}),
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.folderName ? { folderName: input.folderName } : {}),
      ...(input.startPoint ? { startPoint: input.startPoint } : {}),
      ...(input.title ? { title: input.title } : {}),
    })
    if (!response.ok) throw responseError(response)
    return normalizeWorktree(response.worktree)
  }

  async refreshWorktree(worktreeId: string): Promise<WorkspaceWorktree> {
    const response = await this.request({
      type: 'worktree.refresh',
      id: nextRequestId('worktree-refresh'),
      worktreeId,
    })
    if (!response.ok) throw responseError(response)
    return normalizeWorktree(response.worktree)
  }

  async removeWorktree(input: TaodRemoveWorktreeInput): Promise<void> {
    const response = await this.request({
      type: 'worktree.remove',
      id: nextRequestId('worktree-remove'),
      worktreeId: input.worktreeId,
      ...(input.force ? { force: input.force } : {}),
      ...(input.deleteBranch ? { deleteBranch: input.deleteBranch } : {}),
    })
    if (!response.ok) throw responseError(response)
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
  ): Promise<TaodRawControlResponse> {
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
