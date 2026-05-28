# Installer and Release Channels

**Status**: first implementation slice in progress

Tao ships one user-facing desktop product backed by the `taod` daemon:

- `Tao.app`: the Electron desktop app.
- `taod`: the per-user runtime bundled with the app.

Installer design should make the daemon boundary explicit without treating it
as a separately installed command-line product.

## Desktop App

Use Homebrew Cask as the first-class desktop app installer on macOS.

The app bundle should include:

- `Tao.app`
- a bundled `taod`
- built-in daemon adapters

The app should start by connecting to an existing compatible daemon. If none is
running, it can start its bundled daemon. If a daemon is present but
incompatible, the app must use the daemon compatibility policy below instead
of replacing it blindly.

Use separate casks for install-time channel selection:

```bash
brew install --cask tao
brew install --cask tao-nightly
```

If the app is managed by Homebrew, in-app updates should not silently mutate
the Homebrew-owned bundle. The app can still expose the desired update channel,
but the update action should route through the package manager or clearly say
that this install is Homebrew-managed.

## Shared Daemon Contract

`taod` is a shared per-user runtime owned by the Tao app installation.

The canonical runtime paths are:

- socket: `~/.tao/run/taod.sock`
- pid file: `~/.tao/run/taod.pid`
- metadata database: `~/.tao/tao.db`
- session data: `~/.tao/sessions/`

The app must use the daemon handshake before reusing or replacing a daemon.
The handshake contract is:

- protocol version
- daemon version
- capabilities
- same-user local socket ownership

Compatible daemon:

- Reuse it.

Older incompatible daemon:

- Offer or perform a controlled replacement only when the app owns a safe
  upgrade path for the user's selected channel.

Newer incompatible daemon:

- Fail clearly and ask the user to update the older app.

Unknown or unsafe daemon:

- Refuse to connect. Do not send control commands across a socket that fails
  ownership or compatibility checks.

Nightly app builds must not silently replace a stable daemon with an
incompatible nightly daemon. Stable app builds must not silently downgrade a
nightly daemon.

## Channel Model

Channels are app settings, but compatibility is enforced at the daemon
boundary.

Initial channels:

- `stable`
- `nightly`

Initial default:

- Desktop app: `stable`

Every app launch must check whether the running daemon is compatible with the
app's protocol and channel.

## App Setting

The desktop app exposes the initial preference:

```text
Update channel: Stable | Nightly
```

For a Homebrew-managed install, this setting should not directly patch the app
bundle. It should either:

- explain the matching cask switch, or
- trigger a package-manager-aware update path if Tao owns one later.

The setting can still be useful before direct in-app updates exist because it
defines which channel the app expects when checking compatibility, diagnostics,
and upgrade guidance.

When the setting is absent, the desktop app treats `stable` as its product
default.

## Implementation Sequence

1. Document the daemon runtime contract, channel rules, and installer
   ownership boundaries. **Done.**
2. Publish reusable `taod` artifacts for the channels Tao supports.
3. Add Homebrew Casks for `tao` and `tao-nightly`.
4. Add launch smoke coverage for no-daemon, compatible-daemon, and
   incompatible-daemon cases.
5. Add desktop channel preference UI once update/check plumbing exists.
   **Initial preference control done.**

## Verification Expectations

Installer and channel work should include focused smoke tests before release:

- Desktop app launches with no daemon and starts its bundled daemon.
- Desktop app reuses a compatible running daemon.
- Stable app plus incompatible nightly daemon fails with clear guidance.
- Nightly app plus incompatible stable daemon fails or replaces only through
  the controlled upgrade path.
- Homebrew-managed app does not self-mutate outside the package manager.
