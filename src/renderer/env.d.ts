/**
 * Type declarations for the renderer process.
 * These types describe the API exposed by the preload script via contextBridge.
 */

export interface ElectronAPI {
  sendPtyInput(data: string): void
  resizePty(cols: number, rows: number): void
  getInitialColsRows(): Promise<{ cols: number; rows: number }>
  onPtyData(callback: (data: string) => void): () => void
  onPtyError(callback: (error: string) => void): () => void
  onPtyExit(
    callback: (info: { exitCode: number; signal?: number }) => void,
  ): () => void
  signalReady(): void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
