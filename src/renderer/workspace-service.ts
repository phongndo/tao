import { Context, Effect, Layer, Schema } from 'effect'
import {
  WorkspaceError,
  WorkspaceGitBranchResponseSchema,
  WorkspaceGitStatusResponseSchema,
  WorkspaceGitWorktreesResponseSchema,
  WorkspacePathSchema,
  WorkspacePortsResponseSchema,
  WorkspacePullRequestResponseSchema,
  workspaceErrorFromPayload,
  workspaceErrorFromUnknown,
  type GitStatus,
  type PortInfo,
  type PullRequestInfo,
  type WorkspaceIpcResponse,
  type WorktreeInfo,
} from '../shared/workspace'

const WORKSPACE_METADATA_STALE_MS = 5 * 60 * 1000
const WORKSPACE_IPC_TIMEOUT_MS = 15_000

type WorkspaceResourceKind = 'branch' | 'worktrees' | 'status' | 'ports' | 'pull-request'
type WorkspaceResourceListener = () => void

export type WorkspaceResourceStatus = 'idle' | 'loading' | 'success' | 'error'

export type WorkspaceResourceSnapshot<A> = {
  readonly status: WorkspaceResourceStatus
  readonly data: A | undefined
  readonly error: WorkspaceError | null
  readonly updatedAt?: number
}

export type RefreshOptions = {
  readonly force?: boolean
}

type WorkspaceResourceEntry<A> = {
  snapshot: WorkspaceResourceSnapshot<A>
  readonly listeners: Set<WorkspaceResourceListener>
  inFlight: boolean
}

export class WorkspaceIpcClient extends Context.Service<
  WorkspaceIpcClient,
  {
    readonly getGitBranch: (workspacePath: string) => Effect.Effect<string | null, WorkspaceError>
    readonly getGitWorktrees: (
      workspacePath: string,
    ) => Effect.Effect<readonly WorktreeInfo[], WorkspaceError>
    readonly getGitStatus: (workspacePath: string) => Effect.Effect<GitStatus, WorkspaceError>
    readonly getWorkspacePorts: (
      workspacePath: string,
    ) => Effect.Effect<readonly PortInfo[], WorkspaceError>
    readonly getPullRequestInfo: (
      workspacePath: string,
    ) => Effect.Effect<PullRequestInfo | null, WorkspaceError>
  }
>()('Tau/WorkspaceIpcClient') {}

export class WorkspaceMetadataCache extends Context.Service<
  WorkspaceMetadataCache,
  {
    readonly getGitBranchSnapshot: (
      workspacePath: string,
    ) => Effect.Effect<WorkspaceResourceSnapshot<string | null>>
    readonly subscribeGitBranch: (
      workspacePath: string,
      listener: WorkspaceResourceListener,
    ) => Effect.Effect<() => void, WorkspaceError>
    readonly refreshGitBranch: (
      workspacePath: string,
      options?: RefreshOptions,
    ) => Effect.Effect<void, WorkspaceError, WorkspaceIpcClient>

    readonly getGitWorktreesSnapshot: (
      workspacePath: string,
    ) => Effect.Effect<WorkspaceResourceSnapshot<readonly WorktreeInfo[]>>
    readonly subscribeGitWorktrees: (
      workspacePath: string,
      listener: WorkspaceResourceListener,
    ) => Effect.Effect<() => void, WorkspaceError>
    readonly refreshGitWorktrees: (
      workspacePath: string,
      options?: RefreshOptions,
    ) => Effect.Effect<void, WorkspaceError, WorkspaceIpcClient>

    readonly getGitStatusSnapshot: (
      workspacePath: string,
    ) => Effect.Effect<WorkspaceResourceSnapshot<GitStatus>>
    readonly subscribeGitStatus: (
      workspacePath: string,
      listener: WorkspaceResourceListener,
    ) => Effect.Effect<() => void, WorkspaceError>
    readonly refreshGitStatus: (
      workspacePath: string,
      options?: RefreshOptions,
    ) => Effect.Effect<void, WorkspaceError, WorkspaceIpcClient>

    readonly getWorkspacePortsSnapshot: (
      workspacePath: string,
    ) => Effect.Effect<WorkspaceResourceSnapshot<readonly PortInfo[]>>
    readonly subscribeWorkspacePorts: (
      workspacePath: string,
      listener: WorkspaceResourceListener,
    ) => Effect.Effect<() => void, WorkspaceError>
    readonly refreshWorkspacePorts: (
      workspacePath: string,
      options?: RefreshOptions,
    ) => Effect.Effect<void, WorkspaceError, WorkspaceIpcClient>

    readonly getPullRequestInfoSnapshot: (
      workspacePath: string,
    ) => Effect.Effect<WorkspaceResourceSnapshot<PullRequestInfo | null>>
    readonly subscribePullRequestInfo: (
      workspacePath: string,
      listener: WorkspaceResourceListener,
    ) => Effect.Effect<() => void, WorkspaceError>
    readonly refreshPullRequestInfo: (
      workspacePath: string,
      options?: RefreshOptions,
    ) => Effect.Effect<void, WorkspaceError, WorkspaceIpcClient>

    readonly invalidateWorkspace: (workspacePath: string) => Effect.Effect<void>
  }
