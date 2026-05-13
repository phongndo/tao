# Tau — UI & Architecture Plan

## Overview

Transform Tau from a single-terminal Electron app into a workspace-oriented
terminal with tabs, split panes, and project-aware sidebar — matching the UX of
Superset / cmux while retaining Tau's performance DNA (ghostty-web WASM canvas,
zero-copy rendering, dedicated PTY utility process).

---

## 1. Tech Stack (Final)

| Layer | Choice | Rationale |
|-------|--------|-----------|
| **Shell** | Electron 42 + electron-vite | Already in use; same as Superset |
| **Rendering** | React 19 + React DOM | Ecosystem: react-mosaic-component, TanStack Query, lucide-react |
| **UI State** | Zustand 5 | Tiny, fast, synchronous — handles active tab, pane layout, workspace order |
| **Async State** | TanStack Query | Cached auto-refetch for git branch, worktrees, PR info — data that changes outside the app |
| **Pane Layout** | react-mosaic-component | Battle-tested recursive split tiling (same lib Superset uses) |
| **Sidebar / Main Split** | react-resizable-panels | Resizable left sidebar + main content area |
| **Icons** | lucide-react | Consistent icon set, tree-shakeable |
| **Key Bindings** | react-hotkeys-hook | Declarative shortcut handling |
| **Terminal Renderer** | ghostty-web (unchanged) | WASM canvas — zero framework involvement, stays in its own rAF loop |
| **PTY Backend** | PtyPool (evolved PtyManager) | One PTY instance per terminal pane, multiplexed on MessagePort |

### Why not TanStack Router / Table / Virtual / Form?
- **Router**: Tau is a single-screen app. Navigation is state-driven (`activeWorkspaceId`, `activeTabId`), not URL-driven.
- **Table / Virtual / Form**: Not needed for initial UI. Can add later if required.

### Zustand vs TanStack Query boundary
```
Zustand:     "which tab is active right now"    (ephemeral UI state)
Query:       "what branch is this workspace on"  (async, external data)
```

---

## 2. Architecture

```
┌───────────┬───────────────────────────────────────────┐
│           │  Tab Bar                                   │
│           ├───────────────────────────────────────────┤
│  Sidebar  │  Pane Grid (react-mosaic-component)        │
│           │  ┌─────────────┬─────────────┐             │
│ Workspace │  │  Terminal 1  │  Terminal 2  │            │
│   List    │  │  (ghostty)   │  (ghostty)   │            │
│           │  ├─────────────┴─────────────┤             │
│  ├─ tau   │  │       Terminal 3          │             │
│  │  main   │  │       (ghostty)          │             │
│  │  feat/x │  └──────────────────────────┘             │
│  ├─ other │                                            │
│           │                                            │
└───────────┴────────────────────────────────────────────┘
```

### Single-window design
All competitors (Superset, cmux, VS Code, iTerm2) use single-window as the
primary model. Simplifies state management + PTY routing. Multi-window can be
added later via Electron.

### Right sidebar
Reserved layout space (CSS grid column) but not implemented yet.

---

## 3. Data Model

### Zustand Store (UI State)

```typescript
interface TauState {
  // Workspaces
  workspaces: Workspace[]
  activeWorkspaceId: string | null

  // Tabs & Panes
  tabs: Tab[]
  activeTabId: string | null

  // UI
  sidebarExpanded: boolean
  sidebarWidth: number
}

interface Workspace {
  id: string
  name: string
  projectPath: string       // absolute path
  branch?: string            // git branch (pulled via Query)
  worktrees?: WorktreeInfo[] // git worktrees (pulled via Query)
  order: number              // sidebar sort order
}

interface WorktreeInfo {
  path: string
  branch: string
  hash: string
  isBare: boolean
}

interface Tab {
  id: string
  workspaceId: string
  name: string               // display name (auto-title or user-set)
  layout: MosaicNode<string> // react-mosaic layout tree (leaf IDs are paneIds)
  order: number              // tab bar sort order
}

interface Pane {
  id: string
  tabId: string
  type: PaneType              // 'terminal' | 'webview' (terminal only for now)
  name: string
  cwd?: string                // current working directory
  status?: PaneStatus         // agent lifecycle: 'idle' | 'working' | 'permission' | 'review'
}

type PaneType = 'terminal' | 'webview'
type PaneStatus = 'idle' | 'working' | 'permission' | 'review'
```

