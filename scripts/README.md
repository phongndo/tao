# Scripts

Repository-level maintenance scripts used by workspace packages.

- `zig-tools.ts` discovers Zig/ZON files under `apps/daemon` and runs `zig fmt`, `zig fmt --check`, or `zig ast-check` for cross-platform pnpm scripts.
