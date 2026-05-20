# Zig Daemon Code Review

## Executive Summary

No code was edited as part of this review. The daemon has a solid unit-test base and good parser/codec/OOM coverage, but the top risks are around real daemon operation: PTY process ownership, local socket trust, unbounded connection/thread behavior, event-log recovery limits, and blocking work under the global daemon lock.

Top 5 risks:

1. PTY children can become zombies or lose ownership on kill/read-error/post-spawn failure.
2. Any local process that can reach `~/.tao/run/taod.sock` can drive daemon actions, including spawning commands.
3. Valid event logs become unrecoverable once total log size exceeds about 64 MiB.
4. Adopted/external worktrees can be deleted by default despite docs saying unregister/archive should be the default.
5. Control/data-plane work is mixed under one daemon mutex, so slow Git/file/PTY/socket work can stall unrelated sessions.

## Critical Findings

### 1. PTY Children Can Be Lost Or Zombie

- Severity: High
- Category: Correctness / Resource lifetime
- File/function: `apps/daemon/src/daemon/process.zig:121`, `apps/daemon/src/daemon/process.zig:217`, `apps/daemon/src/daemon/control.zig:133`, `apps/daemon/src/pty.zig:207`
- Evidence: EOF/read-error paths call `markExitedAndBroadcast`, which closes/nulls `pty_child` without `waitpid`. `handleKillLocked` sends SIGTERM, closes, nulls, and marks killed. The only reap path is `tryWait`, but ownership can be removed before it runs.
- Why it matters: Long-running daemon use can accumulate zombie child processes or lose process ownership after OOM/thread-spawn failures.
- Recommended fix: Make child ownership explicit: terminate, close, and reap in one path, or retain a reapable child until `waitpid` succeeds. Add `errdefer` cleanup after successful spawn that terminates/reaps, not just closes.
- Verification: Add kill/read-EOF/post-spawn-failure tests that assert `waitpid(pid, WNOHANG)` reaches reaped state or `ECHILD`.

### 2. Local Control Socket Is Unauthenticated

- Severity: High if shared host; Medium on single-user desktop
- Category: Security / Trust boundary
- File/function: `apps/daemon/src/daemon/server.zig:45`, `apps/daemon/src/daemon/server.zig:98`, `apps/daemon/src/daemon/process.zig:52`, `apps/daemon/src/pty.zig:140`
- Evidence: The daemon binds a Unix socket and dispatches all RPCs without peer credential checks, socket permission enforcement, or token challenge. `create` can spawn `argv` through `execvp`.
- Why it matters: A local process can create sessions, spawn commands, attach streams, kill sessions, clear history, or mutate worktrees.
- Recommended fix: Enforce `0700` on `~/.tao` and run dir, owner-only socket permissions, peer UID checks where available, and a per-user `0600` auth token/challenge for control RPC.
- Verification: Socket integration test: unauthenticated client must fail; authenticated Electron/client path must pass.

### 3. Valid Event Logs Become Unrecoverable Past 64 MiB

- Severity: Medium
- Category: Persistence correctness / Robustness
- File/function: `apps/daemon/src/limits.zig:19`, `apps/daemon/src/event_log.zig:285`, `apps/daemon/src/event_log.zig:429`, `apps/daemon/src/event_log.zig:491`
- Evidence: `event_log_payload_bytes_max` is a per-frame payload limit, but recovery reads the whole append-only file with `file_header_size + max_payload_bytes`. `appendOutput` has no total log cap.
- Why it matters: Normal long sessions can exceed 64 MiB total output and later fail restore/repair with `FileTooBig`.
- Recommended fix: Stream-parse event logs, rotate/checkpoint logs, or enforce documented per-session retention before recovery breaks.
- Verification: Unit/integration test creating valid frames totaling just over the current cap; `readLastSeq` and repair must still succeed or degrade intentionally.

### 4. Adopted External Worktrees Can Be Deleted By Default