### TanStack Query (Async / External State)

```typescript
// Sidebar data — fetched from shell commands
useGitBranch(workspacePath: string): Promise<string | null>
useGitWorktrees(workspacePath: string): Promise<WorktreeInfo[]>
useGitStatus(workspacePath: string): Promise<{ changed: number, staged: number }>
useWorkspacePorts(workspacePath: string): Promise<PortInfo[]>
```

---

## 4. PTY Architecture

Evolve the current singleton `PtyManager` into a `PtyPool` inside the PTY
utility process:

```
┌─────────────────────────────────┐
│  PTY Utility Process            │
│  PtyPool                        │
│  ┌──────┐ ┌──────┐ ┌──────┐   │
│  │ PTY 1│ │ PTY 2│ │ PTY 3│   │
│  │ bash  │ │ zsh  │ │ cc   │   │
│  └──────┘ └──────┘ └──────┘   │
│       ▲        ▲        ▲       │
│       │  session-id multiplex   │
│       │  on shared MessagePort  │
└───────┼────────┼────────┼───────┘
        │        │        │
   MessagePort (renderer ↔ PTY service)
```

**Protocol changes**: Add `sessionId` to all messages so the renderer can route
output to the correct terminal pane.

```typescript
type PtyClientMessage =
  | { type: 'spawn'; sessionId: string; cols: number; rows: number }
  | { type: 'write'; sessionId: string; data: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number }
  | { type: 'kill'; sessionId: string }
  | { type: 'renderer-ready' }

type PtyServiceMessage =
  | { type: 'ready'; sessionId: string; size: PtySize }
  | { type: 'data'; sessionId: string; data: string }
  | { type: 'error'; sessionId: string; error: string }
  | { type: 'exit'; sessionId: string; info: PtyExitInfo }
```

---

## 5. Key Bindings (macOS)

```
Cmd+D         Split pane vertically
Cmd+Shift+D   Split pane horizontally
Ctrl+1..0     Switch tab within current workspace (10 tabs)
Cmd+1..0      Switch workspace (10 workspaces)
Ctrl+H/J/K/L  Navigate between panes (Vim-style)
Cmd+L         Focus active terminal pane
Cmd+T         New terminal tab in current workspace
Cmd+W         Close active pane/tab
Cmd+Shift+N   New workspace
```

### Multi-pane navigation
`Ctrl+HJKL` navigates the pane boundary grid:
- `Ctrl+H` → left pane
- `Ctrl+J` → pane below
- `Ctrl+K` → pane above
- `Ctrl+L` → right pane (if Cmd+L is also bound, resolve: Cmd+L = focus terminal, Ctrl+L = right pane in pane-grid mode)

---

## 6. Component Tree

```
<App>
  <PanelGroup direction="horizontal">       // react-resizable-panels
    <Panel>                                  // Left sidebar
      <Sidebar>
        <WorkspaceList>
          <WorkspaceItem>                   // Expandable: branch + worktrees
            <BranchInfo />
            <WorktreeList>
              <WorktreeItem />              // Click to open as workspace
            </WorktreeList>
          </WorkspaceItem>
        </WorkspaceList>
      </Sidebar>
    </Panel>
    <PanelResizeHandle />
    <Panel>                                  // Main content
      <MainContent>
        <TabBar>
          <TabItem />
        </TabBar>
        <TabContent>
          <Mosaic>                           // react-mosaic-component
            <MosaicWindow>                  // = One pane
              <TerminalPane />              // ghostty-web canvas wrapper
            </MosaicWindow>
          </Mosaic>
        </TabContent>
      </MainContent>
    </Panel>
    {/* Right sidebar column reserved for future */}
  </PanelGroup>
</App>
```

### MosaicNode Layout (Pane Splits)
react-mosaic-component uses a recursive tree structure:

```typescript
type MosaicNode<T> = T | MosaicParent<T>

interface MosaicParent<T> {
  direction: 'row' | 'column'   // row = horizontal split, column = vertical split
  first: MosaicNode<T>
  second: MosaicNode<T>
  splitPercentage: number
}
```

