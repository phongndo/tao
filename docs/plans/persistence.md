# Persistence Plan

**Status**: Incremental implementation started  
**Last updated**: 2026-05-16

## Overview

Tao's persistence goal is **process and agent continuity**, not replaying old shell scrollback. Tao
is a terminal for orchestrating AI agents through CLIs such as `pi`, `codex`, `claude`, and similar
tools. Persistence therefore needs to preserve three things:

1. **Live process continuity** — if an AI CLI is still running, Tao should reattach to the same PTY
   and conversation after the UI restarts.
2. **Native command/session resume** — if the live process is gone, Tao should restart configured
   terminal apps or relaunch supported AI CLIs via their native resume/session mechanisms.
3. **Useful metadata, not fake history** — layout, cwd, titles, last command/agent identity, and
   bounded diagnostic excerpts can be kept, but Tao should not replay old `zsh`/shell scrollback into
   a new live terminal.

The architecture is a hybrid:

- **`taod` daemon** (Zig) owns PTYs, AI CLI subprocesses, terminal event logs, metadata, and agent
  adapters. The Electron UI is a client that attaches/detaches.
- **Optional current-screen snapshots** may later improve live reattach first paint, but are not a
  cold shell-history restore mechanism.
- **Framed PTY event logs** provide diagnostics, bounded excerpts, and agent/session-id extraction;
  they are not replayed into newly spawned shells.
- **Agent adapters/hooks** capture native AI CLI session IDs and resume commands.
- **SQLite** stores session metadata, optional current-screen metadata, agent session metadata, and
  searchable excerpts.
- **JSON files** remain the source of truth for human-editable settings and UI layout.

This replaces the current Zustand `persist` + browser `localStorage` model.

---

## Current Implementation Status

The full daemon/agent-resume architecture below is the target design. The current codebase now has an
Electron-side persistence slice that reduces data loss and removes renderer-only layout storage, plus
an initial Zig daemon skeleton/tooling setup while the larger `taod` runtime work is pending.

### Implemented now

- **File-backed UI layout**: pane/workspace/tab layout is persisted to `~/.tao/pane-layouts.json`
  through Electron main IPC instead of Zustand `persist` + browser `localStorage`.
- **One-time localStorage migration**: existing `localStorage['tao-workspaces']` data is read once
  and then removed after a successful migration path is available.
- **File-backed settings service**: `~/.tao/settings.json` read/write IPC exists with default
  persistence settings.
- **Stable pane/session identifiers**: panes now carry `terminalId` and `lastSessionId` so layout
  identity is separate from terminal session identity.
- **Stable terminal IDs reach `taod`**: the renderer/preload/MessagePort bridge now forwards
  `terminalId` separately from `sessionId`, allowing daemon metadata and cold-restart lookup to key
  panes by their stable terminal identity instead of only the current PTY session id.
- **Framed PTY event log prototype**: PTY output, resize, and exit frames are appended under
  `~/.tao/sessions/<session-id>/events.taoev` with sequence numbers and CRC checks.
- **Hardened event-log parsing**: readers validate the file header, frame CRCs, monotonic sequence
  numbers, partial tails, and bounded truncation. Raw cold replay into a newly spawned shell is now
  removed from the app path because replaying arbitrary PTY tails creates fake/stale terminal state.
- **No cold shell scrollback restore**: if a pane's process is gone, Tao starts a fresh shell or will
  run the captured CLI/agent resume command. Old `zsh` scrollback is not shown as a restored terminal.
- **Current file-store retention maintenance**: the utility PTY service periodically applies the
  persistence retention settings to inactive session directories while preserving known live
  sessions.
- **Clear-history controls for the current file store**: users can clear persisted history for the
  active pane, for a workspace's known sessions, or for all session directories; live shells keep
  running and their event logs are reset instead of killing the PTY.
- **Explicit transitional session APIs**: preload now exposes `createSession`, `attachSession`,
  `detachSession`, `writeSessionInput`, `resizeSession`, `killSession`, and `onSessionOutput`
  wrappers over the existing utility PTY bridge.
- **Event-log regression tests**: the TypeScript event-log bridge has tests for CRC rejection,
  partial tails, bounded diagnostic reads, large logs, and cleanup behavior.
- **First-paint/render stability fixes**: the Electron window is shown only after the active pane is
  ready; inactive terminals no longer signal app readiness; automatic DevTools opening is disabled;
  terminal surfaces stay hidden through initial fit/resize settle to avoid exposing intermediate
  Ghostty renders.
- **Utility PTY process survives renderer/window reloads better**: closing a BrowserWindow no longer
  immediately kills the utility PTY service; new renderer ports can reconnect to the same service.
- **Electron install repair**: `scripts/fix-electron-install.mjs` repairs incomplete Electron binary
  installs before `dev` / `start`.
- **Initial Zig daemon skeleton**: `apps/daemon` now exists as a pnpm workspace package with
  `build.zig`, `src/main.zig`, module boundaries for daemon/session/RPC/PTY/event-log/snapshot/DB/
  adapter/cleanup/VT work, a real POSIX PTY boundary, SQLite migration strings, and Zig unit tests
  for the scaffolded pieces. The daemon is buildable but not yet used by the Electron app.
- **Daemon control RPC/session registry prototype**: `taod` now binds `~/.tao/run/taod.sock`, accepts
  newline-delimited JSON control requests, handles create/attach/resize/detach/kill against an
  in-memory session registry, and returns typed JSON responses. Requests now accept the documented
  `type`/camelCase fields while preserving the scaffold's older `method`/snake_case shape.
- **Daemon binary stream frame codec**: `apps/daemon/src/rpc.zig` now has a tested binary frame
  encoder/parser for output, input, resize, snapshot, exit, and agent frames, including session IDs,
  sequence numbers, payload lengths, CRC checks, partial-tail handling, and packed resize/exit
  payload helpers. `@tao/shared/taod-protocol` exports matching stream constants for the future
  Electron client. The stream session-id field is now large enough for Tao's current prefixed UUID
  session IDs.
