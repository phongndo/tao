# Persistence Plan

**Status**: Planning  
**Last updated**: 2026-05-16

## Overview

Tao's persistence goal is broader than restoring a terminal viewport. Tao is a terminal for
orchestrating AI agents through CLIs such as `pi`, `codex`, `claude`, and similar tools. Persistence
therefore needs to preserve three things:

1. **Live process continuity** — if an AI CLI is still running, Tao should reattach to the same PTY
   and conversation after the UI restarts.
2. **Instant visual restore** — the terminal should redraw from a compact libghostty-vt snapshot
   instead of replaying a large log.
3. **Cold semantic resume** — if the live process is gone, Tao should relaunch supported AI CLIs via
   their native resume/session mechanisms and show the previous terminal context immediately.

The architecture is a hybrid:

- **`taod` daemon** (Zig) owns PTYs, AI CLI subprocesses, terminal event logs, snapshots, and agent
  adapters. The Electron UI is a client that attaches/detaches.
- **libghostty-vt binary snapshots** provide fast visual restore and bounded catch-up. The daemon
  builds on **`libghostty-vt`**, Ghostty's embeddable virtual-terminal core, as a Zig library — no
  WASM overhead in the daemon.
- **Framed PTY event logs** provide crash recovery and precise replay, including resize events.
- **Agent adapters/hooks** capture native AI CLI session IDs and resume commands.
- **SQLite** stores session metadata, snapshot metadata, agent session metadata, and searchable
  excerpts.
- **JSON files** remain the source of truth for human-editable settings and UI layout.

This replaces the current Zustand `persist` + browser `localStorage` model.

---

## Restore Guarantees

Tao should make explicit, honest guarantees:

| Level | Scenario | Restore behavior |
|---|---|---|
| **1. Live reattach** | `taod` and the PTY process are still alive | Reattach to the same PTY and same AI CLI process. This is true full restore. |
| **2. Agent resume** | PTY/process died, but Tao captured a supported AI CLI native session ID | Restore terminal snapshot immediately, spawn the adapter-specific resume command, attach to the new PTY. |
| **3. Visual archive** | No live process and no known resume path | Restore terminal snapshot/transcript as an archived terminal view; user can start a fresh shell. |

Tao cannot generally resurrect arbitrary dead Unix process memory. Full live-process restore requires
keeping the process alive in `taod`.

---

## Goals

| Goal | Why |
|---|---|
| **Live AI CLI reattach** | Closing/restarting Tao UI must not kill long-running AI agent chats. |
| **Instant visual restore** | Deserialize a libghostty-vt checkpoint, then replay only the small event-log tail. |
| **Crash resilience** | Event logs allow recovery if the latest snapshot is missing/corrupted. |
| **Agent-aware cold resume** | Capture native AI session IDs and relaunch supported agents after daemon/process death. |
| **Pane/session correctness** | Sessions attach to logical terminal/pane IDs, not just workspaces. |
| **Efficient hot path** | PTY output is bytes → log append → libghostty-vt parser → stream; no SQLite writes per chunk. |
| **Searchable history** | Store bounded plaintext excerpts/FTS rows for search without indexing huge binary logs. |
| **Effect-TS services** | DB/file/daemon services use Effect layers and typed errors across desktop/taod bridge. |
| **Security/privacy** | Terminal logs can contain secrets; use restrictive permissions, retention controls, and clear-history UX. |

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

| Factor | Reason |
|---|---|
| **libghostty-vt link** | `libghostty-vt` is Ghostty's embeddable VT core for parsing terminal sequences and maintaining terminal state. `taod` links it directly as a Zig library — no WASM, no JS ABI boundary. |
| **Self-contained** | Single static binary. No Node runtime, no npm dependencies, no version conflicts with the Electron app. |
| **Performance** | PTY hot path is memory-safe zero-copy: PTY read → libghostty-vt parser → event log append → socket broadcast. All in one process, no GC pauses. |
| **Same snapshot format, two runtimes** | The serialization extension lives at the `libghostty-vt` layer and emits a stable snapshot format consumed by both native `taod` and the renderer's Ghostty WASM build. |

