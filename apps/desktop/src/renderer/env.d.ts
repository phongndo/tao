/**
 * Type declarations for the renderer process.
 * These types describe the API exposed by the preload script via contextBridge.
 */

import type { AppCommand } from '@tao/shared/app-command'
import type { PaneLayoutData, SettingsData } from '@tao/shared/session'
import type {
  AttachSessionInput,
  AttachSessionResult,
  CreateSessionInput,
  CreateSessionResult,
  ExitInfo,
  OutputFrame,
} from '@tao/shared/taod-protocol'
import type {
  WorkspaceGitBranchResponse,
  WorkspaceGitStatusResponse,
  WorkspaceGitWorktreesResponse,
  WorkspacePortsResponse,
  WorkspacePullRequestResponse,
} from '@tao/shared/workspace'

export interface ElectronAPI {
  createSession(input: CreateSessionInput): Promise<CreateSessionResult>
  attachSession(input: AttachSessionInput): Promise<AttachSessionResult>
  detachSession(sessionId: string): Promise<void>
  writeSessionInput(sessionId: string, data: Uint8Array): void
  resizeSession(sessionId: string, cols: number, rows: number): void
  killSession(sessionId: string): Promise<void>
  clearSessionHistory(sessionId: string): Promise<void>
  clearWorkspaceSessionHistory(sessionIds: string[]): Promise<void>
  clearAllSessionHistory(): Promise<void>
  onSessionOutput(sessionId: string, callback: (frame: OutputFrame) => void): () => void
  onSessionResize(sessionId: string, callback: (cols: number, rows: number) => void): () => void
  onSessionExit(sessionId: string, callback: (info: ExitInfo) => void): () => void
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
  readLayout(): Promise<PaneLayoutData | null>
  writeLayout(data: PaneLayoutData): Promise<void>
  readSettings(): Promise<SettingsData | null>
  writeSettings(data: SettingsData): Promise<void>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
