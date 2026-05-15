import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { Effect } from 'effect'
import { runRendererEffect, runRendererEffectSync } from './runtime'
import {
  WorkspaceIpcClient,
  WorkspaceMetadataCache,
  type RefreshOptions,
  type WorkspaceResourceSnapshot,
} from './workspace-service'
import type {
  GitStatus,
  PortInfo,
  PullRequestInfo,
  WorkspaceError,
  WorktreeInfo,
} from '../shared/workspace'

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
  const getSnapshot = useCallback((): WorkspaceResourceSnapshot<A> => {
    if (!workspacePath) return idleSnapshot as WorkspaceResourceSnapshot<A>

    try {
      return runRendererEffectSync(adapter.snapshot(workspacePath))
    } catch (error) {
      console.warn('[workspace] Failed to read Effect cache snapshot:', error)
      return idleSnapshot as WorkspaceResourceSnapshot<A>
    }
  }, [adapter, workspacePath])

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!workspacePath || !enabled) return () => {}

      let disposed = false
      let unsubscribe: (() => void) | null = null
      void runRendererEffect(adapter.subscribe(workspacePath, onStoreChange))
        .then((nextUnsubscribe) => {
          if (disposed) {
            nextUnsubscribe()
            return
          }

          unsubscribe = nextUnsubscribe
          onStoreChange()
        })
        .catch((error) => {
          console.warn('[workspace] Failed to subscribe to Effect cache:', error)
          onStoreChange()
        })

      return () => {
        disposed = true
        unsubscribe?.()
      }
    },
    [adapter, enabled, workspacePath],
  )

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useEffect(() => {
    if (!workspacePath || !enabled) return

    void runRendererEffect(adapter.refresh(workspacePath)).catch((error) => {
      console.warn('[workspace] Failed to refresh metadata:', error)
    })
  }, [adapter, enabled, workspacePath])

  const refetch = useCallback(() => {
    if (!workspacePath) return
    void runRendererEffect(adapter.refresh(workspacePath, { force: true })).catch((error) => {
      console.warn('[workspace] Failed to refetch metadata:', error)
    })
  }, [adapter, workspacePath])

  const hasPath = workspacePath !== null
  const hasData = snapshot.data !== undefined
  const isFetching = hasPath && enabled && snapshot.status === 'loading'
  const isLoading = hasPath && enabled && !hasData && snapshot.status !== 'error'

  return {
    data: snapshot.data,
    error: snapshot.error,
    isError: snapshot.status === 'error',
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
