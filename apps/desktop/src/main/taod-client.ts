import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import electron from 'electron'
import { resolveTaoStoragePaths } from '@tao/shared/storage-path'
import {
  TAOD_CONTROL_CAPABILITIES,
  TAOD_CONTROL_PROTOCOL_VERSION,
  TaodStreamFrameKind,
  type TaodControlRequestDiagnostics,
  type TaodDaemonControlDiagnostics,
  type TaodDaemonOwnership,
  type TaodLifecycleDiagnostics,
  type TaodLifecycleEvent,
  type TaodLifecycleRecoveryAction,
  type TaodLifecycleState,
  type TaodStreamDiagnostics,
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
  PortInfo,
  PullRequestInfo,
  WorktreeInfo,
  WorkspaceDiffPatch,
  WorkspaceDiffPatchScope,
  WorkspaceFileGitStatus,
  WorkspaceFileTree,
  WorkspaceRecord,
  WorkspaceWorktree,
  WorkspaceWorktreeState,
} from '@tao/shared/workspace'

const DEFAULT_CONNECT_TIMEOUT_MS = 500
const DEFAULT_CONTROL_RESPONSE_TIMEOUT_MS = 5000
const DEFAULT_START_TIMEOUT_MS = 3000
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 10_000
const DEFAULT_RESTART_BACKOFF_MS = 750
const DEFAULT_DISPOSE_DAEMON_TIMEOUT_MS = 1000
const CONTROL_RESPONSE_MAX_BYTES = 1024 * 1024
const TAOD_LIFECYCLE_EVENT_LIMIT = 32

type ElectronAppLike = {
  getAppPath(): string
}

const electronApp =
  typeof electron === 'object' && electron !== null && 'app' in electron
    ? (electron as { app?: ElectronAppLike }).app
    : undefined

type TaodRequest = Record<string, unknown>

export type TaodControlResponse = {
  readonly id?: string
  readonly trace_id?: string
  readonly traceId?: string
  readonly ok: boolean
  readonly protocol_version?: number
  readonly protocolVersion?: number
  readonly daemon_version?: string
  readonly daemonVersion?: string
  readonly capabilities?: unknown
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
  readonly branch?: unknown
  readonly branches?: unknown
  readonly worktrees?: unknown
  readonly git_status?: unknown
  readonly gitStatus?: unknown
  readonly file_tree?: unknown
  readonly fileTree?: unknown
  readonly diff_patch?: unknown
  readonly diffPatch?: unknown
  readonly ports?: unknown
  readonly pull_request?: unknown
  readonly pullRequest?: unknown
  readonly stream_diagnostics?: unknown
  readonly streamDiagnostics?: unknown
  readonly control_diagnostics?: unknown
  readonly controlDiagnostics?: unknown
  readonly error_code?: string
  readonly error_message?: string
}

type TaodRawControlResponse = TaodControlResponse & Record<string, unknown>

type RawGitStatus = {
  readonly changed?: unknown
  readonly staged?: unknown
}

type RawGitWorktreeInfo = {
  readonly path?: unknown
  readonly branch?: unknown
  readonly hash?: unknown
  readonly is_bare?: unknown
  readonly isBare?: unknown
}

type RawWorkspaceFileStatus = {
  readonly path?: unknown
  readonly status?: unknown
}

type RawWorkspaceFileTree = {
  readonly paths?: unknown
  readonly git_status?: unknown
  readonly gitStatus?: unknown
}

type RawWorkspacePort = {
  readonly port?: unknown
  readonly process_name?: unknown
  readonly processName?: unknown
}

type RawPullRequestInfo = {
  readonly number?: unknown
  readonly title?: unknown
  readonly url?: unknown
  readonly state?: unknown
  readonly head_ref_name?: unknown
  readonly headRefName?: unknown
}

type RawTaodStreamDiagnostics = {
  readonly active_subscribers?: unknown
  readonly activeSubscribers?: unknown
  readonly pending_output_sessions?: unknown
  readonly pendingOutputSessions?: unknown
  readonly pending_output_frames?: unknown
  readonly pendingOutputFrames?: unknown
  readonly pending_output_bytes?: unknown
  readonly pendingOutputBytes?: unknown
  readonly input_frames_total?: unknown
  readonly inputFramesTotal?: unknown
  readonly input_bytes_total?: unknown
  readonly inputBytesTotal?: unknown
  readonly output_frames_total?: unknown
  readonly outputFramesTotal?: unknown
  readonly output_bytes_total?: unknown
  readonly outputBytesTotal?: unknown
  readonly slow_subscriber_drops_total?: unknown
  readonly slowSubscriberDropsTotal?: unknown
  readonly pending_output_dropped_frames_total?: unknown
  readonly pendingOutputDroppedFramesTotal?: unknown
  readonly pending_output_dropped_bytes_total?: unknown
  readonly pendingOutputDroppedBytesTotal?: unknown
  readonly pending_output_truncated_bytes_total?: unknown
  readonly pendingOutputTruncatedBytesTotal?: unknown
}

