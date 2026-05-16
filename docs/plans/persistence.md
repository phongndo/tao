# Persistence Plan

**Status**: Planning  
**Last updated**: 2026-05-15

## Overview

Tao currently uses Zustand's `persist` middleware backed by browser `localStorage` for UI state (workspaces, tabs, panes, sidebar). There is no terminal scrollback persistence, no settings file, no database. This plan migrates all persistence to a proper architecture centered on:

- **SQLite** (via `@effect/sql-sqlite-node`) for relational data
- **JSON files** for UI layout and user settings
- **Binary state snapshots + PTY logs** for terminal scrollback
- **Plain text excerpt** for search

The core principle: terminal persistence must be O(1) — reopen should be instant, regardless of session length. This is achieved by adding a serialization API to ghostty-web via a Zig patch to Ghostty's WASM parser.

---

## Goals

| Goal | Why |
|---|---|
| **O(1) terminal reopen** | Serialize full terminal state as compact binary. Deserialize into a fresh GhosttyTerminal in one memcpy. |
| **100% fidelity** | Every escape sequence, cursor position, alt-screen state, color, hyperlink — nothing lost. |
| **Crash resilience** | PTY output log serves as fallback if state file is missing or corrupted. |
| **Searchable history** | Plain text excerpt of last N lines stored in SQLite for grep/search. |
| **Effect-TS throughout** | Every DB/file operation is an Effect. Layers for DI. Schema-validated. |
| **No chat/agent session storage** | CLI tools (pi, codex, claude) own their own sessions. Tao only persists terminal and workspace state. |
| **Tough data integrity** | SQLite with strict types, foreign keys, migrations (via `@effect/sql/Migrator`), CRC32 on state blobs. |

---

## Directory Layout

```
~/.tao/
├── tao.db                  # SQLite — workspaces, terminal sessions, settings
├── settings.json           # User preferences (theme, font, window bounds)
├── pane-layouts.json       # Per-workspace UI state (tabs, mosaic layouts, active pane)
└── sessions/               # Terminal session artifacts
    ├── <session-id>.log        # Raw PTY output (append-only, crash-safe)
    ├── <session-id>.state.bin  # Compressed binary serialized terminal state
    └── ...
```

---

## Project Layout — New & Changed Files

```
tao/
├── packages/
│   └── shared/
│       └── src/
│           ├── session.ts                NEW: session type schemas
│           └── storage-path.ts           NEW: ~/.tao/ path resolution
│
├── apps/desktop/
│   ├── package.json                     MODIFY: add @effect/sql-sqlite-node, better-sqlite3
│   │
│   ├── patches/
│   │   └── ghostty-serialization.patch  NEW: Zig serialization patch for ghostty-web
│   │
│   └── src/
│       ├── main/
│       │   ├── index.ts                 MODIFY: init DB, run migrations on app.ready
│       │   ├── db/
│       │   │   ├── client.ts            NEW: Effect SQLite client layer (TaoDbLive)
│       │   │   ├── migrate.ts           NEW: migration runner layer
│       │   │   ├── migrations/
│       │   │   │   ├── 001_create_workspaces.ts
│       │   │   │   ├── 002_create_terminal_sessions.ts
│       │   │   │   └── 003_create_settings.ts
│       │   │   └── service.ts           NEW: typed DB operations as Effects
│       │   ├── session-store.ts         NEW: terminal session lifecycle
│       │   ├── file-store.ts            NEW: read/write session logs + state files
│       │   ├── pty-service.ts           MODIFY: tee PTY output to session log
│       │   └── workspace-service.ts     (unchanged)
│       │
│       ├── preload/
│       │   └── index.ts                 MODIFY: expose session IPC channels
│       │
│       └── renderer/
│           ├── terminal.ts              MODIFY: serialize on close, restore on open
│           ├── session.ts               NEW: renderer-side session manager
│           ├── state/store.ts           MODIFY: remove persist middleware
│           ├── storage.ts               REMOVE
│           └── ui/TerminalPane.tsx      MODIFY: pass session data to createTerminal()
│
│   └── electron.vite.config.ts          MODIFY: add alias for @tao/shared
```

---

## Effect-TS Integration

Every database/filesystem operation is an Effect. The layered architecture:

