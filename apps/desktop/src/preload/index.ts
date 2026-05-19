import { Effect, Schema } from 'effect'
import { clipboard, contextBridge, ipcRenderer, shell } from 'electron'
import type { PtyClientMessage, PtyExitInfo, PtySize } from '../main/pty-protocol'
import { type PtyServiceMessage, PtyServiceMessageSchema } from '../main/pty-protocol'
import type { AppCommand } from '@tao/shared/app-command'
import type { PaneLayoutData, SettingsData } from '@tao/shared/session'
import type {
  AttachSessionInput,
  AttachSessionMode,
  AttachSessionResult,
  AgentStatus,
  CreateSessionInput,
  CreateSessionResult,
  CurrentScreenSnapshotFrame,
  ExitInfo,
  OutputFrame,
} from '@tao/shared/taod-protocol'
import {
  WorkspaceError,
  WorkspacePickDirectoryResponseSchema,
  WorkspaceRecordSchema,
  decodeWorkspaceIpcResponse,
  workspaceIpcFailure,
  workspaceErrorFromUnknown,
  type WorkspaceGitBranchResponse,
  type WorkspaceGitStatusResponse,
  type WorkspaceGitWorktreesResponse,
  type WorkspaceIpcResponse,
  type WorkspaceListResponse,
  type WorkspacePortsResponse,
  type WorkspacePullRequestResponse,
  type WorkspaceRecord,
  type WorkspaceRecordResponse,
  type WorkspaceWorktreeResponse,
} from '@tao/shared/workspace'
import { PreloadWorkspaceIpc, runPreloadEffect } from './runtime'

type PtyDataCallback = (data: string) => void
type SessionOutputCallback = (frame: OutputFrame) => void
type SessionSnapshotCallback = (frame: CurrentScreenSnapshotFrame) => void
type SessionResizeCallback = (cols: number, rows: number) => void
type SessionExitCallback = (info: ExitInfo) => void
type SessionErrorCallback = (error: string) => void
type AgentStatusCallback = (status: AgentStatus) => void
type PtyErrorCallback = (error: string) => void
type PtyExitCallback = (info: PtyExitInfo) => void
type AppCommandCallback = (command: AppCommand) => void
type WorkspaceChangedCallback = (workspace: WorkspaceRecord) => void
type WorkspaceIpcProgram<T> = (
  workspaceIpc: typeof PreloadWorkspaceIpc.Service,
) => Effect.Effect<T, WorkspaceError>

type PendingDataState = {
  chunks: string[]
  bufferedChars: number
}

type PendingOutputState = {
  frames: OutputFrame[]
  bufferedChars: number
}

type ReadyState = {
  size: PtySize | null
  seq: number
  archived: boolean
  attachMode: AttachSessionMode
  agentProvider?: string
  nativeSessionId?: string | null
  promise: Promise<PtySize>
  resolve: ((size: PtySize) => void) | null
  reject: ((err: Error) => void) | null
  timeout: ReturnType<typeof setTimeout> | null
}

const INITIAL_SIZE_TIMEOUT_MS = 5000
const MAX_PENDING_DATA_CHARS = 1024 * 1024
const MAX_PENDING_OUTPUT_CHARS = 1024 * 1024

let ptyPort: MessagePort | null = null
let rendererReadySignaled = false
let rendererShown = false
let pendingClientMessages: PtyClientMessage[] = []
const rendererShownWaiters: Array<() => void> = []
const readyStates = new Map<string, ReadyState>()
const pendingData = new Map<string, PendingDataState>()
const pendingSessionOutput = new Map<string, PendingOutputState>()
const pendingSnapshots = new Map<string, CurrentScreenSnapshotFrame>()
const pendingAgentStatuses = new Map<string, AgentStatus>()
const ptyDataCallbacks = new Map<string, PtyDataCallback[]>()
const sessionOutputCallbacks = new Map<string, SessionOutputCallback[]>()
const sessionSnapshotCallbacks = new Map<string, SessionSnapshotCallback[]>()
const sessionResizeCallbacks = new Map<string, SessionResizeCallback[]>()
const sessionExitCallbacks = new Map<string, SessionExitCallback[]>()
const sessionErrorCallbacks = new Map<string, SessionErrorCallback[]>()
const agentStatusCallbacks = new Map<string, AgentStatusCallback[]>()
const ptyErrorCallbacks = new Map<string, PtyErrorCallback[]>()
const ptyExitCallbacks = new Map<string, PtyExitCallback[]>()