Example — two panes split vertically (Cmd+D in default configuration):
```
'row' 50%
├── first:  'pane-1'
└── second: 'pane-2'
```

---

## 7. Terminal Pane Lifecycle

Each terminal pane owns exactly one ghostty-web `Terminal` instance and one PTY
session.

```
TerminalPane
├── Creates ghostty-web Terminal
├── Sends { type: 'spawn', sessionId } to PTY service
├── Wires onData → write to PTY
├── Wires PTY data → term.write()
├── On dispose: kill PTY session + dispose ghostty Terminal
└── Canvas lives in a React ref (not managed by React reconciliation)
```

The `<canvas>` element is created by ghostty-web's `term.open(container)`. We
must wrap this carefully:
- Use `useRef<HTMLDivElement>` for the container
- Call `term.open(ref.current!)` in a `useEffect` that runs once
- Call `term.dispose()` on cleanup
- NEVER let React re-render the canvas container

---

## 8. Implementation Phases

### Phase 1: Foundation (React + Zustand + Layout)
- [ ] Add React 19, React DOM, Zustand to project
- [ ] Create empty Zustand store with workspace/tab/pane types
- [ ] Wire `react-resizable-panels` for sidebar + main layout
- [ ] Render placeholder sidebar and main area
- [ ] Ensure ghostty-web terminal still works inside a React component

### Phase 2: Sidebar + Workspaces
- [ ] Workspace list UI in sidebar
- [ ] Add workspace (project directory)
- [ ] Remove workspace
- [ ] Git branch display (shell: `git branch --show-current`)
- [ ] Worktree list (shell: `git worktree list`)

### Phase 3: Tabs + Pane Layout
- [ ] Tab bar with tab switching
- [ ] New tab (Cmd+T)
- [ ] Close tab (Cmd+W)
- [ ] Integrate react-mosaic-component for pane grid
- [ ] Split pane vertically (Cmd+D)
- [ ] Split pane horizontally (Cmd+Shift+D)
- [ ] Close pane

### Phase 4: PTY Pool
- [ ] Evolve PTY service to PtyPool (session-based multiplexing)
- [ ] Spawn/kill PTY per terminal pane
- [ ] Route data by sessionId
- [ ] Handle PTY exit per session

### Phase 5: Key Bindings + Navigation
- [ ] Cmd+1..0 workspace switching
- [ ] Ctrl+1..0 tab switching
- [ ] Ctrl+HJKL pane navigation
- [ ] Cmd+L focus terminal pane
- [ ] All keyboard shortcuts via react-hotkeys-hook

### Phase 6: Polish
- [ ] Tab auto-title (scan terminal output for OSC title sequences)
- [ ] Pane status indicators (agent lifecycle rings)
- [ ] Workspace persistence (localStorage)
- [ ] Drag-and-drop tab reorder
- [ ] Drag-and-drop workspace reorder

---

## 9. Key Dependencies to Add

```jsonc
{
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zustand": "^5.0.0",
    "@tanstack/react-query": "^5.0.0",
    "react-mosaic-component": "^6.0.0",
    "react-resizable-panels": "^3.0.0",
    "react-hotkeys-hook": "^5.0.0",
    "lucide-react": "^0.560.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^5.0.0"
  }
}
```

The existing `electron-vite` config needs a `@vitejs/plugin-react` plugin added
to the renderer build config.

---

## 10. Open Questions

1. **Workspace persistence**: localStorage vs IndexedDB vs SQLite (better-sqlite3)?
   Start with localStorage for MVP.

2. **Tab auto-title**: Parse OSC escape sequences from PTY output to extract
   terminal title (e.g., nvim sets window title). Same approach Superset uses.

3. **Agent integration**: Deferred — but the `PaneStatus` field ('working',
   'permission', 'review') is designed for it. This mirrors Superset's agent
   lifecycle rings.

4. **Multiple BrowserWindows**: Deferred. If we ever split workspaces across
   native windows, the PTY pool is already window-agnostic (it lives in a
   utility process).

5. **Theming**: Tau already has a Ghostty theme. CSS custom properties based on
   the same palette for UI chrome (sidebar, tabs, panes).
