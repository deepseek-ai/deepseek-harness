# Agent Note: One dsh launcher for application profiles

Status: implemented

English | [中文](2026-08-22-single-dsh-application-launcher.zh.md)

## Problem

DeepSeek Harness application processes need one owner for composition, plugin resolution, environment discovery, shutdown, and user customization. A dedicated app bin with a complete `cordis.yml` creates a second lifecycle beside profile launch: plugins installed into a profile do not reach it, behavior drifts from `dsh-base`, and SDK callers learn arbitrary process argv instead of the product's composition model.

The Python SDK distributes a native executable through four platform wheels. Its packaged process uses the same profile launcher while preserving the closed VFS dependency tree, native sidecars, and installed-wheel evidence.

## Decision

### Launch scope

Every supported Node application starts through the `dsh` CLI and one named profile. The shipped application commands are `dsh web`, `dsh --profile headless`, `dsh --profile sdk`, `dsh --profile sdk-minimal`, and `dsh --profile acp`; `dsh web` is the deliberate convenience alias for `--profile web`, not another application entry.

Vendor CLIs, build-only and test-only executables, direct in-process plugin mounting, and the private browser WebWorker preview are outside the application-launch inventory. A package app bin or root demo that launches a package entry is not an accepted extension point.

### Profile applications

`@deepseek-ai/dsh-sdk-app` and `@deepseek-ai/dsh-acp-app` compose the full protocol applications over `@deepseek-ai/dsh-base`. The SDK bundle adds the JSON-RPC server plus app-owned help and stdio lifetime; the ACP bundle adds the automation-only ACP server plus the same application responsibilities. Both adopt the base model, tools, persistence, settings, credentials, policy, and environment behavior. The [standalone sdk-minimal profile](../../archived/architecture/2026-08-24-standalone-sdk-minimal-profile.md) reuses SDK startup and JSON-RPC serving but deliberately owns a complete explicit tree without `dsh-base`.

Profile manifests own patch reload:

| Profile | `patchReload` |
|---|---|
| `web` | `live` |
| `headless` | `startup` |
| `sdk` | `startup` |
| `sdk-minimal` | `startup` |
| `acp` | `startup` |

Custom profiles default to `live`. A startup profile still applies its bundle, profile, home-level, and invocation `--patch` layers, but it does not watch them after boot. `dsh-base` inserts the module-HMR row disabled; a profile with a tested source-module reload lifecycle must enable it explicitly. None of the shipped profiles enable server module HMR: `patchReload: live` uses the launcher's config-only watcher while the startup profiles install no watcher. SDK and ACP cannot safely replace their server, agents, persistence, or tool registry inside one owned stdio connection.

The shipped protocol profiles reserve stdout for protocol frames, expose help without starting transport, and route stdin EOF and signals through bounded root disposal. ACP remains automation-only. The SDK JSON-RPC methods, notification fields, and `initialize.serverInfo.name` remain stable. Full-profile model-visible tool and persistence defaults come from `dsh-base`, including its [default editor selection](../simplification/2026-09-05-base-default-file-editor.md); `sdk-minimal` owns its explicit defaults. Runnable snapshots own the assembled application outputs.

### TypeScript SDK customization

`@deepseek-ai/dsh-sdk-client` depends on the same-version `@deepseek-ai/dsh` package, resolves its installed CLI module, runs it through the current Node executable, and selects `sdk` by default. Both client layers expose `dshBin`, `profile`, ordered `patches`, `dshHome`, process cwd, environment, and timeouts; arbitrary command/argv launch remains an internal fake-runtime adapter.

SDK users customize plugins through profiles. `dsh plugin --profile <name> ...` manages persistent dependencies and bundle order, the profile's `cordis.patch.yml` owns persistent row changes, and launch `patches` supply ordered ephemeral overrides. A custom profile must retain `@deepseek-ai/dsh-sdk-app` or another SDK server row. Relative CLI-module, patch, explicit home, and process-cwd paths become absolute before spawn, and initialization has a finite bound whose diagnostic names the selected profile.

Direct SDK use follows normal Harness-home resolution: explicit `dshHome`, inherited `DSH_HOME`, then `~/.dsh`. `subagent-dsh-sdk` instead requires an explicit absolute home, so a nested runtime cannot discover a person's profiles, installed plugins, credentials, or sessions through the operating-system home. DSH-specific ACP child examples also pass an isolated home; the ACP backend itself remains generic for non-DSH agents.

### Python runtime

The Python runtime wheel stages [`python/sdk-runtime/runtime-bootstrap.mjs`](../../../../python/sdk-runtime/runtime-bootstrap.mjs) as the `dsh-python-runtime-closure` entry. Its ordinary branch calls the public CLI export; a provider-private selector dispatches to the internal subprocess runner before CLI parsing and is not an application entry point. The [native-containment decision](2026-08-28-subprocess-native-containment.md) owns that private dispatch. The Python client selects `dsh --profile sdk` by default, ordered patch files, and an explicit Harness home; the runnable example under `python/sdk/examples` selects `sdk-minimal`. The installed `dsh` console command exposes the same profile grammar and the separately packaged `web` application.

The executable family is `deepseek-harness-sdk-runtime-<platform>-<arch>`. The SDK wire, wheel and import distribution names, sidecar names, and wire identity `deepseek-harness-sdk-runtime` remain stable. The SDK package family is `@deepseek-ai/dsh-sdk-client`, `@deepseek-ai/dsh-sdk-protocol`, and `@deepseek-ai/dsh-sdk-jsonrpc-server`; `@deepseek-ai/dsh-acp` remains the ACP protocol plugin. There is no Python-specific Node application, checked-in complete config, compatibility package, forwarding executable, fallback parser, or SDK/ACP launcher alias. [docs/architecture.md](../../../../docs/architecture.md) owns this launch, and the [`python/sdk-runtime` README](../../../../python/sdk-runtime/README.md) owns the Windows carrier.