function isValidTerminalSize(cols: unknown, rows: unknown): cols is number {
  return (
    typeof cols === 'number' &&
    typeof rows === 'number' &&
    Number.isFinite(cols) &&
    Number.isFinite(rows) &&
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols > 0 &&
    rows > 0
  )
}

function createReadyState(sessionId: string): ReadyState {
  let resolveReady: ((size: PtySize) => void) | null = null
  let rejectReady: ((err: Error) => void) | null = null
  const state: ReadyState = {
    size: null,
    seq: 0,
    archived: false,
    attachMode: 'live',
    promise: new Promise<PtySize>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    }),
    resolve: null,
    reject: null,
    timeout: null,
  }

  state.resolve = resolveReady
  state.reject = rejectReady
  state.timeout = setTimeout(() => {
    rejectPtyReady(sessionId, new Error(`Timed out waiting for PTY ${sessionId} to become ready`))
  }, INITIAL_SIZE_TIMEOUT_MS)

  return state
}

function beginReadyState(sessionId: string): ReadyState {
  const existingState = readyStates.get(sessionId)
  if (existingState?.resolve || existingState?.reject) return existingState

  if (existingState) clearReadyTimeout(existingState)
  const state = createReadyState(sessionId)
  readyStates.set(sessionId, state)
  return state
}

function clearReadyTimeout(state: ReadyState) {
  if (state.timeout === null) return
  clearTimeout(state.timeout)
  state.timeout = null
}

function rejectPtyReady(sessionId: string, error: Error) {
  const state = readyStates.get(sessionId)
  if (!state) return
  clearReadyTimeout(state)
  state.reject?.(error)
  state.resolve = null
  state.reject = null
}

function resolvePtyReady(
  sessionId: string,
  size: PtySize,
  seq = 0,
  archived = false,
  attachMode: AttachSessionMode = 'live',
  agentProvider?: string,
  nativeSessionId?: string | null,
) {
  const state = readyStates.get(sessionId)
  if (!state) return
  state.size = size
  state.seq = seq
  state.archived = archived
  state.attachMode = attachMode
  state.agentProvider = agentProvider
  state.nativeSessionId = nativeSessionId
  clearReadyTimeout(state)
  state.resolve?.(size)
  state.resolve = null
  state.reject = null
}

function postToPty(message: PtyClientMessage): boolean {
  if (!ptyPort) return false
  ptyPort.postMessage(message)
  return true
}

function queuePtyMessage(message: PtyClientMessage) {
  pendingClientMessages.push(message)
  flushPendingClientMessages()
}

function flushPendingClientMessages() {
  if (!ptyPort || pendingClientMessages.length === 0) return

  const messages = pendingClientMessages
  pendingClientMessages = []
  for (const message of messages) {
    postToPty(message)
  }
}

function callbacksFor<T>(callbacksBySession: Map<string, T[]>, sessionId: string): T[] {
  const callbacks = callbacksBySession.get(sessionId)
  if (callbacks) return callbacks

  const nextCallbacks: T[] = []
  callbacksBySession.set(sessionId, nextCallbacks)
  return nextCallbacks
}

function pendingDataFor(sessionId: string): PendingDataState {
  const existingState = pendingData.get(sessionId)
  if (existingState) return existingState

  const state: PendingDataState = { chunks: [], bufferedChars: 0 }
  pendingData.set(sessionId, state)
  return state
}

function pendingOutputFor(sessionId: string): PendingOutputState {
  const existingState = pendingSessionOutput.get(sessionId)
  if (existingState) return existingState

  const state: PendingOutputState = { frames: [], bufferedChars: 0 }
  pendingSessionOutput.set(sessionId, state)
  return state
}

