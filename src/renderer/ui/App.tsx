import { useEffect } from 'react'
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels'
import { useTauStore } from '../state/store'
import { TerminalPane } from './TerminalPane'

export function App() {
  const sidebarPanelRef = usePanelRef()
  const sidebarExpanded = useTauStore((state) => state.sidebarExpanded)
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

  return (
    <Group orientation="horizontal" className="tau-shell">
      <Panel
        panelRef={sidebarPanelRef}
        defaultSize="22%"
        minSize="180px"
        maxSize="34%"
        collapsedSize={0}
        collapsible
        className="tau-sidebar"
      >
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
      <Panel minSize="50%" className="tau-main">
        <main className="main-content">
          <TerminalPane />
        </main>
      </Panel>
    </Group>
  )
}
