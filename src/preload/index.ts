import { contextBridge, ipcRenderer } from 'electron'
import type {
  PtyClientMessage,
  PtyExitInfo,
  PtyServiceMessage,
  PtySize,
} from '../main/pty-protocol'

type PtyDataCallback = (data: string) => void
type PtyErrorCallback = (error: string) => void
type PtyExitCallback = (info: PtyExitInfo) => void

let ptyPort: MessagePort | null = null
let readySize: PtySize | null = null
let readyResolve: ((size: PtySize) => void) | null = null
let readyReject: ((err: Error) => void) | null = null
let pendingData: string[] = []
let ptyDataCallbacks: PtyDataCallback[] = []
let ptyErrorCallbacks: PtyErrorCallback[] = []
let ptyExitCallbacks: PtyExitCallback[] = []

const readyPromise = new Promise<PtySize>((resolve, reject) => {
  readyResolve = resolve
  readyReject = reject
})

function postToPty(message: PtyClientMessage) {
  ptyPort?.postMessage(message)
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
      break
    case 'data':
      handlePtyData(message.data)
      break
    case 'error':
      readyReject?.(new Error(message.error))
      for (const callback of ptyErrorCallbacks) {
        callback(message.error)
      }
      break
    case 'exit':
      for (const callback of ptyExitCallbacks) {
        callback(message.info)
      }
      break
  }
}

function isPtyServiceMessage(message: unknown): message is PtyServiceMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    typeof (message as { type: unknown }).type === 'string'
  )
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
    postToPty({ type: 'write', data })
  },

  /**
   * Resize the PTY when the terminal dimensions change
   */
  resizePty(cols: number, rows: number): void {
    if (typeof cols !== 'number' || typeof rows !== 'number') return
    postToPty({ type: 'resize', cols, rows })
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
    postToPty({ type: 'renderer-ready' })
    ipcRenderer.send('renderer:ready')
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

// Type declaration for the renderer
export type ElectronAPI = typeof electronAPI
