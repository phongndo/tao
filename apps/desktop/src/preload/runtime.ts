import { Context, Effect, Layer, ManagedRuntime, Schema } from 'effect'
import { ipcRenderer } from 'electron'
import {
  WorkspaceError,
  WorkspaceDiffPatchResponseSchema,
  WorkspaceFileTreeResponseSchema,
  WorkspaceGitPathActionResponseSchema,
  WorkspaceGitBranchResponseSchema,
  WorkspaceGitBranchesResponseSchema,
  WorkspaceGitStatusResponseSchema,
  WorkspaceGitWorktreesResponseSchema,
  WorkspacePortsResponseSchema,
  WorkspacePullRequestResponseSchema,
  WORKSPACE_IPC_TIMEOUT_MS,
  type WorkspaceGitBranchResponse,
  type WorkspaceGitBranchesResponse,
  type WorkspaceDiffPatchInput,
  type WorkspaceDiffPatchResponse,
  type WorkspaceFileTreeResponse,
  type WorkspaceGitPathActionInput,
  type WorkspaceGitPathActionResponse,
  type WorkspaceGitStatusResponse,
  type WorkspaceGitWorktreesResponse,
  type WorkspacePortsResponse,
  type WorkspacePullRequestResponse,
  decodeWorkspaceIpcResponse,
  errorMessageFromUnknown,
} from '@tao/shared/workspace'

export class PreloadWorkspaceIpc extends Context.Service<
  PreloadWorkspaceIpc,
  {
    readonly getGitBranch: (
      workspacePath: string,
    ) => Effect.Effect<WorkspaceGitBranchResponse, WorkspaceError>
    readonly getGitBranches: (
      workspacePath: string,
    ) => Effect.Effect<WorkspaceGitBranchesResponse, WorkspaceError>
    readonly getGitWorktrees: (
      workspacePath: string,
    ) => Effect.Effect<WorkspaceGitWorktreesResponse, WorkspaceError>
    readonly getGitStatus: (
      workspacePath: string,
    ) => Effect.Effect<WorkspaceGitStatusResponse, WorkspaceError>
    readonly getWorkspaceFileTree: (
      workspacePath: string,
    ) => Effect.Effect<WorkspaceFileTreeResponse, WorkspaceError>
    readonly getWorkspaceDiffPatch: (
      input: WorkspaceDiffPatchInput,
    ) => Effect.Effect<WorkspaceDiffPatchResponse, WorkspaceError>
    readonly stagePath: (
      input: WorkspaceGitPathActionInput,
    ) => Effect.Effect<WorkspaceGitPathActionResponse, WorkspaceError>
    readonly revertPath: (
      input: WorkspaceGitPathActionInput,
    ) => Effect.Effect<WorkspaceGitPathActionResponse, WorkspaceError>
    readonly getWorkspacePorts: (
      workspacePath: string,
    ) => Effect.Effect<WorkspacePortsResponse, WorkspaceError>
    readonly getPullRequestInfo: (
      workspacePath: string,
    ) => Effect.Effect<WorkspacePullRequestResponse, WorkspaceError>
  }
>()('Tao/PreloadWorkspaceIpc') {}

function invokeWorkspace<A>(
  channel: string,
  input: unknown,
  schema: Schema.Decoder<A>,
): Effect.Effect<A, WorkspaceError> {
  return Effect.tryPromise({
    try: () => ipcRenderer.invoke(channel, input) as Promise<unknown>,
    catch: (error) => new WorkspaceError('ipc-failed', errorMessageFromUnknown(error)),
  }).pipe(
    Effect.timeoutOrElse({
      duration: WORKSPACE_IPC_TIMEOUT_MS,
      orElse: () =>
        Effect.fail(
          new WorkspaceError(
            'ipc-timeout',
            `${channel} timed out after ${WORKSPACE_IPC_TIMEOUT_MS}ms`,
          ),
        ),
    }),
    Effect.flatMap((response) => decodeWorkspaceIpcResponse(response, schema, channel)),
  )
}

const PreloadWorkspaceIpcLive = Layer.succeed(PreloadWorkspaceIpc)({
  getGitBranch: (workspacePath) =>
    invokeWorkspace('workspace:getGitBranch', workspacePath, WorkspaceGitBranchResponseSchema),
  getGitBranches: (workspacePath) =>
    invokeWorkspace('workspace:getGitBranches', workspacePath, WorkspaceGitBranchesResponseSchema),
  getGitWorktrees: (workspacePath) =>
    invokeWorkspace(
      'workspace:getGitWorktrees',
      workspacePath,
      WorkspaceGitWorktreesResponseSchema,
    ),
  getGitStatus: (workspacePath) =>
    invokeWorkspace('workspace:getGitStatus', workspacePath, WorkspaceGitStatusResponseSchema),
  getWorkspaceFileTree: (workspacePath) =>
    invokeWorkspace(
      'workspace:getWorkspaceFileTree',
      workspacePath,
      WorkspaceFileTreeResponseSchema,
    ),
  getWorkspaceDiffPatch: (input) =>
    invokeWorkspace('workspace:getWorkspaceDiffPatch', input, WorkspaceDiffPatchResponseSchema),
  stagePath: (input) =>
    invokeWorkspace('workspace:stagePath', input, WorkspaceGitPathActionResponseSchema),
  revertPath: (input) =>
    invokeWorkspace('workspace:revertPath', input, WorkspaceGitPathActionResponseSchema),
  getWorkspacePorts: (workspacePath) =>
    invokeWorkspace('workspace:getWorkspacePorts', workspacePath, WorkspacePortsResponseSchema),
  getPullRequestInfo: (workspacePath) =>
    invokeWorkspace(
      'workspace:getPullRequestInfo',
      workspacePath,
      WorkspacePullRequestResponseSchema,
    ),
})

const preloadRuntime = ManagedRuntime.make(PreloadWorkspaceIpcLive)

export function runPreloadEffect<A, E>(
  program: Effect.Effect<A, E, PreloadWorkspaceIpc>,
): Promise<A> {
  return preloadRuntime.runPromise(program)
}