>()('Tau/WorkspaceMetadataCache') {}

const idleSnapshot: WorkspaceResourceSnapshot<never> = {
  status: 'idle',
  data: undefined,
  error: null,
}

function electronApi(): Effect.Effect<Window['electronAPI'], WorkspaceError> {
  if (typeof window !== 'undefined' && window.electronAPI) {
    return Effect.succeed(window.electronAPI)
  }

  return Effect.fail(new WorkspaceError('unavailable', 'window.electronAPI is unavailable'))
}

function decodeWorkspacePath(workspacePath: string): Effect.Effect<string, WorkspaceError> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(WorkspacePathSchema)(workspacePath),
    catch: (error) =>
      new WorkspaceError('invalid-path', error instanceof Error ? error.message : String(error)),
  })
}

function decodeWorkspacePathSync(workspacePath: string): string | WorkspaceError {
  try {
    return Schema.decodeUnknownSync(WorkspacePathSchema)(workspacePath)
  } catch (error) {
    return new WorkspaceError(
      'invalid-path',
      error instanceof Error ? error.message : String(error),
    )
  }
}

function invokeWorkspaceIpc<T, R extends WorkspaceIpcResponse<T>>(
  workspacePath: string,
  channelName: string,
  invoke: (api: Window['electronAPI'], workspacePath: string) => Promise<unknown>,
  schema: Schema.Decoder<R>,
): Effect.Effect<T, WorkspaceError> {
  return Effect.gen(function* () {
    const path = yield* decodeWorkspacePath(workspacePath)
    const api = yield* electronApi()
    const rawResponse = yield* Effect.tryPromise({
      try: () => invokeWithTimeout(channelName, () => invoke(api, path)),
      catch: (error) => workspaceErrorFromUnknown(error, 'ipc-failed'),
    })
    const decoded = Schema.decodeUnknownOption(schema)(rawResponse)
    if (decoded._tag === 'None') {
      return yield* Effect.fail(
        new WorkspaceError('invalid-response', `Invalid response from ${channelName}`),
      )
    }

    if (!decoded.value.ok) return yield* Effect.fail(workspaceErrorFromPayload(decoded.value.error))
    return decoded.value.value
  })
}

function invokeWithTimeout(channelName: string, invoke: () => Promise<unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(
        new WorkspaceError(
          'ipc-timeout',
          `${channelName} timed out after ${WORKSPACE_IPC_TIMEOUT_MS}ms`,
        ),
      )
    }, WORKSPACE_IPC_TIMEOUT_MS)

    invoke()
      .then((value) => {
        window.clearTimeout(timer)
        resolve(value)
      })
      .catch((error) => {
        window.clearTimeout(timer)
        reject(error)
      })
  })
}

function resourceKey(kind: WorkspaceResourceKind, workspacePath: string): string {
  return `${kind}\u0000${workspacePath}`
}

function notifyResource(entry: WorkspaceResourceEntry<unknown>) {
  for (const listener of entry.listeners) listener()
}

