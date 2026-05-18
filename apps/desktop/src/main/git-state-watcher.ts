import { existsSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { WorkspaceRecord } from '@tao/shared/workspace'
import type { TaodClient } from './taod-client'

const GIT_REFRESH_DEBOUNCE_MS = 175
const GIT_STATE_POLL_MS = 7_500

type WatchEntry = {
  record: WorkspaceRecord
  gitCommonDir: string
  fingerprint: string
  watchers: FSWatcher[]
  debounceTimer: ReturnType<typeof setTimeout> | null
  inFlight: boolean
  pending: boolean
}

function unrefTimer(timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>): void {
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

function watchablePaths(gitCommonDir: string): string[] {
  const paths = new Set<string>()
  for (const path of [
    gitCommonDir,
    join(gitCommonDir, 'HEAD'),
    join(gitCommonDir, 'packed-refs'),
    join(gitCommonDir, 'refs'),
    join(gitCommonDir, 'refs', 'heads'),
    join(gitCommonDir, 'refs', 'remotes'),
    join(gitCommonDir, 'worktrees'),
  ]) {
    const existing = existingPath(path)
    if (existing) paths.add(existing)
  }

  const worktreesDir = join(gitCommonDir, 'worktrees')
  try {
    for (const name of readdirSync(worktreesDir)) {
      const path = join(worktreesDir, name)
      if (statSync(path).isDirectory()) paths.add(path)
    }
  } catch {
    // A repository with no linked worktrees simply has no .git/worktrees dir.
  }

  return [...paths]
}

export class GitStateWatcher {
  private readonly entries = new Map<string, WatchEntry>()
  private readonly pollTimer: ReturnType<typeof setInterval>

  constructor(
    private readonly client: () => TaodClient,
    private readonly notifyWorkspaceChanged: (workspace: WorkspaceRecord) => void,
  ) {
    this.pollTimer = setInterval(() => this.poll(), GIT_STATE_POLL_MS)
    unrefTimer(this.pollTimer)
  }

  dispose(): void {
    clearInterval(this.pollTimer)
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
      this.removeWorkspace(workspace.id)
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

  private removeWorkspace(workspaceId: string): void {
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

    try {
      const watcher = watch(entry.gitCommonDir, { recursive: true }, () => this.queueRefresh(entry))
      watcher.on('error', () => this.queueRefresh(entry))
      entry.watchers.push(watcher)
      return
    } catch {
      // Recursive watching is not available on every platform/filesystem. Fall back
      // to selected Git metadata paths plus polling for correctness.
    }

    for (const path of watchablePaths(entry.gitCommonDir)) {
      try {
        const watcher = watch(path, () => this.queueRefresh(entry))
        watcher.on('error', () => this.queueRefresh(entry))
        entry.watchers.push(watcher)
      } catch {
        // The path may disappear while Git rewrites metadata; polling will catch it.
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

  private poll(): void {
    for (const entry of this.entries.values()) this.queueRefresh(entry)
  }
}
