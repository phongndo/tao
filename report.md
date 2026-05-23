# Tao Code Review Report: Electron + Effect 4 Beta + Zig Daemon

## Summary

Tao is a desktop systems app with a real daemon boundary, not a thin Electron shell. Electron main owns app/window lifecycle, preload owns a typed bridge and MessagePort handoff, the renderer owns xterm presentation, and `taod` owns PTY/session/persistence/worktree state. The best parts of the code already point in the right direction: `taod` has owner-only socket storage, peer UID checks, bounded control payloads, explicit session invariants, and leak-tested Zig code.

The biggest problems are at the boundaries. Protocol truth is split across TS schemas/manual normalization and Zig structs/string aliases. Workspace/Git command execution has now mostly moved behind `taod`, but Electron main still owns Git metadata watching and UI refresh policy. The hot terminal path has batching and diagnostics across socket, main MessagePort, preload, and xterm, but there is still no end-to-end backpressure contract from xterm back to MessagePort/socket/PTY. Detached daemon behavior is intentional; lifecycle diagnostics now expose state, daemon ownership, a typed recovery action, a renderer diagnostics popover, and narrow guided recovery actions for safe start/retry/restart paths. External incompatible daemons are reported but not killed automatically. Performance has benchmarks, and startup/renderer/reload/IPC/daemon-input/attach-replay/packaged-taod/input-echo/input-priority/workspace-metadata/file-tree-renderer/combined-renderer/direct-soak/app-soak smoke budgets now exist, plus passing 50k-file and 250k-file workspace metadata budgets, a paced one-hour packaged app-soak baseline, repeatable packaged trace analysis, and a weekly/manual long-performance workflow. The remaining performance work is responding to measured regressions and tightening budgets once the scheduled profile has enough history.

Current implementation note: this file started as the review-only report. Follow-up implementation work has now modified source files to address the first quick wins from this report.

## Implementation Progress

Completed in the first implementation pass:

- Fixed the `pnpm check` formatting failure in `packages/shared/src/workspace.ts`.
- Added shared control protocol constants in `packages/shared/src/taod-protocol.ts`.
- Added `taod` ping protocol identity: `protocol_version`, `daemon_version`, and `capabilities`.
- Added desktop-side ping compatibility validation in `TaodClient` so stale/incompatible detached daemons are rejected instead of treated as healthy.
- Added control socket write backpressure handling with drain/timeout behavior before reading responses.
- Added stream socket write backpressure detection in `TaodSessionStream.writeFrame`.
- Hardened `TAOD_ADAPTER_RUNNER` so env overrides must resolve to `node` or `tsx` by basename.
- Added shared input schemas for workspace/worktree daemon IPC mutations and wired them through preload and main.
- Removed manual `''` fallback coercion for invalid workspace/worktree IDs in Electron main.
- Changed the Windows production-build CI job into an explicit unsupported-platform guard so CI does not publish an artifact without `taod`.
- Added preload terminal diagnostics for pending MessagePort/client/output buffers.
- Added xterm output writer diagnostics for queued chars/chunks and active writes.
- Added terminal output writer diagnostics coverage to the desktop persistence test command.
- Added initial shared protocol golden fixtures for ping control responses and binary output stream frames.
- Wired both TS and Zig protocol tests to consume the shared stream-frame fixture; Zig also checks the shared ping fixture.
- Expanded shared protocol fixtures to cover attach responses, error responses, resize frames, exit frames, snapshot frames, and corrupt CRC rejection.
- Wired TS and Zig protocol tests to the expanded fixture matrix.
- Added Zig coverage for ping protocol identity.
- Added Zig coverage for adapter runner allowlist behavior.
- Added a packaged-output smoke check for `taod` and adapters.
- Extended the package smoke to launch the packaged Electron entrypoint, create a session through the real preload API, observe terminal output, and kill the smoke session.
- Added a packaged Electron terminal-throughput smoke budget: the smoke session now requires at least 16 KiB of terminal output, at least 4 KiB/s throughput, and no pending preload client messages before passing.
- Added owned smoke-daemon teardown for `TAO_ELECTRON_SMOKE=1` so smoke runs do not leave temp-home `taod` processes behind.
- Added an enforcing xterm/WebGL sustained-output benchmark budget via `pnpm bench:terminal:budget`.
- Removed recursive `lsof +D` from the Electron main workspace ports path; port discovery first scanned listening TCP processes once and checked only bounded listener PIDs' cwd paths, and now that bounded port metadata path runs in `taod`.
- Added a renderer guard for large full-pane diffs: patches with at least 20 files or 1 MiB now render collapsed file bodies by default so the first paint is file headers instead of every `FileDiff` body.
- Deferred renderer diff parsing inputs with React `useDeferredValue` so patch parsing is scheduled below higher-priority terminal/input updates.
- Moved patch parsing into a renderer module worker via `diff-parser.worker.ts`; `App.tsx` now consumes async parsed diff results instead of calling `@pierre/diffs` directly on the renderer thread.
- Added a large-diff mounted-body cap: when a full-pane diff crosses 20 files or 1 MiB, expand/focus/toggle keeps at most 12 `FileDiff` bodies mounted.
- Wired the packaged-output smoke check into the macOS production-build CI job.
- Added a macOS CI `performance-smoke` job that runs `pnpm bench:terminal:budget` with generous thresholds and uploads the terminal budget log as an artifact.
- Added explicit `TaodClient` lifecycle diagnostics with states for absent, starting, owned/external live, stale socket, crashed, version mismatch, stopping, and disposed; exposed the read-only snapshot through main/preload and the package smoke now asserts a live daemon diagnostic state.
- Added `TaodClient` control-request timing diagnostics: total requests, failures, and the last control request id/type/duration/error are exposed through the same typed main/preload diagnostics path and package smoke now asserts request timing was recorded.
- Added daemon stream diagnostics for active subscribers, pending output sessions/frames/bytes, input/output frame and byte totals, and slow subscriber drops. `taod` exposes them in ping responses, `TaodClient` normalizes them into the preload diagnostics schema, and the package smoke asserts terminal output bytes are visible through the real app boundary.
- Added a packaged Electron/taod sustained-output budget via `pnpm bench:taod:budget`: the real package smoke now drives 1 MiB of terminal output through Electron/preload/main/taod, requires at least 64 KiB/s, enforces no more than 64 KiB pending preload output, and checks taod RSS/growth stays within a 256 MiB smoke ceiling.
- Added a packaged renderer/preload-visible input echo budget to `pnpm bench:taod:budget`: while the same PTY is flooding output, the renderer smoke script writes a probe token through `window.electronAPI.writeSessionInput`, waits for the echoed token through `onPtyData`, requires it within 500 ms, and checks daemon input-byte diagnostics moved.
- Fixed a daemon session-exit invariant panic found by the sustained-output smoke path: PTY ownership and `reader_started` are now cleared before transitioning a session to `exited`, with a Zig regression test for the synthetic-exit path.
- Smoke-owned `taod` processes now pipe stderr into the Electron smoke log while production detached daemon runs still keep ignored stdio.
- Made the attach-replay truncation policy observable: `bufferPendingOutput` now returns dropped/truncated frame counts, daemon stream diagnostics expose pending-output dropped frames/bytes and truncated bytes, TS normalizes those fields, and Zig tests verify oversized pending output is reported through ping diagnostics.
- Promoted `pnpm bench:taod:budget` into the macOS production-build CI job after `pnpm smoke:package`, reusing the built artifact and uploading `apps/desktop/out/bench/taod-budget.txt` with the build artifact.
- Added focused `TaodClient` lifecycle tests with fake Unix-socket daemons covering absent socket, compatible external daemon, protocol version mismatch, malformed/stale daemon response, and successful control-request timing.
- Added real managed-`taod` lifecycle integration tests via `pnpm --filter @tao/desktop test:taod-lifecycle`: they start `taod` under a temporary HOME through `TaodClient`, kill the owned daemon, observe the `crashed` state and scheduled restart, verify a new owned daemon becomes live, and cover a macOS `workspace.ports` request failing when the daemon exits mid-request. The macOS production-build CI job runs them after `pnpm smoke:package`.
- Added a detached app-quit semantics test to `pnpm --filter @tao/desktop test:taod-lifecycle`: it starts a real detached `taod`, disposes the `TaodClient`, asserts the daemon process survives client disposal so PTYs can survive Electron quit, and then explicitly terminates the test daemon.
- Added a packaged renderer reload/resync smoke budget via `pnpm bench:reload:budget`: the Electron smoke now creates two real PTY sessions, keeps both alive, seeds a real daemon-backed workspace, reloads the renderer, attaches to each existing daemon session from the fresh preload context, sends input to both, waits for echoed output, verifies the workspace is still listed and refreshable from the fresh preload context, removes the smoke workspace, checks preload/taod diagnostics, and then kills both sessions.
- Made `taod-client.ts` safe to import under Node's test runner by treating Electron's `app` export as optional outside Electron; packaged Electron smoke verifies the runtime path still works.
- Added an enforcing IPC budget mode to the Electron IPC benchmark and wired `pnpm bench:ipc:budget`. The budget checks MessagePort throughput, p99 control latency, control stalls, and data stalls during bulk output.
- Added `pnpm bench:ipc:budget` to the macOS `performance-smoke` CI job and broadened the uploaded artifact to include both terminal and IPC budget logs.
- Replaced the stale direct `taod` latency benchmark with a self-contained managed-daemon benchmark that launches the built `taod` under a temporary HOME, creates a real PTY echo session, uses the shared TS stream encoder/parser, enforces p50/p95/p99/max latency ceilings via `pnpm bench:latency:budget`, and uploads the latency budget log from the macOS production-build job.
- Added an enforcing direct `taod` attach/replay budget via `pnpm bench:attach:budget`: the benchmark launches managed `taod`, creates a PTY session with 1 MiB pending output, measures attach response, current-screen snapshot delivery, and replay completion through the real attach stream, and uploads the budget log from the macOS production-build job.
- Moved `workspace:getGitStatus` off Electron main's direct `git status` execution path. Electron main now validates the renderer workspace path and asks `taod` through a typed `workspace.status` control request; Zig owns the Git status execution and response shape, including preserving the previous desktop behavior that counts untracked files as changed.
- Added an enforcing daemon-backed workspace metadata budget via `pnpm bench:workspace:budget`: the benchmark launches managed `taod`, creates a synthetic 5k-file Git repo, times branches/status/file-tree/diff/ports/PR metadata RPCs, prints every metric before enforcing budgets, and runs from the macOS production-build job. Added manual large-repo profile scripts and enforcing local budgets for 50k and 250k files. The current 250k baseline keeps branches/status/file-tree/diff/PR under the 2500 ms target; `workspace.ports` is about 1.8s because macOS `lsof` dominates the bounded listener scan.
- Added a configurable direct `taod` terminal churn/RSS soak harness via `pnpm bench:soak` and a short enforcing CI smoke via `pnpm bench:soak:budget`: the benchmark launches managed `taod`, repeatedly creates sessions, attaches a stream, drains terminal output, closes the stream, kills the session, and checks daemon RSS growth, active subscribers, and pending-output bytes. The macOS production-build CI job uploads `soak-budget.txt`.
- Added `pnpm bench:file-tree:budget`: the Electron benchmark bundles the real `@pierre/trees` renderer dependency, mounts a virtualized file tree, resets 50k paths through the file-tree renderer, checks max frame and DOM-node budgets, and runs from the macOS performance-smoke job. `pnpm bench:file-tree:xl:budget` is available locally for 250k paths; current 250k baseline resets in about 208 ms with about 200 rendered nodes, so virtualization bounds DOM growth but still has one >50 ms frame.
- Added a direct `taod` input-priority budget under a real slow subscriber via `pnpm bench:input-priority:budget`: the benchmark launches managed `taod`, attaches one unread slow stream and one fast stream to the same PTY, starts paced flood output, requires `taod` to drop the slow subscriber, and measures fast-stream input echo latency during the flood. Current smoke baseline observed about 1.23 MB output, one slow-subscriber drop, one active fast subscriber, and p95 echo latency under 3 ms.
- Added a packaged Electron app-soak budget via `pnpm bench:app-soak:budget`: the smoke launches the packaged app, creates real PTY sessions through preload, repeats three renderer reload/reattach cycles with two sessions, checks daemon-backed workspace resync once, verifies input echo during output, and enforces Electron main, renderer, and `taod` RSS ceilings. `pnpm bench:app-soak` is the longer 60-cycle manual form, and `pnpm bench:app-soak:hour` is the duration-controlled one-hour packaged reload/reattach soak. The smoke success payload now summarizes per-cycle data instead of dumping full taod diagnostics, and the harness streams progress lines plus kills the Electron process tree on timeout/no-progress so long runs produce usable logs and do not hang.
- Ran the literal one-hour packaged app soak with a one-minute reload interval. The no-delay hour stress profile drove Electron to a renderer V8 heap OOM by reload cycle 129, which is useful stress evidence but not a realistic one-hour app-session proof. The accepted paced hour run completed 60 reload/reattach cycles over 3,601,286 ms with max reload 257 ms, input echo about 1.6 ms, main RSS growth 2,624 KiB, renderer RSS growth 239,472 KiB, `taod` RSS growth 297,152 KiB, final active subscribers 0, final pending output bytes 0, and zero slow-subscriber drops.
- Added a combined renderer pressure budget via `pnpm bench:renderer-combined:budget`: the Electron benchmark mounts xterm.js WebGL, the real `@pierre/trees` file tree, and real `@pierre/diffs/react` file diff rendering in the same renderer process while terminal output streams. Current smoke baseline used 25k file-tree paths, 24 parsed diff files with 12 mounted `FileDiff` bodies, and 2 MiB terminal output; it measured p95 frame 33.40 ms, max frame 157.40 ms, one frame over 50 ms, about 5.49 MB/s terminal throughput, 9115 DOM nodes, and WebGL active.
- Added packaged-app Chromium trace capture for the real Electron smoke path. Setting `TAO_ELECTRON_SMOKE_TRACE=1` now records a Chromium trace around the packaged renderer/preload/main/taod smoke workload; `TAO_ELECTRON_SMOKE_TRACE_MEMORY=1` enables memory-infra heap profiling categories; `pnpm bench:app-trace` writes `apps/desktop/out/bench/electron-smoke-trace.json` and still runs the two-session reload/workspace-resync/input-echo smoke. Current local trace baseline produced a 4,258,546 byte trace with Electron, timeline, V8, GPU, scheduler, and memory-infra categories, completed 3 reload cycles, and ended with 0 active subscribers and 0 pending output bytes.
- Added repeatable packaged-trace analysis via `pnpm bench:app-trace:summary`: the current trace contains 25,056 events over 3,061.94 ms, 5 processes, 49 threads, 9 renderer-main tasks over 50 ms, max renderer-main task 73.42 ms, and 0 browser-main tasks over 50 ms. The top renderer duration groups are V8 `LocalWindowProxy::Initialize` during reload and renderer `RunTask`; this points the short trace at renderer reload initialization rather than Electron main blocking.
- Added a scheduled/manual long-performance workflow in `.github/workflows/performance-long.yml`: it runs weekly and via `workflow_dispatch` on macOS, builds the packaged app, runs `pnpm bench:app-trace`, `pnpm bench:app-trace:summary`, and `pnpm bench:app-soak:hour`, then uploads trace summaries and hour-soak logs as artifacts. This keeps the one-hour proof out of PR CI while still giving a regression signal.
- Extended the packaged renderer reload/resync smoke to cover persisted UI state. `pnpm bench:reload:budget` now writes a layout/settings fixture through the real preload API, reloads the renderer, then verifies from the fresh preload context that the workspace, tab, pane, active-pane, sidebar, and persistence settings survived while allowing expected renderer-managed layout migration/session IDs. Current local rebuilt-package run passed with one reload cycle, max reload 83 ms, UI-state read 0.60 ms, layout version 2, 2 panes, 1 tab, 1 workspace, active pane preserved, and final pending output bytes 0.
- Added typed `TaodLifecycleDiagnostics.timing` fields for startup/ping observability: client creation time, last transition time, last ping start/duration/success/failure times, and last daemon start request/duration. `TaodClient` lifecycle tests assert these fields for failed ping, successful ping, and control-request paths, and the packaged Electron smoke now rejects missing timing over the real preload boundary. Current package smoke completed in 890 ms with renderer load 271 ms, first output 611 ms, taod last ping 0 ms, and taod start 232 ms.
- Added a timeout-aware adapter runner in `apps/daemon/src/adapter.zig`: adapter commands now have a 3000 ms ceiling, hung adapter children are terminated, output remains capped at 64 KiB, nonzero adapter stderr is no longer logged raw, and daemon tests cover a hung adapter returning no detection in under 3 seconds. `pnpm --filter @tao/daemon test` now passes 109 tests, and `pnpm zig:leak-check` passes after the child-process cleanup change.
- Moved current-branch and Git worktree-list metadata out of Electron main. `workspace:getGitBranch` now calls `taod` `workspace.branch`, `workspace:getGitWorktrees` now calls `taod` `workspace.gitWorktrees`, Zig owns the Git execution/response shape, and daemon tests cover both handlers.
- Moved mutating Git path actions out of Electron main. `workspace:stagePath`, `workspace:unstagePath`, and `workspace:revertPath` now validate the renderer payload in main, call `taod` `workspace.stagePath`/`workspace.unstagePath`/`workspace.revertPath`, and enforce target path validation in the daemon before running `git add`/`git restore` with argv arrays and `--`.
- Removed the now-empty Electron main `WorkspaceService`/`ManagedRuntime` layer. Main workspace IPC effects now run through `Effect.runPromise` directly at the boundary, leaving Effect in main as an edge wrapper instead of a service graph with no services.
- Preserved daemon machine-readable error codes across the desktop boundary: `TaodClient` errors now expose the daemon `error_code` as both `code` and `kind`, allowing existing workspace IPC error normalization to return specific kinds such as `invalid-path` instead of flattening everything to `ipc-failed`.
- Documented the current Electron `sandbox: false` rationale next to `BrowserWindow` creation. The setting remains because preload intentionally imports Electron `clipboard`, `shell`, `ipcRenderer`, and MessagePort APIs; tightening it should be a separate compatibility pass that preserves the narrow renderer API.
- Added shared workspace-control request and response fixtures for all daemon-backed workspace metadata requests and Git path actions currently emitted by `TaodClient`: branches, current branch, Git worktree list, status, file tree, diff, ports, pull request, stage path, unstage path, and revert path. Zig now decodes request fixtures through `ControlRequestJson` and compares response JSON writers against the response fixtures. The desktop `TaodClient` lifecycle tests compare emitted request shapes and normalized response shapes against the same fixture set, so these workspace protocol additions have cross-language drift coverage.
- Added shared non-workspace control response fixtures for session-shaped responses, history cleanup, retention cleanup, and persistence configuration. Zig now compares `sessionResponse` and generic maintenance/persistence JSON writers against those fixtures, and desktop `TaodClient` tests exercise create/resize/detach/kill/clear-history/cleanup/configure-persistence response normalization from the same fixture set.
- Added shared workspace/worktree mutation response fixtures for workspace list/add/refresh/remove and worktree create/refresh/remove shapes. Zig now compares workspace list/record and worktree payload writers against those fixtures, and desktop `TaodClient` tests exercise the corresponding response normalization paths from the same fixture set.
- Added a central, language-neutral taod protocol fixture manifest at `packages/shared/fixtures/taod-protocol/spec.json`. It records the control protocol version, daemon version, capability list, stream wire constants, frame kind values, and the request/response/stream fixture inventory. Both TS and Zig tests now parse that manifest and compare it against their local constants and fixture files.
- Added focused workspace IPC schema regression coverage for hostile renderer-shaped payloads. The desktop persistence test now asserts shared Effect schemas reject malformed workspace add/refresh/remove, worktree create/refresh/remove, diff, and Git path-action payloads while still accepting representative valid payloads.
- Added a lightweight cross-boundary trace handle for daemon control requests. `TaodClient` now exposes a stable `clientTraceId`, attaches `traceId` to every control request sent over the socket, records it in `lastControlRequest`, and Zig `ControlRequestJson` decodes both `traceId` and `trace_id` so daemon-side code can carry the same request context.
- Extended the trace handle across daemon responses. Valid daemon control responses now echo the request trace as `trace_id`, `TaodClient` records it as `lastControlRequest.responseTraceId`, and Zig tests verify the generic response wrapper preserves one-line JSON and escapes trace strings correctly.
- Added typed daemon-side control diagnostics to ping responses without widening every generic control response shape. The daemon now records bounded request counters, failure counters, last request type, last trace id, last duration, last ok state, and last recorded timestamp; `TaodClient` normalizes this as `daemonControlDiagnostics`; preload schema validation covers it; and packaged smoke now asserts the real Electron/preload/main/taod path exposes a non-empty daemon control trace.
- Added renderer user-timing spans for Tao-level UI work. The renderer now publishes bounded `tao:*` performance entries for app mount, layout hydration, terminal create/font/open/attach/reveal/ready, and packaged smoke asserts startup emits the app/layout marks. `pnpm bench:app-trace:summary` now reports Tao user-timing counts/names from Chromium traces; the current trace contains 72 Tao entries, including terminal create/attach/reveal/ready spans from the reload UI-state path.
- Added a low-noise daemon trace logging policy. The daemon now logs control request `type`, `trace_id`, and `duration_ms` only when a request fails or a successful request takes at least 250 ms; normal successful requests and pings stay out of the log stream. A Zig policy test covers quiet, slow, and failed cases.
- Added read-only Git metadata watcher diagnostics. `GitStateWatcher` now reports tracked workspace count, watcher count, queued/in-flight/pending refresh state, refresh/notify/failure counters, last queue/refresh reason, duration, and last error; preload schema-validates the diagnostics over a narrow IPC call, focused tests cover success and failure counters, and packaged reload smoke now asserts watcher tracking exists during workspace setup and is removed after cleanup.
- Tightened renderer Effect metadata-cache stale-work handling. Normal workspace metadata refreshes still coalesce, but forced refreshes now supersede an existing in-flight request so a stuck or stale request cannot block user-driven refresh forever. The existing cache version guard prevents stale completions from overwriting newer snapshots, and a focused renderer service test now proves it.
- Extended xterm output writer diagnostics for renderer-side backpressure attribution. The batched writer now reports completed write count, total written chars, last write size/duration, max write callback duration, and max write-queue high-water chars/chunks in addition to current queued chars/chunks. This gives the existing terminal diagnostics registry enough data to distinguish backlog before xterm from slow xterm write callbacks.
- Made preload terminal buffer loss observable. `getTerminalPreloadDiagnostics()` now reports cumulative dropped/truncated data/output counters for the bounded pre-subscription buffers, and packaged smoke fails if the normal startup/reload path loses preload-buffered terminal data before the renderer subscribes.
- Made detached-daemon ownership explicit in `TaodClient` diagnostics. The typed diagnostics now distinguish `external`, `owned-attached`, `owned-detached`, and `released-detached` daemons, preserve the released detached pid after client disposal, and the fake-socket plus real-daemon lifecycle tests assert the ownership transitions.
- Added a typed lifecycle recovery action to `TaodClient` diagnostics. The diagnostics now map daemon states to machine-readable policy actions such as `start-daemon`, `reuse-external-daemon`, `clear-stale-socket-and-start`, `restart-owned-daemon`, `replace-incompatible-daemon`, and `keep-detached-daemon`, with fake-socket and real-daemon lifecycle tests covering the key recovery states.
- Surfaced daemon recovery policy in the renderer shell. The app now polls `getTaodDiagnostics()` at a low rate and shows a compact titlebar/sidebar recovery indicator when `taod` is external, starting/recovering, incompatible, or intentionally preserved as detached. Packaged smoke asserts the real Electron/preload/main/daemon diagnostics include `daemonOwnership` and `recoveryAction`.
- Extended the renderer daemon recovery indicator into a diagnostics popover. The popover shows current lifecycle state, daemon owner, recovery action, version/protocol, pid/released pid, last ping/start timing, last control request, and last diagnostic error from the existing `getTaodDiagnostics()` payload.
- Added a narrow guided daemon recovery IPC path. The renderer can invoke only a typed current recovery action through `recoverTaod`; main validates the action, `TaodClient` applies safe start/retry/restart behavior, clears scheduled restart timers before manual recovery, and refuses to replace incompatible daemons it does not own.
- Made main-process PTY MessagePort posting observable. `TaodPtyBridge` now exposes counters for connected port state, active sessions/streams, total/data/snapshot posts, data chars, no-port drops, and post failures through a typed main/preload diagnostics call; packaged smoke asserts the real Electron/preload/main/taod path posts terminal data through the bridge with zero post/drop failures.
- Fixed the file-tree renderer's sorted-input contract. The daemon still emits sorted path arrays for stable protocol output, but the renderer no longer passes those arrays to `@pierre/trees` as `presorted`; it prepares reset input with the library's own sorter so real repos with hidden paths such as `.github/ISSUE_TEMPLATE/bug.yml` do not trip `appendPaths()` order validation.
- Added an explicit renderer xterm write-queue cap. The batched terminal writer now bounds queued writes to 4 MiB, drops the oldest queued output down to 2 MiB when xterm stops draining, emits one visible drop notice, and reports cumulative dropped chunks/chars in diagnostics.

Still open:

- Act on future scheduled long-profile artifacts if they show regressions. The trace capture, summary command, and non-PR long-performance workflow now exist; remaining performance work is fixing any measured offender rather than adding another proof harness.

## Architecture Map

- Electron main responsibilities: Chromium flags and `BrowserWindow` setup in `apps/desktop/src/main/index.ts:55`, window/preload security settings in `apps/desktop/src/main/index.ts:123`, keyboard command routing in `apps/desktop/src/main/index.ts:167`, PTY MessagePort handoff in `apps/desktop/src/main/index.ts:268`, IPC handlers in `apps/desktop/src/main/index.ts:411`, `TaodClient` startup/restart in `apps/desktop/src/main/taod-client.ts:537`, and Git metadata watching in `apps/desktop/src/main/git-state-watcher.ts:84`.
- Preload responsibilities: narrow `contextBridge` API in `apps/desktop/src/preload/index.ts:562`, PTY MessagePort queueing in `apps/desktop/src/preload/index.ts:208`, message decoding in `apps/desktop/src/preload/index.ts:472`, bounded pre-subscription output buffers in `apps/desktop/src/preload/index.ts:324`, and Effect-backed workspace IPC response decoding in `apps/desktop/src/preload/runtime.ts:69`.
- Renderer responsibilities: Zustand app/layout/workspace state in `apps/desktop/src/renderer/state/store.ts:22`, xterm lifecycle in `apps/desktop/src/renderer/terminal.ts:447`, direct xterm write batching in `apps/desktop/src/renderer/terminal-output-writer.ts:8`, terminal pane UI state in `apps/desktop/src/renderer/ui/TerminalPane.tsx:75`, and file tree/diff UI in `apps/desktop/src/renderer/ui/App.tsx:1324` and `apps/desktop/src/renderer/ui/App.tsx:1711`.
- Effect service/runtime responsibilities: main request wrapping now uses `Effect.runPromise` directly in `apps/desktop/src/main/runtime.ts:3`, workspace IPC effects are composed in `apps/desktop/src/main/index.ts:316`, preload still has a `ManagedRuntime` IPC service in `apps/desktop/src/preload/runtime.ts:129`, and renderer resource hooks live in `apps/desktop/src/renderer/workspaceQueries.ts:101`.
- Zig daemon responsibilities: storage/socket preparation and server loop in `apps/daemon/src/daemon/server.zig:27`, peer owner verification in `apps/daemon/src/daemon/server.zig:241`, session state in `apps/daemon/src/session.zig:69`, PTY process ownership in `apps/daemon/src/pty.zig:68`, stream attach/broadcast in `apps/daemon/src/daemon/stream.zig:31`, persistence in `apps/daemon/src/daemon/persistence.zig:20`, workspace/worktree operations in `apps/daemon/src/workspace.zig:125` and `apps/daemon/src/worktree.zig:63`.
- Shared schema/protocol responsibilities: TS schema constants in `packages/shared/src/taod-protocol.ts:5`, workspace IPC schemas in `packages/shared/src/workspace.ts:3`, pane/settings schemas in `packages/shared/src/session.ts`, and app command types in `packages/shared/src/app-command.ts`.
- Electron <-> taod protocol boundary: TS control request construction and response normalization live in `apps/desktop/src/main/taod-client.ts:592`; Zig parses loose JSON in `apps/daemon/src/rpc.zig:84`; binary stream frame constants exist in both `packages/shared/src/taod-protocol.ts:5` and `apps/daemon/src/rpc.zig:302`; TS stream parser is in `apps/desktop/src/main/taod-stream.ts:144`; Zig stream parser is in `apps/daemon/src/rpc.zig:385`.
- Startup flow: `app.whenReady` creates the window in `apps/desktop/src/main/index.ts:654`; renderer mounts terminal; preload requests `pty:requestPort` in `apps/desktop/src/preload/index.ts:531`; main creates a `TaodPtyBridge` and `TaodClient` in `apps/desktop/src/main/index.ts:283`; `TaodClient.ensureRunning()` pings or starts detached `taod` in `apps/desktop/src/main/taod-client.ts:569`; `taod` prepares owner-only storage and socket in `apps/daemon/src/daemon/server.zig:27`.
- Shutdown flow: Electron `before-quit` disposes watchers, bridge, client, and Effect runtime in `apps/desktop/src/main/index.ts:670`; the daemon is intentionally not killed by `TaodClient.dispose()` in `apps/desktop/src/main/taod-client.ts:580`; daemon teardown kills/waits PTY children only when the daemon itself exits in `apps/daemon/src/daemon.zig:78`.
- Hot paths: input goes xterm `onData` -> preload `writeSessionInput` -> MessagePort -> `TaodPtyBridge` -> `TaodSessionStream.writeFrame` -> socket -> daemon stream parser -> PTY write. Output goes PTY read -> VT/event-log update -> stream frame -> main bridge UTF-8 decode -> MessagePort -> preload callbacks -> renderer batched xterm writer.

## Top 10 Prioritized Actions

