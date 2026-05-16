{
  description = "Tao Terminal — A super-performant terminal emulator with Ghostty WASM";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
        };
      in
      {
        # ── Dev shell (nix develop) ──
        devShells.default = pkgs.mkShell {
          name = "tao";

          # Build-time dependencies
          nativeBuildInputs = with pkgs; [
            nodejs_22 # LTS (matches CI)
            pnpm_10 # Package manager
            zig_0_16 # taod daemon + Ghostty/Zig tooling
            zls # Zig language server
            nixpkgs-fmt # nix fmt / CI format check
          ];

          # Runtime dependencies for Electron
          # Linux-specific; macOS/Windows use system frameworks
          buildInputs = with pkgs;
            lib.optionals stdenv.isLinux [
              atk
              cairo
              cups
              dbus
              expat
              gdk-pixbuf
              glib
              gtk3
              libdrm
              libxkbcommon
              mesa
              nspr
              nss
              pango
              udev
              xorg.libX11
              xorg.libXcomposite
              xorg.libXdamage
              xorg.libXext
              xorg.libXfixes
              xorg.libXrandr
              xorg.libxcb
            ];

          shellHook = ''
            echo "🖥  Tao Terminal dev shell"
            echo "   node:  $(node --version)"
            echo "   pnpm:  $(pnpm --version)"
            echo "   zig:   $(zig version)"
            echo "   zls:   $(zls --version)"
            echo ""
            echo "   pnpm install && pnpm dev"
            echo "   pnpm check        # TS + Zig lint/format/type/test checks"
            echo "   pnpm zig:lsp      # verify Zig language server availability"
            echo ""
          '';
        };

        # ── Formatter (nix fmt) ──
        formatter = pkgs.nixpkgs-fmt;
      }
    );
}
