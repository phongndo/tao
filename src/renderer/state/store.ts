import type { MosaicDirection, MosaicNode, MosaicParent } from 'react-mosaic-component'
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
  const randomUUID = globalThis.crypto?.randomUUID?.()
  if (randomUUID) return `${prefix}-${randomUUID}`

  if (globalThis.crypto?.getRandomValues) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))

    return `${prefix}-${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
      .slice(6, 8)
      .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
  }

  return `${prefix}-${Math.random().toString(36).slice(2)}`
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

function isParentNode(node: MosaicLayoutNode): node is MosaicParent<string> {
  return typeof node === 'object' && node !== null
}

function getWorkspaceTabs(tabs: Tab[], workspaceId: string): Tab[] {
  return tabs.filter((tab) => tab.workspaceId === workspaceId).sort((a, b) => a.order - b.order)
}

function getPaneIdsInLayout(layout: MosaicLayoutNode): string[] {
  if (typeof layout === 'string') return [layout]
  return [layout.first, layout.second].flatMap(getPaneIdsInLayout)
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
      direction,
      first: paneId,
      second: newPaneId,
      splitPercentage: 50,
    }
  }

  if (typeof layout === 'string') return layout

  if (isParentNode(layout)) {
    return {
      ...layout,
      first: splitLayoutNode(layout.first, paneId, newPaneId, direction),
      second: splitLayoutNode(layout.second, paneId, newPaneId, direction),
    }
  }

  return layout
}

function removePaneFromLayout(
  layout: MosaicLayoutNode,
  paneId: string,
): { layout: MosaicLayoutNode | null; removed: boolean } {
  if (layout === paneId) return { layout: null, removed: true }
  if (typeof layout === 'string') return { layout, removed: false }

  if (isParentNode(layout)) {
    const first = removePaneFromLayout(layout.first, paneId)
    const second = removePaneFromLayout(layout.second, paneId)
    const removed = first.removed || second.removed
    if (!removed) return { layout, removed: false }
    if (!first.layout && !second.layout) return { layout: null, removed: true }
    if (!first.layout) return { layout: second.layout, removed: true }
    if (!second.layout) return { layout: first.layout, removed: true }

    return {
      layout: {
        ...layout,
        first: first.layout,
        second: second.layout,
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
  const workspaceTabs = getWorkspaceTabs(state.tabs, workspaceId)
  const existingTab = workspaceTabs.find((tab) => tab.id === state.activeTabId) ?? workspaceTabs[0]
  if (existingTab) {
    const activePaneId =
      state.activePaneId && layoutContainsPane(existingTab.layout, state.activePaneId)
        ? state.activePaneId
        : getFirstPaneId(existingTab.layout)

    return {
      activeTabId: existingTab.id,
      activePaneId,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function repairPersistedState(state: TauState): TauState {
  const hasActiveWorkspace =
    state.activeWorkspaceId !== null &&
    state.workspaces.some((workspace) => workspace.id === state.activeWorkspaceId)
  const activeWorkspaceId = hasActiveWorkspace ? state.activeWorkspaceId : null
  const nextState = { ...state, activeWorkspaceId }
  const targetWorkspaceId = activeWorkspaceId ?? LOCAL_WORKSPACE_ID

  return {
    ...nextState,
    ...ensureWorkspaceTabState(nextState, targetWorkspaceId),
  }
}

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
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        panes: state.panes,
        activePaneId: state.activePaneId,
        sidebarExpanded: state.sidebarExpanded,
        sidebarWidth: state.sidebarWidth,
      }),
      merge: (persistedState, currentState) => {
        const persisted = isRecord(persistedState) ? persistedState : {}
        return repairPersistedState({ ...currentState, ...persisted })
      },
    },
  ),
)
