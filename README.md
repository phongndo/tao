# Tao

<p align="center">
  <img src="https://img.shields.io/github/actions/workflow/status/phongndo/tao/ci.yml?branch=main&label=CI" alt="CI">
  <img src="https://img.shields.io/github/license/phongndo/tao?label=license" alt="License">
  <img src="https://img.shields.io/badge/parser-Ghostty%20WASM%20(Zig)-blue" alt="Parser">
</p>

A performance-first workspace terminal built with **Electron**, **Ghostty's WASM-based VT parser**, and Tao's **Zig `taod` PTY/persistence daemon**.

Uses the exact same Zig parser as the native Ghostty terminal, compiled to WebAssembly. Renders via Canvas 2D (WebGL glyph atlas renderer planned).

**1.9× faster VT parsing than xterm.js. 30× lower input latency. 6.2× faster burst writes.**

## Quick Start

```bash
nix develop          # Enter the reproducible dev shell
pnpm install
pnpm dev             # Terminal with HMR
pnpm build           # Production build
pnpm start           # Run production build
```

Tao is a pnpm workspace. Root scripts delegate to `apps/desktop`, leaving room for future apps such as a website.

## Workspace Layout

```text
tao/
├── apps/daemon/    # Zig taod persistence daemon
├── apps/desktop/   # Electron terminal app
├── packages/       # Shared workspace packages
├── docs/           # Architecture notes and plans
├── scripts/        # Repo-level maintenance scripts
├── patches/        # Future dependency patches, e.g. ghostty-web
└── assets/         # Shared repo assets
```

## Performance

| Metric                      | Tao (ghostty-web WASM) | xterm.js (VS Code, Superset) | Speedup  |
| --------------------------- | ---------------------- | ---------------------------- | -------- |
| VT parser throughput (10MB) | 42.8 MB/s              | 22.8 MB/s                    | **1.9×** |
| Input latency (avg)         | 0.04 ms                | 1.20 ms                      | **30×**  |
| Burst writes (1000)         | 266 ms                 | 1646 ms                      | **6.2×** |
| Renderer init               | ~50 ms                 | ~500 ms                      | **10×**  |
| Full redraw (1920 cells)    | ~5 ms                  | ~15 ms                       | **3×**   |

See [plans.md](plans.md) for methodology and full comparison.

## Architecture

```
Renderer Process          Main Process             taod daemon
┌──────────────────┐      ┌──────────────┐         ┌──────────────────────────┐
│ ghostty-web      │      │ Window +     │  UDS    │ PTY processes, live      │
│ Canvas renderer  │◄────►│ taod bridge  │◄───────►│ streams, snapshots, logs │
└──────────────────┘      └──────────────┘         └──────────────────────────┘
```

- **taod**: Zig daemon owns PTYs, live attach streams, event logs, current-screen snapshots, and resume metadata.
- **ghostty-web**: Ghostty's production VT emulator compiled to WASM. Same parser as the native Ghostty app.
- **IPC**: Renderer talks to Electron main over `MessagePort`; main bridges to `taod` over local daemon sockets.
- **Rendering**: Canvas 2D with dirty-row tracking. WebGL glyph atlas renderer planned (see [docs](docs/README.md))

## Benchmarks

```bash
pnpm bench              # VT parser throughput
pnpm bench:latency      # Input latency (keystroke → echo)
pnpm bench:cross        # Cross-terminal comparison
pnpm bench:startup      # Startup time
pnpm bench:all          # Run everything
```

## Development

Desktop source lives in `apps/desktop`. Run commands from the repository root unless you need to target the package directly with `pnpm --filter @tao/desktop <script>`.

```bash
pnpm tsc              # Type check TypeScript
pnpm lint             # Lint TypeScript + Zig syntax
pnpm fmt              # Format TypeScript + Zig
pnpm check            # CI-equivalent TypeScript + Zig checks
pnpm zig:check        # Zig-only lint + format check + tests
pnpm fmt:nix:check    # Check flake.nix formatting
```

`nix develop` provides Zig 0.15.x, matching ZLS, Node 22, pnpm 10, and `nixpkgs-fmt`.

## License

[MIT License](LICENSE)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports and feature requests: use the [issue templates](.github/ISSUE_TEMPLATE).
