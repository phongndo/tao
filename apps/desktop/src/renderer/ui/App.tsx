import {
  FiChevronLeft,
  FiChevronRight,
  FiArchive,
  FiFolderPlus,
  FiMenu,
  FiPlus,
  FiTerminal,
  FiTrash2,
  FiX,
} from 'react-icons/fi'
import {
  type ComponentType,
  type CSSProperties,
  type DragEvent,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Mosaic, type MosaicNode, type MosaicProps } from 'react-mosaic-component'
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
import { runRendererEffect } from '../runtime'
import { WorkspaceMetadataCache } from '../workspace-service'
import { useGitBranch } from '../workspaceQueries'
import { TerminalPane } from './TerminalPane'
import type { WorkspaceRecord } from '@tao/shared/workspace'

const SIDEBAR_DEFAULT_WIDTH = 240
const SIDEBAR_EXPANDED_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 360
const SIDEBAR_KEYBOARD_RESIZE_STEP = 12
const TAB_DRAG_TYPE = 'application/x-tao-tab'
const WORKSPACE_DRAG_TYPE = 'application/x-tao-workspace'
const LAYOUT_WRITE_DEBOUNCE_MS = 150
const LEGACY_LOCAL_STORAGE_LAYOUT_KEY = 'tao-workspaces'

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

const PANE_BORDER_EPSILON = 0.0001

