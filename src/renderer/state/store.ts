import type {
  MosaicDirection,
  MosaicNode,
  MosaicSplitNode,
  MosaicTabsNode,
} from 'react-mosaic-component'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { WorktreeInfo } from '../../shared/workspace'

export const LOCAL_WORKSPACE_ID = 'tau:local'

export interface TauState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  tabs: Tab[]
  activeTabId: string | null
  panes: Pane[]
  activePaneId: string | null
  sidebarExpanded: boolean
  sidebarWidth: number
  addWorkspace(workspace: Workspace): void
  removeWorkspace(workspaceId: string): void
  selectWorkspace(workspaceId: string): void
  ensureWorkspaceTab(workspaceId?: string): void
  newTab(workspaceId?: string): void
  closeTab(tabId: string): void
  closeActiveTab(): void
  selectTab(tabId: string): void
  setTabLayout(tabId: string, layout: MosaicLayoutNode | null): void
  selectPane(paneId: string): void
  splitPane(paneId: string, direction: MosaicDirection): void
  splitActivePane(direction: MosaicDirection): void
  closePane(paneId: string): void
  toggleSidebar(): void
  setSidebarExpanded(expanded: boolean): void
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

export type MosaicLayoutNode = MosaicNode<string>

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

function createId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`
}

function createTerminalPane(tabId: string, index: number): Pane {
  return {
    id: createId('pane'),
    tabId,
    type: 'terminal',
    name: `Terminal ${index}`,
    status: 'idle',
  }
}

function createTerminalTab(workspaceId: string, order: number): { tab: Tab; pane: Pane } {
  const tabId = createId('tab')
  const pane = createTerminalPane(tabId, 1)

  return {
    tab: {
      id: tabId,
      workspaceId,
      name: order === 0 ? 'Terminal' : `Terminal ${order + 1}`,
      layout: pane.id,
      order,
    },
    pane,
  }
}

function isSplitNode(node: MosaicLayoutNode): node is MosaicSplitNode<string> {
  return typeof node === 'object' && node !== null && node.type === 'split'
}

function isTabsNode(node: MosaicLayoutNode): node is MosaicTabsNode<string> {
  return typeof node === 'object' && node !== null && node.type === 'tabs'
}

function getWorkspaceTabs(tabs: Tab[], workspaceId: string): Tab[] {
  return tabs.filter((tab) => tab.workspaceId === workspaceId).sort((a, b) => a.order - b.order)
}

function getPaneIdsInLayout(layout: MosaicLayoutNode): string[] {
  if (typeof layout === 'string') return [layout]
  if (isSplitNode(layout)) return layout.children.flatMap(getPaneIdsInLayout)
  if (isTabsNode(layout)) return layout.tabs
  return []
}

function getFirstPaneId(layout: MosaicLayoutNode): string | null {
  return getPaneIdsInLayout(layout)[0] ?? null
}

function layoutContainsPane(layout: MosaicLayoutNode, paneId: string): boolean {
  return getPaneIdsInLayout(layout).includes(paneId)
}

function splitLayoutNode(
  layout: MosaicLayoutNode,
  paneId: string,
  newPaneId: string,
  direction: MosaicDirection,
): MosaicLayoutNode {
  if (layout === paneId) {
    return {
      type: 'split',
      direction,
      children: [paneId, newPaneId],
      splitPercentages: [50, 50],
    }
  }

  if (typeof layout === 'string') return layout

  if (isSplitNode(layout)) {
    return {
      ...layout,
      children: layout.children.map((child) =>
        splitLayoutNode(child, paneId, newPaneId, direction),
      ),
    }
  }

  return layout
}

function normalizeSplitPercentages(length: number): number[] {
  return Array.from({ length }, () => 100 / length)
}

function removePaneFromLayout(
  layout: MosaicLayoutNode,
  paneId: string,
): { layout: MosaicLayoutNode | null; removed: boolean } {
  if (layout === paneId) return { layout: null, removed: true }
  if (typeof layout === 'string') return { layout, removed: false }

  if (isSplitNode(layout)) {
    let removed = false
    const children = layout.children.flatMap((child) => {
      const result = removePaneFromLayout(child, paneId)
      removed ||= result.removed
      return result.layout ? [result.layout] : []
    })

    if (!removed) return { layout, removed: false }
    if (children.length === 0) return { layout: null, removed: true }
    if (children.length === 1) return { layout: children[0], removed: true }

    return {
      layout: {
        ...layout,
        children,
        splitPercentages: normalizeSplitPercentages(children.length),
      },
      removed: true,
    }
  }

  if (isTabsNode(layout)) {
    const tabs = layout.tabs.filter((tab) => tab !== paneId)
    if (tabs.length === layout.tabs.length) return { layout, removed: false }
    if (tabs.length === 0) return { layout: null, removed: true }
    if (tabs.length === 1) return { layout: tabs[0], removed: true }

    return {
      layout: {
        ...layout,
        tabs,
        activeTabIndex: Math.min(layout.activeTabIndex, tabs.length - 1),
      },
      removed: true,
    }
  }

  return { layout, removed: false }
}

function reorderWorkspaceTabs(tabs: Tab[], workspaceId: string): Tab[] {
  let order = 0
  return tabs.map((tab) => (tab.workspaceId === workspaceId ? { ...tab, order: order++ } : tab))
}

function closeTabState(state: TauState, tabId: string): Partial<TauState> {
  const tab = state.tabs.find((candidate) => candidate.id === tabId)
  if (!tab) return {}

  const paneIds = new Set(getPaneIdsInLayout(tab.layout))
  const nextTabs = reorderWorkspaceTabs(
    state.tabs.filter((candidate) => candidate.id !== tabId),
    tab.workspaceId,
  )
  const nextPanes = state.panes.filter((pane) => pane.tabId !== tabId && !paneIds.has(pane.id))

  if (state.activeTabId !== tabId) {
    return { tabs: nextTabs, panes: nextPanes }
  }

  const nextActiveTab = getWorkspaceTabs(nextTabs, tab.workspaceId)[0] ?? null

  return {
    tabs: nextTabs,
    panes: nextPanes,
    activeTabId: nextActiveTab?.id ?? null,
    activePaneId: nextActiveTab ? getFirstPaneId(nextActiveTab.layout) : null,
  }
}

function ensureWorkspaceTabState(state: TauState, workspaceId: string): Partial<TauState> {
  const existingTab = getWorkspaceTabs(state.tabs, workspaceId)[0]
  if (existingTab) {
    return {
      activeTabId: existingTab.id,
      activePaneId: getFirstPaneId(existingTab.layout),
    }
  }

  const { tab, pane } = createTerminalTab(workspaceId, 0)
  return {
    tabs: [...state.tabs, tab],
    panes: [...state.panes, pane],
    activeTabId: tab.id,
    activePaneId: pane.id,
  }
}

const initialLocalTab = createTerminalTab(LOCAL_WORKSPACE_ID, 0)

export const useTauStore = create<TauState>()(
  persist(
    (set) => ({
      workspaces: [],
      activeWorkspaceId: null,
      tabs: [initialLocalTab.tab],
      activeTabId: initialLocalTab.tab.id,
      panes: [initialLocalTab.pane],
      activePaneId: initialLocalTab.pane.id,
      sidebarExpanded: true,
      sidebarWidth: 240,
      addWorkspace: (workspace) =>
        set((state) => {
          const existingWorkspace = state.workspaces.find(({ id }) => id === workspace.id)
          if (existingWorkspace) {
            return {
              activeWorkspaceId: existingWorkspace.id,
              ...ensureWorkspaceTabState(state, existingWorkspace.id),
            }
          }

          const orderedWorkspace = {
            ...workspace,
            order: state.workspaces.length,
          }
          const { tab, pane } = createTerminalTab(orderedWorkspace.id, 0)

          return {
            workspaces: [...state.workspaces, orderedWorkspace],
            activeWorkspaceId: orderedWorkspace.id,
            tabs: [...state.tabs, tab],
            activeTabId: tab.id,
            panes: [...state.panes, pane],
            activePaneId: pane.id,
          }
        }),
      removeWorkspace: (workspaceId) =>
        set((state) => {
          const workspaces = state.workspaces
            .filter(({ id }) => id !== workspaceId)
            .map((workspace, order) => ({ ...workspace, order }))
          const removedTabIds = new Set(
            state.tabs.filter((tab) => tab.workspaceId === workspaceId).map((tab) => tab.id),
          )
          const tabs = state.tabs.filter((tab) => tab.workspaceId !== workspaceId)
          const panes = state.panes.filter((pane) => !removedTabIds.has(pane.tabId))
          const activeWorkspaceId =
            state.activeWorkspaceId === workspaceId
              ? (workspaces.find(({ order }) => order === 0)?.id ?? null)
              : state.activeWorkspaceId

          const nextState = { ...state, workspaces, tabs, panes, activeWorkspaceId }
          const nextTab = activeWorkspaceId
            ? getWorkspaceTabs(tabs, activeWorkspaceId)[0]
            : getWorkspaceTabs(tabs, LOCAL_WORKSPACE_ID)[0]

          return {
            workspaces,
            activeWorkspaceId,
            tabs,
            panes,
            activeTabId: nextTab?.id ?? null,
            activePaneId: nextTab ? getFirstPaneId(nextTab.layout) : null,
            ...(activeWorkspaceId ? ensureWorkspaceTabState(nextState, activeWorkspaceId) : {}),
          }
        }),
      selectWorkspace: (workspaceId) =>
        set((state) => ({
          activeWorkspaceId: workspaceId,
          ...ensureWorkspaceTabState(state, workspaceId),
        })),
      ensureWorkspaceTab: (workspaceId) =>
        set((state) =>
          ensureWorkspaceTabState(
            state,
            workspaceId ?? state.activeWorkspaceId ?? LOCAL_WORKSPACE_ID,
          ),
        ),
      newTab: (workspaceId) =>
        set((state) => {
          const targetWorkspaceId = workspaceId ?? state.activeWorkspaceId ?? LOCAL_WORKSPACE_ID
          const order = getWorkspaceTabs(state.tabs, targetWorkspaceId).length
          const { tab, pane } = createTerminalTab(targetWorkspaceId, order)

          return {
            tabs: [...state.tabs, tab],
            activeTabId: tab.id,
            panes: [...state.panes, pane],
            activePaneId: pane.id,
          }
        }),
      closeTab: (tabId) => set((state) => closeTabState(state, tabId)),
      closeActiveTab: () =>
        set((state) => (state.activeTabId ? closeTabState(state, state.activeTabId) : {})),
      selectTab: (tabId) =>
        set((state) => {
          const tab = state.tabs.find((candidate) => candidate.id === tabId)
          if (!tab) return {}

          return {
            activeWorkspaceId:
              tab.workspaceId === LOCAL_WORKSPACE_ID ? state.activeWorkspaceId : tab.workspaceId,
            activeTabId: tab.id,
            activePaneId: getFirstPaneId(tab.layout),
          }
        }),
      setTabLayout: (tabId, layout) =>
        set((state) => {
          if (!layout) return closeTabState(state, tabId)

          const tab = state.tabs.find((candidate) => candidate.id === tabId)
          if (!tab) return {}

          const paneIds = new Set(getPaneIdsInLayout(layout))
          const activePaneId =
            state.activeTabId === tabId && (!state.activePaneId || !paneIds.has(state.activePaneId))
              ? (getPaneIdsInLayout(layout)[0] ?? null)
              : state.activePaneId

          return {
            tabs: state.tabs.map((candidate) =>
              candidate.id === tabId ? { ...candidate, layout } : candidate,
            ),
            panes: state.panes.filter((pane) => pane.tabId !== tabId || paneIds.has(pane.id)),
            activePaneId,
          }
        }),
      selectPane: (paneId) =>
        set((state) => {
          const pane = state.panes.find((candidate) => candidate.id === paneId)
          if (!pane) return {}

          return {
            activePaneId: pane.id,
            activeTabId: pane.tabId,
          }
        }),
      splitPane: (paneId, direction) =>
        set((state) => {
          const pane = state.panes.find((candidate) => candidate.id === paneId)
          const tab = pane ? state.tabs.find((candidate) => candidate.id === pane.tabId) : null
          if (!pane || !tab || !layoutContainsPane(tab.layout, pane.id)) return {}

          const paneIndex = state.panes.filter((candidate) => candidate.tabId === tab.id).length + 1
          const newPane = createTerminalPane(tab.id, paneIndex)
          const layout = splitLayoutNode(tab.layout, pane.id, newPane.id, direction)

          return {
            tabs: state.tabs.map((candidate) =>
              candidate.id === tab.id ? { ...candidate, layout } : candidate,
            ),
            panes: [...state.panes, newPane],
            activeTabId: tab.id,
            activePaneId: pane.id,
          }
        }),
      splitActivePane: (direction) =>
        set((state) => {
          const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId)
          const paneId = state.activePaneId ?? (activeTab ? getFirstPaneId(activeTab.layout) : null)
          if (!paneId) return {}

          const pane = state.panes.find((candidate) => candidate.id === paneId)
          const tab = pane ? state.tabs.find((candidate) => candidate.id === pane.tabId) : null
          if (!pane || !tab || !layoutContainsPane(tab.layout, pane.id)) return {}

          const paneIndex = state.panes.filter((candidate) => candidate.tabId === tab.id).length + 1
          const newPane = createTerminalPane(tab.id, paneIndex)
          const layout = splitLayoutNode(tab.layout, pane.id, newPane.id, direction)

          return {
            tabs: state.tabs.map((candidate) =>
              candidate.id === tab.id ? { ...candidate, layout } : candidate,
            ),
            panes: [...state.panes, newPane],
            activeTabId: tab.id,
            activePaneId: pane.id,
          }
        }),
      closePane: (paneId) =>
        set((state) => {
          const pane = state.panes.find((candidate) => candidate.id === paneId)
          const tab = pane ? state.tabs.find((candidate) => candidate.id === pane.tabId) : null
          if (!pane || !tab) return {}

          const result = removePaneFromLayout(tab.layout, pane.id)
          if (!result.removed) return {}
          if (!result.layout) return closeTabState(state, tab.id)

          const layout = result.layout
          const nextPaneIds = new Set(getPaneIdsInLayout(layout))
          const activePaneId =
            state.activePaneId === pane.id
              ? (getPaneIdsInLayout(layout)[0] ?? null)
              : state.activePaneId

          return {
            tabs: state.tabs.map((candidate) =>
              candidate.id === tab.id ? { ...candidate, layout } : candidate,
            ),
            panes: state.panes.filter(
              (candidate) => candidate.tabId !== tab.id || nextPaneIds.has(candidate.id),
            ),
            activePaneId,
          }
        }),
      toggleSidebar: () => set((state) => ({ sidebarExpanded: !state.sidebarExpanded })),
      setSidebarExpanded: (expanded) => set({ sidebarExpanded: expanded }),
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
