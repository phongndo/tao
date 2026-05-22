# Tao Code Review Report: Electron + Effect 4 Beta + Zig Daemon

## Summary
Tao is a desktop systems app with a real daemon boundary, not a thin Electron shell. Electron main owns app/window lifecycle, preload owns a typed bridge and MessagePort handoff, the renderer owns xterm presentation, and `taod` owns PTY/session/persistence/worktree state. The best parts of the code already point in the right direction: `taod` has owner-only socket storage, peer UID checks, bounded control payloads, explicit session invariants, and leak-tested Zig code.

The biggest problems are at the boundaries. Protocol truth is split across TS schemas/manual normalization and Zig structs/string aliases. Workspace/git ownership is split between Electron main and `taod`. The hot terminal path has batching, but there is no end-to-end backpressure contract from xterm back to MessagePort/socket/PTY. Detached daemon behavior is intentional, but the lifecycle model is still implicit enough to make orphan/restart/stale-state cases hard to reason about. Performance has benchmarks, but no enforced budgets for startup, terminal echo, attach replay, renderer jank, memory growth, or large repos.

Current worktree note: source files were already modified before this review. Per instruction, this report only adds `report.md`; no product source was changed.

## Architecture Map
- Electron main responsibilities: Chromium flags and `BrowserWindow` setup in `apps/desktop/src/main/index.ts:55`, window/preload security settings in `apps/desktop/src/main/index.ts:123`, keyboard command routing in `apps/desktop/src/main/index.ts:167`, PTY MessagePort handoff in `apps/desktop/src/main/index.ts:268`, IPC handlers in `apps/desktop/src/main/index.ts:411`, `TaodClient` startup/restart in `apps/desktop/src/main/taod-client.ts:537`, and Git metadata watching in `apps/desktop/src/main/git-state-watcher.ts:84`.
- Preload responsibilities: narrow `contextBridge` API in `apps/desktop/src/preload/index.ts:562`, PTY MessagePort queueing in `apps/desktop/src/preload/index.ts:208`, message decoding in `apps/desktop/src/preload/index.ts:472`, bounded pre-subscription output buffers in `apps/desktop/src/preload/index.ts:324`, and Effect-backed workspace IPC response decoding in `apps/desktop/src/preload/runtime.ts:69`.
- Renderer responsibilities: Zustand app/layout/workspace state in `apps/desktop/src/renderer/state/store.ts:22`, xterm lifecycle in `apps/desktop/src/renderer/terminal.ts:447`, direct xterm write batching in `apps/desktop/src/renderer/terminal-output-writer.ts:8`, terminal pane UI state in `apps/desktop/src/renderer/ui/TerminalPane.tsx:75`, and file tree/diff UI in `apps/desktop/src/renderer/ui/App.tsx:1324` and `apps/desktop/src/renderer/ui/App.tsx:1711`.
- Effect service/runtime responsibilities: `ManagedRuntime.make(WorkspaceServiceLive)` in `apps/desktop/src/main/runtime.ts:4`, main request wrapping in `apps/desktop/src/main/index.ts:316`, `WorkspaceService` command effects in `apps/desktop/src/main/workspace-service.ts:43`, preload runtime in `apps/desktop/src/preload/runtime.ts:129`, and renderer resource hooks in `apps/desktop/src/renderer/workspaceQueries.ts:101`.
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
   - Verification method: golden TS/Zig fixtures for control JSON and binary frames; malformed fixture rejection tests on both sides.
2. Add end-to-end terminal backpressure budgets.
   - Impact: High terminal feel and memory stability.
   - Effort: Medium.
   - Risk: Medium because it touches hot-path flow.
   - Files involved: `taod-client.ts`, `taod-pty-bridge.ts`, `preload/index.ts`, `terminal-output-writer.ts`, `daemon/stream.zig`, `pty.zig`.
   - Verification method: sustained-output benchmark with max queued bytes, p95 frame time, and no unbounded RSS growth.
