# Changelog

All notable changes to Tau Terminal.

## [Unreleased]

### Added
- Electron terminal with Ghostty WASM parser (ghostty-web)
- Tokyo Night → Mellow theme (matching Ghostty default)
- `show: false` + `renderer:ready` instant-open pattern
- PTY output batching (16ms flush for 10-100× fewer IPC messages)
- Comprehensive benchmark suite (parser, latency, cross-terminal, startup)
- Electron performance optimizations (GPU flags, V8 tuning, feature pruning)
- Zig WebGL glyph atlas renderer plan
- CI (type check + lint + build + bench)
- Dual license (MIT OR Apache-2.0)
- Issue templates (bug, feature)
- PR template
- Contributing guide
