/**
 * Type declarations for the renderer process.
 * These types describe the API exposed by the preload script via contextBridge.
 */

import type { AppCommand } from '../shared/app-command'
import type { WorktreeInfo } from '../shared/workspace'

export interface ElectronAPI {
  spawnPty(sessionId: string, cols: number, rows: number): Promise<{ cols: number; rows: number }>
  sendPtyInput(sessionId: string, data: string): void
  resizePty(sessionId: string, cols: number, rows: number): void
  killPty(sessionId: string): void
  onPtyData(sessionId: string, callback: (data: string) => void): () => void
  onPtyError(sessionId: string, callback: (error: string) => void): () => void
  onPtyExit(
    sessionId: string,
    callback: (info: { exitCode: number; signal?: number }) => void,
  ): () => void
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