3. Make detached daemon lifecycle explicit.
   - Impact: High startup/recovery reliability.
   - Effort: Medium.
   - Risk: Medium because PTY survival is product behavior.
   - Files involved: `taod-client.ts`, `daemon/server.zig`, `daemon/persistence.zig`, `main/index.ts`.
   - Verification method: scripted crash/restart/reload tests covering stale socket, daemon exit, Electron quit, and renderer reload.
4. Move remaining filesystem/process-heavy workspace metadata out of Electron main or justify the split.
   - Impact: High startup and large-repo responsiveness.
   - Effort: Medium.
   - Risk: Medium.
   - Files involved: `workspace-service.ts`, `git-state-watcher.ts`, `workspace.zig`, `worktree.zig`.
   - Verification method: large repo benchmark for file tree, status, branches, PR info, and ports.
5. Add packaged app smoke coverage for `taod` and adapters.
   - Impact: High release reliability.
   - Effort: Medium.
   - Risk: Low.
   - Files involved: `electron.vite.config.ts`, `taod-client.ts`, CI workflows.
   - Verification method: build artifact launches, resolves `taod`, starts daemon, creates/attaches one session, loads adapters.
6. Add request IDs and structured timing across renderer/main/daemon.
   - Impact: High debuggability and performance proof.
   - Effort: Low to medium.
   - Risk: Low.
   - Files involved: preload, `taod-client.ts`, `daemon/server.zig`, `rpc.zig`.
   - Verification method: one terminal create/attach produces correlated logs with startup/attach/write/read timings.
7. Make Effect either own resource safety or stay out of hot paths.
   - Impact: Medium maintainability.
   - Effort: Medium.
   - Risk: Low if scoped.
   - Files involved: `runtime.ts`, `workspace-service.ts`, `preload/runtime.ts`, `workspaceQueries.ts`.
   - Verification method: tests for typed errors, cancellation, timeout, and runtime disposal; no Effect in per-byte terminal streams.
8. Bound and measure renderer diff/file tree work.
   - Impact: Medium renderer jank reduction.
   - Effort: Medium.
   - Risk: Low.
   - Files involved: `App.tsx`, `workspaceQueries.ts`, `workspace-service.ts`.
   - Verification method: large diff/file-tree profiles with worker/off-main-thread or virtualization budgets.
9. Harden adapter execution policy.
   - Impact: Medium security/reliability.
   - Effort: Low to medium.
   - Risk: Low.
   - Files involved: `adapter.zig`, packaging config.
   - Verification method: adapter path/runner allowlist tests, timeout tests, stderr redaction tests.
10. Add CI performance smoke budgets.
   - Impact: Medium regression detection.
   - Effort: Medium.
   - Risk: Low.
   - Files involved: `apps/desktop/bench/*`, `.github/workflows/ci.yml`.
   - Verification method: CI emits baseline artifacts and fails only on generous smoke thresholds.

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
- Problem: Stream constants, request aliases, response fields, and validation rules are duplicated manually across TS and Zig. TS has Effect schemas, but Zig has separate structs and parser rules. Control JSON accepts many aliases in Zig while TS constructs a narrower set.
- Why it matters: Protocol drift can break attach/replay, error handling, or workspace operations without typecheck catching it.
- Suggested fix: Add a central protocol spec plus golden fixtures for control requests/responses and binary frames. Run TS encode/decode and Zig parse/encode against the same fixtures.
- Verification: `pnpm test:persistence` plus new Zig/TS golden contract tests; include malformed fixture rejection.
- Confidence: High.

#### [Severity: High] Terminal backpressure is not end-to-end
- Evidence: `apps/desktop/src/main/taod-client.ts:522`, `apps/desktop/src/main/taod-client.ts:628`, `apps/desktop/src/main/taod-client.ts:893`, `apps/desktop/src/preload/index.ts:208`, `apps/desktop/src/renderer/terminal-output-writer.ts:8`, `apps/daemon/src/daemon/stream.zig:235`.
- Problem: TS socket and MessagePort writes do not observe return values or queue pressure. The renderer batches xterm writes, and the daemon drops slow subscribers after nonblocking write failure, but there is no single budget or feedback path across xterm, preload, main, socket, and PTY.
- Why it matters: High output can become latency spikes or memory growth before any subsystem sees pressure.
- Suggested fix: Introduce per-session queue counters and high-water marks at preload/main/socket boundaries; pause or drop replay frames according to policy; expose queued bytes and dropped frame counters.
- Verification: sustained-output benchmark measuring output MB/s, queued bytes, dropped frames, p95 input echo, renderer frame time, and RSS.
- Confidence: High.