- **Daemon POSIX PTY driver**: `apps/daemon/src/pty.zig` now uses `forkpty`/`execvp`, applies
  initial and subsequent window sizes, supports PTY input writes, output reads, termination, and
  non-blocking child-exit polling.
- **Daemon socket-level attach stream**: `taod` now keeps accepting control clients while per-attach
  worker threads bridge binary INPUT/RESIZE frames from clients to the PTY and OUTPUT/EXIT frames
  back to clients. Attach streams now attach to live output only; old event logs are not replayed as
  terminal scrollback.
- **Daemon-owned background PTY readers**: each spawned PTY now has a daemon-owned reader thread that
  continues draining output, appending event logs, and broadcasting to attached clients even while no
  renderer is attached. A bounded in-memory pending-output buffer covers create-before-attach and
  short live reattach gaps without replaying cold event-log scrollback.
- **Daemon-owned event-log writes**: sessions created with an argv now get `events.taoev` files under
  `~/.tao/sessions/<session-id>/`, and daemon PTY output, resize, and exit frames are appended from
  the Zig side for diagnostics/metadata extraction, not terminal replay.
- **Initial VT integration boundary**: `apps/daemon/src/vt.zig` now isolates the daemon VT parser
  boundary, session objects own a VT instance, and daemon PTY output/resize events are fed into that
  state before live stream broadcast. The default CI-safe backend is a small Zig fallback; a native
  `-Dvt-backend=libghostty_c` build option links a system-installed `libghostty-vt` C ABI while the
  upstream Zig package catches up to Tao's Zig 0.16 toolchain.
- **Daemon-owned retention and clear-history controls**: `taod` now accepts control RPCs for
  `clear-history` and `cleanup`. Live/in-memory sessions keep their PTYs while their event logs and
  excerpts are reset, inactive session directories can be deleted by explicit clear-history, and
  retention cleanup honors configured age/size limits while preserving sessions known to the daemon
  or Electron bridge.
- **Initial daemon SQLite layer**: `taod` now opens `~/.tao/tao.db`, applies ordered migrations for
  `terminal_sessions`, `agent_sessions`, and FTS search, and mirrors terminal session create/attach/
  resize/detach/exit metadata outside the PTY-output hot path.
- **SQLite restart/search metadata expansion**: `taod` can now look up persisted terminal-session
  rows by session/terminal id, prune metadata for deleted diagnostic logs, clear stale FTS rows when
  history is reset, store bounded search excerpts in `terminal_search`, and query indexed excerpts.
- **Cold command relaunch from metadata**: when an attach targets a session that is not in the
  in-memory daemon registry, `taod` reads the saved `argv_json`/cwd/size metadata and starts a new
  PTY with that command instead of replaying old scrollback. If the restart command cannot be run,
  Electron still falls back to creating a fresh shell.
- **Initial agent resume metadata**: `taod` detects `pi`, `codex`, and `claude` argv executables,
  captures native session ids from common resume/session flags, stores `agent_sessions` rows, and
  prefers stored adapter-style resume argv when cold-starting a previously agent-driven terminal.
- **Electron main `taod` bridge**: the desktop main process now has a `TaodClient` that launches or
  connects to `taod`, translates the existing MessagePort session protocol to daemon JSON control
  RPC plus binary stream frames, creates shell sessions through the daemon, streams output/resize/exit
  frames back to the renderer, forwards clear-history/retention maintenance to the daemon, and falls
  back to the utility-process PTY service if the daemon is not available during migration.
  `TAO_PTY_BACKEND=taod` forces daemon-only mode and
  `TAO_PTY_BACKEND=utility` forces the legacy utility process.
- **Zig tooling and CI support**: Nix now provides Zig 0.16, ZLS, and `nixpkgs-fmt`; root pnpm
  `zig:*` scripts wrap build/test/lint/format/LSP checks; CI installs Zig, runs `pnpm check`, verifies
  the Nix dev-shell/ZLS path, and builds `taod` before desktop production builds.

### Important limitations of the current slice

- There is now an **Electron-integrated `taod` path**, but it is still transitional. The main process
  can launch/connect to a built daemon and falls back to the utility-process PTY service when `taod`
  is unavailable. Production packaging and hardened daemon lifecycle supervision still need work.
- Live reattach in the shipping Electron path currently works only while the utility process remains
  alive when the fallback path is used. The daemon path keeps PTYs outside the renderer/window and now
  drains detached PTY output in daemon-owned reader threads, but production lifecycle supervision and
  slow-client backpressure policies still need hardening.
- There are **no libghostty-vt snapshots yet**. The daemon now has a VT state boundary, but current
  screen serialization/checkpointing remains future work. This is no longer a blocker for the core
  persistence goal because old shell scrollback is not considered true restore. A future snapshot
  should only improve live/current-screen reattach, not resurrect dead process state.
- There is **no cold terminal scrollback restore by design**. Dead sessions start fresh or resume via
  native CLI/agent mechanisms; event-log excerpts are for diagnostics/search/adapter detection.
- There is an **expanded SQLite metadata layer**. `terminal_sessions`, basic `agent_sessions`, and
  FTS excerpt indexing now exist, but richer UI/query surfaces, transcript re-index scheduling, and
  cross-daemon recovery policies still need hardening.
- There are **initial built-in agent detection/resume heuristics**, but no external adapter-script
  runtime yet. Provider-specific native session discovery should still move into adapter scripts.
- There is **no search UI or daemon-side persistence privacy toggle yet**.

### Next recommended work

1. **Switch the VT backend to upstream libghostty-vt once toolchains align**: replace the CI-safe
   fallback/default C-ABI gate with the Zig-native upstream module when libghostty-vt supports Tao's
   Zig 0.16 build tooling, then build current-screen snapshot APIs on that stable wrapper.