- Severity: High for data loss; Medium if UI never exposes it unsafely
- Category: Product contract / Filesystem safety
- File/function: `apps/daemon/src/worktree.zig:199`, `apps/daemon/src/worktree.zig:207`, `docs/plans/workspace-worktree-workflow.md:642`
- Evidence: Docs say adopted worktrees default to unregister/archive unless explicitly removed from disk. Current remove path ignores `created_by` and runs `git worktree remove` for any known path.
- Why it matters: External user-owned worktrees can be removed when the expected behavior is metadata-only unregister.
- Recommended fix: For `created_by = "external"`, default to archive metadata only. Require a distinct explicit destructive flag to delete from disk.
- Verification: Regression test: adopted external worktree remove leaves path and Git worktree intact.

### 5. Idle Socket Connections Can Exhaust Threads

- Severity: Medium
- Category: DoS / Resource bounds
- File/function: `apps/daemon/src/daemon/server.zig:63`, `apps/daemon/src/daemon/fd_io.zig:64`
- Evidence: One detached thread per accepted connection; first read blocks until newline/EOF; no active connection cap or read deadline.
- Why it matters: Local clients can park many threads/fds and starve the daemon.
- Recommended fix: Add global connection cap, worker pool/semaphore, and first-line read timeout/nonblocking poll.
- Verification: Open N idle sockets past cap and assert daemon still answers `ping`.

### 6. OOM-Path Leaks In Response Builders

- Severity: Medium
- Category: Memory / Allocator discipline
- File/function: `apps/daemon/src/workspace.zig:475`, `apps/daemon/src/workspace.zig:545`, `apps/daemon/src/git.zig:237`
- Evidence: Multi-field struct literals allocate fields with `try`; later failures leak earlier fields. `parseWorktreeListPorcelainZ` finishes an owned entry before append, so append OOM loses ownership.
- Recommended fix: Build owned response structs field-by-field with `errdefer` deinit; keep finished Git entries protected by `errdefer entry.deinit(...)` until append succeeds.
- Verification: `std.testing.checkAllAllocationFailures` around `workspaceResponsesAlloc`, `worktreeResponseFromRowAlloc`, and `parseWorktreeListPorcelainZ`.

## Dedupe Table

| Finding | Reported By | Consolidated As |
|---|---|---|
| PTY child zombies / lost process ownership | Correctness, Memory | High resource lifetime bug |
| Event logs fail over 64 MiB | Correctness, Security, Testing | Medium persistence recovery bug |
| Idle sockets / unbounded threads | Memory, Security | Medium local DoS/resource-bound bug |
| Blocking IO under global lock | Correctness, Performance, Zig API | Medium architecture/perf risk |
| External worktree deletion | Correctness | High data-loss contract bug |
| Response OOM leaks | Memory | Medium allocator bug |
| Weak socket/protocol integration tests | Testing, Security | Highest ROI test gap |
| Broad `anytype`/public daemon API | Zig API | Refactor after tests exist |

## TigerBeetle Gap Analysis

Sources used:

- <https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/ARCHITECTURE.md>
- <https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md>
- <https://tigerbeetle.com/blog/2022-10-12-a-database-without-dynamic-memory/>
- <https://tigerbeetle.com/blog/2025-02-13-a-descent-into-the-vortex/>

| Area | Current repo | TigerBeetle-inspired standard | Applies? | Recommendation |
|---|---|---|---|---|
| Resource bounds | Limits exist in `apps/daemon/src/limits.zig`, but threads/connections/log size are not fully bounded | Everything has an explicit upper bound | A | Add connection/thread/log/session retention caps |
| Allocation | Good OOM tests in many modules; hot paths still allocate per frame/snapshot | Up-front/static where hot or reliability-critical | B | Use fixed/reused buffers for stream/event-log hot paths |
| Ownership | Slices mostly explicit, but PTY child ownership can be lost | One owner, one cleanup path | A | Introduce process owner object: terminate/close/reap |
| Assertions | Strong in session/codec paths | Meaningful pre/postcondition assertions | B | Add assertions around child ownership, lock-held invariants, log size semantics |
| Testing | 74 daemon tests pass; good unit coverage | Defense-in-depth: unit, fuzz, integration, simulation | A | Add socket integration, fuzz/property, interleaving simulation |
| Fault model | Corrupt CRCs tested; large valid logs and live socket split-brain not covered | Treat disk/network as faulty external inputs | A | Stream-parse logs and validate live/stale socket ownership |
| Mechanical sympathy | Bounded buffers exist; control/data-plane mixed under lock | Separate control/data plane, batch/cost model | B | Move Git/file/adapter/blocking work outside global lock |
| Minimal dependencies | Zig daemon depends on Ghostty VT and SQLite; reasonable for domain | Avoid hidden complexity | B | Keep dependencies, but isolate adapter/Node tests from core |
| Direct/simple code | Code is explicit but `anytype` forwarding widens contracts | Narrow interfaces, illegal states hard to represent | A | Typed control request union; enum worktree/agent states |

