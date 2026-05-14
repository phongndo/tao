# Tau Terminal

<p align="center">
  <img src="https://img.shields.io/github/actions/workflow/status/phongndo/tau/ci.yml?branch=main&label=CI" alt="CI">
  <img src="https://img.shields.io/github/license/phongndo/tau?label=license" alt="License">
  <img src="https://img.shields.io/badge/parser-Ghostty%20WASM%20(Zig)-blue" alt="Parser">
  <img src="https://img.shields.io/badge/renderer-Canvas%202D%20%E2%86%92%20WebGL%20(planned)-orange" alt="Renderer">
</p>

A super-performant terminal emulator built with **Electron** + **Ghostty's WASM-based VT parser** + **node-pty**.

Uses the exact same Zig parser as the native Ghostty terminal, compiled to WebAssembly. Renders via Canvas 2D (WebGL glyph atlas renderer planned).

**2.6× faster VT parsing than xterm.js. 30× lower input latency. 6.2× faster burst writes.**

## Quick Start

```bash
nix develop          # Enter the reproducible dev shell
pnpm install
pnpm dev             # Terminal with HMR
pnpm build           # Production build
pnpm start           # Run production build
```

## Performance

| Metric | Tau (ghostty-web WASM) | xterm.js (VS Code, Superset) | Speedup |
|---|---|---|---|
| VT parser throughput (10MB) | 42.8 MB/s | 22.8 MB/s | **1.9×** |
| Input latency (avg) | 0.04 ms | 1.20 ms | **30×** |
| Burst writes (1000) | 266 ms | 1646 ms | **6.2×** |
| Renderer init | ~50 ms | ~500 ms | **10×** |
| Full redraw (1920 cells) | ~5 ms | ~15 ms | **3×** |

See [PLAN.md](PLAN.md) for methodology and full comparison.

## Architecture

```
Main Process                 PTY Utility Process              Renderer Process
┌──────────────┐             ┌──────────────┐   MessagePort   ┌─────────────────────────────┐
│  Window      │             │  node-pty    │◄───────────────►│  ghostty-web                │
│  lifecycle   │             │  real shell  │    buffered     │  - Ghostty WASM parser (Zig)│
│  only        │             │              │    ~16ms        │  - Canvas 2D renderer       │
└──────────────┘             └──────────────┘                 │  - WebGL renderer (planned) │
                                                              └─────────────────────────────┘
```

- **node-pty**: Runs in an Electron utility process and spawns a real shell (bash/zsh/fish) with PTY
- **ghostty-web**: Ghostty's production VT emulator compiled to WASM. Same parser as the native Ghostty app.
- **IPC**: Raw bytes over a direct `MessagePort`, batched at 16ms (~60fps), with main kept off the PTY hot path
- **Rendering**: Canvas 2D with dirty-row tracking. WebGL glyph atlas renderer planned (see [docs](docs/ZIG_WEBGL_IMPLEMENTATION_PLAN.md))

## Benchmarks

```bash
pnpm bench              # VT parser throughput
pnpm bench:latency      # Input latency (keystroke → echo)
pnpm bench:cross        # Cross-terminal comparison
pnpm bench:startup      # Startup time
pnpm bench:all          # Run everything
```

## Development

```bash
pnpm tsc          # Type check
pnpm lint         # Lint
pnpm fmt          # Format
pnpm check        # Format + lint (CI)
```

## License

Dual-licensed under either of:

- [MIT License](LICENSE)
- [Apache License, Version 2.0](LICENSE-APACHE)

at your option.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports and feature requests: use the [issue templates](.github/ISSUE_TEMPLATE).