Trade-off acknowledged:

- Agent adapter logic (pi/codex/claude detection, resume commands, environment setup) is more
  verbose in Zig than TypeScript. Solution: agent adapters live as **small separate scripts**
  (TypeScript/Node or shell) that taod spawns on demand. The core daemon stays Zig.

---

## Why `libghostty-vt`, not full `libghostty`

`taod` is headless. It needs Ghostty's virtual-terminal core, not a renderer or platform frontend.

Use `libghostty-vt` for:

- VT escape sequence parsing
- screen, scrollback, cursor, styles, colors, and modes
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
logs, snapshots, SQLite metadata, retention, and AI-agent resume orchestration.

Note: `libghostty-vt` is still API-in-flux upstream. Tao should wrap it behind `apps/taod/src/vt.zig`
so upstream API churn is isolated to one file.

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
│       ├── snapshot.state.zst     # Latest compressed libghostty-vt checkpoint
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
│   ├── taod/                               NEW: Zig daemon package
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
│       │   └── libghostty-vt-snapshot.patch NEW: snapshot exports for WASM build
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

## libghostty-vt Integration (the key insight)

`libghostty-vt` is Ghostty's embeddable virtual-terminal core. It handles VT parsing,
terminal state, scrollback, resize/reflow, modes, styles, render state, input encoding, and
formatting. `taod` imports this layer as a Zig dependency instead of using Ghostty's app/frontend
code:

```zig
// apps/taod/src/vt.zig
const vt = @import("libghostty_vt");

pub const Terminal = struct {
    inner: vt.Terminal,

    pub fn init(allocator: std.mem.Allocator, cols: u16, rows: u16) !Terminal {
        const inner = try vt.Terminal.init(allocator, .{
            .cols = cols,
            .rows = rows,
            .max_scrollback = 10_000,
        });
        return .{ .inner = inner };
    }

    pub fn write(self: *Terminal, bytes: []const u8) void {
        self.inner.vtWrite(bytes);
    }

    pub fn serialize(self: *Terminal, allocator: std.mem.Allocator) ![]u8 {
        // Calls Tao's libghostty-vt snapshot extension.
        // Produces a stable, pointer-free, versioned binary snapshot.
        // Compression is applied by SnapshotStore, not by the terminal core.
    }

    pub fn deserialize(self: *Terminal, data: []const u8) !void {
        // Restore terminal state from snapshot.
    }
};
```

This is the single most important performance advantage: the daemon never goes through WASM JS glue
for terminal parsing. It calls `libghostty-vt` directly. The daemon still owns PTY lifecycle,
session management, persistence, and agent orchestration; `libghostty-vt` owns terminal emulation.

### The snapshot extension

The snapshot extension should live at the `libghostty-vt` boundary and serve two builds:

1. **Native Zig** (`taod` binary) — direct `libghostty-vt` calls, no WASM overhead.
2. **WASM target** (`ghostty-web` / renderer build) — exports the same snapshot read/write
   functions through WASM.

```zig
// shared serialization logic, compiled for both targets
pub fn terminalSerialize(term: *vt.Terminal, writer: anytype) !void { ... }
pub fn terminalDeserialize(term: *vt.Terminal, reader: anytype) !void { ... }
```

If upstream `libghostty-vt` does not expose snapshot APIs, Tao maintains a small extension and
upstreams it if possible. The patch file in `apps/desktop/patches/libghostty-vt-snapshot.patch`
patches the renderer/WASM build to export the same snapshot functions. The format must be stable,
versioned, endian-defined, pointer-free, CRC-checked, and tagged with the libghostty-vt version.

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

| Kind | Payload |
|---|---|
| `OUTPUT` | raw PTY bytes (use encoding:null) |
| `INPUT` | optional user input bytes (default off, privacy setting) |
| `RESIZE` | `{ cols: u16, rows: u16 }` |
| `TITLE` | UTF-8 title string |
| `CWD` | UTF-8 cwd string |
| `AGENT_EVENT` | adapter-specific JSON |
| `SNAPSHOT_MARK` | `{ snapshot_seq: u64, snapshot_path: str }` |
| `EXIT` | `{ exit_code: i32, signal: i32 }` |

