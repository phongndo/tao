import type { MosaicDirection, MosaicNode, MosaicParent } from 'react-mosaic-component'
import { Schema } from 'effect'
import { create } from 'zustand'
import type { PaneFocusDirection } from '@tao/shared/app-command'
import type { PaneLayoutData } from '@tao/shared/session'
import { type WorktreeInfo, WorktreeInfoSchema } from '@tao/shared/workspace'
import { sanitizeTerminalTitle } from '../osc-title'

export const LOCAL_WORKSPACE_ID = 'tao:local'

export interface TaoState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  lastActiveLocalTabId: string | null
  tabs: Tab[]
  activeTabId: string | null
  panes: Pane[]
  activePaneId: string | null
  sidebarExpanded: boolean
  sidebarWidth: number
  hydrateLayout(data: PaneLayoutData): void
  addWorkspace(workspace: Workspace): void
  removeWorkspace(workspaceId: string): void
  selectWorkspace(workspaceId: string): void
  selectWorkspaceByIndex(index: number): void
  ensureWorkspaceTab(workspaceId?: string): void
  newTab(workspaceId?: string): void
  closeTab(tabId: string): void
  closeActiveTab(): void
  selectTab(tabId: string): void
  selectTabByIndex(index: number): void
  reorderTab(tabId: string, targetTabId: string, placement: ReorderPlacement): void
  setTabLayout(tabId: string, layout: MosaicLayoutNode | null): void
  selectPane(paneId: string): void
  selectPaneByDirection(direction: PaneFocusDirection): void
  restartPaneSession(paneId: string): void
  setPaneTitle(paneId: string, title: string): void
  setPaneStatus(paneId: string, status: PaneStatus): void
  splitPane(paneId: string, direction: MosaicDirection): void
  splitActivePane(direction: MosaicDirection): void
  closePane(paneId: string): void
  closeActivePane(): void
  toggleSidebar(): void
  setSidebarExpanded(expanded: boolean): void
  setSidebarWidth(width: number): void
  reorderWorkspace(
    workspaceId: string,
    targetWorkspaceId: string,
    placement: ReorderPlacement,
  ): void
}

export interface Workspace {
  id: string
  name: string
  projectPath: string
  branch?: string
  worktrees?: WorktreeInfo[]
  lastActiveTabId?: string
  order: number
}

export interface Tab {
  id: string
  workspaceId: string
  name: string
  layout: MosaicLayoutNode
  lastActivePaneId?: string
  order: number
}

export type MosaicLayoutNode = MosaicNode<string>

export interface Pane {
  id: string
  terminalId: string
  tabId: string
  type: PaneType
  name: string
  cwd?: string
  status?: PaneStatus
  lastSessionId?: string
}

export type PaneType = 'terminal' | 'webview'
export type PaneStatus = 'idle' | 'working' | 'permission' | 'review'
export type ReorderPlacement = 'before' | 'after'

const PaneStatusSchema = Schema.Union([
  Schema.Literal('idle'),
  Schema.Literal('working'),
  Schema.Literal('permission'),
  Schema.Literal('review'),
])
const PaneTypeSchema = Schema.Union([Schema.Literal('terminal'), Schema.Literal('webview')])

const PersistedWorkspaceSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  projectPath: Schema.String,
  branch: Schema.optional(Schema.String),
  worktrees: Schema.optional(Schema.Array(WorktreeInfoSchema)),
  lastActiveTabId: Schema.optional(Schema.String),
  order: Schema.optional(Schema.Number),
})

const PersistedTabSchema = Schema.Struct({
  id: Schema.String,
  workspaceId: Schema.String,
  name: Schema.String,
  layout: Schema.Unknown,
  lastActivePaneId: Schema.optional(Schema.String),
  order: Schema.optional(Schema.Number),
})

const PersistedPaneSchema = Schema.Struct({
  id: Schema.String,
  terminalId: Schema.optional(Schema.String),
  tabId: Schema.String,
  type: PaneTypeSchema,
  name: Schema.String,
  cwd: Schema.optional(Schema.String),
  status: Schema.optional(PaneStatusSchema),
  lastSessionId: Schema.optional(Schema.String),
})