```
[Renderer React]
    ↓ IPC (window.electronAPI.*)
[Preload bridge]
    ↓ ipcMain.handle()
[Main Process — Effect Runtime]
    ├── TaoDb (SqliteClient layer)
    ├── FileStore (read/write files — @effect/platform/FileSystem)
    ├── SessionRepo (typed DB operations)
    ├── WorkspaceRepo (typed DB operations)
    └── WorkspaceService (existing)
```

### Layers

```typescript
// SQLite client
TaoDbLive = SqliteClient.layer({
  filename: join(homedir(), ".tao", "tao.db"),
  transformResultNames: (str) => str,  // snake_case in DB
  transformQueryNames: (str) => str,
  disableWAL: false,                    // WAL for renderer reads
})

// Migration runner
MigrateLive = SqliteMigrator.run({
  loader: SqliteMigrator.fromGlob(import.meta.glob('./db/migrations/*.ts')),
  table: 'tao_migrations',
  schemaDirectory: join(__dirname, 'db/migrations'),
})

// Service layers
SessionRepoLive = Layer.effect(SessionRepo, ...)
WorkspaceRepoLive = Layer.effect(WorkspaceRepo, ...)
FileStoreLive = Layer.effect(FileStore, ...)

// Composition
MainLive = TaoDbLive >>> MigrateLive >>> SessionRepoLive
        >>> WorkspaceRepoLive >>> FileStoreLive >>> WorkspaceServiceLive
```

---

## Ghostty-Web Serialization — Zig Patch

### Why a Zig patch

ghostty-web (v0.4.0-next) has no serialize/deserialize API. The WASM exports are read-only lifecycle functions (`_new`, `_write`, `_resize`, `_get_scrollback_*`). Ghostty's terminal parser is written in Zig, and ghostty-web already patches it (`patches/ghostty-wasm-api.patch`). We add our own patch to expose serialization.

### New WASM exports

```zig
// Get required buffer size — call first to allocate
ghostty_terminal_serialize_size(ptr) -> u32

// Serialize full terminal state into buffer
ghostty_terminal_serialize(ptr, out_buf, buf_len) -> i32  // bytes written, or 0 on error

// Deserialize buffer into a fresh terminal
ghostty_terminal_deserialize(ptr, in_buf, buf_len) -> bool

// Get last error message (for diagnostics)
ghostty_terminal_last_error(ptr) -> [*:0]u8
```

### Serialization format

```
┌───────────────────────────────────────────┐
│ Magic: "TAOS" (u32 x2 = 8 bytes)          │
│ Version: u32 (1)                          │
│ CRC32: u32 of everything after             │
│ HeaderSize: u32 offset to first section    │
│ SectionFlags: u64 bitmask of sections      │
├───────────────────────────────────────────┤
│ SCREEN_NORMAL (required):                  │
│   cols, rows, cursor_x, cursor_y,          │
│   cursor_visible, cursor_style,            │
│   saved_cursor_x, saved_cursor_y,          │
│   viewport_y, scrollback_len               │
│   Cells: [GhosttyCell × rows×cols]         │
│   Scrollback: [GhosttyCell × scrollback]   │
├───────────────────────────────────────────┤
│ SCREEN_ALT (required):                     │
│   Same layout as normal                    │
├───────────────────────────────────────────┤
│ MODES (required):                          │
│   mode_bitfield: [u8 × 256]               │
├───────────────────────────────────────────┤
│ COLORS (required):                        │
│   palette: [u32 × 16]                     │
│   fg, bg, cursor: u32                     │
├───────────────────────────────────────────┤
│ REGION (required):                        │
│   top, bottom, left, right: u16           │
├───────────────────────────────────────────┤
│ GRAPHEMES (optional):                     │
│   count: u32                              │
│   entries: [{ type, row, col, cps[] }]    │
├───────────────────────────────────────────┤
│ TABSTOPS (optional):                      │
│   bitfield: [u64 × ceil(cols/64)]         │
├───────────────────────────────────────────┤
│ HYPERLINKS (optional):                    │
│   count: u32                              │
│   entries: [{ id, uri_len, uri }]         │
└───────────────────────────────────────────┘
```

`GhosttyCell` is 16 bytes:

```zig
pub const GhosttyCell = extern struct {
    codepoint: u32,
    fg_r: u8, fg_g: u8, fg_b: u8,
    bg_r: u8, bg_g: u8, bg_b: u8,
    flags: u8,
    width: u8,
    hyperlink_id: u16,
    grapheme_len: u8,
    _pad: u8,
};
```

