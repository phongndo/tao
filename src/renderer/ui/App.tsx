import { useEffect } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { useTauStore } from '../state/store'
import { TerminalPane } from './TerminalPane'

export function App() {
  const sidebarExpanded = useTauStore((state) => state.sidebarExpanded)
  const toggleSidebar = useTauStore((state) => state.toggleSidebar)

  useEffect(() => {
    const unsubscribeToggleSidebar = window.electronAPI.onToggleSidebar(toggleSidebar)

    function handleKeyDown(event: KeyboardEvent) {
      if (!event.metaKey || event.shiftKey || event.altKey || event.ctrlKey) return
      if (event.key.toLowerCase() !== 'b') return

      event.preventDefault()
      toggleSidebar()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      unsubscribeToggleSidebar()
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [toggleSidebar])

  return (
    <Group orientation="horizontal" className="tau-shell">
      {sidebarExpanded ? (
        <>
          <Panel defaultSize="22%" minSize="180px" maxSize="34%" className="tau-sidebar">
            <aside className="sidebar-content" aria-label="Workspaces">
              <div className="sidebar-header">
                <span className="sidebar-title">Tau</span>
              </div>
              <div className="workspace-placeholder">
                <span className="workspace-name">Workspace</span>
                <span className="workspace-meta">Phase 1 foundation</span>
              </div>
            </aside>
          </Panel>
          <Separator className="resize-handle" />
        </>
      ) : null}
      <Panel minSize="50%" className="tau-main">
        <main className="main-content">
          <TerminalPane />
        </main>
      </Panel>
    </Group>
  )
}