#### [Severity: High] Detached daemon lifecycle is intentional but underspecified
- Evidence: `apps/desktop/src/main/taod-client.ts:819`, `apps/desktop/src/main/taod-client.ts:580`, `apps/desktop/src/main/taod-client.ts:857`, `apps/daemon/src/daemon/server.zig:55`, `apps/daemon/src/daemon.zig:78`.
- Problem: Electron detaches/unrefs `taod` so PTYs survive restarts, but there is no explicit lifecycle state model for owner app, orphan daemon, stale socket, daemon crash, version mismatch, or user-visible recovery.
- Why it matters: Recovery bugs here look like duplicate daemons, stale sessions, lost output, or invisible restart loops.
- Suggested fix: Define lifecycle states: `absent`, `starting`, `owned-live`, `external-live`, `stale-socket`, `crashed`, `version-mismatch`, `stopping`. Include pid/version/capability in ping responses and make restart decisions state-based.
- Verification: integration tests for Electron reload, app quit, daemon kill, stale socket, and old daemon binary.
- Confidence: High.

#### [Severity: High] Workspace/git ownership is split between Electron main and taod
- Evidence: `apps/desktop/src/main/workspace-service.ts:78`, `apps/desktop/src/main/workspace-service.ts:420`, `apps/desktop/src/main/workspace-service.ts:429`, `apps/desktop/src/main/index.ts:541`, `apps/daemon/src/workspace.zig:125`, `apps/daemon/src/worktree.zig:63`.
- Problem: Some workspace operations are daemon-owned (`workspace.add`, `worktree.create/remove`, branch listing), while Electron main still shells out to `git`, `lsof`, and `gh` for branch/status/file tree/diff/ports/PR info.
- Why it matters: Large-repo work can block or churn Electron main, and responsibility for path validation, caching, and errors is duplicated.
- Suggested fix: Move filesystem/process-heavy metadata into `taod` behind typed requests, or document why each remaining main-process command must stay in Electron. Prioritize `lsof +D`, file tree, and diff.
- Verification: large repo benchmark plus main-process CPU/long-task profile before and after.
- Confidence: High.

#### [Severity: High] Packaged binary/adapters path resolution is brittle and not smoke-tested
- Evidence: `apps/desktop/electron.vite.config.ts:19`, `apps/desktop/electron.vite.config.ts:52`, `apps/desktop/src/main/taod-client.ts:300`, `apps/desktop/src/main/taod-client.ts:332`, `.github/workflows/ci.yml:115`.
- Problem: Build copies `taod` and adapters beside output, while runtime probes many dev/prod fallback paths. CI uploads `out/`, but no smoke test proves the packaged app can resolve `taod`, start it, and load adapters.
- Why it matters: Production failures will surface as startup timeouts, not compile errors.
- Suggested fix: Add a post-build smoke that runs `taod --check`, verifies adapter dir presence, launches Electron in smoke mode, and performs one daemon ping/session attach.
- Verification: macOS build job fails if `findTaodBinary()`/adapter resolution or daemon ping fails.
- Confidence: High.

## Medium Priority Findings
#### [Severity: Medium] Effect usage is valid beta API but too thin to buy much safety
- Evidence: `apps/desktop/src/main/runtime.ts:4`, `apps/desktop/src/main/workspace-service.ts:43`, `apps/desktop/src/preload/runtime.ts:129`, `apps/desktop/src/renderer/workspaceQueries.ts:101`.
- Problem: Effect mainly wraps imperative IPC/command calls. It does add typed `WorkspaceError` and timeouts in places, but does not yet own resource lifetime, cancellation, retries, structured logging, or service composition for daemon/workspace workflows.
- Why it matters: It adds mental overhead without consistently improving safety.
- Suggested fix: Keep Effect out of terminal hot paths. For workspace flows, make command execution, daemon client, metadata cache, and logging explicit services with typed errors and cancellation.
- Verification: focused tests for timeout/cancel/error mapping and runtime disposal.
- Confidence: High.

