import {
  FiAlertTriangle,
  FiChevronsDown,
  FiChevronLeft,
  FiChevronRight,
  FiChevronDown,
  FiArchive,
  FiChevronsUp,
  FiFileText,
  FiFolder,
  FiGitPullRequest,
  FiColumns,
  FiList,
  FiMaximize2,
  FiMinusSquare,
  FiPlusSquare,
  FiRefreshCw,
  FiRotateCcw,
  FiFolderPlus,
  FiPlus,
  FiSettings,
  FiTerminal,
  FiTrash2,
  FiX,
} from 'react-icons/fi'
import { TbLayoutSidebar, TbLayoutSidebarRight } from 'react-icons/tb'
import {
  Component,
  type ErrorInfo,
  type ComponentType,
  type CSSProperties,
  type DragEvent,
  memo,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Mosaic, type MosaicNode, type MosaicProps } from 'react-mosaic-component'
import { FileDiff } from '@pierre/diffs/react'
import {
  createFileTreeIconResolver,
  FileTree as PierreFileTree,
  getBuiltInSpriteSheet,
  prepareFileTreeInput,
} from '@pierre/trees'
import type { FileTreeDirectoryHandle, GitStatusEntry } from '@pierre/trees'
import type { AppCommand } from '@tao/shared/app-command'
import type { PaneLayoutData } from '@tao/shared/session'
import {
  type Pane,
  type ReorderPlacement,
  selectPaneLayoutData,
  type Tab,
  useTaoStore,
  type Workspace,
  worktreeContextId,
} from '../state/store'
import { sanitizeTerminalTitle } from '../osc-title'
import { runRendererEffect } from '../runtime'
import { WorkspaceMetadataCache } from '../workspace-service'
import { useGitBranch } from '../workspaceQueries'
import { TerminalPane } from './TerminalPane'
import { getDiffFileName, type ParsedDiffFile, type ParsedDiffResult } from '../diff-parser'
import { parseDiffFilesOffThread } from '../diff-parser-client'
import { markRendererEvent } from '../trace'
import type { WorkspaceFileTree, WorkspaceRecord } from '@tao/shared/workspace'
import type {
  TaodLifecycleDiagnostics,
  TaodLifecycleRecoveryAction,
} from '@tao/shared/taod-protocol'

const SIDEBAR_DEFAULT_WIDTH = 240
const SIDEBAR_EXPANDED_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 360
const RIGHT_SIDEBAR_MAX_WIDTH = SIDEBAR_MAX_WIDTH * 2
const SIDEBAR_KEYBOARD_RESIZE_STEP = 12
const TAB_DRAG_TYPE = 'application/x-tao-tab'
const WORKSPACE_DRAG_TYPE = 'application/x-tao-workspace'
const LAYOUT_WRITE_DEBOUNCE_MS = 150
const LEGACY_LOCAL_STORAGE_LAYOUT_KEY = 'tao-workspaces'
const EMPTY_FILE_TREE: WorkspaceFileTree = { paths: [], gitStatus: [] }
const DEFAULT_DIFF_COMPARE_BRANCH = 'main'
const DIFF_FOCUS_FILE_EVENT = 'tao:focus-diff-file'
const DIFF_AUTO_COLLAPSE_FILE_COUNT = 20
const DIFF_AUTO_COLLAPSE_PATCH_CHARS = 1024 * 1024
const DIFF_MAX_EXPANDED_FILE_BODIES = 12
const TAOD_DIAGNOSTICS_POLL_MS = 5000
const FILE_TREE_ICONS = { set: 'complete', colored: true } as const
const FILE_TREE_ICON_SPRITE = getBuiltInSpriteSheet(FILE_TREE_ICONS.set)
const FILE_TREE_ICON_RESOLVER = createFileTreeIconResolver(FILE_TREE_ICONS)
const FILE_TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: #191919;
    --trees-fg-override: #c9c7cd;
    --trees-fg-muted-override: #747783;
    --trees-bg-muted-override: #1f1f22;
    --trees-accent-override: #c9c7cd;
    --trees-border-color-override: #242428;
    --trees-focus-ring-color-override: #424246;
    --trees-focus-ring-offset-override: 0;
    --trees-font-family-override: Menlo, Monaco, 'Courier New', monospace;
    --trees-font-size-override: 12px;
    --trees-font-weight-regular-override: 700;
    --trees-font-weight-semibold-override: 700;
    --trees-border-radius-override: 0;
    --trees-level-gap-override: 9px;
    --trees-item-padding-x-override: 8px;
    --trees-item-margin-x-override: 0;
    --trees-item-row-gap-override: 7px;
    --trees-icon-width-override: 14px;
    --trees-padding-inline-override: 0;
    --trees-scrollbar-thumb-override: #424246;
    --trees-selected-bg-override: #242428;
    --trees-selected-focused-border-color-override: #424246;
    --trees-status-added-override: #90b99f;
    --trees-status-modified-override: #e6b99d;
    --trees-status-renamed-override: #aca1cf;
    --trees-status-untracked-override: #90b99f;
    --trees-status-deleted-override: #f5a191;
    --trees-git-added-color-override: #90b99f;
    --trees-git-modified-color-override: #e6b99d;
    --trees-git-renamed-color-override: #aca1cf;
    --trees-git-untracked-color-override: #90b99f;
    --trees-git-deleted-color-override: #f5a191;
    --trees-file-icon-color: #9699a8;
    --trees-file-icon-color-git: #e06c4f;
    --trees-file-icon-color-json: #e6b99d;
    --trees-file-icon-color-markdown: #90b99f;
    --trees-file-icon-color-npm: #e06c4f;
    --trees-file-icon-color-typescript: #6f8dbd;
    --trees-file-icon-color-yml: #f5a191;
  }

  [data-file-tree-virtualized-scroll='true'] {
    padding-block: 4px 10px;
  }

  [data-file-tree-search-container] {
    display: none;
  }

  [data-type='item'] {
    min-height: 26px;
    transition: background 120ms ease, color 120ms ease;
  }

  [data-type='item']:hover {
    background: #1f1f22;
  }

  [data-item-section='content'] {
    letter-spacing: 0;
  }
`

function readLegacyLocalStorageLayout(): unknown | null {
  try {
    const raw = window.localStorage?.getItem(LEGACY_LOCAL_STORAGE_LAYOUT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { state?: unknown }
    return parsed.state ?? parsed
  } catch (error) {
    console.warn('[layout] Failed to read legacy localStorage layout:', error)
    return null
  }
}

function clearLegacyLocalStorageLayout(): void {
  try {
    window.localStorage?.removeItem(LEGACY_LOCAL_STORAGE_LAYOUT_KEY)
  } catch {
    // Best-effort migration cleanup only.
  }
}

// react-mosaic-component ships React 18-era class component types that do not satisfy
// React 19's JSX constructor check. Keep the runtime component and narrow only the JSX type.
const MosaicView = Mosaic as unknown as ComponentType<MosaicProps<string>>

type ActivePaneBorderLine = {
  key: string
  className: string
  style: CSSProperties
}

type PaneBounds = {
  left: number
  top: number
  right: number
  bottom: number
}

type PaneRect = PaneBounds & {
  id: string
}

type RightSidebarView = 'files' | 'changes'
type DiffViewMode = 'unified' | 'split'
type ChangedFilesViewMode = 'tree' | 'folders'

type DiffFileTreeNode = {
  name: string
  path: string
  children: Map<string, DiffFileTreeNode>
  file?: ParsedDiffFile
}

type DiffSummary = {
  files: number
  additions: number
  deletions: number
}

type ChangedFileGroup = {
  directory: string
  files: ParsedDiffFile[]
}

type ChangedFilesSectionKind = 'base' | 'unstaged' | 'staged'

type ChangedFilesSection = {
  kind: ChangedFilesSectionKind
  label: string
  files: ParsedDiffFile[]
  error: string | null
}

type DaemonRecoveryNotice = {
  tone: 'info' | 'warning' | 'error'
  label: string
  title: string
}

type DaemonRecoveryPanelRow = {
  label: string
  value: string
  tone?: 'error'
}

type DiffPanelErrorBoundaryProps = {
  children: ReactNode
}

type DiffPanelErrorBoundaryState = {
  error: string | null
}

const PANE_BORDER_EPSILON = 0.0001

class DiffPanelErrorBoundary extends Component<
  DiffPanelErrorBoundaryProps,
  DiffPanelErrorBoundaryState
> {
  state: DiffPanelErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): DiffPanelErrorBoundaryState {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    console.warn('[diff-view] Render failed:', error, errorInfo.componentStack)
  }

  render() {
    if (this.state.error) {
      return <div className="right-sidebar-file-tree-error">{this.state.error}</div>
    }

    return this.props.children
  }
}

const FileTreeIconSprite = memo(function FileTreeIconSprite() {
  return (
    <span
      className="right-sidebar-file-tree-icon-sprite"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: FILE_TREE_ICON_SPRITE }}
    />
  )
})

function ChangedFileIcon({ path }: { path: string }) {
  const icon = FILE_TREE_ICON_RESOLVER.resolveIcon('file-tree-icon-file', path)

  return (
    <svg
      className="right-sidebar-diff-file-tree-icon"
      data-icon-token={icon.token}
      viewBox={icon.viewBox ?? '0 0 16 16'}
      width={icon.width ?? 14}
      height={icon.height ?? 14}
      aria-hidden="true"
      focusable="false"
    >
      <use href={`#${icon.name}`} />
    </svg>
  )
}

function layoutContainsPane(layout: MosaicNode<string>, paneId: string): boolean {
  if (typeof layout === 'string') return layout === paneId
  return layoutContainsPane(layout.first, paneId) || layoutContainsPane(layout.second, paneId)
}

function getFirstPaneId(layout: MosaicNode<string>): string | null {
  if (typeof layout === 'string') return layout
  return getFirstPaneId(layout.first)
}

function getPaneCount(layout: MosaicNode<string>): number {
  if (typeof layout === 'string') return 1
  return getPaneCount(layout.first) + getPaneCount(layout.second)
}

function getPaneRects(
  layout: MosaicNode<string>,
  bounds: PaneBounds = { left: 0, top: 0, right: 100, bottom: 100 },
): PaneRect[] {
  if (typeof layout === 'string') return [{ id: layout, ...bounds }]

  const split = (layout.splitPercentage ?? 50) / 100
  if (layout.direction === 'row') {
    const splitX = bounds.left + (bounds.right - bounds.left) * split
    return [
      ...getPaneRects(layout.first, { ...bounds, right: splitX }),
      ...getPaneRects(layout.second, { ...bounds, left: splitX }),
    ]
  }

  const splitY = bounds.top + (bounds.bottom - bounds.top) * split
  return [
    ...getPaneRects(layout.first, { ...bounds, bottom: splitY }),
    ...getPaneRects(layout.second, { ...bounds, top: splitY }),
  ]
}

function borderLineClassName(isActive: boolean): string {
  return [
    'active-pane-border-line',
    isActive ? 'active-pane-border-line-active' : 'active-pane-border-line-inactive',
  ].join(' ')
}

function getTwoPaneBorderLines(
  layout: MosaicNode<string>,
  activePaneId: string,
): ActivePaneBorderLine[] {
  if (typeof layout === 'string') return []

  const splitPercentage = layout.splitPercentage ?? 50
  const firstIsActive = layoutContainsPane(layout.first, activePaneId)
  const secondIsActive = layoutContainsPane(layout.second, activePaneId)
  if (!firstIsActive && !secondIsActive) return []

  // Tmux-style split ownership: for a side-by-side split, the top half of the
  // shared border belongs to the left pane and the bottom half to the right pane.
  // For a stacked split, the left half belongs to the top pane and the right half
  // to the bottom pane. That makes two-pane layouts directional instead of
  // showing the same full active divider for either focused pane.
  if (layout.direction === 'row') {
    return [
      {
        key: 'root-first',
        className: `${borderLineClassName(firstIsActive)} active-pane-border-line-vertical`,
        style: {
          top: '0%',
          left: `${splitPercentage}%`,
          height: '50%',
        },
      },
      {
        key: 'root-second',
        className: `${borderLineClassName(secondIsActive)} active-pane-border-line-vertical`,
        style: {
          top: '50%',
          left: `${splitPercentage}%`,
          height: '50%',
        },
      },
    ]
  }

  return [
    {
      key: 'root-first',
      className: `${borderLineClassName(firstIsActive)} active-pane-border-line-horizontal`,
      style: {
        top: `${splitPercentage}%`,
        left: '0%',
        width: '50%',
      },
    },
    {
      key: 'root-second',
      className: `${borderLineClassName(secondIsActive)} active-pane-border-line-horizontal`,
      style: {
        top: `${splitPercentage}%`,
        left: '50%',
        width: '50%',
      },
    },
  ]
}

function getMultiPaneBorderLines(
  layout: MosaicNode<string>,
  activePaneId: string,
): ActivePaneBorderLine[] {
  const rect = getPaneRects(layout).find((candidate) => candidate.id === activePaneId)
  if (!rect) return []

  const lines: ActivePaneBorderLine[] = []
  const top = `${rect.top}%`
  const left = `${rect.left}%`
  const width = `${rect.right - rect.left}%`
  const height = `${rect.bottom - rect.top}%`
  const className = borderLineClassName(true)

  if (rect.left > PANE_BORDER_EPSILON) {
    lines.push({
      key: 'left',
      className: `${className} active-pane-border-line-vertical`,
      style: { top, left, height },
    })
  }

  if (rect.right < 100 - PANE_BORDER_EPSILON) {
    lines.push({
      key: 'right',
      className: `${className} active-pane-border-line-vertical`,
      style: { top, left: `${rect.right}%`, height },
    })
  }

  if (rect.top > PANE_BORDER_EPSILON) {
    lines.push({
      key: 'top',
      className: `${className} active-pane-border-line-horizontal`,
      style: { top, left, width },
    })
  }

  if (rect.bottom < 100 - PANE_BORDER_EPSILON) {
    lines.push({
      key: 'bottom',
      className: `${className} active-pane-border-line-horizontal`,
      style: { top: `${rect.bottom}%`, left, width },
    })
  }

  return lines
}

function getActivePaneBorderLines(
  layout: MosaicNode<string> | null,
  activePaneId: string | null,
): ActivePaneBorderLine[] {
  if (!layout || !activePaneId) return []
  return getPaneCount(layout) === 2
    ? getTwoPaneBorderLines(layout, activePaneId)
    : getMultiPaneBorderLines(layout, activePaneId)
}

function workspaceNameFromPath(projectPath: string): string {
  return projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath
}

function workspaceInitials(name: string): string {
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? []
  const initials = words
    .slice(0, 2)
    .map((word) => word.at(0))
    .join('')
    .toUpperCase()

  return initials || name.slice(0, 2).toUpperCase() || '•'
}

function workspaceFromRecord(record: WorkspaceRecord): Workspace {
  return {
    id: record.id,
    name: record.name,
    projectPath: record.rootPath,
    branch: record.branch ?? record.defaultBranch ?? undefined,
    worktrees: [...record.worktrees],
    lastActiveTabId: record.lastActiveTabId ?? undefined,
    order: record.orderIndex,
  }
}

