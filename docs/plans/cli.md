# CLI Scaffold Plan

**Status**: scaffold only

## Crate layout

- `apps/cli` (`tao` binary): command dispatch, TUI entry point, and user-facing workflows.
- `crates/tao-bridge`: future Rust bridge to `taod` control/stream protocols.

Keep this split until the CLI needs more boundaries. Add crates later only when code has a clear owner:

- `crates/tao-review`: hunk parsing/state/actions if review diff grows beyond the CLI UI.
- `crates/tao-agent`: agent/session view models if shared by headless commands and TUI.

## Dependencies

Runtime crates are intentionally minimal while this is scaffold-only:

- `crossterm`: terminal mode/event backend for the future TUI; version aligned with `ratatui` to avoid duplicate terminal backends.
- `ratatui`: retained-mode TUI layout/widget layer.
- `serde`: typed Rust structs for future taod control/stream payloads.
- `serde_json`: JSON control-envelope encoding/decoding for taod RPCs.
- `tao-bridge`: local crate placeholder for shared Rust taod protocol/client code.

Tooling expected in CI/dev shells:

- `rustc`/`cargo`: compile and build the Rust workspace.
- `rustfmt`: formatting gate.
- `clippy`: lint gate with warnings denied.
- `rust-analyzer`: LSP availability check.
- `miri`: nightly interpreter checks for Rust tests where practical; currently scoped to `tao-bridge` until the CLI has runtime logic worth interpreting.

## Planned surfaces

- Headless worktree commands backed by `taod` workspace/worktree RPCs.
- Agent view across AI CLIs (`pi`, `codex`, `claude`) using daemon session/adapter metadata.
- Ratatui TUI for agents, worktrees, and review.
- Hunk-oriented review diff with stage/unstage/revert actions through `taod`.

## Non-goal for scaffold

No command behavior, taod socket calls, diff parsing, or TUI event loop yet.
