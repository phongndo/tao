import {
  FolderPlus,
  GitBranch,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import {
  type DragEvent,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Mosaic, type MosaicNode } from 'react-mosaic-component'
import type { AppCommand } from '../../shared/app-command'
import {
  LOCAL_WORKSPACE_ID,
  type Pane,
  type ReorderPlacement,
  type Tab,
  useTauStore,
  type Workspace,
} from '../state/store'
import { useGitBranch, useGitWorktrees } from '../workspaceQueries'
import { TerminalPane } from './TerminalPane'

const SIDEBAR_DEFAULT_WIDTH = 240
const SIDEBAR_COLLAPSED_WIDTH = 52
const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 360
const SIDEBAR_COLLAPSE_THRESHOLD = 120
const SIDEBAR_KEYBOARD_RESIZE_STEP = 12
const TAB_DRAG_TYPE = 'application/x-tau-tab'
const WORKSPACE_DRAG_TYPE = 'application/x-tau-workspace'

function workspaceNameFromPath(projectPath: string): string {
  return projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath
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
  const activeWorkspaceId = useTauStore((state) => state.activeWorkspaceId)
  const selectWorkspace = useTauStore((state) => state.selectWorkspace)
  const removeWorkspace = useTauStore((state) => state.removeWorkspace)
  const isActive = activeWorkspaceId === workspace.id
  const branch = useGitBranch(workspace.projectPath, isActive)
  const worktrees = useGitWorktrees(workspace.projectPath, isActive)
  const branchLabel = branch.isError
    ? 'git error'
    : (branch.data ?? (branch.isLoading ? 'loading' : 'no git branch'))

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
      <div className="workspace-row">
        <button
          type="button"
          className="workspace-select-button"
          onClick={() => selectWorkspace(workspace.id)}
          aria-pressed={isActive}
        >
          <span className="workspace-title">{workspace.name}</span>
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={`Remove ${workspace.name}`}
          onClick={(event) => {
            event.stopPropagation()
            removeWorkspace(workspace.id)
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>
      <span className="workspace-path">{workspace.projectPath}</span>
      <span className="workspace-meta-row">
        <GitBranch size={12} />
        <span>{branchLabel}</span>
      </span>
      {worktrees.isError ? (
        <span className="worktree-error">worktrees unavailable</span>
      ) : worktrees.data && worktrees.data.length > 1 ? (
        <span className="worktree-list">
          {worktrees.data.map((worktree) => (
            <span className="worktree-item" key={worktree.path}>
              {workspaceNameFromPath(worktree.path)}
              {worktree.branch ? <span className="worktree-branch">{worktree.branch}</span> : null}
            </span>
          ))}
        </span>
      ) : null}
    </div>
  )
}

function CollapsedWorkspaceItem({
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
  const activeWorkspaceId = useTauStore((state) => state.activeWorkspaceId)
  const selectWorkspace = useTauStore((state) => state.selectWorkspace)
  const isActive = activeWorkspaceId === workspace.id
  const label = workspace.name.trim().slice(0, 1).toUpperCase() || 'W'

  return (
    <button
      type="button"
      className={
        isActive
          ? 'collapsed-workspace-button collapsed-workspace-button-active'
          : 'collapsed-workspace-button'
      }
      title={workspace.name}
      aria-label={workspace.name}
      aria-pressed={isActive}
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
      onClick={() => selectWorkspace(workspace.id)}
    >
      <span>{label}</span>
    </button>
  )
}

function ResizeShell({
  children,
  width,
  isCollapsed,
  onResize,
}: {
  children: ReactNode
  width: number
  isCollapsed: boolean
  onResize(width: number): void
}) {
  const [isResizing, setIsResizing] = useState(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)
  const pendingWidthRef = useRef<number | null>(null)
  const frameRef = useRef<number | null>(null)

  const flushPendingWidth = useCallback(() => {
    const nextWidth = pendingWidthRef.current
    pendingWidthRef.current = null
    if (nextWidth === null) return
    onResize(nextWidth)
  }, [onResize])

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
    setIsResizing(false)
  }, [flushPendingWidth, isResizing])

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
    }
  }, [handlePointerMove, handlePointerUp, isResizing])

  const resizeHandle = (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={SIDEBAR_COLLAPSED_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      aria-valuenow={width}
      aria-label="Resize sidebar"
      tabIndex={0}
      className={isResizing ? 'resize-handle resize-handle-active' : 'resize-handle'}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        startXRef.current = event.clientX
        startWidthRef.current = width
        setIsResizing(true)
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          onResize(width - SIDEBAR_KEYBOARD_RESIZE_STEP)
          return
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          onResize(isCollapsed ? SIDEBAR_DEFAULT_WIDTH : width + SIDEBAR_KEYBOARD_RESIZE_STEP)
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
          onResize(isCollapsed ? SIDEBAR_DEFAULT_WIDTH : SIDEBAR_COLLAPSED_WIDTH)
        }
      }}
      onDoubleClick={() => onResize(SIDEBAR_DEFAULT_WIDTH)}
    />
  )

  return (
    <aside
      className={isCollapsed ? 'tau-sidebar tau-sidebar-collapsed' : 'tau-sidebar'}
      style={{ width }}
      aria-label="Workspaces"
    >
      {children}
      {resizeHandle}
    </aside>
  )
}

