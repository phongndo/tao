/**
 * Type declarations for the renderer process.
 * These types describe the API exposed by the preload script via contextBridge.
 */

import type { AppCommand } from '@tao/shared/app-command'
import type {
  WorkspaceGitBranchResponse,
  WorkspaceGitStatusResponse,
  WorkspaceGitWorktreesResponse,
  WorkspacePortsResponse,
  WorkspacePullRequestResponse,
} from '@tao/shared/workspace'

export interface ElectronAPI {
  spawnPty(
    sessionId: string,
    cols: number,
    rows: number,
    cwd?: string,
  ): Promise<{ cols: number; rows: number }>
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
  onAppCommand(callback: (command: AppCommand) => void): () => void
  pickWorkspaceDirectory(): Promise<string | null>
  getGitBranch(workspacePath: string): Promise<WorkspaceGitBranchResponse>
  getGitWorktrees(workspacePath: string): Promise<WorkspaceGitWorktreesResponse>
  getGitStatus(workspacePath: string): Promise<WorkspaceGitStatusResponse>
  getWorkspacePorts(workspacePath: string): Promise<WorkspacePortsResponse>
  getPullRequestInfo(workspacePath: string): Promise<WorkspacePullRequestResponse>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