#### [Severity: Medium] IPC validation is inconsistent across channel families
- Evidence: `apps/desktop/src/main/index.ts:437`, `apps/desktop/src/main/index.ts:468`, `apps/desktop/src/main/index.ts:573`, `apps/desktop/src/main/index.ts:596`, `apps/desktop/src/preload/index.ts:968`.
- Problem: Some IPC payloads use shared schemas, while daemon workspace calls manually coerce objects and strings to defaults like `''`.
- Why it matters: Bad renderer input can become ambiguous daemon requests; threat model assumes renderer compromise.
- Suggested fix: Add shared schemas for every `workspace:*` and `worktree:*` payload, decode in preload and main, and reject invalid payloads instead of defaulting IDs to empty strings.
- Verification: IPC contract tests with malformed payloads.
- Confidence: High.

#### [Severity: Medium] Main process uses expensive `lsof +D`
- Evidence: `apps/desktop/src/main/workspace-service.ts:417`.
- Problem: `lsof -a +D <workspace>` recursively descends directories and can be expensive on large repos.
- Why it matters: Port lookup can cause main-process latency and bad perceived performance.
- Suggested fix: Move port discovery to daemon, cache it, and use a cheaper process/netstat strategy that maps cwd only when needed.
- Verification: benchmark port lookup on a large repo and assert no main-process long task above 50 ms.
- Confidence: High.

#### [Severity: Medium] Renderer diff parsing and rendering can jank large changes
- Evidence: `apps/desktop/src/renderer/ui/App.tsx:557`, `apps/desktop/src/renderer/ui/App.tsx:1812`, `apps/desktop/src/renderer/ui/App.tsx:2354`, `apps/desktop/src/renderer/ui/App.tsx:2519`.
- Problem: Patch parsing, grouping, tree building, and rendering full diff files happen on the renderer thread.
- Why it matters: Large diffs compete with terminal rendering and input.
- Suggested fix: Move parse/group work to a worker or daemon-produced summary; virtualize full diff file rendering; cap initial rendered hunks.
- Verification: profile 1 MB, 5 MB, and 20 MB patches with frame-time budget.
- Confidence: High.

#### [Severity: Medium] Adapter execution has no timeout and trusts a mutable runner env var
- Evidence: `apps/daemon/src/adapter.zig:271`, `apps/daemon/src/adapter.zig:284`, `apps/daemon/src/adapter.zig:292`, `apps/daemon/src/adapter.zig:309`.
- Problem: Adapter commands are executed via `TAOD_ADAPTER_RUNNER` or `tsx`/`node` with no timeout. The request includes session paths and argv.
- Why it matters: A hung adapter can stall agent detection/resume; a hostile local environment can redirect runner behavior.
- Suggested fix: Add a short timeout, runner allowlist, adapter directory provenance check, and redacted logging.
- Verification: tests for missing runner, hung adapter, oversized output, and bad adapter path.
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

#### [Severity: Medium] Full repo check currently fails formatting
- Evidence: `pnpm check` output: `packages/shared/src/workspace.ts` has format issues.
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
- `pnpm check` fails at `fmt:ts:check` on `packages/shared/src/workspace.ts`.
- TS/Zig protocol definitions are duplicated manually.
- TS socket writes and MessagePort posts do not implement an end-to-end backpressure contract.
- Electron main still owns several Git/lsof/gh operations while `taod` owns workspace/worktree persistence and mutations.
- Packaged app path resolution has multiple fallbacks but no packaged smoke proof.

Hypotheses needing profiling or stress tests:
- High-volume terminal output can grow queues or produce input echo spikes.
- Large diffs/file trees will jank the renderer.
- Detached daemon upgrade/version mismatch can cause confusing recovery.
- Adapter execution can hang or leak sensitive context in logs.
- Chromium flags are net-positive on current Electron 42 targets.

