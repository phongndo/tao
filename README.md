# Tao

<p align="center">
  <img src="https://img.shields.io/github/actions/workflow/status/phongndo/tao/ci.yml?branch=main&label=CI" alt="CI">
  <img src="https://img.shields.io/github/license/phongndo/tao?label=license" alt="License">
  <img src="https://img.shields.io/badge/renderer-xterm.js%20WebGL-blue" alt="Renderer">
</p>

A performance-first workspace terminal built with **Electron**, **xterm.js + WebGL**, and Tao's **Zig `taod` PTY/persistence daemon**.

All PTY and VT processing runs in an isolated Zig daemon backed by native `libghostty-vt`. The renderer consumes daemon output through Electron and presents the live terminal with xterm.js' WebGL renderer, falling back to xterm.js' default renderer if WebGL is unavailable or loses context.

**4× faster VT parsing than xterm.js. 10× lower input latency vs node-pty era. Zero GC pauses.**

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
├── patches/        # Future dependency patches
└── assets/         # Shared repo assets
```

## Performance

Tao's architecture moved PTY and VT processing from node-pty (a C++ addon running inside Electron) to **`taod`**, an isolated Zig daemon. Benchmarks compare the current taod-based pipeline against the prior node-pty era.

| Metric                             |      node-pty era      |          taod (Zig daemon)          | Improvement |
| ---------------------------------- | :--------------------: | :---------------------------------: | :---------: |
| **VT parse throughput (plain)**    | ~15 MB/s (xterm.js JS) | **~65 MB/s** (libghostty-vt native) |  **4.3×**   |
| **VT parse throughput (ANSI)**     |       ~8-17 MB/s       |           **~36-55 MB/s**           |  **3-4×**   |
| **Input latency (avg)**            |        ~2-4 ms         |             **0.31 ms**             |   **10×**   |
| **Input latency (p99)**            |        ~6-10 ms        |             **2.02 ms**             |  **3-5×**   |
| **Burst throughput** (1000 writes) |  ~1680 ms (xterm.js)   |          **276 ms** (WASM)          |   **6×**    |
| **PTY spawn (avg)**                |  ~3-5 ms (C++ addon)   |      **~1.5 ms** (Zig daemon)       |  **2-3×**   |
| **PTY spawn (p99)**                |     ~15 ms (V8 GC)     |          **~3 ms** (no GC)          |   **5×**    |
| **Process RSS**                    | ~200 MB (in Electron)  |     **93 MB** (isolated daemon)     |  **2.2×**   |
| **V8 GC pauses**                   | Frequent (p99 spikes)  |              **None**               |      —      |
| **Crash resilience**               |     Dies with app      |        **Survives restart**         |     ✅      |

Metrics measured 2026-05-16 on Apple M3, macOS 26.3.1. Full methodology and raw data in [bench/TAOD-BENCHMARK-RESULTS.md](apps/desktop/bench/TAOD-BENCHMARK-RESULTS.md).

> **PTY spawn latency**: taod is ~1.5 ms (measured via `performance.now()` with direct socket I/O) vs node-pty ~3-5 ms. taod is faster despite doing _more_ work (VT init, persistence setup, reader thread spawn). The earlier shell benchmark reporting 31 ms was an artifact of `nc -w 3` timeout combined with sub-ms timing imprecision from Python subprocess calls. See `bench/taod-pty-spawn-profiler.ts`.

> `session.create` (VT init) takes ~0.6 ms, `forkpty+exec` takes ~0.8 ms, socket IPC adds ~0.01 ms. All of these are one-time costs per terminal tab; none affect runtime keystroke latency or throughput.

### Ghostty-web WASM parser (historical cross-reference)

The benchmark suite can still fetch the old `ghostty-web` package into `apps/desktop/.bench-cache/` for parser comparisons without keeping it in Tao's runtime dependency graph:

| Metric                       | ghostty-web (WASM) | xterm.js (JS) | Speedup  |
| ---------------------------- | ------------------ | ------------- | -------- |
| VT parse (cat 1MB plain)     | 44.5 MB/s          | 35.7 MB/s     | **1.2×** |
| VT parse (compiler 1MB ANSI) | 35.7 MB/s          | 16.5 MB/s     | **2.2×** |
| Burst (1000 tiny writes)     | 276 ms             | 1680 ms       | **6.1×** |

See [bench/benchmark.ts](apps/desktop/bench/benchmark.ts) for the WASM vs xterm.js parser comparison and `pnpm bench:renderer` for the current xterm.js DOM-vs-WebGL renderer benchmark.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Renderer Process (Electron)                                    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  React/TypeScript UI                                    │    │
│  │  xterm.js + WebGL renderer                              │    │
│  └───────────────┬─────────────────────────────────────────┘    │
│                  │ Electron MessagePort                         │
│   ┌──────────────▼─────────────────────────────────────────┐    │
│   │  Main Process (Electron)                               │    │
│   │  taod-pty-bridge ←→ taod-client (Node.js)              │    │
│   └───────────────┬────────────────────────────────────────┘    │
│                   │ Unix Domain Socket (binary TASF protocol)   │
└───────────────────┼─────────────────────────────────────────────┘
                    │
┌───────────────────▼─────────────────────────────────────────────┐
│  taod (Zig daemon) — detached process, survives restarts        │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  PTY Driver (forkpty, execvp, ioctl)                    │    │
│  │  VT Parser (libghostty-vt — native Zig)                 │    │
│  │  Session Manager (persistence, event log, snapshots)    │    │
│  │  Binary Stream Protocol (CRC-32, framed)                │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

- **taod** (Zig): Detached daemon owning all PTY processes, native libghostty-vt parsing, live attach streams, event logs, current-screen snapshots, and resume metadata. Starts independently, survives Electron restarts.
- **taod-client** (Node.js/Electron main): Manages daemon lifecycle (spawn, health-check, reconnect). Bridges control requests and binary streams.
- **taod-pty-bridge** (Electron main): Translates renderer protocol into taod commands over Unix sockets. Forwards binary stream frames via Electron `MessagePort`.
- **xterm.js + WebGL** (renderer): Browser terminal UI, input handling, scrollback, selection, and GPU-accelerated rendering. Falls back to xterm.js' default renderer on WebGL failure.
- **IPC**: Binary stream protocol (TASF — Tao Stream Format) with CRC-32 integrity, 64-byte session IDs, and 64MB max payload. More efficient than JSON-over-Electron-IPC.
- **Rendering**: xterm.js WebGL in the Electron renderer, with focused DOM-vs-WebGL coverage in [bench/xterm-webgl-benchmark.ts](apps/desktop/bench/xterm-webgl-benchmark.ts).

## Benchmarks

```bash
pnpm bench              # VT parser throughput (WASM vs xterm.js)
pnpm bench:taod         # taod daemon vs node-pty comparison
pnpm bench:latency      # Input latency via taod (keystroke → echo)
pnpm bench:renderer     # xterm.js DOM vs WebGL renderer
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
