# Tao

Tao is a workspace terminal for shells and AI coding agents. It pairs an Electron/React desktop UI with a Zig daemon (`taod`) that owns PTYs, persistence, workspace/worktree metadata, and agent resume state.

## What is in this repo

- **Desktop app** (`apps/desktop`): Electron, React, xterm.js WebGL, tabs/splits, workspace sidebar, file tree, and changes view.
- **Daemon** (`apps/daemon`): Zig `taod` process for PTY lifecycle, VT parsing via `libghostty-vt`, snapshots, event logs, SQLite metadata, Git/worktree operations, and bundled `pi`/`codex`/`claude` adapters.
- **Shared package** (`packages/shared`): typed IPC/session/workspace protocol definitions used by main, preload, renderer, and scripts.

`taod` runs outside the renderer so live sessions can survive window reloads/restarts. The Electron app is mostly a client: it starts or connects to the daemon, opens attach streams over Unix sockets, and renders terminal/workspace state.

## Quick start

```bash
nix develop          # Node 22, pnpm 10, Zig 0.15.x, ZLS, nixpkgs-fmt
pnpm install
pnpm dev             # build taod, then start Electron with HMR
```

Other common commands:

```bash
pnpm build           # production desktop build, including taod
pnpm start           # run the built Electron app
pnpm check           # lint, format checks, TypeScript, persistence tests, Zig tests
pnpm zig:check       # Zig lint + format check + tests
```

## Layout

```text
tao/
├── apps/
│   ├── daemon/      # Zig taod daemon and built-in agent adapters
│   └── desktop/     # Electron main/preload/renderer app and benchmarks
├── packages/        # Shared workspace packages
├── docs/            # Architecture notes and implementation plans
├── scripts/         # Repo-level maintenance and packaging scripts
├── patches/         # Dependency patches, if needed
└── assets/          # Shared assets
```

## Benchmarks

Benchmarks live under `apps/desktop/bench` and are exposed through root scripts where useful:

```bash
pnpm bench                 # parser comparison benchmark
pnpm bench:latency         # taod input latency
pnpm bench:renderer        # xterm.js DOM vs WebGL renderer
pnpm bench:cross           # cross-terminal comparison
pnpm bench:startup         # startup timing
pnpm bench:all             # desktop benchmark bundle
pnpm --filter @tao/desktop bench:taod  # taod vs node-pty comparison
```

See [`apps/desktop/bench/TAOD-BENCHMARK-RESULTS.md`](apps/desktop/bench/TAOD-BENCHMARK-RESULTS.md) for methodology and captured results.

## Docs

- [`docs/README.md`](docs/README.md) — architecture notes and plans
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup, workflow, style, and daemon memory-safety notes
- [`packages/README.md`](packages/README.md) — shared package summary

## License

[MIT](LICENSE)