1. Define and enforce an Electron <-> taod protocol contract.
   - Impact: High reliability and testability; prevents TS/Zig drift.
   - Effort: Medium.
   - Risk: Low if fixtures come first.
   - Files involved: `packages/shared/src/taod-protocol.ts`, `apps/daemon/src/rpc.zig`, `apps/desktop/src/main/taod-client.ts`, `apps/desktop/src/main/taod-stream.ts`.
   - Verification method: golden TS/Zig fixtures for control JSON and binary frames; malformed fixture rejection tests on both sides. Current fixtures cover ping/attach/error responses, stream output/resize/exit/snapshot/corrupt CRC frames, and the daemon-backed workspace metadata/path-action control requests emitted by `TaodClient`.
2. Add end-to-end terminal backpressure budgets.
   - Impact: High terminal feel and memory stability.
   - Effort: Medium.
   - Risk: Medium because it touches hot-path flow.
   - Files involved: `taod-client.ts`, `taod-pty-bridge.ts`, `preload/index.ts`, `terminal-output-writer.ts`, `daemon/stream.zig`, `pty.zig`.
   - Verification method: sustained-output benchmark with max queued bytes, p95 frame time, socket backpressure counts, and no unbounded RSS growth. The xterm/WebGL budget exists, xterm output writer diagnostics report current and high-water queues plus write callback latency, preload diagnostics report bounded-buffer drop/truncation counters, main bridge diagnostics report MessagePort posts/data chars/post failures/no-port drops, daemon stream counters expose active subscribers/pending bytes/output bytes/slow-subscriber drops/pending-output truncation through ping diagnostics, `pnpm bench:taod:budget` enforces a 1 MiB packaged Electron/taod throughput, pending-output, and RSS smoke budget, `pnpm bench:input-priority:budget` enforces input echo under a dropped slow subscriber, `pnpm bench:soak:budget` enforces a short direct `taod` churn/RSS smoke, `pnpm bench:app-soak:budget` enforces short packaged Electron reload/reattach memory ceilings, and `pnpm bench:app-soak:hour` now proves a paced one-hour packaged reload/reattach soak.
3. Mostly done: make detached daemon lifecycle explicit and recoverable.
   - Impact: High startup/recovery reliability.
   - Effort: Medium.
   - Risk: Medium because PTY survival is product behavior.
   - Files involved: `taod-client.ts`, `daemon/server.zig`, `daemon/persistence.zig`, `main/index.ts`.
   - Verification method: scripted crash/restart/reload tests covering stale socket, daemon exit, Electron quit, and renderer reload. Current code exposes lifecycle diagnostics, daemon ownership, typed recovery actions, a renderer recovery indicator/popover, and a narrow `recoverTaod` IPC action path. Focused fake-socket tests cover absent/stale/live/version-mismatch/request-timing states, compatible external-daemon reuse, and refusal to replace an external incompatible daemon. `test:taod-lifecycle` proves an owned real daemon can be recovered after process exit, records failed control request diagnostics when the daemon exits mid-request, and preserves a detached daemon across client disposal for Electron quit semantics while diagnostics mark it `released-detached` with `keep-detached-daemon`. Package smoke asserts a live state plus recovery policy fields, and `bench:reload:budget` proves packaged renderer reload can reattach to two existing daemon sessions.
4. Move remaining filesystem/process-heavy workspace metadata out of Electron main or justify the split.
   - Impact: High startup and large-repo responsiveness.
   - Effort: Medium.
   - Risk: Medium.
   - Files involved: `git-state-watcher.ts`, `workspace.zig`, `worktree.zig`, `taod-client.ts`, `main/index.ts`.
   - Verification method: large repo benchmark for file tree, status, branches, diff, PR info, and ports. The recursive `lsof +D` ports path has been removed, Git current-branch, branches, worktree-list, status, file-tree, raw-diff, stage/unstage/revert path actions, port, and PR metadata now route through `taod`, `pnpm bench:workspace:budget` enforces a 5k-file daemon-backed smoke baseline, `pnpm bench:workspace:large:budget` enforces a 50k-file local profile, and `pnpm bench:workspace:xl:budget` enforces a 250k-file local profile. Remaining Electron ownership is Git metadata watching/refresh policy; that path now has explicit watcher/refresh diagnostics and packaged reload smoke coverage for track/untrack behavior.
5. Done: add packaged app smoke coverage for `taod` and adapters.
   - Impact: High release reliability.
   - Effort: Medium.
   - Risk: Low.
   - Files involved: `electron.vite.config.ts`, `taod-client.ts`, CI workflows.
   - Verification method: build artifact launches, resolves `taod`, starts daemon, creates one session through preload, observes terminal output, enforces a small throughput/preload-queue budget, kills the smoke session, and verifies no smoke daemon is left behind.
6. Mostly done: add request IDs and structured timing across renderer/main/daemon.
   - Impact: High debuggability and performance proof.
   - Effort: Low to medium.
   - Risk: Low.
   - Files involved: preload, `taod-client.ts`, `daemon/server.zig`, `rpc.zig`.
   - Verification method: one terminal create/attach produces correlated logs with startup/attach/write/read timings. Current diagnostics expose `TaodClient` lifecycle transitions, control request count/failure/last-duration, daemon ping/start timing, a stable client trace id, per-control-request trace ids, daemon response trace echoes, daemon control request counters/last-trace fields through preload, renderer `tao:*` user-timing spans in packaged traces, and daemon failed/slow control request logs with trace ids.
7. Partially done: make Effect either own resource safety or stay out of hot paths.
   - Impact: Medium maintainability.
   - Effort: Medium.
   - Risk: Low if scoped.
   - Files involved: `runtime.ts`, `preload/runtime.ts`, `workspaceQueries.ts`.
   - Verification method: tests for typed errors, cancellation, timeout, and runtime disposal; no Effect in per-byte terminal streams. Current code removes the empty main service layer, keeps terminal streams plain, preserves daemon error kinds, applies renderer IPC timeouts, and proves forced metadata refresh supersedes stale in-flight results without allowing stale completions to overwrite newer snapshots.
8. Partially done: bound initial full-pane diff body rendering and move patch parsing off the renderer thread.
   - Impact: Medium renderer jank reduction.
   - Effort: Medium.
   - Risk: Low.
   - Files involved: `App.tsx`, `diff-parser.ts`, `diff-parser.worker.ts`, `diff-parser-client.ts`, `workspaceQueries.ts`.
   - Verification method: large diff/file-tree profiles with worker/off-main-thread or virtualization budgets. Current guard collapses large rendered diff bodies by default, patch parsing now runs in a module worker, large diffs mount at most 12 expanded `FileDiff` bodies, `pnpm bench:file-tree:budget` enforces a 50k virtualized file-tree renderer budget, `pnpm bench:renderer-combined:budget` exercises terminal output plus file tree plus diff rendering in one Electron renderer, and `pnpm bench:app-trace` captures a packaged-app Chromium trace. The 250k file-tree budget passes locally but still records one about-208 ms reset frame.
9. Done for current threat model: harden adapter execution policy.
   - Impact: Medium security/reliability.
   - Effort: Low to medium.
   - Risk: Low.
   - Files involved: `adapter.zig`, packaging config.
   - Verification method: adapter path/runner allowlist tests, timeout tests, stderr redaction tests. Current daemon code allowlists runner basenames, rejects group/other-writable adapter directories and scripts, times out hung adapter children, caps adapter output, and redacts raw stderr from failure logs.
10. Done for PR smoke plus scheduled long profile: add CI performance smoke budgets. Impact: Medium regression detection. Effort: Medium. Risk: Low. Files involved: `apps/desktop/bench/*`, `.github/workflows/ci.yml`, `.github/workflows/performance-long.yml`. Verification method: CI emits baseline artifacts and fails only on generous smoke thresholds. Current macOS CI runs terminal renderer, combined renderer pressure, IPC, and 50k file-tree renderer budgets with generous thresholds; the macOS production-build job runs packaged startup, packaged renderer reload/reattach, packaged app-soak reload/memory, direct `taod` input-latency, direct slow-subscriber input-priority, direct attach/replay, 5k-file workspace metadata, short direct `taod` churn/RSS soak, packaged renderer/preload input echo under output, and taod throughput budgets and uploads the logs. 50k-file and 250k-file workspace budgets plus a 250k file-tree renderer budget exist as local/manual profiles. The paced one-hour packaged app-soak and packaged trace capture now run in a separate weekly/manual long-performance workflow, not PR CI.

## Performance Budget Proposal

- Cold app startup: <= 1200 ms to first visible terminal on supported macOS hardware; record phases for Electron ready, renderer mounted, daemon connected, PTY attached, first paint.
- Warm app startup: <= 700 ms to first visible terminal when `taod` socket is already live.
- Daemon ready time: <= 250 ms warm ping, <= 750 ms cold `taod` start to ping success.
- Terminal input echo latency: p50 <= 12 ms, p95 <= 25 ms, p99 <= 50 ms from `onData` to rendered echo.
- Sustained terminal output throughput: >= 10 MB/s for 30 seconds with p95 renderer frame <= 16.7 ms and no dropped live frames except documented slow-subscriber policy.
- Attach/replay latency: <= 100 ms for current-screen snapshot, <= 500 ms for 1 MB replay, bounded by configured replay bytes.
- Renderer frame time: p95 <= 16.7 ms during terminal output; p99 <= 33 ms during sidebar/diff actions.
- IPC/protocol message volume: terminal output should batch to <= 120 renderer callbacks/sec per active terminal under sustained output.
- Memory growth over 1 hour: <= 100 MB RSS growth for idle plus one active terminal; <= 250 MB under sustained output and repeated attach/detach.
- Large repo workspace load: <= 1000 ms for 50k files, <= 2500 ms for 250k files, with no main-process long task over 50 ms.
- Worktree create/remove latency: display progress within 100 ms; p95 create/remove command completion <= 10 s on local repos, excluding network fetch.

## Critical Findings

No critical issue was proven by static inspection and the checks run. The highest risks are high-priority boundary/performance issues that need stress or packaged-app tests to calibrate severity.

## High Priority Findings

#### [Severity: High] Protocol contract can drift between TS and Zig

- Evidence: `packages/shared/src/taod-protocol.ts:5`, `apps/daemon/src/rpc.zig:302`, `apps/desktop/src/main/taod-client.ts:194`, `apps/daemon/src/rpc.zig:84`.
- Problem: Stream constants, request aliases, response fields, and validation rules are duplicated manually across TS and Zig. TS has Effect schemas, but Zig has separate structs and parser rules. Control JSON accepts many aliases in Zig while TS constructs a narrower set. Shared fixtures now cover the stream codec, core control responses, session-shaped responses, maintenance/persistence responses, workspace/worktree mutation responses, and all daemon-backed workspace metadata/path-action request and response shapes currently emitted by `TaodClient`. A central JSON protocol fixture manifest now records protocol constants and fixture inventory, but there is still no codegen from that spec.
- Why it matters: Protocol drift can break attach/replay, error handling, or workspace operations without typecheck catching it.
- Suggested fix: Add a central protocol spec plus golden fixtures for control requests/responses and binary frames. Run TS encode/decode and Zig parse/encode against the same fixtures.
- Verification: `pnpm test:persistence` plus new Zig/TS golden contract tests; include malformed fixture rejection.
- Confidence: High.

#### [Severity: High] Terminal backpressure is not end-to-end

- Evidence: `apps/desktop/src/main/taod-client.ts:522`, `apps/desktop/src/main/taod-client.ts:628`, `apps/desktop/src/main/taod-client.ts:893`, `apps/desktop/src/preload/index.ts:208`, `apps/desktop/src/renderer/terminal-output-writer.ts:8`, `apps/daemon/src/daemon/stream.zig:235`.
- Problem: TS socket writes now observe backpressure, main bridge diagnostics expose MessagePort post/data/drop/failure counters, preload/xterm expose pending queues, xterm write callback latency/high-water diagnostics, and a bounded renderer write-queue drop policy, and `taod` now reports stream counters, slow-subscriber drops, and pending-output truncation through diagnostics. Short and paced one-hour packaged Electron/main/renderer app-soak budgets now exist, plus packaged trace capture and summary. The remaining gap is an actual end-to-end flow-control policy and responding to future long-session RSS regressions once the scheduled profile has more samples.
- Why it matters: High output can become latency spikes or memory growth before any subsystem sees pressure.
- Suggested fix: Use the existing bridge/preload/xterm diagnostics plus the daemon stream counters to enforce per-session high-water marks across the whole path; propagate pressure or disconnect slow consumers instead of relying only on local drop policies.
- Verification: sustained-output benchmark measuring output MB/s, queued bytes, dropped frames, p95 input echo, renderer frame time, and RSS.
- Confidence: High.

#### [Severity: High] Detached daemon lifecycle now has safe recovery actions; external replacement remains manual

- Evidence: `apps/desktop/src/main/taod-client.ts:819`, `apps/desktop/src/main/taod-client.ts:580`, `apps/desktop/src/main/taod-client.ts:857`, `apps/daemon/src/daemon/server.zig:55`, `apps/daemon/src/daemon.zig:78`.
- Problem: Electron detaches/unrefs `taod` so PTYs survive restarts. The internal diagnostics now expose explicit lifecycle state, daemon ownership for external/attached-owned/detached-owned/released-detached daemons, and typed recovery actions for start, reuse external, clear stale socket, restart owned daemon, replace incompatible daemon, and keep detached daemon. The renderer now has a compact recovery indicator, diagnostics popover, and narrow `recoverTaod` action path for safe start/retry/restart recovery. Tao still intentionally refuses to kill or replace an incompatible external daemon it does not own.
- Why it matters: Recovery bugs here look like duplicate daemons, stale sessions, lost output, or invisible restart loops.
- Suggested fix: Keep external-daemon replacement manual unless Tao adds authenticated daemon ownership claims. If automatic replacement is added later, require proof that the daemon was spawned by this app instance or a signed/versioned Tao install.
- Verification: current fake-socket tests cover compatible external reuse and external incompatible replacement refusal; real lifecycle tests cover manual owned-daemon recovery after process exit; package smoke covers the live diagnostics boundary.
- Confidence: High.

#### [Severity: High] Workspace/git ownership is split between Electron main and taod

- Evidence: `apps/desktop/src/main/index.ts` workspace IPC handlers, `apps/desktop/src/main/taod-client.ts`, `apps/desktop/src/main/git-state-watcher.ts`, `apps/daemon/src/workspace.zig`, `apps/daemon/src/worktree.zig`.
- Status: Mostly implemented after the initial review. Workspace Git, port, and PR command execution is now daemon-owned (`workspace.add`, `worktree.create/remove`, current branch, branch list, Git worktree list, status, file tree, raw diff, stage/unstage/revert path actions, ports, PR info). Electron main still owns Git metadata watchers and refresh orchestration.
- Problem: Initial review found workspace/process-heavy metadata split between Electron main and `taod`; follow-up implementation moved metadata reads and mutating Git path actions behind typed daemon requests. The remaining split is watcher/refresh policy rather than Git command execution.
- Why it matters: Large-repo work can block or churn Electron main, and responsibility for path validation, caching, and errors is duplicated.
- Suggested fix: Add large-repo benchmarks for these daemon-backed metadata paths and keep new filesystem/process-heavy metadata out of Electron main.
- Verification: large repo benchmark plus main-process CPU/long-task profile before and after.
- Confidence: High.

#### [Severity: High] Packaged binary/adapters path resolution is brittle and not smoke-tested

- Evidence: `apps/desktop/electron.vite.config.ts:19`, `apps/desktop/electron.vite.config.ts:52`, `apps/desktop/src/main/taod-client.ts:300`, `apps/desktop/src/main/taod-client.ts:332`, `.github/workflows/ci.yml:115`.
- Status: Implemented after the initial review. `scripts/package-smoke.ts` now checks packaged `taod`, adapters, Electron startup, preload session creation, terminal output throughput, session kill, and smoke-daemon cleanup; `.github/workflows/ci.yml` runs it on the macOS production build.
- Problem: Build copies `taod` and adapters beside output, while runtime probes many dev/prod fallback paths. CI uploads `out/`, but no smoke test proves the packaged app can resolve `taod`, start it, and load adapters.
- Why it matters: Production failures will surface as startup timeouts, not compile errors.
- Suggested fix: Add a post-build smoke that runs `taod --check`, verifies adapter dir presence, launches Electron in smoke mode, and performs one daemon ping/session attach.
- Verification: macOS build job fails if `findTaodBinary()`/adapter resolution or daemon ping fails.
- Confidence: High.

## Medium Priority Findings

#### [Severity: Medium] Effect usage is valid beta API but still thin outside renderer metadata safety

- Evidence: `apps/desktop/src/main/runtime.ts:3`, `apps/desktop/src/preload/runtime.ts:129`, `apps/desktop/src/renderer/workspaceQueries.ts:101`.
- Problem: The obsolete empty main `WorkspaceService` layer has been removed. Remaining Effect usage mainly wraps IPC/query calls. It does add typed `WorkspaceError`, renderer IPC timeouts, and renderer metadata-cache stale-result protection. Forced metadata refreshes now supersede stale in-flight work, but Effect still does not broadly own resource lifetime, retries, structured logging, or service composition for daemon/workspace workflows.
- Why it matters: It adds mental overhead without consistently improving safety.
- Suggested fix: Keep Effect out of terminal hot paths. For workspace flows, continue making daemon client, metadata cache, and logging explicit services with typed errors, timeouts, and targeted cancellation/supersession where it prevents stale UI or blocked user refreshes.
- Verification: focused tests for timeout/cancel/error mapping and runtime disposal; current desktop tests include forced refresh supersession and daemon error-code preservation.
- Confidence: High.

#### [Severity: Medium] IPC validation is inconsistent across channel families

- Evidence: `apps/desktop/src/main/index.ts:437`, `apps/desktop/src/main/index.ts:468`, `apps/desktop/src/main/index.ts:573`, `apps/desktop/src/main/index.ts:596`, `apps/desktop/src/preload/index.ts:968`.
- Problem: Some IPC payloads use shared schemas, while daemon workspace calls manually coerce objects and strings to defaults like `''`.
- Why it matters: Bad renderer input can become ambiguous daemon requests; threat model assumes renderer compromise.
- Suggested fix: Add shared schemas for every `workspace:*` and `worktree:*` payload, decode in preload and main, and reject invalid payloads instead of defaulting IDs to empty strings.
- Verification: IPC contract tests with malformed payloads.
- Confidence: High.

#### [Severity: Medium] Resolved: main process used expensive `lsof +D`

- Evidence: initial review found the old Electron main workspace service using recursive `lsof +D`; current source has no `lsof +D` source matches and bounded port discovery lives in `apps/daemon/src/workspace.zig`.
- Status: Implemented after the initial review. The recursive `lsof +D` path was replaced with a bounded listener-PID scan; `rg "lsof.*\\+D|\\+D" apps/desktop/src apps/daemon/src` has no source matches.
- Problem: `lsof -a +D <workspace>` recursively descends directories and can be expensive on large repos.
- Why it matters: Port lookup can cause main-process latency and bad perceived performance.
- Suggested fix: Move port discovery to daemon, cache it, and use a cheaper process/netstat strategy that maps cwd only when needed.
- Verification: benchmark port lookup on a large repo and assert no main-process long task above 50 ms.
- Confidence: High.

#### [Severity: Medium] Renderer diff rendering can still jank large changes

- Evidence: `apps/desktop/src/renderer/ui/App.tsx`, `apps/desktop/src/renderer/diff-parser.worker.ts`, `apps/desktop/src/renderer/diff-parser-client.ts`.
- Problem: Patch parsing has been moved to a renderer worker and large full-pane diffs cap mounted bodies, but diff tree grouping and visible `FileDiff` rendering still happen in the renderer.
- Why it matters: Large diffs compete with terminal rendering and input.
- Suggested fix: Keep parser work off-thread, then virtualize full diff file rendering and cap mounted hunk/body count. Longer term, have the daemon return diff summaries/metadata instead of forcing Electron main to produce raw patches for every view.
- Verification: profile 1 MB, 5 MB, and 20 MB patches with frame-time budget.
- Confidence: High.

#### [Severity: Medium] Resolved: adapter execution timeout and runner trust

- Evidence: `apps/daemon/src/adapter.zig:271`, `apps/daemon/src/adapter.zig:284`, `apps/daemon/src/adapter.zig:292`, `apps/daemon/src/adapter.zig:309`.
- Problem: Adapter commands previously executed via `TAOD_ADAPTER_RUNNER` or `tsx`/`node` with no timeout, and failure logs included raw stderr. Runner basename allowlisting existed; timeout, raw-stderr handling, and adapter directory/script writability checks now exist too.
- Why it matters: A hung adapter can stall agent detection/resume; a hostile local environment can redirect runner behavior.
- Suggested fix: Keep the runner allowlist, timeout, stderr redaction, and provenance checks.
- Verification: `pnpm --filter @tao/daemon test` includes runner allowlist, hung-adapter timeout, and group-writable adapter directory rejection coverage.
- Confidence: Medium.

#### [Severity: Medium] Daemon uses per-connection and per-session detached threads without a shutdown control plane

- Evidence: `apps/daemon/src/daemon/server.zig:91`, `apps/daemon/src/daemon/process.zig:76`, `apps/daemon/src/daemon.zig:109`.
- Problem: The daemon detaches control and session reader threads, then waits via atomics only during daemon deinit. There is no explicit graceful shutdown or cancellation path.
- Why it matters: Crash/restart and testability are harder; long blocked reads/writes can delay teardown.
- Suggested fix: Add daemon shutdown state, wakeups, and joinable thread handles for tests or controlled stop.
- Verification: daemon integration test that starts sessions, requests shutdown, and proves all fds/processes are closed.
- Confidence: Medium.

#### [Severity: Medium] Protocol has no version/capability negotiation

- Evidence: `packages/shared/src/taod-protocol.ts:6`, `apps/daemon/src/rpc.zig:303`, `apps/desktop/src/main/taod-client.ts:794`.
- Problem: Binary frames have version `1`, but control ping only returns `status: ok`; no daemon version, build hash, protocol version, or capabilities are checked.
- Why it matters: Detached old daemons can survive app upgrades and speak a stale protocol.
- Suggested fix: Include `{ protocolVersion, daemonVersion, capabilities }` in ping and reject incompatible daemons with a clear recovery path.
- Verification: test an incompatible ping response and confirm Electron reports version mismatch instead of issuing normal requests.
- Confidence: High.

#### [Severity: Medium] Resolved: full repo check failed formatting

- Evidence: `pnpm check` output: `packages/shared/src/workspace.ts` has format issues.
- Status: Implemented after the initial review. `pnpm check` now passes end to end.
- Problem: The aggregate check does not pass in the current worktree.
- Why it matters: CI readiness is not clean even though focused checks pass.
- Suggested fix: Format `packages/shared/src/workspace.ts` in a source-fix turn if permitted.
- Verification: rerun `pnpm check`.
- Confidence: High.

## Low Priority Findings

#### [Severity: Low] Chromium performance flags need measured justification

- Evidence: `apps/desktop/src/main/index.ts:55`, `apps/desktop/src/main/index.ts:72`, `apps/desktop/src/main/index.ts:87`, `apps/desktop/src/main/index.ts:106`.
- Problem: Several flags are asserted as performance wins, but no startup/renderer benchmark budget is tied to them.
- Why it matters: Flags can regress across Electron/Chromium versions.
- Suggested fix: Add a startup/render benchmark matrix with flags on/off for only the risky flags.
- Verification: `pnpm bench:startup` and renderer benchmark artifacts before/after.
- Confidence: Medium.

#### [Severity: Low] Preload callback maps can retain sessions until explicit error/exit

- Evidence: `apps/desktop/src/preload/index.ts:100`, `apps/desktop/src/preload/index.ts:272`, `apps/desktop/src/preload/index.ts:706`.
- Problem: Most callback cleanup is caller-driven; session maps clear on error/exit/kill but not on renderer route lifecycle mistakes.
- Why it matters: Bugs in component cleanup can accumulate callbacks over long sessions.
- Suggested fix: Add diagnostics counters for registered callbacks per session and warn on unusual counts.
- Verification: repeated pane mount/unmount stress test with stable callback counts.
- Confidence: Medium.

#### [Severity: Low] Build scripts skip Windows daemon copy but CI still builds Windows

- Evidence: `apps/desktop/electron.vite.config.ts:33`, `.github/workflows/ci.yml:152`.
- Problem: Windows production build can succeed without a usable daemon binary.
- Why it matters: Users may get an artifact that cannot run Tao's core feature.
- Suggested fix: Mark Windows unsupported in build metadata/UX or add a Windows daemon strategy before publishing artifacts.
- Verification: Windows smoke asserts a clear unsupported message or working daemon.
- Confidence: High.

## Confirmed Issues vs Hypotheses

Confirmed:

- The initial `pnpm check` failure at `fmt:ts:check` on `packages/shared/src/workspace.ts` was real and is now fixed; current `pnpm check` passes.
- TS/Zig protocol definitions are duplicated manually.
- TS socket writes and MessagePort posts do not implement an end-to-end backpressure contract; MessagePort posts are now counted and smoke-checked but still do not have native flow control.
- Electron main now delegates workspace/worktree persistence, mutations, Git metadata, port metadata, and GitHub PR metadata to `taod`.
- Packaged app path resolution had multiple fallbacks and no packaged smoke proof; this is now covered by `pnpm smoke:package` and the macOS build CI job.

Hypotheses needing profiling or stress tests:

- High-volume terminal output can grow queues or produce input echo spikes.
- Large diff rendering and file-tree work may still jank the renderer; patch parsing itself is now worker-backed.
- Detached daemon crash/restart/reload behavior is now covered by focused smoke tests at the main/preload/daemon boundary. Fake-socket lifecycle tests cover absent, stale, live, version-mismatch, and control timing states; real managed-`taod` tests cover owned-daemon process exit/restart and daemon exit during an in-flight control request; packaged reload smoke covers renderer reload, reattach to two existing daemon sessions, daemon-backed workspace list/refresh/remove, and persisted layout/settings resync from the fresh preload context.
- Adapter execution is now bounded and provenance-checked for the current local threat model: runner basenames are allowlisted, hung commands time out, raw stderr is redacted on nonzero exit, and group/other-writable adapter directories or scripts are skipped.
- Chromium flags are net-positive on current Electron 42 targets.

## Electron Main Process Review

Main is much closer to the intended boundary. Window creation and app lifecycle belong here; Git branches/status/file-tree/raw-diff/port/PR metadata now route through `taod`. `TaodClient` startup is reasonably scoped and now shared through `ensureTaodClient()`. It now exposes explicit lifecycle, daemon-ownership, and recovery-action diagnostics consumed by a compact renderer recovery indicator and diagnostics popover, exposes a narrow typed recovery IPC for safe current-action recovery, has fake-socket tests for core diagnostic/recovery states, has real managed-daemon restart/mid-request-crash/detached-release tests, has packaged two-session renderer reload/reattach plus workspace-resync and persisted layout/settings smoke coverage, and has short plus paced one-hour packaged app-soak budgets that repeat reload/reattach while enforcing main/renderer/taod RSS ceilings. The remaining lifecycle work is broader interactive user-flow coverage and any future external-daemon ownership model, not proving the basic renderer reload boundary from scratch.

Security settings are mixed: `contextIsolation: true`, `nodeIntegration: false`, and `webSecurity: true` are good. `sandbox: false` in `apps/desktop/src/main/index.ts` now has an explicit rationale because preload imports `clipboard`, `shell`, `ipcRenderer`, and MessagePort APIs; the durable fix is a separate sandbox-compatibility pass, not a blind flip.

The `before-quit` disposal path exists, but daemon survival means app quit is not terminal/session shutdown. That is now covered as an explicit product invariant in `test:taod-lifecycle`: detached `TaodClient.dispose()` leaves the real daemon process running so PTYs can survive Electron quit, while smoke/test paths still use attached daemons for cleanup.

## Preload + IPC Review

The preload does not expose raw `ipcRenderer`, which is correct. It exposes a broad app API, including session creation, input, resize, kill, workspace mutation, Git actions, layout/settings, clipboard, and external URL opening. The URL opener restricts to `http`/`https` in `apps/desktop/src/preload/index.ts:563`, which is good.

The weak point is now narrower than the initial review. Preload validates service messages, workspace responses, and daemon workspace/worktree mutation payloads through shared schemas before invoking main. Main validates daemon-backed workspace metadata and Git path-action payloads with shared schemas before calling `TaodClient`, and daemon handlers add their own path validation before running Git. Workspace/worktree mutation schemas now have negative and representative positive coverage. The remaining IPC security work is broader coverage for non-workspace APIs, clearer permission/confirmation semantics for destructive operations, and eventual tightening of `sandbox: false`.

## Effect 4 Beta Review

The installed Effect package is `effect@4.0.0-beta.66`, and the repo's `Context.Service`, `Layer.succeed`, `ManagedRuntime.make`, `Schema.decodeUnknownOption`, and `Effect.tryPromise` usage is compatible with the installed local types/source.

The architecture is still only partly Effect-shaped. The empty main `WorkspaceServiceLive` layer has been removed, so main now uses Effect directly at the IPC edge. Preload has one IPC service layer. Renderer query hooks use an Effect cache. This provides typed error wrappers, timeouts, and stale-result protection; forced renderer metadata refreshes now supersede older in-flight requests so user-triggered refresh is not blocked behind stale work. It is still not a coherent service graph for daemon lifecycle, command execution, cancellation, structured logging, retries, or resource finalizers.

Recommended stance: do not push Effect into terminal streams. Use Effect where it can own slow privileged workflows: workspace metadata, daemon control requests, settings/layout IO, and startup diagnostics.

## Renderer + React 19 Responsiveness Review

Terminal output avoids React state and writes directly to xterm through a batched writer, which is the right architecture. Terminal UI state in `TerminalPane` is limited to error/archive/search/resume status.