## Electron Main Process Review
Main is doing too much systems work. Window creation and app lifecycle belong here, but Git file tree/diff/status/ports/PR calls in `WorkspaceService` are not Electron responsibilities. `TaodClient` startup is reasonably scoped and now shared through `ensureTaodClient()`, but detached process management needs a state machine rather than restart hope.

Security settings are mixed: `contextIsolation: true`, `nodeIntegration: false`, and `webSecurity: true` are good; `sandbox: false` in `apps/desktop/src/main/index.ts:141` expands preload power and should be explicitly justified because preload imports `clipboard`, `shell`, and `ipcRenderer`.

The `before-quit` disposal path exists, but daemon survival means app quit is not terminal/session shutdown. That is acceptable only if documented as a product invariant and paired with explicit diagnostics.

## Preload + IPC Review
The preload does not expose raw `ipcRenderer`, which is correct. It exposes a broad app API, including session creation, input, resize, kill, workspace mutation, Git actions, layout/settings, clipboard, and external URL opening. The URL opener restricts to `http`/`https` in `apps/desktop/src/preload/index.ts:563`, which is good.

The weak point is inconsistent schema validation. Preload validates some service messages and workspace responses, but daemon workspace mutation payloads go through `invokeWorkspaceDaemon(channel, input)` in `apps/desktop/src/preload/index.ts:968` and are manually coerced in main. A compromised renderer can exercise every exposed method; main and daemon must reject malformed payloads with typed errors, not coerce missing IDs to empty strings.

## Effect 4 Beta Review
The installed Effect package is `effect@4.0.0-beta.66`, and the repo's `Context.Service`, `Layer.succeed`, `ManagedRuntime.make`, `Schema.decodeUnknownOption`, and `Effect.tryPromise` usage is compatible with the installed local types/source.

The architecture is still only partly Effect-shaped. Main has one `WorkspaceServiceLive` layer. Preload has one IPC service layer. Renderer query hooks use an Effect cache. This provides typed error wrappers and some timeouts, but not a coherent service graph for daemon lifecycle, command execution, cancellation, structured logging, retries, or resource finalizers.

Recommended stance: do not push Effect into terminal streams. Use Effect where it can own slow privileged workflows: workspace metadata, daemon control requests, settings/layout IO, and startup diagnostics.

## Renderer + React 19 Responsiveness Review
Terminal output avoids React state and writes directly to xterm through a batched writer, which is the right architecture. Terminal UI state in `TerminalPane` is limited to error/archive/search/resume status.

The renderer risk is sidebars and diffs. `App.tsx` is a large component with many Zustand selectors and local memoized transforms. Diff parsing and rendering are synchronous. File tree rendering uses `@pierre/trees`, which appears designed for large trees, but the surrounding data fetch and status reset still happen on the UI thread. For a terminal-first app, diff/file-tree work must be treated as background work with caps.

## Terminal / PTY / Stream Throughput Review
The hot path is better than a generic Electron terminal: binary frames are used for streams, xterm writes are batched, resize events are RAF-coalesced, and daemon slow subscribers can be dropped.

The missing piece is cross-boundary flow control. `socket.write()` in TS ignores return values. MessagePort posts have no backpressure signal. Preload buffers are capped, but those caps apply when there are no callbacks, not when xterm is falling behind. Daemon pending output is bounded, but live subscribers are dropped only after a nonblocking write fails. Define an explicit policy: live output may drop slow subscribers after N queued bytes; attach replay may be truncated after N bytes; input must retain priority.

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

What is missing:
- Central spec and golden fixtures.
- Version/capability negotiation on ping.
- Cancellation for long workspace/worktree operations.
- Stable machine-readable error codes on every failure path.
- Backpressure semantics.
- Resync contract after renderer reload or daemon restart.

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

The larger design issue is ownership. `taod` owns durable workspace/worktree state, but Electron main still computes branch/status/file tree/diff/ports/PR metadata. This should move toward daemon ownership so filesystem/process-heavy work is not in Electron main and so path validation/caching/errors are centralized.

Specific issue: `lsof +D` should not be on a hot UI path.

## Build / Packaging / Dependency Review
The build pins Zig `0.15.2`, imports sqlite and ghostty-vt, builds `taod`, and copies the binary/adapters into Electron output. That is good.