const PersistedTaoStateSchema = Schema.Struct({
  workspaces: Schema.optional(Schema.Array(PersistedWorkspaceSchema)),
  activeWorkspaceId: Schema.optional(Schema.NullOr(Schema.String)),
  lastActiveLocalTabId: Schema.optional(Schema.NullOr(Schema.String)),
  tabs: Schema.optional(Schema.Array(PersistedTabSchema)),
  activeTabId: Schema.optional(Schema.NullOr(Schema.String)),
  panes: Schema.optional(Schema.Array(PersistedPaneSchema)),
  activePaneId: Schema.optional(Schema.NullOr(Schema.String)),
  sidebarExpanded: Schema.optional(Schema.Boolean),
  sidebarWidth: Schema.optional(Schema.Number),
})

const MIN_SPLIT_PERCENTAGE = 5
const MAX_SPLIT_PERCENTAGE = 95

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
  const terminalId = createId('term')
  return {
    id: createId('pane'),
    terminalId,
    tabId,
    type: 'terminal',
    name: `Terminal ${index}`,
    status: 'idle',
    lastSessionId: createId('session'),
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
      lastActivePaneId: pane.id,
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

function getPreferredPaneId(tab: Tab): string | null {
  return tab.lastActivePaneId && layoutContainsPane(tab.layout, tab.lastActivePaneId)
    ? tab.lastActivePaneId
    : getFirstPaneId(tab.layout)
}

function getPreferredWorkspaceTab(
  tabs: Tab[],
  workspaces: Workspace[],
  workspaceId: string,
  lastActiveLocalTabId?: string | null,
): Tab | null {
  const workspaceTabs = getWorkspaceTabs(tabs, workspaceId)
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId)
  const preferredTabId =
    workspaceId === LOCAL_WORKSPACE_ID ? lastActiveLocalTabId : workspace?.lastActiveTabId

  return (
    (preferredTabId ? workspaceTabs.find((tab) => tab.id === preferredTabId) : undefined) ??
    workspaceTabs[0] ??
    null
  )
}

function rememberWorkspaceTab(
  workspaces: Workspace[],
  workspaceId: string,
  tabId: string,
): Workspace[] {
  if (workspaceId === LOCAL_WORKSPACE_ID) return workspaces

  let changed = false
  const nextWorkspaces = workspaces.map((workspace) => {
    if (workspace.id !== workspaceId) return workspace
    if (workspace.lastActiveTabId === tabId) return workspace
    changed = true
    return { ...workspace, lastActiveTabId: tabId }
  })

  return changed ? nextWorkspaces : workspaces
}

function rememberLocalTab(
  workspaceId: string,
  tabId: string,
): Pick<TaoState, 'lastActiveLocalTabId'> | {} {
  return workspaceId === LOCAL_WORKSPACE_ID ? { lastActiveLocalTabId: tabId } : {}
}

function rememberTabPane(tabs: Tab[], tabId: string, paneId: string | null): Tab[] {
  let changed = false
  const nextTabs = tabs.map((tab) => {
    if (tab.id !== tabId) return tab
    const lastActivePaneId = paneId && layoutContainsPane(tab.layout, paneId) ? paneId : undefined
    if (tab.lastActivePaneId === lastActivePaneId) return tab
    changed = true
    return { ...tab, lastActivePaneId }
  })

  return changed ? nextTabs : tabs
}

type PaneRect = {
  id: string
  left: number
  top: number
  right: number
  bottom: number
}

function getPaneRects(layout: MosaicLayoutNode, bounds: Omit<PaneRect, 'id'>): PaneRect[] {
  if (typeof layout === 'string') return [{ id: layout, ...bounds }]

  const split = (layout.splitPercentage ?? 50) / 100
  if (layout.direction === 'row') {
    const splitX = bounds.left + (bounds.right - bounds.left) * split
    return [
      ...getPaneRects(layout.first, { ...bounds, right: splitX }),
      ...getPaneRects(layout.second, { ...bounds, left: splitX }),
    ]
  }

  const splitY = bounds.top + (bounds.bottom - bounds.top) * split
  return [
    ...getPaneRects(layout.first, { ...bounds, bottom: splitY }),
    ...getPaneRects(layout.second, { ...bounds, top: splitY }),
  ]
}