The renderer risk is sidebars and diffs. `App.tsx` is a large component with many Zustand selectors and local memoized transforms. Patch parsing now runs through `diff-parser.worker.ts`, which removes the most obvious synchronous parser cost from the renderer, and large full-pane diffs keep mounted `FileDiff` bodies bounded. Workspace file trees now prepare reset input with `@pierre/trees`' own sorter instead of assuming daemon byte-sort order matches the library's semantic order, and `bench:file-tree:budget` proves the virtualized tree keeps 50k paths under 100 ms reset / 150 ms max-frame / 750 DOM-node ceilings. The 250k local budget passes with about a 208 ms reset and about 200 rendered nodes, so DOM growth is bounded but the reset is still a visible frame. `bench:renderer-combined:budget` now adds a combined terminal/sidebar/diff pressure budget in one Electron renderer process with xterm WebGL, `@pierre/trees`, and `@pierre/diffs/react`.

## Terminal / PTY / Stream Throughput Review

The hot path is better than a generic Electron terminal: binary frames are used for streams, xterm writes are batched, resize events are RAF-coalesced, and daemon slow subscribers can be dropped.

The missing piece is cross-boundary flow control. `socket.write()` in TS now observes return values, but MessagePort posts still have no backpressure signal. Preload buffers are capped and now expose cumulative drop/truncation counters, and the xterm writer now has a bounded 4 MiB queue with oldest-output drop-down to 2 MiB plus visible drop notice when xterm stops draining. Daemon pending output is bounded, live subscribers are dropped after nonblocking write failure, and `bench:input-priority:budget` now proves input echo stays fast after a slow live subscriber is dropped. `bench:soak:budget` catches short direct-daemon RSS/subscriber/pending-output regressions, `bench:app-soak:budget` catches short packaged Electron/main/renderer/taod reload memory regressions, `bench:app-soak:hour` now gives a paced one-hour baseline, and `bench:app-trace` captures a real packaged-app Chromium trace with memory-infra categories for attribution.

## Zig Daemon Systems Review

The daemon is much stronger than a helper script. It has explicit session invariants, `deinit` paths, owner-only socket paths, peer checks, bounded payloads, and leak-check coverage. Resource ownership is visible in `TerminalSession.deinit`, `pty.Child.close`, and SQLite row deinit patterns.

Concerns:

- Detached threads make shutdown and cancellation less deterministic.
- Initial snapshot/backlog uses blocking writes by design in `apps/daemon/src/daemon/stream.zig:93`; that is correct for hydration but needs a timeout or byte/time budget.
- Several expensive Git operations unlock daemon state while they run, then re-check some database boundaries. This is correct in places, but should be systematically tested for races.

## Zig Daemon Security Review

Good security properties:

- Owner-only root/run dirs and socket mode in `apps/daemon/src/daemon/server.zig:13`.
- Stale socket refuses unsafe paths in `apps/daemon/src/daemon/server.zig:207`.
- Peer UID validation on Linux/macOS in `apps/daemon/src/daemon/server.zig:241`.
- Git commands use argv arrays in `apps/daemon/src/git.zig:66`.
- Worktree path containment is checked in `apps/daemon/src/worktree.zig:129`.

Remaining risks:

- Same-user renderer compromise can still drive broad local operations through exposed app APIs. That is partly accepted by desktop app trust, but daemon should still validate IDs/paths strictly.
- Adapter runner selection via env var should be constrained.
- Payload limits are high: 64 MB stream payloads and 64 MB event-log payloads need DoS tests and documented rationale.

## Electron ↔ Zig Protocol Review

The protocol has the right shape: NDJSON control plane plus binary stream frames. It has request IDs, frame version, CRC, max payload constants, session IDs, seq numbers, snapshots, agent frames, and error fields.

What is partially done:

- Shared golden fixtures now exercise ping, attach, error, stream output, resize, exit, snapshot, corrupt CRC rejection, and daemon-backed workspace metadata/path-action request shapes from both TS and Zig tests.

What is missing:

- Central spec and complete golden fixture coverage for every control request/response.
- Version/capability negotiation on ping.
- Cancellation for long workspace/worktree operations.
- Stable machine-readable error codes on every failure path.
- Backpressure semantics.
- Resync contract after renderer reload or daemon restart. Packaged reload smoke now covers two terminal session reattaches and daemon-backed workspace list/refresh/remove after renderer reload; daemon-restart resync and full UI state restoration still need broader coverage.

Hardening path:

1. Central spec.
2. Golden fixtures.
3. TS schema validation.
4. Zig parser validation.
5. Contract tests.
6. Version/capability negotiation.
7. Bounded payloads.
8. Backpressure and cancellation.

## Workspace / Worktree / Git Review

Worktree creation/removal has good defensive checks: safe names, UUID folder generation, path containment, dirty checks before remove, external worktree archive behavior, and database uniqueness re-checks after unlocked Git calls.

The larger design issue has been reduced substantially. `taod` owns durable workspace/worktree state, and Git current-branch, branch-list, worktree-list, status, file-tree, raw-diff, stage/unstage/revert path actions, port, and PR metadata now route through daemon control RPCs. The 50k-file and 250k-file profiles are under budget for branches/status/file-tree/diff/PR, with ports still bounded separately because macOS `lsof` dominates. Renderer file-tree consumption now has explicit budgets, and the combined renderer pressure budget exercises terminal output while sidebar-scale file tree and diff work happen in the same renderer process.

The recursive `lsof +D` issue has been fixed. Current-branch metadata has moved to `workspace.branch`, Git worktree-list metadata has moved to `workspace.gitWorktrees`, Git status has moved to `workspace.status`, file-tree metadata has moved to `workspace.fileTree`, raw diff generation has moved to `workspace.diff`, stage/unstage/revert path actions have moved to `workspace.stagePath`/`workspace.unstagePath`/`workspace.revertPath`, bounded port metadata has moved to `workspace.ports`, and PR metadata has moved to `workspace.pullRequest`. The remaining Electron main Git ownership is metadata watching and refresh scheduling through `GitStateWatcher`; it now exposes typed diagnostics for watcher count, queued/in-flight/pending refreshes, refresh failures, notification count, last refresh reason, and refresh duration so refresh storms can be measured before deciding whether this policy should move into `taod`.

## Build / Packaging / Dependency Review

The build pins Zig `0.15.2`, imports sqlite and ghostty-vt, builds `taod`, and copies the binary/adapters into Electron output. That is good.

The risk is proof, not intent. Runtime path discovery has many fallbacks. The current package smoke now verifies the built output layout, runs the copied `taod` binary with `--check`, checks copied adapters, launches the packaged Electron entrypoint, creates a terminal session through the real preload API, observes terminal output, and kills the smoke session.

## Benchmark + Profiling Review

Benchmark scripts exist: latency, renderer, IPC, cross-terminal, startup, taod comparison, and all. CI runs only `pnpm bench` on Linux, which maps to `apps/desktop/bench/benchmark.ts`, not the full set of startup/renderer/IPC/taod scripts.

The missing part is no longer benchmark existence or scheduling policy; it is acting on the data. Renderer sustained-output, combined renderer pressure, Electron IPC, file-tree renderer consumption, packaged startup, direct `taod` input latency, direct slow-subscriber input priority, direct attach/replay, direct `taod` churn/RSS soak, packaged renderer/preload input echo under output, packaged Electron/taod throughput, packaged Electron app-soak smoke budgets, a packaged-app trace command, a trace summary command, and a paced one-hour packaged app-soak baseline now exist. All smoke-size budgets are represented in macOS CI. 50k-file and 250k-file workspace budgets exist locally, and a 250k file-tree renderer budget exists locally. The one-hour soak and trace capture are in a separate scheduled/manual macOS workflow.

## Observability Review

There are logs, but not a fully correlated diagnostic model. Request IDs exist in control messages, and `TaodClient` now exposes lifecycle state/timeline, control request count/failure/last-duration diagnostics, startup/ping timing, a stable `clientTraceId`, per-control-request `traceId`, daemon response `trace_id` echoes, daemon-side control counters/last-trace diagnostics through preload, renderer `tao:*` user-timing spans in Chromium traces, daemon failed/slow control request logs with trace ids, and Git metadata watcher diagnostics for refresh scheduling decisions. The remaining gap is broader correlation to user-visible UI actions, not the core renderer/main/daemon trace handle.

Minimal observability:

- Startup timeline: app ready, window created, renderer ready, port sent, daemon ping/start lifecycle transition, attach response, first output, first paint. Daemon ping/start timing now exists in `TaodLifecycleDiagnostics.timing`, control requests carry a `traceId`, valid daemon responses echo it as `trace_id`, daemon ping diagnostics expose request count/failure/last-trace/last-duration, daemon failed/slow logs print trace ids, and renderer user-timing marks expose app/layout plus terminal create/attach/reveal/ready spans to `bench:app-trace:summary`.
- Counters: active sessions, subscribers, queued bytes, dropped subscribers, pending output bytes, reconnects, restarts, PTY bytes/sec, xterm queued chars, workspace refresh latency. `TaodClient` control request count/failure/last-duration exists, and daemon control request count/failure/last-trace exists.
- Diagnostics export that redacts cwd/argv if needed.

## Testing / CI Review

Current proof is solid for daemon unit/resource basics. The daemon test suite covers many OOM, parser, stale socket, peer owner, pending output, VT, persistence, workspace, and worktree cases.

Missing proof:

- TS/Zig protocol golden tests.
- IPC contract tests.
- `TaodClient` daemon startup/restart/version mismatch tests. Fake-socket lifecycle tests now cover absent/stale/live/version-mismatch/request timing, `test:taod-lifecycle` covers real owned-daemon process exit/restart plus daemon exit during an in-flight control request, and `bench:reload:budget` covers packaged renderer reload reattach for two sessions plus daemon-backed workspace resync from the fresh preload context.
- Full interactive UI-state reload/resync tests beyond the scripted persisted layout/settings smoke.
- Performance smoke budgets. Current CI smoke now covers packaged startup, reload, app-soak memory/reload, taod throughput, direct latency, input-priority, attach/replay, workspace metadata, terminal renderer, combined renderer pressure, IPC, and file-tree renderer subsets.
- Large repo/diff/full-app renderer tests now have smoke coverage through workspace metadata, file-tree renderer, and combined renderer pressure budgets; `pnpm bench:app-trace` now captures a packaged-app Chromium trace for deeper profiling.

## Quick Wins

- Done: add protocol version/capabilities to ping response and validate in `TaodClient`.
- Done: add shared schemas for `workspace:add`, `worktree:create`, `worktree:remove`, and stop coercing invalid IDs to `''`.
- Done: add `socket.write()` return-value handling in `TaodSessionStream.writeFrame` and control request writes.
- Done: add diagnostics counters for xterm queued chars and preload pending output chars.
- Done: add `TAOD_ADAPTER_RUNNER` allowlist or disable it outside dev.
- Done: add a CI note or guard that Windows artifacts are unsupported until daemon support exists.
- Done: fix current formatting issue in `packages/shared/src/workspace.ts`.

## Medium Projects

- Done for CI smoke plus 50k and 250k local profiles: add daemon-backed workspace metadata benchmarks now that Git, port, and PR metadata route through daemon services with typed request/response schemas. Keep these as manual profiles unless CI time budgets explicitly allow the large synthetic repos.
- Build TS/Zig protocol fixture tests.
- Mostly done: add daemon lifecycle state machine and startup timeline diagnostics. Lifecycle state snapshot exists, fake-socket lifecycle tests cover the failure matrix basics, real managed-daemon restart/mid-request-crash tests exist, packaged two-session renderer reload plus workspace, layout, and settings resync smoke exists, and typed daemon ping/start timing now crosses preload. Full renderer/main/daemon trace-id correlation and broader interactive UI-state coverage remain.
- Add packaged macOS smoke test for `taod` and adapters.
- Add large-output terminal throughput benchmark with memory and frame-time recording.

## Larger Refactors

- Make `taod` the single owner for workspace metadata and Git process execution.
- Introduce an explicit protocol spec/codegen or fixture-driven contract package.
- Add controlled daemon shutdown and joinable thread model for tests.
- Move remaining renderer diff render preparation and any file-tree reset work that must meet a 50 ms frame budget to workers or daemon-generated summaries with true virtualization.

## Recommended Execution Order

1. Done: fix `pnpm check` formatting failure.
2. Done: add protocol version/capability ping and TS/Zig golden fixtures for the current control and stream-frame contract.
3. Mostly done: add observability counters/timelines for startup and terminal streams. Terminal queue diagnostics, taod lifecycle diagnostics, control request timing, taod ping/start timing, client/control-request trace ids, daemon response trace echoes, daemon control counters/last-trace diagnostics, renderer `tao:*` user-timing spans, and daemon failed/slow trace-id logging exist.
4. Done: add a packaged Electron smoke budget for a small terminal throughput path and preload pending-message queue.
5. Done: add an enforcing xterm/WebGL sustained-output benchmark budget and record the current local baseline.
6. Mostly done: add daemon/socket throughput, backpressure, and memory-growth benchmarks for sustained terminal output. `pnpm bench:taod:budget` now covers a packaged Electron/taod 1 MiB throughput path with pending-output and RSS ceilings, `pnpm bench:soak:budget` covers short direct-daemon session churn/RSS cleanup, `pnpm bench:app-soak:budget` covers a short packaged Electron/main/renderer/taod reload memory path, and `pnpm bench:app-soak:hour` has a paced one-hour local baseline.
7. Mostly done: patch TS write/backpressure handling and queue budgets. Socket write handling is done; package-smoke pending-output budgets exist; slow-subscriber drops and pending-output truncation are observable; `pnpm bench:input-priority:budget` proves input echo latency while an unread subscriber is dropped; `pnpm bench:app-soak:budget` and `pnpm bench:app-soak:hour` add short and one-hour full-app memory regression coverage; `pnpm bench:app-trace:summary` gives repeatable short-trace attribution. The remaining gap is acting on future long-session RSS regressions.
8. Mostly done: add daemon lifecycle integration tests for stale socket, crash, restart, renderer reload, app quit. Lifecycle diagnostics are now exposed, fake-socket tests cover stale/live/incompatible states, `test:taod-lifecycle` covers real owned-daemon process exit/restart, daemon exit during an in-flight control request, and detached daemon survival across client disposal for Electron quit semantics. `bench:reload:budget` covers packaged two-session renderer reload reattach, daemon-backed workspace resync, and persisted layout/settings resync from the fresh preload context. Remaining work is broader interactive UI-state scenarios, not the core reload boundary.
9. Done for ports, file-tree metadata, raw diff, and renderer patch parsing: remove `lsof +D` from Electron main, move port/file-tree/raw-diff metadata to `taod`, and move patch parsing off the renderer thread.
10. Done: add packaged-output smoke test for `taod`, adapters, and a real Electron/preload terminal session.
11. Done for smoke plus long profile: add CI performance smoke budgets after baselines stabilize. Startup, terminal renderer, combined renderer pressure, IPC, file-tree renderer, direct `taod` latency, direct slow-subscriber input priority, attach/replay, workspace metadata, short direct `taod` soak, packaged app-soak, packaged input echo, and packaged throughput budgets now run in macOS CI; 50k-file and 250k-file workspace profiles plus a 250k file-tree renderer profile are available locally; the paced one-hour packaged app-soak and packaged trace capture run in a separate weekly/manual macOS workflow.

## Suggested CI / Regression Checks

- Formatting: `pnpm fmt:check`.
- TypeScript typecheck: `pnpm tsc`.
- Lint: `pnpm lint`.
- Desktop protocol/persistence tests: `pnpm test:persistence`.
- Zig format/check/tests: `pnpm zig:check`.
- Zig leak check: `pnpm zig:leak-check`.
- Protocol golden tests: new `pnpm test:protocol`.
- Startup smoke: new packaged-app smoke on macOS build artifact, including `taod --check`, adapter presence, Electron/preload session creation, first-output timing, renderer-load timing, process launch timing, small terminal throughput budget, smoke-daemon cleanup, packaged two-session renderer reload reattach, daemon-backed workspace resync after reload, and real owned-daemon restart coverage through `pnpm --filter @tao/desktop test:taod-lifecycle`.
- Performance smoke: current macOS CI runs `pnpm bench:terminal:budget`, `pnpm bench:ipc:budget`, `pnpm bench:file-tree:budget`, and `pnpm bench:renderer-combined:budget` with generous thresholds and uploads the logs; the macOS production-build job now also runs `pnpm bench:startup:budget`, `pnpm bench:latency:budget`, `pnpm bench:input-priority:budget`, `pnpm bench:attach:budget`, `pnpm bench:workspace:budget`, `pnpm bench:soak:budget`, `pnpm bench:reload:budget`, `pnpm bench:app-soak:budget`, and `pnpm bench:taod:budget` against the built Electron/taod artifact and uploads `startup-budget.txt`/`latency-budget.txt`/`input-priority-budget.txt`/`attach-budget.txt`/`workspace-budget.txt`/`soak-budget.txt`/`reload-budget.txt`/`app-soak-budget.txt`/`taod-budget.txt`. Manual large-repo/profile scripts are `pnpm bench:workspace:large`, `pnpm bench:workspace:large:budget`, `pnpm bench:workspace:xl`, `pnpm bench:workspace:xl:budget`, `pnpm bench:file-tree:xl:budget`, and the longer packaged reload soak `pnpm bench:app-soak`. The long non-PR workflow runs `pnpm bench:app-trace`, `pnpm bench:app-trace:summary`, and `pnpm bench:app-soak:hour` weekly and on manual dispatch.

## Profiling Plan

- Electron startup: instrument `app.whenReady`, `createWindow`, `loadURL/loadFile`, `renderer:ready`, `pty:port`, daemon ping/start, attach response, first output, first visible render.
- taod startup: time `prepareStorage`, database open/migrations, socket bind, first ping.
- UI action -> daemon response latency: wrap every preload/main `workspace:*` and `worktree:*` call with request ID and duration.
- Terminal input latency: timestamp xterm `onData`, main stream write, daemon frame parse, PTY write, PTY output read, renderer xterm callback.
- Terminal output throughput: run high-volume command, record bytes/sec, queued bytes, dropped subscribers, xterm write drain time.
- Renderer jank: run `pnpm bench:renderer-combined:budget` for the CI smoke, then run `pnpm bench:app-trace` to capture a packaged-app Chromium trace with Electron/timeline/V8/GPU/scheduler/memory-infra categories at `apps/desktop/out/bench/electron-smoke-trace.json`.
- Main process CPU: sample while loading large repo metadata and port discovery; verify no recursive `lsof +D` is used.
- Daemon CPU: sample during PTY flood, attach replay, VT snapshot, workspace refresh.
- Memory leaks: run `pnpm bench:app-soak:budget` as the CI smoke, `pnpm bench:app-soak` as the longer packaged reload/reattach profile, then run `pnpm bench:app-soak:hour` for the paced 1-hour scripted session with attach/detach/reload and Electron main, renderer, and `taod` RSS. The current local one-hour baseline completed 60 reload cycles with renderer RSS growth 239,472 KiB and `taod` RSS growth 297,152 KiB; follow with heap/allocator profiling before tightening the hour budget.
- Socket/protocol volume: count control requests, stream frames, bytes, average frame size, max queued bytes.
- File tree/diff performance: run `pnpm bench:workspace:large:budget` for 50k daemon metadata, `pnpm bench:workspace:xl:budget` for 250k daemon metadata, `pnpm bench:file-tree:budget` / `pnpm bench:file-tree:xl:budget` for renderer file-tree consumption, and profile 1/5/20 MB patches in the renderer.
- Workspace/worktree operations: time create/remove/refresh and dirty checks on normal and large repos.
- Bundle size: track renderer bundle and xterm addon contribution.
- Daemon binary size: record `zig-out/bin/taod` size per build and fail on large unexpected jumps.

## Commands Run

