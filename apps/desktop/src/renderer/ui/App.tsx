import {
  FiChevronLeft,
  FiChevronRight,
  FiArchive,
  FiFolderPlus,
  FiGitBranch,
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
  LOCAL_WORKSPACE_ID,
  type Pane,
  type ReorderPlacement,
  selectPaneLayoutData,
  type Tab,
  useTaoStore,
  type Workspace,
} from '../state/store'
import { useGitBranch } from '../workspaceQueries'
import { TerminalPane } from './TerminalPane'

const SIDEBAR_DEFAULT_WIDTH = 240
const SIDEBAR_COLLAPSED_WIDTH = 48
const SIDEBAR_EXPANDED_MIN_WIDTH = 220
const SIDEBAR_SNAP_TO_COLLAPSED_THRESHOLD = 156
const SIDEBAR_COMPACT_THRESHOLD = 64
const SIDEBAR_HIDE_HEADER_ACTIONS_THRESHOLD = 148
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

function normalizeSidebarWidth(nextWidth: number): number {
  return nextWidth < SIDEBAR_SNAP_TO_COLLAPSED_THRESHOLD
    ? SIDEBAR_COLLAPSED_WIDTH
    : Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_EXPANDED_MIN_WIDTH, nextWidth))
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
  const removeWorkspace = useTaoStore((state) => state.removeWorkspace)
  const isActive = activeWorkspaceId === workspace.id
  const branch = useGitBranch(workspace.projectPath, isActive)
  const branchLabel = branch.isError
    ? 'git error'
    : (branch.data ?? (branch.isLoading ? 'loading' : 'no git branch'))
  const label = `${workspace.name} — ${branchLabel}`

  return (
    <div
      className={isActive ? 'workspace-item workspace-item-active' : 'workspace-item'}
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
        className="workspace-select-button"
        onClick={() => selectWorkspace(workspace.id)}
        aria-pressed={isActive}
        aria-label={label}
        title={label}
      >
        <span className="workspace-avatar" aria-hidden="true">
          {workspaceInitials(workspace.name)}
        </span>
        <span className="workspace-details">
          <span className="workspace-title">{workspace.name}</span>
          <span className="workspace-branch-pill">
            <FiGitBranch size={12} />
            <span>{branchLabel}</span>
          </span>
        </span>
      </button>
      <button
        type="button"
        className="icon-button workspace-danger-button"
        aria-label={`Remove ${workspace.name}`}
        title="Remove workspace"
        onClick={(event) => {
          event.stopPropagation()
          removeWorkspace(workspace.id)
        }}
      >
        <FiTrash2 size={13} />
      </button>
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
      aria-valuemin={SIDEBAR_COLLAPSED_WIDTH}
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
          onResize(
            displayWidth <= SIDEBAR_COMPACT_THRESHOLD
              ? SIDEBAR_EXPANDED_MIN_WIDTH
              : normalizeSidebarWidth(displayWidth + SIDEBAR_KEYBOARD_RESIZE_STEP),
          )
          return
        }
        if (event.key === 'Home') {
          event.preventDefault()
          onResize(SIDEBAR_COLLAPSED_WIDTH)
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

  const className = [
    'tao-sidebar',
    displayWidth <= SIDEBAR_COMPACT_THRESHOLD ? 'tao-sidebar-compact' : null,
    displayWidth <= SIDEBAR_HIDE_HEADER_ACTIONS_THRESHOLD
      ? 'tao-sidebar-header-actions-hidden'
      : null,
  ]
    .filter(Boolean)
    .join(' ')

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
        title="New tab"
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
  isActive,
  focusToken,
  onSelect,
  onTitleChange,
  onRestartSession,
  onArchiveStateChange,
}: {
  pane: Pane
  terminalCwd?: string
  isActive: boolean
  focusToken: number
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
          cwd={pane.cwd ?? terminalCwd}
          isActive={isActive}
          focusToken={focusToken}
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
  panesById,
  activePaneId,
  terminalFocusTokens,
  onLayoutRelease,
  onSelectPane,
  onPaneTitle,
  onRestartPaneSession,
  onPaneArchiveState,
}: {
  tab: Tab
  terminalCwd?: string
  panesById: Map<string, Pane>
  activePaneId: string | null
  terminalFocusTokens: ReadonlyMap<string, number>
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
          isActive={pane.id === activePaneId}
          focusToken={terminalFocusTokens.get(pane.id) ?? 0}
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
      terminalFocusTokens,
    ],
  )

  return (
    <MosaicView
      value={draftLayout}
      onChange={handleLayoutChange}
      onRelease={handleLayoutRelease}
      renderTile={renderTile}
      className="tao-mosaic"
      resize={{ minimumPaneSizePercentage: 18 }}
      zeroStateView={<div className="pane-grid-empty" />}
    />
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
  const ensureWorkspaceTab = useTaoStore((state) => state.ensureWorkspaceTab)
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
  const hydrateLayout = useTaoStore((state) => state.hydrateLayout)
  const [terminalFocusCounts, setTerminalFocusCounts] = useState<Record<string, number>>({})
  const [sidebarResizePreviewWidth, setSidebarResizePreviewWidth] = useState<number | null>(null)
  const [layoutLoaded, setLayoutLoaded] = useState(false)
  const activeWorkspaceKey = activeWorkspaceId ?? LOCAL_WORKSPACE_ID
  const sidebarSize = useMemo(
    () =>
      Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(
          SIDEBAR_COLLAPSED_WIDTH,
          sidebarWidth >= SIDEBAR_EXPANDED_MIN_WIDTH ? sidebarWidth : SIDEBAR_COLLAPSED_WIDTH,
        ),
      ),
    [sidebarWidth],
  )
  const sortedWorkspaces = useMemo(
    () => [...workspaces].sort((a, b) => a.order - b.order),
    [workspaces],
  )
  const activeWorkspace = useMemo(
    () => sortedWorkspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null,
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
      tabs
        .filter((tab) => tab.workspaceId === activeWorkspaceKey)
        .sort((a, b) => a.order - b.order),
    [activeWorkspaceKey, tabs],
  )
  const mountedTabs = useMemo(
    () => [...tabs].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId) || a.order - b.order),
    [tabs],
  )
  const activeTab = useMemo(
    () => workspaceTabs.find((tab) => tab.id === activeTabId) ?? workspaceTabs[0] ?? null,
    [activeTabId, workspaceTabs],
  )
  const workspacePathById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace.projectPath])),
    [workspaces],
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
  const previousPaneSessionsRef = useRef(
    new Map(panes.map((pane) => [pane.id, pane.lastSessionId ?? pane.id])),
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
    ensureWorkspaceTab(activeWorkspaceKey)
  }, [activeWorkspaceKey, ensureWorkspaceTab, layoutLoaded])

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

    const runCommand = (command: AppCommand) => {
      switch (command.type) {
        case 'toggle-sidebar':
          toggleSidebar()
          break
        case 'new-tab':
          newTab(activeWorkspaceKey)
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
  const isSidebarCompact =
    sidebarExpanded && (sidebarResizePreviewWidth ?? sidebarSize) <= SIDEBAR_COMPACT_THRESHOLD
  const shellStyle = {
    '--tao-sidebar-width': `${sidebarExpanded ? (sidebarResizePreviewWidth ?? sidebarSize) : 0}px`,
  } as CSSProperties & Record<'--tao-sidebar-width', string>
  const shellClassName = [
    'tao-shell',
    sidebarExpanded ? null : 'tao-shell-sidebar-hidden',
    isSidebarCompact ? 'tao-shell-sidebar-compact' : null,
  ]
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
          {!isSidebarCompact ? (
            <HeaderNavigation
              isSidebarVisible={sidebarExpanded}
              canGoPreviousWorkspace={canGoPreviousWorkspace}
              canGoNextWorkspace={canGoNextWorkspace}
              onToggleSidebar={() => setSidebarExpanded(!sidebarExpanded)}
              onPreviousWorkspace={() => selectWorkspaceAtIndex(activeWorkspaceIndex - 1)}
              onNextWorkspace={() => selectWorkspaceAtIndex(activeWorkspaceIndex + 1)}
            />
          ) : null}
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
            showHeaderNavigation={!sidebarExpanded || isSidebarCompact}
            isSidebarVisible={sidebarExpanded}
            canGoPreviousWorkspace={canGoPreviousWorkspace}
            canGoNextWorkspace={canGoNextWorkspace}
            onToggleSidebar={() => setSidebarExpanded(!sidebarExpanded)}
            onPreviousWorkspace={() => selectWorkspaceAtIndex(activeWorkspaceIndex - 1)}
            onNextWorkspace={() => selectWorkspaceAtIndex(activeWorkspaceIndex + 1)}
            onNewTab={() => newTab(activeWorkspaceKey)}
            onSelectTab={selectTab}
            onCloseTab={closeTab}
            onReorderTab={reorderTab}
            archivedTabIds={archivedTabIds}
          />
          <div className="pane-grid">
            {mountedTabs.length > 0 ? (
              mountedTabs.map((tab) => {
                const isTabActive = tab.id === activeTab?.id
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
                      terminalCwd={workspacePathById.get(tab.workspaceId)}
                      panesById={panesById}
                      activePaneId={isTabActive ? activePaneId : null}
                      terminalFocusTokens={terminalFocusTokens}
                      onLayoutRelease={setTabLayout}
                      onSelectPane={selectPane}
                      onPaneTitle={setPaneTitle}
                      onRestartPaneSession={restartPaneSession}
                      onPaneArchiveState={handlePaneArchiveState}
                    />
                  </div>
                )
              })
            ) : (
              <div className="pane-grid-empty">
                <button
                  type="button"
                  className="empty-new-tab-button"
                  aria-label="New tab"
                  onClick={() => newTab(activeWorkspaceKey)}
                >
                  <FiPlus size={15} />
                </button>
              </div>
            )}
          </div>
        </main>
      </section>
    </div>
  )
}
