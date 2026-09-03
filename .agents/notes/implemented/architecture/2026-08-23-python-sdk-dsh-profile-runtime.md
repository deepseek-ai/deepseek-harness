# Agent Note: Python SDK runtime through the dsh profile launcher

Status: implemented

English | [中文](2026-08-23-python-sdk-dsh-profile-runtime.zh.md)

## Problem

The Python SDK distributed a private Node application that booted a complete external `cordis.yml`, while every other supported application entered through `dsh` profiles. That exception duplicated environment loading, configuration ownership, plugin resolution, shutdown, artifact names, and test paths. It also made SDK customization an all-or-nothing application tree: a caller replacing one plugin had to own the JSON-RPC server and every unrelated deployment row.

A normal profile cannot be adopted only at the Python wrapper. The runtime executable must contain the `dsh` CLI, shipped profile and bundle files, native libraries, and a module-resolution path that works when profile files and external plugins live outside pkg's virtual filesystem.

## Decision

### One application launcher

The runtime executable packages `@deepseek-ai/dsh` and runs its ordinary command grammar. The Python client selects `--profile sdk` by default, forwards ordered absolute `--patch` paths, and may select another `dsh` executable or profile. The runnable minimal example selects the shipped `sdk-minimal` profile. The private `@deepseek-ai/dsh-sdk-python-runtime` application package and checked-in runtime `cordis.yml` do not exist. JSON-RPC serving remains the `@deepseek-ai/dsh-sdk-app` bundle and `@deepseek-ai/dsh-sdk-jsonrpc-server` plugin, not a Python-owned boot path.

The public Python configuration is `dsh_bin`, `profile`, ordered `patches`, `dsh_home`, process cwd/environment, provider/model/token selection, a bounded initialization timeout, and optional turn/shutdown timeouts. It does not expose a complete Cordis tree or arbitrary launch argv. `RunResult` reports the protocol-owned run values and does not duplicate the profile's persistence path.

Every Python launch requires either explicit `dsh_home` or a non-empty `DSH_HOME` in the child environment. The SDK never discovers `~/.dsh`. The selected home consistently owns profiles, external plugins, credentials, settings, and sessions.

### Plugin customization

Persistent SDK customization uses the same profile interfaces as direct CLI use. `dsh plugin --profile <name> ...` manages external dependencies and bundle order, `$DSH_HOME/profiles/<name>/cordis.patch.yml` owns persistent row changes, the home patch applies machine-local changes across profiles, and Python `patches` supplies invocation-specific overlays. A selected profile is valid only when it retains an SDK server row. Missing profiles, bundles, server rows, and invalid patches fail without a complete-config fallback; a profile that remains alive without serving JSON-RPC fails the independently bounded initialization handshake with a diagnostic naming that profile.

The [standalone sdk-minimal profile](2026-08-24-standalone-sdk-minimal-profile.md) lists one repository-owned bundle that inserts its complete explicit tree without `dsh-base`. Its persistent Bash and string-replace editor are present by composition; the shared JSON-RPC server exposes no root-agent tool filter. Dynamic runtime context, workspace instructions, settings, managed credentials, telemetry, compaction, and every other base row are absent. The same runtime still packages the full `sdk` and `web` profiles as separate choices.

The runtime wheel installs a `dsh` console command. Ordinary profile and SDK execution remains Node-free; external package management requires a caller-installed `pnpm`.

### Executable packaging

The zero-code deployment manifest is `dsh-python-runtime-closure`. It packages `node_modules/@deepseek-ai/dsh/lib/bin.js` and profile, bundle, preset, native-addon, and shared-library assets into `deepseek-harness-sdk-runtime-<platform>-<arch>`. The wheel distribution names, Python import modules, JSON-RPC messages, and wire-stable `serverInfo.name = deepseek-harness-sdk-runtime` remain unchanged.

Plain Node profiles use symlinks in `$DSH_HOME/profiles/node_modules` to share installation packages with external plugins. An operating-system symlink cannot traverse pkg's `/snapshot` filesystem, so the packaged CLI writes small real ESM proxy packages instead. Each proxy resolves the source package's explicit ESM export map directly under Node import conditions, exposes targets that exist in the installation, and re-exports their virtual module URLs. Export rows without an ESM runtime target and executable-only or declaration-only packages produce no unusable proxy entry; malformed export maps fail startup. A complete matching generation returns without acquiring the cross-process writer lock. A missing or stale entry acquires the lock, rechecks the generation, and repairs it without exposing partial proxies; either carrier can replace the other carrier's managed entry. Loader rows and external plugin peers therefore resolve through the normal profile parent walk while retaining one Cordis and one instance of each bundled module.

The published target set is Linux x64, Linux arm64, macOS arm64, macOS x64, and Windows x64. Installed-wheel black-box CI owns artifact provenance, default and patched profiles, external bundle installation, native tools, MCP, direct JSON-RPC, snapshots, and trusted real-provider turns on every target. The [Windows x64 runtime decision](2026-08-23-python-sdk-windows-x64-runtime.md) owns the Windows artifact and its platform-specific shell surface.

## Existing decisions and supersession

This decision implements and supersedes the Python exception and deferred-migration sections of [the single dsh application launcher](2026-08-22-single-dsh-application-launcher.md). It supersedes the private application, external complete-config, artifact-name, and customization facts in [the single-file Python SDK runtime distribution](2026-07-10-single-file-executable-sdk-runtime-distribution.md), which remains authoritative for pkg/SEA, wheel construction, native target validation, and publication. The [standalone sdk-minimal profile](2026-08-24-standalone-sdk-minimal-profile.md) supersedes only this note's minimal-overlay realization. No active note is fully superseded, so none is archived.

## Alternatives considered

**Keep complete `cordis.yml` as an advanced escape hatch.** Rejected because it preserves a second application assembly and lets a caller bypass profile environment, plugin, and shutdown ownership.

**Silently use `~/.dsh` for compatibility.** Rejected because an SDK process must not inherit a person's plugins, credentials, settings, or sessions without an explicit choice.

**Copy the virtual dependency tree into every home.** Rejected because it duplicates hundreds of megabytes and loads a second Cordis instance. Export-preserving proxies are small and retain module identity.

**Bundle pnpm and Node package management into every SDK launch.** Rejected because installed plugins are deployment state, not per-turn runtime work. Only `dsh plugin` needs the external package manager.

## Consequences

Python callers configure the same profile vocabulary as TypeScript and direct CLI users, and arbitrary external bundles can extend an SDK profile without introducing another launcher. Homes are selected explicitly, complete-config and `session_root` parameters are unavailable, and the executable includes shared-library assets plus profile-module proxies. The full `sdk`, standalone `sdk-minimal`, and `web` applications remain separate profiles inside the same packaged CLI. The installed-wheel CI makes those package, profile, native, and provider paths release requirements rather than source-only assumptions.