- `git status --short --branch`: repo on `best-operation...origin/best-operation`; existing modified source files present before report creation.
- `rg ... /Users/dp/.codex/memories/MEMORY.md`: used prior Tao context only as a routing hint; current repo was re-inspected.
- `pwd && rg --files ...`: confirmed workspace root and key package/config files.
- Static inspection with `nl`, `find`, and `rg`: inspected requested package files, desktop main/preload/renderer files, daemon files, shared schemas, benches, and CI.
- `pnpm --filter @tao/desktop tsc`: passed.
- `pnpm --filter @tao/desktop lint`: passed, 0 warnings/errors.
- `pnpm --filter @tao/desktop fmt:check`: passed.
- `pnpm --filter @tao/daemon fmt:check`: passed.
- `pnpm --filter @tao/daemon test`: passed, 93 tests.
- `pnpm zig:check`: passed, including Zig lint, fmt check, and 93 daemon tests.
- Initial `pnpm check`: failed at `fmt:ts:check`; `packages/shared/src/workspace.ts` and `report.md` had format issues. Earlier lint phase passed.
- `pnpm test:persistence`: passed, 12 tests. Node emitted a `module.register()` deprecation warning.
- `pnpm zig:leak-check`: passed.
- `git diff --stat`: used to confirm source scope before and after follow-up implementation.
- Follow-up `pnpm fmt:ts:check`: passed after formatting `packages/shared/src/workspace.ts`, `report.md`, and touched TS files.
- Follow-up `pnpm --filter @tao/desktop tsc`: passed after protocol compatibility and write-backpressure changes.
- Follow-up `pnpm --filter @tao/daemon fmt:check`: passed after Zig ping protocol changes.
- Follow-up `pnpm --filter @tao/daemon test`: passed, 94 tests including `daemon control RPC ping reports protocol identity`.
- Follow-up `pnpm --filter @tao/daemon test` after adapter runner hardening: passed, 95 tests including `agent adapter runner allowlist rejects shell-shaped env runners`.
- Follow-up `pnpm check` after adapter runner hardening: passed end to end, including 12 persistence tests and 95 daemon tests.
- Follow-up `pnpm --filter @tao/desktop tsc` after IPC input schema wiring: passed.
- Follow-up `pnpm --filter @tao/shared tsc`: passed.
- Follow-up `pnpm --filter @tao/desktop lint`: passed, 0 warnings/errors.
- Follow-up `pnpm --filter @tao/shared lint`: passed, 0 warnings/errors.
- Follow-up `pnpm check` after IPC input schema wiring: passed end to end.
- CI Windows packaging guard added in `.github/workflows/ci.yml`; no local CI runner was available to execute GitHub Actions.
- Follow-up `pnpm check` after CI guard/report updates: passed end to end.
- Follow-up `pnpm --filter @tao/desktop tsc` after terminal diagnostics: passed.
- Follow-up `pnpm --filter @tao/desktop test:persistence` after terminal diagnostics: passed, 14 tests.
- Follow-up `pnpm check` after terminal diagnostics: passed end to end, including 14 desktop tests and 95 daemon tests.
- Follow-up `pnpm --filter @tao/desktop test:persistence` after initial protocol fixtures: passed, 15 tests.
- Follow-up `pnpm --filter @tao/daemon test` after initial protocol fixtures: passed, 97 tests.
- Follow-up `pnpm check` after initial protocol fixtures: passed end to end, including 15 desktop tests and 97 daemon tests.
- Follow-up `pnpm --filter @tao/desktop test:persistence` after expanded protocol fixtures: passed, 17 tests.
- Follow-up `pnpm --filter @tao/daemon test` after expanded protocol fixtures: passed, 100 tests.
- Follow-up `pnpm check` after expanded protocol fixtures: passed end to end, including 17 desktop tests and 100 daemon tests.
- `pnpm smoke:package`: passed against the current `apps/desktop/out` output; verified the bundled `taod --check` path and copied adapters. Node emitted a `module.register()` deprecation warning.
- Follow-up `pnpm tsc` after package smoke wiring: passed.
- Follow-up `pnpm build` after package smoke wiring: passed; rebuilt `taod`, copied it to `apps/desktop/out/bin/taod`, copied adapters, and produced Electron main/preload/renderer output.
- Follow-up `pnpm smoke:package` after fresh build: passed; verified the rebuilt packaged-output `taod --check` path and copied adapters. Node emitted a `module.register()` deprecation warning.
- Follow-up `pnpm check` after package smoke wiring: passed end to end, including 17 desktop tests and 100 daemon tests.
- Follow-up `pnpm --filter @tao/desktop tsc` after Electron launch smoke wiring: passed.
- Follow-up `pnpm --filter @tao/desktop build` after Electron launch smoke wiring: passed; rebuilt `taod`, Electron main/preload/renderer output, and copied adapters.
- Follow-up `pnpm smoke:package` after Electron launch smoke wiring: passed; verified package layout, bundled `taod --check`, copied adapters, packaged Electron startup, preload API session creation, terminal output delivery, and smoke session kill. Node emitted a `module.register()` deprecation warning.
- Follow-up `pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop build && pnpm smoke:package` after formatting: passed; reverified the full package/Electron/preload terminal session smoke path.
- Follow-up `pnpm check` after Electron launch smoke wiring: passed end to end, including 17 desktop tests and 100 daemon tests.
- Follow-up `pnpm --filter @tao/desktop tsc` after terminal-throughput smoke wiring: passed.
- Follow-up `pnpm --filter @tao/desktop build && pnpm smoke:package` after terminal-throughput smoke wiring: build passed, but the initial synchronous smoke harness timed out after `[electron-smoke] passed`; no temp-home daemon was left behind.
- Follow-up `pnpm smoke:package` after async smoke harness update: passed; verified package layout, bundled `taod --check`, copied adapters, packaged Electron startup, preload API session creation, at least 16 KiB terminal output at >= 4 KiB/s, no pending preload client messages, smoke session kill, and no leftover smoke daemon process. Node emitted a `module.register()` deprecation warning.
- Final `pnpm check` after terminal-throughput smoke and teardown updates: passed end to end, including lint, format check, TypeScript, 17 desktop tests, and 100 daemon tests.
- Final process check after smoke runs: no Electron/package-smoke processes and no temp-home smoke `taod` were left running; only the pre-existing long-lived detached `taod` process remained.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check`: passed after the report command log update.
- `pnpm --filter @tao/desktop tsc` after xterm/WebGL benchmark budget wiring: passed.
- `pnpm bench:terminal:budget`: passed with WebGL active; 8 MiB sustained output measured 9.3 MB/s, p95 frame 9.90 ms, and 1 frame over 16 ms against the default budget of >= 8 MB/s, p95 <= 33 ms, and <= 120 frames over 16 ms. Node emitted a `module.register()` deprecation warning.
- Follow-up `pnpm check` after xterm/WebGL benchmark budget wiring: passed end to end, including lint, format check, TypeScript, 17 desktop tests, and 100 daemon tests.
- Attempted daemon/socket throughput budget harness runs with `pnpm bench:taod:budget`: failed because the standalone attach stream timed out without receiving output frames, even after reusing Tao's real TS stream parser/encoder. That attempted command was backed out instead of leaving a failing script in the repo.
- Follow-up `pnpm check` after backing out the failed daemon/socket throughput budget harness: passed end to end, including lint, format check, TypeScript, 17 desktop tests, and 100 daemon tests.
- Follow-up `pnpm --filter @tao/desktop tsc` after replacing `lsof +D`: passed.
- `rg "lsof.*\\+D|\\+D" apps/desktop/src apps/daemon/src`: no source matches; remaining matches are only historical report findings.
- Follow-up `pnpm check` after replacing `lsof +D`: passed end to end, including lint, format check, TypeScript, 17 desktop tests, and 100 daemon tests.
- Follow-up `pnpm --filter @tao/desktop tsc` after large-diff auto-collapse guard: passed.
- Follow-up `pnpm --filter @tao/desktop tsc` after deferred diff parsing inputs: passed.
- Follow-up `pnpm check` after deferred diff parsing inputs: passed end to end, including lint, format check, TypeScript, 17 desktop tests, and 100 daemon tests.
- Follow-up `pnpm --filter @tao/desktop tsc` after moving diff parsing to a renderer worker: passed.
- Follow-up `pnpm --filter @tao/desktop build` after moving diff parsing to a renderer worker: passed; Vite emitted a separate `diff-parser.worker-*.js` asset and rebuilt main/preload/renderer output. Node emitted a `module.register()` deprecation warning during the build.
- `pnpm exec oxfmt apps/desktop/src/renderer/diff-parser.ts apps/desktop/src/renderer/diff-parser-client.ts apps/desktop/src/renderer/diff-parser.worker.ts apps/desktop/src/renderer/ui/App.tsx`: formatted the worker/parser/client/App changes.
- Follow-up `pnpm check` after moving diff parsing to a renderer worker: passed end to end, including lint, format check, TypeScript, 17 desktop tests, and 100 daemon tests.
- Accidental malformed `rg` command with shell backticks: zsh expanded an embedded `pnpm --filter @tao/desktop build` while trying to search `report.md`, so the desktop build reran and passed before `rg` failed on an invalid regex. No source file was edited by that command.
- Corrected `rg -n 'worker-backed|diff-parser\\.worker|Full repo check currently fails|No packaged smoke|lsof \\+D|Diff work is synchronous|packaged smoke proof' report.md`: used to find stale report wording after the worker/report edits.
- `pnpm fmt:ts:check` after report updates: passed.
- `pnpm exec oxfmt apps/desktop/src/renderer/ui/App.tsx && pnpm --filter @tao/desktop tsc` after adding the large-diff mounted-body cap: passed.
- Final `pnpm exec oxfmt report.md && pnpm check` after the mounted-body cap and report updates: passed end to end, including lint, format check, TypeScript, 17 desktop tests, and 100 daemon tests.
- Second accidental malformed `rg` command with shell backticks while checking report text: zsh expanded the embedded final-check command, so `pnpm exec oxfmt report.md && pnpm check` reran and passed before `rg` failed on a multiline regex. No source file was edited by that command.
- `TAO_TERMINAL_BENCH_MIB=4 TAO_TERMINAL_MIN_WEBGL_MBPS=2 TAO_TERMINAL_MAX_P95_FRAME_MS=80 TAO_TERMINAL_MAX_FRAMES_OVER_16=1000 pnpm bench:terminal:budget`: passed with WebGL active; 4 MiB sustained output measured 9.4 MB/s, p95 frame 10.00 ms, and 0 frames over 16 ms against the new CI smoke thresholds.
- `pnpm fmt:ts:check` after adding the CI performance-smoke job: passed.
- Final `pnpm exec oxfmt report.md && pnpm check` after adding the CI performance-smoke job and report updates: passed end to end, including lint, format check, TypeScript, 17 desktop tests, and 100 daemon tests.
- `pnpm --filter @tao/desktop tsc` after adding `TaodClient` lifecycle diagnostics and read-only preload diagnostics: passed.
- `pnpm --filter @tao/shared tsc` after adding shared lifecycle diagnostic schemas/types: passed.
- `pnpm --filter @tao/desktop build` after lifecycle diagnostics: passed; rebuilt `taod`, copied adapters, and rebuilt Electron main/preload/renderer output.
- `pnpm smoke:package` after lifecycle diagnostics: passed; the smoke path now asserts `getTaodDiagnostics()` returns a live daemon state through the real renderer/preload/main boundary.
- Final `pnpm exec oxfmt report.md && pnpm check` after lifecycle diagnostics source changes: passed end to end, including lint, format check, TypeScript, 17 desktop tests, and 100 daemon tests.
- Final process check after lifecycle smoke: no Electron/package-smoke/temp smoke daemon remained; only the pre-existing long-lived detached `taod` process was present.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check` after the lifecycle report update: passed.
- `pnpm --filter @tao/desktop tsc && pnpm --filter @tao/shared tsc` after adding control-request timing diagnostics: passed.
- `pnpm --filter @tao/desktop build && pnpm smoke:package` after adding control-request timing diagnostics: passed; the smoke path now asserts `getTaodDiagnostics()` recorded control request timing through the real renderer/preload/main boundary.
- Final `pnpm exec oxfmt report.md && pnpm check` after control-request timing diagnostics and report updates: passed end to end, including lint, format check, TypeScript, 17 desktop tests, and 100 daemon tests.
- Final process check after control-request timing smoke: no Electron/package-smoke/temp smoke daemon remained; only the pre-existing long-lived detached `taod` process was present.
- `pnpm --filter @tao/daemon test` after adding the `workspace.status` daemon RPC: passed, 100 daemon tests.
- `pnpm --filter @tao/desktop tsc` after routing `workspace:getGitStatus` through `taod`: passed.
- `pnpm --filter @tao/daemon fmt:check` after the `workspace.status` Zig changes: passed.
- Final `pnpm check` after moving workspace Git status to `taod`: passed end to end, including lint, format check, TypeScript, 17 desktop tests, and 100 daemon tests.
- Accidental malformed `rg` command with shell backticks while checking report text: zsh expanded `workspace:getGitStatus` and an embedded `pnpm check` fragment, so the daemon test reran and passed before `rg` failed on an invalid multiline regex. No source file was edited by that command.
- Corrected `rg -n 'branch/status|status, branches|still computes branch/status|lsof \\+D issue has been fixed|workspace\\.status|workspace:getGitStatus|moving workspace Git status' report.md`: used to verify the report wording for the Git status ownership update.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check` after the Git status report update: passed.
- `pnpm --filter @tao/daemon fmt:check && pnpm --filter @tao/daemon test` after adding the real Git-backed `workspace.status` handler test: passed, 101 daemon tests.
- Final `pnpm check` after preserving untracked-file status semantics in `workspace.status`: passed end to end, including lint, format check, TypeScript, 17 desktop tests, and 101 daemon tests.
- `pnpm --filter @tao/daemon fmt:check` after adding the `workspace.fileTree` daemon RPC: passed.
- `pnpm --filter @tao/daemon test` after adding the `workspace.fileTree` daemon RPC and Git-backed handler test: passed, 102 daemon tests.
- `pnpm --filter @tao/desktop tsc` after routing `workspace:getWorkspaceFileTree` through `taod`: passed.
- `pnpm exec oxfmt report.md apps/desktop/src/main/index.ts apps/desktop/src/main/taod-client.ts apps/desktop/src/main/workspace-service.ts && pnpm fmt:ts:check` after the file-tree report update: passed.
- Final `pnpm check` after moving workspace file-tree metadata to `taod`: passed end to end, including lint, format check, TypeScript, 17 desktop tests, and 102 daemon tests.
- `pnpm --filter @tao/daemon fmt:check` after adding the `workspace.diff` daemon RPC: passed.
- `pnpm --filter @tao/daemon test` after adding the `workspace.diff` daemon RPC and Git-backed staged-diff handler test: passed, 103 daemon tests.
- `pnpm --filter @tao/desktop tsc` after routing `workspace:getWorkspaceDiffPatch` through `taod`: passed.
- `pnpm exec oxfmt report.md apps/desktop/src/main/index.ts apps/desktop/src/main/taod-client.ts apps/desktop/src/main/workspace-service.ts && pnpm fmt:ts:check` after the raw-diff report update: passed.
- Final `pnpm check` after moving workspace raw diff generation to `taod`: passed end to end, including lint, format check, TypeScript, 17 desktop tests, and 103 daemon tests.
- `pnpm --filter @tao/daemon fmt:check` after adding the `workspace.ports` daemon RPC: passed.
- `pnpm --filter @tao/daemon test` after adding the `workspace.ports` daemon RPC and port parser test: passed, 104 daemon tests.
- `pnpm --filter @tao/desktop tsc` after routing `workspace:getWorkspacePorts` through `taod`: passed.
- `pnpm exec oxfmt report.md apps/desktop/src/main/index.ts apps/desktop/src/main/taod-client.ts apps/desktop/src/main/workspace-service.ts && pnpm fmt:ts:check` after the port metadata report update: passed.
- Final `pnpm check` after moving workspace port metadata to `taod`: passed end to end, including lint, format check, TypeScript, 17 desktop tests, and 104 daemon tests.
- `pnpm --filter @tao/daemon fmt:check` after adding the `workspace.pullRequest` daemon RPC: passed.
- `pnpm --filter @tao/daemon test` after adding the `workspace.pullRequest` daemon RPC and PR JSON parser test: passed, 105 daemon tests.
- `pnpm --filter @tao/desktop tsc` after routing `workspace:getPullRequestInfo` through `taod`: passed.
- `pnpm exec oxfmt report.md apps/desktop/src/main/index.ts apps/desktop/src/main/taod-client.ts apps/desktop/src/main/workspace-service.ts && pnpm fmt:ts:check` after the PR metadata report update: passed.
- Final `pnpm check` after moving workspace PR metadata to `taod`: passed end to end, including lint, format check, TypeScript, 17 desktop tests, and 105 daemon tests.
- `git status --short` before daemon stream diagnostics: confirmed the existing dirty worktree and preserved unrelated/user changes.
- `rg -n ... report.md`: re-read the open report items and confirmed terminal backpressure/memory-growth proof remained high priority.
- `rg -n ... apps/desktop/src/main apps/desktop/src/preload apps/desktop/src/renderer apps/desktop/bench apps/daemon/src package.json apps/desktop/package.json`: inspected the current stream, diagnostics, and benchmark surfaces before editing.
- `pnpm --filter @tao/daemon fmt:check` after adding daemon stream diagnostics: passed.
- `pnpm --filter @tao/desktop tsc` after wiring stream diagnostics through shared schema, `TaodClient`, main IPC, and package smoke: passed.
- `pnpm --filter @tao/daemon test` after adding stream diagnostics counters and fixture updates: passed, 106 daemon tests including stream diagnostics backlog/totals coverage and updated golden protocol fixtures.
- `pnpm exec oxfmt report.md apps/desktop/src/main/index.ts apps/desktop/src/main/taod-client.ts packages/shared/src/taod-protocol.ts packages/shared/fixtures/taod-protocol/control-ping-response.ndjson packages/shared/fixtures/taod-protocol/control-attach-response.ndjson packages/shared/fixtures/taod-protocol/control-error-response.ndjson && pnpm fmt:ts:check` after stream diagnostics/report updates: passed.
- `pnpm --filter @tao/shared tsc` after adding the shared stream diagnostics schema: passed.
- `pnpm --filter @tao/desktop build && pnpm smoke:package` after extending package smoke to assert daemon stream diagnostics: passed; rebuilt `taod`, copied adapters, rebuilt Electron output, launched the packaged Electron entrypoint, observed terminal output, and confirmed stream diagnostics reported output bytes through the real preload/main/daemon path.
- Final `pnpm exec oxfmt report.md && pnpm check` after daemon stream diagnostics: passed end to end, including lint, format check, TypeScript, 17 desktop tests, and 106 daemon tests.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check` after recording daemon stream diagnostics commands: passed.
- Final `git status --short`: confirmed the worktree remains dirty with the expected ongoing review/fix files and new stream diagnostics edits; no unrelated files were reverted.
- Final `pgrep -fl 'package-smoke|Electron|TAO_ELECTRON_SMOKE|taod' || true`: no package-smoke or smoke Electron process remained; only unrelated app crashpad helpers and the pre-existing long-lived detached `taod` process were present.
- `pnpm --filter @tao/desktop tsc` after the first package-smoke RSS budget wiring: failed on a nullable diagnostics type; fixed before continuing.
- `pnpm fmt:ts:check` after the first package-smoke RSS budget wiring: passed.
- `pnpm --filter @tao/desktop build`: passed after the first package-smoke RSS budget wiring.
- Initial `pnpm bench:taod:budget`: failed because the smoke-owned `taod` exited with `SIGABRT`.
- Follow-up `pnpm smoke:package`: failed with the same smoke-owned `taod` `SIGABRT`.
- `pnpm --filter @tao/desktop tsc` after adding smoke-owned daemon stderr piping: initially failed on `stdio` typing; fixed with `StdioOptions` before continuing.
- `pnpm --filter @tao/desktop build && pnpm smoke:package` after adding smoke-owned daemon stderr piping: failed, but now captured the Zig panic stack in the Electron smoke log. The panic was `TerminalSession.assertInvariants` during synthetic/reader exit transition while PTY ownership was still set.
- `pnpm --filter @tao/daemon fmt:check` after fixing the exited-transition ordering: passed.
- `pnpm --filter @tao/daemon test` after fixing the exited-transition ordering: passed, 107 daemon tests including `daemon synthetic exit clears PTY ownership before exited transition`.
- `pnpm --filter @tao/desktop build && pnpm smoke:package` after fixing the daemon panic: failed with `Smoke session exited before expected output`; this was a smoke harness bug where the bounded output tail could discard the sentinel token. The harness now tracks the token separately.
- `pnpm exec oxfmt apps/desktop/src/main/index.ts && pnpm --filter @tao/desktop tsc` after the smoke harness sentinel fix: passed.
- `pnpm fmt:ts:check` after the smoke harness sentinel fix: passed.
- `pnpm --filter @tao/desktop build && pnpm smoke:package` after the smoke harness sentinel fix: passed; verified packaged Electron/preload/main/taod terminal output with diagnostics and smoke-daemon cleanup.
- `pnpm bench:taod:budget`: passed; verified the packaged Electron/taod 1 MiB sustained-output smoke budget with at least 64 KiB/s throughput, no more than 64 KiB pending preload output, and taod RSS/growth under the 256 MiB smoke ceilings. Node emitted a `module.register()` deprecation warning.
- `pnpm exec oxfmt report.md apps/desktop/src/main/index.ts apps/desktop/src/main/taod-client.ts apps/desktop/package.json package.json && pnpm fmt:ts:check` after recording the sustained-output budget work: passed.
- Final `pnpm check` after the sustained-output budget work and daemon exit-transition fix: passed end to end, including lint, format check, TypeScript, 17 desktop tests, and 107 daemon tests.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check` after recording final verification: passed.
- Final `git status --short`: confirmed the worktree remains dirty with the expected ongoing review/fix files; no unrelated files were reverted.
- Final `pgrep -fl 'package-smoke|Electron|TAO_ELECTRON_SMOKE|taod' || true`: no package-smoke or smoke Electron process remained; only unrelated app crashpad helpers and the pre-existing long-lived detached `taod` process were present.
- `git status --short --branch` before the pending-output diagnostics slice: confirmed the dirty `best-operation` worktree and preserved existing changes.
- `rg`/`sed` inspection of `report.md`, daemon stream/session files, shared diagnostics schema, and CI workflow: identified slow-subscriber/replay observability and CI taod-budget promotion as the next concrete report items.
- `pnpm --filter @tao/daemon fmt:check` after adding pending-output truncation diagnostics: failed because `apps/daemon/src/session.zig` needed Zig formatting.
- `pnpm --filter @tao/shared tsc` after adding stream diagnostic schema fields: passed.
- `pnpm --filter @tao/desktop tsc` after normalizing new diagnostic fields: passed.
- `pnpm --filter @tao/daemon fmt`: formatted `apps/daemon/src/session.zig`.
- `pnpm --filter @tao/daemon fmt:check`: passed after formatting.
- `pnpm --filter @tao/daemon test`: passed, 108 daemon tests including `daemon stream diagnostics report pending output truncation`.
- `pnpm exec oxfmt report.md apps/desktop/src/main/taod-client.ts packages/shared/src/taod-protocol.ts .github/workflows/ci.yml packages/shared/fixtures/taod-protocol/control-ping-response.ndjson && pnpm fmt:ts:check` after wiring diagnostics and CI: passed.
- `pnpm --filter @tao/desktop build && pnpm smoke:package` after adding pending-output diagnostics: passed; rebuilt `taod` and Electron output, then verified packaged `taod`, adapters, Electron launch, preload session creation, terminal output, diagnostics, and smoke-daemon cleanup.
- `pnpm bench:taod:budget` after adding pending-output diagnostics and CI promotion: passed against the rebuilt artifact. Node emitted a `module.register()` deprecation warning.
- Final `pnpm exec oxfmt report.md && pnpm check` after pending-output diagnostics and CI promotion: passed end to end, including lint, format check, TypeScript, 17 desktop tests, and 108 daemon tests.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check` after recording final verification: passed.
- Final `git status --short`: confirmed the worktree remains dirty with the expected ongoing review/fix files; no unrelated files were reverted.
- Final `pgrep -fl 'package-smoke|Electron|TAO_ELECTRON_SMOKE|taod' || true`: no package-smoke or smoke Electron process remained; only unrelated app crashpad helpers and the pre-existing long-lived detached `taod` process were present.
- `git status --short --branch` before the `TaodClient` lifecycle test slice: confirmed the dirty `best-operation` worktree and preserved existing changes.
- `rg`/`sed` inspection of `report.md`, `taod-client.ts`, existing desktop tests, and package scripts: identified lifecycle failure-matrix coverage as the next concrete report item.
- Initial `pnpm --filter @tao/desktop test:persistence` with the new lifecycle test file: failed because `taod-client.ts` used a named Electron `app` import that Node's test runner could not import from the Electron package.
- `pnpm --filter @tao/desktop tsc` during the same lifecycle test slice: passed.
- Follow-up `pnpm --filter @tao/desktop test:persistence` after making Electron's `app` optional outside Electron: passed, 22 tests including absent socket, external live daemon, protocol mismatch, stale/malformed response, and control-request timing lifecycle tests.
- Follow-up `pnpm --filter @tao/desktop tsc` after making Electron's `app` optional outside Electron: passed.
- `pnpm exec oxfmt apps/desktop/src/main/taod-client.ts apps/desktop/src/main/taod-client-lifecycle.test.ts apps/desktop/package.json && pnpm fmt:ts:check` after wiring lifecycle tests: passed.
- `pnpm --filter @tao/desktop build && pnpm smoke:package` after the Electron import/testability change: passed; rebuilt `taod` and Electron output, then verified packaged `taod`, adapters, Electron launch, preload session creation, terminal output, diagnostics, and smoke-daemon cleanup.
- Final `pnpm exec oxfmt report.md && pnpm check` after lifecycle tests: passed end to end, including lint, format check, TypeScript, 22 desktop tests, and 108 daemon tests.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check` after recording lifecycle-test verification: passed.
- Final `git status --short`: confirmed the worktree remains dirty with the expected ongoing review/fix files and the new `taod-client-lifecycle.test.ts`; no unrelated files were reverted.
- Final `pgrep -fl 'package-smoke|Electron|TAO_ELECTRON_SMOKE|taod' || true`: no package-smoke or smoke Electron process remained; only unrelated app crashpad helpers and the pre-existing long-lived detached `taod` process were present.
- `git status --short --branch` before the IPC budget slice: confirmed the dirty `best-operation` worktree and preserved existing changes.
- `rg`/`sed` inspection of `report.md`, memory routing notes, and existing benchmark scripts: identified IPC budget enforcement as the next concrete CI/performance report item.
- `pnpm --filter @tao/desktop tsc` after adding IPC budget enforcement: passed.
- `pnpm exec oxfmt apps/desktop/bench/ipc-benchmark.ts apps/desktop/package.json package.json .github/workflows/ci.yml && pnpm fmt:ts:check` after wiring IPC budget scripts and CI: passed.
- `pnpm bench:ipc:budget`: passed; 16 MiB MessagePort run measured 2442.9 MB/s average throughput, 3.00 ms p99 control latency, 0 median data stalls over 16 ms, and 0 median control stalls over 16 ms. Node emitted a `module.register()` deprecation warning.
- Final `pnpm exec oxfmt report.md && pnpm check` after IPC budget wiring: passed end to end, including lint, format check, TypeScript, 22 desktop tests, and 108 daemon tests.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check` after recording IPC budget verification: passed.
- Final `git status --short`: confirmed the worktree remains dirty with expected ongoing review/fix files and IPC benchmark edits; no unrelated files were reverted.
- Final `pgrep -fl 'package-smoke|Electron|TAO_ELECTRON_SMOKE|taod' || true`: no package-smoke or smoke Electron process remained; only unrelated app crashpad helpers and the pre-existing long-lived detached `taod` process were present.
- `git status --short --branch` during the keychain/startup continuation: confirmed the dirty `best-operation` worktree and preserved existing changes.
- `rg`/`find`/`sed` inspection of package smoke, Electron main smoke hooks, package scripts, CI, and report text: confirmed there was no repo-level keychain/signing config and identified startup budget wiring as the next report item.
- `pnpm --filter @tao/desktop tsc` after adding startup smoke timing budgets: passed.
- `pnpm fmt:ts:check` after adding startup smoke timing budgets: passed.
- `pnpm --filter @tao/desktop build` after adding startup smoke timing budgets: passed; rebuilt `taod`, copied adapters, and rebuilt Electron main/preload/renderer output.
- `pnpm bench:startup:budget`: passed; packaged Electron launch smoke completed in 1140 ms and enforced renderer-load, first-output, total-runtime, and process-launch ceilings. Node emitted a `module.register()` deprecation warning.
- `pnpm exec oxfmt report.md apps/desktop/src/main/index.ts scripts/package-smoke.ts apps/desktop/package.json package.json .github/workflows/ci.yml && pnpm fmt:ts:check` after startup budget wiring and report updates: passed.
- Final `pnpm check` after startup budget wiring: passed end to end, including lint, format check, TypeScript, 22 desktop tests, and 108 daemon tests.
- Final `git status --short`: confirmed the worktree remains dirty with the expected ongoing review/fix files and startup budget edits; no unrelated files were reverted.
- Final `pgrep -fl 'package-smoke|Electron|TAO_ELECTRON_SMOKE|taod' || true`: no package-smoke or smoke Electron process remained; only unrelated app crashpad helpers and the pre-existing long-lived detached `taod` process were present.
- `git status --short --branch` before the latency-budget slice: confirmed the dirty `best-operation` worktree and preserved existing changes.
- `rg`/`sed` inspection of report gaps, `apps/desktop/bench/latency-taod.ts`, package scripts, `TaodClient`, and daemon stream/control code: confirmed the existing latency benchmark was stale and did not create sessions through the current daemon contract.
- Initial `pnpm bench:latency:budget` after rewriting the latency benchmark: failed because the script imported `TaodStreamParser`, but the real export is `TaodStreamFrameParser`; fixed before continuing.
- `pnpm exec oxfmt apps/desktop/bench/latency-taod.ts apps/desktop/package.json package.json .github/workflows/ci.yml && pnpm --filter @tao/desktop tsc`: passed after adding the managed-daemon latency budget script.
- Follow-up `pnpm exec oxfmt apps/desktop/bench/latency-taod.ts && pnpm --filter @tao/desktop tsc && pnpm bench:latency:budget`: passed after the parser import fix; managed `taod` measured 60 samples at avg 0.11 ms, p50 0.10 ms, p95 0.18 ms, p99 0.54 ms, max 0.54 ms. The managed-daemon readiness probe initially caused an `EmptyControlPayload` daemon warning.
- Final `pnpm exec oxfmt apps/desktop/bench/latency-taod.ts && pnpm bench:latency:budget` after replacing the readiness probe with a real ping: passed; managed `taod` measured 60 samples at avg 0.11 ms, p50 0.09 ms, p95 0.19 ms, p99 0.51 ms, max 0.51 ms. Node emitted a `module.register()` deprecation warning.
- `pnpm exec oxfmt report.md apps/desktop/bench/latency-taod.ts apps/desktop/package.json package.json .github/workflows/ci.yml && pnpm fmt:ts:check` after the latency report update: passed.
- Initial `pnpm check` after latency budget wiring: failed because `apps/desktop/bench/latency-taod.ts` imported unused `join`; fixed before continuing.
- Final `pnpm exec oxfmt apps/desktop/bench/latency-taod.ts && pnpm check` after removing the unused import: passed end to end, including lint, format check, TypeScript, 22 desktop tests, and 108 daemon tests.
- Final `git status --short`: confirmed the worktree remains dirty with the expected ongoing review/fix files and latency budget edits; no unrelated files were reverted.
- Final `pgrep -fl 'tao-latency-bench|package-smoke|Electron|TAO_ELECTRON_SMOKE|taod' || true`: no latency/package-smoke/smoke Electron process remained; only unrelated app crashpad helpers and the pre-existing long-lived detached `taod` process were present.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check` after recording latency-budget verification: passed.
- `git status --short --branch` before the attach/replay budget slice: confirmed the dirty `best-operation` worktree and preserved existing changes.
- `rg`/`sed` inspection of `report.md`, daemon attach/stream/snapshot/session code, `TaodClient.attachSession`, and pending-output limits: confirmed attach sends NDJSON first, then current-screen snapshot, then bounded pending output on the same stream.
- `pnpm exec oxfmt apps/desktop/bench/attach-replay-benchmark.ts apps/desktop/package.json package.json .github/workflows/ci.yml && pnpm --filter @tao/desktop tsc`: passed after adding the managed-daemon attach/replay budget script.
- `pnpm fmt:ts:check` after adding the attach/replay budget script: passed.
- `pnpm bench:attach:budget`: passed; managed `taod` buffered 1,048,576 bytes before attach, then measured attach response at 0.98 ms, current-screen snapshot at 2.21 ms, and full 1 MiB replay at 17.29 ms. Node emitted a `module.register()` deprecation warning.
- `pnpm exec oxfmt report.md apps/desktop/bench/attach-replay-benchmark.ts apps/desktop/package.json package.json .github/workflows/ci.yml && pnpm fmt:ts:check` after the attach/replay report update: passed.
- Final `pnpm check` after attach/replay budget wiring: passed end to end, including lint, format check, TypeScript, 22 desktop tests, and 108 daemon tests.
- Final `git status --short`: confirmed the worktree remains dirty with the expected ongoing review/fix files and the new attach/replay benchmark; no unrelated files were reverted.
- Final `pgrep -fl 'tao-attach-replay-bench|tao-latency-bench|package-smoke|Electron|TAO_ELECTRON_SMOKE|taod' || true`: no attach/latency/package-smoke/smoke Electron process remained; only unrelated app crashpad helpers and the pre-existing long-lived detached `taod` process were present.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check` after recording attach/replay verification: passed.
- `git status --short --branch` before the packaged input-priority slice: confirmed the dirty `best-operation` worktree and preserved existing changes.
- `rg`/`sed` inspection of `report.md`, `scripts/package-smoke.ts`, Electron smoke code, preload APIs, and renderer env types: identified packaged renderer/preload input echo under output as the next concrete report item.
- `pnpm exec oxfmt apps/desktop/src/main/index.ts apps/desktop/package.json && pnpm --filter @tao/desktop tsc`: passed after adding the smoke input-echo probe.
- `pnpm fmt:ts:check` after adding the smoke input-echo probe: passed.
- `pnpm --filter @tao/desktop build` after adding the smoke input-echo probe: passed; rebuilt `taod`, copied adapters, and rebuilt Electron main/preload/renderer output.
- `pnpm bench:taod:budget`: passed with `TAO_ELECTRON_SMOKE_MAX_INPUT_ECHO_MS=500`; the packaged Electron smoke now writes an input probe through the real renderer/preload API during the same PTY output flood and requires the echoed token before the smoke can pass. Node emitted a `module.register()` deprecation warning.
- `pnpm smoke:package` after changing the smoke terminal fixture to Python: passed in default mode; packaged Electron launch smoke completed in 997 ms and still verified package layout, copied `taod`, adapters, Electron launch, preload session creation, terminal output, diagnostics, and cleanup.
- `pnpm exec oxfmt report.md apps/desktop/src/main/index.ts apps/desktop/package.json && pnpm fmt:ts:check` after the input-priority report update: passed.
- Final `pnpm check` after packaged input-priority smoke wiring: passed end to end, including lint, format check, TypeScript, 22 desktop tests, and 108 daemon tests.
- Final `git status --short`: confirmed the worktree remains dirty with the expected ongoing review/fix files and packaged input-priority edits; no unrelated files were reverted.
- Final `pgrep -fl 'tao-attach-replay-bench|tao-latency-bench|package-smoke|Electron|TAO_ELECTRON_SMOKE|taod' || true`: no attach/latency/package-smoke/smoke Electron process remained; only unrelated app crashpad helpers and the pre-existing long-lived detached `taod` process were present.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check` after recording input-priority verification: passed.
- `git status --short --branch` before the workspace metadata budget slice: confirmed the dirty `best-operation` worktree and preserved existing changes.
- `rg -n "workspacePortsAlloc|ports|lsof|proc|LISTEN" apps/daemon/src/workspace.zig apps/daemon/src -g '*.zig'`: confirmed `workspace.ports` runs in `taod`, uses a global listening TCP `lsof` scan, and checks bounded listener PIDs' cwd paths instead of recursive `lsof +D`.
- `sed -n` inspection of `apps/desktop/bench/workspace-metadata-benchmark.ts` and `apps/daemon/src/workspace.zig`: confirmed the new benchmark created a synthetic 5k-file Git repo and initially enforced each metric before printing later metrics.
- `pnpm exec oxfmt apps/desktop/bench/workspace-metadata-benchmark.ts && pnpm --filter @tao/desktop tsc && pnpm bench:workspace:budget`: formatting and desktop typecheck passed; the first full workspace budget run failed because `workspace.ports` measured 1580.66 ms against a 1000 ms ceiling while branches/status/fileTree/diff/PR all completed in tens of milliseconds.
- `pnpm exec oxfmt apps/desktop/bench/workspace-metadata-benchmark.ts apps/desktop/package.json package.json .github/workflows/ci.yml && pnpm --filter @tao/desktop tsc && pnpm bench:workspace:budget`: passed after making the benchmark print all metrics before enforcing and setting the macOS `workspace.ports` smoke ceiling to 3000 ms. The 5k-file local run measured branches 5.86 ms, status 12.30 ms, fileTree 23.66 ms, diff 18.42 ms, ports 1605.29 ms, and pullRequest 18.60 ms. Node emitted a `module.register()` deprecation warning.
- `pnpm exec oxfmt report.md apps/desktop/bench/workspace-metadata-benchmark.ts apps/desktop/package.json package.json .github/workflows/ci.yml && pnpm check`: passed end to end after the workspace metadata budget work, including lint, format check, TypeScript, 22 desktop tests, and 108 daemon tests.
- `pgrep -fl 'tao-workspace-bench|tao-attach-replay-bench|tao-latency-bench|package-smoke|Electron|TAO_ELECTRON_SMOKE|taod' || true`: no workspace/attach/latency/package-smoke/smoke Electron process remained; only unrelated app crashpad helpers and the pre-existing long-lived detached `taod` process were present.
- Final `git status --short --branch`: confirmed the worktree remains dirty with the expected ongoing review/fix files and new workspace metadata benchmark; no unrelated files were reverted.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check` after recording workspace metadata verification: passed.
- `git status --short --branch` before the real-daemon lifecycle slice: confirmed the dirty `best-operation` worktree and preserved existing changes.
- `rg`/`sed` inspection of `report.md`, `apps/desktop/src/main/taod-client.ts`, `apps/desktop/src/main/taod-client-lifecycle.test.ts`, package scripts, and CI: identified real owned-daemon restart coverage as the next concrete lifecycle gap.
- Initial `pnpm exec oxfmt apps/desktop/src/main/taod-client-real-lifecycle.test.ts apps/desktop/package.json .github/workflows/ci.yml && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:taod-lifecycle`: passed, but the test produced a delayed restart-failure warning because the polling loop called `refreshLifecycleDiagnostics()` while the scheduled restart was already in flight.
- Follow-up `pnpm exec oxfmt apps/desktop/src/main/taod-client-real-lifecycle.test.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:taod-lifecycle`: passed after removing the competing refresh loop. The test started `taod` under a temporary HOME, killed it with `SIGTERM`, observed the `crashed` state and scheduled restart, then verified a new owned daemon became live in 245 ms. Node emitted a `module.register()` deprecation warning.
- `pnpm check` after adding `test:taod-lifecycle` and CI wiring: passed end to end, including lint, format check, TypeScript, 22 desktop tests, and 108 daemon tests.
- `pgrep -fl 'tao-real-lifecycle|tao-workspace-bench|tao-attach-replay-bench|tao-latency-bench|package-smoke|Electron|TAO_ELECTRON_SMOKE|taod' || true`: no real-lifecycle/workspace/attach/latency/package-smoke/smoke Electron process remained; only unrelated app crashpad helpers and the pre-existing long-lived detached `taod` process were present.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check` after recording real-daemon lifecycle verification: passed.
- Final `git status --short --branch`: confirmed the worktree remains dirty with the expected ongoing review/fix files and new `taod-client-real-lifecycle.test.ts`; no unrelated files were reverted.
- Final `pgrep -fl 'tao-real-lifecycle|tao-workspace-bench|tao-attach-replay-bench|tao-latency-bench|package-smoke|Electron|TAO_ELECTRON_SMOKE|taod' || true`: no real-lifecycle/workspace/attach/latency/package-smoke/smoke Electron process remained; only unrelated app crashpad helpers and the pre-existing long-lived detached `taod` process were present.
- `git status --short --branch` before the direct `taod` soak slice: confirmed the dirty `best-operation` worktree and preserved existing changes.
- `rg`/`sed` inspection of report gaps, existing attach/latency/package smoke harnesses, package scripts, and CI: identified the missing CI-friendly memory/churn budget as the next concrete terminal reliability gap.
- Initial `pnpm exec oxfmt apps/desktop/bench/taod-soak-benchmark.ts apps/desktop/package.json package.json .github/workflows/ci.yml && pnpm --filter @tao/desktop tsc && pnpm bench:soak:budget`: passed. The first 5-iteration run drained 524,288 bytes per session, left 0 active subscribers and 0 pending output bytes, and measured RSS growth of 23,136 KiB against the 65,536 KiB smoke ceiling.
- Follow-up `pnpm exec oxfmt apps/desktop/bench/taod-soak-benchmark.ts && pnpm --filter @tao/desktop tsc && pnpm bench:soak:budget`: passed after a readability cleanup. The run drained 524,288 bytes per session for 5 iterations, measured avg iteration 494.82 ms, max iteration 534.94 ms, RSS growth 23,424 KiB, 0 active subscribers, and 0 pending output bytes. Node emitted a `module.register()` deprecation warning.
- `pnpm exec oxfmt report.md apps/desktop/bench/taod-soak-benchmark.ts apps/desktop/package.json package.json .github/workflows/ci.yml && pnpm check`: passed end to end after the soak budget wiring, including lint, format check, TypeScript, 22 desktop tests, and 108 daemon tests.
- `pgrep -fl 'tao-soak-bench|tao-real-lifecycle|tao-workspace-bench|tao-attach-replay-bench|tao-latency-bench|package-smoke|Electron|TAO_ELECTRON_SMOKE|taod' || true`: no soak/real-lifecycle/workspace/attach/latency/package-smoke/smoke Electron process remained; only unrelated app crashpad helpers and the pre-existing long-lived detached `taod` process were present.
- Final `git status --short --branch`: confirmed the worktree remains dirty with the expected ongoing review/fix files and new `taod-soak-benchmark.ts`; no unrelated files were reverted.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check` after recording soak budget verification: passed.
- `git status --short --branch` before the daemon crash-mid-request slice: confirmed the dirty `best-operation` worktree and preserved existing changes.
- `rg`/`sed` inspection of `report.md`, `taod-client.ts`, and lifecycle tests: identified daemon exit during an in-flight control request as the next lifecycle proof gap.
- `pnpm exec oxfmt apps/desktop/src/main/taod-client-real-lifecycle.test.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:taod-lifecycle`: passed after adding the macOS real-daemon mid-request test. The suite now has 2 tests: owned daemon process exit/restart and owned daemon exit during `workspace.ports`, with the latter asserting failed control request diagnostics before restart. Node emitted a `module.register()` deprecation warning.
- `pnpm exec oxfmt report.md apps/desktop/src/main/taod-client-real-lifecycle.test.ts && pnpm check`: passed end to end after the daemon crash-mid-request test, including lint, format check, TypeScript, 22 desktop tests, and 108 daemon tests.
- `pgrep -fl 'tao-mid-request|tao-real-lifecycle|tao-soak-bench|tao-workspace-bench|tao-attach-replay-bench|tao-latency-bench|package-smoke|Electron|TAO_ELECTRON_SMOKE|taod' || true`: no mid-request/real-lifecycle/soak/workspace/attach/latency/package-smoke/smoke Electron process remained; only unrelated app crashpad helpers and the pre-existing long-lived detached `taod` process were present.
- Final `git status --short --branch`: confirmed the worktree remains dirty with the expected ongoing review/fix files; no unrelated files were reverted.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check` after recording daemon crash-mid-request verification: passed.
- `git status --short --branch` before the packaged renderer reload slice: confirmed the dirty `best-operation` worktree and preserved existing changes.
- `rg`/`sed` inspection of `report.md`, package smoke, Electron smoke code, preload APIs, and renderer env types: identified packaged renderer reload/reattach as the next concrete lifecycle proof gap.
- Initial `pnpm exec oxfmt apps/desktop/src/main/index.ts apps/desktop/package.json package.json .github/workflows/ci.yml && pnpm --filter @tao/desktop tsc && pnpm bench:reload:budget`: typecheck passed and the command passed against the existing built output, but this was not valid proof because `apps/desktop/out` had not been rebuilt after changing `main/index.ts`.
- `pnpm --filter @tao/desktop build && pnpm bench:reload:budget`: rebuilt `taod` and Electron output, then failed. The smoke session exited before expected output because the edit had accidentally removed the only `sawToken = true` assignment in the smoke output callback.
- `pnpm smoke:package` immediately after that failed for the same reason, confirming the bug affected the default package smoke path too.
- `pnpm exec oxfmt apps/desktop/src/main/index.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop build && pnpm smoke:package && pnpm bench:reload:budget`: passed after restoring the smoke token detection. The default package smoke completed in 1135 ms, and the reload budget completed in 1052 ms against rebuilt packaged output, verifying renderer reload plus reattach/input echo on the existing daemon session. Node emitted `module.register()` deprecation warnings.
- `pnpm exec oxfmt report.md apps/desktop/src/main/index.ts apps/desktop/package.json package.json .github/workflows/ci.yml && pnpm check`: passed end to end after the packaged renderer reload smoke wiring, including lint, format check, TypeScript, 22 desktop tests, and 108 daemon tests.
- `pgrep -fl 'tao-electron-smoke|package-smoke|TAO_ELECTRON_SMOKE|tao-mid-request|tao-real-lifecycle|tao-soak-bench|tao-workspace-bench|tao-attach-replay-bench|tao-latency-bench|Electron|taod' || true`: no package-smoke/smoke Electron/reload/lifecycle/soak/workspace/attach/latency process remained; only unrelated app crashpad helpers and the pre-existing long-lived detached `taod` process were present.
- Final `git status --short --branch`: confirmed the worktree remains dirty with the expected ongoing review/fix files; no unrelated files were reverted.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check` after recording packaged renderer reload verification: passed.
- `rg -n "TaodClient|taod|renderer reload|reload" /Users/dp/.codex/memories/MEMORY.md`: inspected prior Tao daemon/startup notes before continuing the lifecycle slice.
- `git status --short --branch` before the multi-session reload slice: confirmed the dirty `best-operation` worktree and preserved existing changes.
- `rg`/`sed` inspection of `report.md`, `apps/desktop/src/main/index.ts`, `apps/desktop/package.json`, root package scripts, and CI workflow references: confirmed the remaining report gap was broader multi-session renderer reload coverage and that `bench:reload:budget` was the right harness to extend.
- `pnpm exec oxfmt apps/desktop/src/main/index.ts apps/desktop/package.json && pnpm --filter @tao/desktop tsc`: passed after adding `TAO_ELECTRON_SMOKE_RELOAD_SESSIONS` and multi-session reload attach execution.
- `pnpm --filter @tao/desktop build && pnpm bench:reload:budget`: passed against rebuilt packaged output. The reload budget now runs with `TAO_ELECTRON_SMOKE_RELOAD_SESSIONS=2`; package smoke completed in 1576 ms and verified two live PTY sessions survive renderer reload, reattach from the fresh preload context, echo input, and clean up. Node emitted a `module.register()` deprecation warning.
- `pnpm check`: passed end to end after multi-session reload smoke wiring, including lint, format check, TypeScript, 22 desktop tests, and 108 daemon tests.
- `pgrep -fl 'tao-electron-smoke|package-smoke|TAO_ELECTRON_SMOKE|tao-mid-request|tao-real-lifecycle|tao-soak-bench|tao-workspace-bench|tao-attach-replay-bench|tao-latency-bench|Electron|taod' || true`: no package-smoke/smoke Electron/reload/lifecycle/soak/workspace/attach/latency process remained; only unrelated app crashpad helpers and the pre-existing long-lived detached `taod` process were present.
- `git status --short --branch` after the multi-session reload slice: confirmed the worktree remains dirty with the expected ongoing review/fix files; no unrelated files were reverted.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check` after recording multi-session reload verification: passed.
- `rg -n "TaodClient|taod|renderer reload|app quit|soak|large-repo" /Users/dp/.codex/memories/MEMORY.md`: inspected prior Tao daemon/startup notes before continuing the app-quit lifecycle slice.
- `git status --short --branch` before the app-quit lifecycle slice: confirmed the dirty `best-operation` worktree and preserved existing changes.
- `rg`/`sed` inspection of `report.md`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/taod-client.ts`, `scripts/package-smoke.ts`, and lifecycle tests: identified detached app-quit semantics as the next concrete lifecycle proof gap. Normal Electron runs create detached daemons; smoke/test cleanup uses attached daemons.
- `pnpm exec oxfmt apps/desktop/src/main/taod-client-real-lifecycle.test.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:taod-lifecycle`: passed after adding the real detached-daemon dispose test. The suite now has 3 tests: owned daemon process exit/restart, detached daemon survives client disposal for Electron quit semantics, and owned daemon exit during `workspace.ports`. Node emitted a `module.register()` deprecation warning.
- `pnpm check`: passed end to end after app-quit lifecycle coverage, including lint, format check, TypeScript, 22 desktop tests, and 108 daemon tests.
- `pgrep -fl 'tao-detached-quit|tao-mid-request|tao-real-lifecycle|tao-soak-bench|tao-workspace-bench|tao-attach-replay-bench|tao-latency-bench|package-smoke|Electron|TAO_ELECTRON_SMOKE|taod' || true`: no detached-quit/mid-request/real-lifecycle/soak/workspace/attach/latency/package-smoke/smoke Electron process remained; only unrelated app crashpad helpers and the pre-existing long-lived detached `taod` process were present.
- `git status --short --branch` after the app-quit lifecycle slice: confirmed the worktree remains dirty with the expected ongoing review/fix files; no unrelated files were reverted.
- Final `pnpm exec oxfmt report.md apps/desktop/src/main/taod-client-real-lifecycle.test.ts && pnpm fmt:ts:check` after recording app-quit lifecycle verification: passed.
- `rg -n "TaodClient|taod|workspace.*reload|reload|workspace.*resync|soak|large-repo" /Users/dp/.codex/memories/MEMORY.md`: inspected prior Tao daemon/startup notes before continuing the workspace reload/resync slice.
- `git status --short --branch` before the workspace reload/resync slice: confirmed the dirty `best-operation` worktree and preserved existing changes.
- `rg`/`sed` inspection of `report.md`, `apps/desktop/src/main/index.ts`, preload APIs, renderer API types, and shared workspace schemas: confirmed `window.electronAPI` exposes `addWorkspace`, `listWorkspaces`, `refreshWorkspace`, and `removeWorkspace`, and that workspace records use `id` rather than `workspaceId`.
- Initial `pnpm --filter @tao/desktop build && pnpm bench:reload:budget` after adding the workspace reload check: rebuilt `taod` and Electron output, then failed. `workspace:add` succeeded, but the smoke checked `workspace.workspaceId` in `workspace:list`; the shared `WorkspaceRecord` field is `id`, so the smoke reported `Smoke workspace missing before reload`.
- Follow-up `pnpm exec oxfmt apps/desktop/src/main/index.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop build && pnpm bench:reload:budget`: passed after switching the smoke to the daemon-returned workspace record `id`. Package smoke completed in 1746 ms and verified two live PTY sessions plus daemon-backed workspace list/refresh/remove from the fresh preload context after renderer reload. Node emitted a `module.register()` deprecation warning.
- `pnpm check`: passed end to end after workspace reload/resync smoke wiring, including lint, format check, TypeScript, 22 desktop tests, and 108 daemon tests.
- `pgrep -fl 'tao-electron-smoke|package-smoke|TAO_ELECTRON_SMOKE|tao-detached-quit|tao-mid-request|tao-real-lifecycle|tao-soak-bench|tao-workspace-bench|tao-attach-replay-bench|tao-latency-bench|Electron|taod' || true`: no package-smoke/smoke Electron/reload/lifecycle/soak/workspace/attach/latency process remained; only unrelated app crashpad helpers and the pre-existing long-lived detached `taod` process were present.
- `git status --short --branch` after the workspace reload/resync slice: confirmed the worktree remains dirty with the expected ongoing review/fix files; no unrelated files were reverted.
- Final `pnpm exec oxfmt report.md apps/desktop/src/main/index.ts && pnpm fmt:ts:check` after recording workspace reload/resync verification: passed.
- `rg -n "TaodClient|taod|workspace.*benchmark|soak|large-repo|50k|250k|memory" /Users/dp/.codex/memories/MEMORY.md`: inspected prior Tao daemon and memory-safety notes before continuing the large-repo profile slice.
- `git status --short --branch` before the large-repo profile slice: confirmed the dirty `best-operation` worktree and preserved existing changes.
- `rg`/`sed` inspection of `report.md`, package scripts, CI, `apps/desktop/bench/workspace-metadata-benchmark.ts`, and `apps/desktop/bench/taod-soak-benchmark.ts`: confirmed the workspace benchmark already supports configurable file counts and the soak benchmark already has a manual 720-iteration example for roughly one-hour direct-daemon churn.
- `pnpm exec oxfmt apps/desktop/package.json package.json && pnpm --filter @tao/desktop tsc && pnpm bench:workspace:large`: passed after adding `bench:workspace:large` and `bench:workspace:xl`. The 50k-file non-enforcing profile measured branches 6.29 ms, status 78.84 ms, fileTree 150.31 ms with a 1,300,207 byte response, diff 70.39 ms, ports 1822.42 ms, and pullRequest 22.45 ms. Node emitted a `module.register()` deprecation warning.
- `pnpm exec oxfmt apps/desktop/package.json package.json && pnpm --filter @tao/desktop tsc && pnpm bench:workspace:large:budget`: passed after adding an enforcing 50k-file profile. The 50k-file budget run measured branches 6.92 ms, status 80.88 ms, fileTree 155.84 ms with a 1,300,207 byte response, diff 72.99 ms, ports 1836.41 ms under the 3000 ms ports ceiling, and pullRequest 22.81 ms. Node emitted a `module.register()` deprecation warning.
- `rg -n "TaodClient|taod|250k|workspace.*xl|large-repo|memory safety|soak" /Users/dp/.codex/memories/MEMORY.md`: inspected prior Tao daemon/startup notes before the 250k workspace profile slice.
- `git status --short --branch` before the 250k workspace profile slice: confirmed the dirty `best-operation` worktree and preserved existing changes.
- `rg` inspection of `report.md`, package scripts, and `apps/desktop/bench/workspace-metadata-benchmark.ts`: confirmed `bench:workspace:xl` existed and the report still lacked 250k command evidence.
- Initial `pnpm bench:workspace:xl`: failed before Tao daemon metadata measurement because synthetic repo setup killed `git add .` at the benchmark's fixed 30s Git timeout.
- `pnpm exec oxfmt apps/desktop/bench/workspace-metadata-benchmark.ts apps/desktop/package.json && pnpm --filter @tao/desktop tsc && pnpm bench:workspace:xl`: passed after adding configurable `TAO_WORKSPACE_BENCH_GIT_TIMEOUT_MS=180000` for the 250k profile. Measured branches 8.20 ms, status 1604.45 ms, fileTree 1395.30 ms with a 6,500,207 byte response, diff 1081.64 ms, ports 1814.18 ms, and pullRequest 144.64 ms.
- `pnpm exec oxfmt apps/desktop/package.json package.json && pnpm --filter @tao/desktop tsc && pnpm bench:workspace:xl:budget`: passed after adding an enforcing 250k-file profile. Measured branches 9.11 ms, status 1745.18 ms, fileTree 1168.68 ms with a 6,500,207 byte response, diff 1335.65 ms, ports 1803.78 ms under the 3000 ms ports ceiling, and pullRequest 133.46 ms.
- `pnpm check`: passed end to end after the large-repo profile scripts, including lint, format check, TypeScript, 22 desktop tests, and 108 daemon tests.
- `pgrep -fl 'tao-workspace-bench|tao-soak-bench|package-smoke|TAO_ELECTRON_SMOKE|tao-detached-quit|tao-mid-request|tao-real-lifecycle|Electron|taod' || true`: no workspace-bench/soak/package-smoke/smoke Electron/lifecycle process remained; only unrelated app crashpad helpers and the pre-existing long-lived detached `taod` process were present.
- `git status --short --branch` after the large-repo profile slice: confirmed the worktree remains dirty with the expected ongoing review/fix files; no unrelated files were reverted.
- Final `pnpm exec oxfmt report.md apps/desktop/package.json package.json && pnpm fmt:ts:check` after recording large-repo profile verification: passed.
- `git status --short --branch` during the 250k-report continuation: confirmed the dirty `best-operation` worktree and preserved existing changes.
- `rg` inspection of the report, package scripts, workspace benchmark, and memory notes during the 250k-report continuation: confirmed the summary sections already named the 250k proof and the remaining stale area was command evidence.
- `sed` inspection of `report.md`, `apps/desktop/bench/workspace-metadata-benchmark.ts`, `apps/desktop/package.json`, and `package.json`: verified the current command log, `TAO_WORKSPACE_BENCH_GIT_TIMEOUT_MS`, and `bench:workspace:xl:budget` wiring before editing this report.
- `pnpm exec oxfmt report.md apps/desktop/bench/workspace-metadata-benchmark.ts apps/desktop/package.json package.json && pnpm fmt:ts:check` after adding 250k command evidence: passed; all matched files use the correct format.
- `pgrep -fl 'tao-workspace-bench|tao-soak-bench|package-smoke|TAO_ELECTRON_SMOKE|tao-detached-quit|tao-mid-request|tao-real-lifecycle|Electron|taod' || true`: no workspace-bench/soak/package-smoke/smoke Electron/lifecycle process remained; only unrelated app crashpad helpers and the pre-existing long-lived detached `taod` process were present.
- `git status --short --branch` after the 250k-report continuation: confirmed the worktree remains dirty with the expected ongoing review/fix files; no unrelated files were reverted.
- `rg -n "True one-hour|remaining|Still open|Commands Not Run|one-hour memory|renderer UI|UI jank|250k" report.md`: confirmed the remaining report gaps are true one-hour memory growth and renderer UI/jank profiling for very large metadata, not the 250k daemon metadata budget itself.
- `sed`/`rg` inspection of `report.md`, `apps/desktop/bench/taod-soak-benchmark.ts`, `apps/desktop/bench/xterm-webgl-benchmark.ts`, `apps/desktop/src/renderer/ui/App.tsx`, and `apps/desktop/bench/run-electron.ts`: identified renderer file-tree consumption as the next bounded gap after the 250k daemon metadata proof.
- `node -e "const t=require('@pierre/trees')..."`: failed because `@pierre/trees` is ESM-only and does not expose a CommonJS main; used this to avoid building the benchmark around `require('@pierre/trees')`.
- `find`/`cat`/`sed`/`rg` inspection of `node_modules/@pierre/trees`: confirmed the package exports ESM, uses a virtualized file tree, supports `presorted` input and `resetPaths`, and exposes `preparePresortedFileTreeInput`.
- `node --input-type=module -e "console.log(await import.meta.resolve('@pierre/trees'))"` and the same command from `apps/desktop`: confirmed ESM package resolution for the benchmark and showed the local package path.
- Initial `pnpm exec oxfmt apps/desktop/bench/file-tree-renderer-benchmark.ts apps/desktop/src/renderer/ui/App.tsx apps/desktop/package.json package.json && pnpm --filter @tao/desktop tsc`: passed after adding the first file-tree benchmark harness and marking renderer file-tree paths as presorted.
- Initial `pnpm bench:file-tree:budget`: failed because a `data:` URL renderer could not dynamically import the local `@pierre/trees` ESM file.
- Follow-up `pnpm exec oxfmt apps/desktop/bench/file-tree-renderer-benchmark.ts && pnpm --filter @tao/desktop tsc && pnpm bench:file-tree:budget`: typecheck passed, but the benchmark failed because the temporary `file://` page still tried to resolve `@pierre/trees`' bare `preact` import in the browser.
- `node -e "for (const m of ['esbuild','vite'])..."`: confirmed `esbuild` and `vite` are already installed; no new dependency was needed for the renderer benchmark bundle.
- Follow-up `pnpm exec oxfmt apps/desktop/bench/file-tree-renderer-benchmark.ts && pnpm --filter @tao/desktop tsc && pnpm bench:file-tree:budget`: failed because esbuild stdin had no resolve directory for `@pierre/trees`; fixed by setting `resolveDir: process.cwd()`.
- Follow-up `pnpm exec oxfmt apps/desktop/bench/file-tree-renderer-benchmark.ts && pnpm --filter @tao/desktop tsc && pnpm bench:file-tree:budget`: passed after bundling the benchmark renderer with esbuild. The first run measured 50k reset 38.40 ms, max frame 38.30 ms, and light-DOM-only node count 1, which exposed a benchmark metric bug.
- Follow-up `pnpm exec oxfmt apps/desktop/bench/file-tree-renderer-benchmark.ts && pnpm --filter @tao/desktop tsc && pnpm bench:file-tree:budget`: passed after counting shadow DOM nodes. The 50k run measured reset 38.80 ms, max frame 38.20 ms, 0 frames over 50 ms, and 195 DOM nodes.
- `pnpm bench:file-tree:xl:budget`: passed with the initial loose 250k ceilings. It measured reset 207.60 ms, max frame 210.90 ms, 1 frame over 50 ms, and 195 DOM nodes.
- `pnpm exec oxfmt apps/desktop/package.json package.json apps/desktop/bench/file-tree-renderer-benchmark.ts apps/desktop/src/renderer/ui/App.tsx && pnpm --filter @tao/desktop tsc && pnpm bench:file-tree:budget && pnpm bench:file-tree:xl:budget`: passed after tightening file-tree renderer budgets. The 50k run measured reset 38.70 ms, max frame 42.80 ms, 0 frames over 50 ms, and 195 DOM nodes. The 250k run measured reset 207.70 ms, max frame 207.60 ms, 1 frame over 50 ms, and 195 DOM nodes.
- `rg -n "renderer UI|UI jank|file-tree|large repo proof|Performance smoke|Renderer \\+ React|Benchmark \\+ Profiling|Recommended Execution|Still open|50k-file and 250k-file workspace|250k-file workspace" report.md` plus focused `sed` reads: located stale report wording before adding the file-tree renderer proof.
- `pnpm exec oxfmt report.md apps/desktop/bench/file-tree-renderer-benchmark.ts apps/desktop/src/renderer/ui/App.tsx apps/desktop/package.json package.json .github/workflows/ci.yml && pnpm check`: passed end to end after file-tree renderer benchmark wiring, CI wiring, and report updates, including lint, format check, TypeScript, 22 desktop tests, and 108 daemon tests.
- `pgrep -fl 'tao-file-tree-bench|tao-workspace-bench|tao-soak-bench|package-smoke|TAO_ELECTRON_SMOKE|tao-detached-quit|tao-mid-request|tao-real-lifecycle|Electron|taod' || true`: no file-tree/workspace/soak/package-smoke/smoke Electron/lifecycle benchmark process remained; only unrelated app crashpad helpers and the pre-existing long-lived detached `taod` process were present.
- `git status --short --branch` after the file-tree renderer benchmark slice: confirmed the worktree remains dirty with expected ongoing files and the new `file-tree-renderer-benchmark.ts`; no unrelated files were reverted.
- `rg -n "bench:file-tree|file-tree renderer|250k file-tree|one-hour|full-app" ...`: confirmed package scripts, CI, renderer presorted input, benchmark file, and report text all reference the new file-tree renderer budgets and remaining full-app/one-hour gaps.
- `pnpm exec oxfmt report.md apps/desktop/bench/file-tree-renderer-benchmark.ts apps/desktop/src/renderer/ui/App.tsx apps/desktop/package.json package.json .github/workflows/ci.yml && pnpm fmt:ts:check`: passed after recording file-tree benchmark commands; all matched files use the correct format.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check` after recording this verification line: passed.
- `git status --short --branch` before the slow-subscriber input-priority slice: confirmed the dirty `best-operation` worktree and preserved existing changes.
- `rg -n "Still open|slow-subscriber|input-priority|input priority|one-hour|1-hour|full-app|bench:taod|bench:soak|Commands Run" ...`: re-read report gaps, package scripts, benchmarks, daemon stream code, and main/preload/renderer surfaces before adding the direct input-priority budget.
- `rg -n "TaodClient|taod|slow subscriber|input priority|soak|memory" /Users/dp/.codex/memories/MEMORY.md`: inspected prior Tao daemon/startup and memory-safety notes before editing.
- `sed` inspection of `apps/daemon/src/daemon/stream.zig`, `apps/desktop/src/main/taod-stream.ts`, `apps/desktop/bench/latency-taod.ts`, and `apps/desktop/bench/taod-soak-benchmark.ts`: confirmed the benchmark should use real stream frames, a managed daemon, ping diagnostics, and slow-subscriber counters.
- Initial `pnpm exec oxfmt apps/desktop/bench/input-priority-benchmark.ts apps/desktop/package.json package.json .github/workflows/ci.yml && pnpm --filter @tao/desktop tsc && pnpm bench:input-priority:budget`: typecheck passed, but the first benchmark timed out waiting for the first echo token because the test process could read `GO\n` and the first probe in one chunk and discard bytes after the GO marker.
- Follow-up `pnpm exec oxfmt apps/desktop/bench/input-priority-benchmark.ts && pnpm --filter @tao/desktop tsc && pnpm bench:input-priority:budget`: typecheck passed, but the benchmark still timed out because the single-threaded Python flood fixture could block in `os.write()` before reading input.
- Follow-up `pnpm exec oxfmt apps/desktop/bench/input-priority-benchmark.ts && pnpm --filter @tao/desktop tsc && pnpm bench:input-priority:budget`: typecheck passed and the threaded Python fixture measured p95 echo around 0.19 ms, but failed because it produced only 1630 observed output bytes and did not trigger a slow-subscriber drop.
- Follow-up `pnpm exec oxfmt apps/desktop/bench/input-priority-benchmark.ts && pnpm --filter @tao/desktop tsc && pnpm bench:input-priority:budget` with an unbounded `yes` flood fixture: typecheck passed, but the flood was too aggressive and both subscribers were dropped before the fast stream observed the `READY` marker.
- Follow-up `pnpm exec oxfmt apps/desktop/bench/input-priority-benchmark.ts && pnpm --filter @tao/desktop tsc && pnpm bench:input-priority:budget` with a paced shell/Python flood fixture: typecheck passed, but the benchmark still timed out on `READY` because PTY line ending translation produced `READY\r\n` while the benchmark waited for `READY\n`.
- Final `pnpm exec oxfmt apps/desktop/bench/input-priority-benchmark.ts && pnpm --filter @tao/desktop tsc && pnpm bench:input-priority:budget`: passed after making `READY` and probe matching line-ending agnostic. The direct managed-`taod` run observed 1,232,923 output bytes, measured avg echo 1.73 ms, p50 1.72 ms, p95 2.92 ms, max 2.92 ms, recorded 1 slow-subscriber drop, and ended with 1 active fast subscriber. Node emitted a `module.register()` deprecation warning.
- `pnpm check`: passed end to end after the input-priority budget and CI wiring, including lint, format check, TypeScript, 22 desktop tests, and 108 daemon tests.
- `pgrep -fl 'tao-input-priority-bench|tao-file-tree-bench|tao-workspace-bench|tao-soak-bench|package-smoke|TAO_ELECTRON_SMOKE|tao-detached-quit|tao-mid-request|tao-real-lifecycle|Electron|taod' || true`: no input-priority/file-tree/workspace/soak/package-smoke/smoke Electron/lifecycle benchmark process remained; only unrelated app crashpad helpers and the pre-existing long-lived detached `taod` process were present.
- `git status --short --branch` after the slow-subscriber input-priority slice: confirmed the worktree remains dirty with expected ongoing files and the new `input-priority-benchmark.ts`; no unrelated files were reverted.
- `rg -n "input-priority|slow-subscriber|slow subscriber|one-hour|Still open|Performance smoke|Recommended Execution|Commands Run" ...`: confirmed package scripts, CI, benchmark file, and report text reference the new direct input-priority budget and leave the one-hour/full-app gaps explicit.
- `pnpm exec oxfmt report.md apps/desktop/bench/input-priority-benchmark.ts apps/desktop/package.json package.json .github/workflows/ci.yml && pnpm fmt:ts:check`: passed after recording input-priority benchmark commands; all matched files use the correct format.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check` after recording this verification line: passed.
- `git status --short --branch` before the packaged app-soak slice: confirmed the dirty `best-operation` worktree and preserved existing changes.
- `rg -n "Still open|one-hour|1-hour|full-app|full app|renderer trace|combined terminal|memory-growth|memory growth|Commands Run|Commands Not Run|startup budget|soak" ...`: confirmed the remaining report gaps were literal one-hour memory growth and full-app renderer tracing.
- `rg -n "Tao.*soak|taod.*memory|renderer.*trace|one-hour|input-priority|TaodClient|taod" /Users/dp/.codex/memories/MEMORY.md`: inspected prior Tao daemon/startup notes before continuing the app-soak work.
- `rg`/`sed` inspection of Electron smoke code, package smoke, preload API types, package scripts, and CI workflow: confirmed the packaged Electron smoke already covered one reload but only enforced `taod` RSS, not Electron main/renderer RSS.
- Initial `pnpm --filter @tao/desktop tsc` after adding reload cycles and main/renderer RSS budgets: passed.
- `pnpm exec oxfmt apps/desktop/src/main/index.ts apps/desktop/package.json package.json .github/workflows/ci.yml && pnpm fmt:ts:check` after first app-soak wiring: passed.
- `pnpm --filter @tao/desktop build`: passed; rebuilt `taod`, copied adapters, and rebuilt Electron main/preload/renderer output for the packaged smoke path.
- Initial `pnpm bench:app-soak:budget`: passed with three packaged renderer reload/reattach cycles, but the package smoke only printed pass/fail and hid the smoke metrics on success.
- `pnpm exec oxfmt apps/desktop/src/main/index.ts scripts/package-smoke.ts apps/desktop/package.json package.json .github/workflows/ci.yml && pnpm --filter @tao/desktop tsc && pnpm fmt:ts:check`: passed after making the Electron smoke success payload JSON and printing that line from `package-smoke.ts`.
- `pnpm --filter @tao/desktop build && pnpm bench:app-soak:budget`: passed after the JSON success-line update; the app-soak budget exercised the packaged app, repeated three reload/reattach cycles with two sessions, verified workspace resync once, and emitted detailed memory/reload metrics.
- `pnpm exec oxfmt apps/desktop/src/main/index.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop build && pnpm bench:app-soak:budget`: passed after tightening the RSS baseline sampler to wait for a live daemon state when possible.
- `pnpm bench:app-soak:budget > /tmp/tao-app-soak-budget.log && node - <<'NODE' ...`: passed and parsed the smoke metrics: renderer load 281 ms, total smoke 2980 ms, first output 471 ms, input echo about 1.6 ms, observed max reload 83 ms, 3 reload cycles, main RSS growth 8176 KiB, renderer RSS growth 81584 KiB, taod RSS growth 20112 KiB, final active subscribers 0, final pending output bytes 0, and 393708 daemon output bytes.
- `pnpm exec oxfmt report.md apps/desktop/src/main/index.ts scripts/package-smoke.ts apps/desktop/package.json package.json .github/workflows/ci.yml && pnpm fmt:ts:check && pnpm check`: passed end to end after app-soak wiring and report updates, including lint, format check, TypeScript, 22 desktop tests, and 108 daemon tests.
- `pgrep -fl 'tao-app-soak|tao-electron-smoke|package-smoke|TAO_ELECTRON_SMOKE|tao-input-priority-bench|tao-file-tree-bench|tao-workspace-bench|tao-soak-bench|tao-detached-quit|tao-mid-request|tao-real-lifecycle|Electron|taod' || true`: no app-soak/package-smoke/smoke Electron/benchmark process remained; only unrelated app crashpad helpers and the pre-existing long-lived detached `taod` process were present.
- `git status --short --branch` after the packaged app-soak slice: confirmed the worktree remains dirty with expected ongoing review/fix files and the new app-soak edits; no unrelated files were reverted.
- `rg -n "bench:app-soak|app-soak|one-hour|full-app renderer|Commands Run|Commands Not Run" ...`: confirmed scripts, CI, smoke code, and report text reference the new app-soak budget while keeping literal one-hour and full-app renderer trace gaps explicit.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check` after recording app-soak verification: passed.
- `sed`/`rg` inspection of `apps/desktop/bench/run-electron.ts`, `apps/desktop/bench/file-tree-renderer-benchmark.ts`, `apps/desktop/bench/xterm-webgl-benchmark.ts`, `apps/desktop/src/renderer/ui/App.tsx`, `apps/desktop/src/renderer/diff-parser.ts`, and `node_modules/@pierre/diffs`: identified the existing Electron benchmark harnesses and real renderer dependencies needed for combined terminal/sidebar/diff pressure coverage.
- `pnpm exec oxfmt apps/desktop/bench/combined-renderer-benchmark.ts apps/desktop/package.json package.json .github/workflows/ci.yml && pnpm --filter @tao/desktop tsc && pnpm bench:renderer-combined:budget`: passed after adding the combined renderer benchmark and CI wiring. The budget run mounted xterm.js WebGL, `@pierre/trees`, and `@pierre/diffs/react` in one Electron renderer; with 25k file paths, 24 parsed diff files, 12 mounted diff bodies, and 2 MiB terminal output, it measured duration 388.90 ms, terminal throughput 5.49 MB/s, p95 frame 33.40 ms, max frame 157.40 ms, 2 frames over 16 ms, 1 frame over 50 ms, 9115 DOM nodes, and WebGL active.
- `pnpm exec oxfmt report.md apps/desktop/bench/combined-renderer-benchmark.ts apps/desktop/package.json package.json .github/workflows/ci.yml && pnpm fmt:ts:check && pnpm check`: passed end to end after combined renderer benchmark wiring, including lint, format check, TypeScript, 22 desktop tests, and 108 daemon tests.
- `pgrep -fl 'tao-combined-renderer-bench|tao-app-soak|tao-electron-smoke|package-smoke|TAO_ELECTRON_SMOKE|tao-input-priority-bench|tao-file-tree-bench|tao-workspace-bench|tao-soak-bench|tao-detached-quit|tao-mid-request|tao-real-lifecycle|Electron|taod' || true`: no combined-renderer/app-soak/package-smoke/smoke Electron/benchmark process remained; only unrelated app crashpad helpers and the pre-existing long-lived detached `taod` process were present.
- `git status --short --branch` after the combined renderer benchmark slice: confirmed the worktree remains dirty with expected ongoing review/fix files and the new `combined-renderer-benchmark.ts`; no unrelated files were reverted.
- `rg -n "renderer-combined|combined renderer|true one-hour|Still open|Commands Not Run|Commands Run" ...`: confirmed scripts, CI, benchmark code, and report text reference combined renderer pressure coverage while keeping the one-hour soak gap explicit.
- `pnpm exec oxfmt apps/desktop/src/main/index.ts apps/desktop/package.json package.json && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop build && pnpm bench:app-soak:budget > /tmp/tao-app-soak-budget-summary.log && node - <<'NODE' ...`: passed after adding duration-controlled app-soak support and compact smoke summaries. The parsed summary confirmed 3 reload cycles, requested duration `null` for the short budget, compact per-cycle result keys, main RSS growth 7664 KiB, renderer RSS growth 81568 KiB, and taod RSS growth 15920 KiB.
- `tail -80 /tmp/tao-app-soak-hour.log`, `pgrep -fl 'bench:app-soak:hour|package-smoke|TAO_ELECTRON_SMOKE|...|/taod$'`, and `git status --short --branch`: inspected the original hour-soak attempt; it was still running without useful progress telemetry, and only the pre-existing detached `taod` was unrelated to the smoke process tree.
- `rg`/`sed` inspection of package scripts, `scripts/package-smoke.ts`, and Electron smoke code: confirmed there is no Tao keychain/codesign path in this smoke. Any observed macOS keychain-not-found warning is Electron/macOS temporary-HOME noise, not a Tao daemon failure.
- `ps`, `lsof`, and `sample` inspections of the original hour run: found no useful renderer-helper progress and treated the run as invalid for a report baseline.
- `kill -TERM ...` followed by `kill -KILL ...` for the invalid original hour-run process tree: stopped the stale smoke/Electron process tree; cleanup checks left only the pre-existing detached `taod` process.
- `pnpm exec oxfmt apps/desktop/src/main/index.ts scripts/package-smoke.ts`: passed after adding smoke progress streaming and compact payload handling.
- `pnpm --filter @tao/desktop tsc`: passed after the progress/payload harness edit.
- `pnpm --filter @tao/desktop build && pnpm bench:app-soak:budget > /tmp/tao-app-soak-budget-after-progress.log`: passed. Parsed summary showed 3 reload cycles, 3 sampled cycles, last cycle 3, main RSS growth 6672 KiB, renderer RSS growth 81424 KiB, taod RSS growth 16208 KiB, and total smoke time 3111 ms.
- `cd apps/desktop && ... tsx ../../scripts/package-smoke.ts > /tmp/tao-duration-smoke-5s.log`: failed immediately because `tsx` was not on PATH outside `pnpm exec`.
- `cd apps/desktop && ... pnpm exec tsx ../../scripts/package-smoke.ts > /tmp/tao-duration-smoke-5s.log`: failed under the stricter 131072 KiB renderer RSS budget and then was manually killed after package-smoke timed out. The log showed renderer RSS growth 165024 KiB > 131072 KiB and progress through cycle 8.
- `pnpm exec oxfmt apps/desktop/src/main/index.ts scripts/package-smoke.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop build`: passed after adding the Electron forced-exit watchdog and compact progress metrics.
- `cd apps/desktop && TAO_ELECTRON_SMOKE_RELOAD_DURATION_MS=5000 ... pnpm exec tsx ../../scripts/package-smoke.ts > /tmp/tao-duration-smoke-5s-pass.log`: passed with relaxed 524288 KiB renderer RSS growth budget. Parsed summary showed 5 progress lines, 8 reload cycles, 3 sampled cycles, 4 stored cycle entries, last cycle 8, main RSS growth 17616 KiB, renderer RSS growth 167536 KiB, and taod RSS growth 47168 KiB.
- `pnpm bench:app-soak:hour > /tmp/tao-app-soak-hour.log`: failed for the no-delay hour profile. It reached about 75 reload cycles in the first minute, then failed with no progress for 182738 ms and a renderer V8 heap OOM at cycle 129 (`Heap: used=245.0MB limit=352.0MB`). This established that the no-delay script was an unrealistic reload stress profile, not a valid one-hour app-session baseline.
- `pnpm exec oxfmt apps/desktop/src/main/index.ts apps/desktop/package.json scripts/package-smoke.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop build`: passed after adding `TAO_ELECTRON_SMOKE_RELOAD_INTERVAL_MS` and setting `bench:app-soak:hour` to one reload per minute.
- `cd apps/desktop && TAO_ELECTRON_SMOKE_RELOAD_DURATION_MS=125000 TAO_ELECTRON_SMOKE_RELOAD_INTERVAL_MS=60000 ... pnpm exec tsx ../../scripts/package-smoke.ts > /tmp/tao-duration-smoke-125s-paced.log`: passed. Parsed summary showed 2 progress lines, 3 reload cycles over 126357 ms, main RSS growth -3936 KiB, renderer RSS growth 52304 KiB, and taod RSS growth 19392 KiB.
- `pnpm bench:app-soak:hour > /tmp/tao-app-soak-hour.log`: passed for the paced one-hour packaged app soak. The run completed 60 reload cycles over 3601286 ms, max reload 257 ms, first output 460 ms, input echo about 1.6 ms, main RSS growth 2624 KiB, renderer RSS growth 239472 KiB, taod RSS growth 297152 KiB, final active subscribers 0, final pending output bytes 0, zero slow-subscriber drops, 7874664 output bytes, and 4380 input bytes.
- `node - <<'NODE' ... /tmp/tao-app-soak-hour.log`: passed and extracted the one-hour metrics above from the `[electron-smoke] passed` JSON payload.
- `pgrep -fl 'bench:app-soak:hour|package-smoke|TAO_ELECTRON_SMOKE|best-operation/node_modules/.pnpm/electron|/taod$' || true`: confirmed no package-smoke/Electron smoke process remained; only the pre-existing detached `taod` process was still running.
- `rg -n "literal one-hour|true one-hour|has not been executed|still needs baselines|one-hour memory budgets remain|true one-hour memory|app-soak:hour" report.md`: found stale report text claiming the hour run had not been executed; the report was updated to the paced-hour baseline.
- `pnpm exec oxfmt report.md apps/desktop/src/main/index.ts scripts/package-smoke.ts apps/desktop/package.json && pnpm fmt:ts:check`: passed after recording the paced hour-soak baseline.
- `pnpm check`: passed end to end after the final report/package-smoke/package-script updates, including lint, format check, TypeScript, 22 desktop tests, and 108 daemon tests. Node emitted the existing `module.register()` deprecation warning during desktop tests.
- `pgrep -fl 'bench:app-soak:hour|package-smoke|TAO_ELECTRON_SMOKE|tao-app-soak|tao-electron-smoke|tao-input-priority-bench|tao-file-tree-bench|tao-workspace-bench|tao-soak-bench|tao-detached-quit|tao-mid-request|tao-real-lifecycle|Electron|/taod$' || true`: no smoke/benchmark/lifecycle process remained; only unrelated Superset/Slack crashpad helpers and the pre-existing detached `taod` process were present.
- `git status --short --branch`: confirmed the branch is still `best-operation` ahead of origin by 1 commit with the expected dirty review/fix files and no reverted unrelated changes.
- `rg -n "has not been executed|not been run|not run yet|one-hour memory budgets remain|true one-hour memory budgets remain|True one-hour memory growth still needs enforced proof|literal one-hour run still|literal one-hour soak has not" report.md || true`: found no stale narrative claims; the only match was the command-log entry describing the stale text that had been fixed.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check && git status --short --branch`: passed final report formatting and TypeScript formatting checks; final status remained dirty with the expected review/fix files.
- `git status --short --branch`: rechecked current state before continuing the trace/profiling slice; the worktree was still dirty on `best-operation`, ahead of origin by 1 commit.
- `rg`/`sed` inspection of `report.md`, `apps/desktop/bench/run-electron.ts`, `apps/desktop/bench/combined-renderer-benchmark.ts`, `apps/desktop/bench/xterm-webgl-benchmark.ts`, package scripts, `.github/workflows/ci.yml`, Electron contentTracing types, `scripts/package-smoke.ts`, and `apps/desktop/src/main/index.ts`: confirmed the remaining report gap was trace-based packaged renderer attribution and that Electron main's smoke path is the right place to capture a real packaged-app Chromium trace.
- `pnpm exec oxfmt apps/desktop/src/main/index.ts scripts/package-smoke.ts apps/desktop/package.json package.json && pnpm --filter @tao/desktop tsc`: passed after adding `TAO_ELECTRON_SMOKE_TRACE`, `TAO_ELECTRON_SMOKE_TRACE_MEMORY`, trace output path/buffer/category controls, package-smoke trace-line streaming, and `bench:app-trace` scripts.
- `pnpm --filter @tao/desktop build && pnpm bench:app-trace > /tmp/tao-app-trace.log`: passed. The build rebuilt `taod`, copied adapters, and rebuilt Electron main/preload/renderer output; the trace smoke launched the packaged app, captured a Chromium trace, exercised two-session reload/reattach and workspace resync, and passed package-smoke.
- `tail -80 /tmp/tao-app-trace.log`: confirmed `[electron-smoke] trace` and `[electron-smoke] passed` lines were streamed by package-smoke. The trace path was `out/bench/electron-smoke-trace.json`.
- `node - <<'NODE' ... /tmp/tao-app-trace.log`: passed and parsed the trace smoke result: `apps/desktop/out/bench/electron-smoke-trace.json` exists, size 4,258,546 bytes, categories include `electron`, `devtools.timeline`, `disabled-by-default-devtools.timeline`, `blink.user_timing`, `v8`, `gpu`, `cc`, `renderer.scheduler`, and `disabled-by-default-memory-infra`; memory tracing was enabled; 3 reload cycles completed; observed max reload was 88 ms; first output was 582 ms; input echo was 1.5 ms; main RSS growth was 7,312 KiB; renderer RSS growth was 82,928 KiB; `taod` RSS growth was 20,160 KiB; final pending output bytes and active subscribers were both 0.
- `pgrep -fl 'bench:app-trace|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|Electron|/taod$' || true`: confirmed no app-trace/package-smoke/smoke Electron process remained; only unrelated Superset/Slack crashpad helpers and the pre-existing detached `taod` process were present.
- `rg -n "Still open|app-trace|trace|manual trace|Chrome Performance trace|not run|missing trace|renderer trace" ...` and `git diff -- ...`: reviewed the new trace script/report wiring and found one stale manual-trace sentence, which was updated to point at `pnpm bench:app-trace`.
- `pnpm exec oxfmt report.md apps/desktop/src/main/index.ts scripts/package-smoke.ts apps/desktop/package.json package.json && pnpm fmt:ts:check && pnpm check`: passed end to end after trace wiring and report updates, including lint, format check, TypeScript, 22 desktop tests, and 108 daemon tests.
- `pgrep -fl 'bench:app-trace|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|Electron|/taod$' || true`: final cleanup check found no app-trace/package-smoke/smoke Electron process; only unrelated Superset/Slack crashpad helpers and the pre-existing detached `taod` process were present.
- `git status --short --branch`: final status remained dirty on `best-operation`, ahead of origin by 1 commit, with the expected ongoing review/fix files and new trace script wiring.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check`: passed after recording the final trace-slice verification commands.
- `git status --short --branch`: rechecked current state before the trace-analysis workflow slice; the worktree was still dirty on `best-operation`, ahead of origin by 1 commit.
- `rg -n "Still open|Partially done|Mostly done|remaining|..." report.md` and focused `sed` reads: confirmed the explicit open item was packaged trace analysis plus scheduled long-profile policy, while other architecture items remain partial.
- `ls -lh apps/desktop/out/bench/electron-smoke-trace.json` and `node - <<'NODE' ...`: confirmed the existing trace artifact was present and inspectable before adding the summary command.
- `node - <<'NODE' ... electron-smoke-trace.json`: ad hoc trace inspection parsed 25,056 events, identified 5 traced processes, found 9 renderer-main tasks over 50 ms, found no browser-main task over 50 ms, and showed the top renderer-main durations were V8 `LocalWindowProxy::Initialize` and renderer `RunTask`.
- `pnpm exec oxfmt apps/desktop/bench/trace-summary.ts apps/desktop/package.json package.json && pnpm --filter @tao/desktop tsc && pnpm bench:app-trace:summary > /tmp/tao-app-trace-summary.json`: passed after adding the repeatable trace summary command.
- `cat /tmp/tao-app-trace-summary.json`: showed the initial summary output, then revealed the duration calculation included metadata timestamps and needed tightening.
- `pnpm exec oxfmt apps/desktop/bench/trace-summary.ts && pnpm --filter @tao/desktop tsc && pnpm bench:app-trace:summary > /tmp/tao-app-trace-summary.json && node - <<'NODE' ...`: passed after fixing duration calculation to exclude metadata timestamps. Parsed summary: size 4,258,546 bytes, 25,056 events, 3,061.94 ms trace duration, 5 processes, 49 threads, 9 renderer-main tasks over 50 ms, max renderer-main task 73.42 ms, 0 browser-main tasks over 50 ms, top duration groups `LocalWindowProxy::Initialize` and renderer `RunTask`.
- `rg -n "decide whether|scheduled, non-PR|missing instrumentation|Manual trace analysis|Still open|app-trace:summary|performance-long" ...`: found stale summary/commands text after adding the trace summary and long-performance workflow; report text was updated to reflect the new policy.
- `pnpm exec oxfmt report.md apps/desktop/bench/trace-summary.ts apps/desktop/package.json package.json .github/workflows/performance-long.yml && pnpm fmt:ts:check && pnpm check`: passed after adding the trace summary command, long-performance workflow, and report updates, including lint, format check, TypeScript, 22 desktop tests, and 108 daemon tests.
- `pgrep -fl 'bench:app-trace|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|Electron|/taod$' || true`: final cleanup check found no app-trace/package-smoke/smoke Electron process; only unrelated Superset/Slack crashpad helpers and the pre-existing detached `taod` process were present.
- `git status --short --branch`: final status remained dirty on `best-operation`, ahead of origin by 1 commit, with expected ongoing review/fix files plus `.github/workflows/performance-long.yml` and `apps/desktop/bench/trace-summary.ts`.
- `rg -n "decide whether|scheduled, non-PR|missing instrumentation|Manual trace analysis|not run yet|has not been run|has not been executed|Still open|Partially done|Mostly done|remaining" report.md`: confirmed stale trace-policy language was gone and identified the next remaining partial areas as lifecycle/UI-state reload, observability correlation, and broader architecture items.
- `rg`/`sed` inspection of `packages/shared/src/session.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/env.d.ts`, `apps/desktop/src/main/layout-store.ts`, `apps/desktop/src/main/settings-store.ts`, and `apps/desktop/src/main/index.ts`: confirmed persisted layout/settings are exposed through preload and schema-validated in main, making them suitable for the next renderer reload smoke extension.
- `pnpm exec oxfmt apps/desktop/src/main/index.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop build && pnpm bench:reload:budget > /tmp/tao-reload-ui-state.log`: failed on the first UI-state attempt because strict `JSON.stringify` equality treated schema-normalized object key order as a mismatch before reload.
- `rg -n "keychain|Keychain|security:|codesign|CSC_|not found" ...`: found no keychain/codesign/signing text in the captured reload smoke log, package scripts, workflows, or package metadata; the active failure was UI-state smoke logic, not macOS keychain signing.
- `pnpm exec oxfmt apps/desktop/src/main/index.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop build && pnpm bench:reload:budget > /tmp/tao-reload-ui-state.log`: failed on the second UI-state attempt after reload because the renderer legitimately migrated layout version and added pane `lastSessionId` values after attaching sessions.
- `pnpm exec oxfmt apps/desktop/src/main/index.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop build && pnpm bench:reload:budget > /tmp/tao-reload-ui-state.log`: passed after switching the reload smoke to durable layout/settings invariant checks. The rebuilt packaged smoke completed one reload cycle with max reload 83 ms, UI-state read 0.60 ms, layout version 2, 2 panes, 1 tab, 1 workspace, active pane `electron-smoke-pane-b`, persistence enabled, final pending output bytes 0, and one active subscriber at the pre-kill diagnostic sample.
- `node - <<'NODE' ... /tmp/tao-reload-ui-state.log`: parsed the passing reload smoke payload and recorded the UI-state/workspace metrics above.
- `pnpm exec oxfmt report.md apps/desktop/src/main/index.ts && pnpm fmt:ts:check && pnpm check`: passed after recording the UI-state reload smoke work, including lint, format check, TypeScript, 22 desktop tests, and 108 daemon tests.
- `pgrep -fl 'bench:reload|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|Electron|/taod$' || true`: final cleanup check found no reload/package-smoke/smoke Electron process; only unrelated Superset/Slack crashpad helpers and the pre-existing detached `taod` process were present.
- `git status --short --branch`: final status remained dirty on `best-operation`, ahead of origin by 1 commit, with the expected ongoing review/fix files and UI-state reload smoke/report edits.
- `rg -n "full UI-state reload/resync|Full UI-state|remaining lifecycle proof gap|keychain|UI-state" report.md`: confirmed stale "full UI-state reload/resync remains" wording was replaced with narrower "broader interactive UI-state" wording, and existing keychain command notes still identify keychain as non-blocking Electron/macOS noise rather than the active smoke failure.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check && git status --short --branch`: passed final report formatting and TypeScript formatting checks; final status remained dirty with the expected ongoing review/fix files.
- `rg`/`sed` inspection of diagnostics schemas, `TaodClient`, preload `getTaodDiagnostics`, renderer env types, lifecycle tests, and report observability sections: confirmed the remaining observability gap was compact startup/ping timing and broader trace-id correlation.
- Initial `pnpm exec oxfmt packages/shared/src/taod-protocol.ts apps/desktop/src/main/taod-client.ts apps/desktop/src/main/taod-client-lifecycle.test.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: failed TypeScript because the new optional timing assertions did not narrow `lastPingDurationMs`.
- Follow-up `pnpm exec oxfmt apps/desktop/src/main/taod-client-lifecycle.test.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: passed after explicit undefined checks; desktop typecheck passed and 22 desktop persistence/lifecycle/stream tests passed.
- `pnpm exec oxfmt packages/shared/src/taod-protocol.ts apps/desktop/src/main/taod-client.ts apps/desktop/src/main/taod-client-lifecycle.test.ts apps/desktop/src/main/index.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: passed after adding packaged-smoke assertions for lifecycle timing diagnostics over preload; desktop typecheck passed and 22 desktop tests passed.
- `pnpm --filter @tao/desktop build && pnpm smoke:package > /tmp/tao-diagnostics-timing-smoke.log`: passed after rebuilding packaged output; package smoke verified the real preload/main diagnostics timing path.
- `node - <<'NODE' ... /tmp/tao-diagnostics-timing-smoke.log`: parsed the smoke payload and recorded total 890 ms, renderer load 271 ms, first output 611 ms, taod state `owned-live`, last ping 0 ms, and last start 232 ms.
- `pnpm exec oxfmt report.md packages/shared/src/taod-protocol.ts apps/desktop/src/main/taod-client.ts apps/desktop/src/main/taod-client-lifecycle.test.ts apps/desktop/src/main/index.ts && pnpm fmt:ts:check && pnpm check`: passed after diagnostics timing/report updates, including lint, format check, TypeScript, 22 desktop tests, and 108 daemon tests.
- `pgrep -fl 'diagnostics-timing|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|Electron|/taod$' || true`: final cleanup check found no diagnostics/package-smoke/smoke Electron process; only unrelated Superset/Slack crashpad helpers and the pre-existing detached `taod` process were present.
- `git status --short --branch`: final status remained dirty on `best-operation`, ahead of origin by 1 commit, with the expected ongoing review/fix files and diagnostics timing edits.
- `git status --short --branch`: rechecked current dirty state before the adapter timeout slice.
- `rg`/`sed` inspection of `report.md`, `apps/daemon/src/adapter.zig`, and daemon adapter tests: identified adapter timeout/hung-process handling as the next concrete unfinished report item.
- Initial `pnpm --filter @tao/daemon fmt:check && pnpm --filter @tao/daemon test`: failed to compile the new timeout runner because switching over POSIX signal constants inferred a comptime-only type.
- Follow-up `pnpm --filter @tao/daemon fmt:check && pnpm --filter @tao/daemon test`: crashed in the new timeout test because the timeout error path double-freed the adapter child output result during `errdefer` cleanup.
- Final `pnpm --filter @tao/daemon fmt:check && pnpm --filter @tao/daemon test`: passed after fixing child result ownership. The daemon suite now has 109 tests, including `agent adapter command timeout returns no detection`; the timeout test logged the expected redacted timeout warning and completed under the 3s assertion.
- `pnpm zig:leak-check`: passed after the adapter child-process timeout/cleanup change.
- `pgrep -fl 'hang.js|TAOD_ADAPTER|tsx .*hang|node .*hang|taod-root-test' || true`: found no leftover hung adapter or daemon test process after the timeout test.
- `pnpm exec oxfmt report.md apps/daemon/src/adapter.zig && pnpm fmt:ts:check && pnpm check`: passed after adapter timeout/report updates, including lint, format check, TypeScript, 22 desktop tests, and 109 daemon tests.
- `pgrep -fl 'hang.js|TAOD_ADAPTER|tsx .*hang|node .*hang|taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|Electron|/taod$' || true`: final cleanup check found no hung adapter, daemon test, package-smoke, or smoke Electron process; only unrelated Superset/Slack crashpad helpers and the pre-existing detached `taod` process were present.
- `git status --short --branch`: final status remained dirty on `best-operation`, ahead of origin by 1 commit, with the expected ongoing review/fix files and adapter timeout edits.
- `git status --short --branch` during the keychain/current-branch continuation: confirmed the dirty `best-operation` worktree and preserved existing changes.
- `rg -n "keychain|codesign|notar|security find|CSC_|APPLE_|SIGN" .`: found no Tao keychain/codesign/notarization configuration; only report notes mention the observed keychain noise, so it remains classified as non-blocking Electron/macOS temporary-HOME noise unless paired with a real failing assertion.
- `rg`/`sed` inspection of daemon RPC/workspace/git code, `TaodClient`, Electron main workspace handlers, `WorkspaceService`, shared workspace schemas, and report sections: confirmed branch/worktree-list metadata was partly wired to `taod` but missing Zig helpers, tests, desktop client methods, and removal of now-unused Electron main read helpers.
- `pnpm --filter @tao/desktop tsc`: passed after wiring `TaodClient.getGitBranch`, `TaodClient.getGitWorktrees`, and daemon-backed Electron main IPC handlers.
- `pnpm --filter @tao/daemon fmt:check`: passed after adding `git.freeWorktreeList`, `gitWorktreeBranch`, and daemon workspace branch/worktree-list handler tests.
- `pnpm --filter @tao/daemon test`: passed with 111 tests, including new `workspace branch response is served by daemon git path` and `workspace git worktrees response is served by daemon git path` coverage.
- `pnpm zig:leak-check`: passed after adding the shared worktree-list deinit helper and daemon handler tests.
- `pnpm exec oxfmt report.md apps/desktop/src/main/index.ts apps/desktop/src/main/taod-client.ts apps/desktop/src/main/workspace-service.ts apps/daemon/src/git.zig apps/daemon/src/workspace.zig apps/daemon/src/rpc.zig apps/daemon/src/daemon.zig apps/daemon/src/daemon/server.zig && pnpm fmt:ts:check && pnpm check`: passed after report/current-branch/worktree-list updates, including lint, format check, TypeScript, 22 desktop tests, and 111 daemon tests.
- `pgrep -fl 'tao-workspace-bench|taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|Electron|/taod$' || true`: found no smoke/package/benchmark process; only unrelated Superset/Slack crashpad helpers and the pre-existing detached `taod` process remained.
- `git status --short --branch`: final status remained dirty on `best-operation`, ahead of origin by 1 commit, with expected ongoing review/fix files and the current branch/worktree-list daemon migration edits.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check`: passed after recording final current-branch/worktree-list verification commands.
- `rg`/`sed` inspection of daemon RPC request fields, Electron main/preload Git action handlers, `WorkspaceService`, `TaodClient`, and shared workspace schemas: confirmed path actions still used Electron main command execution and identified `rootPath` plus a new `paths` array as the least ambiguous daemon request shape.
- `pnpm --filter @tao/desktop tsc`: passed after adding `TaodClient.stagePath`, `TaodClient.unstagePath`, `TaodClient.revertPath`, and switching Electron main path-action handlers to daemon calls.
- `pnpm --filter @tao/daemon fmt:check`: passed after adding `workspace.stagePath`, `workspace.unstagePath`, and `workspace.revertPath` request types/dispatch/handlers.
- `pnpm --filter @tao/daemon test`: passed with 113 tests, including new daemon Git path-action success coverage and option-shaped path rejection.
- `rg -n "execFile|runGit|git',|workspace:stagePath|workspace:unstagePath|workspace:revertPath|stageWorkspacePath|unstageWorkspacePath|revertWorkspacePath" apps/desktop/src/main apps/desktop/src/preload apps/desktop/src/renderer`: confirmed no remaining Electron main workspace Git action shell path; the remaining main `execFile` use is package-smoke RSS measurement via `ps`.
- `pnpm zig:leak-check`: passed after adding daemon Git path-action handlers and tests.
- `pnpm exec oxfmt report.md apps/desktop/src/main/index.ts apps/desktop/src/main/taod-client.ts apps/desktop/src/main/workspace-service.ts apps/daemon/src/rpc.zig apps/daemon/src/daemon.zig apps/daemon/src/daemon/server.zig apps/daemon/src/workspace.zig && pnpm fmt:ts:check && pnpm check`: passed after daemon Git mutation migration, including lint, format check, TypeScript, 22 desktop tests, and 113 daemon tests.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check && pgrep -fl 'taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|Electron|/taod$' || true && git status --short --branch`: passed report/TS formatting, found no smoke or daemon-test process, and confirmed the dirty `best-operation` worktree with expected ongoing review/fix files plus the pre-existing detached `taod` process.
- `rg`/`sed` inspection of `apps/daemon/src/adapter.zig`, daemon config, package smoke adapter env wiring, `TaodClient` adapter discovery, and packaging config: confirmed adapter runner timeout/allowlist existed and adapter directory/script writability was the remaining small hardening gap.
- Initial `pnpm --filter @tao/daemon fmt:check && pnpm --filter @tao/daemon test` after adding adapter provenance checks: passed with 114 tests, including group-writable adapter directory rejection, but showed that missing adapter dirs logged a misleading untrusted-directory warning.
- Follow-up `pnpm --filter @tao/daemon fmt:check && pnpm --filter @tao/daemon test`: passed with 114 tests after distinguishing missing adapter dirs from untrusted adapter dirs; missing dirs now silently fall back to argv heuristics.
- `pnpm zig:leak-check`: passed after adapter provenance checks.
- `pnpm exec oxfmt report.md apps/daemon/src/adapter.zig && pnpm fmt:ts:check && pnpm check`: passed after adapter provenance report updates, including lint, format check, TypeScript, 22 desktop tests, and 114 daemon tests.
- `pgrep -fl 'taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|Electron|/taod$' || true` and `git status --short --branch`: found no smoke or daemon-test process; only unrelated app crashpad helpers and the pre-existing detached `taod` remained. The worktree stayed dirty with expected ongoing review/fix files.
- `rg`/`sed` inspection of Effect 4 `ManagedRuntime.make` types, main runtime, the now-empty `WorkspaceService`, and remaining main references: confirmed `ManagedRuntime.make` requires a layer and the main layer no longer provided any service value after workspace Git commands moved to `taod`.
- `pnpm --filter @tao/desktop tsc`: passed after replacing the main `ManagedRuntime` with direct `Effect.runPromise`, narrowing `runMainEffect` to `never` context, removing the unused main `WorkspaceService` import, and deleting `apps/desktop/src/main/workspace-service.ts`.
- `pnpm exec oxfmt report.md apps/desktop/src/main/runtime.ts apps/desktop/src/main/index.ts && pnpm fmt:ts:check && pnpm check`: passed after removing the empty main Effect service layer, including lint, format check, TypeScript, 22 desktop tests, and 114 daemon tests.
- `pgrep -fl 'taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|Electron|/taod$' || true` and `git status --short --branch`: found no smoke or daemon-test process; only unrelated app crashpad helpers and the pre-existing detached `taod` remained. The worktree stayed dirty with expected ongoing review/fix files and deleted `apps/desktop/src/main/workspace-service.ts`.
- `pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: passed after preserving daemon error codes as workspace error kinds in `TaodClient`; desktop persistence/lifecycle/stream tests now pass with 23 tests.
- `pnpm exec oxfmt report.md apps/desktop/src/main/taod-client.ts apps/desktop/src/main/taod-client-lifecycle.test.ts && pnpm fmt:ts:check && pnpm check`: passed after daemon error-code preservation, including lint, format check, TypeScript, 23 desktop tests, and 114 daemon tests.
- `pgrep -fl 'taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|Electron|/taod$' || true` and `git status --short --branch`: found no smoke or daemon-test process; only unrelated app crashpad helpers and the pre-existing detached `taod` remained. The worktree stayed dirty with expected ongoing review/fix files.
- `sed`/`rg` inspection of Electron `BrowserWindow` webPreferences and preload imports: confirmed `sandbox: false` is tied to current preload usage of Electron `clipboard`, `shell`, `ipcRenderer`, and MessagePort APIs.
- `pnpm exec oxfmt report.md apps/desktop/src/main/index.ts && pnpm fmt:ts:check && pnpm check`: passed after documenting the Electron sandbox rationale, including lint, format check, TypeScript, 23 desktop tests, and 114 daemon tests.
- `pgrep -fl 'taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|Electron|/taod$' || true` and `git status --short --branch`: found no smoke or daemon-test process; only unrelated app crashpad helpers and the pre-existing detached `taod` remained. The worktree stayed dirty with expected ongoing review/fix files.
- `git status --short --branch`: confirmed the dirty `best-operation` worktree before the workspace-control fixture continuation.
- `rg`/`sed` inspection of `report.md`, `apps/desktop/src/main/taod-client-lifecycle.test.ts`, `apps/desktop/src/main/taod-client.ts`, and existing shared protocol fixture coverage: identified that workspace request-shape fixtures were the next narrow protocol-drift gap.
- Initial `pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence` after adding workspace request fixtures: failed because the new fake-socket test returned an error for `ping`, causing `TaodClient.ensureRunning()` to start a real daemon and collide with an active socket. No production source was changed by this failure.
- `pnpm --filter @tao/daemon fmt:check && pnpm --filter @tao/daemon test`: passed with 115 daemon tests, including the new shared workspace-control request fixture decoder test.
- Follow-up `pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: passed after fixing the fake-socket test to return a valid ping response; desktop persistence/lifecycle/stream tests now pass with 24 tests.
- Follow-up `pnpm --filter @tao/daemon fmt:check && pnpm --filter @tao/daemon test`: passed with 115 daemon tests.
- `pnpm exec oxfmt report.md apps/desktop/src/main/taod-client-lifecycle.test.ts apps/daemon/src/rpc.zig && pnpm fmt:ts:check && pnpm check`: passed after workspace-control fixture coverage and report updates, including lint, format check, TypeScript, 24 desktop tests, and 115 daemon tests.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check && pgrep -fl 'taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|Electron|/taod$' || true && git status --short --branch`: passed report/TS formatting, found no smoke or daemon-test process, and confirmed the dirty `best-operation` worktree with expected ongoing review/fix files plus the pre-existing detached `taod` process.
- `rg`/`sed` inspection of report gaps, `TaodClient` workspace request constructors, response normalizers, existing protocol fixtures, and the Zig fixture test: identified the remaining narrow protocol-drift gap as missing workspace metadata request fixtures for branches/status/file-tree/diff/ports/pull-request and unstage/revert path actions.
- `pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: passed after expanding the workspace-control fixture matrix; desktop persistence/lifecycle/stream tests pass with 24 tests.
- `pnpm --filter @tao/daemon fmt:check && pnpm --filter @tao/daemon test`: passed after expanding the workspace-control fixture matrix; daemon tests pass with 115 tests.
- `pnpm exec oxfmt report.md apps/desktop/src/main/taod-client-lifecycle.test.ts apps/daemon/src/rpc.zig && pnpm fmt:ts:check && pnpm check`: passed after expanding the workspace-control fixture matrix and report updates, including lint, format check, TypeScript, 24 desktop tests, and 115 daemon tests.
- `rg`/`sed` inspection of preload workspace APIs, main workspace IPC handlers, shared workspace schemas, and report IPC findings: confirmed workspace mutation payload validation now uses shared schemas in preload/main and identified missing negative schema coverage as the next small IPC-safety proof.
- `pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: passed after adding workspace IPC schema rejection coverage; desktop persistence/lifecycle/stream tests now pass with 25 tests.
- `pnpm exec oxfmt report.md apps/desktop/src/main/taod-client-lifecycle.test.ts && pnpm fmt:ts:check && pnpm check`: passed after IPC schema regression coverage and report updates, including lint, format check, TypeScript, 25 desktop tests, and 115 daemon tests.
- `pgrep -fl 'taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|Electron|/taod$' || true && git status --short --branch`: found no smoke or daemon-test process; only unrelated app crashpad helpers and the pre-existing detached `taod` remained. The worktree stayed dirty with expected ongoing review/fix files.
- `sed`/`rg` inspection of `TaodLifecycleDiagnosticsSchema`, `TaodClient` request/diagnostics flow, Zig `ControlRequestJson`, preload diagnostics decoding, and package-smoke diagnostics checks: identified a small trace-correlation gap that could be narrowed without touching terminal hot paths.
- `pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: passed after adding `clientTraceId`/`traceId` diagnostics and request propagation; desktop persistence/lifecycle/stream tests remain at 25 tests.
- `pnpm --filter @tao/daemon fmt:check && pnpm --filter @tao/daemon test`: passed after adding Zig `traceId`/`trace_id` request decoding; daemon tests remain at 115 tests.
- `pnpm exec oxfmt report.md apps/desktop/src/main/taod-client.ts apps/desktop/src/main/taod-client-lifecycle.test.ts packages/shared/src/taod-protocol.ts apps/daemon/src/rpc.zig && pnpm fmt:ts:check && pnpm check`: passed after trace-id diagnostics/report updates, including lint, format check, TypeScript, 25 desktop tests, and 115 daemon tests.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check && pgrep -fl 'taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|Electron|/taod$' || true && git status --short --branch`: passed report/TS formatting, found no smoke or daemon-test process, and confirmed the dirty `best-operation` worktree with expected ongoing review/fix files plus the pre-existing detached `taod` process.
- `rg`/`sed` inspection of daemon response helpers, `handleControlPayload`, `handleStream`, `TaodClient` response normalization, lifecycle diagnostics schemas, and lifecycle tests: identified daemon response trace echo as the next narrow step after request-side trace ids.
- Initial `pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence` after adding response trace echo: failed at TypeScript because the fake socket test helper referenced `request` before assigning it while building the echoed trace response. No production behavior failed.
- `pnpm --filter @tao/daemon fmt:check && pnpm --filter @tao/daemon test`: passed after adding generic daemon response trace wrapping; daemon tests now pass with 116 tests, including response trace wrapper coverage.
- Follow-up `pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: passed after fixing the fake socket helper; desktop persistence/lifecycle/stream tests remain at 25 tests.
- `pnpm exec oxfmt report.md apps/desktop/src/main/taod-client.ts apps/desktop/src/main/taod-client-lifecycle.test.ts packages/shared/src/taod-protocol.ts apps/daemon/src/rpc.zig apps/daemon/src/daemon/server.zig && pnpm fmt:ts:check && pnpm check`: passed after daemon response trace echo/report updates, including lint, format check, TypeScript, 25 desktop tests, and 116 daemon tests.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check && pgrep -fl 'taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|Electron|/taod$' || true && git status --short --branch`: passed report/TS formatting, found no smoke or daemon-test process, and confirmed the dirty `best-operation` worktree with expected ongoing review/fix files plus the pre-existing detached `taod` process.
- `git status --short --branch` during the IPC-negative-coverage continuation: confirmed the dirty `best-operation` worktree and preserved existing changes.
- `rg`/`sed` inspection of `report.md`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/main/taod-client-lifecycle.test.ts`, and `packages/shared/src/workspace.ts`: identified workspace/worktree mutation schemas as the next narrow IPC coverage gap.
- `pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: passed after expanding workspace IPC schema negative coverage; desktop persistence/lifecycle/stream tests remain at 25 tests.
- `pnpm exec oxfmt report.md apps/desktop/src/main/taod-client-lifecycle.test.ts && pnpm fmt:ts:check && pnpm check`: passed after the IPC schema/report update, including lint, format check, TypeScript, 25 desktop tests, and 116 daemon tests.
- `find`/`rg`/`sed` inspection of shared protocol fixtures, `TaodClient` workspace response normalization, and Zig workspace response builders: identified the remaining narrow protocol-drift gap as missing daemon-backed workspace response fixtures.
- Initial `pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence && pnpm --filter @tao/daemon fmt:check && pnpm --filter @tao/daemon test` after adding workspace response fixtures: desktop TypeScript and 26 desktop tests passed, daemon formatting passed, and daemon tests found the three Git path-action response fixtures were too narrow because generic control responses include explicit nullable fields.
- Follow-up `pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence && pnpm --filter @tao/daemon fmt:check && pnpm --filter @tao/daemon test`: passed after correcting the path-action response fixtures; desktop persistence/lifecycle/stream tests now include 26 tests and daemon tests now include 118 tests.
- `pnpm exec oxfmt report.md apps/desktop/src/main/taod-client-lifecycle.test.ts apps/daemon/src/workspace.zig packages/shared/fixtures/taod-protocol/control-workspace-*.ndjson && pnpm fmt:ts:check && pnpm check`: passed after workspace response fixture/report updates, including lint, format check, TypeScript, 26 desktop tests, and 118 daemon tests.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check && pgrep -fl 'taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|Electron|/taod$' || true && git status --short --branch`: passed report/TS formatting, found no smoke/package-smoke/daemon-test process, and confirmed the dirty `best-operation` worktree with expected ongoing files plus the pre-existing detached `taod` process.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check`: passed after recording the final process/status command.
- `git status --short --branch` during the non-workspace response fixture continuation: confirmed the dirty `best-operation` worktree and preserved existing changes.
- `rg`/`sed` inspection of `report.md`, daemon session/control response builders, `rpc.ControlResponse`, and `TaodClient` session/maintenance methods: identified session-shaped, history cleanup, retention cleanup, and persistence configuration responses as the next protocol-drift fixture gap.
- `pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence && pnpm --filter @tao/daemon fmt:check && pnpm --filter @tao/daemon test`: passed after adding non-workspace control response fixtures; desktop persistence/lifecycle/stream tests now include 27 tests and daemon tests now include 120 tests.
- `pnpm exec oxfmt report.md apps/desktop/src/main/taod-client-lifecycle.test.ts apps/daemon/src/daemon/protocol.zig apps/daemon/src/rpc.zig packages/shared/fixtures/taod-protocol/control-*.ndjson && pnpm fmt:ts:check && pnpm check`: passed after non-workspace control response fixture/report updates, including lint, format check, TypeScript, 27 desktop tests, and 120 daemon tests.
- `sed`/`rg` inspection of workspace/worktree response payload structs and `TaodClient` workspace/worktree mutation normalizers: identified workspace list/add/refresh/remove and worktree create/refresh/remove as the remaining fixture-light protocol response shapes.
- `pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence && pnpm --filter @tao/daemon fmt:check && pnpm --filter @tao/daemon test`: passed after adding workspace/worktree mutation response fixtures; desktop persistence/lifecycle/stream tests now include 28 tests and daemon tests now include 122 tests.
- `pnpm exec oxfmt report.md apps/desktop/src/main/taod-client-lifecycle.test.ts apps/daemon/src/rpc.zig apps/daemon/src/workspace.zig apps/daemon/src/worktree.zig apps/daemon/src/daemon/protocol.zig packages/shared/fixtures/taod-protocol/control-*.ndjson && pnpm fmt:ts:check && pnpm check`: passed after workspace/worktree mutation response fixture/report updates, including lint, format check, TypeScript, 28 desktop tests, and 122 daemon tests.
- `rg -n "fixture-light|partly fixture|central protocol spec|Still open|remaining gap|remaining|Partially done|Mostly done|GitStateWatcher|cancellation|backpressure|trace" report.md`: confirmed the stale fixture-light wording is gone and the remaining report gaps are now larger architecture/performance/observability items.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check && pgrep -fl 'taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|Electron|/taod$' || true && git status --short --branch`: passed report/TS formatting, found no smoke/package-smoke/daemon-test process, and confirmed the dirty `best-operation` worktree with expected ongoing files plus the pre-existing detached `taod` process.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check`: passed after recording the final status command.
- `rg`/`sed` inspection of protocol constants, stream limits, existing fixtures, and TS/Zig protocol tests: identified the remaining central-spec gap as an implicit fixture inventory with no language-neutral manifest.
- `pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence && pnpm --filter @tao/daemon fmt:check && pnpm --filter @tao/daemon test`: passed after adding `spec.json` and TS/Zig manifest tests; desktop persistence/lifecycle/stream tests now include 29 tests and daemon tests now include 123 tests.
- `pnpm exec oxfmt report.md apps/desktop/src/main/taod-stream.test.ts apps/daemon/src/rpc.zig packages/shared/fixtures/taod-protocol/spec.json && pnpm fmt:ts:check && pnpm check`: passed after protocol manifest/report updates, including lint, format check, TypeScript, 29 desktop tests, and 123 daemon tests.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check && pgrep -fl 'taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|Electron|/taod$' || true && git status --short --branch`: passed report/TS formatting, found no smoke/package-smoke/daemon-test process, and confirmed the dirty `best-operation` worktree with expected ongoing files plus the pre-existing detached `taod` process.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check`: passed after recording the final protocol-manifest status command.
- `git status --short --branch`: rechecked current worktree state before the daemon-control-diagnostics slice; the branch remained `best-operation`, ahead of origin by 1 commit, with expected dirty review/fix files.
- `rg`/`sed`/`nl` inspection of `report.md`, `packages/shared/src/taod-protocol.ts`, `apps/desktop/src/main/taod-client.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/env.d.ts`, `apps/desktop/src/main/taod-client-lifecycle.test.ts`, `apps/daemon/src/rpc.zig`, `apps/daemon/src/daemon.zig`, and `apps/daemon/src/daemon/server.zig`: confirmed the remaining observability gap was daemon-side trace counters/log context after request/response trace ids already existed.
- `pnpm exec oxfmt packages/shared/src/taod-protocol.ts apps/desktop/src/main/taod-client.ts apps/desktop/src/main/taod-client-lifecycle.test.ts apps/desktop/src/main/index.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: passed after adding shared `TaodDaemonControlDiagnostics`, desktop normalization, tests, and packaged-smoke assertions; desktop persistence/lifecycle/stream tests remain at 29 tests.
- `pnpm exec oxfmt apps/daemon/src/daemon.zig apps/daemon/src/daemon/server.zig apps/daemon/src/rpc.zig packages/shared/fixtures/taod-protocol/control-ping-response.ndjson && pnpm --filter @tao/daemon fmt:check && pnpm --filter @tao/daemon test`: failed immediately because `oxfmt` ignores Zig/NDJSON inputs and reported no target files; no product source test failed in that command.
- Initial `pnpm --filter @tao/daemon fmt:check && pnpm --filter @tao/daemon test` after adding `control_diagnostics` directly to `rpc.ControlResponse`: daemon formatting passed, but daemon tests failed because the generic response struct added `"control_diagnostics":null` to every response fixture. The implementation was narrowed so only ping diagnostics responses carry the new object.
- Follow-up `pnpm --filter @tao/daemon fmt:check && pnpm --filter @tao/daemon test`: passed after narrowing `control_diagnostics` to the ping response wrapper; daemon tests now include 124 tests, including `daemon control diagnostics report last traced request`.
- `pnpm --filter @tao/desktop build && pnpm smoke:package > /tmp/tao-control-diagnostics-smoke.log`: passed after rebuilding the packaged Electron/taod output; the real smoke path verified daemon control diagnostics through Electron/preload/main and completed in about 927 ms total startup time.
- `cat /tmp/tao-control-diagnostics-smoke.log && node - <<'NODE' ...`: inspected the packaged smoke log; the first ad hoc parser looked at the wrong JSON field for `totalMs`, but confirmed the smoke passed and included `daemonControlDiagnostics`.
- Follow-up `node - <<'NODE' ... /tmp/tao-control-diagnostics-smoke.log`: parsed the smoke payload correctly: total startup 927 ms, renderer ready 7 ms, first output 646 ms, taod state `owned-live`, stable client trace `taod-client-mph4d8o5-1`, latest client control trace `taod-client-mph4d8o5-1:ping-mph4d955-l`, and daemon control diagnostics with request count 10, failure count 0, last request type `ping`, and last trace `taod-client-mph4d8o5-1:ping-mph4d955-k`.
- `pnpm exec oxfmt report.md packages/shared/src/taod-protocol.ts apps/desktop/src/main/taod-client.ts apps/desktop/src/main/taod-client-lifecycle.test.ts apps/desktop/src/main/index.ts && pnpm fmt:ts:check && pnpm check`: passed after daemon-control-diagnostics updates, including lint, format check, TypeScript, 29 desktop tests, and 124 daemon tests.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check && pgrep -fl 'taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|Electron|/taod$' || true && git status --short --branch`: passed report/TS formatting, found no package-smoke/smoke Electron/daemon-test process, and confirmed the dirty `best-operation` worktree with expected ongoing files plus the pre-existing detached `taod` process.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check`: passed after recording the daemon-control-diagnostics status command.
- `git status --short --branch` plus `rg`/`sed` inspection of report observability gaps and renderer/main/preload trace surfaces: confirmed the remaining small observability gap was renderer UI spans after daemon request/response/control diagnostics existed.
- `sed` inspection of Electron smoke scripts, renderer `App`, `TerminalPane`, `terminal.ts`, preload diagnostics, and renderer env types: confirmed packaged smoke executes app/layout startup directly and terminal UI spans only when the normal UI path mounts terminal panes.
- `pnpm exec oxfmt apps/desktop/src/renderer/trace.ts apps/desktop/src/renderer/terminal.ts apps/desktop/src/renderer/ui/App.tsx apps/desktop/src/main/index.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: passed after adding renderer user-timing helpers and initial smoke assertions; desktop persistence/lifecycle/stream tests remain at 29 tests.
- Initial `pnpm --filter @tao/desktop build && pnpm smoke:package > /tmp/tao-renderer-trace-smoke.log`: failed because the smoke required terminal user-timing spans, but the packaged startup smoke path had only mounted the app/layout UI before the injected direct session workload. The assertion was narrowed to require app/layout marks while keeping terminal spans for real terminal pane mounts.
- Follow-up `pnpm exec oxfmt apps/desktop/src/main/index.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop build && pnpm smoke:package > /tmp/tao-renderer-trace-smoke.log`: passed. Parsed smoke output showed total startup 941 ms, renderer trace count 2, and startup trace names `tao:ui:app-mounted` and `tao:ui:layout-loaded`.
- `cat /tmp/tao-renderer-trace-smoke.log | tail -20 && node - <<'NODE' ...`: parsed the passing smoke payload above and confirmed taod remained `owned-live` with pending output bytes 0.
- `sed` inspection of `apps/desktop/bench/trace-summary.ts`: confirmed the trace summary did not yet surface Tao user-timing entries.
- `pnpm exec oxfmt apps/desktop/bench/trace-summary.ts && pnpm --filter @tao/desktop tsc && pnpm bench:app-trace > /tmp/tao-renderer-user-timing-trace.log && pnpm bench:app-trace:summary > /tmp/tao-renderer-user-timing-summary.json`: passed after adding Tao user-timing extraction to the trace summary command.
- `cat /tmp/tao-renderer-user-timing-summary.json && tail -20 /tmp/tao-renderer-user-timing-trace.log`: confirmed the packaged trace summary now reports 72 Tao user-timing events, including `tao:ui:app-mounted`, `tao:ui:layout-loaded`, `tao:terminal:create`, `tao:terminal:fonts`, `tao:terminal:xterm-open`, `tao:terminal:attach`, `tao:terminal:reveal`, `tao:terminal:surface-visible`, and `tao:terminal:ready`.
- `pnpm exec oxfmt report.md apps/desktop/src/renderer/trace.ts apps/desktop/src/renderer/terminal.ts apps/desktop/src/renderer/ui/App.tsx apps/desktop/src/main/index.ts apps/desktop/bench/trace-summary.ts && pnpm fmt:ts:check && pnpm check`: passed after renderer user-timing/report updates, including lint, format check, TypeScript, 29 desktop tests, and 124 daemon tests.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check && pgrep -fl 'taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|bench:app-trace|Electron|/taod$' || true && git status --short --branch`: passed report/TS formatting, found no package-smoke/app-trace/smoke Electron/daemon-test process, and confirmed the dirty `best-operation` worktree with expected ongoing files plus the pre-existing detached `taod` process.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check`: passed after recording the renderer user-timing status command.
- `git status --short --branch`, `rg`, and `sed` inspection of the report and daemon control/logging path: confirmed the remaining narrow observability gap was daemon trace-id logging policy after renderer user-timing and daemon diagnostics existed.
- `pnpm --filter @tao/daemon fmt:check && pnpm --filter @tao/daemon test`: passed after adding failed/slow control request trace-id logging and a deterministic logging-policy test; daemon tests now include 125 tests.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check && pnpm check`: passed after daemon trace logging/report updates, including lint, format check, TypeScript, 29 desktop tests, and 125 daemon tests.
- `rg -n "keychain|codesign|sign|not found|security:" report.md apps/desktop package.json pnpm-lock.yaml` and `git status --short --branch`: rechecked the user's keychain warning question; no repo-level signing/keychain path was found, and only prior report notes classify it as Electron/macOS temporary-HOME noise.
- `sed`/`rg` inspection of `scripts/package-smoke.ts`, Electron smoke code, package scripts, and workflows: confirmed the smoke runner sets `HOME` to a fresh temporary directory for both `taod --check` and Electron, which explains macOS keychain probing warnings without a normal login keychain.
- `git status --short --branch` and `rg -n "Still open|remaining|...|GitStateWatcher|watcher|observability" report.md`: rechecked the current dirty `best-operation` worktree and identified Git metadata watcher diagnostics as the next narrow report-backed gap.
- `rg --files`, `sed`, and `rg` inspection of `GitStateWatcher`, workspace IPC handlers, preload diagnostics, renderer env types, smoke workspace reload scripts, and shared workspace schemas: confirmed Electron main still owns watcher/refresh policy and that a read-only diagnostics IPC was the smallest safe observability improvement.
- Initial `pnpm exec oxfmt ... && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: passed after adding watcher diagnostics, schema validation, preload/env API, reload-smoke assertions, and watcher unit tests, but the expected failure test printed the intentional warning.
- Follow-up `pnpm exec oxfmt apps/desktop/src/main/git-state-watcher.test.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: failed after suppressing the intentional warning because the first watcher test expected exactly two queued refreshes, while real `fs.watch` setup can legitimately enqueue extra `fs-event` refreshes.
- Follow-up `pnpm exec oxfmt apps/desktop/src/main/git-state-watcher.test.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: failed after relaxing the queue count because real `fs.watch` setup had already queued another refresh at the observation point.
- Final `pnpm exec oxfmt apps/desktop/src/main/git-state-watcher.test.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: passed after making the watcher test assert stable policy outcomes instead of exact platform-specific watcher event counts; desktop persistence/lifecycle/stream tests now include 31 tests.
- `pnpm --filter @tao/desktop build && pnpm bench:reload:budget > /tmp/tao-workspace-watcher-diagnostics-reload.log`: passed after rebuilding `taod` and Electron output. The packaged reload smoke now proves watcher diagnostics over the real renderer/preload/main path: setup saw one tracked workspace with three watchers and cleanup saw zero tracked workspaces/watchers; observed max reload was about 85 ms.
- `tail -40 /tmp/tao-workspace-watcher-diagnostics-reload.log` and a `node` parser for the `[electron-smoke] passed` payload: confirmed one reload cycle, watcher setup `{ trackedWorkspaces: 1, totalWatchers: 3, watcherCount: 3, watcherInstallCount: 1 }`, watcher cleanup `{ trackedWorkspaces: 0, totalWatchers: 0 }`, and pending daemon output bytes 0.
- `pnpm exec oxfmt report.md apps/desktop/src/main/git-state-watcher.ts apps/desktop/src/main/git-state-watcher.test.ts apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/env.d.ts apps/desktop/package.json packages/shared/src/workspace.ts && pnpm fmt:ts:check && pnpm check`: passed after watcher diagnostics/report updates, including lint, format check, TypeScript, 31 desktop tests, and 125 daemon tests.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check && pgrep -fl 'taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|bench:reload|Electron|/taod$' || true && git status --short --branch`: passed report/TS formatting, found no package-smoke/reload/smoke Electron/daemon-test process, and confirmed the dirty `best-operation` worktree with expected ongoing files plus unrelated app crashpad helpers and the pre-existing detached `taod` process.
- `git status --short --branch`, `pnpm exec oxfmt report.md && pnpm fmt:ts:check`, and `rg -n "Still open|remaining|...|Effect|cancellation|timeout|interrupt" report.md`: confirmed the current dirty worktree, re-verified the prior report-only patch formatting, and identified renderer metadata cache stale-work handling as the next Effect/resource-safety gap.
- `sed`/`rg` inspection of `apps/desktop/src/renderer/workspace-service.ts`, `workspaceQueries.ts`, renderer runtime, and installed Effect 4 beta `ManagedRuntime` types: confirmed renderer workspace metadata has typed errors and timeouts but normal in-flight refresh coalescing also blocked forced refresh until stale work completed.
- `pnpm exec oxfmt apps/desktop/src/renderer/workspace-service.ts apps/desktop/test/workspace-service.test.ts apps/desktop/package.json && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: passed after allowing forced metadata refreshes to supersede stale in-flight results and adding focused renderer service coverage; desktop persistence/lifecycle/stream tests now include 32 tests.
- Initial `pnpm exec oxfmt report.md apps/desktop/src/renderer/workspace-service.ts apps/desktop/test/workspace-service.test.ts apps/desktop/package.json && pnpm fmt:ts:check && pnpm check`: failed in `GitStateWatcher diagnostics record refresh failures`; the newly added watcher test used unref'd debounce timers and was flaky under the full multi-process gate.
- `pnpm exec oxfmt apps/desktop/src/main/git-state-watcher.ts apps/desktop/src/main/git-state-watcher.test.ts && pnpm --filter @tao/desktop exec tsx --test src/main/git-state-watcher.test.ts`: passed after keeping production watcher debounce timers unref'd while letting tests opt into ref'd timers for deterministic refresh execution.
- Final `pnpm exec oxfmt report.md apps/desktop/src/main/git-state-watcher.ts apps/desktop/src/main/git-state-watcher.test.ts apps/desktop/src/renderer/workspace-service.ts apps/desktop/test/workspace-service.test.ts apps/desktop/package.json && pnpm fmt:ts:check && pnpm check`: passed after the Effect cache supersession and deterministic watcher-test updates, including lint, format check, TypeScript, 32 desktop tests, and 125 daemon tests.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check && pgrep -fl 'taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|bench:reload|Electron|/taod$' || true && git status --short --branch`: passed report/TS formatting, found no package-smoke/reload/smoke Electron/daemon-test process, and confirmed the dirty `best-operation` worktree with expected ongoing files plus unrelated app crashpad helpers and the pre-existing detached `taod` process.
- `git status --short --branch`, `pnpm exec oxfmt report.md && pnpm fmt:ts:check`, and `rg -n "Still open|remaining|...|backpressure|xterm|terminal-output" report.md`: confirmed the current dirty worktree, re-verified the prior report-only patch formatting, and identified xterm output callback/backlog attribution as the next small terminal backpressure gap.
- `sed`/`rg` inspection of `terminal-output-writer.ts`, terminal diagnostics registration, preload diagnostics, package smoke summaries, and xterm/combined renderer benchmarks: confirmed the writer already reports current queues but did not report completed write counts, xterm callback latency, or high-water write queue depth.
- Initial `pnpm exec oxfmt apps/desktop/src/renderer/terminal-output-writer.ts apps/desktop/test/terminal-output-writer.test.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: failed because the still-flaky watcher test used a ref'd 1 ms timer in the full desktop test run, and because the new writer high-water assertion expected only queued chunks instead of active-plus-queued write depth.
- Follow-up `pnpm exec oxfmt apps/desktop/src/main/git-state-watcher.ts apps/desktop/src/main/git-state-watcher.test.ts apps/desktop/src/renderer/terminal-output-writer.ts apps/desktop/test/terminal-output-writer.test.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: passed after making the watcher failure test use the no-debounce deterministic test path and updating writer assertions for active-plus-queued high-water depth; desktop persistence/lifecycle/stream tests remain at 32 tests.
- `pnpm exec oxfmt apps/desktop/src/main/git-state-watcher.test.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: passed after relaxing the watcher failure test to accept one or more refresh failures, because filesystem watcher events can legitimately schedule another immediate failed refresh before the assertion observes the first one.
- `pnpm exec oxfmt report.md apps/desktop/src/main/git-state-watcher.ts apps/desktop/src/main/git-state-watcher.test.ts apps/desktop/src/renderer/terminal-output-writer.ts apps/desktop/test/terminal-output-writer.test.ts && pnpm fmt:ts:check && pnpm check`: passed after xterm output writer diagnostics and watcher-test stability updates, including lint, format check, TypeScript, 32 desktop tests, and 125 daemon tests.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check && pgrep -fl 'taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|bench:reload|Electron|/taod$' || true && git status --short --branch`: passed report/TS formatting, found no package-smoke/reload/smoke Electron/daemon-test process, and confirmed the dirty `best-operation` worktree with unrelated app crashpad helpers and the pre-existing detached `taod` process.
- `rg`/`sed` inspection of `TaodClient`, lifecycle diagnostics schemas, preload diagnostics, fake lifecycle tests, and real lifecycle tests: confirmed lifecycle states already existed, but diagnostics did not expose whether the daemon was external, attached-owned, detached-owned, or deliberately released on dispose.
- `pnpm exec oxfmt packages/shared/src/taod-protocol.ts apps/desktop/src/main/taod-client.ts apps/desktop/src/main/taod-client-lifecycle.test.ts apps/desktop/src/main/taod-client-real-lifecycle.test.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: passed after adding daemon-ownership diagnostics and fake-socket assertions; desktop persistence/lifecycle/stream tests remain at 32 tests.
- `pnpm --filter @tao/desktop test:taod-lifecycle`: passed after adding real-daemon ownership assertions for attached owned daemon restart, detached daemon release on client dispose, and mid-request owned daemon restart; 3 real lifecycle tests passed.
- `pnpm exec oxfmt report.md packages/shared/src/taod-protocol.ts apps/desktop/src/main/taod-client.ts apps/desktop/src/main/taod-client-lifecycle.test.ts apps/desktop/src/main/taod-client-real-lifecycle.test.ts && pnpm fmt:ts:check && pnpm check`: passed after daemon-ownership diagnostics/report updates, including lint, format check, TypeScript, 32 desktop tests, and 125 daemon tests.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check && pgrep -fl 'taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|bench:reload|Electron|/taod$' || true && git status --short --branch`: passed report/TS formatting, found no package-smoke/reload/smoke Electron/daemon-test process, and confirmed the dirty `best-operation` worktree with unrelated app crashpad helpers and the pre-existing detached `taod` process.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check`: passed after recording the daemon-ownership status command.
- `git status --short --branch`, `rg`, and `sed` inspection of `report.md`: confirmed the current dirty worktree and identified the user-visible daemon recovery policy as the next high-priority lifecycle gap.
- `pnpm exec oxfmt packages/shared/src/taod-protocol.ts apps/desktop/src/main/taod-client.ts apps/desktop/src/main/taod-client-lifecycle.test.ts apps/desktop/src/main/taod-client-real-lifecycle.test.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: passed after adding typed lifecycle recovery actions and fake-socket assertions for absent, external-live, version-mismatch, stale-socket, and normal request states; desktop persistence/lifecycle/stream tests remain at 32 tests.
- `pnpm --filter @tao/desktop test:taod-lifecycle`: passed after adding real-daemon recovery-action assertions for attached daemon restart, detached daemon release on client dispose, and mid-request owned daemon restart; 3 real lifecycle tests passed.
- `pnpm exec oxfmt report.md packages/shared/src/taod-protocol.ts apps/desktop/src/main/taod-client.ts apps/desktop/src/main/taod-client-lifecycle.test.ts apps/desktop/src/main/taod-client-real-lifecycle.test.ts && pnpm fmt:ts:check && pnpm check`: passed after lifecycle recovery-action/report updates, including lint, format check, TypeScript, 32 desktop tests, and 125 daemon tests.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check && pgrep -fl 'taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|bench:reload|Electron|/taod$' || true && git status --short --branch`: passed report/TS formatting, found no package-smoke/reload/smoke Electron/daemon-test process, and confirmed the dirty `best-operation` worktree with unrelated app crashpad helpers and the pre-existing detached `taod` process.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check`: passed after recording the lifecycle recovery-action status command.
- `git status --short --branch` plus `rg`/`sed` inspection of `report.md`, renderer `App.tsx`, renderer CSS, preload diagnostics, and Electron smoke scripts: confirmed the remaining lifecycle gap was a renderer-visible recovery surface backed by existing `getTaodDiagnostics()`.
- `pnpm exec oxfmt apps/desktop/src/renderer/ui/App.tsx apps/desktop/src/renderer/styles.css apps/desktop/src/main/index.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: passed after adding the compact renderer recovery indicator and packaged smoke recovery-policy assertions; desktop persistence/lifecycle/stream tests remain at 32 tests.
- `pnpm --filter @tao/desktop build && pnpm smoke:package`: passed after rebuilding `out/`; the packaged Electron smoke payload included `daemonOwnership:"owned-attached"` and `recoveryAction:"none"` through the real Electron/preload/main/taod diagnostics path and completed in about 1.19 seconds.
- `pnpm exec oxfmt report.md apps/desktop/src/renderer/ui/App.tsx apps/desktop/src/renderer/styles.css apps/desktop/src/main/index.ts && pnpm fmt:ts:check && pnpm check`: passed after renderer recovery-indicator/report updates, including lint, format check, TypeScript, 32 desktop tests, and 125 daemon tests.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check && pgrep -fl 'taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|bench:reload|Electron|/taod$' || true && git status --short --branch`: passed report/TS formatting, found no package-smoke/reload/smoke Electron/daemon-test process, and confirmed the dirty `best-operation` worktree with unrelated app crashpad helpers and the pre-existing detached `taod` process.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check`: passed after recording the renderer recovery-indicator status command.
- `git status --short --branch`, `rg`, and `sed` inspection of `report.md`, renderer `App.tsx`, renderer CSS, and shared diagnostics schemas: confirmed the remaining lifecycle gap was no renderer diagnostics panel/guided recovery surface after the compact recovery indicator.
- `pnpm exec oxfmt apps/desktop/src/renderer/ui/App.tsx apps/desktop/src/renderer/styles.css && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: passed after extending the renderer daemon recovery indicator into a diagnostics popover; desktop persistence/lifecycle/stream tests remain at 32 tests.
- `git diff -- apps/desktop/src/renderer/ui/App.tsx apps/desktop/src/renderer/styles.css` plus focused `sed` reads of `report.md`: reviewed the UI/report patch before package verification.
- `pnpm --filter @tao/desktop build && pnpm smoke:package`: passed after rebuilding `out/`; the packaged Electron smoke payload included real diagnostics with `daemonOwnership:"owned-attached"` and `recoveryAction:"none"`, renderer load about 266 ms, first output about 649 ms, and completed in about 1.17 seconds.
- Initial `pnpm exec oxfmt report.md apps/desktop/src/renderer/ui/App.tsx apps/desktop/src/renderer/styles.css && pnpm fmt:ts:check && pnpm check`: failed in desktop lint because the diagnostics popover used `role="status"` on a `div`; the role was removed instead of suppressing the a11y rule.
- Follow-up `pnpm exec oxfmt report.md apps/desktop/src/renderer/ui/App.tsx apps/desktop/src/renderer/styles.css && pnpm fmt:ts:check && pnpm check`: passed after removing the diagnostics popover `role="status"`, including lint, format check, TypeScript, 32 desktop tests, and 125 daemon tests.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check && pgrep -fl 'taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|bench:reload|Electron|/taod$' || true && git status --short --branch`: passed report/TS formatting, found no package-smoke/reload/smoke Electron/daemon-test process, and confirmed the dirty `best-operation` worktree with unrelated app crashpad helpers and the pre-existing detached `taod` process.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check`: passed after recording the process/status command.
- `git status --short --branch`, `rg`, and `sed` inspection of `report.md`, `TaodClient`, main/preload diagnostics IPC, renderer API types, and lifecycle tests: confirmed the remaining lifecycle gap was guided recovery actions after diagnostics and the popover existed.
- `rg -n "Tao|tao|best-operation|TaodClient|report.md" /Users/dp/.codex/memories/MEMORY.md | head -40`: used memory only as a routing hint for prior Tao startup/lifecycle context; current worktree inspection remained authoritative.
- Initial `pnpm exec oxfmt packages/shared/src/taod-protocol.ts apps/desktop/src/main/taod-client.ts apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/env.d.ts apps/desktop/src/renderer/ui/App.tsx apps/desktop/src/renderer/styles.css apps/desktop/src/main/taod-client-lifecycle.test.ts apps/desktop/src/main/taod-client-real-lifecycle.test.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: failed in TypeScript because the new `TaodClient.applyLifecycleRecovery` switch still included unreachable no-op cases after action narrowing.
- Follow-up `pnpm exec oxfmt apps/desktop/src/main/taod-client.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: passed after removing the unreachable switch cases; desktop persistence/lifecycle/stream tests now include 34 tests, including compatible external daemon reuse and external incompatible daemon replacement refusal.
- `pnpm --filter @tao/desktop test:taod-lifecycle`: passed after changing the real owned-daemon crash test to use manual `applyLifecycleRecovery('restart-owned-daemon')`; 3 real lifecycle tests passed.
- `pnpm --filter @tao/desktop build && pnpm smoke:package`: passed after adding the typed `taod:recover` IPC/preload/renderer path and rebuilding `out/`; the packaged Electron smoke payload included real diagnostics with `daemonOwnership:"owned-attached"` and `recoveryAction:"none"`, renderer load about 268 ms, first output about 628 ms, and completed in about 1.15 seconds.
- `pnpm exec oxfmt report.md packages/shared/src/taod-protocol.ts apps/desktop/src/main/taod-client.ts apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/env.d.ts apps/desktop/src/renderer/ui/App.tsx apps/desktop/src/renderer/styles.css apps/desktop/src/main/taod-client-lifecycle.test.ts apps/desktop/src/main/taod-client-real-lifecycle.test.ts && pnpm fmt:ts:check && pnpm check`: passed after guided recovery/report updates, including lint, format check, TypeScript, 34 desktop tests, and 125 daemon tests.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check && pgrep -fl 'taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|bench:reload|Electron|/taod$' || true && git status --short --branch`: passed report/TS formatting, found no package-smoke/reload/smoke Electron/daemon-test process, and confirmed the dirty `best-operation` worktree with unrelated app crashpad helpers and the pre-existing detached `taod` process.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check`: passed after recording the process/status command.
- `git status --short --branch`, `rg`, `sed`, and `nl` inspection of `report.md`, `TaodPtyBridge`, preload terminal buffering, renderer terminal output writer, package smoke diagnostics, and memory routing notes: confirmed the remaining hot-path gap was cross-boundary backpressure and identified invisible preload bounded-buffer loss as the next small attribution gap.
- `pnpm exec oxfmt apps/desktop/src/preload/index.ts apps/desktop/src/renderer/env.d.ts apps/desktop/src/main/index.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: passed after adding preload terminal drop/truncation diagnostics and smoke assertions; desktop persistence/lifecycle/stream tests remain at 34 tests.
- `pnpm --filter @tao/desktop build && pnpm smoke:package`: passed after rebuilding `out/`; the packaged Electron smoke payload included preload drop/truncation counters all at 0, renderer load about 273 ms, first output about 639 ms, and completed in about 1.16 seconds.
- `pnpm exec oxfmt report.md apps/desktop/src/preload/index.ts apps/desktop/src/renderer/env.d.ts apps/desktop/src/main/index.ts && pnpm fmt:ts:check && pnpm check`: passed after preload loss-diagnostics/report updates, including lint, format check, TypeScript, 34 desktop tests, and 125 daemon tests.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check && pgrep -fl 'taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|bench:reload|Electron|/taod$' || true && git status --short --branch`: passed report/TS formatting, found no package-smoke/reload/smoke Electron/daemon-test process, and confirmed the dirty `best-operation` worktree with unrelated app crashpad helpers and the pre-existing detached `taod` process.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check`: passed after recording the process/status command.
- `git status --short --branch`, `rg`, `sed`, and `nl` inspection of `report.md`, `TaodPtyBridge`, main/preload diagnostics APIs, renderer env types, and package smoke assertions: confirmed MessagePort posting was the remaining invisible hot-path bridge boundary.
- `pnpm exec oxfmt apps/desktop/src/main/pty-protocol.ts apps/desktop/src/main/taod-pty-bridge.ts apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/env.d.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: passed after adding typed `TaodPtyBridge` diagnostics and preload/main API wiring; desktop persistence/lifecycle/stream tests remain at 34 tests.
- `pnpm --filter @tao/desktop build && pnpm smoke:package`: passed after rebuilding `out/`; the packaged Electron smoke payload included bridge diagnostics with `messagesPostedTotal:19`, `dataMessagesPostedTotal:17`, `dataCharsPostedTotal:16411`, `messagesDroppedNoPortTotal:0`, and `postFailuresTotal:0`, plus renderer load about 267 ms, first output about 632 ms, and package smoke completion in about 1.16 seconds.
- `pnpm exec oxfmt report.md apps/desktop/src/main/pty-protocol.ts apps/desktop/src/main/taod-pty-bridge.ts apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/env.d.ts && pnpm fmt:ts:check && pnpm check`: passed after bridge diagnostics/report updates, including lint, format check, TypeScript, 34 desktop tests, and 125 daemon tests.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check && pgrep -fl 'taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|bench:reload|Electron|/taod$' || true && git status --short --branch`: passed report/TS formatting, found no package-smoke/reload/smoke Electron/daemon-test process, and confirmed the dirty `best-operation` worktree with unrelated app crashpad helpers and the pre-existing detached `taod` process.
- Final `pnpm exec oxfmt report.md && pnpm fmt:ts:check`: passed after recording the process/status command.
- `git status --short --branch` and `rg`/`sed` inspection of `@pierre/trees`, `@pierre/path-store`, `App.tsx`, daemon file-tree sorting, and report file-tree claims: confirmed the live `appendPaths()` failure came from treating daemon byte-sorted paths as `@pierre/trees` presorted semantic input.
- `pnpm exec oxfmt apps/desktop/src/renderer/ui/App.tsx && pnpm --filter @tao/desktop tsc && pnpm bench:file-tree:budget`: passed after changing the renderer to prepare file-tree reset input with `@pierre/trees`' own sorter; the 50k benchmark measured reset 39.10 ms, max frame 41.00 ms, 0 frames over 50 ms, and 195 DOM nodes.
- `git status --short --branch`, `nl`, and `rg` inspection of `apps/desktop/src/renderer/terminal-output-writer.ts`, `apps/desktop/test/terminal-output-writer.test.ts`, and `report.md`: confirmed the interrupted renderer write-queue cap was the active slice and narrowed the test risk to backlog draining behavior.
- `pnpm exec oxfmt apps/desktop/src/renderer/terminal-output-writer.ts apps/desktop/test/terminal-output-writer.test.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: TypeScript passed and the terminal writer tests passed, but the combined persistence command failed once in `GitStateWatcher diagnostics report queued refreshes and notifications` with `refreshCalls` observed as 2 instead of 1.
- `pnpm --filter @tao/desktop exec tsx --test test/terminal-output-writer.test.ts`: passed the focused terminal writer tests, including the new bounded-backlog/drop-notice case. Node emitted a `module.register()` deprecation warning.
- `pnpm --filter @tao/desktop exec tsx --test src/main/git-state-watcher.test.ts`: passed when rerun alone, indicating the earlier combined persistence failure was an adjacent flaky watcher timing failure rather than a terminal writer regression. Node emitted a `module.register()` deprecation warning.
- `pnpm exec oxfmt report.md apps/desktop/src/renderer/terminal-output-writer.ts apps/desktop/test/terminal-output-writer.test.ts && pnpm --filter @tao/desktop tsc && pnpm --filter @tao/desktop test:persistence`: passed on rerun after report updates; desktop persistence/lifecycle/stream tests now include 35 tests.
- `pnpm exec oxfmt report.md apps/desktop/src/renderer/terminal-output-writer.ts apps/desktop/test/terminal-output-writer.test.ts && pnpm fmt:ts:check && pnpm check`: passed after the renderer write-queue cap/report updates, including lint, format check, TypeScript, 35 desktop tests, and 125 daemon tests.
- `pnpm exec oxfmt report.md && pnpm fmt:ts:check && pgrep -fl 'taod-root-test|package-smoke|TAO_ELECTRON_SMOKE|tao-electron-smoke|bench:reload|Electron|/taod$' || true && git status --short --branch`: passed report/TS formatting and confirmed the dirty `best-operation` worktree; it also found an already-running Electron app from this worktree plus `apps/daemon/zig-out/bin/taod`, which I left running.

