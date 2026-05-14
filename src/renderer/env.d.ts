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
  onPtyExit(callback: (info: { exitCode: number; signal?: number }) => void): () => void
  signalReady(): void
  onToggleSidebar(callback: () => void): () => void
  pickWorkspaceDirectory(): Promise<string | null>
  getGitBranch(workspacePath: string): Promise<string | null>
  getGitWorktrees(workspacePath: string): Promise<WorktreeInfo[]>
}

interface WorktreeInfo {
  path: string
  branch: string
  hash: string
  isBare: boolean
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