The risk is proof, not intent. Runtime path discovery has many fallbacks, and CI builds artifacts, but no smoke test launches the packaged app and proves `taod`/adapters are found. Windows builds are especially ambiguous because `copyTaodBinary` skips Windows while CI still uploads a Windows out directory.

## Benchmark + Profiling Review
Benchmark scripts exist: latency, renderer, IPC, cross-terminal, startup, taod comparison, and all. CI runs only `pnpm bench` on Linux, which maps to `apps/desktop/bench/benchmark.ts`, not the full set of startup/renderer/IPC/taod scripts.

The missing part is budgets and regression policy. Add generous smoke budgets first, record artifacts, then tighten after baseline data.

## Observability Review
There are logs, but not a correlated diagnostic model. Request IDs exist in control messages, but they are not consistently carried through renderer/main/daemon logs and timings.

Minimal observability:
- Startup timeline: app ready, window created, renderer ready, port sent, daemon ping, daemon start, attach response, first output, first paint.
- Counters: active sessions, subscribers, queued bytes, dropped subscribers, pending output bytes, reconnects, restarts, control request latency, PTY bytes/sec, xterm queued chars, workspace refresh latency.
- Diagnostics export that redacts cwd/argv if needed.

## Testing / CI Review
Current proof is solid for daemon unit/resource basics. The daemon test suite covers many OOM, parser, stale socket, peer owner, pending output, VT, persistence, workspace, and worktree cases.

Missing proof:
- TS/Zig protocol golden tests.
- IPC contract tests.
- `TaodClient` daemon startup/restart/version mismatch tests.
- Renderer reload and daemon crash mid-request tests.
- Packaged app smoke test.
- Performance smoke budgets.
- Large repo/diff/file-tree tests.

## Quick Wins
- Add protocol version/capabilities to ping response and validate in `TaodClient`.
- Add shared schemas for `workspace:add`, `worktree:create`, `worktree:remove`, and stop coercing invalid IDs to `''`.
- Add `socket.write()` return-value handling in `TaodSessionStream.writeFrame` and control request writes, even if first action is metrics plus warning.
- Add diagnostics counters for xterm queued chars and preload pending output chars.
- Add `TAOD_ADAPTER_RUNNER` allowlist or disable it outside dev.
- Add a CI note or guard that Windows artifacts are unsupported until daemon support exists.
- Fix current formatting issue in `packages/shared/src/workspace.ts`.

## Medium Projects
- Move file tree, diff, ports, and PR metadata into daemon services with typed request/response schemas.
- Build TS/Zig protocol fixture tests.
- Add daemon lifecycle state machine and startup timeline diagnostics.
- Add packaged macOS smoke test for `taod` and adapters.
- Add large-output terminal throughput benchmark with memory and frame-time recording.

## Larger Refactors
- Make `taod` the single owner for workspace metadata and Git process execution.
- Introduce an explicit protocol spec/codegen or fixture-driven contract package.
- Add controlled daemon shutdown and joinable thread model for tests.
- Move renderer diff parsing/render preparation to workers or daemon-generated summaries with virtualization.

## Recommended Execution Order
1. Fix `pnpm check` formatting failure.
2. Add protocol version/capability ping and golden fixtures.
3. Add observability counters/timelines for startup and terminal streams.
4. Add terminal throughput/backpressure benchmark and record current baseline.
5. Patch TS write/backpressure handling and queue budgets.
6. Add daemon lifecycle integration tests for stale socket, crash, restart, renderer reload, app quit.
7. Move `lsof +D`, file tree, and diff out of Electron main.
8. Add packaged app smoke test.
9. Add CI performance smoke budgets after baselines stabilize.

## Suggested CI / Regression Checks
- Formatting: `pnpm fmt:check`.
- TypeScript typecheck: `pnpm tsc`.
- Lint: `pnpm lint`.
- Desktop protocol/persistence tests: `pnpm test:persistence`.
- Zig format/check/tests: `pnpm zig:check`.
- Zig leak check: `pnpm zig:leak-check`.
- Protocol golden tests: new `pnpm test:protocol`.
- Startup smoke: new packaged-app smoke on macOS build artifact.
- Performance smoke: `pnpm bench:startup`, `pnpm bench:ipc`, `pnpm bench:renderer`, `pnpm bench:latency`, `pnpm --filter @tao/desktop bench:taod` with generous thresholds.