## Commands Not Run

- `pnpm bench:latency`: skipped because the full non-enforcing command targets developer/manual use; `pnpm bench:latency:budget` now covers the enforcing managed-daemon CI smoke subset.
- `pnpm bench:renderer`: skipped for the same reason.
- `pnpm bench:renderer-combined`: skipped for the same reason; `pnpm bench:renderer-combined:budget` now covers the enforcing CI smoke subset.
- `pnpm bench:ipc`: skipped for the same reason; `pnpm bench:ipc:budget` now covers the enforcing CI smoke subset.
- `pnpm bench:startup`: skipped for the same reason; `pnpm bench:startup:budget` now covers the enforcing packaged startup smoke subset.
- `pnpm --filter @tao/desktop bench:taod`: skipped for the same reason.
- `pnpm bench:app-soak`: skipped because it is the longer non-hour packaged reload/reattach profile; `pnpm bench:app-soak:budget` covers the enforcing CI smoke subset, and `pnpm bench:app-soak:hour` now covers the paced one-hour local baseline.
- Interactive Chrome/Perfetto trace inspection: skipped because `pnpm bench:app-trace:summary` now provides repeatable JSON analysis for the current artifact. Use the GUI only when the summary points to a specific offender that needs visual timeline inspection.

## Appendix A: Raw Agent Notes

