import { FolderPlus, GitBranch, PanelLeftClose, PanelLeftOpen, Trash2 } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTauStore, type Workspace } from '../state/store'
import { useGitBranch, useGitWorktrees } from '../workspaceQueries'
import { TerminalPane } from './TerminalPane'

const SIDEBAR_DEFAULT_WIDTH = 240
const SIDEBAR_COLLAPSED_WIDTH = 52
const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 360
const SIDEBAR_COLLAPSE_THRESHOLD = 120
const SIDEBAR_KEYBOARD_RESIZE_STEP = 12

function workspaceNameFromPath(projectPath: string): string {
  return projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath
}

function WorkspaceItem({ workspace }: { workspace: Workspace }) {
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
    <div className={isActive ? 'workspace-item workspace-item-active' : 'workspace-item'}>
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

function CollapsedWorkspaceItem({ workspace }: { workspace: Workspace }) {
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

  return (
    <aside
      className={isCollapsed ? 'tau-sidebar tau-sidebar-collapsed' : 'tau-sidebar'}
      style={{ width }}
      aria-label="Workspaces"
    >
      {children}
      {/* biome-ignore lint/a11y/useSemanticElements: <hr> is not appropriate for an interactive resize handle. */}
      <div
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
    </aside>
  )
}

export function App() {
  const workspaces = useTauStore((state) => state.workspaces)
  const sidebarExpanded = useTauStore((state) => state.sidebarExpanded)
  const sidebarWidth = useTauStore((state) => state.sidebarWidth)
  const addWorkspace = useTauStore((state) => state.addWorkspace)
  const setSidebarWidth = useTauStore((state) => state.setSidebarWidth)
  const setSidebarExpanded = useTauStore((state) => state.setSidebarExpanded)
  const toggleSidebar = useTauStore((state) => state.toggleSidebar)
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

  useEffect(() => {
    const unsubscribeToggleSidebar = window.electronAPI.onToggleSidebar(toggleSidebar)

    return () => {
      unsubscribeToggleSidebar()
    }
  }, [toggleSidebar])

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
                  <WorkspaceItem key={workspace.id} workspace={workspace} />
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
                <CollapsedWorkspaceItem key={workspace.id} workspace={workspace} />
              ))}
            </div>
          </div>
        )}
      </ResizeShell>
      <section className="tau-main">
        <main className="main-content">
          <TerminalPane />
        </main>
      </section>
    </div>
  )
}