2. **Harden/package the `taod` desktop path**: bundle the daemon in production builds and add
   lifecycle supervision, health checks, and explicit slow-client backpressure/drop policies.
3. **Expose SQLite/search metadata in the UI**: add visible search, session diagnostics, and
   user-facing command/agent resume status surfaces on top of the daemon metadata APIs.
4. **Harden daemon maintenance** with more cleanup tests, transcript re-index scheduling, and visible UX for
   daemon-side retention/clear-history results.
5. **Replace built-in agent heuristics with external adapters** so `pi`, `codex`, `claude`, and future
   agents can discover native ids and resume commands without recompiling `taod`.
6. **Add a persistence privacy toggle in the daemon path** so settings can disable or narrow terminal
   output/excerpt persistence before data is written.

---

## Restore Guarantees

Tao should make explicit, honest guarantees:

| Level                       | Scenario                                                                 | Restore behavior                                                                                            |
| --------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| **1. Live reattach**        | `taod` and the PTY process are still alive                               | Reattach to the same PTY and same AI CLI process. This is true full restore.                                |
| **2. Agent/command resume** | PTY/process died, but Tao captured a supported resume command/session ID | Spawn the adapter-specific resume command or saved terminal preset and attach to the new PTY.               |
| **3. Fresh shell fallback** | No live process and no known resume path                                 | Restore layout/cwd and start a fresh shell. Do not replay old shell scrollback as if it were live terminal. |

Tao cannot generally resurrect arbitrary dead Unix process memory. Full live-process restore requires
keeping the process alive in `taod`.

---

## Goals

| Goal                         | Why                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Live AI CLI reattach**     | Closing/restarting Tao UI must not kill long-running AI agent chats.                                      |
| **Command/app relaunch**     | If no live process exists, restart the saved command/preset instead of showing stale shell history.       |
| **Crash resilience**         | Event logs and metadata support diagnostics and agent/session-id extraction after failures.               |
| **Agent-aware cold resume**  | Capture native AI session IDs and relaunch supported agents after daemon/process death.                   |
| **Pane/session correctness** | Sessions attach to logical terminal/pane IDs, not just workspaces.                                        |
| **Efficient hot path**       | PTY output is bytes → log append → libghostty-vt parser → stream; no SQLite writes per chunk.             |
| **Searchable excerpts**      | Store bounded plaintext excerpts/FTS rows for search/debug without treating them as terminal restore.     |
| **Effect-TS services**       | DB/file/daemon services use Effect layers and typed errors across desktop/taod bridge.                    |
| **Security/privacy**         | Terminal logs can contain secrets; use restrictive permissions, retention controls, and clear-history UX. |

---

## Non-Goals / Boundaries

- Tao does **not** become the source of truth for proprietary agent memory. Agent CLIs own their own
  chat/session storage.
- Tao does **not** promise exact restoration of a dead process unless that process stayed alive in
  `taod`.
- Tao does **not** store shell input history as a separate feature. Shells still own shell history.
- Tao does not put PTY output chunks on the SQLite hot path.

---

## Architecture

```
[Renderer React]
    ├── Ghostty renderer
    └── UI layout/store
        ↓ IPC / MessagePort
[Electron main]
    ├── authorization
    ├── window lifecycle
    └── TaodClient (control RPC + binary stream)
        ↓ ~/.tao/run/taod.sock
[taod (Zig binary)]
    ├── SessionManager          owns logical terminal sessions
    ├── PtyDriver               owns PTY master fds and child processes
    ├── LibghosttyVt            Zig-native libghostty-vt parser/state (no WASM)
    ├── EventLog                append-only framed PTY log
    ├── SnapshotStore           libghostty-vt binary checkpoints (zstd)
    ├── AgentRegistry           spawns adapter scripts for pi/codex/claude
    ├── SqliteDb                session/agent metadata (zig-sqlite)
    └── Maintenance             retention, cleanup, integrity checks
```

Critical lifecycle rule:

> Pane unmount / window close detaches from a session. It does not kill the PTY by default.

Killing is explicit: `Kill Session`, `Stop Agent`, or retention cleanup after configured policy.

---

## Why Zig for `taod`

| Factor                 | Reason                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **libghostty-vt link** | `libghostty-vt` is Ghostty's embeddable VT core for parsing terminal sequences and maintaining terminal state. `taod` links it directly as a Zig library — no WASM, no JS ABI boundary. |
| **Self-contained**     | Single static binary. No Node runtime, no npm dependencies, no version conflicts with the Electron app.                                                                                 |
| **Performance**        | PTY hot path is memory-safe zero-copy: PTY read → event log append/metadata extraction → socket broadcast. All in one process, no GC pauses.                                            |
| **Optional VT state**  | A VT layer can later provide current-screen state for live reattach polish, but not cold scrollback replay.                                                                             |

Trade-off acknowledged:

- Agent adapter logic (pi/codex/claude detection, resume commands, environment setup) is more
  verbose in Zig than TypeScript. Solution: agent adapters live as **small separate scripts**
  (TypeScript/Node or shell) that taod spawns on demand. The core daemon stays Zig.

---

## Why `libghostty-vt`, not full `libghostty`

`taod` is headless. It needs Ghostty's virtual-terminal core, not a renderer or platform frontend.

If linked later, use `libghostty-vt` for:

- VT escape sequence parsing
- current screen, cursor, styles, colors, and modes
- resize/reflow
- render-state data for clients
- plain-text/formatter extraction for search
- input/key/mouse encoding where useful

Do **not** put Ghostty's GUI/platform layer in `taod`:

- no Metal/OpenGL rendering
- no font discovery/layout
- no platform windows/tabs/splits
- no renderer event loop

Tao owns daemon/session/process concerns around the VT core: PTY lifecycle, live reattach, event
logs, SQLite metadata, retention, and AI-agent resume orchestration.

Note: `libghostty-vt` is still API-in-flux upstream. Tao should wrap it behind `apps/daemon/src/vt.zig`
so upstream API churn is isolated to one file.

