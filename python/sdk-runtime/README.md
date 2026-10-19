# deepseek-harness-runtime-bin

English | [中文](README.zh.md)

Platform runtime wheel for the DeepSeek Harness Python SDK. It packages the normal `dsh` CLI and its closed Node dependency tree into a native executable, so SDK use requires no system Node.js. This package publishes wheels only.

## Installed commands and artifacts

The wheel installs a `dsh` console command and the `deepseek_harness_runtime` Python module. `dsh` forwards its arguments to the bundled executable and requires a non-empty `DSH_HOME`; it never falls back to `~/.dsh`.

Production executables are named `deepseek-harness-sdk-runtime-<platform>-<arch>` under the module's `runtime/` directory; Windows uses the `.exe` suffix. Linux and macOS wheels include a target-native `-rg` sidecar, Windows includes `-rg.exe`, and macOS also includes `-spawn-helper` for `node-pty`. Published targets are Linux x64, Linux arm64, macOS arm64, macOS x64, and Windows x64. The wheel tag and payload must match exactly; no Windows arm64 wheel is published.

The wheel carries only the executable, native execution helpers, and `<platform>-<arch>/` with `downloads.json` and the lightweight `office-skills/` tree. CPython, authoring libraries, standalone Node, pnpm, and the complete Office sidecar are optional downloads. Importing Python modules, starting SDK profiles, and processing Office files never download resources.

Download either resource explicitly before using it:

```py
from deepseek_harness_runtime import download_office, download_primary_runtime

office = download_office()
primary_runtime = download_primary_runtime()
```

