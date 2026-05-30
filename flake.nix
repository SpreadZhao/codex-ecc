{
  description = "Codex + ECC multi-repository workspace";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    ecc-src = {
      url = "github:affaan-m/ECC";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, ecc-src, ... }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          runtimeInputs = with pkgs; [
            bash
            coreutils
            findutils
            gawk
            git
            gnused
            jq
            nodejs_24
            python3
            ripgrep
          ];
        in
        rec {
          ecc-universal = pkgs.buildNpmPackage {
            pname = "ecc-universal";
            version = "2.0.0-rc.1";
            src = ecc-src;
            npmDepsHash = "sha256-BMSDkBZ3IzaCh16SLY5Z6wy34j3M0BzBOQT6WCbofTU=";
            npmFlags = [ "--omit=dev" ];
            dontNpmBuild = true;
            nativeBuildInputs = [ pkgs.makeWrapper ];

            installPhase = ''
              runHook preInstall

              mkdir -p "$out/lib/ecc" "$out/bin"
              cp -R . "$out/lib/ecc"

              makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/ecc" \
                --add-flags "$out/lib/ecc/scripts/ecc.js" \
                --set CODEX_ECC_RUNTIME "$out/lib/ecc" \
                --set CLAUDE_PLUGIN_ROOT "$out/lib/ecc" \
                --set ECC_PLUGIN_ROOT "$out/lib/ecc"

              makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/ecc-install" \
                --add-flags "$out/lib/ecc/scripts/install-apply.js" \
                --set CODEX_ECC_RUNTIME "$out/lib/ecc" \
                --set CLAUDE_PLUGIN_ROOT "$out/lib/ecc" \
                --set ECC_PLUGIN_ROOT "$out/lib/ecc"

              runHook postInstall
            '';
          };

          ecc-src-wrapper = pkgs.writeShellApplication {
            name = "ecc";
            inherit runtimeInputs;
            text = ''
              export CODEX_ECC_RUNTIME="${ecc-src}"
              export CLAUDE_PLUGIN_ROOT="${ecc-src}"
              export ECC_PLUGIN_ROOT="${ecc-src}"
              exec ${pkgs.nodejs_24}/bin/node "${ecc-src}/scripts/ecc.js" "$@"
            '';
          };

          ecc = ecc-universal;

          codex-ecc = pkgs.writeShellApplication {
            name = "codex-ecc";
            runtimeInputs = runtimeInputs ++ [ ecc ];
            text = ''
              workspace="''${CODEX_ECC_WORKSPACE:-$PWD}"
              if [ ! -x "$workspace/scripts/codex-workspace" ]; then
                echo "codex-ecc must run from a codex-ecc workspace or with CODEX_ECC_WORKSPACE set" >&2
                exit 1
              fi
              exec "$workspace/scripts/codex-workspace" "$@"
            '';
          };

          ecc-workspace = pkgs.writeShellApplication {
            name = "ecc-workspace";
            runtimeInputs = runtimeInputs ++ [ ecc ];
            text = ''
              workspace="''${CODEX_ECC_WORKSPACE:-$PWD}"
              if [ ! -x "$workspace/scripts/ecc-workspace" ]; then
                echo "ecc-workspace must run from a codex-ecc workspace or with CODEX_ECC_WORKSPACE set" >&2
                exit 1
              fi
              export NPM_CONFIG_PREFIX="''${NPM_CONFIG_PREFIX:-$workspace/.npm-global}"
              export NPM_CONFIG_CACHE="''${NPM_CONFIG_CACHE:-$workspace/.npm-cache}"
              export npm_config_prefix="$NPM_CONFIG_PREFIX"
              export npm_config_cache="$NPM_CONFIG_CACHE"
              exec "$workspace/scripts/ecc-workspace" "$@"
            '';
          };

          codex-ecc-doctor = pkgs.writeShellApplication {
            name = "codex-ecc-doctor";
            runtimeInputs = runtimeInputs;
            text = ''
              workspace="''${CODEX_ECC_WORKSPACE:-$PWD}"
              if [ ! -x "$workspace/scripts/codex-ecc-doctor.js" ]; then
                echo "codex-ecc-doctor must run from a codex-ecc workspace or with CODEX_ECC_WORKSPACE set" >&2
                exit 1
              fi
              exec ${pkgs.nodejs_24}/bin/node "$workspace/scripts/codex-ecc-doctor.js" "$@"
            '';
          };

          ecc-install-git-hooks = pkgs.writeShellApplication {
            name = "ecc-install-git-hooks";
            runtimeInputs = runtimeInputs;
            text = ''
              workspace="''${CODEX_ECC_WORKSPACE:-$PWD}"
              if [ ! -x "$workspace/scripts/install-ecc-git-hooks.sh" ]; then
                echo "ecc-install-git-hooks must run from a codex-ecc workspace or with CODEX_ECC_WORKSPACE set" >&2
                exit 1
              fi
              exec "$workspace/scripts/install-ecc-git-hooks.sh" "$@"
            '';
          };

          ecc2 = pkgs.rustPlatform.buildRustPackage {
            pname = "ecc2";
            version = "0.1.0";
            src = "${ecc-src}/ecc2";
            cargoLock.lockFile = "${ecc-src}/ecc2/Cargo.lock";
          };

          default = codex-ecc;
        });

      apps = forAllSystems (system: {
        ecc = {
          type = "app";
          program = "${self.packages.${system}.ecc-workspace}/bin/ecc-workspace";
        };
        ecc-universal = {
          type = "app";
          program = "${self.packages.${system}.ecc}/bin/ecc";
        };
        ecc-workspace = {
          type = "app";
          program = "${self.packages.${system}.ecc-workspace}/bin/ecc-workspace";
        };
        codex-ecc-doctor = {
          type = "app";
          program = "${self.packages.${system}.codex-ecc-doctor}/bin/codex-ecc-doctor";
        };
        ecc-install-git-hooks = {
          type = "app";
          program = "${self.packages.${system}.ecc-install-git-hooks}/bin/ecc-install-git-hooks";
        };
        codex-ecc = {
          type = "app";
          program = "${self.packages.${system}.codex-ecc}/bin/codex-ecc";
        };
        default = self.apps.${system}.codex-ecc;
      });

      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              bash
              coreutils
              direnv
              fd
              findutils
              gawk
              git
              gnused
              jq
              nodejs_24
              pnpm
              python3
              ripgrep
              yq-go
            ];

            shellHook = ''
              export CODEX_ECC_WORKSPACE="$PWD"
              export ECC_SRC="${ecc-src}"
              if [ -d "$PWD/.ecc/source" ]; then
                export CODEX_ECC_RUNTIME="$PWD/.ecc/source"
              else
                export CODEX_ECC_RUNTIME="${ecc-src}"
              fi
              export CLAUDE_PLUGIN_ROOT="$CODEX_ECC_RUNTIME"
              export ECC_PLUGIN_ROOT="$CODEX_ECC_RUNTIME"
              export AGENTS_HOME="$PWD/.agents"
              export CLV2_HOMUNCULUS_DIR="$PWD/.ecc/state/ecc-homunculus"
              export ECC_STATE_DIR="$PWD/.ecc/state"
              export ECC_GLOBAL_HOOKS_DIR="$PWD/.codex/git-hooks"

              # Keep npm writes local to the workspace.
              export NPM_CONFIG_PREFIX="$PWD/.npm-global"
              export NPM_CONFIG_CACHE="$PWD/.npm-cache"
              export npm_config_prefix="$NPM_CONFIG_PREFIX"
              export npm_config_cache="$NPM_CONFIG_CACHE"
              export CODEX_ECC_BIN="$PWD/scripts/bin"
              export PATH="$CODEX_ECC_BIN:$NPM_CONFIG_PREFIX/bin:$PATH"
              mkdir -p "$NPM_CONFIG_PREFIX/bin" "$NPM_CONFIG_CACHE"
            '';
          };
        });
    };
}