### Enforcement

`verify-application-entrypoints` scans application/package manifests, executable sources, and root demo scripts. The allowlist classifies the `dsh` product bin, vendor-excluded scope, the private WebWorker build tool, and test support. An unclassified shebang, a new package bin, or a demo wrapper that bypasses `apps/cli/src/bin.ts` fails hygiene and the primary/static CI aggregates.

## Existing decisions and supersession

This decision supersedes the application-launch and package-name facts in [profile plugin bundles](2026-08-05-profile-plugin-bundles.md), [TypeScript SDK client and subagent backend](../../archived/feature/2026-07-27-typescript-sdk-and-sdk-subagent-backend.md), [remove the SDK project toolchain](../../archived/simplification/2026-08-11-remove-sdk-project-toolchain.md), and [single-file Python SDK runtime distribution](2026-07-10-single-file-executable-sdk-runtime-distribution.md). Those notes retain independent authority for profile layering, client/wire semantics, deleted project tooling, and native packaging.

The [ACP automation-only protocol](../simplification/2026-07-23-acp-automation-only-protocol.md) remains authoritative for ACP wire and interaction scope. The [adding-a-package cookbook](../../../../docs/cookbook/adding-a-package.md) owns role-based package names. The [standalone sdk-minimal profile](../../archived/architecture/2026-08-24-standalone-sdk-minimal-profile.md) partially supersedes this note's base-first rule and complete-tree alternative while retaining this note's launcher ownership. No active note is fully superseded or eligible for archival.

## Alternatives considered

**Keep direct bins and state that profiles are preferred.** Rejected: documentation cannot make profiles own plugin installation, environment loading, shutdown, and tests while a supported executable bypasses them.

**Keep forwarding compatibility bins.** Rejected: a forwarding executable remains another public launch name and compatibility promise. The pre-release repository can move callers directly to profiles.

**Put caller-supplied complete Cordis trees behind profile wrappers.** Rejected: that centralizes argv without centralizing application composition. Full profiles use `dsh-base` plus thin app bundles so shared policy has one owner. A repository-owned, versioned standalone bundle is allowed only when an explicit roster is the product behavior, as [sdk-minimal](../../archived/architecture/2026-08-24-standalone-sdk-minimal-profile.md) records.

**Accept inline plugins or a complete `cordis.yml` in the TypeScript constructor.** Rejected: the SDK would become another package installer and application composer. Named profiles and patch files already provide persistent and per-launch customization through one resolution model.

**Resolve `dsh` only from `PATH`.** Rejected: ordinary Node processes do not reliably inherit a project-local `.bin` path. A same-version package dependency provides a deterministic runtime.

**Enable module HMR in `dsh-base` and make unsafe profiles disable it.** Rejected: the shared base also underlies custom profiles, so an enabled default makes every new application remember to opt out of source-module replacement. A disabled base makes module HMR an explicit profile capability while leaving `patchReload: live` config watching available.

**Hot-reload protocol profiles.** Rejected: replacing a protocol server or its dependencies can invalidate pending frames and SDK-owned agents. Process restart is the adoption boundary for SDK and ACP configuration changes.

**Move the Python executable through profiles without a separate packaging proof.** Rejected: the native VFS closure, four platform wheels, profile assets, ripgrep and spawn-helper sidecars, and clean-install behavior require their own migration evidence.

## Verification

- Source and built CLI acceptance cover `sdk`, `sdk-minimal`, and `acp` help, transport startup, stdout purity, EOF, signals, and root disposal.
- Bundle configuration tests pin module HMR disabled in `dsh-base` and absent from shipped mode overrides; the custom live-profile e2e pins config reload through the launcher's watch-only fallback.
- Focused unit suites cover profile launch resolution, initialization bounds, SDK retries, server readiness, and nested isolated homes with 100% coverage on the changed runtime sources.
- Keyless ACP and SDK snapshots boot real `dsh` profiles and pin protocol output plus persisted logs; the nested SDK composition boots a second real profile runtime.
- The real-API workflow caps file parallelism at four because one profile e2e file can own several complete `dsh` subprocess trees; workflow tests pin that resource bound.
- The Python suite exercises exe and node carriers; packaged-runtime scenarios, native macOS executable construction, both wheels, and clean-wheel default/MCP smokes pin the `deepseek-harness-sdk-runtime-*` artifacts and profile launch.
- `verify-application-entrypoints` includes invalid fixtures for package bins, executable sources, package-launching demo wrappers, and unclassified demos.

## Consequences

- A user changes an SDK application's plugin composition through a named profile and ordered patches, using the same installation and resolution model as every other dsh application.
- A custom profile receives live config watching without server module HMR and opts into source-module replacement only through an explicit row override.
- The full SDK and ACP profiles share the complete base application and one set of policy and tools; `sdk-minimal` owns its explicit standalone roster, and snapshots present intentional assembled differences.
- Adding `@deepseek-ai/dsh` increases the TypeScript client's install size in exchange for a deterministic same-version runtime.
- Trusted user patches can add a plugin that writes to stdout and corrupt their own protocol stream; shipped profiles guarantee purity, not arbitrary third-party composition.
- Python packages the ordinary `dsh` profile launcher while retaining a closed native runtime and no system-Node requirement for wheel users.
