# Tau Terminal

A super-performant terminal emulator built with **Electron** + **ghostty-web** (Ghostty's WASM-based VT parser) + **node-pty**.

Uses the same architecture as VS Code's terminal but with Ghostty's Zig-compiled VT parser instead of xterm.js, giving 3-5× faster escape sequence parsing and proper Unicode handling.

## Quick Start

```bash
pnpm install
pnpm dev     # Development mode with HMR
pnpm build   # Production build
pnpm start   # Run production build
```

## Architecture

```
Main Process                    Renderer Process
┌──────────────┐    IPC    ┌─────────────────────────┐
│  node-pty    │◄─────────►│  ghostty-web             │
│  (real shell)│  raw bytes │  - WASM VT parser (Zig) │
│              │            │  - Canvas renderer      │
└──────────────┘            │  - Key encoder (WASM)   │
                            └─────────────────────────┘
```

- **node-pty**: Spawns a real shell process (bash/zsh/fish) with a pseudo-terminal
- **ghostty-web**: Ghostty's production VT emulator compiled to WebAssembly. Parses ANSI escape sequences at near-native speed. Renders to HTML5 Canvas.
- **IPC**: Raw bytes flow between main and renderer via Electron's `ipcMain`/`ipcRenderer`. No cell serialization overhead.

## Performance

| | Tau (ghostty-web) | VS Code / Hyper / Tabby (xterm.js) |
|---|---|---|
| VT Parser | WASM (Zig, near-native) | JavaScript (interpreted/JIT) |
| Unicode | Full Ghostty grapheme handling | Partial, known issues |
| GC Pressure | Zero-allocation cell pool | Per-cell JS objects |
| Rendering | Canvas 2D, dirty-row tracking | Canvas 2D or WebGL |

## Tech Stack

- **Electron** 42
- **ghostty-web** 0.4.0 (Coder)
- **node-pty** 1.1.0 (Microsoft)
- **electron-vite** 5 (Vite-based build tooling)
- **TypeScript** 6
- **pnpm** 10

## Project Structure

```
tau/
├── src/
│   ├── main/           # Electron main process
│   │   ├── index.ts    # App entry, window creation, IPC
│   │   └── pty.ts      # PTY manager (node-pty wrapper)
│   ├── preload/
│   │   └── index.ts    # contextBridge (security boundary)
│   └── renderer/
│       ├── index.html  # HTML shell
│       ├── main.ts     # Renderer entry
│       ├── terminal.ts # Terminal component (ghostty-web)
│       ├── env.d.ts    # Type declarations
│       └── styles.css  # Terminal styling
├── public/
│   └── ghostty-vt.wasm # WASM binary (served in dev mode)
├── electron.vite.config.ts
├── tsconfig.json
└── PLAN.md             # Full architecture deep-dive
```