function createWorkspaceMetadataCache(): typeof WorkspaceMetadataCache.Service {
  const entries = new Map<string, WorkspaceResourceEntry<unknown>>()
  const invalidSnapshots = new Map<string, WorkspaceResourceSnapshot<never>>()

  function entryFor<A>(
    kind: WorkspaceResourceKind,
    workspacePath: string,
  ): WorkspaceResourceEntry<A> {
    const key = resourceKey(kind, workspacePath)
    const existingEntry = entries.get(key)
    if (existingEntry) return existingEntry as WorkspaceResourceEntry<A>

    const entry: WorkspaceResourceEntry<A> = {
      snapshot: idleSnapshot as WorkspaceResourceSnapshot<A>,
      listeners: new Set(),
      inFlight: false,
    }
    entries.set(key, entry as WorkspaceResourceEntry<unknown>)
    return entry
  }

  function invalidSnapshot<A>(
    workspacePath: string,
    error: WorkspaceError,
  ): WorkspaceResourceSnapshot<A> {
    const existing = invalidSnapshots.get(workspacePath)
    if (existing) return existing as WorkspaceResourceSnapshot<A>

    const snapshot: WorkspaceResourceSnapshot<never> = {
      status: 'error',
      data: undefined,
      error,
      updatedAt: Date.now(),
    }
    invalidSnapshots.set(workspacePath, snapshot)
    return snapshot as WorkspaceResourceSnapshot<A>
  }

  function snapshot<A>(
    kind: WorkspaceResourceKind,
    workspacePath: string,
  ): WorkspaceResourceSnapshot<A> {
    const decodedPath = decodeWorkspacePathSync(workspacePath)
    if (decodedPath instanceof WorkspaceError) return invalidSnapshot(workspacePath, decodedPath)

    return entryFor<A>(kind, decodedPath).snapshot
  }

  function subscribe(
    kind: WorkspaceResourceKind,
    workspacePath: string,
    listener: WorkspaceResourceListener,
  ): Effect.Effect<() => void, WorkspaceError> {
    return decodeWorkspacePath(workspacePath).pipe(
      Effect.map((decodedPath) => {
        const entry = entryFor(kind, decodedPath)
        entry.listeners.add(listener)
        return () => {
          entry.listeners.delete(listener)
        }
      }),
    )
  }

  function refresh<A>(
    kind: WorkspaceResourceKind,
    workspacePath: string,
    options: RefreshOptions | undefined,
    fetch: (workspacePath: string) => Effect.Effect<A, WorkspaceError, WorkspaceIpcClient>,
  ): Effect.Effect<void, WorkspaceError, WorkspaceIpcClient> {
    return Effect.gen(function* () {
      const decodedPath = yield* decodeWorkspacePath(workspacePath)
      const entry = entryFor<A>(kind, decodedPath)
      if (entry.inFlight) return

      const now = Date.now()
      if (
        !options?.force &&
        entry.snapshot.status === 'success' &&
        entry.snapshot.updatedAt !== undefined &&
        now - entry.snapshot.updatedAt < WORKSPACE_METADATA_STALE_MS
      ) {
        return
      }

      entry.inFlight = true
      entry.snapshot = {
        status: 'loading',
        data: entry.snapshot.data,
        error: null,
        updatedAt: entry.snapshot.updatedAt,
      }
      notifyResource(entry as WorkspaceResourceEntry<unknown>)

      return yield* fetch(decodedPath).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              entry.inFlight = false
              entry.snapshot = {
                status: 'error',
                data: entry.snapshot.data,
                error,
                updatedAt: Date.now(),
              }
              notifyResource(entry as WorkspaceResourceEntry<unknown>)
            }).pipe(Effect.flatMap(() => Effect.fail(error))),
          onSuccess: (data) =>
            Effect.sync(() => {
              entry.inFlight = false
              entry.snapshot = {
                status: 'success',
                data,
                error: null,
                updatedAt: Date.now(),
              }
              notifyResource(entry as WorkspaceResourceEntry<unknown>)
            }),
        }),
      )
    })
  }

  return {
    getGitBranchSnapshot: (workspacePath) => Effect.sync(() => snapshot('branch', workspacePath)),
    subscribeGitBranch: (workspacePath, listener) => subscribe('branch', workspacePath, listener),
    refreshGitBranch: (workspacePath, options) =>
      refresh('branch', workspacePath, options, (path) =>
        WorkspaceIpcClient.use((client) => client.getGitBranch(path)),
      ),

    getGitWorktreesSnapshot: (workspacePath) =>
      Effect.sync(() => snapshot('worktrees', workspacePath)),
    subscribeGitWorktrees: (workspacePath, listener) =>
      subscribe('worktrees', workspacePath, listener),
    refreshGitWorktrees: (workspacePath, options) =>
      refresh('worktrees', workspacePath, options, (path) =>
        WorkspaceIpcClient.use((client) => client.getGitWorktrees(path)),
      ),

    getGitStatusSnapshot: (workspacePath) => Effect.sync(() => snapshot('status', workspacePath)),
    subscribeGitStatus: (workspacePath, listener) => subscribe('status', workspacePath, listener),
    refreshGitStatus: (workspacePath, options) =>
      refresh('status', workspacePath, options, (path) =>
        WorkspaceIpcClient.use((client) => client.getGitStatus(path)),
      ),

    getWorkspacePortsSnapshot: (workspacePath) =>
      Effect.sync(() => snapshot('ports', workspacePath)),
    subscribeWorkspacePorts: (workspacePath, listener) =>
      subscribe('ports', workspacePath, listener),
    refreshWorkspacePorts: (workspacePath, options) =>
      refresh('ports', workspacePath, options, (path) =>
        WorkspaceIpcClient.use((client) => client.getWorkspacePorts(path)),
      ),

    getPullRequestInfoSnapshot: (workspacePath) =>
      Effect.sync(() => snapshot('pull-request', workspacePath)),
    subscribePullRequestInfo: (workspacePath, listener) =>
      subscribe('pull-request', workspacePath, listener),
    refreshPullRequestInfo: (workspacePath, options) =>
      refresh('pull-request', workspacePath, options, (path) =>
        WorkspaceIpcClient.use((client) => client.getPullRequestInfo(path)),
      ),

    invalidateWorkspace: (workspacePath) =>
      Effect.sync(() => {
        const decodedPath = decodeWorkspacePathSync(workspacePath)
        if (decodedPath instanceof WorkspaceError) return

        invalidSnapshots.delete(workspacePath)
        invalidSnapshots.delete(decodedPath)

        for (const kind of ['branch', 'worktrees', 'status', 'ports', 'pull-request'] as const) {
          const key = resourceKey(kind, decodedPath)
          const entry = entries.get(key)
          if (!entry) continue

          entry.inFlight = false
          entry.snapshot = idleSnapshot
          notifyResource(entry)
        }
      }),
  }
}

