# Tau — UI & Architecture Plan

## Overview

Transform Tau from a single-terminal Electron app into a workspace-oriented
terminal with tabs, split panes, and project-aware sidebar — matching the UX of
Superset / cmux while retaining Tau's performance DNA (ghostty-web WASM canvas,
zero-copy rendering, dedicated PTY utility process).

---

## 1. Tech Stack (Current + Target)

| Layer                    | Choice                        | Rationale                                                                                                                                 |
| ------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Shell**                | Electron 42 + electron-vite   | Already in use; same as Superset                                                                                                          |
| **Rendering**            | React 19 + React DOM          | Ecosystem: react-mosaic-component, lucide-react; metadata reads use Tau's Effect cache                                                    |
| **UI State**             | Zustand 5                     | Tiny, fast, synchronous — handles active tab, pane layout, workspace order                                                                |
| **Effect Runtime**       | Effect.ts (`effect`)          | Primary backend/runtime model for shell commands, IPC, persistence, cancellation, retries, streaming, typed errors, and testable services |
| **Async Cache**          | Effect-owned metadata cache   | Renderer cache/subscription layer over Effect-backed reads; TanStack Query was removed in Phase 7                                         |
| **Pane Layout**          | react-mosaic-component        | Battle-tested recursive split tiling (same lib Superset uses)                                                                             |
| **Sidebar / Main Split** | react-resizable-panels        | Resizable left sidebar + main content area                                                                                                |
| **Icons**                | lucide-react                  | Consistent icon set, tree-shakeable                                                                                                       |
| **Key Bindings**         | Electron `before-input-event` | Centralized app shortcuts before terminal input                                                                                           |
| **Terminal Renderer**    | ghostty-web (unchanged)       | WASM canvas — zero framework involvement, stays in its own rAF loop                                                                       |
| **PTY Backend**          | PtyPool (evolved PtyManager)  | One PTY instance per terminal pane, multiplexed on MessagePort                                                                            |

### Why not TanStack Router / Table / Virtual / Form?

- **Router**: Tau is a single-screen app. Navigation is state-driven (`activeWorkspaceId`, `activeTabId`), not URL-driven.
- **Table / Virtual / Form**: Not needed for initial UI. Can add later if required.

### Zustand vs Effect boundary

```text
Zustand:        "which tab is active right now"     (ephemeral UI state)
Effect:         "run git safely and return typed errors" (fallible side effects)
Effect Cache:   "workspace metadata cache/subscriptions"
```

Effect is the only place for fallible external work. React components and
Zustand actions should not call shell commands, Electron IPC, storage, or PTY
operations directly. They call narrow Effect-backed services through configured
main/preload/renderer runtimes.

Direction: Tau should become Effect-first, especially in the Electron
main/preload/utility-process backend. New backend-facing code should be modeled
as Effect services. The Effect runtime now owns workspace metadata request
caching, invalidation, and subscriptions.

---

## 2. Architecture

```
┌───────────┬───────────────────────────────────────────┐
│           │  Tab Bar                                  │
│           ├───────────────────────────────────────────┤
│  Sidebar  │  Pane Grid (react-mosaic-component)       │
│           │  ┌─────────────┬─────────────┐            │
│ Workspace │  │  Terminal 1  │  Terminal 2│            │
│   List    │  │  (ghostty)   │  (ghostty) │            │
│           │  ├─────────────┴─────────────┤            │
│  ├─ tau   │  │       Terminal 3          │            │
│  │  main  │  │       (ghostty)           │            │
│  │  feat/x│  └───────────────────────────┘            │
│  ├─ other │                                           │
│           │                                           │
└───────────┴───────────────────────────────────────────┘
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
  projectPath: string // absolute path
  branch?: string // git branch (pulled via Query)
  worktrees?: WorktreeInfo[] // git worktrees (pulled via Query)
  order: number // sidebar sort order
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
  name: string // display name (auto-title or user-set)
  layout: MosaicNode<string> // react-mosaic layout tree (leaf IDs are paneIds)
  order: number // tab bar sort order
}

interface Pane {
  id: string
  tabId: string
  type: PaneType // 'terminal' | 'webview' (terminal only for now)
  name: string
  cwd?: string // current working directory
  status?: PaneStatus // agent lifecycle: 'idle' | 'working' | 'permission' | 'review'
}

type PaneType = 'terminal' | 'webview'
type PaneStatus = 'idle' | 'working' | 'permission' | 'review'
```

### Effect Metadata Cache (TanStack Exit)