Current implementation note: Tao's wrapper is now present and fed by the daemon hot path. The default
backend is a small Zig fallback for CI, and `-Dvt-backend=libghostty_c` can link a system
`libghostty-vt` C ABI. The target remains a Zig-native upstream module once the libghostty-vt package
supports Tao's Zig 0.16 build toolchain without pulling incompatible package metadata into every CI
build.

---

## Directory Layout

```
~/.tao/
├── tao.db                         # SQLite metadata
├── settings.json                  # Human-editable user preferences
├── pane-layouts.json              # UI layout/workspaces/tabs/panes
├── run/
│   ├── taod.sock                  # Local daemon socket
│   └── taod.pid
├── sessions/
│   └── <session-id>/
│       ├── events.taoev           # Framed PTY event log, append-only
│       ├── current-screen.state   # Optional future live-reattach first-paint state
│       └── excerpt.txt            # Bounded plain text excerpt for search/debug
└── adapters/                      # Optional agent adapter scripts
    ├── pi.js
    ├── codex.js
    └── claude.js
```

Permissions:

- `~/.tao`: `0700`
- `~/.tao/run`: `0700`
- session files: `0600`

---

## Project Layout — New & Changed Files

```
tao/
├── packages/
│   └── shared/
│       └── src/
│           ├── session.ts                  NEW: session/agent schemas
│           ├── storage-path.ts             NEW: ~/.tao path resolution
│           └── taod-protocol.ts            NEW: daemon RPC/stream message schemas
│
├── apps/
│   ├── daemon/                               NEW: Zig daemon package
│   │   ├── build.zig
│   │   ├── build.zig.zon
│   │   ├── src/
│   │   │   ├── main.zig                    entrypoint, signal handling
│   │   │   ├── daemon.zig                  socket server, session registry
│   │   │   ├── rpc.zig                     JSON control RPC + binary stream frames
│   │   │   ├── session.zig                 terminal session state machine
│   │   │   ├── pty.zig                     PTY master via posix_openpt / fork
│   │   │   ├── vt.zig                      libghostty-vt wrapper / API isolation
│   │   │   ├── event_log.zig               framed binary log, append/read/seek
│   │   │   ├── snapshot.zig                zstd compress/decompress, file I/O
│   │   │   ├── db.zig                      SQLite schema, migrations, queries
│   │   │   ├── adapter.zig                 agent adapter process spawning
│   │   │   └── cleanup.zig                 retention, periodic maintenance
│   │   └── libghostty-vt/                  (git submodule or Zig dependency)
│   │       └── src/                        Ghostty virtual-terminal core
│   │
│   └── desktop/
│       ├── package.json                    MODIFY: add build:taod script
│       ├── patches/
│       │   └── libghostty-vt-current-screen.patch OPTIONAL: current-screen exports
│       └── src/
│           ├── main/
│           │   ├── index.ts                MODIFY: launch/connect taod, bridge IPC
│           │   ├── taod-client.ts          NEW: Unix socket control/stream client
│           │   ├── session-ipc.ts          NEW: session IPC handlers
│           │   ├── layout-store.ts         NEW: pane-layouts.json service
│           │   ├── settings-store.ts       NEW: settings.json service
│           │   └── pty-service.ts          REMOVE/REPLACE with taod bridge
│           ├── preload/
│           │   └── index.ts                MODIFY: expose session APIs
│           └── renderer/
│               ├── terminal.ts             MODIFY: attach/deserialize/live stream
│               ├── session.ts              NEW: renderer session manager
│               ├── state/store.ts          MODIFY: remove localStorage persist
│               └── storage.ts              REMOVE
```

---

## Optional libghostty-vt Integration

`libghostty-vt` is Ghostty's embeddable virtual-terminal core. It can handle VT parsing, current
screen state, resize/reflow, modes, styles, render state, input encoding, and formatting. This is now
an optional live-reattach polish layer, not the foundation of persistence. Tao should not use it to
replay old shell scrollback after a process is gone.

```zig
// apps/daemon/src/vt.zig
const vt = @import("libghostty_vt");

pub const Terminal = struct {
    inner: vt.Terminal,

    pub fn init(allocator: std.mem.Allocator, cols: u16, rows: u16) !Terminal {
        const inner = try vt.Terminal.init(allocator, .{
            .cols = cols,
            .rows = rows,
            .max_scrollback = 0,
        });
        return .{ .inner = inner };
    }

    pub fn write(self: *Terminal, bytes: []const u8) void {
        self.inner.vtWrite(bytes);
    }

    pub fn serializeCurrentScreen(self: *Terminal, allocator: std.mem.Allocator) ![]u8 {
        // Optional future: serialize the current screen for live reattach first paint.
        // This is not a cold shell scrollback restore format.
    }

    pub fn deserializeCurrentScreen(self: *Terminal, data: []const u8) !void {
        // Optional future: restore current screen state for a still-live session.
    }
};
```

The daemon still owns PTY lifecycle, session management, persistence, and agent orchestration. If a
VT layer is added, it should stay behind `apps/daemon/src/vt.zig` and serve live session rendering
metadata only.

### Current-screen snapshot extension (optional)

If implemented, the current-screen extension should live at the `libghostty-vt` boundary and serve two
builds:

1. **Native Zig** (`taod` binary) — direct `libghostty-vt` calls, no WASM overhead.
2. **WASM target** (`ghostty-web` / renderer build) — exports the same current-screen read/write
   functions through WASM.

```zig
// shared serialization logic, compiled for both targets
pub fn terminalSerializeCurrentScreen(term: *vt.Terminal, writer: anytype) !void { ... }
pub fn terminalDeserializeCurrentScreen(term: *vt.Terminal, reader: anytype) !void { ... }
```

The format must be stable, versioned, endian-defined, pointer-free, CRC-checked, and tagged with the
libghostty-vt version. It should contain current visible state only; historical scrollback remains
outside the live-reattach contract.

