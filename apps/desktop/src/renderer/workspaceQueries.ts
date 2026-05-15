import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Effect } from 'effect'
import { runRendererEffect, runRendererEffectSync } from './runtime'
import {
  WorkspaceIpcClient,
  WorkspaceMetadataCache,
  type RefreshOptions,
  type WorkspaceResourceSnapshot,
} from './workspace-service'
import { WorkspaceError, workspaceErrorFromUnknown } from '@tau/shared/workspace'
import type { GitStatus, PortInfo, PullRequestInfo, WorktreeInfo } from '@tau/shared/workspace'

type WorkspaceResourceAdapter<A> = {
  readonly snapshot: (
    workspacePath: string,
  ) => Effect.Effect<WorkspaceResourceSnapshot<A>, never, WorkspaceMetadataCache>
  readonly subscribe: (
    workspacePath: string,
    listener: () => void,
  ) => Effect.Effect<() => void, WorkspaceError, WorkspaceMetadataCache>
  readonly refresh: (
    workspacePath: string,
    options?: RefreshOptions,
  ) => Effect.Effect<void, WorkspaceError, WorkspaceMetadataCache | WorkspaceIpcClient>
}

export type EffectQueryResult<A> = {
  readonly data: A | undefined
  readonly error: WorkspaceError | null
  readonly isError: boolean
  readonly isLoading: boolean
  readonly isFetching: boolean
  readonly refetch: () => void
}

const idleSnapshot: WorkspaceResourceSnapshot<never> = {
  status: 'idle',
  data: undefined,
  error: null,
}

function errorSnapshot<A>(error: unknown, workspacePath: string): WorkspaceResourceSnapshot<A> {
  const workspaceError = workspaceErrorFromUnknown(
    error,
    error instanceof Error ? 'unavailable' : 'invalid-response',
  )

  return {
    status: 'error',
    data: undefined,
    error: new WorkspaceError(workspaceError.kind, `${workspacePath}: ${workspaceError.message}`),
    updatedAt: Date.now(),
  }
}

const gitBranchResource: WorkspaceResourceAdapter<string | null> = {
  snapshot: (workspacePath) =>
    WorkspaceMetadataCache.use((cache) => cache.getGitBranchSnapshot(workspacePath)),
  subscribe: (workspacePath, listener) =>
    WorkspaceMetadataCache.use((cache) => cache.subscribeGitBranch(workspacePath, listener)),
  refresh: (workspacePath, options) =>
    WorkspaceMetadataCache.use((cache) => cache.refreshGitBranch(workspacePath, options)),
}

const gitWorktreesResource: WorkspaceResourceAdapter<readonly WorktreeInfo[]> = {
  snapshot: (workspacePath) =>
    WorkspaceMetadataCache.use((cache) => cache.getGitWorktreesSnapshot(workspacePath)),
  subscribe: (workspacePath, listener) =>
    WorkspaceMetadataCache.use((cache) => cache.subscribeGitWorktrees(workspacePath, listener)),
  refresh: (workspacePath, options) =>
    WorkspaceMetadataCache.use((cache) => cache.refreshGitWorktrees(workspacePath, options)),
}

const gitStatusResource: WorkspaceResourceAdapter<GitStatus> = {
  snapshot: (workspacePath) =>
    WorkspaceMetadataCache.use((cache) => cache.getGitStatusSnapshot(workspacePath)),
  subscribe: (workspacePath, listener) =>
    WorkspaceMetadataCache.use((cache) => cache.subscribeGitStatus(workspacePath, listener)),
  refresh: (workspacePath, options) =>
    WorkspaceMetadataCache.use((cache) => cache.refreshGitStatus(workspacePath, options)),
}

const workspacePortsResource: WorkspaceResourceAdapter<readonly PortInfo[]> = {
  snapshot: (workspacePath) =>
    WorkspaceMetadataCache.use((cache) => cache.getWorkspacePortsSnapshot(workspacePath)),
  subscribe: (workspacePath, listener) =>
    WorkspaceMetadataCache.use((cache) => cache.subscribeWorkspacePorts(workspacePath, listener)),
  refresh: (workspacePath, options) =>
    WorkspaceMetadataCache.use((cache) => cache.refreshWorkspacePorts(workspacePath, options)),
}