```typescript
import type { EffectQueryResult } from '../renderer/workspaceQueries'

// Sidebar data — fetched through Effect-backed services
useGitBranch(workspacePath: string): EffectQueryResult<string | null>
useGitWorktrees(workspacePath: string): EffectQueryResult<readonly WorktreeInfo[]>
useGitStatus(workspacePath: string): EffectQueryResult<{ changed: number, staged: number }>
useWorkspacePorts(workspacePath: string): EffectQueryResult<readonly PortInfo[]>
```

This is the current React adapter shape after Phase 7. Hooks subscribe to the
Effect-owned metadata cache and trigger Effect refresh programs. Do not add
business logic, command execution, retry semantics, IPC parsing, or domain error
handling to hooks. Those belong in Effect programs and services.

### Effect Services (Side-Effect Boundary)

```typescript
import { Effect, Context } from 'effect'

class WorkspaceService extends Context.Service<
  WorkspaceService,
  {
    readonly getGitBranch: (workspacePath: string) => Effect.Effect<string | null, WorkspaceError>
    readonly getGitWorktrees: (
      workspacePath: string,
    ) => Effect.Effect<WorktreeInfo[], WorkspaceError>
    readonly getGitStatus: (workspacePath: string) => Effect.Effect<GitStatus, WorkspaceError>
    readonly getWorkspacePorts: (workspacePath: string) => Effect.Effect<PortInfo[], WorkspaceError>
  }
>()('WorkspaceService') {}

class PtyService extends Context.Service<
  PtyService,
  {
    readonly spawn: (request: SpawnPtyRequest) => Effect.Effect<PtySize, PtyError>
    readonly write: (sessionId: string, data: string) => Effect.Effect<void, PtyError>
    readonly resize: (sessionId: string, size: PtySize) => Effect.Effect<void, PtyError>
    readonly kill: (sessionId: string) => Effect.Effect<void, PtyError>
  }
>()('PtyService') {}
```

Effect service consumers see the third type parameter (requirements `R`):

```typescript
// getGitBranch has type:
//   Effect.Effect<string | null, WorkspaceError, WorkspaceService>
//
// Any effect requiring WorkspaceService will not compile unless the
// service is provided to the Effect runtime before execution.
```

Effect services must own:

- Shell process execution and parsing
- Electron IPC request/response wrappers
- PTY lifecycle commands and cancellation
- Persistence reads/writes for workspace layout
- Runtime validation with `Schema` at process and IPC boundaries
- Typed domain errors instead of thrown `unknown`
- Request caching, invalidation, and subscriptions through the Effect metadata
  cache

Effect-first implementation rules:

- New shell, git, workspace, PTY, persistence, and agent-facing code should
  expose typed `Effect.Effect<A, E, R>` programs at the service boundary.
- Use `Context.Service` + `Layer` for dependencies instead of importing singleton
  helpers from deep modules.
- Keep thrown exceptions and raw `Promise` code at the adapter edge only.
- Use `Schema` for every process, IPC, persisted-state, and command-output
  boundary that crosses trust or version seams.
- Keep React hooks thin: they should run or subscribe to Effect-backed services,
  not become the source of domain behavior.

Renderer hooks stay thin:

```typescript
import { useSyncExternalStore } from 'react'
import { WorkspaceMetadataCache } from './workspace-service'
import { runRendererEffect, runRendererEffectSync } from './runtime'

const useGitBranch = (workspacePath: string) => {
  const snapshot = useSyncExternalStore(
    (onStoreChange) =>
      runRendererEffect(
        WorkspaceMetadataCache.use((cache) =>
          cache.subscribeGitBranch(workspacePath, onStoreChange),
        ),
      ),
    () =>
      runRendererEffectSync(
        WorkspaceMetadataCache.use((cache) => cache.getGitBranchSnapshot(workspacePath)),
      ),
  )

  return snapshot
}
```

Phase 7 replaced `useQuery` with Tau's configured Effect runtime plus an
Effect-owned cache/subscription primitive.

---

## 4. PTY Architecture

Evolve the current singleton `PtyManager` into a `PtyPool` inside the PTY
utility process:

```
┌─────────────────────────────────┐
│  PTY Utility Process            │
│  PtyPool                        │
│  ┌──────┐ ┌──────┐ ┌──────┐     │
│  │ PTY 1│ │ PTY 2│ │ PTY 3│     │
│  │ bash │ │ zsh  │ │ cc   │     │
│  └──────┘ └──────┘ └──────┘     │
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

Use Effect `Schema` for the runtime message contract before messages cross the
renderer, main process, and PTY utility-process boundary. Invalid IPC payloads
must become typed protocol errors, not uncaught exceptions.

```typescript
import { Schema } from 'effect'

