set shell := ["bash", "-eu", "-o", "pipefail", "-c"]
set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"]

default:
    @just --list

# Prepare a fresh worktree for local development.
setup: _ensure-package-manager
    pnpm install --frozen-lockfile
    pnpm exec tsx scripts/electron-install.ts

[unix]
_ensure-package-manager:
    if command -v corepack >/dev/null 2>&1; then \
        corepack enable; \
    elif ! command -v pnpm >/dev/null 2>&1; then \
        echo "Neither corepack nor pnpm was found. Install pnpm first." >&2; \
        exit 1; \
    fi

[windows]
_ensure-package-manager:
    $ErrorActionPreference = 'Stop'; if (Get-Command corepack -ErrorAction SilentlyContinue) { corepack enable } elseif (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { Write-Error 'Neither corepack nor pnpm was found. Install pnpm first.'; exit 1 }

# Re-run Electron's install/repair step after dependencies are present.
electron:
    pnpm exec tsx scripts/electron-install.ts

# Kill any running taod daemon and start a fresh dev server.
[unix]
dev:
    pkill -TERM -x taod || true
    for _ in {1..20}; do pgrep -x taod >/dev/null || break; sleep 0.1; done
    if pgrep -x taod >/dev/null; then echo "taod did not stop after TERM" >&2; exit 1; fi
    pnpm dev

[windows]
dev:
    $ErrorActionPreference = 'Stop'; Get-Process -Name taod -ErrorAction SilentlyContinue | Stop-Process -ErrorAction SilentlyContinue; for ($i = 0; $i -lt 20 -and (Get-Process -Name taod -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 100 }; if (Get-Process -Name taod -ErrorAction SilentlyContinue) { throw 'taod did not stop after stop request' }; pnpm dev