type RawTaodDaemonControlDiagnostics = {
  readonly request_count?: unknown
  readonly requestCount?: unknown
  readonly failure_count?: unknown
  readonly failureCount?: unknown
  readonly last_request_type?: unknown
  readonly lastRequestType?: unknown
  readonly last_trace_id?: unknown
  readonly lastTraceId?: unknown
  readonly last_duration_ms?: unknown
  readonly lastDurationMs?: unknown
  readonly last_ok?: unknown
  readonly lastOk?: unknown
  readonly last_recorded_at_ms?: unknown
  readonly lastRecordedAtMs?: unknown
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

export type TaodWorkspaceDiffInput = {
  readonly rootPath: string
  readonly scope?: WorkspaceDiffPatchScope
  readonly compareBranch?: string
}

export type TaodGitPathActionInput = {
  readonly rootPath: string
  readonly path: string | readonly string[]
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function requestField(request: TaodRequest, field: string): string {
  const value = request[field]
  return typeof value === 'string' && value.length > 0 ? value : 'unknown'
}

function requestTraceId(clientTraceId: string, request: TaodRequest): string {
  const existing = requestField(request, 'traceId')
  if (existing !== 'unknown') return existing
  return `${clientTraceId}:${requestField(request, 'id')}`
}

function responseTraceId(response: TaodControlResponse): string | undefined {
  const traceId = response.trace_id ?? response.traceId
  return typeof traceId === 'string' && traceId.length > 0 ? traceId : undefined
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (hasExited(child)) return Promise.resolve()

  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.off('exit', finish)
      child.off('error', finish)
      resolve()
    }
    const timeout = setTimeout(finish, timeoutMs)
    timeout.unref?.()
    child.once('exit', finish)
    child.once('error', finish)
  })
}

function responseError(response: TaodControlResponse): Error {
  const error = new Error(response.error_message ?? 'taod request failed') as Error & {
    code?: string
    kind?: string
  }
  error.code = response.error_code
  error.kind = response.error_code
  return error
}

class TaodCompatibilityError extends Error {
  readonly code = 'TAOD_PROTOCOL_MISMATCH'
}

function isTaodCompatibilityError(error: unknown): error is TaodCompatibilityError {
  return error instanceof TaodCompatibilityError
}

function formatDaemonVersion(response: TaodControlResponse): string {
  return (
    optionalString(response.daemon_version ?? response.daemonVersion) ??
    `protocol ${String(response.protocol_version ?? response.protocolVersion ?? 'unknown')}`
  )
}

function assertCompatiblePingResponse(response: TaodControlResponse): void {
  if (!response.ok || response.status !== 'ok') throw responseError(response)

  const protocolVersion = numberOr(
    response.protocol_version ?? response.protocolVersion,
    Number.NaN,
  )
  if (protocolVersion !== TAOD_CONTROL_PROTOCOL_VERSION) {
    throw new TaodCompatibilityError(
      `taod protocol mismatch: desktop requires protocol ${TAOD_CONTROL_PROTOCOL_VERSION}, daemon reported ${String(protocolVersion)} (${formatDaemonVersion(response)})`,
    )
  }

  const capabilities = new Set(stringArray(response.capabilities))
  const missingCapabilities = TAOD_CONTROL_CAPABILITIES.filter(
    (capability) => !capabilities.has(capability),
  )
  if (missingCapabilities.length > 0) {
    throw new TaodCompatibilityError(
      `taod protocol mismatch: daemon ${formatDaemonVersion(response)} is missing capabilities ${missingCapabilities.join(', ')}`,
    )
  }
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

function gitPathActionPaths(path: string | readonly string[]): string[] {
  const values = Array.isArray(path) ? path : [path]
  const paths = values.map((value) => value.trim())
  if (
    paths.length === 0 ||
    paths.some((value) => value.length === 0 || value.startsWith('-') || value.includes('\0'))
  ) {
    throw new Error('Invalid workspace git path')
  }
  return paths
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

const VALID_WORKSPACE_FILE_STATUSES = new Set<WorkspaceFileGitStatus>([
  'added',
  'deleted',
  'ignored',
  'modified',
  'renamed',
  'untracked',
])

function isWorkspaceWorktreeState(value: string): value is WorkspaceWorktreeState {
  return VALID_WORKTREE_STATES.has(value as WorkspaceWorktreeState)
}

function isWorkspaceFileGitStatus(value: string): value is WorkspaceFileGitStatus {
  return VALID_WORKSPACE_FILE_STATUSES.has(value as WorkspaceFileGitStatus)
}

function normalizeGitStatus(value: unknown): GitStatus | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as RawGitStatus
  return {
    changed: numberOr(raw.changed, 0),
    staged: numberOr(raw.staged, 0),
  }
}

function normalizeGitWorktreeInfo(value: unknown): WorktreeInfo {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid workspace.gitWorktrees response')
  const raw = value as RawGitWorktreeInfo
  const path = optionalString(raw.path)
  if (!path) throw new Error('Invalid workspace.gitWorktrees response')
  return {
    path,
    branch: optionalString(raw.branch) ?? '',
    hash: optionalString(raw.hash) ?? '',
    isBare: raw.is_bare === true || raw.isBare === true,
  }
}

function normalizeWorkspaceFileTree(value: unknown): WorkspaceFileTree {
  if (!value || typeof value !== 'object') throw new Error('Invalid taod workspace file tree')
  const raw = value as RawWorkspaceFileTree
  const rawGitStatus = Array.isArray(raw.git_status ?? raw.gitStatus)
    ? ((raw.git_status ?? raw.gitStatus) as unknown[])
    : []

  return {
    paths: stringArray(raw.paths),
    gitStatus: rawGitStatus.map((entry) => {
      if (!entry || typeof entry !== 'object') throw new Error('Invalid taod workspace file status')
      const rawEntry = entry as RawWorkspaceFileStatus
      const path = optionalString(rawEntry.path)
      const status = optionalString(rawEntry.status)
      if (!path || !status || !isWorkspaceFileGitStatus(status)) {
        throw new Error('Invalid taod workspace file status')
      }
      return { path, status }
    }),
  }
}

function normalizeWorkspacePorts(value: unknown): PortInfo[] {
  if (!Array.isArray(value)) throw new Error('Invalid workspace.ports response')
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid workspace port')
    const raw = entry as RawWorkspacePort
    const port = numberOr(raw.port, 0)
    if (!Number.isInteger(port) || port <= 0) throw new Error('Invalid workspace port')
    const processName = optionalString(raw.process_name ?? raw.processName)
    return {
      port,
      ...(processName ? { processName } : {}),
    }
  })
}

