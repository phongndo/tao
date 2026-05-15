import { Context, Effect, Layer, ManagedRuntime, Schema } from 'effect'
import { ipcRenderer } from 'electron'
import {
  WorkspaceError,
  WorkspaceGitBranchResponseSchema,
  WorkspaceGitStatusResponseSchema,
  WorkspaceGitWorktreesResponseSchema,
  WorkspacePortsResponseSchema,
  WorkspacePullRequestResponseSchema,
  type WorkspaceGitBranchResponse,
  type WorkspaceGitStatusResponse,
  type WorkspaceGitWorktreesResponse,
  type WorkspacePortsResponse,
  type WorkspacePullRequestResponse,
} from '../shared/workspace'

export class PreloadWorkspaceIpc extends Context.Service<
  PreloadWorkspaceIpc,
  {
    readonly getGitBranch: (
      workspacePath: string,
    ) => Effect.Effect<WorkspaceGitBranchResponse, WorkspaceError>
    readonly getGitWorktrees: (
      workspacePath: string,
    ) => Effect.Effect<WorkspaceGitWorktreesResponse, WorkspaceError>
    readonly getGitStatus: (
      workspacePath: string,
    ) => Effect.Effect<WorkspaceGitStatusResponse, WorkspaceError>
    readonly getWorkspacePorts: (
      workspacePath: string,
    ) => Effect.Effect<WorkspacePortsResponse, WorkspaceError>
    readonly getPullRequestInfo: (
      workspacePath: string,
    ) => Effect.Effect<WorkspacePullRequestResponse, WorkspaceError>
  }
>()('Tau/PreloadWorkspaceIpc') {}

function invokeWorkspace<A>(
  channel: string,
  workspacePath: string,
  schema: Schema.Decoder<A>,
): Effect.Effect<A, WorkspaceError> {
  if (typeof workspacePath !== 'string') {
    return Effect.fail(new WorkspaceError('invalid-path', 'workspacePath must be a string'))
  }

  return Effect.tryPromise({
    try: () => ipcRenderer.invoke(channel, workspacePath) as Promise<unknown>,
    catch: (error) =>
      new WorkspaceError('ipc-failed', error instanceof Error ? error.message : String(error)),
  }).pipe(
    Effect.flatMap((response) => {
      const decoded = Schema.decodeUnknownOption(schema)(response)
      if (decoded._tag === 'Some') return Effect.succeed(decoded.value)

      return Effect.fail(new WorkspaceError('invalid-response', `Invalid response from ${channel}`))
    }),
  )
}

const PreloadWorkspaceIpcLive = Layer.succeed(PreloadWorkspaceIpc)({
  getGitBranch: (workspacePath) =>
    invokeWorkspace('workspace:getGitBranch', workspacePath, WorkspaceGitBranchResponseSchema),
  getGitWorktrees: (workspacePath) =>
    invokeWorkspace(
      'workspace:getGitWorktrees',
      workspacePath,
      WorkspaceGitWorktreesResponseSchema,
    ),
  getGitStatus: (workspacePath) =>
    invokeWorkspace('workspace:getGitStatus', workspacePath, WorkspaceGitStatusResponseSchema),
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
