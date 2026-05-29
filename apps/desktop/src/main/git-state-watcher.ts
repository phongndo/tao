import { existsSync, readdirSync, watch, type FSWatcher } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { WorkspaceRecord, WorkspaceWatcherDiagnostics } from '@tau/shared/workspace'
import type { TaudClient } from './taud-client'

const GIT_REFRESH_DEBOUNCE_MS = 75
const MAX_WATCHED_GIT_DIRS = 512
const MAX_WATCHED_GIT_DEPTH = 32

type WatchEntry = {
  record: WorkspaceRecord
  gitCommonDir: string
  fingerprint: string
  watchers: FSWatcher[]
  debounceTimer: ReturnType<typeof setTimeout> | null
  inFlight: boolean
  pending: boolean
  queuedRefreshCount: number
  refreshCount: number
  refreshFailureCount: number
  notifyCount: number
  watcherInstallCount: number
  lastQueuedAt: number | undefined
  lastQueuedReason: string | undefined
  lastRefreshStartedAt: number | undefined
  lastRefreshFinishedAt: number | undefined
  lastRefreshDurationMs: number | undefined
  lastRefreshOk: boolean | undefined
  lastRefreshReason: string | undefined
  lastNotifiedAt: number | undefined
  lastError: string | undefined
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref()
}