function normalizePullRequestInfo(value: unknown): PullRequestInfo | null {
  if (value == null) return null
  if (typeof value !== 'object') throw new Error('Invalid workspace.pullRequest response')
  const raw = value as RawPullRequestInfo
  const number = numberOr(raw.number, 0)
  const title = optionalString(raw.title)
  const url = optionalString(raw.url)
  const state = optionalString(raw.state)
  if (!Number.isInteger(number) || number <= 0 || !title || !url || !state) {
    throw new Error('Invalid workspace.pullRequest response')
  }
  const headRefName = optionalString(raw.head_ref_name ?? raw.headRefName)
  return {
    number,
    title,
    url,
    state,
    ...(headRefName ? { headRefName } : {}),
  }
}

function normalizeTaodStreamDiagnostics(value: unknown): TaodStreamDiagnostics | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as RawTaodStreamDiagnostics
  return {
    activeSubscribers: numberOr(raw.active_subscribers ?? raw.activeSubscribers, 0),
    pendingOutputSessions: numberOr(raw.pending_output_sessions ?? raw.pendingOutputSessions, 0),
    pendingOutputFrames: numberOr(raw.pending_output_frames ?? raw.pendingOutputFrames, 0),
    pendingOutputBytes: numberOr(raw.pending_output_bytes ?? raw.pendingOutputBytes, 0),
    inputFramesTotal: numberOr(raw.input_frames_total ?? raw.inputFramesTotal, 0),
    inputBytesTotal: numberOr(raw.input_bytes_total ?? raw.inputBytesTotal, 0),
    outputFramesTotal: numberOr(raw.output_frames_total ?? raw.outputFramesTotal, 0),
    outputBytesTotal: numberOr(raw.output_bytes_total ?? raw.outputBytesTotal, 0),
    slowSubscriberDropsTotal: numberOr(
      raw.slow_subscriber_drops_total ?? raw.slowSubscriberDropsTotal,
      0,
    ),
    pendingOutputDroppedFramesTotal: numberOr(
      raw.pending_output_dropped_frames_total ?? raw.pendingOutputDroppedFramesTotal,
      0,
    ),
    pendingOutputDroppedBytesTotal: numberOr(
      raw.pending_output_dropped_bytes_total ?? raw.pendingOutputDroppedBytesTotal,
      0,
    ),
    pendingOutputTruncatedBytesTotal: numberOr(
      raw.pending_output_truncated_bytes_total ?? raw.pendingOutputTruncatedBytesTotal,
      0,
    ),
  }
}

