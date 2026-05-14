import { Schema } from 'effect'
import { contextBridge, ipcRenderer } from 'electron'
import type { PtyClientMessage, PtyExitInfo, PtySize } from '../main/pty-protocol'
import { type PtyServiceMessage, PtyServiceMessageSchema } from '../main/pty-protocol'
import type { WorktreeInfo } from '../shared/workspace'

type PtyDataCallback = (data: string) => void
type PtyErrorCallback = (error: string) => void
type PtyExitCallback = (info: PtyExitInfo) => void
type AppShortcutCallback = () => void
type AppCommand = 'new-tab' | 'close-tab' | 'split-pane-vertical' | 'split-pane-horizontal'

const INITIAL_SIZE_TIMEOUT_MS = 5000

let ptyPort: MessagePort | null = null
let readySize: PtySize | null = null
let readyResolve: ((size: PtySize) => void) | null = null
let readyReject: ((err: Error) => void) | null = null
let readyTimeout: ReturnType<typeof setTimeout> | null = null
let pendingClientMessages: PtyClientMessage[] = []
let pendingData: string[] = []
let ptyDataCallbacks: PtyDataCallback[] = []
let ptyErrorCallbacks: PtyErrorCallback[] = []
let ptyExitCallbacks: PtyExitCallback[] = []

const readyPromise = new Promise<PtySize>((resolve, reject) => {
  readyResolve = resolve
  readyReject = reject
  readyTimeout = setTimeout(() => {
    rejectReady(new Error('Timed out waiting for PTY service to become ready'))
  }, INITIAL_SIZE_TIMEOUT_MS)
})

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

function rejectReady(error: Error) {
  clearReadyTimeout()
  readyReject?.(error)
  readyResolve = null
  readyReject = null
}

function clearReadyTimeout() {
  if (readyTimeout === null) return
  clearTimeout(readyTimeout)
  readyTimeout = null
}

function flushPendingData() {
  if (pendingData.length === 0 || ptyDataCallbacks.length === 0) return

  const data = pendingData.length === 1 ? pendingData[0] : pendingData.join('')
  pendingData = []
  for (const callback of ptyDataCallbacks) {
    callback(data)
  }
}

function handlePtyData(data: string) {
  if (ptyDataCallbacks.length === 0) {
    pendingData.push(data)
    return
  }

  for (const callback of ptyDataCallbacks) {
    callback(data)
  }
}

function handlePtyMessage(message: PtyServiceMessage) {
  switch (message.type) {
    case 'ready':
      readySize = message.size
      readyResolve?.(message.size)
      clearReadyTimeout()
      readyResolve = null
      readyReject = null
      break
    case 'data':
      handlePtyData(message.data)
      break
    case 'error':
      rejectReady(new Error(message.error))
      for (const callback of ptyErrorCallbacks) {
        callback(message.error)
      }
      break
    case 'exit':
      if (!readySize) {
        rejectReady(
          new Error(
            `PTY exited before ready (exitCode=${message.info.exitCode}, signal=${
              message.info.signal ?? 'none'
            })`,
          ),
        )
      }
      for (const callback of ptyExitCallbacks) {
        callback(message.info)
      }
      break
  }
}

function isPtyServiceMessage(message: unknown): message is PtyServiceMessage {
  return Schema.decodeUnknownEither(PtyServiceMessageSchema)(message)._tag === 'Right'
}

ipcRenderer.on('pty:port', (event) => {
  const [port] = event.ports
  if (!port) return

  ptyPort = port
  ptyPort.onmessage = (messageEvent) => {
    if (!isPtyServiceMessage(messageEvent.data)) return
    handlePtyMessage(messageEvent.data)
  }
  ptyPort.start()
  flushPendingClientMessages()
})

ipcRenderer.on('pty:service-error', (_event, error: string) => {
  rejectReady(new Error(error))
  for (const callback of ptyErrorCallbacks) {
    callback(error)
  }
})

ipcRenderer.send('pty:requestPort')

/**
 * The API exposed to the renderer process via contextBridge.
 * This is a minimal, typed surface — the renderer can only call
 * these specific methods, nothing else.
 */
const electronAPI = {
  /**
   * Send keystroke data to the PTY (shell input)
   */
  sendPtyInput(data: string): void {
    if (typeof data !== 'string' || data.length === 0) return
    queuePtyMessage({ type: 'write', data })
  },

  /**
   * Resize the PTY when the terminal dimensions change
   */
  resizePty(cols: number, rows: number): void {
    if (typeof cols !== 'number' || typeof rows !== 'number') return
    queuePtyMessage({ type: 'resize', cols, rows })
  },

  /**
   * Get the initial PTY dimensions (needed for ghostty-web init)
   */
  getInitialColsRows(): Promise<{ cols: number; rows: number }> {
    return readySize ? Promise.resolve(readySize) : readyPromise
  },

  /**
   * Register a callback for PTY output data
   */
  onPtyData(callback: (data: string) => void): () => void {
    ptyDataCallbacks.push(callback)
    flushPendingData()
    return () => {
      ptyDataCallbacks = ptyDataCallbacks.filter((registeredCallback) => {
        return registeredCallback !== callback
      })
    }
  },

  /**
   * Register a callback for PTY errors
   */
  onPtyError(callback: (error: string) => void): () => void {
    ptyErrorCallbacks.push(callback)
    return () => {
      ptyErrorCallbacks = ptyErrorCallbacks.filter((registeredCallback) => {
        return registeredCallback !== callback
      })
    }
  },

  /**
   * Register a callback for PTY exit
   */
  onPtyExit(callback: (info: { exitCode: number; signal?: number }) => void): () => void {
    ptyExitCallbacks.push(callback)
    return () => {
      ptyExitCallbacks = ptyExitCallbacks.filter((registeredCallback) => {
        return registeredCallback !== callback
      })
    }
  },

  /**
   * Signal the main process that the renderer is ready (terminal loaded).
   * This triggers the window to be shown for an instant-open feel.
   */
  signalReady(): void {
    queuePtyMessage({ type: 'renderer-ready' })
    ipcRenderer.send('renderer:ready')
  },

  /**
   * Register a callback for app-owned shortcuts handled before terminal input.
   */
  onToggleSidebar(callback: AppShortcutCallback): () => void {
    const listener = () => {
      callback()
    }
    ipcRenderer.on('app:toggle-sidebar', listener)
    return () => {
      ipcRenderer.removeListener('app:toggle-sidebar', listener)
    }
  },

  /**
   * Register a callback for a tab/pane command handled before terminal input.
   */
  onAppCommand(command: AppCommand, callback: AppShortcutCallback): () => void {
    const channel = `app:${command}`
    const listener = () => {
      callback()
    }
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  },

  pickWorkspaceDirectory(): Promise<string | null> {
    return ipcRenderer.invoke('workspace:pickDirectory')
  },

  getGitBranch(workspacePath: string): Promise<string | null> {
    if (typeof workspacePath !== 'string' || workspacePath.length === 0)
      return Promise.resolve(null)
    return ipcRenderer.invoke('workspace:getGitBranch', workspacePath)
  },

  getGitWorktrees(workspacePath: string): Promise<WorktreeInfo[]> {
    if (typeof workspacePath !== 'string' || workspacePath.length === 0) return Promise.resolve([])
    return ipcRenderer.invoke('workspace:getGitWorktrees', workspacePath)
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

// Type declaration for the renderer
export type ElectronAPI = typeof electronAPI
