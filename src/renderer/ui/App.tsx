import { FolderPlus, GitBranch, Trash2 } from 'lucide-react'
import { useEffect } from 'react'
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels'
import { useTauStore, type Workspace } from '../state/store'
import { useGitBranch, useGitWorktrees } from '../workspaceQueries'
import { TerminalPane } from './TerminalPane'

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

export function App() {
  const sidebarPanelRef = usePanelRef()
  const workspaces = useTauStore((state) => state.workspaces)
  const sidebarExpanded = useTauStore((state) => state.sidebarExpanded)
  const sidebarWidth = useTauStore((state) => state.sidebarWidth)
  const addWorkspace = useTauStore((state) => state.addWorkspace)
  const setSidebarWidth = useTauStore((state) => state.setSidebarWidth)
  const toggleSidebar = useTauStore((state) => state.toggleSidebar)

  useEffect(() => {
    const unsubscribeToggleSidebar = window.electronAPI.onToggleSidebar(toggleSidebar)

    return () => {
      unsubscribeToggleSidebar()
    }
  }, [toggleSidebar])

  useEffect(() => {
    if (sidebarExpanded) {
      sidebarPanelRef.current?.expand()
    } else {
      sidebarPanelRef.current?.collapse()
    }
  }, [sidebarExpanded, sidebarPanelRef])

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

  return (
    <Group orientation="horizontal" className="tau-shell">
      <Panel
        panelRef={sidebarPanelRef}
        defaultSize={`${sidebarWidth}px`}
        minSize="180px"
        maxSize="34%"
        collapsedSize={0}
        collapsible
        className="tau-sidebar"
        onResize={(size) => {
          if (typeof size === 'number' && size > 0) setSidebarWidth(size)
        }}
      >
        <aside className="sidebar-content" aria-label="Workspaces">
          <div className="sidebar-header">
            <span className="sidebar-title">Tau</span>
            <button
              type="button"
              className="icon-button add-workspace-button"
              aria-label="Add workspace"
              onClick={handleAddWorkspace}
            >
              <FolderPlus size={15} />
            </button>
          </div>
          {workspaces.length > 0 ? (
            <div className="workspace-list">
              {[...workspaces]
                .sort((a, b) => a.order - b.order)
                .map((workspace) => (
                  <WorkspaceItem key={workspace.id} workspace={workspace} />
                ))}
            </div>
          ) : (
            <div className="workspace-placeholder">
              <span className="workspace-name">No workspaces</span>
              <span className="workspace-meta">Add a project directory</span>
            </div>
          )}
        </aside>
      </Panel>
      <Separator className="resize-handle" />
      <Panel minSize="50%" className="tau-main">
        <main className="main-content">
          <TerminalPane />
        </main>
      </Panel>
    </Group>
  )
}
