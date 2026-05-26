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
        linuxElectronRuntimeLibs = pkgs.lib.optionals pkgs.stdenv.isLinux (with pkgs; [
          alsa-lib
          atk
          at-spi2-atk
          cairo
          cups
          dbus
          expat
          gdk-pixbuf
          glib
          gtk3
          libdrm
          libglvnd
          libgbm
          libxkbcommon
          mesa
          nspr
          nss
          pango
          udev
          libx11
          libxcomposite
          libxdamage
          libxext
          libxfixes
          libxrandr
          libxcb
        ]);
        linuxElectronLibraryPath = pkgs.lib.makeLibraryPath linuxElectronRuntimeLibs;
        linuxElectronMesa = pkgs.lib.optionalString pkgs.stdenv.isLinux "${pkgs.mesa}";
      in
      {
        # ── Dev shell (nix develop) ──
        devShells.default = pkgs.mkShell {
          name = "tao";

          # Build-time dependencies
          nativeBuildInputs = (with pkgs; [
            nodejs_22 # LTS (matches CI)
            pnpm_10 # Package manager
            cargo # Rust CLI workspace
            rustc # Rust CLI workspace
            rustfmt # Rust formatting
            clippy # Rust linting
            rust-analyzer # Rust language server
            zig_0_15 # taod daemon + Ghostty/Zig tooling
            zls_0_15 # Zig language server matching Zig 0.15.x
            nixpkgs-fmt # nix fmt / CI format check
          ]) ++ pkgs.lib.optionals pkgs.stdenv.isLinux (with pkgs; [
            patchelf # Repair npm Electron's Linux interpreter in the dev shell
          ]);

          # Runtime dependencies for Electron
          # Linux-specific; macOS uses system frameworks.
          buildInputs = linuxElectronRuntimeLibs;

          shellHook = ''
            if [ "$(uname -s)" = "Linux" ]; then
              # VS Code and some tooling set this for extension hosts. It makes
              # Electron behave like Node, which breaks the app main process.
              unset ELECTRON_RUN_AS_NODE

              electron_append_path_without_nix_glibc() {
                local current_path="''${1:-}"
                local next_path=""
                local entry=""
                while [ -n "$current_path" ]; do
                  entry="''${current_path%%:*}"
                  if [ "$entry" = "$current_path" ]; then
                    current_path=""
                  else
                    current_path="''${current_path#*:}"
                  fi
                  case "$entry" in
                    *-glibc-*/lib|*-glibc-*/lib64) ;;
                    *) next_path="''${next_path:+$next_path:}$entry" ;;
                  esac
                done
                printf '%s' "$next_path"
              }

              electron_gl_lib_path=""
              for path in /run/opengl-driver/lib /run/opengl-driver-32/lib; do
                if [ -d "$path" ]; then
                  electron_gl_lib_path="''${electron_gl_lib_path:+$electron_gl_lib_path:}$path"
                fi
              done
              electron_inherited_ld_library_path="$(electron_append_path_without_nix_glibc "''${LD_LIBRARY_PATH:-}")"
              export LD_LIBRARY_PATH="${linuxElectronLibraryPath}''${electron_gl_lib_path:+:$electron_gl_lib_path}''${electron_inherited_ld_library_path:+:$electron_inherited_ld_library_path}"

              electron_egl_vendor_dirs=""
              for path in /run/opengl-driver/share/glvnd/egl_vendor.d /run/opengl-driver-32/share/glvnd/egl_vendor.d ${linuxElectronMesa}/share/glvnd/egl_vendor.d; do
                if [ -d "$path" ]; then
                  electron_egl_vendor_dirs="''${electron_egl_vendor_dirs:+$electron_egl_vendor_dirs:}$path"
                fi
              done
              export __EGL_VENDOR_LIBRARY_DIRS="$electron_egl_vendor_dirs''${__EGL_VENDOR_LIBRARY_DIRS:+:$__EGL_VENDOR_LIBRARY_DIRS}''${EGL_VENDOR_LIBRARY_DIRS:+:$EGL_VENDOR_LIBRARY_DIRS}"
              export LIBGL_DRIVERS_PATH="${linuxElectronMesa}/lib/dri''${LIBGL_DRIVERS_PATH:+:$LIBGL_DRIVERS_PATH}"
            fi

            echo "🖥  Tao Terminal dev shell"
            echo "   node:  $(node --version)"
            echo "   pnpm:  $(pnpm --version)"
            echo "   zig:   $(zig version)"
            echo "   zls:   $(zls --version)"
            echo "   rust:  $(rustc --version)"
            echo "   ra:    $(rust-analyzer --version)"
            echo ""
            echo "   pnpm install && pnpm dev"
            echo "   pnpm check        # TS + Zig lint/format/type/test checks"
            echo "   pnpm cli:check    # Rust CLI workspace check"
            echo "   pnpm zig:lsp      # verify Zig language server availability"
            echo "   pnpm cli:lsp      # verify Rust language server availability"
            echo ""
          '';
        };

        # ── Formatter (nix fmt) ──
        formatter = pkgs.nixpkgs-fmt;
      }
    );
}
