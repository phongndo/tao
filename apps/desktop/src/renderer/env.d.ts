/**
 * Type declarations for the renderer process.
 * These types describe the API exposed by the preload script via contextBridge.
 */

import type { AppCommand } from '@tao/shared/app-command'
import type { PaneLayoutData, SettingsData } from '@tao/shared/session'
import type {
  AttachSessionInput,
  AttachSessionResult,
  AgentStatus,
  CreateSessionInput,
  CreateSessionResult,
  CurrentScreenSnapshotFrame,
  ExitInfo,
  OutputFrame,
} from '@tao/shared/taod-protocol'
import type {
  WorkspaceGitBranchResponse,
  WorkspaceGitStatusResponse,
  WorkspaceGitWorktreesResponse,
  WorkspaceIpcResponse,
  WorkspaceListResponse,
  WorkspacePortsResponse,
  WorkspacePullRequestResponse,
  WorkspaceRecord,
  WorkspaceRecordResponse,
  WorkspaceWorktreeResponse,
} from '@tao/shared/workspace'

export interface ElectronAPI {
  openExternalUrl(url: string): Promise<void>
  writeClipboardText(text: string): Promise<void>
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
  onSessionSnapshot(
    sessionId: string,
    callback: (frame: CurrentScreenSnapshotFrame) => void,
  ): () => void
  onSessionResize(sessionId: string, callback: (cols: number, rows: number) => void): () => void
  onSessionExit(sessionId: string, callback: (info: ExitInfo) => void): () => void
  onSessionError(sessionId: string, callback: (error: string) => void): () => void
  onAgentStatus(sessionId: string, callback: (status: AgentStatus) => void): () => void
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
  signalReady(): Promise<void>
  onAppCommand(callback: (command: AppCommand) => void): () => void
  onWorkspaceChanged(callback: (workspace: WorkspaceRecord) => void): () => void
  pickWorkspaceDirectory(): Promise<string | null>
  getGitBranch(workspacePath: string): Promise<WorkspaceGitBranchResponse>
  getGitWorktrees(workspacePath: string): Promise<WorkspaceGitWorktreesResponse>
  getGitStatus(workspacePath: string): Promise<WorkspaceGitStatusResponse>
  getWorkspacePorts(workspacePath: string): Promise<WorkspacePortsResponse>
  getPullRequestInfo(workspacePath: string): Promise<WorkspacePullRequestResponse>
  listWorkspaces(): Promise<WorkspaceListResponse>
  addWorkspace(input: {
    rootPath: string
    workspaceId?: string
    name?: string
    orderIndex?: number
  }): Promise<WorkspaceRecordResponse>
  refreshWorkspace(workspaceId: string): Promise<WorkspaceRecordResponse>
  removeWorkspace(workspaceId: string): Promise<WorkspaceIpcResponse<void>>
  createWorktree(input: {
    workspaceId: string
    baseBranch?: string
    targetBranch?: string
    branch?: string
    folderName?: string
    startPoint?: string
    title?: string
  }): Promise<WorkspaceWorktreeResponse>
  refreshWorktree(worktreeId: string): Promise<WorkspaceWorktreeResponse>
  removeWorktree(input: {
    worktreeId: string
    force?: boolean
    deleteBranch?: boolean
  }): Promise<WorkspaceIpcResponse<void>>
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