## Highest ROI Fix Plan

### 1. Fix Immediately

1. Rework PTY lifecycle so kill/read-error/post-spawn failure always reaps or retains a reapable child.
2. Make external/adopted worktree removal metadata-only by default.
3. Fix event-log recovery to stream-parse or rotate before valid logs become unrecoverable.
4. Add socket auth/peer checks and owner-only permissions.
5. Add connection caps/read deadline for idle control sockets.

### 2. Add Tests / CI

1. Real socket-level daemon integration harness with create/attach/input/resize/kill/restart.
2. OOM tests for workspace response builders and Git worktree parser.
3. Event-log >64 MiB regression, ideally using small test-only limits.
4. Cross-language protocol golden corpus for Zig `rpc.zig` and TS `taod-stream`.
5. CI Ubuntu native daemon test without `TAOD_SKIP_NATIVE`, plus fuzz/sanitizer nightlies.

### 3. Refactor After Tests Exist

1. Typed validated control-request union instead of catch-all optional JSON struct.
2. Replace worktree/agent string states with enums and transition helpers.
3. Use `LockGuard` consistently and split blocking IO from locked state mutation.
4. Add indexed session lookup if 16k session cap is real.
5. Use ring/head-index pending output queue.

### 4. Defer / Not Worth Doing

1. Do not copy TigerBeetle's no-runtime-allocation rule wholesale; this is a desktop daemon with SQLite, Ghostty VT, adapters, and Git subprocesses.
2. Do not remove Ghostty/SQLite just for minimalism; they are domain-relevant.
3. Do not rewrite everything around deterministic simulation before fixing concrete lifecycle/security bugs.

## Suggested Follow-up Codex Prompts

### 1. Memory/resource cleanup pass

> Fix the taod PTY lifecycle bugs. Ensure kill, EOF/read-error, and post-spawn error paths either reap the child or retain ownership until reaped. Add focused tests proving no zombie/lost process ownership. Keep the diff small.

### 2. Security hardening pass

> Harden taod's Unix control socket. Add owner-only directory/socket permissions, stale socket detection before unlink, peer/auth validation suitable for macOS/Linux, idle connection caps/timeouts, and regression tests for unauthenticated and idle clients.

### 3. Testing/fuzzing/CI pass

> Add a daemon socket integration test harness and protocol golden corpus. Cover create/attach/input/resize/kill/restart, event logs larger than the current single-payload limit, and Zig/TS stream-frame compatibility. Wire the fastest version into CI.

## Verification

What changed during review: review only; no source files edited.

Files modified during review: none.

Verified during review:

- `git status --short --branch`: clean on `rambunctious-bramble`
- `zig version`: `0.15.2`
- `pnpm --filter @tao/daemon test`: 74/74 passed
- `pnpm --filter @tao/daemon fmt:check`: passed
- `pnpm --filter @tao/daemon lint`: passed
- `pnpm --filter @tao/daemon leak-check`: passed

Not verified:

- Direct `zig build test` failed before test execution with Darwin libc/linker symbols in the build runner; the repo's declared macOS wrapper test passed.
- No live destructive socket PoCs, zombie repro, external-worktree deletion smoke, benchmark, sanitizer, Valgrind, or long-running fuzz was run.

Remaining risk:

The strongest findings are source-proven, but runtime severity still depends on deployment posture and real daemon workload. The next useful proof is a focused socket/process integration harness.