## Agent 1: System Architecture Boundary Reviewer

### Findings

#### [Severity: High] Workspace process ownership is split

- Evidence: `apps/desktop/src/main/workspace-service.ts:78`, `apps/daemon/src/workspace.zig:125`, `apps/daemon/src/worktree.zig:63`.
- Problem: Electron main and `taod` both run workspace/git logic.
- Why it matters: Duplicate ownership makes performance profiling and path validation harder.
- Suggested fix: Move slow filesystem/process metadata calls to daemon or document the remaining split.
- Verification: large repo profile with main-process long-task budget.
- Confidence: High.

#### [Severity: High] Detached daemon lifecycle needs explicit states

- Evidence: `apps/desktop/src/main/taod-client.ts:819`, `apps/desktop/src/main/taod-client.ts:580`.
- Problem: Detached daemon survival is a product invariant but not modeled as states.
- Why it matters: Crash/restart/stale socket behavior is hard to reason about.
- Suggested fix: Add lifecycle states and versioned ping diagnostics.
- Verification: stale socket, daemon kill, app quit, renderer reload integration tests.
- Confidence: High.

## Agent 2: Effect.ts 4 Beta Reviewer

### Findings

#### [Severity: Medium] Effect is valid but thin

- Evidence: `apps/desktop/src/main/runtime.ts:4`, `apps/desktop/src/main/workspace-service.ts:43`.
- Problem: Effect wraps imperative calls but does not own much resource safety.
- Why it matters: Added abstraction should buy cancellation, typed errors, retries, finalizers, or observability.
- Suggested fix: Keep terminal streams plain; strengthen Effect around workspace and daemon-control workflows.
- Verification: focused timeout/cancellation/error tests.
- Confidence: High.