Important rules:

- `seq` is monotonically increasing per terminal session.
- Each snapshot records the `seq` up to which state is fully captured.
- Reopen flow: `deserialize(snapshot)` → replay frames after `snapshot_seq`.
- SQLite stores metadata, not each frame. The frames live on disk.

---

## Daemon Protocol — control RPC + binary stream

Taod exposes local Unix domain sockets under `~/.tao/run/`. Use JSON/NDJSON only for low-volume
control messages. PTY output, snapshots, and event-log catch-up use binary frames to avoid base64
overhead.

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
kind=SNAPSHOT   payload = compressed snapshot bytes
kind=EXIT       payload = packed exit_code/signal
kind=AGENT      payload = compact JSON/msgpack agent status
```

Backpressure:

- Active pane receives live bytes.
- If the client falls behind, taod sends a fresh snapshot and discards the backlog for that client.
- Background panes may receive coalesced output or periodic snapshot refreshes only.

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
      .toString().match(/pi-session-([a-f0-9]+)/)
    process.stdout.write(JSON.stringify({
      nativeSessionId: match?.[1] ?? null
    }) + '\n')
    break
  }
  case 'resume-command': {
    process.stdout.write(JSON.stringify({
      argv: ['pi', '--session', msg.nativeSessionId]
    }) + '\n')
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
  └─► else: show archived snapshot/transcript
```

---

## Source of Truth Decisions

| Data | Source of truth | Notes |
|---|---|---|
| Terminal session metadata | SQLite | Written by taod. |
| Agent resume metadata | SQLite | Written by taod via adapter scripts. |
| Search excerpts | SQLite FTS | Bounded text only. |
| UI layout/workspaces/tabs/panes | `pane-layouts.json` | Loaded before rendering app shell. |
| User settings | `settings.json` | Human-editable. |
| PTY output | `events.taoev` files | Append-only binary logs. |
| Terminal state | `snapshot.state.zst` files | Compressed libghostty-vt snapshots. |

---

## taod Build & Launch

### Build

```zig
// apps/taod/build.zig
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

    // Build snapshot exports for the renderer/WASM build
    const wasm_step = b.addObject(.{
        .name = "libghostty-vt-snapshot",
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
  "workspaces": [
    { "id": "tao:local", "name": "Local", "projectPath": null, "order": 0 }
  ],
  "activeWorkspaceId": "tao:local",
  "tabs": [
    { "id": "tab-xxx", "workspaceId": "tao:local", "name": "Terminal", "layout": "pane-yyy", "order": 0 }
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
  ├─► taod: start libghostty-vt terminal state for this session
  └─► Renderer: attach → receive snapshot + live stream
```

### Detach

```
Pane hidden / window closed / renderer reloads
  ├─► Renderer unsubscribes
  ├─► Main sends detach to taod
  └─► taod keeps PTY + libghostty-vt state + event log running
```

### Kill

```
User explicitly kills session
  ├─► taod sends SIGTERM to PTY child (then SIGKILL after grace)
  ├─► writes EXIT frame to event log
  ├─► updates terminal_sessions status/ended_at
  └─► keeps snapshot/log until retention cleanup or clear-history
```

### Snapshot

```
Timer (30s) / output threshold (1MB) / before shutdown
  ├─► libghostty-vt snapshot extension serialize()
  ├─► zstd compress
  ├─► atomic write snapshot.state.zst.tmp → snapshot.state.zst
  ├─► update snapshot_seq/crc/size in DB
  └─► write SNAPSHOT_MARK frame to event log
```

### Reattach