function activeContextPath(workspace: Workspace, activeContextId: string | null): string {
  const worktree = (workspace.worktrees ?? []).find(
    (candidate) => worktreeContextId(candidate.id) === activeContextId,
  )
  return worktree?.path ?? workspace.projectPath
}

function workspaceForContext(
  workspaces: readonly Workspace[],
  contextId: string | null,
): Workspace | null {
  if (!contextId) return null
  return (
    workspaces.find(
      (workspace) =>
        workspace.id === contextId ||
        (workspace.worktrees ?? []).some(
          (worktree) => worktreeContextId(worktree.id) === contextId,
        ),
    ) ?? null
  )
}

function activeContextCompareBranch(
  workspace: Workspace | null,
  activeContextId: string | null,
): string {
  if (!workspace) return DEFAULT_DIFF_COMPARE_BRANCH
  const worktree = (workspace.worktrees ?? []).find(
    (candidate) => worktreeContextId(candidate.id) === activeContextId,
  )
  return worktree?.baseBranch ?? DEFAULT_DIFF_COMPARE_BRANCH
}

function activeContextBranchName(
  workspace: Workspace | null,
  activeContextId: string | null,
): string {
  if (!workspace) return ''
  const worktree = (workspace.worktrees ?? []).find(
    (candidate) => worktreeContextId(candidate.id) === activeContextId,
  )
  return worktree?.branch ?? workspace.branch ?? workspace.name
}

function daemonRecoveryNotice(
  diagnostics: TaodLifecycleDiagnostics | null,
  error: string | null,
): DaemonRecoveryNotice | null {
  if (error) {
    return {
      tone: 'error',
      label: 'Daemon diagnostics unavailable',
      title: `Daemon diagnostics unavailable: ${error}`,
    }
  }
  if (!diagnostics || diagnostics.recoveryAction === 'none') return null

  const base = `state=${diagnostics.state}, owner=${diagnostics.daemonOwnership}, action=${diagnostics.recoveryAction}`
  switch (diagnostics.recoveryAction) {
    case 'reuse-external-daemon':
      return {
        tone: 'info',
        label: 'Using existing daemon',
        title: `Using existing daemon; ${base}`,
      }
    case 'keep-detached-daemon':
      return {
        tone: 'info',
        label: 'Detached daemon preserved',
        title: `Detached daemon preserved; ${base}`,
      }
    case 'wait-for-start':
    case 'start-daemon':
      return {
        tone: 'warning',
        label: 'Daemon starting',
        title: `Daemon starting; ${base}`,
      }
    case 'clear-stale-socket-and-start':
      return {
        tone: 'warning',
        label: 'Recovering stale daemon socket',
        title: `Recovering stale daemon socket; ${base}`,
      }
    case 'restart-owned-daemon':
      return {
        tone: 'warning',
        label: 'Restarting daemon',
        title: `Restarting daemon; ${base}`,
      }
    case 'replace-incompatible-daemon':
      return {
        tone: 'error',
        label: 'Daemon version mismatch',
        title: `Daemon version mismatch; ${base}`,
      }
  }
}

function formatDiagnosticsMs(value: number | undefined): string {
  return typeof value === 'number' ? `${Math.round(value)} ms` : 'none'
}

function formatDiagnosticsPid(diagnostics: TaodLifecycleDiagnostics | null): string {
  if (!diagnostics) return 'none'
  if (typeof diagnostics.spawnedPid === 'number') return String(diagnostics.spawnedPid)
  if (typeof diagnostics.releasedDetachedPid === 'number') {
    return `${diagnostics.releasedDetachedPid} released`
  }
  return diagnostics.daemonOwnership === 'external' ? 'external' : 'none'
}

function daemonRecoveryRows(
  diagnostics: TaodLifecycleDiagnostics | null,
  error: string | null,
  recoveryError: string | null,
): DaemonRecoveryPanelRow[] {
  if (!diagnostics) {
    return [
      {
        label: 'Diagnostics',
        value: recoveryError ?? error ?? 'unavailable',
        tone: recoveryError || error ? 'error' : undefined,
      },
    ]
  }

  const rows: DaemonRecoveryPanelRow[] = [
    { label: 'State', value: diagnostics.state },
    { label: 'Owner', value: diagnostics.daemonOwnership },
    { label: 'Action', value: diagnostics.recoveryAction },
    { label: 'Version', value: diagnostics.daemonVersion ?? 'unknown' },
    { label: 'Protocol', value: String(diagnostics.protocolVersion ?? 'unknown') },
    { label: 'PID', value: formatDiagnosticsPid(diagnostics) },
    { label: 'Last ping', value: formatDiagnosticsMs(diagnostics.timing.lastPingDurationMs) },
    { label: 'Last start', value: formatDiagnosticsMs(diagnostics.timing.lastStartDurationMs) },
    { label: 'Last control', value: diagnostics.lastControlRequest?.type ?? 'none' },
  ]

  if (diagnostics.lastError) {
    rows.push({ label: 'Last error', value: diagnostics.lastError, tone: 'error' })
  }
  if (error) {
    rows.push({ label: 'Poll error', value: error, tone: 'error' })
  }
  if (recoveryError) {
    rows.push({ label: 'Recovery', value: recoveryError, tone: 'error' })
  }

  return rows
}

function daemonRecoveryActionLabel(action: TaodLifecycleRecoveryAction): string | null {
  switch (action) {
    case 'start-daemon':
      return 'Start daemon'
    case 'wait-for-start':
      return 'Retry start'
    case 'clear-stale-socket-and-start':
      return 'Clear stale socket'
    case 'restart-owned-daemon':
      return 'Restart daemon'
    case 'replace-incompatible-daemon':
      return 'Replace daemon'
    case 'none':
    case 'reuse-external-daemon':
    case 'keep-detached-daemon':
      return null
  }
}

function collectDirectoryPaths(paths: readonly string[]): string[] {
  const directories = new Set<string>()

  for (const path of paths) {
    const segments = path.split('/').filter(Boolean)
    for (let index = 1; index < segments.length; index++) {
      directories.add(segments.slice(0, index).join('/'))
    }
  }

  return [...directories].sort((left, right) => right.length - left.length)
}

function summarizeParsedDiffFiles(files: readonly ParsedDiffFile[]): DiffSummary {
  return files.reduce(
    (summary, file) => ({
      files: summary.files + 1,
      additions: summary.additions + file.additions,
      deletions: summary.deletions + file.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  )
}

function useParsedDiffFiles(patch: string, idPrefix: string): ParsedDiffResult {
  const [result, setResult] = useState<ParsedDiffResult>({ files: [], error: null })

  useEffect(() => {
    let cancelled = false
    if (patch.trim().length === 0) {
      setResult({ files: [], error: null })
      return
    }

    setResult({ files: [], error: null })
    parseDiffFilesOffThread(patch, idPrefix).then(
      (nextResult) => {
        if (!cancelled) setResult(nextResult)
      },
      (error: unknown) => {
        if (!cancelled) {
          setResult({ files: [], error: error instanceof Error ? error.message : String(error) })
        }
      },
    )

    return () => {
      cancelled = true
    }
  }, [idPrefix, patch])

  return result
}

function buildDiffFileTree(files: readonly ParsedDiffFile[]): DiffFileTreeNode[] {
  const root = new Map<string, DiffFileTreeNode>()

  for (const file of files) {
    const segments = file.path.split('/').filter(Boolean)
    let siblings = root
    let currentPath = ''

    for (const [index, segment] of segments.entries()) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment
      const existing = siblings.get(segment)
      const node =
        existing ??
        ({
          name: segment,
          path: currentPath,
          children: new Map<string, DiffFileTreeNode>(),
        } satisfies DiffFileTreeNode)

      if (index === segments.length - 1) node.file = file
      siblings.set(segment, node)
      siblings = node.children
    }
  }

  return sortDiffFileTreeNodes([...root.values()])
}

function groupDiffFilesByDirectory(files: readonly ParsedDiffFile[]): ChangedFileGroup[] {
  const groups = new Map<string, ParsedDiffFile[]>()

  for (const file of files) {
    const separatorIndex = file.path.lastIndexOf('/')
    const directory = separatorIndex === -1 ? 'Root' : file.path.slice(0, separatorIndex)
    const group = groups.get(directory)
    if (group) {
      group.push(file)
    } else {
      groups.set(directory, [file])
    }
  }

  return [...groups.entries()]
    .map(([directory, groupedFiles]) => ({
      directory,
      files: [...groupedFiles].sort((left, right) =>
        getDiffFileName(left.fileDiff).localeCompare(getDiffFileName(right.fileDiff)),
      ),
    }))
    .sort((left, right) => left.directory.localeCompare(right.directory))
}

function sortDiffFileTreeNodes(nodes: DiffFileTreeNode[]): DiffFileTreeNode[] {
  return nodes
    .sort((left, right) => {
      const leftIsDirectory = left.children.size > 0 && !left.file
      const rightIsDirectory = right.children.size > 0 && !right.file
      if (leftIsDirectory !== rightIsDirectory) return leftIsDirectory ? -1 : 1
      return left.name.localeCompare(right.name)
    })
    .map((node) => ({
      ...node,
      children: new Map(
        sortDiffFileTreeNodes([...node.children.values()]).map((child) => [child.name, child]),
      ),
    }))
}

function collectDiffFileTreeDirectoryKeys(
  nodes: readonly DiffFileTreeNode[],
  sectionKind: ChangedFilesSectionKind,
): string[] {
  const keys: string[] = []

  for (const node of nodes) {
    if (node.file) continue
    keys.push(`${sectionKind}:${node.path}`)
    keys.push(...collectDiffFileTreeDirectoryKeys([...node.children.values()], sectionKind))
  }

  return keys
}

function isFileTreeDirectoryHandle(
  item: ReturnType<PierreFileTree['getItem']>,
): item is FileTreeDirectoryHandle {
  return item?.isDirectory() === true
}

function normalizeSidebarWidth(nextWidth: number, maxWidth = SIDEBAR_MAX_WIDTH): number {
  return Math.min(maxWidth, Math.max(SIDEBAR_EXPANDED_MIN_WIDTH, nextWidth))
}

function getDropPlacement(
  event: DragEvent<HTMLElement>,
  axis: 'horizontal' | 'vertical',
): ReorderPlacement {
  const rect = event.currentTarget.getBoundingClientRect()
  const midpoint = axis === 'horizontal' ? rect.left + rect.width / 2 : rect.top + rect.height / 2
  const pointer = axis === 'horizontal' ? event.clientX : event.clientY

  return pointer > midpoint ? 'after' : 'before'
}

function dataTransferHasType(dataTransfer: DataTransfer, type: string): boolean {
  return Array.from(dataTransfer.types).includes(type)
}

function WorkspaceItem({
  workspace,
  onReorderWorkspace,
}: {
  workspace: Workspace
  onReorderWorkspace(
    workspaceId: string,
    targetWorkspaceId: string,
    placement: ReorderPlacement,
  ): void
}) {
  const activeWorkspaceId = useTaoStore((state) => state.activeWorkspaceId)
  const selectWorkspace = useTaoStore((state) => state.selectWorkspace)
  const selectWorktree = useTaoStore((state) => state.selectWorktree)
  const upsertWorkspace = useTaoStore((state) => state.upsertWorkspace)
  const upsertWorktree = useTaoStore((state) => state.upsertWorktree)
  const removeWorktree = useTaoStore((state) => state.removeWorktree)
  const removeWorkspace = useTaoStore((state) => state.removeWorkspace)
  const [isCreatingWorktree, setIsCreatingWorktree] = useState(false)
  const [isExpanded, setIsExpanded] = useState(true)
  const [worktreeError, setWorktreeError] = useState<string | null>(null)
  const isActive = activeWorkspaceId === workspace.id
  const hasActiveWorktree = (workspace.worktrees ?? []).some(
    (worktree) => activeWorkspaceId === worktreeContextId(worktree.id),
  )
  const branch = useGitBranch(workspace.projectPath, isExpanded || isActive || hasActiveWorktree)
  const branchLabel = branch.isError
    ? 'git error'
    : (branch.data ?? (branch.isLoading ? 'loading' : 'no git branch'))
  const label = `${workspace.name} — local branch ${branchLabel}`

  async function handleCreateWorktree() {
    if (isCreatingWorktree) return
    setIsCreatingWorktree(true)
    setWorktreeError(null)
    setIsExpanded(true)
    try {
      const workspaceResponse = await window.electronAPI.addWorkspace({
        rootPath: workspace.projectPath,
        workspaceId: workspace.id,
        name: workspace.name,
        orderIndex: workspace.order,
      })
      if (!workspaceResponse.ok) {
        setWorktreeError(workspaceResponse.error.message)
        console.warn('[worktree] Failed to register workspace:', workspaceResponse.error.message)
        return
      }

      upsertWorkspace(workspaceFromRecord(workspaceResponse.value))

      const response = await window.electronAPI.createWorktree({
        workspaceId: workspaceResponse.value.id,
      })
      if (!response.ok) {
        setWorktreeError(response.error.message)
        console.warn('[worktree] Failed to create worktree:', response.error.message)
        return
      }
      setIsExpanded(true)
      upsertWorktree(workspaceResponse.value.id, response.value)
      selectWorktree(response.value.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setWorktreeError(message)
      console.warn('[worktree] Failed to create worktree:', error)
    } finally {
      setIsCreatingWorktree(false)
    }
  }

  async function handleRemoveWorktree(worktreeId: string) {
    try {
      const response = await window.electronAPI.removeWorktree({ worktreeId })
      if (!response.ok) {
        setWorktreeError(response.error.message)
        console.warn('[worktree] Failed to remove worktree:', response.error.message)
        return
      }
      removeWorktree(workspace.id, worktreeId)
      setWorktreeError(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setWorktreeError(message)
      console.warn('[worktree] Failed to remove worktree:', error)
    }
  }

  async function handleRemoveWorkspace() {
    try {
      const response = await window.electronAPI.removeWorkspace(workspace.id)
      if (!response.ok) {
        setWorktreeError(response.error.message)
        console.warn('[workspace] Failed to remove workspace:', response.error.message)
        return
      }
      removeWorkspace(workspace.id)
      setWorktreeError(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setWorktreeError(message)
      console.warn('[workspace] Failed to remove workspace:', error)
    }
  }

  return (
    <div className="workspace-group">
      <div
        className="workspace-item"
        draggable
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData(WORKSPACE_DRAG_TYPE, workspace.id)
          event.dataTransfer.setData('text/plain', workspace.id)
        }}
        onDragOver={(event) => {
          if (!dataTransferHasType(event.dataTransfer, WORKSPACE_DRAG_TYPE)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
        }}
        onDrop={(event) => {
          const workspaceId = event.dataTransfer.getData(WORKSPACE_DRAG_TYPE)
          if (!workspaceId || workspaceId === workspace.id) return
          event.preventDefault()
          onReorderWorkspace(workspaceId, workspace.id, getDropPlacement(event, 'vertical'))
        }}
      >
        <button
          type="button"
          className="workspace-select-button workspace-dropdown-button"
          onClick={() => setIsExpanded((expanded) => !expanded)}
          aria-expanded={isExpanded}
          aria-label={label}
          title={label}
        >
          <span className="workspace-avatar" aria-hidden="true">
            {workspaceInitials(workspace.name)}
          </span>
          <span className="workspace-details">
            <span className="workspace-title">{workspace.name}</span>
            <FiChevronRight
              className={
                isExpanded ? 'workspace-chevron workspace-chevron-expanded' : 'workspace-chevron'
              }
              size={13}
            />
          </span>
        </button>
        <button
          type="button"
          className="icon-button workspace-worktree-button"
          aria-label={`New worktree for ${workspace.name}`}
          title="New Worktree"
          disabled={isCreatingWorktree}
          onClick={(event) => {
            event.stopPropagation()
            void handleCreateWorktree()
          }}
        >
          <FiPlus size={13} />
        </button>
        <button
          type="button"
          className="icon-button workspace-danger-button"
          aria-label={`Remove ${workspace.name}`}
          title="Remove workspace"
          onClick={(event) => {
            event.stopPropagation()
            void handleRemoveWorkspace()
          }}
        >
          <FiTrash2 size={13} />
        </button>
      </div>
      {isExpanded ? (
        <div className="workspace-branch-list">
          <button
            type="button"
            className={isActive ? 'local-branch-row local-branch-row-active' : 'local-branch-row'}
            aria-pressed={isActive}
            title={`Local checkout — ${branchLabel}`}
            onClick={() => selectWorkspace(workspace.id)}
          >
            <span className="worktree-details">
              <span className="worktree-title">{branchLabel}</span>
            </span>
          </button>
          {(workspace.worktrees ?? []).map((worktree) => {
            const isWorktreeActive = activeWorkspaceId === worktreeContextId(worktree.id)
            const title = worktree.branch
            return (
              <div
                key={worktree.id}
                className={isWorktreeActive ? 'worktree-row worktree-row-active' : 'worktree-row'}
              >
                <button
                  type="button"
                  className="worktree-item"
                  aria-pressed={isWorktreeActive}
                  title={`${title} — ${worktree.branch}`}
                  onClick={() => selectWorktree(worktree.id)}
                >
                  <span className="worktree-details">
                    <span className="worktree-title">{title}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-button worktree-danger-button"
                  aria-label={`Remove ${title}`}
                  title="Remove worktree"
                  onClick={() => void handleRemoveWorktree(worktree.id)}
                >
                  <FiTrash2 size={11} />
                </button>
              </div>
            )
          })}
          {worktreeError ? <div className="worktree-error">{worktreeError}</div> : null}
        </div>
      ) : null}
    </div>
  )
}

function ResizeShell({
  children,
  width,
  side = 'left',
  className = 'tao-sidebar',
  ariaLabel = 'Workspaces',
  onResize,
  onResizePreview,
}: {
  children: ReactNode
  width: number
  side?: 'left' | 'right'
  className?: string
  ariaLabel?: string
  onResize(width: number): void
  onResizePreview?(width: number | null): void
}) {
  const [isResizing, setIsResizing] = useState(false)
  const [draftWidth, setDraftWidth] = useState<number | null>(null)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)
  const currentWidthRef = useRef(width)
  const pendingWidthRef = useRef<number | null>(null)
  const frameRef = useRef<number | null>(null)
  const displayWidth = draftWidth ?? width
  const maxWidth = side === 'right' ? RIGHT_SIDEBAR_MAX_WIDTH : SIDEBAR_MAX_WIDTH

  useEffect(() => {
    if (!isResizing) currentWidthRef.current = width
  }, [isResizing, width])

  const flushPendingWidth = useCallback(() => {
    const nextWidth = pendingWidthRef.current
    pendingWidthRef.current = null
    if (nextWidth === null) return
    const clampedWidth = normalizeSidebarWidth(nextWidth, maxWidth)
    currentWidthRef.current = clampedWidth
    setDraftWidth(clampedWidth)
    onResizePreview?.(clampedWidth)
  }, [maxWidth, onResizePreview])

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      if (!isResizing) return

      const deltaX = event.clientX - startXRef.current
      pendingWidthRef.current = startWidthRef.current + (side === 'left' ? deltaX : -deltaX)
      if (frameRef.current !== null) return

      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null
        flushPendingWidth()
      })
    },
    [flushPendingWidth, isResizing, side],
  )

  const handlePointerUp = useCallback(() => {
    if (!isResizing) return

    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    flushPendingWidth()
    onResize(currentWidthRef.current)
    setDraftWidth(null)
    setIsResizing(false)
  }, [flushPendingWidth, isResizing, onResize])

  useEffect(() => {
    if (!isResizing) return

    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp)
    document.addEventListener('pointercancel', handlePointerUp)
    document.body.classList.add('sidebar-resizing')

    return () => {
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', handlePointerUp)
      document.removeEventListener('pointercancel', handlePointerUp)
      document.body.classList.remove('sidebar-resizing')
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      pendingWidthRef.current = null
      onResizePreview?.(null)
    }
  }, [handlePointerMove, handlePointerUp, isResizing, onResizePreview])

  const resizeHandle = (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={SIDEBAR_EXPANDED_MIN_WIDTH}
      aria-valuemax={maxWidth}
      aria-valuenow={displayWidth}
      aria-label="Resize sidebar"
      tabIndex={0}
      className={[
        'resize-handle',
        side === 'right' ? 'resize-handle-right' : null,
        isResizing ? 'resize-handle-active' : null,
      ]
        .filter(Boolean)
        .join(' ')}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        const normalizedWidth = normalizeSidebarWidth(width, maxWidth)
        startXRef.current = event.clientX
        startWidthRef.current = normalizedWidth
        currentWidthRef.current = normalizedWidth
        setDraftWidth(normalizedWidth)
        onResizePreview?.(normalizedWidth)
        setIsResizing(true)
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          onResize(
            normalizeSidebarWidth(
              displayWidth +
                (side === 'left' ? -SIDEBAR_KEYBOARD_RESIZE_STEP : SIDEBAR_KEYBOARD_RESIZE_STEP),
              maxWidth,
            ),
          )
          return
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          onResize(
            normalizeSidebarWidth(
              displayWidth +
                (side === 'left' ? SIDEBAR_KEYBOARD_RESIZE_STEP : -SIDEBAR_KEYBOARD_RESIZE_STEP),
              maxWidth,
            ),
          )
          return
        }
        if (event.key === 'Home') {
          event.preventDefault()
          onResize(SIDEBAR_EXPANDED_MIN_WIDTH)
          return
        }
        if (event.key === 'End') {
          event.preventDefault()
          onResize(maxWidth)
          return
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onResize(SIDEBAR_DEFAULT_WIDTH)
        }
      }}
      onDoubleClick={() => onResize(SIDEBAR_DEFAULT_WIDTH)}
    />
  )
  return (
    <aside className={className} style={{ width: displayWidth }} aria-label={ariaLabel}>
      {children}
      {resizeHandle}
    </aside>
  )
}

