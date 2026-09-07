# deepseek-harness-runtime-bin

English | [中文](README.zh.md)

Platform runtime wheel for the DeepSeek Harness Python SDK. It packages the normal `dsh` CLI and its closed Node dependency tree into a native executable, so SDK use requires no system Node.js. This package publishes wheels only.

## Installed commands and artifacts

The wheel installs a `dsh` console command and the `deepseek_harness_runtime` Python module. `dsh` forwards its arguments to the bundled executable and requires a non-empty `DSH_HOME`; it never falls back to `~/.dsh`.

Production executables are named `deepseek-harness-sdk-runtime-<platform>-<arch>` under the module's `runtime/` directory; Windows uses the `.exe` suffix. Linux and macOS wheels include a target-native `-rg` sidecar, Windows includes `-rg.exe`, and macOS also includes `-spawn-helper` for `node-pty`. Published targets are Linux x64, Linux arm64, macOS arm64, macOS x64, and Windows x64. The wheel tag and payload must match exactly; no Windows arm64 wheel is published.

Repository builds also materialize a dev-only `runtime/node/` carrier. It runs `node runtime/node/node_modules/@deepseek-ai/dsh/lib/bin.js` on system Node 22.19 or newer. It is never selected automatically and is excluded from wheels and sdists.

Both carriers execute the same `dsh` grammar and shipped profiles, including the standalone `sdk-minimal` tree and the full `web` profile with its frontend assets. The private `dsh-python-runtime-closure` manifest defines the packaged dependency closure; there is no Python-specific Node application or checked-in default `cordis.yml`.

## Python module API

- `bundled_package_dir() -> Path` returns the installed module-data root and verifies its release metadata.
- `bundled_runtime_path() -> Path` returns the current platform executable and verifies required sidecars.
- `resolve_bundled_launch_args(mode=None) -> tuple[str, ...]` returns the executable argv by default. Explicit `mode="node"` or `DSH_RUNTIME_MODE=node` selects the repo-only Node carrier.
- `main()` implements the installed `dsh` console command and rejects an absent or blank `DSH_HOME`. On Windows it waits for the bundled process with inherited standard streams and forwards its exit status; on POSIX it replaces the Python process.

Unsupported platforms and missing executables or sidecars raise `FileNotFoundError` with the build and installation routes. Unknown runtime modes raise `ValueError`.

## Packaged profile resolution

`dsh` initializes shipped profiles under the explicit home, composes their bundle patches, and loads bundled plugins from the executable's virtual filesystem. Because operating-system symlinks cannot enter that filesystem, packaged launches maintain small real ESM proxy packages under `$DSH_HOME/profiles/node_modules`. Each proxy mirrors explicit runtime exports, records the original package identity, and re-exports the virtual module URL. Built-in rows and external plugin peers therefore share one Cordis/module instance. Native shared libraries and Windows ConPTY addons are packaged with native addons, while ripgrep and the macOS PTY helper remain executable sidecars.

External profile management uses `dsh plugin --profile <name> ...`. That command requires `pnpm` on `PATH`; ordinary SDK/profile execution does not.

## Build and distribution

From the repository root, `pnpm exec tsx scripts/build-exe-for-python-sdk.ts` verifies the closure, builds packages, deploys a symlink-free tree, packages the selected target, and syncs the executable and sidecars into this module. `scripts/build-python-release.py` stages release-shaped wheels at the root repository version and pins `deepseek-harness-sdk` to the exact runtime version.

The installed-wheel smoke creates a clean virtual environment outside the checkout, proves distribution and executable provenance, then exercises default and customized SDK profiles, external plugins, MCP, native tools, direct JSON-RPC, committed snapshots, and the real provider on trusted runs. See the [Python contributor workflow](../development.md) and [installed-wheel testing decision](../../.agents/notes/implemented/testing/2026-08-23-installed-python-wheel-black-box-ci.md).