`download_office()` downloads the locked npm Kit, target engine, and complete dependency tree, plus standalone Node for the Kit CLI. `download_primary_runtime()` independently downloads CPython, locked Python libraries, Node, pnpm, and Office skills. Both return absolute resource directories and reuse completed caches. The authoring download validates its target, interpreters, library directory and skills before returning. The existing local `installPrimaryRuntime()` operation still copies an already available payload; it does not download. The shared builder applies the [NumPy/pandas test-file exclusions](../../apps/desktop/README.md#bundled-workspace-dependencies).

`DSH_RESOURCE_CACHE` selects an absolute cache root, defaulting to `~/.cache/deepseek-harness/resources`. Resource identities include the release's locked inputs. Downloads verify archive hashes and package identities, preserve executable permissions, and publish completed directories atomically. Failed downloads can be retried. `DSH_RESOURCE_DOWNLOAD_TIMEOUT_MS` bounds each archive download, including its body; the default is `300000`, and accepted values are integers from `1` to `2147483647`. Downloads follow the Harness proxy environment policy. Installed wheel files are never modified. Release versions have separate cache directories; unused versions require manual removal. Downloads use the locked upstream URLs without a registry or mirror override.

On subsequent launches the packaged bootstrap exposes downloaded resources to the SDK profile. `DSH_PRIMARY_RUNTIME` overrides the cached authoring environment; an empty value disables its query. `DSH_OFFICE_SIDECAR` can select an absolute sidecar directory with its standalone Node. Users may provide their own Python environment and document libraries without downloading the authoring environment. Office skills are available when either resource is selected; authoring-only deployments expose the skills with the Kit CLI disabled. External authoring payloads retain the `primary-runtime/` plus sibling `office-skills/` layout. The SDK reads resources in place without copying them into `DSH_HOME`. The `sdk-minimal` profile does not mount these providers.

Skill selection is independent of delivery: project, custom-directory, and user filesystem skills override same-name bundled skills. An SDK patch can disable only the Office provider while retaining the Python query:

```yaml
- id: skill-office
  disabled: true
```

Office operation skills invoke the configured Node and Kit CLI through the profile's shell commands. See the [Office provider](../../packages/skill/skill-office/README.md#use-this-package) for command selection and replacing the skill collection. Configuration patches apply at process startup; changing skills does not require rebuilding the runtime wheel or Python environment.

Repository builds also materialize a dev-only `runtime/node/` carrier. It runs `node runtime/node/runtime-bootstrap.mjs` on system Node 24.9 or newer. It is never selected automatically and is excluded from wheels and sdists.

Both carriers execute the same `dsh` grammar and shipped profiles, including the standalone `sdk-minimal` tree and the full `web` profile with its frontend assets. The private `dsh-python-runtime-closure` manifest defines the packaged dependency closure; there is no Python-specific Node application or checked-in default `cordis.yml`.

## Python module API

- `bundled_package_dir() -> Path` returns the installed module-data root and verifies its release metadata.
- `bundled_runtime_path() -> Path` returns the current platform executable and verifies required sidecars.
- `resolve_bundled_launch_args(mode=None) -> tuple[str, ...]` returns the executable argv by default. Explicit `mode="node"` or `DSH_RUNTIME_MODE=node` selects the repo-only Node carrier.
- `download_office() -> Path` explicitly downloads or reuses the Office sidecar and its standalone Node.
- `download_primary_runtime() -> Path` explicitly downloads or reuses the authoring environment.
- `resolve_office_launch_args() -> tuple[str, str]` locates the installed Node and Kit CLI without downloading; missing resources raise `FileNotFoundError` with the download instruction.
- `main()` implements the installed `dsh` console command and rejects an absent or blank `DSH_HOME`. On Windows it waits for the bundled process with inherited standard streams and forwards its exit status; on POSIX it replaces the Python process.

Unsupported platforms and missing executables or sidecars raise `FileNotFoundError` with the build and installation routes. Unknown runtime modes raise `ValueError`.

## Packaged profile resolution

`dsh` initializes shipped profiles under the explicit home, composes their bundle patches, and loads bundled plugins from the executable's virtual filesystem. Runtime resolution uses an in-memory generation instead of disk symlinks or proxy packages. Fallback imports use recorded declaring-package paths, including paths inside the executable's virtual filesystem, so built-in rows and external plugin peers share the bundled Cordis/module instance. Native shared libraries and Windows ConPTY addons are packaged with native addons, while ripgrep and the macOS PTY helper remain executable sidecars.

Python and the packaged bootstrap share the resource layout: `<cache>/<identity>/office/`, `node/bin/node[.exe]`, and `node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js`. Automatic Office cache discovery requires the `complete` marker to match the manifest identity; an explicit `DSH_OFFICE_SIDECAR` requires the Node and CLI files. The Python bootstrap resolves the Office kit from its explicitly downloaded or selected sidecar so native helpers and URL Workers use real filesystem paths. The same resource preparation implementation serves repository builds and explicit Python downloads. The kit owns document operations; the Office smoke retrieves CLI paths from the loaded skill and executes capabilities and DOCX conversion with an empty PATH.

External profile management uses `dsh plugin --profile <name> ...`. That command requires `pnpm` on `PATH`; ordinary SDK/profile execution does not.

## Build and distribution

Production deployment permits unused workspace patches for packages outside the runtime closure; patches for included packages must still apply successfully. This exception is confined to the deploy command; repository installation still rejects unused patches.

From the repository root, `pnpm exec tsx scripts/build-exe-for-python-sdk.ts` verifies the closure, builds packages, deploys a symlink-free tree, packages the selected target, and syncs the executable and sidecars into this module. The executable stores embedded files with Brotli compression. Only the target platform’s PTY prebuilds are packaged. Package README, CHANGELOG, HISTORY Markdown, source maps, and TypeScript declarations outside runtime assets are omitted. Deployment disables workspace hoisting, and packaging excludes checkout dependencies and workspace source trees outside the deployment so dependency scans cannot add development packages to the payload. Staging shares root workspace packages with nested consumers of the same pnpm dependency identity, preserving singleton services while retaining different peer resolutions. `scripts/build-python-release.py` stages release-shaped wheels at the root repository version and pins `deepseek-harness-sdk` to the exact runtime version.

The installed-wheel smoke creates a clean virtual environment outside the checkout, proves the installed distribution and executable identities, then exercises default and customized SDK profiles, external plugins, MCP, native tools, direct JSON-RPC, committed snapshots, and the real provider on trusted runs. Its Office scenario relocates the lightweight target payload, explicitly downloads the sidecar, and converts DOCX with the required platform engine: the target’s declared native engine, or WASM when no native engine is declared. See the [Python contributor workflow](../development.md) and [installed-wheel testing decision](../../.agents/notes/implemented/testing/2026-08-23-installed-python-wheel-black-box-ci.md).
