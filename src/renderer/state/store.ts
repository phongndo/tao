import { create } from 'zustand'

export interface TauState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  tabs: Tab[]
  activeTabId: string | null
  panes: Pane[]
  sidebarExpanded: boolean
  sidebarWidth: number
  toggleSidebar(): void
}

export interface Workspace {
  id: string
  name: string
  projectPath: string
  branch?: string
  worktrees?: WorktreeInfo[]
  order: number
}

export interface WorktreeInfo {
  path: string
  branch: string
  hash: string
  isBare: boolean
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

export const useTauStore = create<TauState>((set) => ({
  workspaces: [],
  activeWorkspaceId: null,
  tabs: [],
  activeTabId: null,
  panes: [],
  sidebarExpanded: true,
  sidebarWidth: 240,
  toggleSidebar: () => set((state) => ({ sidebarExpanded: !state.sidebarExpanded })),
}))