const TabBar = memo(function TabBar({
  tabs,
  activeTabId,
  showHeaderNavigation,
  isSidebarVisible,
  canGoPreviousWorkspace,
  canGoNextWorkspace,
  tabLabelsById,
  onToggleSidebar,
  onPreviousWorkspace,
  onNextWorkspace,
  onSelectTab,
  onCloseTab,
  onReorderTab,
  archivedTabIds,
}: {
  tabs: Tab[]
  activeTabId: string | null
  showHeaderNavigation: boolean
  isSidebarVisible: boolean
  canGoPreviousWorkspace: boolean
  canGoNextWorkspace: boolean
  tabLabelsById: ReadonlyMap<string, string>
  onToggleSidebar(): void
  onPreviousWorkspace(): void
  onNextWorkspace(): void
  onSelectTab(tabId: string): void
  onCloseTab(tabId: string): void
  onReorderTab(tabId: string, targetTabId: string, placement: ReorderPlacement): void
  archivedTabIds: ReadonlySet<string>
}) {
  return (
    <div className="tab-bar">
      {showHeaderNavigation ? (
        <HeaderNavigation
          isSidebarVisible={isSidebarVisible}
          canGoPreviousWorkspace={canGoPreviousWorkspace}
          canGoNextWorkspace={canGoNextWorkspace}
          onToggleSidebar={onToggleSidebar}
          onPreviousWorkspace={onPreviousWorkspace}
          onNextWorkspace={onNextWorkspace}
        />
      ) : null}
      <div className="tab-list" role="tablist" aria-label="Terminal tabs">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId
          const isArchived = archivedTabIds.has(tab.id)
          const tabLabel = tabLabelsById.get(tab.id) ?? tab.name
          const className = [
            'tab-item',
            isActive ? 'tab-item-active' : null,
            isArchived ? 'tab-item-archived' : null,
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <div
              className={className}
              key={tab.id}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData(TAB_DRAG_TYPE, tab.id)
                event.dataTransfer.setData('text/plain', tab.id)
              }}
              onDragOver={(event) => {
                if (!dataTransferHasType(event.dataTransfer, TAB_DRAG_TYPE)) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(event) => {
                const tabId = event.dataTransfer.getData(TAB_DRAG_TYPE)
                if (!tabId || tabId === tab.id) return
                event.preventDefault()
                onReorderTab(tabId, tab.id, getDropPlacement(event, 'horizontal'))
              }}
            >
              <button
                type="button"
                className="tab-select-button"
                role="tab"
                aria-selected={isActive}
                title={
                  isArchived ? `${tabLabel} — contains a read-only archived session` : tabLabel
                }
                onClick={() => onSelectTab(tab.id)}
              >
                <span>{tabLabel}</span>
                {isArchived ? (
                  <span className="tab-archive-pill" aria-label="Read-only archive">
                    <FiArchive size={10} />
                    Archive
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                className="tab-close-button"
                aria-label={`Close ${tabLabel}`}
                title="Close tab"
                onClick={() => onCloseTab(tab.id)}
              >
                <FiX size={12} />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
})

const HeaderNavigation = memo(function HeaderNavigation({
  isSidebarVisible,
  canGoPreviousWorkspace,
  canGoNextWorkspace,
  onToggleSidebar,
  onPreviousWorkspace,
  onNextWorkspace,
}: {
  isSidebarVisible: boolean
  canGoPreviousWorkspace: boolean
  canGoNextWorkspace: boolean
  onToggleSidebar(): void
  onPreviousWorkspace(): void
  onNextWorkspace(): void
}) {
  return (
    <div className="titlebar-navigation">
      <button
        type="button"
        className="icon-button titlebar-button"
        aria-label={isSidebarVisible ? 'Hide left sidebar' : 'Show left sidebar'}
        title={isSidebarVisible ? 'Hide left sidebar' : 'Show left sidebar'}
        onClick={onToggleSidebar}
      >
        <TbLayoutSidebar size={16} />
      </button>
      <button
        type="button"
        className="icon-button titlebar-button"
        aria-label="Previous workspace"
        title="Previous workspace"
        disabled={!canGoPreviousWorkspace}
        onClick={onPreviousWorkspace}
      >
        <FiChevronLeft size={15} />
      </button>
      <button
        type="button"
        className="icon-button titlebar-button"
        aria-label="Next workspace"
        title="Next workspace"
        disabled={!canGoNextWorkspace}
        onClick={onNextWorkspace}
      >
        <FiChevronRight size={15} />
      </button>
    </div>
  )
})

const DaemonRecoveryIndicator = memo(function DaemonRecoveryIndicator({
  notice,
  diagnostics,
  diagnosticsError,
  recoveryError,
  isRecovering,
  isOpen,
  onToggle,
  onRecover,
}: {
  notice: DaemonRecoveryNotice | null
  diagnostics: TaodLifecycleDiagnostics | null
  diagnosticsError: string | null
  recoveryError: string | null
  isRecovering: boolean
  isOpen: boolean
  onToggle(): void
  onRecover(action: TaodLifecycleRecoveryAction): void
}) {
  if (!notice) return null
  const rows = daemonRecoveryRows(diagnostics, diagnosticsError, recoveryError)
  const action = diagnostics?.recoveryAction ?? null
  const actionLabel = action ? daemonRecoveryActionLabel(action) : null

  return (
    <div className="daemon-recovery-host">
      <button
        type="button"
        className={`icon-button daemon-recovery-indicator daemon-recovery-indicator-${notice.tone}`}
        aria-label={notice.label}
        aria-expanded={isOpen}
        title={notice.title}
        onClick={onToggle}
      >
        <FiAlertTriangle size={13} />
      </button>
      {isOpen ? (
        <div className={`daemon-recovery-panel daemon-recovery-panel-${notice.tone}`}>
          <div className="daemon-recovery-panel-header">{notice.label}</div>
          <div className="daemon-recovery-panel-rows">
            {rows.map((row) => (
              <div className="daemon-recovery-panel-row" key={row.label}>
                <span className="daemon-recovery-panel-label">{row.label}</span>
                <span
                  className={[
                    'daemon-recovery-panel-value',
                    row.tone ? `daemon-recovery-panel-value-${row.tone}` : null,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  title={row.value}
                >
                  {row.value}
                </span>
              </div>
            ))}
          </div>
          {action && actionLabel ? (
            <button
              type="button"
              className="daemon-recovery-action-button"
              disabled={isRecovering}
              onClick={() => onRecover(action)}
            >
              {isRecovering ? 'Working...' : actionLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})

const settingsNavItems = ['General', 'Appearance', 'Agent'] as const
type SettingsSection = (typeof settingsNavItems)[number]

const SettingsPage = memo(function SettingsPage({ onBack }: { onBack(): void }) {
  const [activeSection, setActiveSection] = useState<SettingsSection>('General')

  return (
    <section className="settings-page" aria-label="Settings">
      <div className="settings-titlebar" aria-hidden="true" />
      <aside className="settings-nav" aria-label="Settings sections">
        <button type="button" className="settings-back-link" onClick={onBack}>
          <FiChevronLeft size={14} />
          <span>Back to app</span>
        </button>
        <nav className="settings-nav-list">
          {settingsNavItems.map((item) => (
            <button
              type="button"
              key={item}
              onClick={() => setActiveSection(item)}
              className={
                item === activeSection
                  ? 'settings-nav-item settings-nav-item-active'
                  : 'settings-nav-item'
              }
              aria-current={item === activeSection ? 'page' : undefined}
            >
              {item}
            </button>
          ))}
        </nav>
      </aside>
      <main className="settings-main">
        <div className="settings-main-inner">
          <header className="settings-main-header">
            <button type="button" className="settings-mobile-back-link" onClick={onBack}>
              <FiChevronLeft size={14} />
              <span>Back to app</span>
            </button>
            <h1>{activeSection}</h1>
            <nav className="settings-mobile-nav-list" aria-label="Settings sections">
              {settingsNavItems.map((item) => (
                <button
                  type="button"
                  key={item}
                  onClick={() => setActiveSection(item)}
                  className={
                    item === activeSection
                      ? 'settings-mobile-nav-item settings-mobile-nav-item-active'
                      : 'settings-mobile-nav-item'
                  }
                  aria-current={item === activeSection ? 'page' : undefined}
                >
                  {item}
                </button>
              ))}
            </nav>
          </header>
        </div>
      </main>
    </section>
  )
})

const RightSidebar = memo(function RightSidebar({
  rootPath,
  branchName,
  compareBranch,
  view,
  onSelectView,
  onOpenChangesTab,
}: {
  rootPath: string | null
  branchName: string
  compareBranch: string
  view: RightSidebarView
  onSelectView(view: RightSidebarView): void
  onOpenChangesTab(): void
}) {
  return (
    <>
      <div className="right-sidebar-header">
        <div className="right-sidebar-view-tabs" role="tablist" aria-label="Right sidebar view">
          <button
            type="button"
            className={
              view === 'files'
                ? 'right-sidebar-view-tab right-sidebar-view-tab-active'
                : 'right-sidebar-view-tab'
            }
            role="tab"
            aria-selected={view === 'files'}
            title="Files"
            onClick={() => onSelectView('files')}
          >
            <FiFileText size={12} />
            <span>Files</span>
          </button>
          <button
            type="button"
            className={
              view === 'changes'
                ? 'right-sidebar-view-tab right-sidebar-view-tab-active'
                : 'right-sidebar-view-tab'
            }
            role="tab"
            aria-selected={view === 'changes'}
            title="Changes"
            onClick={() => onSelectView('changes')}
          >
            <FiGitPullRequest size={12} />
            <span>Changes</span>
          </button>
        </div>
      </div>
      <div className="right-sidebar-content">
        {view === 'files' ? (
          <WorkspaceFileTreePanel rootPath={rootPath} />
        ) : (
          <ChangedFilesTreePanel
            rootPath={rootPath}
            branchName={branchName}
            compareBranch={compareBranch}
            onOpenChangesTab={onOpenChangesTab}
          />
        )}
      </div>
    </>
  )
})

function WorkspaceFileTreePanel({ rootPath }: { rootPath: string | null }) {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const treeRef = useRef<PierreFileTree | null>(null)
  const [fileTree, setFileTree] = useState<WorkspaceFileTree>(EMPTY_FILE_TREE)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [areAllFoldersCollapsed, setAreAllFoldersCollapsed] = useState(true)

  const refreshFileTree = useCallback(() => {
    if (!rootPath) {
      setFileTree(EMPTY_FILE_TREE)
      setError(null)
      setIsLoading(false)
      return
    }

    let cancelled = false
    setIsLoading(true)
    setError(null)

    window.electronAPI
      .getWorkspaceFileTree(rootPath)
      .then((response) => {
        if (cancelled) return
        if (response.ok) {
          setFileTree(response.value)
          return
        }
        setFileTree(EMPTY_FILE_TREE)
        setError(response.error.message)
      })
      .catch((loadError: unknown) => {
        if (cancelled) return
        setFileTree(EMPTY_FILE_TREE)
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [rootPath])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const tree = new PierreFileTree({
      density: 'compact',
      flattenEmptyDirectories: true,
      initialExpansion: 0,
      itemHeight: 26,
      icons: FILE_TREE_ICONS,
      paths: [],
      search: false,
      gitStatus: [],
      unsafeCSS: FILE_TREE_UNSAFE_CSS,
    })

    try {
      tree.render({ containerWrapper: mount })
      treeRef.current = tree
      setRenderError(null)
    } catch (renderErrorValue) {
      tree.cleanUp()
      setRenderError(
        renderErrorValue instanceof Error ? renderErrorValue.message : String(renderErrorValue),
      )
      console.warn('[file-tree] Mount failed:', renderErrorValue)
      return
    }

    return () => {
      treeRef.current = null
      tree.cleanUp()
      mount.replaceChildren()
    }
  }, [])

  useEffect(() => refreshFileTree(), [refreshFileTree])

  useEffect(() => {
    const tree = treeRef.current
    if (!tree) return

    try {
      const preparedInput = prepareFileTreeInput(fileTree.paths, {
        flattenEmptyDirectories: true,
      })
      tree.resetPaths(fileTree.paths, { preparedInput })
      tree.setGitStatus(fileTree.gitStatus as readonly GitStatusEntry[])
      setAreAllFoldersCollapsed(true)
      setRenderError(null)
    } catch (updateErrorValue) {
      setRenderError(
        updateErrorValue instanceof Error ? updateErrorValue.message : String(updateErrorValue),
      )
      console.warn('[file-tree] Update failed:', updateErrorValue)
    }
  }, [fileTree])

  const collapseAll = useCallback(() => {
    const tree = treeRef.current
    if (!tree) return

    try {
      for (const path of collectDirectoryPaths(fileTree.paths)) {
        const item = tree.getItem(path)
        if (isFileTreeDirectoryHandle(item)) item.collapse()
      }
      setAreAllFoldersCollapsed(true)
      setRenderError(null)
    } catch (collapseErrorValue) {
      setRenderError(
        collapseErrorValue instanceof Error
          ? collapseErrorValue.message
          : String(collapseErrorValue),
      )
      console.warn('[file-tree] Collapse failed:', collapseErrorValue)
    }
  }, [fileTree.paths])

  const expandAll = useCallback(() => {
    const tree = treeRef.current
    if (!tree) return

    try {
      for (const path of collectDirectoryPaths(fileTree.paths)) {
        const item = tree.getItem(path)
        if (isFileTreeDirectoryHandle(item)) item.expand()
      }
      setAreAllFoldersCollapsed(false)
      setRenderError(null)
    } catch (expandErrorValue) {
      setRenderError(
        expandErrorValue instanceof Error ? expandErrorValue.message : String(expandErrorValue),
      )
      console.warn('[file-tree] Expand failed:', expandErrorValue)
    }
  }, [fileTree.paths])

  const toggleAllFolders = useCallback(() => {
    if (areAllFoldersCollapsed) {
      expandAll()
    } else {
      collapseAll()
    }
  }, [areAllFoldersCollapsed, collapseAll, expandAll])

  return (
    <div className="right-sidebar-file-tree">
      <div className="right-sidebar-file-tree-toolbar">
        <div className="right-sidebar-file-tree-title">Explorer</div>
        <div className="right-sidebar-file-tree-actions">
          <button
            type="button"
            className="icon-button right-sidebar-tree-action-button"
            aria-label={areAllFoldersCollapsed ? 'Expand all folders' : 'Collapse all folders'}
            title={areAllFoldersCollapsed ? 'Expand all folders' : 'Collapse all folders'}
            disabled={!rootPath || fileTree.paths.length === 0}
            onClick={toggleAllFolders}
          >
            {areAllFoldersCollapsed ? <FiChevronsDown size={12} /> : <FiChevronsUp size={12} />}
          </button>
          <button
            type="button"
            className="icon-button right-sidebar-tree-action-button"
            aria-label="Refresh file tree"
            title="Refresh file tree"
            disabled={!rootPath || isLoading}
            onClick={() => refreshFileTree()}
          >
            <FiRefreshCw size={12} />
          </button>
        </div>
      </div>
      {renderError ? <div className="right-sidebar-file-tree-error">{renderError}</div> : null}
      {error ? <div className="right-sidebar-file-tree-error">{error}</div> : null}
      {!rootPath ? <div className="right-sidebar-file-tree-message">Select a workspace</div> : null}
      {rootPath && !isLoading && !error && !renderError && fileTree.paths.length === 0 ? (
        <div className="right-sidebar-file-tree-message">No files</div>
      ) : null}
      <div
        ref={mountRef}
        className="right-sidebar-file-tree-mount"
        aria-label="Workspace file tree"
      />
    </div>
  )
}

function DiffBranchPicker({
  rootPath,
  branchName,
  compareBranch,
  onCompareBranchChange,
}: {
  rootPath: string | null
  branchName: string
  compareBranch: string
  onCompareBranchChange(branch: string): void
}) {
  const [branchSearch, setBranchSearch] = useState(compareBranch)
  const [isBranchPickerOpen, setIsBranchPickerOpen] = useState(false)
  const [isBranchSearchFresh, setIsBranchSearchFresh] = useState(false)
  const [highlightedBranchIndex, setHighlightedBranchIndex] = useState(0)
  const [branchOptions, setBranchOptions] = useState<readonly string[]>([])
  const [isLoadingBranches, setIsLoadingBranches] = useState(false)

  useEffect(() => {
    setBranchSearch(compareBranch)
  }, [compareBranch])

  useEffect(() => {
    if (!rootPath) {
      setBranchOptions([])
      setIsLoadingBranches(false)
      return
    }

    let cancelled = false
    setIsLoadingBranches(true)

    window.electronAPI
      .getGitBranches(rootPath)
      .then((response) => {
        if (cancelled) return
        setBranchOptions(response.ok ? response.value : [])
      })
      .catch(() => {
        if (!cancelled) setBranchOptions([])
      })
      .finally(() => {
        if (!cancelled) setIsLoadingBranches(false)
      })

    return () => {
      cancelled = true
    }
  }, [rootPath])

  const compareBranchOptions = branchOptions.includes(compareBranch)
    ? branchOptions
    : compareBranch
      ? [compareBranch, ...branchOptions]
      : branchOptions
  const filteredBranchOptions = useMemo(() => {
    const query = branchSearch.trim().toLowerCase()
    if (query.length === 0) return compareBranchOptions
    return compareBranchOptions.filter((branch) => branch.toLowerCase().includes(query))
  }, [branchSearch, compareBranchOptions])
  const selectCompareBranch = useCallback(
    (branch: string) => {
      onCompareBranchChange(branch)
      setBranchSearch(branch)
      setIsBranchPickerOpen(false)
      setIsBranchSearchFresh(false)
      setHighlightedBranchIndex(0)
    },
    [onCompareBranchChange],
  )
  const commitBranchSearch = useCallback(() => {
    const branch = filteredBranchOptions[highlightedBranchIndex] ?? filteredBranchOptions[0]
    if (branch) {
      selectCompareBranch(branch)
      return
    }
    if (branchSearch.trim().length > 0) {
      selectCompareBranch(branchSearch.trim())
    }
  }, [branchSearch, filteredBranchOptions, highlightedBranchIndex, selectCompareBranch])

  return (
    <div className="right-sidebar-diff-branch-row">
      <FiGitPullRequest size={13} />
      <span className="right-sidebar-diff-branch-name" title={branchName}>
        {branchName || 'No branch'}
      </span>
      <span className="right-sidebar-diff-branch-from">from</span>
      <div className="right-sidebar-diff-branch-picker">
        <input
          className="right-sidebar-diff-branch-base-input"
          aria-label="Compare branch"
          aria-controls="right-sidebar-diff-branch-options"
          aria-autocomplete="list"
          value={branchSearch}
          disabled={!rootPath || isLoadingBranches}
          placeholder={isLoadingBranches ? 'Loading branches...' : 'Search branches...'}
          onChange={(event) => {
            setBranchSearch(event.currentTarget.value)
            setIsBranchSearchFresh(false)
            setIsBranchPickerOpen(true)
            setHighlightedBranchIndex(0)
          }}
          onFocus={() => {
            setIsBranchPickerOpen(true)
            setBranchSearch('')
            setIsBranchSearchFresh(true)
            setHighlightedBranchIndex(0)
          }}
          onPointerDown={() => {
            if (!isBranchPickerOpen) {
              setBranchSearch('')
              setIsBranchSearchFresh(true)
              setHighlightedBranchIndex(0)
            }
          }}
          onBlur={() => {
            window.setTimeout(() => {
              setIsBranchPickerOpen(false)
              setBranchSearch(compareBranch)
              setIsBranchSearchFresh(false)
              setHighlightedBranchIndex(0)
            }, 100)
          }}
          onKeyDown={(event) => {
            if (isBranchSearchFresh && event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
              setBranchSearch('')
              setIsBranchSearchFresh(false)
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setIsBranchPickerOpen(true)
              setHighlightedBranchIndex((current) =>
                Math.min(current + 1, Math.max(filteredBranchOptions.length - 1, 0)),
              )
              return
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setHighlightedBranchIndex((current) => Math.max(current - 1, 0))
              return
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              if (isBranchPickerOpen || branchSearch !== compareBranch) {
                event.preventDefault()
                commitBranchSearch()
              }
            }
            if (event.key === 'Escape') {
              setIsBranchPickerOpen(false)
              setBranchSearch(compareBranch)
              setIsBranchSearchFresh(false)
              setHighlightedBranchIndex(0)
            }
          }}
        />
        <button
          type="button"
          className="icon-button right-sidebar-diff-branch-picker-button"
          aria-label="Show branches"
          title="Show branches"
          disabled={!rootPath || isLoadingBranches}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setIsBranchPickerOpen((current) => !current)}
        >
          <FiChevronDown size={12} />
        </button>
        {isBranchPickerOpen ? (
          <div id="right-sidebar-diff-branch-options" className="right-sidebar-diff-branch-options">
            {filteredBranchOptions.length > 0 ? (
              filteredBranchOptions.slice(0, 40).map((branch, index) => (
                <button
                  key={branch}
                  type="button"
                  className={
                    index === highlightedBranchIndex
                      ? 'right-sidebar-diff-branch-option right-sidebar-diff-branch-option-active'
                      : 'right-sidebar-diff-branch-option'
                  }
                  onMouseEnter={() => setHighlightedBranchIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectCompareBranch(branch)}
                >
                  {branch}
                </button>
              ))
            ) : (
              <div className="right-sidebar-diff-branch-empty">No matching branches</div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function ChangedFilesTreePanel({
  rootPath,
  branchName,
  compareBranch,
  onOpenChangesTab,
}: {
  rootPath: string | null
  branchName: string
  compareBranch: string
  onOpenChangesTab(): void
}) {
  const [basePatch, setBasePatch] = useState('')
  const [unstagedPatch, setUnstagedPatch] = useState('')
  const [stagedPatch, setStagedPatch] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isMutatingPath, setIsMutatingPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [focusedPath, setFocusedPath] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ChangedFilesViewMode>('folders')
  const [compareBranchInput, setCompareBranchInput] = useState(compareBranch)
  const [collapsedTreeDirectoryKeys, setCollapsedTreeDirectoryKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<ChangedFilesSectionKind>>(
    () => new Set(),
  )

  useEffect(() => {
    setCompareBranchInput(compareBranch)
  }, [compareBranch])

  const refreshDiffPatch = useCallback(() => {
    if (!rootPath) {
      setBasePatch('')
      setUnstagedPatch('')
      setStagedPatch('')
      setError(null)
      setIsLoading(false)
      return
    }

    let cancelled = false
    setIsLoading(true)
    setError(null)

    Promise.all([
      window.electronAPI.getWorkspaceDiffPatch({
        workspacePath: rootPath,
        scope: 'all',
        compareBranch: compareBranchInput || undefined,
      }),
      window.electronAPI.getWorkspaceDiffPatch({
        workspacePath: rootPath,
        scope: 'unstaged',
        compareBranch: compareBranchInput || undefined,
      }),
      window.electronAPI.getWorkspaceDiffPatch({
        workspacePath: rootPath,
        scope: 'staged',
        compareBranch: compareBranchInput || undefined,
      }),
    ])
      .then(([baseResponse, unstagedResponse, stagedResponse]) => {
        if (cancelled) return
        if (baseResponse.ok && unstagedResponse.ok && stagedResponse.ok) {
          setBasePatch(baseResponse.value)
          setUnstagedPatch(unstagedResponse.value)
          setStagedPatch(stagedResponse.value)
          return
        }
        setBasePatch('')
        setUnstagedPatch('')
        setStagedPatch('')
        if (!baseResponse.ok) {
          setError(baseResponse.error.message)
          return
        }
        if (!unstagedResponse.ok) {
          setError(unstagedResponse.error.message)
          return
        }
        if (!stagedResponse.ok) setError(stagedResponse.error.message)
      })
      .catch((loadError: unknown) => {
        if (cancelled) return
        setBasePatch('')
        setUnstagedPatch('')
        setStagedPatch('')
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [compareBranchInput, rootPath])

  useEffect(() => refreshDiffPatch(), [refreshDiffPatch])

  const deferredBasePatch = useDeferredValue(basePatch)
  const deferredUnstagedPatch = useDeferredValue(unstagedPatch)
  const deferredStagedPatch = useDeferredValue(stagedPatch)
  const base = useParsedDiffFiles(deferredBasePatch, 'base')
  const unstaged = useParsedDiffFiles(deferredUnstagedPatch, 'unstaged')
  const staged = useParsedDiffFiles(deferredStagedPatch, 'staged')

  const sections = useMemo((): ChangedFilesSection[] => {
    return [
      { kind: 'unstaged', label: 'Unstaged', files: unstaged.files, error: unstaged.error },
      { kind: 'staged', label: 'Staged', files: staged.files, error: staged.error },
      { kind: 'base', label: 'Against base', files: base.files, error: base.error },
    ]
  }, [base, staged, unstaged])

  const totalChangedFiles = sections.reduce((total, section) => total + section.files.length, 0)
  const baseSummary = summarizeParsedDiffFiles(
    sections.find((section) => section.kind === 'base')?.files ?? [],
  )
  const sectionErrors = sections.map((section) => section.error).filter((value) => value !== null)
  const hasChangedFiles = totalChangedFiles > 0
  const sectionsWithFiles = useMemo(
    () => sections.filter((section) => section.files.length > 0),
    [sections],
  )
  const diffFileTreesBySection = useMemo(
    () =>
      new Map(sectionsWithFiles.map((section) => [section.kind, buildDiffFileTree(section.files)])),
    [sectionsWithFiles],
  )
  const treeDirectoryKeys = useMemo(
    () =>
      sectionsWithFiles.flatMap((section) =>
        collectDiffFileTreeDirectoryKeys(
          diffFileTreesBySection.get(section.kind) ?? [],
          section.kind,
        ),
      ),
    [diffFileTreesBySection, sectionsWithFiles],
  )
  const areAllTreeDirectoriesCollapsed =
    treeDirectoryKeys.length > 0 &&
    treeDirectoryKeys.every((key) => collapsedTreeDirectoryKeys.has(key))

  const toggleSection = useCallback((kind: ChangedFilesSectionKind) => {
    setCollapsedSections((current) => {
      const next = new Set(current)
      if (next.has(kind)) {
        next.delete(kind)
      } else {
        next.add(kind)
      }
      return next
    })
  }, [])

  const toggleAllTreeDirectories = useCallback(() => {
    if (areAllTreeDirectoriesCollapsed) {
      setCollapsedTreeDirectoryKeys(new Set())
    } else {
      setCollapsedTreeDirectoryKeys(new Set(treeDirectoryKeys))
    }
  }, [areAllTreeDirectoriesCollapsed, treeDirectoryKeys])

  const focusDiffFile = useCallback(
    (file: ParsedDiffFile) => {
      setFocusedPath(file.path)
      onOpenChangesTab()
      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent(DIFF_FOCUS_FILE_EVENT, {
            detail: { path: file.path, rootPath },
          }),
        )
      }, 0)
    },
    [onOpenChangesTab, rootPath],
  )

  const runPathAction = useCallback(
    async (action: 'stage' | 'unstage' | 'revert', path: string | readonly string[]) => {
      if (!rootPath || isMutatingPath) return
      setIsMutatingPath(typeof path === 'string' ? path : path.join('\0'))
      setError(null)

      try {
        const actionPath =
          typeof path === 'string' ? path : path.filter((candidate) => candidate.trim().length > 0)
        if (Array.isArray(actionPath) && actionPath.length === 0) {
          setError('No paths selected')
          return
        }
        const checkedPath = actionPath as string | readonly [string, ...string[]]
        const response =
          action === 'stage'
            ? await window.electronAPI.stagePath({ workspacePath: rootPath, path: checkedPath })
            : action === 'unstage'
              ? await window.electronAPI.unstagePath({ workspacePath: rootPath, path: checkedPath })
              : await window.electronAPI.revertPath({ workspacePath: rootPath, path: checkedPath })
        if (!response.ok) {
          setError(response.error.message)
          return
        }
        refreshDiffPatch()
      } catch (actionError) {
        setError(actionError instanceof Error ? actionError.message : String(actionError))
      } finally {
        setIsMutatingPath(null)
      }
    },
    [isMutatingPath, refreshDiffPatch, rootPath],
  )

  const renderNodes = useCallback(
    (
      nodes: readonly DiffFileTreeNode[],
      sectionKind: ChangedFilesSectionKind,
      depth = 0,
    ): ReactNode =>
      nodes.map((node) => {
        if (node.file) {
          const file = node.file
          const isFocused = focusedPath === file.path
          return (
            <button
              key={file.id}
              type="button"
              className={
                isFocused
                  ? 'right-sidebar-diff-file-tree-item right-sidebar-diff-file-tree-item-active'
                  : 'right-sidebar-diff-file-tree-item'
              }
              style={{ '--diff-tree-depth': depth } as CSSProperties}
              title={getDiffFileName(file.fileDiff)}
              onClick={() => focusDiffFile(file)}
            >
              <ChangedFileIcon path={file.path} />
              <span className="right-sidebar-diff-file-tree-name">{node.name}</span>
              <span className="right-sidebar-diff-file-tree-delta">
                <span className="right-sidebar-diff-added">+{file.additions}</span>
                <span className="right-sidebar-diff-deleted">-{file.deletions}</span>
              </span>
              {sectionKind === 'unstaged' ? (
                <span className="right-sidebar-diff-file-actions">
                  <button
                    type="button"
                    className="icon-button right-sidebar-tree-action-button"
                    aria-label={`Revert ${file.path}`}
                    title="Revert"
                    disabled={isMutatingPath !== null}
                    onClick={(event) => {
                      event.stopPropagation()
                      void runPathAction('revert', file.path)
                    }}
                  >
                    <FiRotateCcw size={12} />
                  </button>
                  <button
                    type="button"
                    className="icon-button right-sidebar-tree-action-button"
                    aria-label={`Stage ${file.path}`}
                    title="Stage"
                    disabled={isMutatingPath !== null}
                    onClick={(event) => {
                      event.stopPropagation()
                      void runPathAction('stage', file.path)
                    }}
                  >
                    <FiPlus size={12} />
                  </button>
                </span>
              ) : sectionKind === 'staged' ? (
                <span className="right-sidebar-diff-file-actions">
                  <button
                    type="button"
                    className="icon-button right-sidebar-tree-action-button"
                    aria-label={`Unstage ${file.path}`}
                    title="Unstage"
                    disabled={isMutatingPath !== null}
                    onClick={(event) => {
                      event.stopPropagation()
                      void runPathAction('unstage', file.path)
                    }}
                  >
                    <FiMinusSquare size={12} />
                  </button>
                </span>
              ) : null}
            </button>
          )
        }

        const directoryKey = `${sectionKind}:${node.path}`
        const isDirectoryCollapsed = collapsedTreeDirectoryKeys.has(directoryKey)

        return (
          <div className="right-sidebar-diff-file-tree-directory" key={node.path}>
            <div
              className="right-sidebar-diff-file-tree-directory-label"
              style={{ '--diff-tree-depth': depth } as CSSProperties}
              title={node.path}
            >
              <FiFolder size={13} />
              <span className="right-sidebar-diff-file-tree-name">{node.name}</span>
            </div>
            {isDirectoryCollapsed
              ? null
              : renderNodes([...node.children.values()], sectionKind, depth + 1)}
          </div>
        )
      }),
    [collapsedTreeDirectoryKeys, focusDiffFile, focusedPath, isMutatingPath, runPathAction],
  )

  const renderFileButton = useCallback(
    (file: ParsedDiffFile, label: string, sectionKind: ChangedFilesSectionKind): ReactNode => {
      const isFocused = focusedPath === file.path
      return (
        <button
          key={file.id}
          type="button"
          className={
            isFocused
              ? 'right-sidebar-diff-file-tree-item right-sidebar-diff-file-tree-item-active'
              : 'right-sidebar-diff-file-tree-item'
          }
          title={getDiffFileName(file.fileDiff)}
          onClick={() => focusDiffFile(file)}
        >
          <ChangedFileIcon path={file.path} />
          <span className="right-sidebar-diff-file-tree-name">{label}</span>
          <span className="right-sidebar-diff-file-tree-delta">
            <span className="right-sidebar-diff-added">+{file.additions}</span>
            <span className="right-sidebar-diff-deleted">-{file.deletions}</span>
          </span>
          {sectionKind === 'unstaged' ? (
            <span className="right-sidebar-diff-file-actions">
              <button
                type="button"
                className="icon-button right-sidebar-tree-action-button"
                aria-label={`Revert ${file.path}`}
                title="Revert"
                disabled={isMutatingPath !== null}
                onClick={(event) => {
                  event.stopPropagation()
                  void runPathAction('revert', file.path)
                }}
              >
                <FiRotateCcw size={12} />
              </button>
              <button
                type="button"
                className="icon-button right-sidebar-tree-action-button"
                aria-label={`Stage ${file.path}`}
                title="Stage"
                disabled={isMutatingPath !== null}
                onClick={(event) => {
                  event.stopPropagation()
                  void runPathAction('stage', file.path)
                }}
              >
                <FiPlus size={12} />
              </button>
            </span>
          ) : sectionKind === 'staged' ? (
            <span className="right-sidebar-diff-file-actions">
              <button
                type="button"
                className="icon-button right-sidebar-tree-action-button"
                aria-label={`Unstage ${file.path}`}
                title="Unstage"
                disabled={isMutatingPath !== null}
                onClick={(event) => {
                  event.stopPropagation()
                  void runPathAction('unstage', file.path)
                }}
              >
                <FiMinusSquare size={12} />
              </button>
            </span>
          ) : null}
        </button>
      )
    },
    [focusDiffFile, focusedPath, isMutatingPath, runPathAction],
  )

  return (
    <>
      <FileTreeIconSprite />
      <div className="right-sidebar-file-tree">
        <div className="right-sidebar-file-tree-toolbar right-sidebar-diff-toolbar right-sidebar-diff-toolbar-sidebar">
          <div className="right-sidebar-diff-toolbar-main">
            <DiffBranchPicker
              rootPath={rootPath}
              branchName={branchName}
              compareBranch={compareBranchInput}
              onCompareBranchChange={setCompareBranchInput}
            />
            <div className="right-sidebar-diff-control-row">
              <span className="right-sidebar-diff-summary" title="Line delta">
                <span>{baseSummary.files} files</span>
                <span className="right-sidebar-diff-added">+{baseSummary.additions}</span>
                <span className="right-sidebar-diff-deleted">-{baseSummary.deletions}</span>
              </span>
              <div className="right-sidebar-file-tree-actions">
                {viewMode === 'tree' ? (
                  <button
                    type="button"
                    className="icon-button right-sidebar-tree-action-button"
                    aria-label={
                      areAllTreeDirectoriesCollapsed ? 'Expand all folders' : 'Collapse all folders'
                    }
                    title={
                      areAllTreeDirectoriesCollapsed ? 'Expand all folders' : 'Collapse all folders'
                    }
                    disabled={treeDirectoryKeys.length === 0}
                    onClick={toggleAllTreeDirectories}
                  >
                    {areAllTreeDirectoriesCollapsed ? (
                      <FiChevronsDown size={12} />
                    ) : (
                      <FiChevronsUp size={12} />
                    )}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="icon-button right-sidebar-tree-action-button"
                  aria-label={
                    viewMode === 'tree'
                      ? 'Show changed files grouped by folder'
                      : 'Show changed files as an indented tree'
                  }
                  title={
                    viewMode === 'tree'
                      ? 'Show changed files grouped by folder'
                      : 'Show changed files as an indented tree'
                  }
                  disabled={!hasChangedFiles}
                  onClick={() =>
                    setViewMode((current) => (current === 'tree' ? 'folders' : 'tree'))
                  }
                >
                  {viewMode === 'tree' ? <FiList size={12} /> : <FiFolder size={12} />}
                </button>
                <button
                  type="button"
                  className="icon-button right-sidebar-tree-action-button"
                  aria-label="Refresh changed files"
                  title="Refresh changed files"
                  disabled={!rootPath || isLoading}
                  onClick={() => refreshDiffPatch()}
                >
                  <FiRefreshCw size={12} />
                </button>
              </div>
            </div>
          </div>
        </div>
        {error ? <div className="right-sidebar-file-tree-error">{error}</div> : null}
        {sectionErrors.map((sectionError) => (
          <div className="right-sidebar-file-tree-error" key={sectionError}>
            {sectionError}
          </div>
        ))}
        {!rootPath ? (
          <div className="right-sidebar-file-tree-message">Select a workspace</div>
        ) : null}
        {rootPath && !isLoading && !error && sectionErrors.length === 0 && !hasChangedFiles ? (
          <div className="right-sidebar-file-tree-message">No tracked changes</div>
        ) : null}
        {hasChangedFiles ? (
          <nav className="right-sidebar-diff-file-tree" aria-label="Changed files">
            {sectionsWithFiles.map((section) => {
              const isCollapsed = collapsedSections.has(section.kind)
              const diffFileTree = diffFileTreesBySection.get(section.kind) ?? []
              const diffFileGroups = groupDiffFilesByDirectory(section.files)

              return (
                <section className="right-sidebar-diff-change-section" key={section.kind}>
                  <button
                    type="button"
                    className="right-sidebar-diff-change-section-header"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleSection(section.kind)}
                  >
                    {isCollapsed ? <FiChevronRight size={13} /> : <FiChevronDown size={13} />}
                    <span>{section.label}</span>
                    <span>{section.files.length}</span>
                    {section.kind === 'unstaged' && section.files.length > 0 ? (
                      <span className="right-sidebar-diff-section-actions">
                        <button
                          type="button"
                          className="icon-button right-sidebar-tree-action-button"
                          aria-label="Revert all unstaged changes"
                          title="Revert all unstaged changes"
                          disabled={isMutatingPath !== null}
                          onClick={(event) => {
                            event.stopPropagation()
                            void runPathAction(
                              'revert',
                              section.files.map((file) => file.path),
                            )
                          }}
                        >
                          <FiRotateCcw size={12} />
                        </button>
                        <button
                          type="button"
                          className="icon-button right-sidebar-tree-action-button"
                          aria-label="Stage all unstaged changes"
                          title="Stage all unstaged changes"
                          disabled={isMutatingPath !== null}
                          onClick={(event) => {
                            event.stopPropagation()
                            void runPathAction(
                              'stage',
                              section.files.map((file) => file.path),
                            )
                          }}
                        >
                          <FiPlus size={12} />
                        </button>
                      </span>
                    ) : section.kind === 'staged' && section.files.length > 0 ? (
                      <span className="right-sidebar-diff-section-actions">
                        <button
                          type="button"
                          className="icon-button right-sidebar-tree-action-button"
                          aria-label="Unstage all staged changes"
                          title="Unstage all staged changes"
                          disabled={isMutatingPath !== null}
                          onClick={(event) => {
                            event.stopPropagation()
                            void runPathAction(
                              'unstage',
                              section.files.map((file) => file.path),
                            )
                          }}
                        >
                          <FiMinusSquare size={12} />
                        </button>
                      </span>
                    ) : null}
                  </button>
                  {!isCollapsed && section.files.length > 0
                    ? viewMode === 'tree'
                      ? renderNodes(diffFileTree, section.kind)
                      : diffFileGroups.map((group) => (
                          <div
                            className="right-sidebar-diff-file-tree-directory"
                            key={`${section.kind}:${group.directory}`}
                          >
                            <div
                              className="right-sidebar-diff-file-tree-group-label"
                              title={group.directory}
                            >
                              <span className="right-sidebar-diff-file-tree-group-name">
                                <FiFolder size={13} />
                                {group.directory}
                              </span>
                              <span>{group.files.length}</span>
                            </div>
                            {group.files.map((file) =>
                              renderFileButton(
                                file,
                                file.path.split('/').pop() ?? file.path,
                                section.kind,
                              ),
                            )}
                          </div>
                        ))
                    : null}
                </section>
              )
            })}
          </nav>
        ) : null}
      </div>
    </>
  )
}

function WorkspaceDiffPanel({
  rootPath,
  branchName,
  compareBranch,
  isFullPane = false,
  onOpenChangesTab,
}: {
  rootPath: string | null
  branchName: string
  compareBranch: string
  isFullPane?: boolean
  onOpenChangesTab?: () => void
}) {
  const [patch, setPatch] = useState('')
  const [diffViewMode, setDiffViewMode] = useState<DiffViewMode>(isFullPane ? 'split' : 'unified')
  const [compareBranchInput, setCompareBranchInput] = useState(compareBranch)
  const [collapsedFileIds, setCollapsedFileIds] = useState<ReadonlySet<string>>(() => new Set())
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [focusedFileId, setFocusedFileId] = useState<string | null>(null)
  const fileSectionRefs = useRef(new Map<string, HTMLElement>())

  useEffect(() => {
    setCompareBranchInput(compareBranch)
  }, [compareBranch])

  const refreshDiffPatch = useCallback(() => {
    if (!rootPath) {
      setPatch('')
      setError(null)
      setIsLoading(false)
      return
    }

    let cancelled = false
    setIsLoading(true)
    setError(null)

    window.electronAPI
      .getWorkspaceDiffPatch({
        workspacePath: rootPath,
        scope: 'all',
        compareBranch: compareBranchInput || undefined,
      })
      .then((response) => {
        if (cancelled) return
        if (response.ok) {
          setPatch(response.value)
          return
        }
        setPatch('')
        setError(response.error.message)
      })
      .catch((loadError: unknown) => {
        if (cancelled) return
        setPatch('')
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [compareBranchInput, rootPath])

  useEffect(() => refreshDiffPatch(), [refreshDiffPatch])

  const deferredPatch = useDeferredValue(patch)
  const parsedDiffResult = useParsedDiffFiles(deferredPatch, '')

  const parsedDiff = useMemo((): {
    files: ParsedDiffFile[]
    summary: DiffSummary
    error: string | null
  } => {
    return {
      files: parsedDiffResult.files,
      summary: summarizeParsedDiffFiles(parsedDiffResult.files),
      error: parsedDiffResult.error,
    }
  }, [parsedDiffResult])

  const shouldCapExpandedDiffBodies =
    parsedDiff.files.length >= DIFF_AUTO_COLLAPSE_FILE_COUNT ||
    deferredPatch.length >= DIFF_AUTO_COLLAPSE_PATCH_CHARS

  const limitExpandedDiffBodies = useCallback(
    (nextCollapsedFileIds: Set<string>, preferredFileId?: string): Set<string> => {
      if (!shouldCapExpandedDiffBodies) return nextCollapsedFileIds

      const expandedFileIds = parsedDiff.files
        .map((file) => file.id)
        .filter((id) => !nextCollapsedFileIds.has(id))
      if (expandedFileIds.length <= DIFF_MAX_EXPANDED_FILE_BODIES) return nextCollapsedFileIds

      const keptExpandedFileIds = new Set<string>()
      if (preferredFileId && expandedFileIds.includes(preferredFileId)) {
        keptExpandedFileIds.add(preferredFileId)
      }
      for (const id of expandedFileIds) {
        if (keptExpandedFileIds.size >= DIFF_MAX_EXPANDED_FILE_BODIES) break
        keptExpandedFileIds.add(id)
      }
      for (const id of expandedFileIds) {
        if (!keptExpandedFileIds.has(id)) nextCollapsedFileIds.add(id)
      }
      return nextCollapsedFileIds
    },
    [parsedDiff.files, shouldCapExpandedDiffBodies],
  )

  const collapseAll = useCallback(() => {
    setCollapsedFileIds(new Set(parsedDiff.files.map((file) => file.id)))
  }, [parsedDiff.files])

  const expandAll = useCallback(() => {
    setCollapsedFileIds(limitExpandedDiffBodies(new Set()))
  }, [limitExpandedDiffBodies])

  const areAllFilesCollapsed =
    parsedDiff.files.length > 0 && collapsedFileIds.size >= parsedDiff.files.length

  useEffect(() => {
    if (
      parsedDiff.files.length >= DIFF_AUTO_COLLAPSE_FILE_COUNT ||
      deferredPatch.length >= DIFF_AUTO_COLLAPSE_PATCH_CHARS
    ) {
      setCollapsedFileIds(new Set(parsedDiff.files.map((file) => file.id)))
    } else {
      setCollapsedFileIds(new Set())
    }
  }, [deferredPatch.length, parsedDiff.files])

  const toggleAllFilesCollapsed = useCallback(() => {
    if (areAllFilesCollapsed) {
      expandAll()
    } else {
      collapseAll()
    }
  }, [areAllFilesCollapsed, collapseAll, expandAll])

  const toggleFileCollapsed = useCallback(
    (fileId: string) => {
      setCollapsedFileIds((current) => {
        const next = new Set(current)
        if (next.has(fileId)) {
          next.delete(fileId)
        } else {
          next.add(fileId)
        }
        return limitExpandedDiffBodies(next, fileId)
      })
    },
    [limitExpandedDiffBodies],
  )

  const focusDiffFile = useCallback(
    (fileId: string) => {
      setFocusedFileId(fileId)
      setCollapsedFileIds((current) => {
        if (!current.has(fileId)) return current
        const next = new Set(current)
        next.delete(fileId)
        return limitExpandedDiffBodies(next, fileId)
      })
      window.requestAnimationFrame(() => {
        fileSectionRefs.current.get(fileId)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      })
    },
    [limitExpandedDiffBodies],
  )

  useEffect(() => {
    function handleFocusFile(event: Event) {
      const detail = (event as CustomEvent<{ path?: string; rootPath?: string | null }>).detail
      if (detail?.rootPath !== rootPath) return
      const path = detail?.path
      if (!path) return
      const file = parsedDiff.files.find((candidate) => candidate.path === path)
      if (file) focusDiffFile(file.id)
    }

    window.addEventListener(DIFF_FOCUS_FILE_EVENT, handleFocusFile)
    return () => window.removeEventListener(DIFF_FOCUS_FILE_EVENT, handleFocusFile)
  }, [focusDiffFile, parsedDiff.files, rootPath])

  const className = ['right-sidebar-diff', isFullPane ? 'right-sidebar-diff-full-pane' : null]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={className}>
      <div className="right-sidebar-file-tree-toolbar right-sidebar-diff-toolbar">
        <div className="right-sidebar-diff-toolbar-main">
          <DiffBranchPicker
            rootPath={rootPath}
            branchName={branchName}
            compareBranch={compareBranchInput}
            onCompareBranchChange={setCompareBranchInput}
          />
          <div className="right-sidebar-diff-control-row">
            <span className="right-sidebar-diff-summary" title="Line delta">
              {parsedDiff.summary.files} files
              <span className="right-sidebar-diff-added">+{parsedDiff.summary.additions}</span>
              <span className="right-sidebar-diff-deleted">-{parsedDiff.summary.deletions}</span>
            </span>
            <div className="right-sidebar-file-tree-actions">
              {onOpenChangesTab ? (
                <button
                  type="button"
                  className="icon-button right-sidebar-tree-action-button"
                  aria-label="Open changes tab"
                  title="Open changes tab"
                  disabled={!rootPath}
                  onClick={onOpenChangesTab}
                >
                  <FiMaximize2 size={12} />
                </button>
              ) : null}
              <button
                type="button"
                className="icon-button right-sidebar-tree-action-button"
                aria-label={
                  diffViewMode === 'unified' ? 'Show side-by-side diff' : 'Show inline diff'
                }
                title={diffViewMode === 'unified' ? 'Show side-by-side diff' : 'Show inline diff'}
                disabled={parsedDiff.files.length === 0}
                onClick={() =>
                  setDiffViewMode((current) => (current === 'unified' ? 'split' : 'unified'))
                }
              >
                <FiColumns size={12} />
              </button>
              <button
                type="button"
                className="icon-button right-sidebar-tree-action-button"
                aria-label={areAllFilesCollapsed ? 'Expand all changes' : 'Collapse all changes'}
                title={areAllFilesCollapsed ? 'Expand all changes' : 'Collapse all changes'}
                disabled={parsedDiff.files.length === 0}
                onClick={toggleAllFilesCollapsed}
              >
                {areAllFilesCollapsed ? <FiPlusSquare size={12} /> : <FiMinusSquare size={12} />}
              </button>
            </div>
          </div>
        </div>
      </div>
      {error ? <div className="right-sidebar-file-tree-error">{error}</div> : null}
      {parsedDiff.error ? (
        <div className="right-sidebar-file-tree-error">{parsedDiff.error}</div>
      ) : null}
      {!rootPath ? <div className="right-sidebar-file-tree-message">Select a workspace</div> : null}
      {rootPath && !isLoading && !error && !parsedDiff.error && parsedDiff.files.length === 0 ? (
        <div className="right-sidebar-file-tree-message">No tracked changes</div>
      ) : null}
      {parsedDiff.files.length > 0 ? (
        <DiffPanelErrorBoundary key={`${compareBranchInput}:${deferredPatch.length}`}>
          <div className="right-sidebar-diff-body">
            <div className="right-sidebar-diff-view">
              {parsedDiff.files.map(({ id, fileDiff, additions, deletions }) => {
                const isCollapsed = collapsedFileIds.has(id)
                const isFocused = focusedFileId === id
                return (
                  <section
                    className={
                      isFocused
                        ? 'right-sidebar-diff-file right-sidebar-diff-file-focused'
                        : 'right-sidebar-diff-file'
                    }
                    key={id}
                    ref={(node) => {
                      if (node) {
                        fileSectionRefs.current.set(id, node)
                      } else {
                        fileSectionRefs.current.delete(id)
                      }
                    }}
                  >
                    <button
                      type="button"
                      className="right-sidebar-diff-file-header"
                      aria-expanded={!isCollapsed}
                      onClick={() => toggleFileCollapsed(id)}
                    >
                      {isCollapsed ? <FiChevronRight size={13} /> : <FiChevronDown size={13} />}
                      <span className="right-sidebar-diff-file-name">
                        {getDiffFileName(fileDiff)}
                      </span>
                      <span className="right-sidebar-diff-file-delta">
                        <span className="right-sidebar-diff-added">+{additions}</span>
                        <span className="right-sidebar-diff-deleted">-{deletions}</span>
                      </span>
                    </button>
                    {!isCollapsed ? (
                      <FileDiff
                        fileDiff={fileDiff}
                        options={{
                          diffStyle: diffViewMode,
                          disableFileHeader: true,
                          expandUnchanged: true,
                          hunkSeparators: 'line-info-basic',
                          lineDiffType: 'word',
                          overflow: 'wrap',
                          theme: { light: 'github-light-default', dark: 'github-dark-default' },
                          themeType: 'dark',
                          unsafeCSS: `
                            * {
                              user-select: text;
                              -webkit-user-select: text;
                            }
                          `,
                        }}
                      />
                    ) : null}
                  </section>
                )
              })}
            </div>
          </div>
        </DiffPanelErrorBoundary>
      ) : null}
    </div>
  )
}

const PaneTile = memo(function PaneTile({
  pane,
  terminalCwd,
  diffBranchName,
  diffCompareBranch,
  terminalWorkspaceId,
  terminalWorktreeId,
  isActive,
  focusToken,
  searchToken,
  onSelect,
  onTitleChange,
  onRestartSession,
  onArchiveStateChange,
}: {
  pane: Pane
  terminalCwd?: string
  diffBranchName: string
  diffCompareBranch: string
  terminalWorkspaceId?: string
  terminalWorktreeId?: string
  isActive: boolean
  focusToken: number
  searchToken: number
  onSelect(): void
  onTitleChange(title: string): void
  onRestartSession(): void
  onArchiveStateChange(archived: boolean): void
}) {
  const status = pane.status ?? 'idle'
  const isArchived = status === 'archived'
  const className = [
    'pane-tile',
    isActive ? 'pane-tile-active' : null,
    isArchived ? 'pane-tile-archived' : null,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={className}
      data-pane-id={pane.id}
      onPointerDown={(event) => {
        if (event.target instanceof Node && event.currentTarget.contains(event.target)) onSelect()
      }}
    >
      {status === 'idle' ? null : (
        <span
          className={`pane-status pane-status-${status}`}
          title={`Pane status: ${status}`}
          aria-label={`Pane status: ${status}`}
        />
      )}
      {pane.type === 'terminal' ? (
        <TerminalPane
          sessionId={pane.lastSessionId ?? pane.id}
          terminalId={pane.terminalId}
          workspaceId={terminalWorkspaceId}
          worktreeId={terminalWorktreeId}
          cwd={pane.cwd ?? terminalCwd}
          isActive={isActive}
          focusToken={focusToken}
          searchToken={searchToken}
          onTitleChange={onTitleChange}
          onRestartSession={onRestartSession}
          onArchiveStateChange={onArchiveStateChange}
        />
      ) : pane.type === 'changes' ? (
        <WorkspaceDiffPanel
          rootPath={pane.cwd ?? terminalCwd ?? null}
          branchName={diffBranchName}
          compareBranch={diffCompareBranch}
          isFullPane
        />
      ) : (
        <div className="pane-standby" aria-hidden="true">
          <FiTerminal size={18} />
        </div>
      )}
    </div>
  )
})

const PaneGrid = memo(function PaneGrid({
  tab,
  terminalCwd,
  diffBranchName,
  diffCompareBranch,
  terminalWorkspaceId,
  terminalWorktreeId,
  panesById,
  activePaneId,
  terminalFocusTokens,
  terminalSearchTokens,
  onLayoutRelease,
  onSelectPane,
  onPaneTitle,
  onRestartPaneSession,
  onPaneArchiveState,
}: {
  tab: Tab
  terminalCwd?: string
  diffBranchName: string
  diffCompareBranch: string
  terminalWorkspaceId?: string
  terminalWorktreeId?: string
  panesById: Map<string, Pane>
  activePaneId: string | null
  terminalFocusTokens: ReadonlyMap<string, number>
  terminalSearchTokens: ReadonlyMap<string, number>
  onLayoutRelease(tabId: string, layout: MosaicNode<string> | null): void
  onSelectPane(paneId: string): void
  onPaneTitle(paneId: string, title: string): void
  onRestartPaneSession(paneId: string): void
  onPaneArchiveState(paneId: string, archived: boolean): void
}) {
  const [draftLayout, setDraftLayout] = useState<MosaicNode<string> | null>(tab.layout)

  useEffect(() => {
    setDraftLayout(tab.layout)
  }, [tab.layout])

  const handleLayoutChange = useCallback((layout: MosaicNode<string> | null) => {
    setDraftLayout(layout)
  }, [])

  const handleLayoutRelease = useCallback(
    (layout: MosaicNode<string> | null) => {
      setDraftLayout(layout)
      onLayoutRelease(tab.id, layout)
    },
    [onLayoutRelease, tab.id],
  )

  const activePaneBorderLines = useMemo(
    () => getActivePaneBorderLines(draftLayout, activePaneId),
    [activePaneId, draftLayout],
  )

  const renderTile = useCallback(
    (paneId: string) => {
      const pane = panesById.get(paneId)
      if (!pane) {
        return <div className="pane-tile pane-tile-missing" />
      }

      return (
        <PaneTile
          pane={pane}
          terminalCwd={terminalCwd}
          diffBranchName={diffBranchName}
          diffCompareBranch={diffCompareBranch}
          terminalWorkspaceId={terminalWorkspaceId}
          terminalWorktreeId={terminalWorktreeId}
          isActive={pane.id === activePaneId}
          focusToken={terminalFocusTokens.get(pane.id) ?? 0}
          searchToken={terminalSearchTokens.get(pane.id) ?? 0}
          onSelect={() => onSelectPane(pane.id)}
          onTitleChange={(title) => onPaneTitle(pane.id, title)}
          onRestartSession={() => onRestartPaneSession(pane.id)}
          onArchiveStateChange={(archived) => onPaneArchiveState(pane.id, archived)}
        />
      )
    },
    [
      activePaneId,
      onPaneTitle,
      onPaneArchiveState,
      onRestartPaneSession,
      onSelectPane,
      panesById,
      terminalCwd,
      diffBranchName,
      diffCompareBranch,
      terminalWorkspaceId,
      terminalWorktreeId,
      terminalFocusTokens,
      terminalSearchTokens,
    ],
  )

  return (
    <div className="pane-mosaic-shell">
      <MosaicView
        value={draftLayout}
        onChange={handleLayoutChange}
        onRelease={handleLayoutRelease}
        renderTile={renderTile}
        className="tao-mosaic"
        resize={{ minimumPaneSizePercentage: 18 }}
        zeroStateView={<div className="pane-grid-empty" />}
      />
      {activePaneBorderLines.length > 0 ? (
        <div className="active-pane-border-lines" aria-hidden="true">
          {activePaneBorderLines.map((line) => (
            <span key={line.key} className={line.className} style={line.style} />
          ))}
        </div>
      ) : null}
    </div>
  )
})

export function App() {
  const workspaces = useTaoStore((state) => state.workspaces)
  const tabs = useTaoStore((state) => state.tabs)
  const panes = useTaoStore((state) => state.panes)
  const activeTabId = useTaoStore((state) => state.activeTabId)
  const activePaneId = useTaoStore((state) => state.activePaneId)
  const activeWorkspaceId = useTaoStore((state) => state.activeWorkspaceId)
  const sidebarExpanded = useTaoStore((state) => state.sidebarExpanded)
  const sidebarWidth = useTaoStore((state) => state.sidebarWidth)
  const rightSidebarExpanded = useTaoStore((state) => state.rightSidebarExpanded)
  const rightSidebarWidth = useTaoStore((state) => state.rightSidebarWidth)
  const addWorkspace = useTaoStore((state) => state.addWorkspace)
  const selectWorkspaceByIndex = useTaoStore((state) => state.selectWorkspaceByIndex)
  const newTab = useTaoStore((state) => state.newTab)
  const openChangesTab = useTaoStore((state) => state.openChangesTab)
  const closeTab = useTaoStore((state) => state.closeTab)
  const closeActiveTab = useTaoStore((state) => state.closeActiveTab)
  const selectTab = useTaoStore((state) => state.selectTab)
  const selectTabByIndex = useTaoStore((state) => state.selectTabByIndex)
  const reorderTab = useTaoStore((state) => state.reorderTab)
  const setTabLayout = useTaoStore((state) => state.setTabLayout)
  const selectPane = useTaoStore((state) => state.selectPane)
  const selectPaneByDirection = useTaoStore((state) => state.selectPaneByDirection)
  const restartPaneSession = useTaoStore((state) => state.restartPaneSession)
  const setPaneTitle = useTaoStore((state) => state.setPaneTitle)
  const setPaneStatus = useTaoStore((state) => state.setPaneStatus)
  const splitActivePane = useTaoStore((state) => state.splitActivePane)
  const closeActivePane = useTaoStore((state) => state.closeActivePane)
  const setSidebarWidth = useTaoStore((state) => state.setSidebarWidth)
  const setSidebarExpanded = useTaoStore((state) => state.setSidebarExpanded)
  const toggleSidebar = useTaoStore((state) => state.toggleSidebar)
  const toggleRightSidebar = useTaoStore((state) => state.toggleRightSidebar)
  const setRightSidebarExpanded = useTaoStore((state) => state.setRightSidebarExpanded)
  const setRightSidebarWidth = useTaoStore((state) => state.setRightSidebarWidth)
  const reorderWorkspace = useTaoStore((state) => state.reorderWorkspace)
  const upsertWorkspace = useTaoStore((state) => state.upsertWorkspace)
  const removeWorktree = useTaoStore((state) => state.removeWorktree)
  const hydrateLayout = useTaoStore((state) => state.hydrateLayout)
  const [terminalFocusCounts, setTerminalFocusCounts] = useState<Record<string, number>>({})
  const [terminalSearchCounts, setTerminalSearchCounts] = useState<Record<string, number>>({})
  const [sidebarResizePreviewWidth, setSidebarResizePreviewWidth] = useState<number | null>(null)
  const [rightSidebarResizePreviewWidth, setRightSidebarResizePreviewWidth] = useState<
    number | null
  >(null)
  const [rightSidebarView, setRightSidebarView] = useState<RightSidebarView>('files')
  const [layoutLoaded, setLayoutLoaded] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [taodDiagnostics, setTaodDiagnostics] = useState<TaodLifecycleDiagnostics | null>(null)
  const [taodDiagnosticsError, setTaodDiagnosticsError] = useState<string | null>(null)
  const [daemonDiagnosticsOpen, setDaemonDiagnosticsOpen] = useState(false)
  const [daemonRecoveryInFlight, setDaemonRecoveryInFlight] = useState(false)
  const [daemonRecoveryError, setDaemonRecoveryError] = useState<string | null>(null)
  const activeWorkspaceKey = activeWorkspaceId
  const canCreateTerminal = activeWorkspaceKey !== null

  useEffect(() => {
    markRendererEvent('ui:app-mounted')
  }, [])

  useEffect(() => {
    if (!layoutLoaded) return
    markRendererEvent('ui:layout-loaded')
  }, [layoutLoaded])

  const sidebarSize = useMemo(
    () =>
      normalizeSidebarWidth(
        sidebarWidth >= SIDEBAR_EXPANDED_MIN_WIDTH ? sidebarWidth : SIDEBAR_DEFAULT_WIDTH,
      ),
    [sidebarWidth],
  )
  const rightSidebarSize = useMemo(
    () =>
      normalizeSidebarWidth(
        rightSidebarWidth >= SIDEBAR_EXPANDED_MIN_WIDTH ? rightSidebarWidth : SIDEBAR_DEFAULT_WIDTH,
        RIGHT_SIDEBAR_MAX_WIDTH,
      ),
    [rightSidebarWidth],
  )
  const sortedWorkspaces = useMemo(
    () => [...workspaces].sort((a, b) => a.order - b.order),
    [workspaces],
  )
  const activeWorkspace = useMemo(
    () =>
      sortedWorkspaces.find(
        (workspace) =>
          workspace.id === activeWorkspaceId ||
          (workspace.worktrees ?? []).some(
            (worktree) => worktreeContextId(worktree.id) === activeWorkspaceId,
          ),
      ) ?? null,
    [activeWorkspaceId, sortedWorkspaces],
  )
  const activeDiffCompareBranch = useMemo(
    () => activeContextCompareBranch(activeWorkspace, activeWorkspaceKey),
    [activeWorkspace, activeWorkspaceKey],
  )
  const activeWorkspaceIndex = activeWorkspace
    ? sortedWorkspaces.findIndex((workspace) => workspace.id === activeWorkspace.id)
    : -1
  const canGoPreviousWorkspace = activeWorkspaceIndex > 0
  const canGoNextWorkspace =
    activeWorkspaceIndex >= 0 && activeWorkspaceIndex < sortedWorkspaces.length - 1
  const workspaceTabs = useMemo(
    () =>
      layoutLoaded && activeWorkspaceKey
        ? tabs
            .filter((tab) => tab.workspaceId === activeWorkspaceKey)
            .sort((a, b) => a.order - b.order)
        : [],
    [activeWorkspaceKey, layoutLoaded, tabs],
  )
  const contextMetadataById = useMemo(() => {
    const entries: Array<[string, { workspaceId?: string; worktreeId?: string; cwd?: string }]> = []
    for (const workspace of workspaces) {
      entries.push([workspace.id, { workspaceId: workspace.id, cwd: workspace.projectPath }])
      for (const worktree of workspace.worktrees ?? []) {
        entries.push([
          worktreeContextId(worktree.id),
          { workspaceId: workspace.id, worktreeId: worktree.id, cwd: worktree.path },
        ])
      }
    }
    return new Map(entries)
  }, [workspaces])
  const mountedTabs = useMemo(
    () =>
      layoutLoaded
        ? tabs
            .filter((tab) => contextMetadataById.has(tab.workspaceId))
            .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId) || a.order - b.order)
        : [],
    [contextMetadataById, layoutLoaded, tabs],
  )
  const activeTab = useMemo(
    () => workspaceTabs.find((tab) => tab.id === activeTabId) ?? workspaceTabs[0] ?? null,
    [activeTabId, workspaceTabs],
  )
  const panesById = useMemo(() => new Map(panes.map((pane) => [pane.id, pane])), [panes])
  const activePane = activePaneId ? (panesById.get(activePaneId) ?? null) : null
  const activeTabMetadata = activeTab ? (contextMetadataById.get(activeTab.workspaceId) ?? {}) : {}
  const isChangesPaneFocused = activePane?.type === 'changes'
  const rightSidebarRootPath = isChangesPaneFocused
    ? (activePane?.cwd ?? activeTabMetadata.cwd ?? null)
    : activeWorkspace
      ? activeContextPath(activeWorkspace, activeWorkspaceKey)
      : null
  const tabLabelsById = useMemo(() => {
    const entries = tabs.map((tab): [string, string] => {
      const firstPaneId = getFirstPaneId(tab.layout)
      const pane = firstPaneId ? panesById.get(firstPaneId) : null
      return [tab.id, sanitizeTerminalTitle(pane?.name ?? tab.name) ?? tab.name]
    })
    return new Map(entries)
  }, [panesById, tabs])
  const archivedTabIds = useMemo(
    () => new Set(panes.filter((pane) => pane.status === 'archived').map((pane) => pane.tabId)),
    [panes],
  )
  const terminalFocusTokens = useMemo(
    () => new Map(Object.entries(terminalFocusCounts)),
    [terminalFocusCounts],
  )
  const terminalSearchTokens = useMemo(
    () => new Map(Object.entries(terminalSearchCounts)),
    [terminalSearchCounts],
  )
  const previousPaneSessionsRef = useRef(
    new Map(panes.map((pane) => [pane.id, pane.lastSessionId ?? pane.id])),
  )
  const applyWorkspaceRecord = useCallback(
    (record: WorkspaceRecord) => {
      const nextWorkspace = workspaceFromRecord(record)
      const previousWorkspace = useTaoStore
        .getState()
        .workspaces.find(
          (workspace) =>
            workspace.id === nextWorkspace.id ||
            workspace.projectPath === nextWorkspace.projectPath,
        )
      const nextWorktreeIds = new Set(
        (nextWorkspace.worktrees ?? []).map((worktree) => worktree.id),
      )
      const removedWorktrees = (previousWorkspace?.worktrees ?? []).filter(
        (worktree) => !nextWorktreeIds.has(worktree.id),
      )

      upsertWorkspace(nextWorkspace)
      for (const worktree of removedWorktrees) removeWorktree(nextWorkspace.id, worktree.id)
    },
    [removeWorktree, upsertWorkspace],
  )

  useEffect(() => {
    let cancelled = false

    async function loadLayout() {
      try {
        const layout = (await window.electronAPI.readLayout()) ?? readLegacyLocalStorageLayout()
        if (!cancelled && layout) hydrateLayout(layout as PaneLayoutData)
        if (!cancelled && layout) clearLegacyLocalStorageLayout()
      } catch (error) {
        console.warn('[layout] Failed to read pane layout:', error)
      } finally {
        if (!cancelled) setLayoutLoaded(true)
      }
    }

    void loadLayout()

    return () => {
      cancelled = true
    }
  }, [hydrateLayout])

  useEffect(() => {
    if (!layoutLoaded) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const refreshTaodDiagnostics = async () => {
      try {
        const diagnostics = await window.electronAPI.getTaodDiagnostics()
        if (cancelled) return
        setTaodDiagnostics(diagnostics)
        setTaodDiagnosticsError(null)
        if (diagnostics?.recoveryAction === 'none') setDaemonRecoveryError(null)
      } catch (error) {
        if (cancelled) return
        setTaodDiagnostics(null)
        setTaodDiagnosticsError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!cancelled) timer = setTimeout(refreshTaodDiagnostics, TAOD_DIAGNOSTICS_POLL_MS)
      }
    }

    void refreshTaodDiagnostics()

    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [layoutLoaded])

  useEffect(() => {
    if (!layoutLoaded) return

    let cancelled = false

    async function syncDaemonWorkspaces() {
      const currentWorkspaces = useTaoStore.getState().workspaces
      if (currentWorkspaces.length === 0) return

      for (const workspace of currentWorkspaces) {
        try {
          const response = await window.electronAPI.addWorkspace({
            rootPath: workspace.projectPath,
            workspaceId: workspace.id,
            name: workspace.name,
            orderIndex: workspace.order,
          })
          if (!cancelled && response.ok) applyWorkspaceRecord(response.value)
        } catch (error) {
          console.warn('[workspace] Failed to import workspace into taod:', error)
        }
      }

      try {
        const response = await window.electronAPI.listWorkspaces()
        if (!cancelled && response.ok) {
          for (const workspace of response.value) applyWorkspaceRecord(workspace)
        }
      } catch (error) {
        console.warn('[workspace] Failed to list daemon workspaces:', error)
      }
    }

    void syncDaemonWorkspaces()

    return () => {
      cancelled = true
    }
  }, [applyWorkspaceRecord, layoutLoaded])

  useEffect(() => {
    return window.electronAPI.onWorkspaceChanged((workspace) => {
      applyWorkspaceRecord(workspace)
      void runRendererEffect(
        WorkspaceMetadataCache.use((cache) => cache.invalidateWorkspace(workspace.rootPath)),
      ).catch((error) => {
        console.warn('[workspace] Failed to invalidate Git metadata cache:', error)
      })
    })
  }, [applyWorkspaceRecord])

  useEffect(() => {
    if (!layoutLoaded) return

    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = useTaoStore.subscribe((state) => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        window.electronAPI.writeLayout(selectPaneLayoutData(state)).catch((error) => {
          console.warn('[layout] Failed to write pane layout:', error)
        })
      }, LAYOUT_WRITE_DEBOUNCE_MS)
    })

    window.electronAPI.writeLayout(selectPaneLayoutData(useTaoStore.getState())).catch((error) => {
      console.warn('[layout] Failed to write initial pane layout:', error)
    })

    return () => {
      unsubscribe()
      if (timer !== null) clearTimeout(timer)
    }
  }, [layoutLoaded])

  useEffect(() => {
    if (!layoutLoaded) return

    const activePane = activePaneId ? panes.find((pane) => pane.id === activePaneId) : null
    if (!activePane || activePane.type !== 'terminal') {
      const frame = window.requestAnimationFrame(() => window.electronAPI.signalReady())
      return () => window.cancelAnimationFrame(frame)
    }
  }, [activePaneId, layoutLoaded, panes])

  useEffect(() => {
    document.title = activeTab ? `${activeTab.name} — Tao` : 'Tao'
  }, [activeTab])

  useEffect(() => {
    if (!layoutLoaded) return
    const terminalPanes = panes.filter((pane) => pane.type === 'terminal')
    const nextPaneIds = new Set(terminalPanes.map((pane) => pane.id))
    for (const [paneId, sessionId] of previousPaneSessionsRef.current) {
      if (!nextPaneIds.has(paneId)) {
        void window.electronAPI.killSession(sessionId)
      }
    }
    previousPaneSessionsRef.current = new Map(
      terminalPanes.map((pane) => [pane.id, pane.lastSessionId ?? pane.id]),
    )
  }, [layoutLoaded, panes])

  useEffect(() => {
    const focusActiveTerminal = () => {
      const paneId = useTaoStore.getState().activePaneId
      if (!paneId) return

      setTerminalFocusCounts((counts) => ({
        ...counts,
        [paneId]: (counts[paneId] ?? 0) + 1,
      }))
    }

    const searchActiveTerminal = () => {
      const paneId = useTaoStore.getState().activePaneId
      if (!paneId) return

      setTerminalSearchCounts((counts) => ({
        ...counts,
        [paneId]: (counts[paneId] ?? 0) + 1,
      }))
    }

    const runCommand = (command: AppCommand) => {
      switch (command.type) {
        case 'toggle-sidebar':
          toggleSidebar()
          break
        case 'toggle-right-sidebar':
          toggleRightSidebar()
          break
        case 'new-tab':
          setIsSettingsOpen(false)
          newTab(activeWorkspaceKey ?? undefined)
          break
        case 'close-tab':
          closeActiveTab()
          break
        case 'close-pane':
          closeActivePane()
          break
        case 'split-pane-vertical':
          splitActivePane('row')
          break
        case 'split-pane-horizontal':
          splitActivePane('column')
          break
        case 'switch-workspace':
          setIsSettingsOpen(false)
          selectWorkspaceByIndex(command.index)
          break
        case 'switch-tab':
          setIsSettingsOpen(false)
          selectTabByIndex(command.index)
          break
        case 'focus-pane':
          selectPaneByDirection(command.direction)
          break
        case 'focus-terminal':
          focusActiveTerminal()
          break
        case 'search-terminal':
          searchActiveTerminal()
          break
      }
    }

    return window.electronAPI.onAppCommand(runCommand)
  }, [
    activeWorkspaceKey,
    closeActivePane,
    closeActiveTab,
    newTab,
    selectPaneByDirection,
    selectTabByIndex,
    selectWorkspaceByIndex,
    setRightSidebarExpanded,
    toggleRightSidebar,
    splitActivePane,
    toggleSidebar,
  ])

  async function handleAddWorkspace() {
    setIsSettingsOpen(false)
    const projectPath = await window.electronAPI.pickWorkspaceDirectory()
    if (!projectPath) return
    if (
      workspaces.some(
        (workspace) => workspace.id === projectPath || workspace.projectPath === projectPath,
      )
    )
      return

    const response = await window.electronAPI.addWorkspace({
      rootPath: projectPath,
      name: workspaceNameFromPath(projectPath),
      orderIndex: workspaces.length,
    })
    if (response.ok) {
      addWorkspace(workspaceFromRecord(response.value))
      return
    }

    console.warn('[workspace] Failed to add daemon workspace:', response.error.message)

    addWorkspace({
      id: projectPath,
      name: workspaceNameFromPath(projectPath),
      projectPath,
      order: workspaces.length,
    })
  }

  function selectWorkspaceAtIndex(index: number) {
    const workspace = sortedWorkspaces[index]
    if (!workspace) return
    setIsSettingsOpen(false)
    useTaoStore.getState().selectWorkspace(workspace.id)
  }

  const handlePaneArchiveState = useCallback(
    (paneId: string, archived: boolean) => {
      if (archived) {
        setPaneStatus(paneId, 'archived')
        return
      }

      const pane = useTaoStore.getState().panes.find((candidate) => candidate.id === paneId)
      if (pane?.status === 'archived') setPaneStatus(paneId, 'idle')
    },
    [setPaneStatus],
  )

  const handleResizeSidebar = useCallback(
    (nextWidth: number) => {
      setSidebarWidth(normalizeSidebarWidth(nextWidth))
      setSidebarExpanded(true)
      setSidebarResizePreviewWidth(null)
    },
    [setSidebarExpanded, setSidebarWidth],
  )
  const handleSidebarResizePreview = useCallback((nextWidth: number | null) => {
    setSidebarResizePreviewWidth(nextWidth)
  }, [])
  const handleResizeRightSidebar = useCallback(
    (nextWidth: number) => {
      setRightSidebarWidth(normalizeSidebarWidth(nextWidth, RIGHT_SIDEBAR_MAX_WIDTH))
      setRightSidebarExpanded(true)
      setRightSidebarResizePreviewWidth(null)
    },
    [setRightSidebarExpanded, setRightSidebarWidth],
  )
  const handleRightSidebarResizePreview = useCallback((nextWidth: number | null) => {
    setRightSidebarResizePreviewWidth(nextWidth)
  }, [])
  const handleOpenChangesTab = useCallback(() => {
    openChangesTab(activeWorkspaceKey ?? undefined)
  }, [activeWorkspaceKey, openChangesTab])
  const shellStyle = {
    '--tao-sidebar-width': `${sidebarExpanded ? (sidebarResizePreviewWidth ?? sidebarSize) : 0}px`,
  } as CSSProperties & Record<'--tao-sidebar-width', string>
  const shellClassName = ['tao-shell', sidebarExpanded ? null : 'tao-shell-sidebar-hidden']
    .filter(Boolean)
    .join(' ')
  const daemonNotice = useMemo(
    () => daemonRecoveryNotice(taodDiagnostics, taodDiagnosticsError),
    [taodDiagnostics, taodDiagnosticsError],
  )

  useEffect(() => {
    if (!daemonNotice) setDaemonDiagnosticsOpen(false)
  }, [daemonNotice])

  const handleToggleDaemonDiagnostics = useCallback(() => {
    setDaemonDiagnosticsOpen((open) => !open)
  }, [])

  const handleApplyDaemonRecovery = useCallback(async (action: TaodLifecycleRecoveryAction) => {
    setDaemonRecoveryInFlight(true)
    setDaemonRecoveryError(null)
    try {
      const diagnostics = await window.electronAPI.recoverTaod(action)
      setTaodDiagnostics(diagnostics)
      setTaodDiagnosticsError(null)
    } catch (error) {
      setDaemonRecoveryError(error instanceof Error ? error.message : String(error))
    } finally {
      setDaemonRecoveryInFlight(false)
    }
  }, [])

  if (!layoutLoaded) {
    return <div className="tao-shell" />
  }

  if (isSettingsOpen) {
    return (
      <div className="tao-shell tao-settings-shell">
        <SettingsPage onBack={() => setIsSettingsOpen(false)} />
      </div>
    )
  }

  return (
    <div className={shellClassName} style={shellStyle}>
      {sidebarExpanded ? (
        <ResizeShell
          width={sidebarSize}
          onResize={handleResizeSidebar}
          onResizePreview={handleSidebarResizePreview}
        >
          <HeaderNavigation
            isSidebarVisible={sidebarExpanded}
            canGoPreviousWorkspace={canGoPreviousWorkspace}
            canGoNextWorkspace={canGoNextWorkspace}
            onToggleSidebar={() => setSidebarExpanded(!sidebarExpanded)}
            onPreviousWorkspace={() => selectWorkspaceAtIndex(activeWorkspaceIndex - 1)}
            onNextWorkspace={() => selectWorkspaceAtIndex(activeWorkspaceIndex + 1)}
          />
          <div className="sidebar-top-actions">
            <DaemonRecoveryIndicator
              notice={daemonNotice}
              diagnostics={taodDiagnostics}
              diagnosticsError={taodDiagnosticsError}
              recoveryError={daemonRecoveryError}
              isRecovering={daemonRecoveryInFlight}
              isOpen={daemonDiagnosticsOpen}
              onToggle={handleToggleDaemonDiagnostics}
              onRecover={handleApplyDaemonRecovery}
            />
            <button
              type="button"
              className="icon-button add-workspace-button"
              aria-label="Add workspace"
              title="Add workspace"
              onClick={handleAddWorkspace}
            >
              <FiFolderPlus size={15} />
            </button>
          </div>
          <div className="sidebar-content">
            {workspaces.length > 0 ? (
              <div className="workspace-list">
                {sortedWorkspaces.map((workspace) => (
                  <WorkspaceItem
                    key={workspace.id}
                    workspace={workspace}
                    onReorderWorkspace={reorderWorkspace}
                  />
                ))}
              </div>
            ) : null}
            <div className="sidebar-footer">
              <button
                type="button"
                className="icon-button sidebar-settings-button"
                aria-label="Open settings"
                title="Settings"
                onClick={() => setIsSettingsOpen(true)}
              >
                <FiSettings size={15} />
              </button>
            </div>
          </div>
        </ResizeShell>
      ) : null}
      <section className="tao-main">
        <main className="main-content">
          <TabBar
            tabs={workspaceTabs}
            activeTabId={activeTab?.id ?? null}
            showHeaderNavigation={!sidebarExpanded}
            isSidebarVisible={sidebarExpanded}
            canGoPreviousWorkspace={canGoPreviousWorkspace}
            canGoNextWorkspace={canGoNextWorkspace}
            tabLabelsById={tabLabelsById}
            onToggleSidebar={() => setSidebarExpanded(!sidebarExpanded)}
            onPreviousWorkspace={() => selectWorkspaceAtIndex(activeWorkspaceIndex - 1)}
            onNextWorkspace={() => selectWorkspaceAtIndex(activeWorkspaceIndex + 1)}
            onSelectTab={(tabId) => {
              setIsSettingsOpen(false)
              selectTab(tabId)
            }}
            onCloseTab={closeTab}
            onReorderTab={reorderTab}
            archivedTabIds={archivedTabIds}
          />
          {!sidebarExpanded && daemonNotice ? (
            <div className="titlebar-status-actions">
              <DaemonRecoveryIndicator
                notice={daemonNotice}
                diagnostics={taodDiagnostics}
                diagnosticsError={taodDiagnosticsError}
                recoveryError={daemonRecoveryError}
                isRecovering={daemonRecoveryInFlight}
                isOpen={daemonDiagnosticsOpen}
                onToggle={handleToggleDaemonDiagnostics}
                onRecover={handleApplyDaemonRecovery}
              />
            </div>
          ) : null}
          <div className="pane-grid">
            {mountedTabs.map((tab) => {
              const isTabActive = tab.id === activeTab?.id
              const metadata = contextMetadataById.get(tab.workspaceId) ?? {}
              const tabWorkspace = workspaceForContext(workspaces, tab.workspaceId)
              return (
                <div
                  className={
                    isTabActive ? 'pane-grid-layer pane-grid-layer-active' : 'pane-grid-layer'
                  }
                  key={tab.id}
                  aria-hidden={!isTabActive}
                >
                  <PaneGrid
                    tab={tab}
                    terminalCwd={metadata.cwd}
                    diffBranchName={activeContextBranchName(tabWorkspace, tab.workspaceId)}
                    diffCompareBranch={activeContextCompareBranch(tabWorkspace, tab.workspaceId)}
                    terminalWorkspaceId={metadata.workspaceId}
                    terminalWorktreeId={metadata.worktreeId}
                    panesById={panesById}
                    activePaneId={isTabActive ? activePaneId : null}
                    terminalFocusTokens={terminalFocusTokens}
                    terminalSearchTokens={terminalSearchTokens}
                    onLayoutRelease={setTabLayout}
                    onSelectPane={selectPane}
                    onPaneTitle={setPaneTitle}
                    onRestartPaneSession={restartPaneSession}
                    onPaneArchiveState={handlePaneArchiveState}
                  />
                </div>
              )
            })}
            {!activeTab ? (
              <div className="pane-grid-layer pane-grid-layer-active">
                <div className="pane-grid-empty">
                  {canCreateTerminal ? (
                    <button
                      type="button"
                      className="empty-new-tab-button"
                      aria-label="New tab"
                      onClick={() => {
                        setIsSettingsOpen(false)
                        newTab(activeWorkspaceKey ?? undefined)
                      }}
                    >
                      <FiPlus size={15} />
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </main>
      </section>
      {rightSidebarExpanded ? (
        <ResizeShell
          width={rightSidebarResizePreviewWidth ?? rightSidebarSize}
          side="right"
          className="tao-right-sidebar"
          ariaLabel="Workspace files"
          onResize={handleResizeRightSidebar}
          onResizePreview={handleRightSidebarResizePreview}
        >
          <RightSidebar
            rootPath={rightSidebarRootPath}
            compareBranch={activeDiffCompareBranch}
            branchName={activeContextBranchName(activeWorkspace, activeWorkspaceKey)}
            view={rightSidebarView}
            onSelectView={setRightSidebarView}
            onOpenChangesTab={handleOpenChangesTab}
          />
        </ResizeShell>
      ) : null}
      <button
        type="button"
        className="icon-button titlebar-button right-sidebar-toggle-button"
        aria-label={rightSidebarExpanded ? 'Hide right sidebar' : 'Show right sidebar'}
        title={rightSidebarExpanded ? 'Hide right sidebar' : 'Show right sidebar'}
        onClick={() => setRightSidebarExpanded(!rightSidebarExpanded)}
      >
        <TbLayoutSidebarRight size={16} />
      </button>
    </div>
  )
}
