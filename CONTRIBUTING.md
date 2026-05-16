# Contributing to Tao

Thanks for your interest in contributing!

## Getting Started

### Prerequisites

Install [Nix](https://nixos.org/download) — if using the standard installer, enable flakes by adding `experimental-features = nix-command flakes` to `~/.config/nix/nix.conf`. The [Determinate Nix Installer](https://github.com/DeterminateSystems/nix-installer) enables flakes by default. Then:

```bash
git clone https://github.com/phongndo/tao.git
cd tao
nix develop          # Enter the reproducible dev shell
pnpm install
pnpm dev             # Start terminal with HMR
```

## Development Workflow

1. **Fork** the repository
2. **Create a branch** (`feat/split-panes`, `fix/escape-key`, etc.)
3. **Make your changes**
4. **Run checks:**
   ```bash
   pnpm check      # TypeScript + Zig lint/format/type/test checks
   pnpm build      # Production build, including taod
   pnpm bench      # Verify no performance regressions
   ```
5. **Commit** using [Conventional Commits](https://www.conventionalcommits.org/):
   ```
   feat: add split pane support
   fix: escape key not working in nvim
   perf: optimize vertex packing loop
   docs: update WebGL renderer plan
   ```
6. **Push** and open a **Pull Request**

## Project Structure

```
tao/
├── apps/
│   ├── daemon/        # Zig taod persistence daemon
│   └── desktop/
│       ├── src/
│       │   ├── main/       # Electron main process (window, PTY, IPC)
│       │   ├── preload/    # contextBridge (security boundary)
│       │   └── renderer/   # Terminal UI (ghostty-web + rendering)
│       ├── bench/      # Desktop benchmark suite
│       └── public/     # Desktop runtime assets
├── packages/           # Shared workspace packages
├── docs/               # Architecture + plans
├── scripts/            # Repo-level maintenance scripts
├── patches/            # Future dependency patches
├── assets/             # Shared repo assets
└── .github/            # CI + templates
```

## Architecture

See [docs](docs/README.md) for architecture notes and plans.

## Code Style

- **TypeScript**: `oxlint` for linting and `oxfmt` for formatting.
- **Zig**: `zig fmt`, `zig ast-check`, and `zig build test` are wired through `pnpm zig:*` scripts.
- **Nix**: `nix fmt` formats `flake.nix`; the dev shell provides `zig`, `zls`, `node`, and `pnpm`.
- Run `pnpm fmt` to auto-format TypeScript and Zig. Run `pnpm zig:lsp` inside `nix develop` to verify the Zig language server is available.
- **Commit messages**: [Conventional Commits](https://www.conventionalcommits.org/).

## License

Tao is licensed under MIT. All contributions are accepted under the same terms.