## Profiling Plan
- Electron startup: instrument `app.whenReady`, `createWindow`, `loadURL/loadFile`, `renderer:ready`, `pty:port`, daemon ping/start, attach response, first output, first visible render.
- taod startup: time `prepareStorage`, database open/migrations, socket bind, first ping.
- UI action -> daemon response latency: wrap every preload/main `workspace:*` and `worktree:*` call with request ID and duration.
- Terminal input latency: timestamp xterm `onData`, main stream write, daemon frame parse, PTY write, PTY output read, renderer xterm callback.
- Terminal output throughput: run high-volume command, record bytes/sec, queued bytes, dropped subscribers, xterm write drain time.
- Renderer jank: Chrome Performance trace during sustained output, file tree load, and diff render.
- Main process CPU: sample while loading large repo metadata and running `lsof +D`.
- Daemon CPU: sample during PTY flood, attach replay, VT snapshot, workspace refresh.
- Memory leaks: 1-hour scripted session with attach/detach/reload; record Electron main, renderer, and `taod` RSS.
- Socket/protocol volume: count control requests, stream frames, bytes, average frame size, max queued bytes.
- File tree/diff performance: benchmark 50k/250k files and 1/5/20 MB patches.
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
- `pnpm check`: failed at `fmt:ts:check`; `packages/shared/src/workspace.ts` has format issues. Earlier lint phase passed.
- `pnpm test:persistence`: passed, 12 tests. Node emitted a `module.register()` deprecation warning.
- `pnpm zig:leak-check`: passed.
- `git diff --stat`: used to confirm existing modified source scope; no source was changed by this report.

## Commands Not Run
- `pnpm bench:latency`: skipped because benchmark runs are not needed to create the first static report and would not be comparable without a baseline protocol.
- `pnpm bench:renderer`: skipped for the same reason.
- `pnpm bench:ipc`: skipped for the same reason.
- `pnpm bench:startup`: skipped for the same reason.
- `pnpm --filter @tao/desktop bench:taod`: skipped for the same reason.
- Packaged app smoke: no existing command found; recommended as new CI coverage.
- Full build: skipped because the task requested review/report only, and `pnpm check` already exposed a current formatting failure.

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
- Problem: File tree, diff, and `lsof +D` execute from Electron main.
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

#### [Severity: Medium] Diff work is synchronous on renderer thread
- Evidence: `apps/desktop/src/renderer/ui/App.tsx:557`, `apps/desktop/src/renderer/ui/App.tsx:2354`, `apps/desktop/src/renderer/ui/App.tsx:2519`.
- Problem: Large patch parse/render can block terminal responsiveness.
- Why it matters: Terminal feel is a top product metric.
- Suggested fix: Worker/offload parsing and virtualize large diff rendering.
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

#### [Severity: Medium] Adapter runner is environment-controlled and untimed
- Evidence: `apps/daemon/src/adapter.zig:284`, `apps/daemon/src/adapter.zig:292`.
- Problem: `TAOD_ADAPTER_RUNNER` can redirect execution, and adapter runs have no timeout.
- Why it matters: Same-user hostile environment or hung adapters can affect daemon behavior.
- Suggested fix: Allowlist runner in production and add timeout.
- Verification: adapter timeout and runner rejection tests.
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
- Problem: Recursive `lsof` can be very expensive.
- Why it matters: Port panel can freeze metadata refresh on large repos.
- Suggested fix: Move to daemon, cache, and use cheaper process-port mapping.
- Verification: large repo port lookup benchmark.
- Confidence: High.

## Agent 11: Build / Packaging / Dependency Reviewer

### Findings

#### [Severity: High] No packaged smoke proves `taod` and adapters resolve
- Evidence: `apps/desktop/electron.vite.config.ts:19`, `apps/desktop/src/main/taod-client.ts:300`, `.github/workflows/ci.yml:115`.
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
