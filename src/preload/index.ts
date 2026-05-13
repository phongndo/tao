import { contextBridge, ipcRenderer } from 'electron'

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
    ipcRenderer.send('pty:write', data)
  },

  /**
   * Resize the PTY when the terminal dimensions change
   */
  resizePty(cols: number, rows: number): void {
    ipcRenderer.send('pty:resize', cols, rows)
  },

  /**
   * Get the initial PTY dimensions (needed for ghostty-web init)
   */
  getInitialColsRows(): Promise<{ cols: number; rows: number }> {
    return ipcRenderer.invoke('pty:getInitialColsRows')
  },

  /**
   * Register a callback for PTY output data
   */
  onPtyData(callback: (data: string) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, data: string) => {
      callback(data)
    }
    ipcRenderer.on('pty:data', listener)
    return () => {
      ipcRenderer.removeListener('pty:data', listener)
    }
  },

  /**
   * Register a callback for PTY errors
   */
  onPtyError(callback: (error: string) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, error: string) => {
      callback(error)
    }
    ipcRenderer.on('pty:error', listener)
    return () => {
      ipcRenderer.removeListener('pty:error', listener)
    }
  },

  /**
   * Register a callback for PTY exit
   */
  onPtyExit(
    callback: (info: { exitCode: number; signal?: number }) => void,
  ): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      info: { exitCode: number; signal?: number },
    ) => {
      callback(info)
    }
    ipcRenderer.on('pty:exit', listener)
    return () => {
      ipcRenderer.removeListener('pty:exit', listener)
    }
  },

  /**
   * Signal the main process that the renderer is ready (terminal loaded).
   * This triggers the window to be shown for an instant-open feel.
   */
  signalReady(): void {
    ipcRenderer.send('renderer:ready')
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

// Type declaration for the renderer
export type ElectronAPI = typeof electronAPI