---

## SQLite

`taod` uses a Zig SQLite binding (either `zig-sqlite` package or direct `sqlite3.h` C ABI calls).
Schema uses STRICT tables, WAL, foreign keys.

### Migration 001 — `terminal_sessions`

```sql
CREATE TABLE terminal_sessions (
    id                 TEXT PRIMARY KEY,
    terminal_id        TEXT NOT NULL,
    workspace_id       TEXT,
    cwd                TEXT,
    argv_json          TEXT,
    status             TEXT NOT NULL CHECK(status IN (
        'live', 'detached', 'exited', 'crashed', 'archived', 'killed'
    )),
    daemon_id          TEXT,
    pid                INTEGER,
    cols               INTEGER NOT NULL,
    rows               INTEGER NOT NULL,
    title              TEXT,
    event_log_path     TEXT NOT NULL,
    last_seq           INTEGER NOT NULL DEFAULT 0,
    snapshot_path      TEXT,
    snapshot_seq       INTEGER NOT NULL DEFAULT 0,
    snapshot_crc32     INTEGER,
    snapshot_size      INTEGER,
    scrollback_excerpt TEXT,
    started_at         TEXT NOT NULL,
    last_activity_at   TEXT,
    ended_at           TEXT,
    exit_code          INTEGER,
    signal             INTEGER,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX idx_terminal_sessions_terminal ON terminal_sessions(terminal_id);
CREATE INDEX idx_terminal_sessions_workspace ON terminal_sessions(workspace_id);
CREATE INDEX idx_terminal_sessions_status ON terminal_sessions(status);
CREATE INDEX idx_terminal_sessions_activity ON terminal_sessions(last_activity_at);

CREATE TRIGGER update_terminal_sessions_updated_at
    AFTER UPDATE ON terminal_sessions
    BEGIN
        UPDATE terminal_sessions SET updated_at = datetime('now') WHERE id = NEW.id;
    END;
```

### Migration 002 — `agent_sessions`

```sql
CREATE TABLE agent_sessions (
    id                  TEXT PRIMARY KEY,
    terminal_session_id TEXT NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
    provider            TEXT NOT NULL,
    native_session_id   TEXT,
    original_argv_json  TEXT,
    resume_argv_json    TEXT,
    cwd                 TEXT,
    transcript_path     TEXT,
    model               TEXT,
    title               TEXT,
    status              TEXT NOT NULL CHECK(status IN (
        'detected', 'running', 'resumable', 'resumed', 'unknown', 'ended'
    )),
    last_activity_at    TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX idx_agent_sessions_terminal ON agent_sessions(terminal_session_id);
CREATE INDEX idx_agent_sessions_provider_native ON agent_sessions(provider, native_session_id);
CREATE INDEX idx_agent_sessions_status ON agent_sessions(status);

CREATE TRIGGER update_agent_sessions_updated_at
    AFTER UPDATE ON agent_sessions
    BEGIN
        UPDATE agent_sessions SET updated_at = datetime('now') WHERE id = NEW.id;
    END;
```

### Migration 003 — search index

```sql
CREATE VIRTUAL TABLE terminal_search USING fts5(
    terminal_session_id UNINDEXED,
    workspace_id UNINDEXED,
    title,
    excerpt,
    tokenize = 'unicode61'
);
```

---

## Event Log Format

Framed binary event log. Each session has one append-only file.

```
File header:
  magic       "TAOEV\0\1"    (8 bytes)
  session_id  uuid            (36 bytes)
  created_at  unix_ms         (u64, 8 bytes)

Repeated frames:
  magic       u32             (0x54414546 = "TAEF")
  version     u16             (1)
  kind        u16             (enum: 1=OUTPUT, 2=INPUT, 3=RESIZE, 4=TITLE, 5=CWD, 6=AGENT_EVENT, 7=SNAPSHOT_MARK, 8=EXIT)
  seq         u64             (monotonic per session)
  monotonic_ms  u64
  length      u32
  crc32       u32
  payload     u8[length]
```

Frame kinds:

| Kind            | Payload                                                  |
| --------------- | -------------------------------------------------------- |
| `OUTPUT`        | raw PTY bytes (use encoding:null)                        |
| `INPUT`         | optional user input bytes (default off, privacy setting) |
| `RESIZE`        | `{ cols: u16, rows: u16 }`                               |
| `TITLE`         | UTF-8 title string                                       |
| `CWD`           | UTF-8 cwd string                                         |
| `AGENT_EVENT`   | adapter-specific JSON                                    |
| `SNAPSHOT_MARK` | `{ snapshot_seq: u64, snapshot_path: str }`              |
| `EXIT`          | `{ exit_code: i32, signal: i32 }`                        |

Important rules:

- `seq` is monotonically increasing per terminal session.
- Event logs are not replayed into newly spawned shells. They are retained for diagnostics, bounded
  excerpts, and adapter/session-id extraction.
- SQLite stores metadata, not each frame. The frames live on disk.

---

## Daemon Protocol — control RPC + binary stream

Taod exposes local Unix domain sockets under `~/.tao/run/`. Use JSON/NDJSON only for low-volume
control messages. PTY output and client input/resize events use binary frames to avoid base64
overhead. Event-log catch-up is intentionally not part of attach semantics.

### Control messages (request/response)

```json
--> {"type":"create","id":"req-1","terminalId":"pane-xxx","cols":80,"rows":24,"cwd":"/home","argv":["/bin/bash"]}
<-- {"type":"create:ok","id":"req-1","sessionId":"ses-abc","pid":12345}

--> {"type":"attach","id":"req-2","sessionId":"ses-abc"}
<-- {"type":"attach:ok","id":"req-2","streamId":"stream-1","seq":421,"cwd":"/home/project"}

// Input bytes are sent on the binary stream as kind=INPUT frames.

--> {"type":"resize","sessionId":"ses-abc","cols":120,"rows":40}
<-- {"type":"resize:ok"}

--> {"type":"detach","sessionId":"ses-abc"}
<-- {"type":"detach:ok"}

--> {"type":"kill","sessionId":"ses-abc"}
<-- {"type":"kill:ok"}
```

