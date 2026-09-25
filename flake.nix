{
  description = "Kilo development flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    { self, nixpkgs, ... }:
    let
      systems = [
        "aarch64-linux"
        "x86_64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      forEachSystem = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      rev = self.shortRev or self.dirtyShortRev or "dirty";
    in
    {
      devShells = forEachSystem (pkgs: {
        default =
          let
            # Pin bun to the version declared in package.json (packageManager: "bun@1.3.14").
            # The locked nixpkgs revision ships 1.3.11, so we fetch the official release directly.
            bun =
              let
                sources = {
                  "aarch64-linux" = {
                    name = "bun-linux-aarch64";
                    hash = "sha256-on/7Y6gxA3WDbg1vZorhf6jY0YuIw3yCHGUzGXOhmjs=";
                  };
                  "x86_64-linux" = {
                    name = "bun-linux-x64";
                    hash = "sha256-lR7iruhV8IWVruxiJSJqKY0/6oOj3NZGXAnLzN9+hI8=";
                  };
                  "aarch64-darwin" = {
                    name = "bun-darwin-aarch64";
                    hash = "sha256-2LliIYKK1vl6x6wKt+lYcjQa92MAHogD6CZ2UsJlJiA=";
                  };
                  "x86_64-darwin" = {
                    name = "bun-darwin-x64";
                    hash = "sha256-QYPfM3RiPlurMVxUfPoJdFM81FfYa3O2OfeoeXTNZjM=";
                  };
                };
                source =
                  sources.${pkgs.stdenv.hostPlatform.system}
                    or (throw "Unsupported system for bun: ${pkgs.stdenv.hostPlatform.system}");
              in
              pkgs.stdenv.mkDerivation rec {
                pname = "bun";
                version = "1.3.14";
                src = pkgs.fetchurl {
                  url = "https://github.com/oven-sh/bun/releases/download/bun-v${version}/${source.name}.zip";
                  inherit (source) hash;
                };
                nativeBuildInputs = [
                  pkgs.unzip
                ] ++ pkgs.lib.optional pkgs.stdenv.isLinux pkgs.autoPatchelfHook;
                buildInputs = pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.stdenv.cc.cc.lib ];
                dontConfigure = true;
                dontBuild = true;
                installPhase = ''
                  runHook preInstall
                  install -Dm755 bun $out/bin/bun
                  ln -s $out/bin/bun $out/bin/bunx
                  runHook postInstall
                '';
                meta = {
                  description = "Fast all-in-one JavaScript runtime";
                  homepage = "https://bun.sh";
                  license = pkgs.lib.licenses.mit;
                  mainProgram = "bun";
                  platforms = builtins.attrNames sources;
                };
              };

            kilo-dev = pkgs.writeShellScriptBin "kilo-dev" ''
              set -euo pipefail

              : "''${KILO_ROOT:?KILO_ROOT is not set. Enter the flake dev shell from the repo root.}"
              export KILO_DEV_CWD="$PWD"
              exec ${bun}/bin/bun --cwd "$KILO_ROOT/packages/opencode" --conditions=browser ./src/index.ts "$@"
            '';

          in
          pkgs.mkShell {
            packages =
              with pkgs;
              [
                bun
                nodejs_20
                python3
                pkg-config
                openssl
                git
                gh
                playwright-driver.browsers
                vsce
                unzip
                gnutar
                gzip
                patchelf
                ripgrep
                jdk21
                kilo-dev
              ]
              ++ lib.optionals stdenv.isLinux [
                libX11
                libXext
                libXrender
                libXtst
                libXi
                fontconfig
                freetype
              ];
            shellHook = ''
              export KILO_ROOT="$PWD"
              export PLAYWRIGHT_BROWSERS_PATH="${pkgs.playwright-driver.browsers}"
              export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
            ''
            + pkgs.lib.optionalString pkgs.stdenv.isLinux ''
              export LD_LIBRARY_PATH="${
                pkgs.lib.makeLibraryPath [
                  pkgs.libX11
                  pkgs.libXext
                  pkgs.libXrender
                  pkgs.libXtst
                  pkgs.libXi
                  pkgs.fontconfig
                  pkgs.freetype
                ]
              }:$LD_LIBRARY_PATH"
            '';
          };
      });

      overlays = {
        default =
          final: _prev:
          let
            node_modules = final.callPackage ./nix/node_modules.nix {
              inherit rev;
            };
            opencode = final.callPackage ./nix/opencode.nix {
              inherit node_modules;
            };
          in
          {
            inherit opencode;
          };
      };

      packages = forEachSystem (
        pkgs:
        let
          node_modules = pkgs.callPackage ./nix/node_modules.nix {
            inherit rev;
          };
          kilo = pkgs.callPackage ./nix/kilo.nix {
            inherit node_modules;
          };
        in
        {
          default = kilo;
          inherit kilo;
          # Updater derivation with fakeHash - build fails and reveals correct hash
          node_modules_updater = node_modules.override {
            hash = pkgs.lib.fakeHash;
          };
        }
      );
    };
}
