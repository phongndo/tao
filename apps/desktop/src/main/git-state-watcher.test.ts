import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { WorkspaceRecord } from '@tau/shared/workspace'
import { GitStateWatcher } from './git-state-watcher'
import type { TaudClient } from './taud-client'

function workspace(rootPath: string, branch: string): WorkspaceRecord {
  return {
    id: 'workspace-a',
    name: 'Workspace A',
    rootPath,
    gitCommonDir: '.git',
    workspaceSlug: 'workspace-a',
    defaultBranch: 'main',
    branch,
    orderIndex: 0,
    worktrees: [],
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.ok(predicate(), 'condition was not met before timeout')
}

function createGitRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tau-git-state-watcher-'))
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true })
  mkdirSync(join(root, '.git', 'worktrees'), { recursive: true })
  return root
}

test('GitStateWatcher diagnostics report queued refreshes and notifications', async () => {
  const root = createGitRoot()
  const initial = workspace(root, 'main')
  const refreshed = {
    ...initial,
    branch: 'feature/watcher-diagnostics',
    gitStatus: { changed: 1, staged: 0 },
  }
  const notifications: WorkspaceRecord[] = []
  let refreshCalls = 0
  const client = {
    refreshWorkspace: async (workspaceId: string) => {
      refreshCalls += 1
      assert.equal(workspaceId, initial.id)
      return refreshed
    },
  } as unknown as TaudClient
  const watcher = new GitStateWatcher(
    () => client,
    (workspace) => notifications.push(workspace),
    1,
    false,
  )

  try {
    watcher.trackWorkspace(initial)
    let diagnostics = watcher.getDiagnostics()
    assert.equal(diagnostics.trackedWorkspaces, 1)
    assert.ok(diagnostics.totalWatchers >= 1)
    assert.equal(diagnostics.entries[0]?.watcherInstallCount, 1)

    watcher.refreshWorkspaceSoon(initial.id)
    watcher.refreshWorkspaceSoon(initial.id)

    await waitFor(() => notifications.length === 1)
    diagnostics = watcher.getDiagnostics()
    const entry = diagnostics.entries[0]
    assert.ok(entry)
    assert.equal(refreshCalls, 1)
    assert.equal(entry.workspaceId, initial.id)
    assert.ok(entry.queuedRefreshCount >= 2)
    assert.equal(entry.refreshCount, 1)
    assert.equal(entry.refreshFailureCount, 0)
    assert.equal(entry.notifyCount, 1)
    assert.equal(entry.lastRefreshOk, true)
    assert.ok(['explicit', 'fs-event'].includes(entry.lastQueuedReason ?? ''))
    assert.ok(['explicit', 'fs-event'].includes(entry.lastRefreshReason ?? ''))
    assert.equal(entry.inFlight, false)
    assert.equal(entry.pending, false)
    assert.equal(entry.lastError, undefined)
    assert.ok((entry.lastRefreshDurationMs ?? -1) >= 0)
  } finally {
    watcher.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('GitStateWatcher diagnostics record refresh failures', async () => {
  const root = createGitRoot()
  const initial = workspace(root, 'main')
  const client = {
    refreshWorkspace: async () => {
      throw new Error('refresh exploded')
    },
  } as unknown as TaudClient
  const watcher = new GitStateWatcher(
    () => client,
    () => {},
    0,
    false,
  )
  const originalWarn = console.warn
  const warnings: unknown[][] = []
  console.warn = (...args: unknown[]) => {
    warnings.push(args)
  }

  try {
    watcher.trackWorkspace(initial)
    watcher.refreshWorkspaceSoon(initial.id)

    await waitFor(() => (watcher.getDiagnostics().entries[0]?.refreshFailureCount ?? 0) >= 1)
    const entry = watcher.getDiagnostics().entries[0]
    assert.ok(entry)
    assert.ok(entry.refreshCount >= 1)
    assert.ok(entry.refreshFailureCount >= 1)
    assert.equal(entry.notifyCount, 0)
    assert.equal(entry.lastRefreshOk, false)
    assert.match(entry.lastError ?? '', /refresh exploded/)
    assert.ok(warnings.length >= 1)
  } finally {
    console.warn = originalWarn
    watcher.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
