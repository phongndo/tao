import assert from 'node:assert/strict'
import test from 'node:test'
import { Effect } from 'effect'
import { WorkspaceError } from '@tau/shared/workspace'
import {
  WorkspaceIpcClient,
  createWorkspaceMetadataCache,
  type WorkspaceResourceSnapshot,
} from '../src/renderer/workspace-service'

type PendingBranch = {
  resolve: (value: string | null) => void
  reject: (error: unknown) => void
}

function provideWorkspaceClient<A, E>(
  program: Effect.Effect<A, E, WorkspaceIpcClient>,
  pendingBranches: PendingBranch[],
): Effect.Effect<A, E> {
  return Effect.provideService(program, WorkspaceIpcClient, {
    getGitBranch: () =>
      Effect.tryPromise({
        try: () =>
          new Promise<string | null>((resolve, reject) => {
            pendingBranches.push({ resolve, reject })
          }),
        catch: (error) =>
          error instanceof WorkspaceError
            ? error
            : new WorkspaceError(
                'ipc-failed',
                error instanceof Error ? error.message : String(error),
              ),
      }),
    getGitWorktrees: () => Effect.succeed([]),
    getGitStatus: () => Effect.succeed({ changed: 0, staged: 0 }),
    getWorkspacePorts: () => Effect.succeed([]),
    getPullRequestInfo: () => Effect.succeed(null),
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.ok(predicate(), 'condition was not met before timeout')
}

async function snapshot(
  cache: ReturnType<typeof createWorkspaceMetadataCache>,
  workspacePath: string,
): Promise<WorkspaceResourceSnapshot<string | null>> {
  return Effect.runPromise(cache.getGitBranchSnapshot(workspacePath))
}

test('WorkspaceMetadataCache forced refresh supersedes stale in-flight results', async () => {
  const cache = createWorkspaceMetadataCache()
  const pendingBranches: PendingBranch[] = []
  const workspacePath = '/tmp/tau-workspace-service-test'

  const firstRefresh = Effect.runPromise(
    provideWorkspaceClient(cache.refreshGitBranch(workspacePath), pendingBranches),
  )
  await waitFor(() => pendingBranches.length === 1)

  await Effect.runPromise(
    provideWorkspaceClient(cache.refreshGitBranch(workspacePath), pendingBranches),
  )
  assert.equal(pendingBranches.length, 1)

  const forcedRefresh = Effect.runPromise(
    provideWorkspaceClient(cache.refreshGitBranch(workspacePath, { force: true }), pendingBranches),
  )
  await waitFor(() => pendingBranches.length === 2)

  pendingBranches[1]?.resolve('newer')
  await forcedRefresh

  let current = await snapshot(cache, workspacePath)
  assert.equal(current.status, 'success')
  assert.equal(current.data, 'newer')

  pendingBranches[0]?.resolve('older')
  await firstRefresh

  current = await snapshot(cache, workspacePath)
  assert.equal(current.status, 'success')
  assert.equal(current.data, 'newer')
})
