import assert from 'node:assert/strict'
import test from 'node:test'
import { useTaoStore, type Workspace } from '../src/renderer/state/store'

function resetStore(): void {
  useTaoStore.setState({
    workspaces: [],
    activeWorkspaceId: null,
    lastActiveLocalTabId: null,
    tabs: [],
    activeTabId: null,
    panes: [],
    activePaneId: null,
    sidebarExpanded: true,
    sidebarWidth: 240,
  })
}

function workspace(id: string): Workspace {
  return {
    id,
    name: id,
    projectPath: `/tmp/${id}`,
    order: 0,
  }
}

test('adding a workspace selects it without creating a terminal', () => {
  resetStore()

  useTaoStore.getState().addWorkspace(workspace('workspace-a'))

  const state = useTaoStore.getState()
  assert.equal(state.activeWorkspaceId, 'workspace-a')
  assert.equal(state.activeTabId, null)
  assert.equal(state.activePaneId, null)
  assert.equal(state.tabs.length, 0)
  assert.equal(state.panes.length, 0)
})

test('newTab explicitly creates the first terminal for the active workspace', () => {
  resetStore()

  useTaoStore.getState().addWorkspace(workspace('workspace-a'))
  useTaoStore.getState().newTab()

  const state = useTaoStore.getState()
  assert.equal(state.tabs.length, 1)
  assert.equal(state.panes.length, 1)
  assert.equal(state.tabs[0]?.workspaceId, 'workspace-a')
  assert.equal(state.activeTabId, state.tabs[0]?.id)
  assert.equal(state.activePaneId, state.panes[0]?.id)
})

test('selecting a workspace with no tabs does not create a terminal', () => {
  resetStore()

  useTaoStore.getState().addWorkspace(workspace('workspace-a'))
  useTaoStore.getState().newTab()
  useTaoStore.getState().addWorkspace(workspace('workspace-b'))

  let state = useTaoStore.getState()
  assert.equal(state.activeWorkspaceId, 'workspace-b')
  assert.equal(state.activeTabId, null)
  assert.equal(state.activePaneId, null)
  assert.equal(state.tabs.length, 1)
  assert.equal(state.panes.length, 1)

  useTaoStore.getState().selectWorkspace('workspace-a')
  state = useTaoStore.getState()
  assert.equal(state.activeTabId, state.tabs[0]?.id)
  assert.equal(state.activePaneId, state.panes[0]?.id)

  useTaoStore.getState().selectWorkspace('workspace-b')
  state = useTaoStore.getState()
  assert.equal(state.activeTabId, null)
  assert.equal(state.activePaneId, null)
  assert.equal(state.tabs.length, 1)
  assert.equal(state.panes.length, 1)
})
