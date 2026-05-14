# Contributing to Tau

Thanks for your interest in contributing!

## Getting Started

### Prerequisites

Install [Nix](https://nixos.org/download) — if using the standard installer, enable flakes by adding `experimental-features = nix-command flakes` to `~/.config/nix/nix.conf`. The [Determinate Nix Installer](https://github.com/DeterminateSystems/nix-installer) enables flakes by default. Then:

```bash
git clone https://github.com/phongndo/tau.git
cd tau
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
   pnpm tsc        # Type check
   pnpm lint       # Lint
   pnpm build      # Production build
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
tau/
├── src/
│   ├── main/           # Electron main process (window, PTY, IPC)
│   ├── preload/        # contextBridge (security boundary)
│   └── renderer/       # Terminal UI (ghostty-web + rendering)
├── bench/              # Benchmark suite
├── docs/               # Architecture + plans
└── .github/            # CI + templates
```

## Architecture

See [PLAN.md](PLAN.md) for the full architecture deep-dive.

## Code Style

- **TypeScript**: `oxlint` for linting and `oxfmt` for formatting. `pnpm fmt` to auto-format.
- **Commit messages**: [Conventional Commits](https://www.conventionalcommits.org/).

## License

Tau is dual-licensed under MIT OR Apache-2.0. You may choose either license.
All contributions are accepted under the same terms.