## Agent 3: Electron Main Process Reviewer

### Findings

#### [Severity: Medium] Main runs potentially slow repo commands

- Evidence: `apps/desktop/src/main/workspace-service.ts:367`, `apps/desktop/src/main/workspace-service.ts:387`, `apps/desktop/src/main/workspace-service.ts:420`.
- Status: Implemented after the initial review. PR metadata now routes through `taod` as `workspace.pullRequest`.
- Problem: Initial review found process-heavy workspace metadata executing from Electron main. The original `lsof +D` port path has been removed, and file-tree/raw-diff/port/PR metadata now route through `taod`.
- Why it matters: Large repos can degrade app responsiveness.
- Suggested fix: Move to daemon or worker process with cache/progress.
- Verification: main CPU and long-task profile on large repos.
- Confidence: High.

## Agent 4: Preload + IPC Security Reviewer

### Findings

#### [Severity: Medium] IPC mutation payloads are not uniformly schema-decoded

- Evidence: `apps/desktop/src/main/index.ts:437`, `apps/desktop/src/main/index.ts:468`, `apps/desktop/src/preload/index.ts:968`.
- Problem: Some payloads are manually coerced rather than decoded through shared schemas.
- Why it matters: A compromised renderer can send malformed workspace/worktree requests.
- Suggested fix: Add schemas for all mutation inputs and reject invalid payloads.
- Verification: IPC malformed payload tests.
- Confidence: High.