```
Tao UI starts
  ├─► load pane-layouts.json before rendering terminals
  ├─► connect to taod socket
  ├─► for each visible pane: attach(lastSessionId | terminalId)
  ├─► if live: receive snapshot + live stream
  ├─► if not live but resumable: show snapshot, spawn resume command via adapter
  └─► if archived: show visual archive
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

Bounded plaintext excerpts extracted periodically through libghostty-vt formatter/grid APIs and stored in SQLite FTS5.

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

- delete archived/exited sessions older than retention period (default 30 days).
- cap total `~/.tao/sessions` size (default 2 GB).
- keep `status = 'live'` or `'detached'` sessions regardless of age.
- explicit "Clear History" per session / per workspace / all.

---

## Edge Cases

| Scenario | Handling |
|---|---|
| **Renderer crash/reload** | Reconnect to taod; live PTY never dies. |
| **Electron app quit** | Default detach; taod keeps sessions alive. |
| **Daemon crash** | Load latest snapshot + event tail. If agent resumable, spawn resume command via adapter. |
| **Machine reboot** | No live PTY process. Use agent resume if available, else archive restore. |
| **Snapshot corrupted** | CRC/version failure → load prior snapshot if available, else replay event log from start. |
| **Event log tail huge** | Periodic snapshots bound replay. If renderer lags, taod sends fresh snapshot. |
| **Resize during replay** | Event log includes RESIZE frames with seq; replay at correct dimensions. |
| **Multiple panes per workspace** | Sessions keyed by terminal_id/lastSessionId, not workspace. |
| **Secrets in terminal output** | User can disable persistence, reduce retention, clear history, or chmod session files. |

---

## Dependencies

### Zig (apps/taod)

- `libghostty-vt` Zig package or C API from Ghostty (git submodule or Zig dependency).
- `zig-sqlite` or direct `sqlite3.h` C ABI.
- `zstd` via Zig package or system library.
- No Node/npm dependencies in the daemon itself.

### TypeScript (apps/desktop, packages/shared)

- `@effect/sql` (schema validation for desktop-side reads, optional).
- `uuid` (session ID generation in renderer).
- Agent adapter scripts may use Node built-ins only (no heavy deps).

### Maintainers only

```bash
brew install zig
zig version  # 0.15.2+
```

---

## Implementation Order

| Phase | What | Est. time |
|---|---|---|
| **0** | Set up `apps/taod` Zig project with `build.zig`, dependency on `libghostty-vt` | 1 week |
| **1** | Write core daemon: Unix socket server, JSON control RPC, binary stream, session manager | 2 weeks |
| **2** | Write PTY driver (posix_openpt, fork/exec, raw byte read/write) | 1 week |
| **3** | Link `libghostty-vt`; write `vt.zig` wrapper and smoke tests | 1-2 weeks |
| **4** | Add `libghostty-vt` snapshot extension (native + WASM exports) | 2-3 weeks |
| **5** | Write event log (framed binary, append/read/seek/crc) | 1 week |
| **6** | Write SQLite layer (zig-sqlite, migrations, query functions) | 1 week |
| **7** | Integrate daemon with Electron main (launch, socket client, IPC bridge) | 1 week |
| **8** | Renderer attach from snapshot + live stream; remove old pty-service path | 1 week |
| **9** | Add agent adapter spawning + pi/codex/claude adapter scripts | 1-2 weeks |
| **10** | Add pane-layouts.json / settings.json services; migrate localStorage | 3-4 days |
| **11** | Search excerpts / FTS, cleanup/retention, clear-history UX | 1 week |
| **12** | Stress testing: crash, restart, daemon fail, large logs, agent resume | 1-2 weeks |

**Total**: roughly 10-14 weeks, dominated by the libghostty-vt snapshot extension and robust daemon
lifecycle.

---

## Revised Summary

The persistence architecture is now:

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
│ libghostty-vt terminal core  │ ← direct Zig link, no WASM
│ Event log                    │
│ Snapshot store (zstd)        │
│ SQLite metadata              │
│ Agent adapter processes      │ ← spawns small scripts
└──────────────────────────────┘
```

- `taod` is a single static Zig binary. No Node, no npm, no WASM runtime for terminal parsing.
- Snapshot serialization lives at the `libghostty-vt` layer and is shared by native daemon and WASM renderer builds.
- Agent adapters are lightweight scripts spawned by `taod` — the only part that stays in
  TypeScript/Node.
- The Electron UI is a thin client that attaches/detaches from sessions. The daemon owns the
  persistence and process lifecycle.
