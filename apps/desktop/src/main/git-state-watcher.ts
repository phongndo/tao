import { existsSync, readdirSync, watch, type FSWatcher } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { WorkspaceRecord } from '@tao/shared/workspace'
import type { TaodClient } from './taod-client'

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
    private readonly client: () => TaodClient,
    private readonly notifyWorkspaceChanged: (workspace: WorkspaceRecord) => void,
  ) {}

  dispose(): void {
    for (const entry of this.entries.values()) this.disposeEntry(entry)
    this.entries.clear()
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
    }
    this.entries.set(workspace.id, entry)
    this.installWatchers(entry)
  }

  refreshWorkspaceSoon(workspaceId: string): void {
    const entry = this.entries.get(workspaceId)
    if (!entry) return
    this.queueRefresh(entry)
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

    const watched = new Set<string>()
    const watchDirectory = (path: string, recursive: boolean): boolean => {
      const existing = existingPath(path)
      if (!existing || watched.has(`${existing}\u0000${recursive}`)) return false

      try {
        const watcher = watch(existing, recursive ? { recursive: true } : {}, () =>
          this.queueRefresh(entry),
        )
        watcher.on('error', () => this.queueRefresh(entry))
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

  private queueRefresh(entry: WatchEntry): void {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null
      void this.refresh(entry)
    }, GIT_REFRESH_DEBOUNCE_MS)
    unrefTimer(entry.debounceTimer)
  }

  private async refresh(entry: WatchEntry): Promise<void> {
    if (entry.inFlight) {
      entry.pending = true
      return
    }

    entry.inFlight = true
    const previousFingerprint = entry.fingerprint
    try {
      const workspace = await this.client().refreshWorkspace(entry.record.id)
      const nextFingerprint = workspaceFingerprint(workspace)
      entry.record = workspace
      entry.gitCommonDir = resolveGitCommonDir(workspace) ?? entry.gitCommonDir
      entry.fingerprint = nextFingerprint
      this.installWatchers(entry)
      if (nextFingerprint !== previousFingerprint) this.notifyWorkspaceChanged(workspace)
    } catch (error) {
      console.warn(`[git-state] Failed to refresh workspace ${entry.record.id}:`, error)
    } finally {
      entry.inFlight = false
      if (entry.pending) {
        entry.pending = false
        this.queueRefresh(entry)
      }
    }
  }
}