function removeCallback<T>(callbacksBySession: Map<string, T[]>, sessionId: string, callback: T) {
  const currentCallbacks = callbacksBySession.get(sessionId)
  if (!currentCallbacks) return

  const nextCallbacks = currentCallbacks.filter((registeredCallback) => {
    return registeredCallback !== callback
  })
  if (nextCallbacks.length === 0) {
    callbacksBySession.delete(sessionId)
    return
  }

  callbacksBySession.set(sessionId, nextCallbacks)
}

function clearSessionState(sessionId: string) {
  const state = readyStates.get(sessionId)
  if (state) {
    clearReadyTimeout(state)
  }
  readyStates.delete(sessionId)
  pendingData.delete(sessionId)
  pendingSessionOutput.delete(sessionId)
  pendingSnapshots.delete(sessionId)
  pendingAgentStatuses.delete(sessionId)
  ptyDataCallbacks.delete(sessionId)
  sessionOutputCallbacks.delete(sessionId)
  sessionSnapshotCallbacks.delete(sessionId)
  sessionResizeCallbacks.delete(sessionId)
  sessionExitCallbacks.delete(sessionId)
  sessionErrorCallbacks.delete(sessionId)
  agentStatusCallbacks.delete(sessionId)
  ptyErrorCallbacks.delete(sessionId)
  ptyExitCallbacks.delete(sessionId)
}

function rejectAndClearSessionState(sessionId: string, error: Error) {
  rejectPtyReady(sessionId, error)
  clearSessionState(sessionId)
}

function flushPendingData(sessionId: string) {
  const pending = pendingData.get(sessionId)
  const callbacks = ptyDataCallbacks.get(sessionId)
  if (!pending || pending.chunks.length === 0 || !callbacks || callbacks.length === 0) return

  const data = pending.chunks.length === 1 ? pending.chunks[0] : pending.chunks.join('')
  pending.chunks = []
  pending.bufferedChars = 0
  for (const callback of callbacks) {
    callback(data)
  }
}

function flushPendingSessionOutput(sessionId: string) {
  const pending = pendingSessionOutput.get(sessionId)
  const callbacks = sessionOutputCallbacks.get(sessionId)
  if (!pending || pending.frames.length === 0 || !callbacks || callbacks.length === 0) return

  const frames = pending.frames
  pending.frames = []
  pending.bufferedChars = 0
  for (const frame of frames) {
    for (const callback of callbacks) callback(frame)
  }
}

function handlePtyData(sessionId: string, data: string) {
  const callbacks = ptyDataCallbacks.get(sessionId)
  if (!callbacks || callbacks.length === 0) {
    const pending = pendingDataFor(sessionId)
    pending.chunks.push(data)
    pending.bufferedChars += data.length
    while (pending.bufferedChars > MAX_PENDING_DATA_CHARS && pending.chunks.length > 1) {
      pending.bufferedChars -= pending.chunks.shift()?.length ?? 0
    }
    if (pending.bufferedChars > MAX_PENDING_DATA_CHARS && pending.chunks.length === 1) {
      pending.chunks[0] = pending.chunks[0].slice(-MAX_PENDING_DATA_CHARS)
      pending.bufferedChars = pending.chunks[0].length
    }
    return
  }

  for (const callback of callbacks) {
    callback(data)
  }
}

function handleSessionOutput(frame: OutputFrame) {
  const callbacks = sessionOutputCallbacks.get(frame.sessionId)
  if (!callbacks || callbacks.length === 0) {
    const pending = pendingOutputFor(frame.sessionId)
    pending.frames.push(frame)
    pending.bufferedChars += frame.data.length
    while (pending.bufferedChars > MAX_PENDING_OUTPUT_CHARS && pending.frames.length > 1) {
      pending.bufferedChars -= pending.frames.shift()?.data.length ?? 0
    }
    if (pending.bufferedChars > MAX_PENDING_OUTPUT_CHARS && pending.frames.length === 1) {
      const onlyFrame = pending.frames[0]!
      pending.frames[0] = {
        ...onlyFrame,
        data: onlyFrame.data.slice(-MAX_PENDING_OUTPUT_CHARS),
      }
      pending.bufferedChars = pending.frames[0]!.data.length
    }
    return
  }

  for (const callback of callbacks) {
    callback(frame)
  }
}

