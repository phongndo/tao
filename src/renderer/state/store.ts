import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { WorktreeInfo } from '../../shared/workspace'

export interface TauState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  tabs: Tab[]
  activeTabId: string | null
  panes: Pane[]
  sidebarExpanded: boolean
  sidebarWidth: number
  addWorkspace(workspace: Workspace): void
  removeWorkspace(workspaceId: string): void
  selectWorkspace(workspaceId: string): void
  toggleSidebar(): void
  setSidebarWidth(width: number): void
}

export interface Workspace {
  id: string
  name: string
  projectPath: string
  branch?: string
  worktrees?: WorktreeInfo[]
  order: number
}

export interface Tab {
  id: string
  workspaceId: string
  name: string
  layout: MosaicLayoutNode
  order: number
}

export type MosaicLayoutNode = string | MosaicLayoutParent

export interface MosaicLayoutParent {
  direction: 'row' | 'column'
  first: MosaicLayoutNode
  second: MosaicLayoutNode
  splitPercentage?: number
}

export interface Pane {
  id: string
  tabId: string
  type: PaneType
  name: string
  cwd?: string
  status?: PaneStatus
}

export type PaneType = 'terminal' | 'webview'
export type PaneStatus = 'idle' | 'working' | 'permission' | 'review'

export const useTauStore = create<TauState>()(
  persist(
    (set) => ({
      workspaces: [],
      activeWorkspaceId: null,
      tabs: [],
      activeTabId: null,
      panes: [],
      sidebarExpanded: true,
      sidebarWidth: 22,
      addWorkspace: (workspace) =>
        set((state) => {
          const existingWorkspace = state.workspaces.find(({ id }) => id === workspace.id)
          if (existingWorkspace) {
            return { activeWorkspaceId: existingWorkspace.id }
          }

          const orderedWorkspace = {
            ...workspace,
            order: state.workspaces.length,
          }

          return {
            workspaces: [...state.workspaces, orderedWorkspace],
            activeWorkspaceId: orderedWorkspace.id,
          }
        }),
      removeWorkspace: (workspaceId) =>
        set((state) => {
          const workspaces = state.workspaces
            .filter(({ id }) => id !== workspaceId)
            .map((workspace, order) => ({ ...workspace, order }))
          const activeWorkspaceId =
            state.activeWorkspaceId === workspaceId
              ? (workspaces.find(({ order }) => order === 0)?.id ?? null)
              : state.activeWorkspaceId

          return { workspaces, activeWorkspaceId }
        }),
      selectWorkspace: (workspaceId) => set({ activeWorkspaceId: workspaceId }),
      toggleSidebar: () => set((state) => ({ sidebarExpanded: !state.sidebarExpanded })),
      setSidebarWidth: (width) => set({ sidebarWidth: width }),
    }),
    {
      name: 'tau-workspaces',
      partialize: (state) => ({
        workspaces: state.workspaces,
        activeWorkspaceId: state.activeWorkspaceId,
        sidebarExpanded: state.sidebarExpanded,
        sidebarWidth: state.sidebarWidth,
      }),
    },
  ),
)