const TabBar = memo(function TabBar({
  tabs,
  activeTabId,
  onNewTab,
  onSelectTab,
  onCloseTab,
  onReorderTab,
}: {
  tabs: Tab[]
  activeTabId: string | null
  onNewTab(): void
  onSelectTab(tabId: string): void
  onCloseTab(tabId: string): void
  onReorderTab(tabId: string, targetTabId: string, placement: ReorderPlacement): void
}) {
  return (
    <div className="tab-bar">
      <div className="tab-list" role="tablist" aria-label="Terminal tabs">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId
          return (
            <div
              className={isActive ? 'tab-item tab-item-active' : 'tab-item'}
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
                onClick={() => onSelectTab(tab.id)}
              >
                <Terminal size={13} />
                <span>{tab.name}</span>
              </button>
              <button
                type="button"
                className="tab-close-button"
                aria-label={`Close ${tab.name}`}
                title="Close tab"
                onClick={() => onCloseTab(tab.id)}
              >
                <X size={12} />
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
        <Plus size={15} />
      </button>
    </div>
  )
})

const PaneTile = memo(function PaneTile({
  pane,
  terminalCwd,
  isActive,
  focusToken,
  onClose,
  onSelect,
  onTitleChange,
}: {
  pane: Pane
  terminalCwd?: string
  isActive: boolean
  focusToken: number
  onClose(): void
  onSelect(): void
  onTitleChange(title: string): void
}) {
  const status = pane.status ?? 'idle'

  return (
    <div
      className={isActive ? 'pane-tile pane-tile-active' : 'pane-tile'}
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
      <button
        type="button"
        className="pane-close-button"
        aria-label={`Close ${pane.name}`}
        title="Close pane"
        onPointerDown={(event) => {
          event.stopPropagation()
        }}
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
      >
        <X size={12} />
      </button>
      {pane.type === 'terminal' ? (
        <TerminalPane
          sessionId={pane.id}
          cwd={pane.cwd ?? terminalCwd}
          isActive={isActive}
          focusToken={focusToken}
          onTitleChange={onTitleChange}
        />
      ) : (
        <div className="pane-standby" aria-hidden="true">
          <Terminal size={18} />
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
  onClosePane,
  onLayoutRelease,
  onSelectPane,
  onPaneTitle,
}: {
  tab: Tab
  terminalCwd?: string
  panesById: Map<string, Pane>
  activePaneId: string | null
  terminalFocusTokens: ReadonlyMap<string, number>
  onClosePane(paneId: string): void
  onLayoutRelease(tabId: string, layout: MosaicNode<string> | null): void
  onSelectPane(paneId: string): void
  onPaneTitle(paneId: string, title: string): void
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
          onClose={() => onClosePane(pane.id)}
          onSelect={() => onSelectPane(pane.id)}
          onTitleChange={(title) => onPaneTitle(pane.id, title)}
        />
      )
    },
    [
      activePaneId,
      onClosePane,
      onPaneTitle,
      onSelectPane,
      panesById,
      terminalCwd,
      terminalFocusTokens,
    ],
  )

  return (
    <Mosaic<string>
      value={draftLayout}
      onChange={handleLayoutChange}
      onRelease={handleLayoutRelease}
      renderTile={renderTile}
      className="tau-mosaic"
      resize={{ minimumPaneSizePercentage: 18 }}
      zeroStateView={<div className="pane-grid-empty" />}
    />
  )
})

export function App() {
  const workspaces = useTauStore((state) => state.workspaces)
  const tabs = useTauStore((state) => state.tabs)
  const panes = useTauStore((state) => state.panes)
  const activeTabId = useTauStore((state) => state.activeTabId)
  const activePaneId = useTauStore((state) => state.activePaneId)
  const activeWorkspaceId = useTauStore((state) => state.activeWorkspaceId)
  const sidebarExpanded = useTauStore((state) => state.sidebarExpanded)
  const sidebarWidth = useTauStore((state) => state.sidebarWidth)
  const addWorkspace = useTauStore((state) => state.addWorkspace)
  const ensureWorkspaceTab = useTauStore((state) => state.ensureWorkspaceTab)
  const selectWorkspaceByIndex = useTauStore((state) => state.selectWorkspaceByIndex)
  const newTab = useTauStore((state) => state.newTab)
  const closeTab = useTauStore((state) => state.closeTab)
  const closeActiveTab = useTauStore((state) => state.closeActiveTab)
  const selectTab = useTauStore((state) => state.selectTab)
  const selectTabByIndex = useTauStore((state) => state.selectTabByIndex)
  const reorderTab = useTauStore((state) => state.reorderTab)
  const setTabLayout = useTauStore((state) => state.setTabLayout)
  const selectPane = useTauStore((state) => state.selectPane)
  const selectPaneByDirection = useTauStore((state) => state.selectPaneByDirection)
  const setPaneTitle = useTauStore((state) => state.setPaneTitle)
  const splitActivePane = useTauStore((state) => state.splitActivePane)
  const closePane = useTauStore((state) => state.closePane)
  const closeActivePane = useTauStore((state) => state.closeActivePane)
  const setSidebarWidth = useTauStore((state) => state.setSidebarWidth)
  const setSidebarExpanded = useTauStore((state) => state.setSidebarExpanded)
  const toggleSidebar = useTauStore((state) => state.toggleSidebar)
  const reorderWorkspace = useTauStore((state) => state.reorderWorkspace)
  const [terminalFocusCounts, setTerminalFocusCounts] = useState<Record<string, number>>({})
  const activeWorkspaceKey = activeWorkspaceId ?? LOCAL_WORKSPACE_ID
  const sidebarSize = useMemo(
    () =>
      Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(
          SIDEBAR_MIN_WIDTH,
          sidebarWidth >= SIDEBAR_MIN_WIDTH ? sidebarWidth : SIDEBAR_DEFAULT_WIDTH,
        ),
      ),
    [sidebarWidth],
  )
  const renderedSidebarWidth = sidebarExpanded ? sidebarSize : SIDEBAR_COLLAPSED_WIDTH
  const workspaceTabs = useMemo(
    () =>
      tabs
        .filter((tab) => tab.workspaceId === activeWorkspaceKey)
        .sort((a, b) => a.order - b.order),
    [activeWorkspaceKey, tabs],
  )
  const activeTab = useMemo(
    () => workspaceTabs.find((tab) => tab.id === activeTabId) ?? workspaceTabs[0] ?? null,
    [activeTabId, workspaceTabs],
  )
  const workspacePathById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace.projectPath])),
    [workspaces],
  )
  const activeTabCwd = activeTab ? workspacePathById.get(activeTab.workspaceId) : undefined
  const panesById = useMemo(() => new Map(panes.map((pane) => [pane.id, pane])), [panes])
  const terminalFocusTokens = useMemo(
    () => new Map(Object.entries(terminalFocusCounts)),
    [terminalFocusCounts],
  )
  const previousPaneIdsRef = useRef(new Set(panes.map((pane) => pane.id)))

  useEffect(() => {
    ensureWorkspaceTab(activeWorkspaceKey)
  }, [activeWorkspaceKey, ensureWorkspaceTab])

  useEffect(() => {
    document.title = activeTab ? `${activeTab.name} — Tau` : 'Tau'
  }, [activeTab])

  useEffect(() => {
    const nextPaneIds = new Set(panes.map((pane) => pane.id))
    for (const paneId of previousPaneIdsRef.current) {
      if (!nextPaneIds.has(paneId)) {
        window.electronAPI.killPty(paneId)
      }
    }
    previousPaneIdsRef.current = nextPaneIds
  }, [panes])

  useEffect(() => {
    const focusActiveTerminal = () => {
      const paneId = useTauStore.getState().activePaneId
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

  const handleResizeSidebar = useCallback(
    (nextWidth: number) => {
      if (nextWidth < SIDEBAR_COLLAPSE_THRESHOLD) {
        setSidebarExpanded(false)
        return
      }

      const clampedWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, nextWidth))
      setSidebarWidth(clampedWidth)
      setSidebarExpanded(true)
    },
    [setSidebarExpanded, setSidebarWidth],
  )

  const sortedWorkspaces = [...workspaces].sort((a, b) => a.order - b.order)

  return (
    <div className="tau-shell">
      <ResizeShell
        width={renderedSidebarWidth}
        isCollapsed={!sidebarExpanded}
        onResize={handleResizeSidebar}
      >
        {sidebarExpanded ? (
          <div className="sidebar-content">
            <div className="sidebar-header">
              <span className="sidebar-title">Tau</span>
              <div className="sidebar-header-actions">
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Collapse sidebar"
                  title="Collapse sidebar"
                  onClick={() => setSidebarExpanded(false)}
                >
                  <PanelLeftClose size={15} />
                </button>
                <button
                  type="button"
                  className="icon-button add-workspace-button"
                  aria-label="Add workspace"
                  onClick={handleAddWorkspace}
                >
                  <FolderPlus size={15} />
                </button>
              </div>
            </div>
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
            ) : (
              <div className="workspace-placeholder">
                <span className="workspace-name">No workspaces</span>
                <span className="workspace-meta">Add a project directory</span>
              </div>
            )}
          </div>
        ) : (
          <div className="collapsed-sidebar-content">
            <button
              type="button"
              className="collapsed-sidebar-toggle"
              aria-label="Expand sidebar"
              title="Expand sidebar"
              onClick={() => setSidebarExpanded(true)}
            >
              <PanelLeftOpen size={16} />
            </button>
            <button
              type="button"
              className="collapsed-sidebar-toggle"
              aria-label="Add workspace"
              title="Add workspace"
              onClick={handleAddWorkspace}
            >
              <FolderPlus size={16} />
            </button>
            <div className="collapsed-workspace-list">
              {sortedWorkspaces.map((workspace) => (
                <CollapsedWorkspaceItem
                  key={workspace.id}
                  workspace={workspace}
                  onReorderWorkspace={reorderWorkspace}
                />
              ))}
            </div>
          </div>
        )}
      </ResizeShell>
      <section className="tau-main">
        <main className="main-content">
          <TabBar
            tabs={workspaceTabs}
            activeTabId={activeTab?.id ?? null}
            onNewTab={() => newTab(activeWorkspaceKey)}
            onSelectTab={selectTab}
            onCloseTab={closeTab}
            onReorderTab={reorderTab}
          />
          <div className="pane-grid">
            {activeTab ? (
              <PaneGrid
                key={activeTab.id}
                tab={activeTab}
                terminalCwd={activeTabCwd}
                panesById={panesById}
                activePaneId={activePaneId}
                terminalFocusTokens={terminalFocusTokens}
                onClosePane={closePane}
                onLayoutRelease={setTabLayout}
                onSelectPane={selectPane}
                onPaneTitle={setPaneTitle}
              />
            ) : (
              <div className="pane-grid-empty">
                <button
                  type="button"
                  className="empty-new-tab-button"
                  aria-label="New tab"
                  onClick={() => newTab(activeWorkspaceKey)}
                >
                  <Plus size={15} />
                </button>
              </div>
            )}
          </div>
        </main>
      </section>
    </div>
  )
}