function handleSessionSnapshot(frame: CurrentScreenSnapshotFrame) {
  const callbacks = sessionSnapshotCallbacks.get(frame.sessionId)
  if (!callbacks || callbacks.length === 0) {
    pendingSnapshots.set(frame.sessionId, frame)
    return
  }

  for (const callback of callbacks) {
    callback(frame)
  }
}

function handleAgentStatus(sessionId: string, status: AgentStatus) {
  const callbacks = agentStatusCallbacks.get(sessionId)
  if (!callbacks || callbacks.length === 0) {
    pendingAgentStatuses.set(sessionId, status)
    return
  }

  for (const callback of callbacks) {
    callback(status)
  }
}

function handlePtyMessage(message: PtyServiceMessage) {
  switch (message.type) {
    case 'ready':
      resolvePtyReady(
        message.sessionId,
        message.size,
        message.seq ?? 0,
        message.archived ?? false,
        message.attachMode ?? 'live',
        message.agentProvider,
        message.nativeSessionId,
      )
      if (message.agentProvider) {
        handleAgentStatus(message.sessionId, {
          provider: message.agentProvider,
          status: message.attachMode === 'agent-resume' ? 'resumed' : 'running',
          nativeSessionId: message.nativeSessionId,
        })
      }
      break
    case 'data':
      handleSessionOutput({
        sessionId: message.sessionId,
        seq: message.seq ?? 0,
        data: message.data,
      })
      handlePtyData(message.sessionId, message.data)
      break
    case 'resize':
      for (const callback of sessionResizeCallbacks.get(message.sessionId) ?? []) {
        callback(message.cols, message.rows)
      }
      break
    case 'snapshot':
      handleSessionSnapshot({
        sessionId: message.sessionId,
        seq: message.seq ?? 0,
        dataBase64: message.dataBase64,
        live: message.live ?? true,
      })
      break
    case 'error':
      rejectPtyReady(message.sessionId, new Error(message.error))
      for (const callback of ptyErrorCallbacks.get(message.sessionId) ?? []) {
        callback(message.error)
      }
      for (const callback of sessionErrorCallbacks.get(message.sessionId) ?? []) {
        callback(message.error)
      }
      clearSessionState(message.sessionId)
      break
    case 'exit': {
      const state = readyStates.get(message.sessionId)
      if (!state?.size) {
        rejectPtyReady(
          message.sessionId,
          new Error(
            `PTY ${message.sessionId} exited before ready (exitCode=${
              message.info.exitCode
            }, signal=${message.info.signal ?? 'none'})`,
          ),
        )
      }
      for (const callback of ptyExitCallbacks.get(message.sessionId) ?? []) {
        callback(message.info)
      }
      for (const callback of sessionExitCallbacks.get(message.sessionId) ?? []) {
        callback(message.info)
      }
      clearSessionState(message.sessionId)
      break
    }
    case 'agent':
      handleAgentStatus(message.sessionId, message.status)
      break
  }
}

function decodePtyServiceMessage(message: unknown): PtyServiceMessage | null {
  const decoded = Schema.decodeUnknownOption(PtyServiceMessageSchema)(message)
  return decoded._tag === 'Some' ? decoded.value : null
}

function createSessionId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.()
  if (randomUUID) return `session-${randomUUID}`
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

ipcRenderer.on('pty:port', (event) => {
  const [port] = event.ports
  if (!port) return

  ptyPort = port
  ptyPort.onmessage = (messageEvent) => {
    const message = decodePtyServiceMessage(messageEvent.data)
    if (!message) return
    handlePtyMessage(message)
  }
  ptyPort.start()
  flushPendingClientMessages()
})