const pullRequestResource: WorkspaceResourceAdapter<PullRequestInfo | null> = {
  snapshot: (workspacePath) =>
    WorkspaceMetadataCache.use((cache) => cache.getPullRequestInfoSnapshot(workspacePath)),
  subscribe: (workspacePath, listener) =>
    WorkspaceMetadataCache.use((cache) => cache.subscribePullRequestInfo(workspacePath, listener)),
  refresh: (workspacePath, options) =>
    WorkspaceMetadataCache.use((cache) => cache.refreshPullRequestInfo(workspacePath, options)),
}

function useWorkspaceResource<A>(
  workspacePath: string | null,
  enabled: boolean,
  adapter: WorkspaceResourceAdapter<A>,
): EffectQueryResult<A> {
  const [operationError, setOperationError] = useState<WorkspaceError | null>(null)

  const getSnapshot = useCallback((): WorkspaceResourceSnapshot<A> => {
    if (!workspacePath) return idleSnapshot as WorkspaceResourceSnapshot<A>

    try {
      return runRendererEffectSync(adapter.snapshot(workspacePath))
    } catch (error) {
      console.warn('[workspace] Failed to read Effect cache snapshot:', error)
      return errorSnapshot(error, workspacePath)
    }
  }, [adapter, workspacePath])

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!workspacePath || !enabled) return () => {}

      try {
        const unsubscribe = runRendererEffectSync(adapter.subscribe(workspacePath, onStoreChange))
        setOperationError(null)
        return unsubscribe
      } catch (error) {
        console.warn('[workspace] Failed to subscribe to Effect cache:', error)
        onStoreChange()
        return () => {}
      }
    },
    [adapter, enabled, workspacePath],
  )

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useEffect(() => {
    if (!workspacePath || !enabled) {
      setOperationError(null)
      return
    }

    if (snapshot.status !== 'idle') return

    setOperationError(null)
    void runRendererEffect(adapter.refresh(workspacePath))
      .then(() => setOperationError(null))
      .catch((error) => {
        console.warn('[workspace] Failed to refresh metadata:', error)
        setOperationError(workspaceErrorFromUnknown(error, 'ipc-failed'))
      })
  }, [adapter, enabled, snapshot.status, workspacePath])

  const refetch = useCallback(() => {
    if (!workspacePath) return
    setOperationError(null)
    void runRendererEffect(adapter.refresh(workspacePath, { force: true }))
      .then(() => setOperationError(null))
      .catch((error) => {
        console.warn('[workspace] Failed to refetch metadata:', error)
        setOperationError(workspaceErrorFromUnknown(error, 'ipc-failed'))
      })
  }, [adapter, workspacePath])

  const hasPath = workspacePath !== null
  const hasData = snapshot.data !== undefined
  const isFetching = hasPath && enabled && snapshot.status === 'loading'
  const error = operationError ?? snapshot.error
  const isError = snapshot.status === 'error' || operationError !== null
  const isLoading = hasPath && enabled && !hasData && !isError

  return {
    data: snapshot.data,
    error,
    isError,
    isLoading,
    isFetching,
    refetch,
  }
}

export function useGitBranch(workspacePath: string | null, enabled = true) {
  return useWorkspaceResource(workspacePath, enabled, gitBranchResource)
}

export function useGitWorktrees(workspacePath: string | null, enabled = true) {
  return useWorkspaceResource(workspacePath, enabled, gitWorktreesResource)
}

export function useGitStatus(workspacePath: string | null, enabled = true) {
  return useWorkspaceResource(workspacePath, enabled, gitStatusResource)
}

export function useWorkspacePorts(workspacePath: string | null, enabled = true) {
  return useWorkspaceResource(workspacePath, enabled, workspacePortsResource)
}

export function usePullRequestInfo(workspacePath: string | null, enabled = true) {
  return useWorkspaceResource(workspacePath, enabled, pullRequestResource)
}