function normalizeTaodDaemonControlDiagnostics(
  value: unknown,
): TaodDaemonControlDiagnostics | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as RawTaodDaemonControlDiagnostics
  const lastRequestType = optionalString(raw.last_request_type ?? raw.lastRequestType)
  const lastTraceId = optionalString(raw.last_trace_id ?? raw.lastTraceId)
  const lastDurationMs = raw.last_duration_ms ?? raw.lastDurationMs
  const lastOk = raw.last_ok ?? raw.lastOk
  const lastRecordedAtMs = raw.last_recorded_at_ms ?? raw.lastRecordedAtMs
  return {
    requestCount: numberOr(raw.request_count ?? raw.requestCount, 0),
    failureCount: numberOr(raw.failure_count ?? raw.failureCount, 0),
    ...(lastRequestType ? { lastRequestType } : {}),
    ...(lastTraceId ? { lastTraceId } : {}),
    ...(typeof lastDurationMs === 'number' ? { lastDurationMs } : {}),
    ...(typeof lastOk === 'boolean' ? { lastOk } : {}),
    ...(typeof lastRecordedAtMs === 'number' ? { lastRecordedAtMs } : {}),
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
    return electronApp?.getAppPath() ?? null
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

function writeSocketPayload(
  socket: net.Socket,
  payload: string | Buffer,
  timeoutMs: number,
  context: string,
): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    let settled = false
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out writing ${context} to taod`))
    }, timeoutMs)

    function cleanup() {
      clearTimeout(timeout)
      socket.off('drain', onDrain)
      socket.off('error', onError)
      socket.off('close', onClose)
    }

    function resolve() {
      if (settled) return
      settled = true
      cleanup()
      resolveWrite()
    }

    function reject(error: Error) {
      if (settled) return
      settled = true
      cleanup()
      rejectWrite(error)
    }

    function onDrain() {
      resolve()
    }

    function onError(error: Error) {
      reject(error)
    }

    function onClose() {
      reject(new Error(`taod closed the socket before accepting ${context}`))
    }

    socket.once('error', onError)
    socket.once('close', onClose)
    const accepted = socket.write(payload, (error) => {
      if (error) reject(error)
    })

    if (!accepted) {
      console.warn(
        `[taod-client] socket write backpressure while writing ${context}; buffered=${socket.writableLength}`,
      )
      socket.once('drain', onDrain)
      return
    }

    resolve()
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
  private waitingForWriteDrain = false

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
    const accepted = this.socket.write(frame)
    if (!accepted && !this.waitingForWriteDrain) {
      this.waitingForWriteDrain = true
      console.warn(
        `[taod-client] stream write backpressure for ${this.sessionId}; buffered=${this.socket.writableLength}`,
      )
      this.socket.once('drain', () => {
        this.waitingForWriteDrain = false
      })
    }
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
  private readonly controlResponseTimeoutMs: number
  private readonly startTimeoutMs: number
  private readonly healthCheckIntervalMs: number
  private readonly restartBackoffMs: number
  private readonly detachDaemon: boolean
  private startPromise: Promise<void> | null = null
  private spawnedProcess: ChildProcess | null = null
  private healthTimer: ReturnType<typeof setInterval> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private lifecycleState: TaodLifecycleState = 'absent'
  private lifecycleReason: string | undefined
  private lifecycleError: string | undefined
  private lifecycleDaemonVersion: string | undefined
  private lifecycleProtocolVersion: number | undefined
  private lifecycleCapabilities: string[] = []
  private lifecycleStreamDiagnostics: TaodStreamDiagnostics | undefined
  private lifecycleDaemonControlDiagnostics: TaodDaemonControlDiagnostics | undefined
  private lifecycleDaemonOwnership: TaodDaemonOwnership = 'none'
  private releasedDetachedPid: number | undefined
  private controlRequestCount = 0
  private controlRequestFailureCount = 0
  private lastControlRequest: TaodControlRequestDiagnostics | undefined
  private readonly clientTraceId = nextRequestId('taod-client')
  private readonly clientCreatedAt = Date.now()
  private lastTransitionAt = this.clientCreatedAt
  private lastPingStartedAt: number | undefined
  private lastPingDurationMs: number | undefined
  private lastSuccessfulPingAt: number | undefined
  private lastFailedPingAt: number | undefined
  private lastStartRequestedAt: number | undefined
  private lastStartDurationMs: number | undefined
  private readonly lifecycleEvents: TaodLifecycleEvent[] = [
    { state: 'absent', at: this.clientCreatedAt, reason: 'client-created' },
  ]

  constructor(
    options: {
      socketPath?: string
      connectTimeoutMs?: number
      controlResponseTimeoutMs?: number
      startTimeoutMs?: number
      healthCheckIntervalMs?: number
      restartBackoffMs?: number
      detachDaemon?: boolean
    } = {},
  ) {
    this.socketPath = options.socketPath ?? defaultSocketPath()
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.controlResponseTimeoutMs =
      options.controlResponseTimeoutMs ?? DEFAULT_CONTROL_RESPONSE_TIMEOUT_MS
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS
    this.restartBackoffMs = options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS
    this.detachDaemon = options.detachDaemon ?? true
  }

  getLifecycleDiagnostics(): TaodLifecycleDiagnostics {
    return {
      clientTraceId: this.clientTraceId,
      state: this.lifecycleState,
      socketPath: this.socketPath,
      detachDaemon: this.detachDaemon,
      healthChecksEnabled: this.healthCheckIntervalMs > 0,
      healthChecksStarted: this.healthTimer !== null,
      startInFlight: this.startPromise !== null,
      restartScheduled: this.restartTimer !== null,
      daemonOwnership: this.lifecycleDaemonOwnership,
      recoveryAction: this.lifecycleRecoveryAction(),
      ...(this.spawnedProcess?.pid ? { spawnedPid: this.spawnedProcess.pid } : {}),
      ...(this.releasedDetachedPid ? { releasedDetachedPid: this.releasedDetachedPid } : {}),
      ...(this.lifecycleDaemonVersion ? { daemonVersion: this.lifecycleDaemonVersion } : {}),
      ...(typeof this.lifecycleProtocolVersion === 'number'
        ? { protocolVersion: this.lifecycleProtocolVersion }
        : {}),
      capabilities: [...this.lifecycleCapabilities],
      ...(this.lifecycleReason ? { lastReason: this.lifecycleReason } : {}),
      ...(this.lifecycleError ? { lastError: this.lifecycleError } : {}),
      controlRequestCount: this.controlRequestCount,
      controlRequestFailureCount: this.controlRequestFailureCount,
      ...(this.lastControlRequest ? { lastControlRequest: this.lastControlRequest } : {}),
      ...(this.lifecycleStreamDiagnostics
        ? { streamDiagnostics: this.lifecycleStreamDiagnostics }
        : {}),
      ...(this.lifecycleDaemonControlDiagnostics
        ? { daemonControlDiagnostics: this.lifecycleDaemonControlDiagnostics }
        : {}),
      timing: {
        clientCreatedAt: this.clientCreatedAt,
        lastTransitionAt: this.lastTransitionAt,
        ...(typeof this.lastPingStartedAt === 'number'
          ? { lastPingStartedAt: this.lastPingStartedAt }
          : {}),
        ...(typeof this.lastPingDurationMs === 'number'
          ? { lastPingDurationMs: this.lastPingDurationMs }
          : {}),
        ...(typeof this.lastSuccessfulPingAt === 'number'
          ? { lastSuccessfulPingAt: this.lastSuccessfulPingAt }
          : {}),
        ...(typeof this.lastFailedPingAt === 'number'
          ? { lastFailedPingAt: this.lastFailedPingAt }
          : {}),
        ...(typeof this.lastStartRequestedAt === 'number'
          ? { lastStartRequestedAt: this.lastStartRequestedAt }
          : {}),
        ...(typeof this.lastStartDurationMs === 'number'
          ? { lastStartDurationMs: this.lastStartDurationMs }
          : {}),
      },
      transitions: [...this.lifecycleEvents],
    }
  }

  private transitionLifecycle(state: TaodLifecycleState, reason?: string, error?: unknown): void {
    const transitionedAt = Date.now()
    this.lifecycleState = state
    this.lifecycleReason = reason
    this.lifecycleError = error == null ? undefined : errorMessage(error)
    this.lastTransitionAt = transitionedAt
    this.lifecycleEvents.push({
      state,
      at: transitionedAt,
      ...(reason ? { reason } : {}),
    })
    if (this.lifecycleEvents.length > TAOD_LIFECYCLE_EVENT_LIMIT) {
      this.lifecycleEvents.splice(0, this.lifecycleEvents.length - TAOD_LIFECYCLE_EVENT_LIMIT)
    }
  }

  private recordLiveDaemon(response: TaodControlResponse): void {
    this.lifecycleDaemonOwnership = this.currentDaemonOwnership()
    this.lifecycleDaemonVersion =
      optionalString(response.daemon_version ?? response.daemonVersion) ??
      this.lifecycleDaemonVersion
    this.lifecycleProtocolVersion = numberOr(
      response.protocol_version ?? response.protocolVersion,
      this.lifecycleProtocolVersion ?? Number.NaN,
    )
    if (!Number.isFinite(this.lifecycleProtocolVersion)) this.lifecycleProtocolVersion = undefined
    this.lifecycleCapabilities = stringArray(response.capabilities)
    this.lifecycleStreamDiagnostics = normalizeTaodStreamDiagnostics(
      response.stream_diagnostics ?? response.streamDiagnostics,
    )
    this.lifecycleDaemonControlDiagnostics = normalizeTaodDaemonControlDiagnostics(
      response.control_diagnostics ?? response.controlDiagnostics,
    )
  }

  private currentDaemonOwnership(): TaodDaemonOwnership {
    if (this.spawnedProcess && !hasExited(this.spawnedProcess)) {
      return this.detachDaemon ? 'owned-detached' : 'owned-attached'
    }
    return 'external'
  }

  private lifecycleRecoveryAction(): TaodLifecycleRecoveryAction {
    if (this.disposed) {
      return this.lifecycleDaemonOwnership === 'released-detached' ? 'keep-detached-daemon' : 'none'
    }
    switch (this.lifecycleState) {
      case 'absent':
        return 'start-daemon'
      case 'starting':
        return 'wait-for-start'
      case 'external-live':
        return 'reuse-external-daemon'
      case 'owned-live':
        return 'none'
      case 'stale-socket':
        return 'clear-stale-socket-and-start'
      case 'crashed':
        return 'restart-owned-daemon'
      case 'version-mismatch':
        return 'replace-incompatible-daemon'
      case 'stopping':
      case 'disposed':
        return 'none'
    }
  }

  async refreshLifecycleDiagnostics(): Promise<TaodLifecycleDiagnostics> {
    if (!this.disposed) {
      try {
        await this.canConnect()
      } catch {
        // canConnect records lifecycle state before returning or throwing. Keep diagnostics readable
        // even when the latest refresh cannot reach a compatible daemon.
      }
    }
    return this.getLifecycleDiagnostics()
  }

  private recordControlRequest(
    request: TaodRequest,
    startedAt: number,
    ok: boolean,
    responseTrace: string | undefined,
    error?: unknown,
  ): void {
    this.controlRequestCount += 1
    if (!ok) this.controlRequestFailureCount += 1
    this.lastControlRequest = {
      id: requestField(request, 'id'),
      traceId: requestTraceId(this.clientTraceId, request),
      ...(responseTrace ? { responseTraceId: responseTrace } : {}),
      type: requestField(request, 'type'),
      at: startedAt,
      durationMs: Date.now() - startedAt,
      ok,
      ...(error == null ? {} : { error: errorMessage(error) }),
    }
  }

  async ensureRunning(): Promise<void> {
    if (this.disposed) throw new Error('taod client is disposed')
    this.startHealthChecks()
    if (await this.canConnect()) {
      if (this.disposed) throw new Error('taod client is disposed')
      return
    }
    if (this.disposed) throw new Error('taod client is disposed')

    this.transitionLifecycle('starting', 'daemon-start-requested')
    this.startPromise ??= this.startDaemon().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  async applyLifecycleRecovery(
    action: TaodLifecycleRecoveryAction,
  ): Promise<TaodLifecycleDiagnostics> {
    if (
      action === 'none' ||
      action === 'reuse-external-daemon' ||
      action === 'keep-detached-daemon'
    ) {
      return this.refreshLifecycleDiagnostics()
    }

    const diagnostics = this.getLifecycleDiagnostics()
    if (diagnostics.recoveryAction !== action) {
      throw new Error(
        `Cannot apply taod recovery action ${action}; current action is ${diagnostics.recoveryAction}`,
      )
    }

    switch (action) {
      case 'start-daemon':
      case 'wait-for-start':
      case 'clear-stale-socket-and-start':
        this.clearScheduledRestart()
        await this.ensureRunning()
        break
      case 'restart-owned-daemon':
        this.clearScheduledRestart()
        await this.restartOwnedDaemon('manual-recovery-restart-owned')
        break
      case 'replace-incompatible-daemon':
        this.clearScheduledRestart()
        await this.restartOwnedDaemon('manual-recovery-replace-incompatible')
        break
    }

    return this.refreshLifecycleDiagnostics()
  }

  async dispose(): Promise<void> {
    this.transitionLifecycle('stopping', 'client-dispose')
    this.disposed = true
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = null
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const spawnedProcess = this.spawnedProcess
    const releasedDetachedPid =
      this.detachDaemon && spawnedProcess && !hasExited(spawnedProcess)
        ? spawnedProcess.pid
        : undefined
    if (releasedDetachedPid) {
      this.releasedDetachedPid = releasedDetachedPid
      this.lifecycleDaemonOwnership = 'released-detached'
    } else {
      this.lifecycleDaemonOwnership = 'none'
    }
    this.spawnedProcess = null
    // taod is intentionally detached and may keep live PTYs available across Electron restarts.
    // Disposing the client releases this process' handles without terminating the daemon.
    if (!this.detachDaemon && spawnedProcess && !hasExited(spawnedProcess)) {
      spawnedProcess.kill()
      await waitForChildExit(spawnedProcess, DEFAULT_DISPOSE_DAEMON_TIMEOUT_MS)
      if (!hasExited(spawnedProcess)) {
        spawnedProcess.kill('SIGKILL')
        await waitForChildExit(spawnedProcess, DEFAULT_DISPOSE_DAEMON_TIMEOUT_MS)
      }
    }
    spawnedProcess?.removeAllListeners()
    this.transitionLifecycle('disposed', 'client-disposed')
  }

  private clearScheduledRestart(): void {
    if (!this.restartTimer) return
    clearTimeout(this.restartTimer)
    this.restartTimer = null
  }

  private async restartOwnedDaemon(reason: string): Promise<void> {
    if (this.disposed) throw new Error('taod client is disposed')
    const spawnedProcess = this.spawnedProcess
    if (!spawnedProcess || hasExited(spawnedProcess)) {
      throw new Error('Cannot restart taod because this client does not own a running daemon')
    }

    this.transitionLifecycle('stopping', reason)
    spawnedProcess.removeAllListeners('exit')
    spawnedProcess.removeAllListeners('error')
    spawnedProcess.kill()
    await waitForChildExit(spawnedProcess, DEFAULT_DISPOSE_DAEMON_TIMEOUT_MS)
    if (!hasExited(spawnedProcess)) {
      spawnedProcess.kill('SIGKILL')
      await waitForChildExit(spawnedProcess, DEFAULT_DISPOSE_DAEMON_TIMEOUT_MS)
    }
    if (!hasExited(spawnedProcess)) {
      throw new Error('Timed out stopping owned taod for recovery')
    }

    spawnedProcess.removeAllListeners()
    if (this.spawnedProcess === spawnedProcess) this.spawnedProcess = null
    this.lifecycleDaemonOwnership = 'none'
    this.transitionLifecycle('absent', `${reason}:stopped`)
    await this.ensureRunning()
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

    const request = this.withTrace({
      type: 'attach',
      id: nextRequestId('attach'),
      sessionId: input.sessionId,
      ...(input.terminalId ? { terminalId: input.terminalId } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
      ...(input.cols ? { cols: input.cols } : {}),
      ...(input.rows ? { rows: input.rows } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
    })

    let response: TaodControlResponse
    let tail: Buffer
    const startedAt = Date.now()
    try {
      await writeSocketPayload(
        socket,
        `${JSON.stringify(request)}\n`,
        this.controlResponseTimeoutMs,
        'attach request',
      )
      ;({ response, tail } = await readNdjsonResponse(socket, this.controlResponseTimeoutMs))
    } catch (error) {
      this.recordControlRequest(request, startedAt, false, undefined, error)
      socket.end()
      socket.destroy()
      throw error
    }
    this.recordControlRequest(
      request,
      startedAt,
      response.ok,
      responseTraceId(response),
      response.ok ? undefined : responseError(response),
    )
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

  async getGitBranch(rootPath: string): Promise<string | null> {
    const response = await this.request({
      type: 'workspace.branch',
      id: nextRequestId('workspace-branch'),
      rootPath,
    })
    if (!response.ok) throw responseError(response)
    const branch = response.branch
    return typeof branch === 'string' && branch.length > 0 ? branch : null
  }

  async getGitWorktrees(rootPath: string): Promise<WorktreeInfo[]> {
    const response = await this.request({
      type: 'workspace.gitWorktrees',
      id: nextRequestId('workspace-git-worktrees'),
      rootPath,
    })
    if (!response.ok) throw responseError(response)
    if (!Array.isArray(response.worktrees))
      throw new Error('Invalid workspace.gitWorktrees response')
    return response.worktrees.map(normalizeGitWorktreeInfo)
  }

  async getGitStatus(rootPath: string): Promise<GitStatus> {
    const response = await this.request({
      type: 'workspace.status',
      id: nextRequestId('workspace-status'),
      rootPath,
    })
    if (!response.ok) throw responseError(response)
    return (
      normalizeGitStatus(response.git_status ?? response.gitStatus) ?? { changed: 0, staged: 0 }
    )
  }

  async getWorkspaceFileTree(rootPath: string): Promise<WorkspaceFileTree> {
    const response = await this.request({
      type: 'workspace.fileTree',
      id: nextRequestId('workspace-file-tree'),
      rootPath,
    })
    if (!response.ok) throw responseError(response)
    return normalizeWorkspaceFileTree(response.file_tree ?? response.fileTree)
  }

  async getWorkspaceDiffPatch(input: TaodWorkspaceDiffInput): Promise<WorkspaceDiffPatch> {
    const response = await this.request({
      type: 'workspace.diff',
      id: nextRequestId('workspace-diff'),
      rootPath: input.rootPath,
      scope: input.scope ?? 'all',
      ...(input.compareBranch ? { compareBranch: input.compareBranch } : {}),
    })
    if (!response.ok) throw responseError(response)
    const patch = response.diff_patch ?? response.diffPatch
    if (typeof patch !== 'string') throw new Error('Invalid workspace.diff response')
    return patch
  }

  async stagePath(input: TaodGitPathActionInput): Promise<void> {
    await this.gitPathAction('workspace.stagePath', 'workspace-stage-path', input)
  }

  async unstagePath(input: TaodGitPathActionInput): Promise<void> {
    await this.gitPathAction('workspace.unstagePath', 'workspace-unstage-path', input)
  }

  async revertPath(input: TaodGitPathActionInput): Promise<void> {
    await this.gitPathAction('workspace.revertPath', 'workspace-revert-path', input)
  }

  async getWorkspacePorts(rootPath: string): Promise<PortInfo[]> {
    const response = await this.request({
      type: 'workspace.ports',
      id: nextRequestId('workspace-ports'),
      rootPath,
    })
    if (!response.ok) throw responseError(response)
    return normalizeWorkspacePorts(response.ports)
  }

  async getPullRequestInfo(rootPath: string): Promise<PullRequestInfo | null> {
    const response = await this.request({
      type: 'workspace.pullRequest',
      id: nextRequestId('workspace-pr'),
      rootPath,
    })
    if (!response.ok) throw responseError(response)
    return normalizePullRequestInfo(response.pull_request ?? response.pullRequest)
  }

  private async gitPathAction(
    type: 'workspace.stagePath' | 'workspace.unstagePath' | 'workspace.revertPath',
    requestIdPrefix: string,
    input: TaodGitPathActionInput,
  ): Promise<void> {
    const response = await this.request({
      type,
      id: nextRequestId(requestIdPrefix),
      rootPath: input.rootPath,
      paths: gitPathActionPaths(input.path),
    })
    if (!response.ok) throw responseError(response)
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
    const pingStartedAt = Date.now()
    this.lastPingStartedAt = pingStartedAt
    try {
      const response = await this.request(
        { type: 'ping', id: nextRequestId('ping') },
        { ensure: false },
      )
      const pingFinishedAt = Date.now()
      this.lastPingDurationMs = pingFinishedAt - pingStartedAt
      this.lastSuccessfulPingAt = pingFinishedAt
      assertCompatiblePingResponse(response)
      this.recordLiveDaemon(response)
      this.transitionLifecycle(
        this.spawnedProcess && !hasExited(this.spawnedProcess) ? 'owned-live' : 'external-live',
        'ping-ok',
      )
      return true
    } catch (error) {
      const pingFinishedAt = Date.now()
      this.lastPingDurationMs = pingFinishedAt - pingStartedAt
      this.lastFailedPingAt = pingFinishedAt
      if (isTaodCompatibilityError(error)) {
        this.lifecycleDaemonOwnership = this.currentDaemonOwnership()
        this.transitionLifecycle('version-mismatch', 'ping-version-mismatch', error)
        throw error
      }
      const code = errorCode(error)
      this.lifecycleDaemonOwnership = 'none'
      this.transitionLifecycle(
        code === 'ENOENT' ? 'absent' : 'stale-socket',
        code ? `ping-failed:${code}` : 'ping-failed',
        error,
      )
      return false
    }
  }

  private async startDaemon(): Promise<void> {
    if (this.disposed) throw new Error('taod client is disposed')
    const startRequestedAt = Date.now()
    this.lastStartRequestedAt = startRequestedAt
    if (await this.canConnect()) {
      if (this.disposed) throw new Error('taod client is disposed')
      this.lastStartDurationMs = Date.now() - startRequestedAt
      return
    }
    if (this.disposed) throw new Error('taod client is disposed')

    const binaryPath = findTaodBinary()
    if (!binaryPath) {
      this.lifecycleDaemonOwnership = 'none'
      this.transitionLifecycle('absent', 'binary-not-found')
      throw new Error(
        `taod binary not found. Checked: ${candidateTaodPaths().join(', ') || '(none)'}`,
      )
    }

    if (
      !this.spawnedProcess ||
      this.spawnedProcess.exitCode !== null ||
      this.spawnedProcess.killed
    ) {
      if (this.disposed) throw new Error('taod client is disposed')
      const adapterDir = findTaodAdapterDir()
      const stdio: StdioOptions = this.detachDaemon ? 'ignore' : ['ignore', 'ignore', 'pipe']
      const child = spawn(binaryPath, [], {
        // Detached/unref'd in normal app runs: taod owns PTYs and should survive Electron restarts.
        // Smoke runs keep it attached so the test can clean up the temporary-home daemon.
        detached: this.detachDaemon,
        stdio,
        env: {
          ...process.env,
          ...(adapterDir ? { TAOD_ADAPTER_DIR: adapterDir } : {}),
        },
        cwd: dirname(binaryPath),
      })
      this.spawnedProcess = child
      this.lifecycleDaemonOwnership = this.currentDaemonOwnership()
      if (!this.detachDaemon) {
        child.stderr?.on('data', (chunk: Buffer) => {
          console.warn('[taod stderr]', chunk.toString('utf8').trimEnd())
        })
      }
      this.transitionLifecycle('starting', `spawned:${child.pid ?? 'unknown'}`)
      child.once('exit', (code, signal) => {
        if (this.spawnedProcess === child) this.spawnedProcess = null
        if (this.lifecycleDaemonOwnership !== 'released-detached') {
          this.lifecycleDaemonOwnership = 'none'
        }
        if (!this.disposed) {
          this.transitionLifecycle('crashed', `process-exit:${code ?? 'null'}:${signal ?? 'null'}`)
          this.scheduleRestart(`taod exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`)
        }
      })
      child.once('error', (error) => {
        if (this.spawnedProcess === child) this.spawnedProcess = null
        if (this.lifecycleDaemonOwnership !== 'released-detached') {
          this.lifecycleDaemonOwnership = 'none'
        }
        if (!this.disposed) {
          this.transitionLifecycle('crashed', 'process-error', error)
          this.scheduleRestart(`taod process error: ${error.message}`)
        }
      })
      if (this.detachDaemon) child.unref()
    }

    const deadline = Date.now() + this.startTimeoutMs
    let lastError: unknown = null
    while (Date.now() < deadline) {
      if (this.disposed) throw new Error('taod client is disposed')
      try {
        if (await this.canConnect()) {
          if (this.disposed) throw new Error('taod client is disposed')
          this.lastStartDurationMs = Date.now() - startRequestedAt
          return
        }
      } catch (error) {
        lastError = error
      }
      await delay(75)
    }

    this.lastStartDurationMs = Date.now() - startRequestedAt
    this.lifecycleDaemonOwnership =
      this.spawnedProcess && !hasExited(this.spawnedProcess)
        ? this.currentDaemonOwnership()
        : 'none'
    this.transitionLifecycle('stale-socket', 'start-timeout', lastError)
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
    try {
      if (await this.canConnect()) return
    } catch (error) {
      if (isTaodCompatibilityError(error)) {
        console.warn('[taod-client] taod compatibility check failed:', error)
        return
      }
      throw error
    }
    this.scheduleRestart('taod health check failed')
  }

  private scheduleRestart(reason: string): void {
    if (this.disposed || this.restartTimer) return

    this.transitionLifecycle('crashed', reason)
    console.warn(`[taod-client] ${reason}; scheduling restart`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      const recovery =
        this.spawnedProcess && !hasExited(this.spawnedProcess)
          ? this.restartOwnedDaemon('scheduled-restart-owned')
          : this.ensureRunning()
      void recovery.catch((error) => {
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

    const tracedRequest = this.withTrace(request)
    const startedAt = Date.now()
    const socket = await connectUnixSocket(this.socketPath, this.connectTimeoutMs)
    try {
      await writeSocketPayload(
        socket,
        `${JSON.stringify(tracedRequest)}\n`,
        this.controlResponseTimeoutMs,
        'control request',
      )
      const { response } = await readNdjsonResponse(socket, this.controlResponseTimeoutMs)
      this.recordControlRequest(
        tracedRequest,
        startedAt,
        response.ok,
        responseTraceId(response),
        response.ok ? undefined : responseError(response),
      )
      return response
    } catch (error) {
      this.recordControlRequest(tracedRequest, startedAt, false, undefined, error)
      throw error
    } finally {
      socket.end()
      socket.destroy()
    }
  }

  private withTrace(request: TaodRequest): TaodRequest {
    return { ...request, traceId: requestTraceId(this.clientTraceId, request) }
  }
}