### Binary stream messages

After `attach`, daemon and client exchange binary frames until `detach`:

```txt
frame_header { magic, version, kind, session_id, seq, length, crc32 }
payload[length]

kind=OUTPUT     payload = raw PTY bytes
kind=INPUT      payload = raw user input bytes (client → daemon)
kind=RESIZE     payload = packed cols/rows
kind=SNAPSHOT   payload = optional future current-screen snapshot bytes
kind=EXIT       payload = packed exit_code/signal
kind=AGENT      payload = compact JSON/msgpack agent status
```

Backpressure:

- Active pane receives live bytes.
- If the client falls behind, taod may drop/coalesce output for that client rather than attempting to
  replay a full historical scrollback.
- Background panes may receive coalesced output only.

---

## Agent Adapters

Agent adapters are **separate scripts** that taod spawns as child processes. The core daemon remains
Zig; adapters are TypeScript/Node (or whatever each agent's ecosystem prefers).

```zig
// adapter.zig — taod spawns adapters as child processes
pub const Adapter = struct {
    provider: []const u8,   // "pi", "codex", "claude", "unknown"

    /// Register a session as agent-driven.
    /// Spawns adapter script with env vars pointing to the session directory.
    pub fn detect(session: *Session, argv: []const []const u8) !?Adapter

    /// Ask the adapter to discover a native session ID.
    pub fn discoverNativeSessionId(adapter: *Adapter) !?[]const u8

    /// Get the resume command line for a known native session.
    pub fn resumeCommand(adapter: *Adapter, native_id: []const u8) ![]const []const u8
};
```

Adapter scripts live at `~/.tao/adapters/<provider>.js` (or `.ts` compiled to `.js` shared from the
shared package). Taod communicates with them via stdin/stdout NDJSON.

Example adapter interface:

```typescript
// ~/.tao/adapters/pi.js
import { readFileSync, writeFileSync } from 'fs'

// Called by taod with JSON on stdin
const msg = JSON.parse(process.argv[2] || '')

switch (msg.command) {
  case 'detect': {
    // Return whether argv matches this agent
    process.stdout.write(JSON.stringify({ detected: true }) + '\n')
    break
  }
  case 'discover-session': {
    // Scan terminal output / env / files for native session id
    const sessionDir = msg.sessionDir
    const match = readFileSync(`${sessionDir}/events.taoev`)
      .toString()
      .match(/pi-session-([a-f0-9]+)/)
    process.stdout.write(
      JSON.stringify({
        nativeSessionId: match?.[1] ?? null,
      }) + '\n',
    )
    break
  }
  case 'resume-command': {
    process.stdout.write(
      JSON.stringify({
        argv: ['pi', '--session', msg.nativeSessionId],
      }) + '\n',
    )
    break
  }
}
```

Cold resume flow:

```
Tao opens previous terminal
  ├─► ask taod for live session
  ├─► if live: attach same PTY
  ├─► else: read agent_sessions row
  ├─► if provider + native_session_id:
  │      spawn adapter.resumeCommand()
  │      attach new PTY
  └─► else: start a fresh shell or saved pane command without replaying old scrollback
```

---

## Source of Truth Decisions

| Data                            | Source of truth          | Notes                                                   |
| ------------------------------- | ------------------------ | ------------------------------------------------------- |
| Terminal session metadata       | SQLite                   | Written by taod.                                        |
| Agent resume metadata           | SQLite                   | Written by taod via adapter scripts.                    |
| Search excerpts                 | SQLite FTS               | Bounded text only.                                      |
| UI layout/workspaces/tabs/panes | `pane-layouts.json`      | Loaded before rendering app shell.                      |
| User settings                   | `settings.json`          | Human-editable.                                         |
| PTY output                      | `events.taoev` files     | Append-only diagnostics/excerpts; not terminal restore. |
| Terminal state                  | Live daemon PTY/VT state | Optional future current-screen snapshots only.          |

---

## taod Build & Launch

### Build

```zig
// apps/daemon/build.zig
const std = @import("std");

pub fn build(b: *std.Build) void {
    const exe = b.addExecutable(.{
        .name = "taod",
        .root_source_file = b.path("src/main.zig"),
        .target = b.standardTargetOptions(.{}),
        .optimize = .ReleaseSafe,
    });

    // Link libghostty-vt as a Zig dependency
    const libghostty_vt = b.dependency("libghostty_vt", .{});
    exe.root_module.addImport("libghostty_vt", libghostty_vt.module("vt"));

    // Link sqlite3
    exe.linkSystemLibrary("sqlite3");

    // Optional future: build current-screen exports for live reattach first paint.
    const wasm_step = b.addObject(.{
        .name = "libghostty-vt-current-screen",
        .root_source_file = b.path("src/serialize.zig"),
        .target = .{ .cpu_arch = .wasm32, .os_tag = .wasi },
        .optimize = .ReleaseSmall,
    });

    b.installArtifact(exe);
    b.installArtifact(wasm_step);
}
```

### Integrated into desktop build

```json
// apps/desktop/package.json
{
  "scripts": {
    "build:taod": "cd ../taod && zig build",
    "dev": "pnpm build:taod && electron-vite dev",
    "build": "pnpm build:taod && electron-vite build"
  }
}
```

### Launch from Electron main

```typescript
async function ensureTaodRunning() {
  if (await canConnectToTaod()) return

  const taodPath = join(app.getAppPath(), '..', 'taod', 'zig-out', 'bin', 'taod')
  spawn(taodPath, [], {
    detached: true,
    stdio: 'ignore',
  }).unref()
}
```

---

## UI Layout JSON

`pane-layouts.json` stores workspace/tab/pane layout. Must be read before rendering app shell.

```json
{
  "version": 2,
  "workspaces": [{ "id": "tao:local", "name": "Local", "projectPath": null, "order": 0 }],
  "activeWorkspaceId": "tao:local",
  "tabs": [
    {
      "id": "tab-xxx",
      "workspaceId": "tao:local",
      "name": "Terminal",
      "layout": "pane-yyy",
      "order": 0
    }
  ],
  "panes": [
    {
      "id": "pane-yyy",
      "terminalId": "term-yyy",
      "tabId": "tab-xxx",
      "type": "terminal",
      "name": "Terminal 1",
      "cwd": null,
      "status": "idle",
      "lastSessionId": "session-abc"
    }
  ],
  "activeTabId": "tab-xxx",
  "activePaneId": "pane-yyy",
  "sidebarExpanded": true,
  "sidebarWidth": 240
}
```

One-time migration from existing `localStorage['tao-workspaces']` on first launch.

---

## Session Lifecycle

### Create

```
User creates pane/tab or starts AI agent
  ├─► Renderer → Main → taod: create(terminalId, cols, rows, cwd, argv?)
  ├─► taod: INSERT terminal_sessions (status='live')
  ├─► taod: create session dir, init event log
  ├─► taod: posix_openpt() → fork/exec shell or agent CLI
  └─► Renderer: attach → receive live stream
```

### Detach

```
Pane hidden / window closed / renderer reloads
  ├─► Renderer unsubscribes
  ├─► Main sends detach to taod
  └─► taod keeps PTY + event log running
```

### Kill

```
User explicitly kills session
  ├─► taod sends SIGTERM to PTY child (then SIGKILL after grace)
  ├─► writes EXIT frame to event log
  ├─► updates terminal_sessions status/ended_at
  └─► keeps metadata/log until retention cleanup or clear-history
```

### Optional current-screen snapshot

Future work may add compact current-screen snapshots to make live reattach first paint nicer. These
snapshots must not be used to fake a dead shell/app restore; if the process is gone, Tao should run a
native resume command or start fresh.

### Reattach

```
Tao UI starts
  ├─► load pane-layouts.json before rendering terminals
  ├─► connect to taod socket
  ├─► for each visible pane: attach(lastSessionId | terminalId)
  ├─► if live: attach to the existing PTY/process
  ├─► if not live but resumable: spawn resume command via adapter
  └─► else: restore layout/cwd and start a fresh shell or saved pane command
```

---

## IPC Surface (Renderer → Electron Main)

Renderer sees session primitives, not raw PTY operations.

```typescript
interface ElectronAPI {
  createSession(input: CreateSessionInput): Promise<CreateSessionResult>
  attachSession(input: AttachSessionInput): Promise<AttachSessionResult>
  detachSession(sessionId: string): Promise<void>
  writeSessionInput(sessionId: string, data: Uint8Array): void
  resizeSession(sessionId: string, cols: number, rows: number): void
  killSession(sessionId: string): Promise<void>
  resumeAgent(agentSessionId: string): Promise<CreateSessionResult>

  onSessionOutput(sessionId: string, callback: (frame: OutputFrame) => void): () => void
  onSessionResize(sessionId: string, callback: (cols: number, rows: number) => void): () => void
  onSessionExit(sessionId: string, callback: (info: ExitInfo) => void): () => void
  onAgentStatus(sessionId: string, callback: (status: AgentStatus) => void): () => void

  readLayout(): Promise<PaneLayoutData | null>
  writeLayout(data: PaneLayoutData): Promise<void>
  readSettings(): Promise<SettingsData | null>
  writeSettings(data: SettingsData): Promise<void>
}
```

---

## Search

Bounded plaintext excerpts can be extracted from logs or future VT state and stored in SQLite FTS5.
Search results are references/debug context, not terminal scrollback restoration.

```sql
SELECT terminal_session_id, title, snippet(terminal_search, 3, '[', ']', '…', 12)
FROM terminal_search
WHERE terminal_search MATCH 'error'
ORDER BY rank
LIMIT 20;
```

---

## Session Cleanup / Retention

Configurable maintenance runs in taod:

- delete exited/killed diagnostic logs older than retention period (default 30 days).
- cap total `~/.tao/sessions` size (default 2 GB).
- keep `status = 'live'` or `'detached'` sessions regardless of age.
- explicit "Clear History" per session / per workspace / all.

---

## Edge Cases

| Scenario                         | Handling                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| **Renderer crash/reload**        | Reconnect to taod; live PTY never dies.                                                  |
| **Electron app quit**            | Default detach; taod keeps sessions alive.                                               |
| **Daemon crash**                 | Live processes are gone. Use native agent/command resume if available, else start fresh. |
| **Machine reboot**               | No live PTY process. Use agent/command resume if available, else start fresh.            |
| **Snapshot corrupted**           | Ignore the snapshot; do not replay event logs into a fake live terminal.                 |
| **Event log tail huge**          | Retention/clear-history handles disk use; attach does not replay the tail.               |
| **Resize while detached**        | Store latest size metadata and apply it to live/fresh sessions.                          |
| **Multiple panes per workspace** | Sessions keyed by terminal_id/lastSessionId, not workspace.                              |
| **Secrets in terminal output**   | User can disable persistence, reduce retention, clear history, or chmod session files.   |

---

## Dependencies

### Zig (apps/daemon)

- `libghostty-vt` Zig package or C API from Ghostty (git submodule, Zig dependency, or system
  library during the transition).
- `zig-sqlite` or direct `sqlite3.h` C ABI.
- `zstd` via Zig package or system library.
- No Node/npm dependencies in the daemon itself.

### TypeScript (apps/desktop, packages/shared)

- `@effect/sql` (schema validation for desktop-side reads, optional).
- `uuid` (session ID generation in renderer).
- Agent adapter scripts may use Node built-ins only (no heavy deps).

### Maintainers only

```bash
nix develop
zig version  # 0.16.0
zls --version
pnpm zig:check
```

---

## Implementation Order

| Phase  | Status                          | What                                                                                                                                                                                                                                                                                                                                                                                  | Est. time |
| ------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| **A**  | **Done**                        | Electron-side bootstrap slice: `pane-layouts.json`, `settings.json`, localStorage migration, stable pane/session IDs, PTY event-log prototype, Electron install repair                                                                                                                                                                                                                | Done      |
| **B**  | **Done**                        | Harden current event-log implementation with tests, corruption handling, retention controls, explicit session IPC wrappers, first-paint/render stability fixes, and current-file-store clear-history controls. Cold scrollback replay/archive restore has since been removed from the app path.                                                                                       | Done      |
| **0**  | Partial                         | Set up `apps/daemon` Zig project with `build.zig`, pnpm workspace scripts, Nix/ZLS/CI tooling, and module skeletons. The direct upstream Zig dependency on `libghostty-vt` is still pending toolchain alignment; the daemon has a gated system-library C-ABI path meanwhile.                                                                                                             | Partial   |
| **1**  | Substantial daemon slice done   | Write core daemon: Unix socket server, JSON control RPC, binary stream, session manager. The socket server, JSON control RPC, in-memory session registry, binary stream frame codec, socket-level attach loop, live PTY streaming, daemon-owned PTY reader threads, and bounded live pending-output buffers are implemented. Electron can now use it through the transitional bridge. | 2 weeks   |
| **2**  | Done for POSIX prototype        | Write PTY driver. `pty.zig` now uses `forkpty`/`execvp`, resize, input writes, output reads, termination, and exit polling.                                                                                                                                                                                                                                                           | Done      |
| **3**  | Initial integration done        | `vt.zig` now isolates the VT backend, session objects own VT state, daemon output/resize paths feed that state, and smoke tests cover the wrapper/current-screen boundary. The default backend remains a CI-safe Zig fallback; `-Dvt-backend=libghostty_c` links a system `libghostty-vt` C ABI until the upstream Zig module supports Tao's Zig 0.16 toolchain.                  | Initial   |
| **4**  | Re-scoped                       | Optional current-screen snapshot extension for nicer live reattach first paint. Do not use snapshots/event-log tails as cold shell scrollback restore.                                                                                                                                                                                                                                | TBD       |
| **5**  | Partial daemon ownership        | Move framed event log from Electron utility process into `taod`; add append/read/seek/crc tests. The daemon now creates session logs and appends output/resize/exit frames; the Electron utility logging path remains as a migration fallback until the daemon path is fully hardened.                                                                                                | 1 week    |
| **6**  | Substantial metadata slice done | Write SQLite layer (zig-sqlite or direct C ABI, migrations, query functions). `taod` now opens SQLite through the C ABI, runs migrations, mirrors terminal session lifecycle metadata, records initial agent-session resume rows, indexes bounded search excerpts, and uses restart lookup queries for cold command/agent relaunch. Richer query UI and re-index scheduling remain.   | 1 week    |
| **7**  | Initial bridge done             | Integrate daemon with Electron main (launch, socket client, IPC bridge). A transitional `TaodClient`/MessagePort bridge now launches or connects to `taod`, maps the existing renderer PTY protocol to control RPC + binary stream frames, and keeps the utility-process PTY service as a fallback. Packaging/lifecycle hardening remains.                                            | 1 week    |
| **8**  | Not started                     | Renderer attach to live stream and native command/agent resume results; remove old pty-service path once daemon lifecycle is hardened.                                                                                                                                                                                                                                                | 1 week    |
| **9**  | Initial heuristics done         | Add agent adapter spawning + pi/codex/claude adapter scripts. Built-in argv/session-id heuristics now seed `agent_sessions` and resume argv metadata; external adapter process spawning remains.                                                                                                                                                                                      | 1-2 weeks |
| **10** | **Done for Electron slice**     | Add pane-layouts.json / settings.json services; migrate localStorage. Revisit once `taod` exists.                                                                                                                                                                                                                                                                                     | Done      |
| **11** | Partial                         | Search excerpts / FTS and daemon cleanup/retention. Daemon-side clear-history and retention RPCs now reset live logs, delete inactive session directories, clear stale search rows, prune metadata for missing logs, and index bounded excerpts on exit. Search UI and scheduled background re-indexing remain.                                                                       | 1 week    |
| **12** | Not started                     | Stress testing: crash, restart, daemon fail, large logs, agent resume                                                                                                                                                                                                                                                                                                                 | 1-2 weeks |

**Total**: dominated by robust daemon lifecycle, packaging, and agent/command resume metadata. The
old libghostty-vt scrollback/snapshot cold-restore work is no longer the critical path.

---

## Target Summary

The target persistence architecture remains:

```
┌──────────────────────────────┐
│ Tao Renderer / React         │
│ Ghostty renderer (WASM)      │
│ Zustand (layout only)        │
└──────────┬───────────────────┘
           │ IPC (MessagePort)
┌──────────▼───────────────────┐
│ Electron main process        │
│ TaodClient (TypeScript)      │
└──────────┬───────────────────┘
           │ Unix socket (control RPC + binary stream)
┌──────────▼───────────────────┐
│ taod (Zig binary)            │
│                              │
│ PTY driver                   │
│ optional VT current-screen   │ ← future first-paint optimization only
│ Event log                    │
│ SQLite metadata              │
│ Agent adapter processes      │ ← spawns small scripts
└──────────────────────────────┘
```

- `taod` is a single static Zig binary. No Node, no npm, no WASM runtime for terminal parsing.
- Current-screen snapshot serialization may be added later for live reattach polish, but Tao does
  not cold-restore old shell scrollback into new processes.
- Agent adapters are lightweight scripts spawned by `taod` — the only part that stays in
  TypeScript/Node.
- The Electron UI is a thin client that attaches/detaches from sessions. The daemon owns the
  persistence and process lifecycle.