function getRectCenter(rect: PaneRect): { x: number; y: number } {
  return {
    x: (rect.left + rect.right) / 2,
    y: (rect.top + rect.bottom) / 2,
  }
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return Math.max(startA, startB) < Math.min(endA, endB)
}

function findPaneInDirection(
  layout: MosaicLayoutNode,
  paneId: string,
  direction: PaneFocusDirection,
): string | null {
  const rects = getPaneRects(layout, { left: 0, top: 0, right: 1, bottom: 1 })
  const activeRect = rects.find((rect) => rect.id === paneId)
  if (!activeRect) return null

  const activeCenter = getRectCenter(activeRect)
  let best: { id: string; score: number } | null = null

  for (const rect of rects) {
    if (rect.id === paneId) continue

    const center = getRectCenter(rect)
    const horizontalOverlap = rangesOverlap(
      activeRect.left,
      activeRect.right,
      rect.left,
      rect.right,
    )
    const verticalOverlap = rangesOverlap(activeRect.top, activeRect.bottom, rect.top, rect.bottom)
    let primaryDistance: number
    let secondaryDistance: number

    switch (direction) {
      case 'left':
        if (center.x >= activeCenter.x || !verticalOverlap) continue
        primaryDistance = activeCenter.x - center.x
        secondaryDistance = Math.abs(activeCenter.y - center.y)
        break
      case 'right':
        if (center.x <= activeCenter.x || !verticalOverlap) continue
        primaryDistance = center.x - activeCenter.x
        secondaryDistance = Math.abs(activeCenter.y - center.y)
        break
      case 'up':
        if (center.y >= activeCenter.y || !horizontalOverlap) continue
        primaryDistance = activeCenter.y - center.y
        secondaryDistance = Math.abs(activeCenter.x - center.x)
        break
      case 'down':
        if (center.y <= activeCenter.y || !horizontalOverlap) continue
        primaryDistance = center.y - activeCenter.y
        secondaryDistance = Math.abs(activeCenter.x - center.x)
        break
    }

    const score = primaryDistance * 100 + secondaryDistance
    if (!best || score < best.score) {
      best = { id: rect.id, score }
    }
  }

  return best?.id ?? null
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

function closeTabState(state: TaoState, tabId: string): Partial<TaoState> {
  const tab = state.tabs.find((candidate) => candidate.id === tabId)
  if (!tab) return {}

  const paneIds = new Set(getPaneIdsInLayout(tab.layout))
  const nextTabs = reorderWorkspaceTabs(
    state.tabs.filter((candidate) => candidate.id !== tabId),
    tab.workspaceId,
  )
  const nextPanes = state.panes.filter((pane) => pane.tabId !== tabId && !paneIds.has(pane.id))

  if (state.activeTabId !== tabId) {
    return {
      tabs: nextTabs,
      panes: nextPanes,
      workspaces:
        tab.workspaceId !== LOCAL_WORKSPACE_ID &&
        state.workspaces.some((workspace) => workspace.lastActiveTabId === tabId)
          ? state.workspaces.map((workspace) =>
              workspace.id === tab.workspaceId && workspace.lastActiveTabId === tabId
                ? {
                    ...workspace,
                    lastActiveTabId: getWorkspaceTabs(nextTabs, tab.workspaceId)[0]?.id,
                  }
                : workspace,
            )
          : state.workspaces,
      ...(tab.workspaceId === LOCAL_WORKSPACE_ID && state.lastActiveLocalTabId === tabId
        ? { lastActiveLocalTabId: getWorkspaceTabs(nextTabs, LOCAL_WORKSPACE_ID)[0]?.id ?? null }
        : {}),
    }
  }

  const nextActiveTab = getWorkspaceTabs(nextTabs, tab.workspaceId)[0] ?? null
  const nextActivePaneId = nextActiveTab ? getPreferredPaneId(nextActiveTab) : null

  return {
    tabs: nextTabs,
    panes: nextPanes,
    workspaces: nextActiveTab
      ? rememberWorkspaceTab(state.workspaces, tab.workspaceId, nextActiveTab.id)
      : state.workspaces,
    ...(nextActiveTab ? rememberLocalTab(tab.workspaceId, nextActiveTab.id) : {}),
    activeTabId: nextActiveTab?.id ?? null,
    activePaneId: nextActivePaneId,
  }
}

function closePaneState(state: TaoState, paneId: string): Partial<TaoState> {
  const pane = state.panes.find((candidate) => candidate.id === paneId)
  const tab = pane ? state.tabs.find((candidate) => candidate.id === pane.tabId) : null
  if (!pane || !tab) return {}

  const result = removePaneFromLayout(tab.layout, pane.id)
  if (!result.removed) return {}
  if (!result.layout) return closeTabState(state, tab.id)

  const layout = result.layout
  const paneIdsInLayout = getPaneIdsInLayout(layout)
  const nextPaneIds = new Set(paneIdsInLayout)
  const activePaneId =
    state.activePaneId === pane.id ? (paneIdsInLayout[0] ?? null) : state.activePaneId
  const lastActivePaneId =
    tab.lastActivePaneId === pane.id ? (activePaneId ?? undefined) : tab.lastActivePaneId

  return {
    tabs: state.tabs.map((candidate) =>
      candidate.id === tab.id ? { ...candidate, layout, lastActivePaneId } : candidate,
    ),
    panes: state.panes.filter(
      (candidate) => candidate.tabId !== tab.id || nextPaneIds.has(candidate.id),
    ),
    activePaneId,
  }
}

function ensureWorkspaceTabState(state: TaoState, workspaceId: string): Partial<TaoState> {
  const workspaceTabs = getWorkspaceTabs(state.tabs, workspaceId)
  const existingTab =
    workspaceTabs.find((tab) => tab.id === state.activeTabId) ??
    getPreferredWorkspaceTab(state.tabs, state.workspaces, workspaceId, state.lastActiveLocalTabId)
  if (existingTab) {
    const activePaneId = getPreferredPaneId(existingTab)

    return {
      workspaces: rememberWorkspaceTab(state.workspaces, workspaceId, existingTab.id),
      ...rememberLocalTab(workspaceId, existingTab.id),
      activeTabId: existingTab.id,
      activePaneId,
    }
  }

  const { tab, pane } = createTerminalTab(workspaceId, 0)
  return {
    tabs: [...state.tabs, tab],
    panes: [...state.panes, pane],
    ...rememberLocalTab(workspaceId, tab.id),
    activeTabId: tab.id,
    activePaneId: pane.id,
  }
}

const initialLocalTab = createTerminalTab(LOCAL_WORKSPACE_ID, 0)

type PersistedTaoState = Schema.Schema.Type<typeof PersistedTaoStateSchema>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNonEmptyString(value: string): boolean {
  return value.trim().length > 0
}

function finiteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function clampSplitPercentage(value: number | undefined): number {
  return Math.min(
    MAX_SPLIT_PERCENTAGE,
    Math.max(MIN_SPLIT_PERCENTAGE, finiteNumber(value ?? 50, 50)),
  )
}

function moveRelativeTo<T extends { id: string; order: number }>(
  items: T[],
  itemId: string,
  targetItemId: string,
  placement: ReorderPlacement,
): T[] {
  if (itemId === targetItemId) return items

  const movingItem = items.find((item) => item.id === itemId)
  if (!movingItem || !items.some((item) => item.id === targetItemId)) return items

  const orderedItems = items.filter((item) => item.id !== itemId)
  const targetIndex = orderedItems.findIndex((item) => item.id === targetItemId)
  orderedItems.splice(placement === 'after' ? targetIndex + 1 : targetIndex, 0, movingItem)

  return orderedItems.map((item, order) => ({ ...item, order }))
}

function reorderAllWorkspaceTabs(tabs: Tab[]): Tab[] {
  const counters = new Map<string, number>()

  return [...tabs]
    .sort((a, b) => a.order - b.order)
    .map((tab) => {
      const order = counters.get(tab.workspaceId) ?? 0
      counters.set(tab.workspaceId, order + 1)
      return { ...tab, order }
    })
}

function decodePersistedLayout(
  layout: unknown,
  paneIdsForTab: ReadonlySet<string>,
): MosaicLayoutNode | null {
  if (typeof layout === 'string') return paneIdsForTab.has(layout) ? layout : null
  if (!isRecord(layout)) return null

  const direction = layout.direction
  if (direction !== 'row' && direction !== 'column') return null

  const first = decodePersistedLayout(layout.first, paneIdsForTab)
  const second = decodePersistedLayout(layout.second, paneIdsForTab)
  if (!first || !second) return first ?? second

  return {
    direction,
    first,
    second,
    splitPercentage: clampSplitPercentage(
      typeof layout.splitPercentage === 'number' ? layout.splitPercentage : undefined,
    ),
  }
}

function normalizePersistedState(persistedState: unknown): Partial<TaoState> {
  const decoded = Schema.decodeUnknownOption(PersistedTaoStateSchema)(persistedState)
  if (decoded._tag === 'None') return {}

  const persisted = decoded.value as PersistedTaoState
  const workspaces = (persisted.workspaces ?? [])
    .filter(
      (workspace) => isNonEmptyString(workspace.id) && isNonEmptyString(workspace.projectPath),
    )
    .sort((a, b) => finiteNumber(a.order ?? 0, 0) - finiteNumber(b.order ?? 0, 0))
    .map<Workspace>((workspace, order) => ({
      ...workspace,
      name: sanitizeTerminalTitle(workspace.name) ?? workspaceNameFallback(workspace.projectPath),
      worktrees: workspace.worktrees ? [...workspace.worktrees] : undefined,
      lastActiveTabId: isNonEmptyString(workspace.lastActiveTabId ?? '')
        ? workspace.lastActiveTabId
        : undefined,
      order,
    }))

  const panes = (persisted.panes ?? [])
    .filter((pane) => isNonEmptyString(pane.id) && isNonEmptyString(pane.tabId))
    .map<Pane>((pane) => ({
      ...pane,
      terminalId: isNonEmptyString(pane.terminalId ?? '') ? pane.terminalId! : createId('term'),
      name: sanitizeTerminalTitle(pane.name) ?? 'Terminal',
      status: pane.status ?? 'idle',
      lastSessionId: isNonEmptyString(pane.lastSessionId ?? '')
        ? pane.lastSessionId
        : createId('session'),
    }))
  const paneIdsByTab = new Map<string, Set<string>>()
  for (const pane of panes) {
    const paneIds = paneIdsByTab.get(pane.tabId) ?? new Set<string>()
    paneIds.add(pane.id)
    paneIdsByTab.set(pane.tabId, paneIds)
  }

  const usedPaneIds = new Set<string>()
  const tabs = reorderAllWorkspaceTabs(
    (persisted.tabs ?? []).flatMap<Tab>((tab) => {
      if (!isNonEmptyString(tab.id) || !isNonEmptyString(tab.workspaceId)) return []

      const layout = decodePersistedLayout(tab.layout, paneIdsByTab.get(tab.id) ?? new Set())
      if (!layout) return []
      for (const paneId of getPaneIdsInLayout(layout)) {
        usedPaneIds.add(paneId)
      }

      return [
        {
          ...tab,
          name: sanitizeTerminalTitle(tab.name) ?? 'Terminal',
          layout,
          lastActivePaneId:
            isNonEmptyString(tab.lastActivePaneId ?? '') &&
            layoutContainsPane(layout, tab.lastActivePaneId!)
              ? tab.lastActivePaneId
              : (getFirstPaneId(layout) ?? undefined),
          order: finiteNumber(tab.order ?? 0, 0),
        },
      ]
    }),
  )

  const tabIds = new Set(tabs.map((tab) => tab.id))
  const repairedWorkspaces = workspaces.map((workspace) =>
    workspace.lastActiveTabId && tabIds.has(workspace.lastActiveTabId)
      ? workspace
      : { ...workspace, lastActiveTabId: undefined },
  )
  const lastActiveLocalTabId =
    persisted.lastActiveLocalTabId &&
    tabs.some(
      (tab) => tab.workspaceId === LOCAL_WORKSPACE_ID && tab.id === persisted.lastActiveLocalTabId,
    )
      ? persisted.lastActiveLocalTabId
      : null

  return {
    workspaces: repairedWorkspaces,
    activeWorkspaceId:
      persisted.activeWorkspaceId &&
      workspaces.some((workspace) => workspace.id === persisted.activeWorkspaceId)
        ? persisted.activeWorkspaceId
        : null,
    lastActiveLocalTabId,
    tabs,
    activeTabId: persisted.activeTabId ?? null,
    panes: panes.filter((pane) => usedPaneIds.has(pane.id)),
    activePaneId: persisted.activePaneId ?? null,
    sidebarExpanded: persisted.sidebarExpanded ?? true,
    sidebarWidth: finiteNumber(persisted.sidebarWidth ?? 240, 240),
  }
}

function workspaceNameFallback(projectPath: string): string {
  return projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath
}

function repairPersistedState(state: TaoState): TaoState {
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

export const useTaoStore = create<TaoState>()((set) => ({
  workspaces: [],
  activeWorkspaceId: null,
  lastActiveLocalTabId: initialLocalTab.tab.id,
  tabs: [initialLocalTab.tab],
  activeTabId: initialLocalTab.tab.id,
  panes: [initialLocalTab.pane],
  activePaneId: initialLocalTab.pane.id,
  sidebarExpanded: true,
  sidebarWidth: 240,
  hydrateLayout: (data) =>
    set((state) => {
      const persisted = normalizePersistedState(data)
      return repairPersistedState({ ...state, ...persisted })
    }),
  addWorkspace: (workspace) =>
    set((state) => {
      const existingWorkspace = state.workspaces.find(({ id }) => id === workspace.id)
      if (existingWorkspace) {
        const preferredTab = getPreferredWorkspaceTab(
          state.tabs,
          state.workspaces,
          existingWorkspace.id,
          state.lastActiveLocalTabId,
        )
        return {
          activeWorkspaceId: existingWorkspace.id,
          ...(preferredTab
            ? {
                activeTabId: preferredTab.id,
                activePaneId: getPreferredPaneId(preferredTab),
                workspaces: rememberWorkspaceTab(
                  state.workspaces,
                  existingWorkspace.id,
                  preferredTab.id,
                ),
              }
            : ensureWorkspaceTabState(state, existingWorkspace.id)),
        }
      }

      const { tab, pane } = createTerminalTab(workspace.id, 0)
      const orderedWorkspace: Workspace = {
        ...workspace,
        lastActiveTabId: tab.id,
        order: state.workspaces.length,
      }

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
        ? getPreferredWorkspaceTab(tabs, workspaces, activeWorkspaceId, state.lastActiveLocalTabId)
        : getPreferredWorkspaceTab(tabs, workspaces, LOCAL_WORKSPACE_ID, state.lastActiveLocalTabId)

      return {
        workspaces,
        activeWorkspaceId,
        tabs,
        panes,
        activeTabId: nextTab?.id ?? null,
        activePaneId: nextTab ? getPreferredPaneId(nextTab) : null,
        ...(activeWorkspaceId ? ensureWorkspaceTabState(nextState, activeWorkspaceId) : {}),
      }
    }),
  selectWorkspace: (workspaceId) =>
    set((state) => ({
      activeWorkspaceId: workspaceId,
      ...ensureWorkspaceTabState(state, workspaceId),
    })),
  selectWorkspaceByIndex: (index) =>
    set((state) => {
      const workspace = [...state.workspaces].sort((a, b) => a.order - b.order)[index]
      if (!workspace) return {}

      return {
        activeWorkspaceId: workspace.id,
        ...ensureWorkspaceTabState(state, workspace.id),
      }
    }),
  ensureWorkspaceTab: (workspaceId) =>
    set((state) =>
      ensureWorkspaceTabState(state, workspaceId ?? state.activeWorkspaceId ?? LOCAL_WORKSPACE_ID),
    ),
  newTab: (workspaceId) =>
    set((state) => {
      const targetWorkspaceId = workspaceId ?? state.activeWorkspaceId ?? LOCAL_WORKSPACE_ID
      const order = getWorkspaceTabs(state.tabs, targetWorkspaceId).length
      const { tab, pane } = createTerminalTab(targetWorkspaceId, order)

      return {
        workspaces: rememberWorkspaceTab(state.workspaces, targetWorkspaceId, tab.id),
        ...rememberLocalTab(targetWorkspaceId, tab.id),
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
        workspaces: rememberWorkspaceTab(state.workspaces, tab.workspaceId, tab.id),
        ...rememberLocalTab(tab.workspaceId, tab.id),
        activeWorkspaceId:
          tab.workspaceId === LOCAL_WORKSPACE_ID ? state.activeWorkspaceId : tab.workspaceId,
        activeTabId: tab.id,
        activePaneId: getPreferredPaneId(tab),
      }
    }),
  selectTabByIndex: (index) =>
    set((state) => {
      const workspaceId = state.activeWorkspaceId ?? LOCAL_WORKSPACE_ID
      const tab = getWorkspaceTabs(state.tabs, workspaceId)[index]
      if (!tab) return {}

      return {
        workspaces: rememberWorkspaceTab(state.workspaces, tab.workspaceId, tab.id),
        ...rememberLocalTab(tab.workspaceId, tab.id),
        activeTabId: tab.id,
        activePaneId: getPreferredPaneId(tab),
      }
    }),
  reorderTab: (tabId, targetTabId, placement) =>
    set((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === tabId)
      const targetTab = state.tabs.find((candidate) => candidate.id === targetTabId)
      if (!tab || !targetTab || tab.workspaceId !== targetTab.workspaceId) return {}

      const workspaceTabs = getWorkspaceTabs(state.tabs, tab.workspaceId)
      const reorderedTabs = moveRelativeTo(workspaceTabs, tabId, targetTabId, placement)
      if (reorderedTabs === workspaceTabs) return {}

      const reorderedById = new Map(reorderedTabs.map((candidate) => [candidate.id, candidate]))

      return {
        tabs: state.tabs.map((candidate) => reorderedById.get(candidate.id) ?? candidate),
      }
    }),
  setTabLayout: (tabId, layout) =>
    set((state) => {
      if (!layout) return closeTabState(state, tabId)

      const tab = state.tabs.find((candidate) => candidate.id === tabId)
      if (!tab) return {}

      const paneIds = new Set(getPaneIdsInLayout(layout))
      const firstPaneId = paneIds.values().next().value ?? null
      const activePaneId =
        state.activeTabId === tabId && (!state.activePaneId || !paneIds.has(state.activePaneId))
          ? firstPaneId
          : state.activePaneId
      const lastActivePaneId =
        tab.lastActivePaneId && paneIds.has(tab.lastActivePaneId)
          ? tab.lastActivePaneId
          : (firstPaneId ?? undefined)

      return {
        tabs: state.tabs.map((candidate) =>
          candidate.id === tabId ? { ...candidate, layout, lastActivePaneId } : candidate,
        ),
        panes: state.panes.filter((pane) => pane.tabId !== tabId || paneIds.has(pane.id)),
        activePaneId,
      }
    }),
  selectPane: (paneId) =>
    set((state) => {
      const pane = state.panes.find((candidate) => candidate.id === paneId)
      if (!pane) return {}
      const tab = state.tabs.find((candidate) => candidate.id === pane.tabId)

      return {
        tabs: rememberTabPane(state.tabs, pane.tabId, pane.id),
        workspaces: tab
          ? rememberWorkspaceTab(state.workspaces, tab.workspaceId, tab.id)
          : state.workspaces,
        ...(tab ? rememberLocalTab(tab.workspaceId, tab.id) : {}),
        activePaneId: pane.id,
        activeTabId: pane.tabId,
      }
    }),
  selectPaneByDirection: (direction) =>
    set((state) => {
      const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId)
      const paneId = state.activePaneId ?? (activeTab ? getFirstPaneId(activeTab.layout) : null)
      if (!activeTab || !paneId) return {}

      const nextPaneId = findPaneInDirection(activeTab.layout, paneId, direction)
      if (!nextPaneId) return {}

      return {
        tabs: rememberTabPane(state.tabs, activeTab.id, nextPaneId),
        activePaneId: nextPaneId,
      }
    }),
  restartPaneSession: (paneId) =>
    set((state) => {
      const pane = state.panes.find((candidate) => candidate.id === paneId)
      if (!pane || pane.type !== 'terminal') return {}

      return {
        panes: state.panes.map((candidate) =>
          candidate.id === pane.id
            ? { ...candidate, lastSessionId: createId('session'), status: 'idle' }
            : candidate,
        ),
      }
    }),
  setPaneTitle: (paneId, title) =>
    set((state) => {
      const pane = state.panes.find((candidate) => candidate.id === paneId)
      if (!pane) return {}

      const name = sanitizeTerminalTitle(title)
      if (!name) return {}

      const tab = state.tabs.find((candidate) => candidate.id === pane.tabId)
      const nextPanes =
        pane.name === name
          ? state.panes
          : state.panes.map((candidate) =>
              candidate.id === pane.id ? { ...candidate, name } : candidate,
            )
      const nextTabs =
        tab && paneId === state.activePaneId && tab.name !== name
          ? state.tabs.map((candidate) =>
              candidate.id === tab.id ? { ...candidate, name } : candidate,
            )
          : state.tabs

      if (nextPanes === state.panes && nextTabs === state.tabs) return {}
      return { panes: nextPanes, tabs: nextTabs }
    }),
  setPaneStatus: (paneId, status) =>
    set((state) => {
      const pane = state.panes.find((candidate) => candidate.id === paneId)
      if (!pane || pane.status === status) return {}

      return {
        panes: state.panes.map((candidate) =>
          candidate.id === pane.id ? { ...candidate, status } : candidate,
        ),
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
          candidate.id === tab.id ? { ...candidate, layout, lastActivePaneId: pane.id } : candidate,
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
          candidate.id === tab.id ? { ...candidate, layout, lastActivePaneId: pane.id } : candidate,
        ),
        panes: [...state.panes, newPane],
        activeTabId: tab.id,
        activePaneId: pane.id,
      }
    }),
  closePane: (paneId) => set((state) => closePaneState(state, paneId)),
  closeActivePane: () =>
    set((state) => (state.activePaneId ? closePaneState(state, state.activePaneId) : {})),
  toggleSidebar: () => set((state) => ({ sidebarExpanded: !state.sidebarExpanded })),
  setSidebarExpanded: (expanded) => set({ sidebarExpanded: expanded }),
  setSidebarWidth: (width) => set({ sidebarWidth: width }),
  reorderWorkspace: (workspaceId, targetWorkspaceId, placement) =>
    set((state) => {
      const workspaces = moveRelativeTo(state.workspaces, workspaceId, targetWorkspaceId, placement)
      return workspaces === state.workspaces ? {} : { workspaces }
    }),
}))

export function selectPaneLayoutData(state: TaoState): PaneLayoutData {
  return {
    version: 2,
    workspaces: state.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      projectPath: workspace.projectPath,
      branch: workspace.branch,
      worktrees: workspace.worktrees,
      lastActiveTabId: workspace.lastActiveTabId,
      order: workspace.order,
    })),
    activeWorkspaceId: state.activeWorkspaceId,
    lastActiveLocalTabId: state.lastActiveLocalTabId,
    tabs: state.tabs.map((tab) => ({
      id: tab.id,
      workspaceId: tab.workspaceId,
      name: tab.name,
      layout: tab.layout,
      lastActivePaneId: tab.lastActivePaneId,
      order: tab.order,
    })),
    panes: state.panes.map((pane) => ({
      id: pane.id,
      terminalId: pane.terminalId,
      tabId: pane.tabId,
      type: pane.type,
      name: pane.name,
      cwd: pane.cwd,
      status: pane.status,
      lastSessionId: pane.lastSessionId,
    })),
    activeTabId: state.activeTabId,
    activePaneId: state.activePaneId,
    sidebarExpanded: state.sidebarExpanded,
    sidebarWidth: state.sidebarWidth,
  }
}