function workspaceFingerprint(workspace: WorkspaceRecord): string {
  return JSON.stringify({
    id: workspace.id,
    rootPath: workspace.rootPath,
    gitCommonDir: workspace.gitCommonDir ?? null,
    defaultBranch: workspace.defaultBranch ?? null,
    branch: workspace.branch ?? null,
    gitStatus: workspace.gitStatus ?? null,
    worktrees: workspace.worktrees
      .map((worktree) => ({
        id: worktree.id,
        path: worktree.path,
        branch: worktree.branch,
        state: worktree.state,
        lastError: worktree.lastError ?? null,
        gitStatus: worktree.gitStatus ?? null,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  })
}

function resolveGitCommonDir(workspace: WorkspaceRecord): string | null {
  const gitCommonDir = workspace.gitCommonDir
  if (!gitCommonDir) return null
  return isAbsolute(gitCommonDir) ? gitCommonDir : resolve(workspace.rootPath, gitCommonDir)
}

function existingPath(path: string): string | null {
  try {
    return existsSync(path) ? path : null
  } catch {
    return null
  }
}

function appendExistingDirectory(paths: Set<string>, path: string, depth = 0): void {
  if (depth > MAX_WATCHED_GIT_DEPTH || paths.size >= MAX_WATCHED_GIT_DIRS) return
  const existing = existingPath(path)
  if (!existing) return
  try {
    for (const entry of readdirSync(existing, { withFileTypes: true })) {
      if (entry.isDirectory()) appendExistingDirectory(paths, join(existing, entry.name), depth + 1)
    }
    if (paths.size < MAX_WATCHED_GIT_DIRS) paths.add(existing)
  } catch {
    // Git may rewrite metadata while we are enumerating. The parent watcher will
    // fire again and re-arm watchers after the next refresh.
  }
}

function watchablePaths(gitCommonDir: string): string[] {
  const paths = new Set<string>()
  const root = existingPath(gitCommonDir)
  if (root) paths.add(root)
  appendExistingDirectory(paths, join(gitCommonDir, 'refs'))
  appendExistingDirectory(paths, join(gitCommonDir, 'worktrees'))

  return [...paths]
}

export class GitStateWatcher {
  private readonly entries = new Map<string, WatchEntry>()

  constructor(
    private readonly client: () => TaudClient,
    private readonly notifyWorkspaceChanged: (workspace: WorkspaceRecord) => void,
    private readonly debounceMs = GIT_REFRESH_DEBOUNCE_MS,
    private readonly unrefDebounceTimers = true,
  ) {}

  dispose(): void {
    for (const entry of this.entries.values()) this.disposeEntry(entry)
    this.entries.clear()
  }

  getDiagnostics(): WorkspaceWatcherDiagnostics {
    const entries = [...this.entries.values()].map((entry) => ({
      workspaceId: entry.record.id,
      rootPath: entry.record.rootPath,
      gitCommonDir: entry.gitCommonDir,
      watcherCount: entry.watchers.length,
      inFlight: entry.inFlight,
      pending: entry.pending,
      queued: entry.debounceTimer !== null,
      queuedRefreshCount: entry.queuedRefreshCount,
      refreshCount: entry.refreshCount,
      refreshFailureCount: entry.refreshFailureCount,
      notifyCount: entry.notifyCount,
      watcherInstallCount: entry.watcherInstallCount,
      ...(entry.lastQueuedAt === undefined ? {} : { lastQueuedAt: entry.lastQueuedAt }),
      ...(entry.lastQueuedReason === undefined ? {} : { lastQueuedReason: entry.lastQueuedReason }),
      ...(entry.lastRefreshStartedAt === undefined
        ? {}
        : { lastRefreshStartedAt: entry.lastRefreshStartedAt }),
      ...(entry.lastRefreshFinishedAt === undefined
        ? {}
        : { lastRefreshFinishedAt: entry.lastRefreshFinishedAt }),
      ...(entry.lastRefreshDurationMs === undefined
        ? {}
        : { lastRefreshDurationMs: entry.lastRefreshDurationMs }),
      ...(entry.lastRefreshOk === undefined ? {} : { lastRefreshOk: entry.lastRefreshOk }),
      ...(entry.lastRefreshReason === undefined
        ? {}
        : { lastRefreshReason: entry.lastRefreshReason }),
      ...(entry.lastNotifiedAt === undefined ? {} : { lastNotifiedAt: entry.lastNotifiedAt }),
      ...(entry.lastError === undefined ? {} : { lastError: entry.lastError }),
    }))

    return {
      trackedWorkspaces: entries.length,
      totalWatchers: entries.reduce((sum, entry) => sum + entry.watcherCount, 0),
      totalInFlight: entries.filter((entry) => entry.inFlight).length,
      totalPending: entries.filter((entry) => entry.pending).length,
      totalQueued: entries.filter((entry) => entry.queued).length,
      entries,
    }
  }

  syncWorkspaces(workspaces: readonly WorkspaceRecord[]): void {
    const ids = new Set(workspaces.map((workspace) => workspace.id))
    for (const [id, entry] of this.entries) {
      if (ids.has(id)) continue
      this.disposeEntry(entry)
      this.entries.delete(id)
    }
    for (const workspace of workspaces) this.trackWorkspace(workspace)
  }

  trackWorkspace(workspace: WorkspaceRecord): void {
    const gitCommonDir = resolveGitCommonDir(workspace)
    if (!gitCommonDir) {
      this.untrackWorkspace(workspace.id)
      return
    }

    const fingerprint = workspaceFingerprint(workspace)
    const existing = this.entries.get(workspace.id)
    if (existing) {
      const gitCommonDirChanged = existing.gitCommonDir !== gitCommonDir
      existing.record = workspace
      existing.fingerprint = fingerprint
      if (gitCommonDirChanged) {
        existing.gitCommonDir = gitCommonDir
        this.installWatchers(existing)
      }
      return
    }

    const entry: WatchEntry = {
      record: workspace,
      gitCommonDir,
      fingerprint,
      watchers: [],
      debounceTimer: null,
      inFlight: false,
      pending: false,
      queuedRefreshCount: 0,
      refreshCount: 0,
      refreshFailureCount: 0,
      notifyCount: 0,
      watcherInstallCount: 0,
      lastQueuedAt: undefined,
      lastQueuedReason: undefined,
      lastRefreshStartedAt: undefined,
      lastRefreshFinishedAt: undefined,
      lastRefreshDurationMs: undefined,
      lastRefreshOk: undefined,
      lastRefreshReason: undefined,
      lastNotifiedAt: undefined,
      lastError: undefined,
    }
    this.entries.set(workspace.id, entry)
    this.installWatchers(entry)
  }

  refreshWorkspaceSoon(workspaceId: string): void {
    const entry = this.entries.get(workspaceId)
    if (!entry) return
    this.queueRefresh(entry, 'explicit')
  }

  untrackWorkspace(workspaceId: string): void {
    const entry = this.entries.get(workspaceId)
    if (!entry) return
    this.disposeEntry(entry)
    this.entries.delete(workspaceId)
  }

  private disposeEntry(entry: WatchEntry): void {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    entry.debounceTimer = null
    for (const watcher of entry.watchers) watcher.close()
    entry.watchers = []
  }

  private installWatchers(entry: WatchEntry): void {
    for (const watcher of entry.watchers) watcher.close()
    entry.watchers = []
    entry.watcherInstallCount += 1

    const watched = new Set<string>()
    const watchDirectory = (path: string, recursive: boolean): boolean => {
      const existing = existingPath(path)
      if (!existing || watched.has(`${existing}\u0000${recursive}`)) return false

      try {
        const watcher = watch(existing, recursive ? { recursive: true } : {}, () =>
          this.queueRefresh(entry, 'fs-event'),
        )
        watcher.on('error', () => this.queueRefresh(entry, 'watcher-error'))
        entry.watchers.push(watcher)
        watched.add(`${existing}\u0000${recursive}`)
        return true
      } catch {
        return false
      }
    }

    watchDirectory(entry.gitCommonDir, false)

    const refsDir = join(entry.gitCommonDir, 'refs')
    const worktreesDir = join(entry.gitCommonDir, 'worktrees')
    const refsRecursive = watchDirectory(refsDir, true)
    const worktreesRecursive = watchDirectory(worktreesDir, true)

    // Recursive watching is not available on every platform/filesystem. Fall back
    // to watching the existing Git metadata directory tree and re-arm it after
    // every refresh so newly-created refs/worktree admin dirs are picked up.
    if (!refsRecursive || !worktreesRecursive) {
      for (const path of watchablePaths(entry.gitCommonDir)) {
        if (path === entry.gitCommonDir) continue
        if (refsRecursive && (path === refsDir || path.startsWith(`${refsDir}${sep}`))) continue
        if (
          worktreesRecursive &&
          (path === worktreesDir || path.startsWith(`${worktreesDir}${sep}`))
        ) {
          continue
        }
        watchDirectory(path, false)
      }
    }
  }

  private queueRefresh(entry: WatchEntry, reason: string): void {
    entry.queuedRefreshCount += 1
    entry.lastQueuedAt = Date.now()
    entry.lastQueuedReason = reason
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    if (this.debounceMs <= 0) {
      entry.debounceTimer = null
      void this.refresh(entry)
      return
    }
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null
      void this.refresh(entry)
    }, this.debounceMs)
    if (this.unrefDebounceTimers) unrefTimer(entry.debounceTimer)
  }

  private async refresh(entry: WatchEntry): Promise<void> {
    if (entry.inFlight) {
      entry.pending = true
      return
    }

    entry.inFlight = true
    const workspaceId = entry.record.id
    const previousFingerprint = entry.fingerprint
    const startedAt = Date.now()
    entry.refreshCount += 1
    entry.lastRefreshStartedAt = startedAt
    entry.lastRefreshReason = entry.lastQueuedReason
    entry.lastRefreshOk = undefined
    entry.lastError = undefined
    try {
      const workspace = await this.client().refreshWorkspace(workspaceId)
      if (this.entries.get(workspaceId) !== entry) {
        entry.pending = false
        this.disposeEntry(entry)
        return
      }
      const nextFingerprint = workspaceFingerprint(workspace)
      const gitCommonDir = resolveGitCommonDir(workspace)
      if (!gitCommonDir) {
        entry.pending = false
        this.untrackWorkspace(entry.record.id)
        if (nextFingerprint !== previousFingerprint) this.notifyWorkspaceChanged(workspace)
        return
      }
      entry.record = workspace
      entry.gitCommonDir = gitCommonDir
      entry.fingerprint = nextFingerprint
      this.installWatchers(entry)
      if (nextFingerprint !== previousFingerprint) {
        entry.notifyCount += 1
        entry.lastNotifiedAt = Date.now()
        this.notifyWorkspaceChanged(workspace)
      }
      entry.lastRefreshOk = true
    } catch (error) {
      entry.refreshFailureCount += 1
      entry.lastRefreshOk = false
      entry.lastError = error instanceof Error ? error.message : String(error)
      console.warn(`[git-state] Failed to refresh workspace ${entry.record.id}:`, error)
    } finally {
      const finishedAt = Date.now()
      entry.lastRefreshFinishedAt = finishedAt
      entry.lastRefreshDurationMs = finishedAt - startedAt
      entry.inFlight = false
      if (this.entries.get(workspaceId) === entry && entry.pending) {
        entry.pending = false
        this.queueRefresh(entry, 'pending')
      }
    }
  }
}
