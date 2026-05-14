/**
 * Type declarations for the renderer process.
 * These types describe the API exposed by the preload script via contextBridge.
 */

import type { WorktreeInfo } from '../shared/workspace'

type AppCommand = 'new-tab' | 'close-tab' | 'split-pane-vertical' | 'split-pane-horizontal'

export interface ElectronAPI {
  sendPtyInput(data: string): void
  resizePty(cols: number, rows: number): void
  getInitialColsRows(): Promise<{ cols: number; rows: number }>
  onPtyData(callback: (data: string) => void): () => void
  onPtyError(callback: (error: string) => void): () => void
  onPtyExit(callback: (info: { exitCode: number; signal?: number }) => void): () => void
  signalReady(): void
  onToggleSidebar(callback: () => void): () => void
  onAppCommand(command: AppCommand, callback: () => void): () => void
  pickWorkspaceDirectory(): Promise<string | null>
  getGitBranch(workspacePath: string): Promise<string | null>
  getGitWorktrees(workspacePath: string): Promise<WorktreeInfo[]>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