### Storage estimates

| Component | Raw | Compressed (zstd) |
|---|---|---|
| Viewport (80×24) | ~30 KB | ~5 KB |
| Scrollback (10,000 lines) | ~12.8 MB | ~200-800 KB |
| Alt screen | ~30 KB | ~5 KB |
| Modes + colors + metadata | ~500 B | ~500 B |
| **Total** | **~13 MB** | **~200-800 KB** |

### Patching approach

We maintain a fork of `coder/ghostty-web` at `tao-terminal/ghostty-web` with the serialization patch baked in. Tao's `package.json` points to the fork:

```json
"ghostty-web": "github:tao-terminal/ghostty-web#serialization-v1"
```

The patch file (`patches/ghostty-serialization.patch`) is kept in Tao's repo for documentation and upstream contribution.

---

## Database Schema (Effect SQL Migrations)

Migration files live in `src/main/db/migrations/` as TypeScript files. Each exports a default `Effect<void>` that runs SQL via `SqlClient`.

### Migration 001 — `workspaces`

```sql
CREATE TABLE workspaces (
    id              TEXT PRIMARY KEY,
    project_path    TEXT NOT NULL,
    name            TEXT,
    branch          TEXT,
    head_sha        TEXT,
    worktrees_json  TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_workspaces_project_path ON workspaces(project_path);

CREATE TRIGGER update_workspaces_updated_at
    AFTER UPDATE ON workspaces
    BEGIN
        UPDATE workspaces SET updated_at = datetime('now') WHERE id = NEW.id;
    END;
```

### Migration 002 — `terminal_sessions`

```sql
CREATE TABLE terminal_sessions (
    id               TEXT PRIMARY KEY,
    workspace_id     TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
    cwd              TEXT,
    cols             INTEGER,
    rows             INTEGER,
    title            TEXT,
    state_path       TEXT,
    log_path         TEXT,
    state_size       INTEGER,
    log_size         INTEGER,
    scrollback_text  TEXT,
    alternate_screen INTEGER DEFAULT 0,
    bracketed_paste  INTEGER DEFAULT 0,
    started_at       TEXT NOT NULL,
    ended_at         TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_terminal_sessions_workspace ON terminal_sessions(workspace_id);
CREATE INDEX idx_terminal_sessions_ended   ON terminal_sessions(ended_at);
```

### Migration 003 — `settings`

```sql
CREATE TABLE settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER update_settings_updated_at
    AFTER UPDATE ON settings
    BEGIN
        UPDATE settings SET updated_at = datetime('now') WHERE key = NEW.key;
    END;
```

