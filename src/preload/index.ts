import { Schema, type Effect } from 'effect'
import { contextBridge, ipcRenderer } from 'electron'
import type { PtyClientMessage, PtyExitInfo, PtySize } from '../main/pty-protocol'
import { type PtyServiceMessage, PtyServiceMessageSchema } from '../main/pty-protocol'
import type { AppCommand } from '../shared/app-command'
import {
  workspaceIpcFailure,
  type WorkspaceGitBranchResponse,
  type WorkspaceGitStatusResponse,
  type WorkspaceGitWorktreesResponse,
  type WorkspacePortsResponse,
  type WorkspacePullRequestResponse,
} from '../shared/workspace'
import { PreloadWorkspaceIpc, runPreloadEffect } from './runtime'

type PtyDataCallback = (data: string) => void
type PtyErrorCallback = (error: string) => void
type PtyExitCallback = (info: PtyExitInfo) => void
type AppCommandCallback = (command: AppCommand) => void
type WorkspaceIpcProgram<T> = (
  workspaceIpc: typeof PreloadWorkspaceIpc.Service,
) => Effect.Effect<T, unknown>

type PendingDataState = {
  chunks: string[]
  bufferedChars: number
}

type ReadyState = {
  size: PtySize | null
  promise: Promise<PtySize>
  resolve: ((size: PtySize) => void) | null
  reject: ((err: Error) => void) | null
  timeout: ReturnType<typeof setTimeout> | null
}

const INITIAL_SIZE_TIMEOUT_MS = 5000
const MAX_PENDING_DATA_CHARS = 1024 * 1024

let ptyPort: MessagePort | null = null
let rendererReadySignaled = false
let pendingClientMessages: PtyClientMessage[] = []
const readyStates = new Map<string, ReadyState>()
const pendingData = new Map<string, PendingDataState>()
const ptyDataCallbacks = new Map<string, PtyDataCallback[]>()
const ptyErrorCallbacks = new Map<string, PtyErrorCallback[]>()
const ptyExitCallbacks = new Map<string, PtyExitCallback[]>()

function createReadyState(sessionId: string): ReadyState {
  let resolveReady: ((size: PtySize) => void) | null = null
  let rejectReady: ((err: Error) => void) | null = null
  const state: ReadyState = {
    size: null,
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

function getReadyState(sessionId: string): ReadyState {
  const existingState = readyStates.get(sessionId)
  if (existingState) return existingState

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

function resolvePtyReady(sessionId: string, size: PtySize) {
  const state = readyStates.get(sessionId)
  if (!state) return
  state.size = size
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
  ptyDataCallbacks.delete(sessionId)
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

function handlePtyMessage(message: PtyServiceMessage) {
  switch (message.type) {
    case 'ready':
      resolvePtyReady(message.sessionId, message.size)
      break
    case 'data':
      handlePtyData(message.sessionId, message.data)
      break
    case 'error':
      rejectPtyReady(message.sessionId, new Error(message.error))
      for (const callback of ptyErrorCallbacks.get(message.sessionId) ?? []) {
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
      clearSessionState(message.sessionId)
      break
    }
  }
}

function decodePtyServiceMessage(message: unknown): PtyServiceMessage | null {
  const decoded = Schema.decodeUnknownOption(PtyServiceMessageSchema)(message)
  return decoded._tag === 'Some' ? decoded.value : null
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

ipcRenderer.on('pty:service-error', (_event, error: string) => {
  const sessionIds = new Set([
    ...readyStates.keys(),
    ...pendingData.keys(),
    ...ptyDataCallbacks.keys(),
    ...ptyErrorCallbacks.keys(),
    ...ptyExitCallbacks.keys(),
  ])

  for (const sessionId of sessionIds) {
    rejectPtyReady(sessionId, new Error(error))
    for (const callback of ptyErrorCallbacks.get(sessionId) ?? []) {
      callback(error)
    }
    clearSessionState(sessionId)
  }
})

ipcRenderer.send('pty:requestPort')

/**
 * The API exposed to the renderer process via contextBridge.
 * This is a minimal, typed surface — the renderer can only call
 * these specific methods, nothing else.
 */
const electronAPI = {
  spawnPty(sessionId: string, cols: number, rows: number, cwd?: string): Promise<PtySize> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return Promise.reject(new Error('PTY sessionId is required'))
    }
    if (typeof cols !== 'number' || typeof rows !== 'number') {
      return Promise.reject(new Error('PTY size must be numeric'))
    }

    const state = getReadyState(sessionId)
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
    if (typeof cols !== 'number' || typeof rows !== 'number') return
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
  signalReady(): void {
    queuePtyMessage({ type: 'renderer-ready' })
    if (rendererReadySignaled) return
    rendererReadySignaled = true
    ipcRenderer.send('renderer:ready')
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

  pickWorkspaceDirectory(): Promise<string | null> {
    return ipcRenderer.invoke('workspace:pickDirectory')
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
}

function runWorkspaceIpc<T>(program: WorkspaceIpcProgram<T>): Promise<T> {
  return runPreloadEffect(PreloadWorkspaceIpc.use(program)).catch(
    (error) => workspaceIpcFailure(error, 'ipc-failed') as T,
  )
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

// Type declaration for the renderer
export type ElectronAPI = typeof electronAPI