// Example: runtime validation for the spawn message
const SpawnSchema = Schema.Struct({
  type: Schema.Literal('spawn'),
  sessionId: Schema.String,
  cols: Schema.Number,
  rows: Schema.Number,
})
const PtyClientMessageSchema = Schema.Union([
  SpawnSchema,
  Schema.Struct({ type: Schema.Literal('write'), sessionId: Schema.String, data: Schema.String }),
  Schema.Struct({
    type: Schema.Literal('resize'),
    sessionId: Schema.String,
    cols: Schema.Number,
    rows: Schema.Number,
  }),
  Schema.Struct({ type: Schema.Literal('kill'), sessionId: Schema.String }),
  Schema.Struct({ type: Schema.Literal('renderer-ready') }),
])

type PtyClientMessage = Schema.Schema.Type<typeof PtyClientMessageSchema>
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
  direction: 'row' | 'column' // row = horizontal split, column = vertical split
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

- [x] Add React 19, React DOM, Zustand to project
- [x] Add Effect.ts (`effect`) and define the runtime/service boundary
- [x] Create empty Zustand store with workspace/tab/pane types
- [x] Create typed Effect errors and schemas for workspace and PTY contracts
- [x] Wire `react-resizable-panels` for sidebar + main layout
- [x] Render placeholder sidebar and main area
- [x] Ensure ghostty-web terminal still works inside a React component

### Phase 2: Sidebar + Workspaces

- [x] Workspace list UI in sidebar
- [x] Add workspace (project directory)
- [x] Remove workspace
- [x] Git branch display via `WorkspaceService.getGitBranch`
- [x] Worktree list via `WorkspaceService.getGitWorktrees`
- [x] Keep raw shell command execution inside the Effect service layer

### Phase 3: Tabs + Pane Layout

- [x] Tab bar with tab switching
- [x] New tab (Cmd+T)
- [x] Close tab (Cmd+W)
- [x] Integrate react-mosaic-component for pane grid
- [x] Split pane vertically (Cmd+D)
- [x] Split pane horizontally (Cmd+Shift+D)
- [x] Close pane (tile close button and Cmd+Shift+W)

Phase 3 is layout-only: the first terminal pane keeps the existing singleton
PTY-backed terminal mounted while other panes are layout placeholders.
Independent PTY sessions per pane remain Phase 4.

### Phase 4: PTY Pool

- [x] Evolve PTY service to PtyPool (session-based multiplexing)
- [x] Spawn/kill PTY per terminal pane
- [x] Route data by sessionId
- [x] Handle PTY exit per session
- [x] Wrap renderer ↔ PTY utility-process IPC in Effect services
- [x] Validate PTY protocol messages with Effect `Schema`

### Phase 5: Key Bindings + Navigation

- [x] Cmd+1..0 workspace switching
- [x] Ctrl+1..0 tab switching
- [x] Ctrl+HJKL pane navigation
- [x] Cmd+L focus terminal pane
- [x] All keyboard shortcuts centralized through Electron `before-input-event`

### Phase 6: Polish

- [x] Tab auto-title (scan terminal output for OSC title sequences)
- [x] Pane status indicators (agent lifecycle rings)
- [x] Workspace persistence through an Effect-backed storage service (localStorage for MVP)
- [x] Drag-and-drop tab reorder
- [x] Drag-and-drop workspace reorder

### Phase 7: Effect-First Backend + TanStack Exit

- [x] Introduce a configured app Effect runtime for main/preload/renderer
      adapters
- [x] Convert workspace and git helpers from Promise-returning functions into
      `Context.Service` services with `Layer` implementations
- [x] Move IPC request/response wrappers behind Effect services with typed
      domain errors
- [x] Add Effect-owned caching/subscription semantics for workspace metadata,
      git status, worktrees, ports, and PR info
- [x] Replace the TanStack Query hooks with thin Effect runtime hooks
- [x] Remove `@tanstack/react-query` once the Effect-backed hooks cover the
      current branch/worktree/status surfaces

---

## 9. Key Dependencies

```jsonc
{
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "effect": "4.0.0-beta.66",
    "zustand": "^5.0.0",
    "react-mosaic-component": "^6.0.0",
    "react-resizable-panels": "^4.11.1",
    "lucide-react": "^1.16.0",
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^5.2.0",
    "@tailwindcss/vite": "^4.3.0",
    "oxfmt": "^0.49.0",
    "oxlint": "^1.64.0",
    "tailwindcss": "^4.3.0",
  },
}
```

These are the dependency families used or planned across the implementation
phases. `package.json` remains the source of truth for what has landed.

`@tanstack/react-query` was transitional and has been removed. The current
backend and renderer metadata architecture is Effect-first.

The existing `electron-vite` config already wires `@vitejs/plugin-react` and
`@tailwindcss/vite` into the renderer build config.

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