## Agent 5: Renderer + React 19 Responsiveness Reviewer

### Findings

#### [Severity: Medium] Diff rendering still needs virtualization

- Evidence: `apps/desktop/src/renderer/ui/App.tsx`, `apps/desktop/src/renderer/diff-parser.worker.ts`, `apps/desktop/src/renderer/diff-parser-client.ts`.
- Problem: Patch parsing is now worker-backed, but large diff render preparation and `FileDiff` body mounting still need virtualization/caps.
- Why it matters: Terminal feel is a top product metric.
- Suggested fix: Keep parsing off-thread and virtualize large diff rendering.
- Verification: 1/5/20 MB diff frame-time profiles.
- Confidence: High.

## Agent 6: Terminal / PTY / Stream Throughput Reviewer

### Findings

#### [Severity: High] No end-to-end backpressure policy

- Evidence: `apps/desktop/src/main/taod-client.ts:522`, `apps/desktop/src/preload/index.ts:208`, `apps/daemon/src/daemon/stream.zig:235`.
- Problem: Individual buffers exist, but the full pipeline has no coordinated high-water policy.
- Why it matters: Sustained output can trade memory growth for latency without visibility.
- Suggested fix: Add queue budgets/counters and explicit slow-subscriber/replay truncation policy.
- Verification: sustained output benchmark with RSS and input latency.
- Confidence: High.

## Agent 7: Zig Daemon Systems Reviewer

### Findings

#### [Severity: Medium] Detached daemon threads lack controlled shutdown semantics

- Evidence: `apps/daemon/src/daemon/server.zig:91`, `apps/daemon/src/daemon/process.zig:76`, `apps/daemon/src/daemon.zig:109`.
- Problem: Threads are detached and daemon deinit waits by atomics.
- Why it matters: Controlled stop, tests, and crash recovery are harder.
- Suggested fix: Add shutdown state and joinable handles in test/control modes.
- Verification: daemon shutdown integration test.
- Confidence: Medium.

## Agent 8: Zig Daemon Security Reviewer

### Findings

#### [Severity: Medium] Resolved: adapter runner is environment-controlled

- Evidence: `apps/daemon/src/adapter.zig:284`, `apps/daemon/src/adapter.zig:292`.
- Status: Implemented after the initial review; runner basename allowlisting exists, adapter commands time out, raw stderr is redacted, and group/other-writable adapter directories/scripts are skipped.
- Problem: `TAOD_ADAPTER_RUNNER` can redirect execution only to `node`/`tsx` by basename, adapter runs now have a timeout, and writable adapter assets are rejected.
- Why it matters: Same-user hostile environment or hung adapters can affect daemon behavior.
- Suggested fix: Keep the current runner, timeout, stderr, and adapter provenance checks.
- Verification: adapter timeout, runner rejection, and group-writable adapter directory rejection tests now pass in the daemon suite.
- Confidence: Medium.

## Agent 9: Electron ↔ Zig Protocol Reviewer

### Findings

#### [Severity: High] Protocol lacks golden cross-language tests

- Evidence: `packages/shared/src/taod-protocol.ts:5`, `apps/daemon/src/rpc.zig:302`, `apps/desktop/src/main/taod-stream.ts:144`.
- Problem: TS and Zig protocol code can drift.
- Why it matters: TypeScript typecheck cannot catch Zig parser incompatibility.
- Suggested fix: Shared fixtures for control JSON and binary frames.
- Verification: TS and Zig fixture tests in CI.
- Confidence: High.

## Agent 10: Workspaces / Worktrees / Git Reviewer

### Findings

#### [Severity: Medium] `lsof +D` is a scaling risk

- Evidence: `apps/desktop/src/main/workspace-service.ts:420`.
- Status: Implemented after the initial review; no source matches for `lsof +D` remain.
- Problem: Recursive `lsof` can be very expensive.
- Why it matters: Port panel can freeze metadata refresh on large repos.
- Suggested fix: Move to daemon, cache, and use cheaper process-port mapping.
- Verification: large repo port lookup benchmark.
- Confidence: High.

## Agent 11: Build / Packaging / Dependency Reviewer

### Findings

#### [Severity: High] Resolved: packaged smoke now proves `taod` and adapters resolve

- Evidence: `apps/desktop/electron.vite.config.ts:19`, `apps/desktop/src/main/taod-client.ts:300`, `.github/workflows/ci.yml:115`.
- Status: Implemented after the initial review; the package smoke now runs on the macOS build job.
- Problem: Build copies files, runtime probes paths, but CI does not launch and ping packaged daemon.
- Why it matters: Release artifact can build but fail at startup.
- Suggested fix: Add packaged smoke for daemon binary, adapter dir, and one session attach.
- Verification: CI smoke after macOS build.
- Confidence: High.

## Agent 12: Benchmark + Profiling Reviewer

### Findings

#### [Severity: Medium] Benchmarks exist but budgets are not enforced

- Evidence: `package.json:33`, `apps/desktop/package.json:24`, `.github/workflows/ci.yml:172`.
- Problem: Multiple bench scripts exist, but CI only runs `pnpm bench` and no budgets are visible.
- Why it matters: Performance claims can regress silently.
- Suggested fix: Add generous startup, IPC, renderer, output, and memory smoke budgets.
- Verification: benchmark artifacts and threshold checks in CI.
- Confidence: High.

## Agent 13: Observability Reviewer

### Findings

#### [Severity: Medium] Request IDs are not a full diagnostic trace

- Evidence: `apps/desktop/src/main/taod-client.ts:171`, `apps/daemon/src/daemon/server.zig:118`.
- Problem: IDs exist in requests, but logs/counters do not carry a full renderer-main-daemon timeline.
- Why it matters: Startup loops and latency spikes will be hard to diagnose.
- Suggested fix: Structured trace fields and counters for startup/session/workspace operations.
- Verification: diagnostics export from a create/attach/reload scenario.
- Confidence: High.

## Agent 14: Testing / CI Reviewer

### Findings

#### [Severity: Medium] Missing integration tests for crash/reload/version boundaries

- Evidence: daemon unit tests pass, but no matching Electron/daemon integration smoke is present in `.github/workflows/ci.yml:115`.
- Problem: Current proof is mostly unit-level plus build/check jobs.
- Why it matters: Boundary bugs are most likely in startup, restart, renderer reload, and packaged paths.
- Suggested fix: Add targeted integration smoke before full performance work.
- Verification: CI job kills daemon mid-request, reloads renderer, and launches packaged app.
- Confidence: Medium.

## Agent 15: "Cracked Systems Code" Reviewer

### Findings

#### [Severity: High] This should not rely on implicit restart hope

- Evidence: `apps/desktop/src/main/taod-client.ts:872`, `apps/desktop/src/main/taod-client.ts:878`.
- Problem: Restart scheduling is timer-based and not tied to explicit lifecycle/capability state.
- Why it matters: Serious systems code needs deterministic ownership and recovery.
- Suggested fix: Model daemon lifecycle states, define owner/resume behavior, and expose diagnostics.
- Verification: failure matrix tests for absent/live/stale/crashed/incompatible daemon.
- Confidence: High.

## Appendix B: Suggested Follow-up Codex Prompts

1. "In Tao, fix the current formatting failure only. Inspect `packages/shared/src/workspace.ts`, run the repo formatter check, and do not change behavior."
2. "Add Electron <-> taod protocol golden fixtures. Start with ping, create, attach, error response, resize frame, output frame, snapshot frame, and malformed frame rejection. Do not refactor runtime behavior."
3. "Add daemon lifecycle diagnostics: version/capabilities in ping, `TaodClient` compatibility check, and startup timeline logs. Include focused tests for incompatible daemon responses."
4. "Add terminal throughput/backpressure instrumentation without changing policy first: queued bytes, xterm drain duration, socket write backpressure, dropped subscribers, and renderer callback rate."
5. "Move `getWorkspacePorts` out of Electron main. Implement a daemon request for port discovery, preserve the existing preload API, and add a large-repo/timeout test."
