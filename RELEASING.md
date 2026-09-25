# Releasing Kilo Code

Kilo Code uses a fully automated CI pipeline triggered via GitHub Actions `workflow_dispatch`. The workflow handles version bumping, building the internal serve artifact and VSIX, and publishing to the supported distribution channels.

## How to Trigger a Release

1. Go to the [`publish` workflow](https://github.com/Kilo-Org/kilocode/actions/workflows/publish.yml) in GitHub Actions.
2. Click **"Run workflow"**.
3. Select the branch (typically `main`).
4. Fill in the inputs:
   - **`bump`** (choice): `patch`, `minor`, or `major`. Determines how the version number is incremented.
   - **`version`** (string, optional): Override the version explicitly instead of using `bump`. Leave empty to use the bump-based calculation.
   - **`pre_release`** (boolean, default `true`): Publish as pre-release (VS Code Marketplace + Open VSX `--pre-release` flag, npm rc channel, GitHub pre-release).

   > **⚠️ Do not fill in `version` unless you have a specific reason to.**
   > The default behavior — leaving `version` empty and selecting a `bump` level — is almost always what you want. The automated bump logic computes the correct next version from the current state of the repo. Only use the `version` override for exceptional cases like skipping versions. For pre-releases, use the `pre_release` input instead of a `-beta` version override.

5. Click **"Run workflow"** to start the release.

## What Happens During a Release

The `publish.yml` workflow runs jobs sequentially: version, build serve artifact, validate, build VSIX, publish.

### 1. Version (`version`)

- Checks out the repo with full history (`fetch-depth: 0`).
- Runs `script/version.ts` to compute the next version based on the `bump` or `version` input.
- Generates release notes from the commit history since the last release.
- Creates a **draft** GitHub Release with the computed tag (e.g. `v1.2.3`) and release notes.
- Outputs the `version`, `release` (database ID), and `tag` for downstream jobs.

### 2. Build Serve Artifact (`build-cli`)

- Runs `packages/opencode/script/build.ts` to compile the internal `kilo-serve` binary.
- Builds native `kilo-serve` binaries for **all supported platforms and architectures**:
  - Linux: x64, arm64 (glibc and musl), plus baseline (non-AVX2) variants
  - macOS: x64, arm64, plus baseline variants
  - Windows: x64 (plus baseline variant), arm64
- Patches ELF interpreters on Linux binaries for broad compatibility.
- Packs the `dist/` tree into a single `kilo-cli.tar.zst` (zstd-compressed tar) and uploads it as the workflow artifact for downstream jobs. This artifact is **internal only** — it is not published as standalone CLI archives and is consumed directly by the VSIX build. No `npm`, Homebrew, AUR, Docker/GHCR, or standalone GitHub CLI archives are produced.

### 3. Validate Serve Artifact (`validate-cli-*`)

- Downloads and unpacks `kilo-cli.tar.zst` on Linux, macOS, Windows, and Alpine runners.
- Smoke-checks `kilo-serve --version` and `kilo-serve serve --help` plus bundled resources (tree-sitter wasms, sandbox helpers). This validates the internal artifact that will be bundled into the VSIX.

### 4. Build VS Code Extension (`build-vscode`)

- Downloads the `kilo-cli.tar.zst` artifact from the previous job and unpacks to `packages/opencode/dist`.
- Runs `packages/kilo-vscode/script/build.ts` to build VSIX packages for all target platforms:
  - `linux-x64`, `linux-arm64`, `alpine-x64`, `alpine-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`, `win32-arm64`
- Each VSIX bundles the platform-specific `kilo-serve` binary and resources.
- Uploads the VSIX files as workflow artifact (`kilo-vscode`).

### 5. Publish (`publish`)

Downloads build artifacts and publishes to the supported channels:

#### Version Commit and Tagging

- Updates the `version` field in all `package.json` files across the monorepo.
- Rebuilds the TypeScript SDK (`packages/sdk/js`).
- Commits the version bump, tags the commit, and pushes to the repo.
- Promotes the draft GitHub Release to a published release (with VSIX assets only).

#### SDK (`@kilocode/sdk`)

- Builds and publishes the TypeScript SDK to **npm**.

#### Plugin (`@kilocode/plugin`)

- Builds and publishes the plugin interface package to **npm**.

#### VS Code Extension

- Publishes platform-specific VSIX packages to the **VS Code Marketplace** via `vsce` and to **Open VSX** via `ovsx publish` (both honor the `pre_release` input with `--pre-release`).
- Uploads all VSIX files to the **GitHub Release** as assets. The GitHub Release contains **VSIX only** — no standalone `kilo` CLI archives (`kilo-*.zip`/`kilo-*.tar.gz`) and no `kilo-serve` tarballs outside the internal `kilo-cli.tar.zst` workflow artifact.

No additional package registries are published. Homebrew (`Kilo-Org/homebrew-tap`), AUR (`kilo-bin`), Docker/GHCR (`ghcr.io/kilo-org/kilocode`), and npm `@kilocode/cli` (including `@kilocode/cli-*` platform packages) are not part of the release.

## Prerequisites and Permissions

### Repository Access

- The workflow only runs in the `Kilo-Org/kilocode` repository (guarded by `if: github.repository == 'Kilo-Org/kilocode'`).
- You must have **write access** to the repository to trigger a `workflow_dispatch` event.

### Workflow Permissions

The workflow requires these GitHub token permissions:

- `id-token: write` -- for npm provenance attestation (SDK/plugin)
- `contents: write` -- for creating releases, pushing tags, and uploading assets
- `issues: write` -- as declared in `publish.yml` (GitHub API access during release)
- `pull-requests: write` -- as declared in `publish.yml` (GitHub API access during release)
- `packages: write` -- retained for workflow compatibility (no GHCR publish in VSIX-only release)

### Required Secrets

The following secrets must be configured in the repository:

| Secret | Purpose |
|---|---|
| `KILO_API_KEY` | Kilo API key used during version computation |
| `KILO_ORG_ID` | Kilo organization ID |
| `KILO_MAINTAINER_APP_ID` | GitHub App ID for the kilo-maintainer bot (used for git commits) |
| `KILO_MAINTAINER_APP_SECRET` | GitHub App secret for the kilo-maintainer bot |
| `NPM_TOKEN` | npm authentication token for publishing SDK/plugin |
| `VSCE_TOKEN` | VS Code Marketplace personal access token |
| `OVSX_TOKEN` | Open VSX Registry token for `ovsx publish` (active: pre-release-aware publish to Open VSX) |

`AUR_KEY` is no longer required (AUR publish removed).

### Concurrency

The workflow uses concurrency control (`${{ github.workflow }}-${{ github.ref }}-${{ inputs.version || inputs.bump }}`) to prevent parallel releases from conflicting. It does not include `pre_release`, so a pre-release and a stable release with the same bump/version inputs share the same concurrency group.