Migration table: `tao_migrations` (controlled by Migrator's `table` option).

---

## DB Service Layer

All database operations are exposed as Effect service tags. Examples:

```typescript
export class SessionRepo extends Context.Tag("Tao/SessionRepo")<
  SessionRepo,
  {
    readonly insert: (session: NewSession) => Effect.Effect<void, SqlError>
    readonly getById: (id: string) => Effect.Effect<SessionRow | null, SqlError>
    readonly getByWorkspace: (workspaceId: string) => Effect.Effect<readonly SessionRow[], SqlError>
    readonly getLatestForWorkspace: (workspaceId: string) => Effect.Effect<SessionRow | null, SqlError>
    readonly updateEndedAt: (id: string, endedAt: string) => Effect.Effect<void, SqlError>
    readonly setStatePath: (id: string, path: string) => Effect.Effect<void, SqlError>
    readonly delete: (id: string) => Effect.Effect<void, SqlError>
    readonly cleanupOlderThan: (days: number) => Effect.Effect<number, SqlError>
    readonly search: (query: string, limit: number) => Effect.Effect<readonly SessionRow[], SqlError>
  }
>() {}

export class WorkspaceRepo extends Context.Tag("Tao/WorkspaceRepo")<
  WorkspaceRepo,
  {
    readonly upsert: (workspace: Workspace) => Effect.Effect<void, SqlError>
    readonly getAll: () => Effect.Effect<readonly WorkspaceRow[], SqlError>
    readonly getById: (id: string) => Effect.Effect<WorkspaceRow | null, SqlError>
    readonly delete: (id: string) => Effect.Effect<void, SqlError>
  }
>() {}

export class FileStore extends Context.Tag("Tao/FileStore")<
  FileStore,
  {
    readonly initSessionDir: () => Effect.Effect<void, FileStoreError>
    readonly readState: (sessionId: string) => Effect.Effect<Uint8Array, FileStoreError>
    readonly writeState: (sessionId: string, data: Uint8Array) => Effect.Effect<void, FileStoreError>
    readonly readLog: (sessionId: string) => Effect.Effect<Uint8Array, FileStoreError>
    readonly appendLog: (sessionId: string, chunk: Uint8Array) => Effect.Effect<void, FileStoreError>
    readonly finalizeLog: (sessionId: string) => Effect.Effect<void, FileStoreError>
    readonly deleteSessionFiles: (sessionId: string) => Effect.Effect<void, FileStoreError>
    readonly totalSize: () => Effect.Effect<number, FileStoreError>
  }
>() {}
```

Each service layer is implemented via `Layer.effect` with the `SqlClient` tag:

```typescript
export const SessionRepoLive = Layer.effect(
  SessionRepo,
  SqlClient.pipe(
    Effect.map((sql) => ({
      insert: (session) =>
        sql`INSERT INTO terminal_sessions ${sql.insert(session)}`.withoutTransform,
      getById: (id) =>
        sql`SELECT * FROM terminal_sessions WHERE id = ${id}`.pipe(
          Effect.map((rows: SessionRow[]) => rows[0] ?? null),
        ),
      // ...
    })),
  ),
)
```

---

## Session Lifecycle

### Open

```
User creates tab / reopens workspace
  │
  ├─► Renderer: window.electronAPI.openSession(workspaceId, cwd, cols, rows)
  │
  ├─► Main Process:
  │     ├─► SessionRepo.create({ id, workspaceId, cwd, cols, rows, started_at })
  │     ├─► FileStore.initSessionDir()
  │     ├─► FileStore.appendLog(id, "")     // create empty log file
  │     └─► spawn PTY (existing flow, now with log file path)
  │
  └─► Renderer:
        ├─► If restoring: fetch from DB → try deserialize() → fallback to replay log
        └─► createTerminal(id, options)
```

### PTY Output Tee

In `pty-service.ts`, the existing chunked output buffer is also written to the log file:

```
PTY output → batch into chunks[] → IPC to renderer
                                 → append to <session-id>.log
```

The log file path is passed to the PTY utility process via the IPC setup message.

### Close

```
User closes tab / pane
  │
  ├─► Renderer:
  │     ├─► term.wasmTerm.serialize() → Uint8Array
  │     ├─► Extract last 100 lines from ghostty scrollback buffer
  │     ├─► window.electronAPI.closeSession(id, stateBuffer, text, title, altScreen)
  │     └─► term.dispose()
  │
  ├─► Main Process:
  │     ├─► Compress stateBuffer → write to <id>.state.bin
  │     ├─► SessionRepo.update({
  │     │     ended_at, state_path, state_size,
  │     │     scrollback_text, title, alternate_screen
  │     │   })
  │     └─► FileStore.finalizeLog(id)   // close file handle
  │
  └─► PTY Service: kill PTY process
```

### Reopen

```
User activates workspace with previous session
  │
  ├─► Renderer: window.electronAPI.reopenSession(workspaceId)
  │
  ├─► Main Process:
  │     ├─► SessionRepo.getLatestForWorkspace(workspaceId)
  │     ├─► FileStore.readState(id) → Uint8Array or null
  │     ├─► If state exists → return state buffer (Primary, O(1))
  │     ├─► If not → FileStore.readLog(id) → return log buffer (Fallback, O(n))
  │     └─► Return: { cols, rows, cwd, state?, log? }
  │
  └─► Renderer:
        ├─► createTerminal(id, { cols, rows, cwd })
        ├─► if state: term.wasmTerm.deserialize(state)     // O(1) — ~0.1ms
        ├─► else if log: term.write(log)                   // O(n) — 42MB/s
        └─► wire live PTY IPC
```

### Search

```sql
SELECT scrollback_text FROM terminal_sessions
WHERE scrollback_text LIKE '%error%'
  AND workspace_id = 'tao:/Users/dp/code/projects/tao'
ORDER BY ended_at DESC LIMIT 10;
```

---

## JSON Files

### `~/.tao/pane-layouts.json`

Stores non-relational UI state that changes frequently. No ACID needed.

```json
{
  "version": 1,
  "workspaces": [
    { "id": "tao:local", "name": "Local", "projectPath": null, "order": 0 }
  ],
  "activeWorkspaceId": "tao:local",
  "tabs": [
    { "id": "tab-xxx", "workspaceId": "tao:local", "name": "Terminal", "layout": "pane-yyy", "order": 0 }
  ],
  "panes": [
    { "id": "pane-yyy", "tabId": "tab-xxx", "type": "terminal", "name": "Terminal 1", "cwd": null, "status": "idle" }
  ],
  "activeTabId": "tab-xxx",
  "activePaneId": "pane-yyy",
  "sidebarExpanded": true,
  "sidebarWidth": 240
}
```

Read/write via `JSON.parse`/`JSON.stringify` wrapped in Effect, with fallback to defaults.

### `~/.tao/settings.json`

Human-editable user preferences. Synced with the `settings` DB table on startup/write.

```json
{
  "version": 1,
  "theme": {
    "background": "#151515",
    "foreground": "#c9c7cd",
    "cursor": "#cac9dd",
    "cursorAccent": "#151515",
    "selectionBackground": "#2a2a2d",
    "selectionForeground": "#c1c0d4",
    "black": "#27272a",
    "red": "#f5a191",
    "green": "#90b99f",
    "yellow": "#e6b99d",
    "blue": "#aca1cf",
    "magenta": "#e29eca",
    "cyan": "#ea83a5",
    "white": "#c1c0d4",
    "brightBlack": "#424246",
    "brightRed": "#ffae9f",
    "brightGreen": "#9dc6ac",
    "brightYellow": "#f0c5a9",
    "brightBlue": "#b9aeda",
    "brightMagenta": "#ecaad6",
    "brightCyan": "#f591b2",
    "brightWhite": "#cac9dd"
  },
  "font": {
    "family": "\"SF Mono\", Menlo, Monaco, \"JetBrains Mono\", monospace",
    "size": 14,
    "lineHeight": 1.3
  },
  "ui": {
    "cursorStyle": "block",
    "cursorBlink": false,
    "scrollbackLines": 10000,
    "smoothScrollDuration": 200,
    "sidebarExpanded": true,
    "sidebarWidth": 240
  },
  "window": {
    "width": 900,
    "height": 600,
    "x": null,
    "y": null,
    "state": "Windowed"
  }
}
```

---

## IPC Surface

### New preload API

```typescript
interface ElectronAPI {
  // Existing PTY methods (unchanged):
  spawnPty(sessionId, cols, rows, cwd): Promise<PtySize>
  sendPtyInput(sessionId, data): void
  resizePty(sessionId, cols, rows): void
  killPty(sessionId): void
  onPtyData(sessionId, callback): () => void
  onPtyError(sessionId, callback): () => void
  onPtyExit(sessionId, callback): () => void

  // New — sessions:
  openSession(workspaceId: string, cwd: string | null, cols: number, rows: number): Promise<SessionInfo>
  closeSession(id: string, state: Uint8Array, text: string, title: string, altScreen: boolean): Promise<void>
  reopenSession(workspaceId: string): Promise<ReopenData | null>
  getSessionList(workspaceId: string): Promise<SessionSummary[]>
  deleteSession(id: string): Promise<void>

  // New — files:
  readLayout(): Promise<PaneLayoutData | null>
  writeLayout(data: PaneLayoutData): Promise<void>
  readSettings(): Promise<SettingsData | null>
  writeSettings(data: SettingsData): Promise<void>
}
```

### IPC handlers (main process)

```typescript
ipcMain.handle('session:open', sessionOpenHandler)
ipcMain.handle('session:close', sessionCloseHandler)
ipcMain.handle('session:reopen', sessionReopenHandler)
ipcMain.handle('session:list', sessionListHandler)
ipcMain.handle('session:delete', sessionDeleteHandler)
ipcMain.handle('layout:read', layoutReadHandler)
ipcMain.handle('layout:write', layoutWriteHandler)
ipcMain.handle('settings:read', settingsReadHandler)
ipcMain.handle('settings:write', settingsWriteHandler)
```

Each handler wraps the Effect with `authorizeRenderer` and provides the service layers:

```typescript
function sessionOpenHandler(event, ...args): Promise<Result> {
  return Effect.runPromise(
    authorizeRenderer(event).pipe(
      Effect.flatMap(() => sessionOpenEffect(...args)),
      Effect.provide(SessionRepoLive),
      Effect.provide(FileStoreLive),
      Effect.provide(TaoDbLive),
    ),
  )
}
```

---

## App Startup Sequence (`src/main/index.ts`)

```typescript
app.whenReady().then(() => {
  // 1. Ensure ~/.tao/ and ~/.tao/sessions/ exist
  // 2. Run DB migrations (create tables if needed)
  // 3. Sync settings.json → DB (if file is newer)
  // 4. Read pane-layouts.json (deferred — renderer requests it)
  // 5. Create window
  // 6. Setup PTY service
})
```

Migration runner:

```typescript
const runMigrations = Effect.gen(function* () {
  const result = yield* SqliteMigrator.run({
    loader: SqliteMigrator.fromGlob(import.meta.glob('./db/migrations/*.ts')),
    table: 'tao_migrations',
    schemaDirectory: join(__dirname, 'db/migrations'),
  })
  yield* Effect.log(`Applied ${result.length} migrations`)
})
```

---

## Session Cleanup

Background maintenance effect, runs hourly:

- **Age-based**: Delete sessions older than 30 days
- **Size-based**: Cap total session storage at 2 GB (delete oldest first)
- **Calls** `FileStore.deleteSessionFiles(id)` + `SessionRepo.delete(id)`

```typescript
const sessionCleanup = Effect.repeat(
  Effect.gen(function* () {
    const repo = yield* SessionRepo
    const store = yield* FileStore
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    const oldSessions = yield* repo.getOlderThan(new Date(cutoff))
    for (const session of oldSessions) {
      yield* store.deleteSessionFiles(session.id)
      yield* repo.delete(session.id)
    }
    const totalSize = yield* store.totalSize()
    if (totalSize > 2 * 1024 * 1024 * 1024) {
      // Delete oldest sessions until under limit
    }
  }),
  Schedule.spaced(Duration.hours(1)),
)
```

---

## Edge Cases

| Scenario | Handling |
|---|---|
| **Crash before serialize** | Log file exists up to crash point. Reopen falls back to PTY log replay. Text excerpt is empty. |
| **State file corrupted** | CRC32 mismatch in deserialize() → return false. Fall back to log replay. |
| **Both state and log missing** | Fresh terminal in workspace CWD. No scrollback. |
| **Multiple sessions per workspace** | `getLatestForWorkspace` returns most recent. User can list all. |
| **Settings.json manually edited** | Startup sync detects newer mtime → import into DB. |
| **Ghostty-web upgrade breaks patch** | Our fork maintains the serialization patch. We control the rebase. |
| **Zig not installed** | WASM binary is pre-built and committed. Only need Zig if regenerating. |
| **Concurrent write to state file** | Serialized via main process — single writer. |

---

## Dependencies

### NPM

```json
{
  "@effect/sql": "^0.51.0",
  "@effect/sql-sqlite-node": "^0.52.0",
  "@effect/platform": "^0.72.0",
  "@effect/platform-node": "^0.66.0",
  "better-sqlite3": "^12.6.0",
  "uuid": "^11.0.0"
}
```

### Zig (maintainers only)

```bash
brew install zig
zig version  # 0.15.2+
```

The WASM binary is pre-built. The `patches/` directory and build scripts are for maintainer use when regenerating.

---

## Implementation Order

| Phase | What | Est. time |
|---|---|---|
| **1** | Write & test the Zig serialization patch. Build WASM binary. | 2-3 weeks |
| **2** | Add `@effect/sql` deps, set up TaoDbLive layer, write migrations | 2 days |
| **3** | Write DB services (SessionRepo, WorkspaceRepo) | 2 days |
| **4** | Write FileStore layer | 1 day |
| **5** | Modify PTY service to tee output to log file | 1 day |
| **6** | Wire IPC (preload + main handlers) | 2 days |
| **7** | Modify renderer terminal lifecycle (serialize/deserialize) | 2 days |
| **8** | Add session cleanup maintenance | 1 day |
| **9** | Write settings.json / pane-layouts.json readers | 1 day |
| **10** | Remove localStorage Zustand persist + `storage.ts` | 0.5 day |
| **11** | Testing and integration | 3 days |

**Total: ~6-8 weeks**

---

## What We DON'T Persist

- ❌ No chat/agent session history (CLI tools own this)
- ❌ No terminal input history (shell history is the shell's job)
- ❌ No PTY process state (reopen spawns a fresh shell)
- ❌ No binary state for sessions outside ~30-day retention