function layoutContainsPane(layout: MosaicNode<string>, paneId: string): boolean {
  if (typeof layout === 'string') return layout === paneId
  return layoutContainsPane(layout.first, paneId) || layoutContainsPane(layout.second, paneId)
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

function normalizeSidebarWidth(nextWidth: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_EXPANDED_MIN_WIDTH, nextWidth))
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
  onResize,
  onResizePreview,
}: {
  children: ReactNode
  width: number
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

  useEffect(() => {
    if (!isResizing) currentWidthRef.current = width
  }, [isResizing, width])

  const flushPendingWidth = useCallback(() => {
    const nextWidth = pendingWidthRef.current
    pendingWidthRef.current = null
    if (nextWidth === null) return
    const clampedWidth = normalizeSidebarWidth(nextWidth)
    currentWidthRef.current = clampedWidth
    setDraftWidth(clampedWidth)
    onResizePreview?.(clampedWidth)
  }, [onResizePreview])

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      if (!isResizing) return

      pendingWidthRef.current = startWidthRef.current + event.clientX - startXRef.current
      if (frameRef.current !== null) return

      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null
        flushPendingWidth()
      })
    },
    [flushPendingWidth, isResizing],
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
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      aria-valuenow={displayWidth}
      aria-label="Resize sidebar"
      tabIndex={0}
      className={isResizing ? 'resize-handle resize-handle-active' : 'resize-handle'}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        const normalizedWidth = normalizeSidebarWidth(width)
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
          onResize(normalizeSidebarWidth(displayWidth - SIDEBAR_KEYBOARD_RESIZE_STEP))
          return
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          onResize(normalizeSidebarWidth(displayWidth + SIDEBAR_KEYBOARD_RESIZE_STEP))
          return
        }
        if (event.key === 'Home') {
          event.preventDefault()
          onResize(SIDEBAR_EXPANDED_MIN_WIDTH)
          return
        }
        if (event.key === 'End') {
          event.preventDefault()
          onResize(SIDEBAR_MAX_WIDTH)
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

  const className = ['tao-sidebar'].filter(Boolean).join(' ')

  return (
    <aside className={className} style={{ width: displayWidth }} aria-label="Workspaces">
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
  onToggleSidebar,
  onPreviousWorkspace,
  onNextWorkspace,
  onNewTab,
  canCreateTabs,
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
  onToggleSidebar(): void
  onPreviousWorkspace(): void
  onNextWorkspace(): void
  onNewTab(): void
  canCreateTabs: boolean
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
                  isArchived ? `${tab.name} — contains a read-only archived session` : tab.name
                }
                onClick={() => onSelectTab(tab.id)}
              >
                <FiTerminal size={13} />
                <span>{tab.name}</span>
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
                aria-label={`Close ${tab.name}`}
                title="Close tab"
                onClick={() => onCloseTab(tab.id)}
              >
                <FiX size={12} />
              </button>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        className="icon-button"
        aria-label="New tab"
        title={canCreateTabs ? 'New tab' : 'Add a workspace first'}
        disabled={!canCreateTabs}
        onClick={onNewTab}
      >
        <FiPlus size={15} />
      </button>
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
        aria-label={isSidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
        title={isSidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
        onClick={onToggleSidebar}
      >
        <FiMenu size={15} />
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

const PaneTile = memo(function PaneTile({
  pane,
  terminalCwd,
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
  const addWorkspace = useTaoStore((state) => state.addWorkspace)
  const selectWorkspaceByIndex = useTaoStore((state) => state.selectWorkspaceByIndex)
  const newTab = useTaoStore((state) => state.newTab)
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
  const reorderWorkspace = useTaoStore((state) => state.reorderWorkspace)
  const upsertWorkspace = useTaoStore((state) => state.upsertWorkspace)
  const removeWorktree = useTaoStore((state) => state.removeWorktree)
  const hydrateLayout = useTaoStore((state) => state.hydrateLayout)
  const [terminalFocusCounts, setTerminalFocusCounts] = useState<Record<string, number>>({})
  const [terminalSearchCounts, setTerminalSearchCounts] = useState<Record<string, number>>({})
  const [sidebarResizePreviewWidth, setSidebarResizePreviewWidth] = useState<number | null>(null)
  const [layoutLoaded, setLayoutLoaded] = useState(false)
  const activeWorkspaceKey = activeWorkspaceId
  const canCreateTerminal = activeWorkspaceKey !== null
  const sidebarSize = useMemo(
    () =>
      normalizeSidebarWidth(
        sidebarWidth >= SIDEBAR_EXPANDED_MIN_WIDTH ? sidebarWidth : SIDEBAR_DEFAULT_WIDTH,
      ),
    [sidebarWidth],
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
    const nextPaneIds = new Set(panes.map((pane) => pane.id))
    for (const [paneId, sessionId] of previousPaneSessionsRef.current) {
      if (!nextPaneIds.has(paneId)) {
        void window.electronAPI.killSession(sessionId)
      }
    }
    previousPaneSessionsRef.current = new Map(
      panes.map((pane) => [pane.id, pane.lastSessionId ?? pane.id]),
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
        case 'new-tab':
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
          selectWorkspaceByIndex(command.index)
          break
        case 'switch-tab':
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
    splitActivePane,
    toggleSidebar,
  ])

  async function handleAddWorkspace() {
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
  const shellStyle = {
    '--tao-sidebar-width': `${sidebarExpanded ? (sidebarResizePreviewWidth ?? sidebarSize) : 0}px`,
  } as CSSProperties & Record<'--tao-sidebar-width', string>
  const shellClassName = ['tao-shell', sidebarExpanded ? null : 'tao-shell-sidebar-hidden']
    .filter(Boolean)
    .join(' ')

  if (!layoutLoaded) {
    return <div className="tao-shell" />
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
            onToggleSidebar={() => setSidebarExpanded(!sidebarExpanded)}
            onPreviousWorkspace={() => selectWorkspaceAtIndex(activeWorkspaceIndex - 1)}
            onNextWorkspace={() => selectWorkspaceAtIndex(activeWorkspaceIndex + 1)}
            onNewTab={() => newTab(activeWorkspaceKey ?? undefined)}
            canCreateTabs={canCreateTerminal}
            onSelectTab={selectTab}
            onCloseTab={closeTab}
            onReorderTab={reorderTab}
            archivedTabIds={archivedTabIds}
          />
          <div className="pane-grid">
            {mountedTabs.map((tab) => {
              const isTabActive = tab.id === activeTab?.id
              const metadata = contextMetadataById.get(tab.workspaceId) ?? {}
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
                      onClick={() => newTab(activeWorkspaceKey ?? undefined)}
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
    </div>
  )
}