ipcRenderer.on('renderer:shown', () => {
  rendererShown = true
  const waiters = rendererShownWaiters.splice(0)
  for (const resolve of waiters) resolve()
})

function waitForRendererShown(): Promise<void> {
  if (rendererShown) return Promise.resolve()

  return new Promise((resolve) => {
    let wrappedResolve: (() => void) | null = null
    const timeout = setTimeout(() => {
      if (wrappedResolve) removeRendererShownWaiter(wrappedResolve)
      resolve()
    }, 500)
    wrappedResolve = () => {
      clearTimeout(timeout)
      resolve()
    }
    rendererShownWaiters.push(wrappedResolve)
  })
}

function removeRendererShownWaiter(resolve: () => void) {
  const index = rendererShownWaiters.indexOf(resolve)
  if (index >= 0) rendererShownWaiters.splice(index, 1)
}

ipcRenderer.send('pty:requestPort')

/**
 * The API exposed to the renderer process via contextBridge.
 * This is a minimal, typed surface — the renderer can only call
 * these specific methods, nothing else.
 */
const electronAPI = {
  async openExternalUrl(url: string): Promise<void> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Unsupported external URL protocol: ${parsed.protocol}`)
    }
    await shell.openExternal(parsed.href)
  },

  writeClipboardText(text: string): Promise<void> {
    clipboard.writeText(text)
    return Promise.resolve()
  },

  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    if (!input || typeof input.terminalId !== 'string' || input.terminalId.length === 0) {
      return Promise.reject(new Error('terminalId is required'))
    }
    if (!isValidTerminalSize(input.cols, input.rows)) {
      return Promise.reject(new Error('Session size must use positive integer cols and rows'))
    }

    const sessionId = createSessionId()
    const state = beginReadyState(sessionId)
    const trimmedCwd = typeof input.cwd === 'string' ? input.cwd.trim() : ''
    queuePtyMessage({
      type: 'spawn',
      sessionId,
      terminalId: input.terminalId,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
      cols: input.cols,
      rows: input.rows,
      ...(trimmedCwd.length > 0 ? { cwd: trimmedCwd } : {}),
      ...(input.argv && input.argv.length > 0 ? { argv: [...input.argv] } : {}),
    })
    await (state.size ? Promise.resolve(state.size) : state.promise)
    return { sessionId }
  },

  async attachSession(
    input: AttachSessionInput & { cols?: number; rows?: number; cwd?: string },
  ): Promise<AttachSessionResult> {
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return Promise.reject(new Error('sessionId is required'))
    }

    const cols = typeof input.cols === 'number' ? input.cols : 80
    const rows = typeof input.rows === 'number' ? input.rows : 24
    if (!isValidTerminalSize(cols, rows)) {
      return Promise.reject(new Error('Session size must use positive integer cols and rows'))
    }
    const state = beginReadyState(sessionId)
    const trimmedCwd = typeof input.cwd === 'string' ? input.cwd.trim() : ''
    const terminalId = typeof input.terminalId === 'string' ? input.terminalId.trim() : ''
    const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId.trim() : ''
    const worktreeId = typeof input.worktreeId === 'string' ? input.worktreeId.trim() : ''
    queuePtyMessage({
      type: 'attach',
      sessionId,
      ...(terminalId.length > 0 ? { terminalId } : {}),
      ...(workspaceId.length > 0 ? { workspaceId } : {}),
      ...(worktreeId.length > 0 ? { worktreeId } : {}),
      cols,
      rows,
      ...(trimmedCwd.length > 0 ? { cwd: trimmedCwd } : {}),
    })
    const size = state.size ?? (await state.promise)
    return {
      sessionId,
      seq: state.seq,
      cols: size.cols,
      rows: size.rows,
      archived: state.archived,
      attachMode: state.attachMode,
      agentProvider: state.agentProvider,
      nativeSessionId: state.nativeSessionId,
    }
  },

  detachSession(sessionId: string): Promise<void> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return Promise.resolve()
    queuePtyMessage({ type: 'detach', sessionId })
    return Promise.resolve()
  },

  writeSessionInput(sessionId: string, data: Uint8Array): void {
    if (!(data instanceof Uint8Array) || data.length === 0) return
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    queuePtyMessage({ type: 'write', sessionId, data })
  },

  resizeSession(sessionId: string, cols: number, rows: number): void {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    if (!isValidTerminalSize(cols, rows)) return
    queuePtyMessage({ type: 'resize', sessionId, cols, rows })
  },

  killSession(sessionId: string): Promise<void> {
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      rejectAndClearSessionState(
        sessionId,
        new Error(`Session ${sessionId} was killed before ready`),
      )
      queuePtyMessage({ type: 'kill', sessionId })
    }
    return Promise.resolve()
  },

  clearSessionHistory(sessionId: string): Promise<void> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return Promise.resolve()
    queuePtyMessage({ type: 'clear-history', sessionIds: [sessionId] })
    return Promise.resolve()
  },

  clearWorkspaceSessionHistory(sessionIds: string[]): Promise<void> {
    if (!Array.isArray(sessionIds)) return Promise.resolve()
    const uniqueSessionIds = Array.from(
      new Set(
        sessionIds.filter((sessionId) => typeof sessionId === 'string' && sessionId.length > 0),
      ),
    )
    if (uniqueSessionIds.length === 0) return Promise.resolve()

    queuePtyMessage({ type: 'clear-history', sessionIds: uniqueSessionIds })
    return Promise.resolve()
  },

  clearAllSessionHistory(): Promise<void> {
    queuePtyMessage({ type: 'clear-history' })
    return Promise.resolve()
  },

  onSessionOutput(sessionId: string, callback: (frame: OutputFrame) => void): () => void {
    const callbacks = callbacksFor(sessionOutputCallbacks, sessionId)
    callbacks.push(callback)
    flushPendingSessionOutput(sessionId)
    return () => removeCallback(sessionOutputCallbacks, sessionId, callback)
  },

  onSessionSnapshot(
    sessionId: string,
    callback: (frame: CurrentScreenSnapshotFrame) => void,
  ): () => void {
    const callbacks = callbacksFor(sessionSnapshotCallbacks, sessionId)
    callbacks.push(callback)
    const pendingSnapshot = pendingSnapshots.get(sessionId)
    if (pendingSnapshot) {
      pendingSnapshots.delete(sessionId)
      callback(pendingSnapshot)
    }
    return () => removeCallback(sessionSnapshotCallbacks, sessionId, callback)
  },

  onSessionResize(sessionId: string, callback: (cols: number, rows: number) => void): () => void {
    const callbacks = callbacksFor(sessionResizeCallbacks, sessionId)
    callbacks.push(callback)
    return () => removeCallback(sessionResizeCallbacks, sessionId, callback)
  },

  onSessionExit(sessionId: string, callback: (info: ExitInfo) => void): () => void {
    const callbacks = callbacksFor(sessionExitCallbacks, sessionId)
    callbacks.push(callback)
    return () => removeCallback(sessionExitCallbacks, sessionId, callback)
  },

  onSessionError(sessionId: string, callback: (error: string) => void): () => void {
    const callbacks = callbacksFor(sessionErrorCallbacks, sessionId)
    callbacks.push(callback)
    return () => removeCallback(sessionErrorCallbacks, sessionId, callback)
  },

  onAgentStatus(sessionId: string, callback: (status: AgentStatus) => void): () => void {
    const callbacks = callbacksFor(agentStatusCallbacks, sessionId)
    callbacks.push(callback)
    const pendingStatus = pendingAgentStatuses.get(sessionId)
    if (pendingStatus) {
      pendingAgentStatuses.delete(sessionId)
      callback(pendingStatus)
    }
    return () => removeCallback(agentStatusCallbacks, sessionId, callback)
  },

  spawnPty(sessionId: string, cols: number, rows: number, cwd?: string): Promise<PtySize> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return Promise.reject(new Error('PTY sessionId is required'))
    }
    if (!isValidTerminalSize(cols, rows)) {
      return Promise.reject(new Error('PTY size must use positive integer cols and rows'))
    }

    const state = beginReadyState(sessionId)
    const trimmedCwd = typeof cwd === 'string' ? cwd.trim() : ''
    queuePtyMessage({
      type: 'spawn',
      sessionId,
      cols,
      rows,
      ...(trimmedCwd.length > 0 ? { cwd: trimmedCwd } : {}),
    })
    return state.size ? Promise.resolve(state.size) : state.promise
  },

  sendPtyInput(sessionId: string, data: string): void {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    if (typeof data !== 'string' || data.length === 0) return
    queuePtyMessage({ type: 'write', sessionId, data })
  },

  resizePty(sessionId: string, cols: number, rows: number): void {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    if (!isValidTerminalSize(cols, rows)) return
    queuePtyMessage({ type: 'resize', sessionId, cols, rows })
  },

  killPty(sessionId: string): void {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    rejectAndClearSessionState(sessionId, new Error(`PTY ${sessionId} was killed before ready`))
    queuePtyMessage({ type: 'kill', sessionId })
  },

  onPtyData(sessionId: string, callback: (data: string) => void): () => void {
    const callbacks = callbacksFor(ptyDataCallbacks, sessionId)
    callbacks.push(callback)
    flushPendingData(sessionId)
    return () => removeCallback(ptyDataCallbacks, sessionId, callback)
  },

  onPtyError(sessionId: string, callback: (error: string) => void): () => void {
    const callbacks = callbacksFor(ptyErrorCallbacks, sessionId)
    callbacks.push(callback)
    return () => removeCallback(ptyErrorCallbacks, sessionId, callback)
  },

  onPtyExit(sessionId: string, callback: (info: PtyExitInfo) => void): () => void {
    const callbacks = callbacksFor(ptyExitCallbacks, sessionId)
    callbacks.push(callback)
    return () => removeCallback(ptyExitCallbacks, sessionId, callback)
  },

  /**
   * Signal the main process that the renderer has mounted.
   * This triggers the window to be shown for an instant-open feel.
   */
  signalReady(): Promise<void> {
    queuePtyMessage({ type: 'renderer-ready' })
    const shown = waitForRendererShown()
    if (!rendererReadySignaled) {
      rendererReadySignaled = true
      ipcRenderer.send('renderer:ready')
    }
    return shown
  },

  /**
   * Register a callback for a tab/pane command handled before terminal input.
   */
  onAppCommand(callback: AppCommandCallback): () => void {
    const listener = (_event: Electron.IpcRendererEvent, command: AppCommand) => {
      callback(command)
    }
    ipcRenderer.on('app:command', listener)
    return () => {
      ipcRenderer.removeListener('app:command', listener)
    }
  },

  onWorkspaceChanged(callback: WorkspaceChangedCallback): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      const decoded = Schema.decodeUnknownOption(WorkspaceRecordSchema)(payload)
      if (decoded._tag === 'Some') {
        callback(decoded.value)
      } else {
        console.debug('[preload] Invalid workspace:changed payload received', payload)
      }
    }
    ipcRenderer.on('workspace:changed', listener)
    return () => {
      ipcRenderer.removeListener('workspace:changed', listener)
    }
  },

  pickWorkspaceDirectory(): Promise<string | null> {
    return pickWorkspaceDirectory()
  },

  getGitBranch(workspacePath: string): Promise<WorkspaceGitBranchResponse> {
    return runWorkspaceIpc((workspaceIpc) => workspaceIpc.getGitBranch(workspacePath))
  },

  getGitWorktrees(workspacePath: string): Promise<WorkspaceGitWorktreesResponse> {
    return runWorkspaceIpc((workspaceIpc) => workspaceIpc.getGitWorktrees(workspacePath))
  },

  getGitStatus(workspacePath: string): Promise<WorkspaceGitStatusResponse> {
    return runWorkspaceIpc((workspaceIpc) => workspaceIpc.getGitStatus(workspacePath))
  },

  getWorkspacePorts(workspacePath: string): Promise<WorkspacePortsResponse> {
    return runWorkspaceIpc((workspaceIpc) => workspaceIpc.getWorkspacePorts(workspacePath))
  },

  getPullRequestInfo(workspacePath: string): Promise<WorkspacePullRequestResponse> {
    return runWorkspaceIpc((workspaceIpc) => workspaceIpc.getPullRequestInfo(workspacePath))
  },

  listWorkspaces(): Promise<WorkspaceListResponse> {
    return invokeWorkspaceDaemon('workspace:list') as Promise<WorkspaceListResponse>
  },

  addWorkspace(input: {
    rootPath: string
    workspaceId?: string
    name?: string
    orderIndex?: number
  }): Promise<WorkspaceRecordResponse> {
    return invokeWorkspaceDaemon('workspace:add', input) as Promise<WorkspaceRecordResponse>
  },

  refreshWorkspace(workspaceId: string): Promise<WorkspaceRecordResponse> {
    return invokeWorkspaceDaemon(
      'workspace:refresh',
      workspaceId,
    ) as Promise<WorkspaceRecordResponse>
  },

  removeWorkspace(workspaceId: string): Promise<WorkspaceIpcResponse<void>> {
    return invokeWorkspaceDaemon('workspace:remove', workspaceId) as Promise<
      WorkspaceIpcResponse<void>
    >
  },

  createWorktree(input: {
    workspaceId: string
    baseBranch?: string
    targetBranch?: string
    branch?: string
    folderName?: string
    startPoint?: string
    title?: string
  }): Promise<WorkspaceWorktreeResponse> {
    return invokeWorkspaceDaemon('worktree:create', input) as Promise<WorkspaceWorktreeResponse>
  },

  refreshWorktree(worktreeId: string): Promise<WorkspaceWorktreeResponse> {
    return invokeWorkspaceDaemon(
      'worktree:refresh',
      worktreeId,
    ) as Promise<WorkspaceWorktreeResponse>
  },

  removeWorktree(input: {
    worktreeId: string
    force?: boolean
    deleteBranch?: boolean
  }): Promise<WorkspaceIpcResponse<void>> {
    return invokeWorkspaceDaemon('worktree:remove', input) as Promise<WorkspaceIpcResponse<void>>
  },

  readLayout(): Promise<PaneLayoutData | null> {
    return ipcRenderer.invoke('layout:read') as Promise<PaneLayoutData | null>
  },

  writeLayout(data: PaneLayoutData): Promise<void> {
    return ipcRenderer.invoke('layout:write', data) as Promise<void>
  },

  readSettings(): Promise<SettingsData | null> {
    return ipcRenderer.invoke('settings:read') as Promise<SettingsData | null>
  },

  writeSettings(data: SettingsData): Promise<void> {
    return ipcRenderer.invoke('settings:write', data) as Promise<void>
  },
}

function runWorkspaceIpc<T>(program: WorkspaceIpcProgram<T>): Promise<T> {
  return runPreloadEffect(PreloadWorkspaceIpc.use(program)).catch(
    (error) => workspaceIpcFailure(error, 'ipc-failed') as T,
  )
}

function invokeWorkspaceDaemon(channel: string, input?: unknown): Promise<unknown> {
  return (ipcRenderer.invoke(channel, input) as Promise<unknown>).catch((error) =>
    workspaceIpcFailure(error, 'ipc-failed'),
  )
}

function pickWorkspaceDirectory(): Promise<string | null> {
  const channel = 'workspace:pickDirectory'
  return Effect.runPromise(
    Effect.tryPromise({
      try: () => ipcRenderer.invoke(channel) as Promise<unknown>,
      catch: (error) => workspaceErrorFromUnknown(error, 'ipc-failed'),
    }).pipe(
      Effect.flatMap((response) =>
        decodeWorkspaceIpcResponse(response, WorkspacePickDirectoryResponseSchema, channel),
      ),
    ),
  ).catch((error) => {
    // Preserve the existing public API: cancellation and selection failure are both null.
    console.warn('[workspace] Failed to pick directory:', error)
    return null
  })
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

// Type declaration for the renderer
export type ElectronAPI = typeof electronAPI