export const WorkspaceIpcClientLive = Layer.succeed(WorkspaceIpcClient)({
  getGitBranch: (workspacePath) =>
    invokeWorkspaceIpc(
      workspacePath,
      'workspace:getGitBranch',
      (api, path) => api.getGitBranch(path),
      WorkspaceGitBranchResponseSchema,
    ),
  getGitWorktrees: (workspacePath) =>
    invokeWorkspaceIpc(
      workspacePath,
      'workspace:getGitWorktrees',
      (api, path) => api.getGitWorktrees(path),
      WorkspaceGitWorktreesResponseSchema,
    ),
  getGitStatus: (workspacePath) =>
    invokeWorkspaceIpc(
      workspacePath,
      'workspace:getGitStatus',
      (api, path) => api.getGitStatus(path),
      WorkspaceGitStatusResponseSchema,
    ),
  getWorkspacePorts: (workspacePath) =>
    invokeWorkspaceIpc(
      workspacePath,
      'workspace:getWorkspacePorts',
      (api, path) => api.getWorkspacePorts(path),
      WorkspacePortsResponseSchema,
    ),
  getPullRequestInfo: (workspacePath) =>
    invokeWorkspaceIpc(
      workspacePath,
      'workspace:getPullRequestInfo',
      (api, path) => api.getPullRequestInfo(path),
      WorkspacePullRequestResponseSchema,
    ),
})

export const WorkspaceMetadataCacheLive = Layer.succeed(WorkspaceMetadataCache)(
  createWorkspaceMetadataCache(),
)
