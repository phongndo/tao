set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

default:
    @just --list

# Prepare a fresh worktree for local development.
setup:
    if command -v corepack >/dev/null 2>&1; then corepack enable; elif ! command -v pnpm >/dev/null 2>&1; then echo "Neither corepack nor pnpm was found. Install pnpm first." >&2; exit 1; fi
    pnpm install --frozen-lockfile
    pnpm exec tsx scripts/electron-install.ts

# Re-run Electron's install/repair step after dependencies are present.
electron:
    pnpm exec tsx scripts/electron-install.ts

