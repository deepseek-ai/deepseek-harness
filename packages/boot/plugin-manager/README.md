---
description: "Enable profile plugins and install, remove or select bundles from the Web sidebar or an agent."
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-manager

English | [中文](README.zh.md)

Application-owned profiles supply their bundled package-manager invocation through launcher facts. It takes precedence over `pnpmCommand` for package operations and registry inspection; its environment applies only to those subprocesses.

## Summary

Manage the current profile's plugins without editing configuration by hand. Enable or disable individual plugin entries, select installed bundles, and install or remove external bundles. With HMR enabled in YAML, configuration changes apply immediately; without HMR, the running composition remains until restart. Changes affect every session using the profile.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Failure behavior](#failure-behavior)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Base-backed profiles provide the manager. In Web, the sidebar's **Plugins** page ([ui-plugin-manager](../../client/ui-plugin-manager/README.md)) manages the profile's bundles and their uniquely addressable rows; the Settings Plugin list stays read-only. Agent-preset rows remain read-only. The `plugin_manager` tool exposes the same operations and is enabled in Creator mode. Other presets keep it disabled by default. Every tool action requires `danger-full-access` or approval for that call. Under lower sandbox modes, `ask` requests approval; `never`, rejection, cancellation, or an unavailable approval channel prevents execution. An approval leaves the session permission mode unchanged. Profile changes persist across sessions, and installed Host code executes in-process outside the workspace sandbox. Dependency build-script approval remains separate.

For a deployment without agent presets, enable the tool in the profile patch. Preset-backed sessions use their preset’s `tool-plugin-manager` entry.

```yaml
- id: tool-plugin-manager
  disabled: false
```

A plugin toggle updates only `disabled` in the last matching override in the profile's `cordis.patch.yml`, or appends an override when none matches. Matching uses the entry id and any module-name assertion. A bundle toggle changes `package.json`'s ordered `dsh.profile.bundles` list. Disabling retains the dependency; enabling appends the bundle at the end, which can change configuration precedence. Installation enables a new bundle by default. Home and invocation patches retain their higher priority.

A selected bundle that cannot load remains in `listBundles` with an `error`; `enabled` records the saved selection, not successful loading. The plugin page shows the error and allows deselection. A broken bundle cannot be enabled. Management bundles remain protected if their files become unreadable.

`listBundles` includes optional display `meta` for each bundle and its declared plugin rows, including disabled bundles. The Client selects a language from these values. The separate `description` field is the bundle's raw `package.json.description`; a metadata diagnostic does not block management. The `plugin_manager` tool omits UI display metadata from list results.

`inspect(spec, options)` reads what a spec names before anything installs: a registry name is asked of the registry through `pnpm view`, run in the profile directory so the same proxy and authentication settings apply as to the install; an absolute path has its `package.json` read; a git address or tarball answers only its form and the `host` it is fetched from. The answer carries the name, version, description, whether the package declares a bundle, and the `registry` that answered, or a `problem`: `invalid-spec`, `already-installed`, `not-found`, `not-a-package`, `not-a-bundle`, `network`, or `unknown`, with the `registries` asked. A caller's `signal` or `inspectTimeoutMs` ends the lookup.

`installBundle` checks GitHub repositories with `git ls-remote` before starting pnpm, using the profile directory and the installer's Git and proxy configuration. `githubConnectionTimeoutMs` defaults to 5000 ms and limits only this check, not package download or builds. The check disables credential helpers and prompts; only network failures and timeouts stop installation, reporting `failedAt: 'spec-host'` with the existing failure kind and diagnostic log. Authentication, repository lookup and other failures are left to pnpm, including its HTTPS-to-SSH fallback. Cancellation and manager disposal stop the check and its descendants. Registry packages, paths, tarballs and other Git hosts skip this check. A reachable repository can still fail during download or bundle validation.

Registries are asked in turn. The plan starts at `options.registry`, else the configured `registry` (`null` is the one pnpm's own configuration names), and continues through `fallbackRegistries` while a registry is unreachable, times out, or answers that it has no such package or version, which a mirror not yet synced does. A registry outside the configured set is asked alone, so a private registry never falls through to a public one; pnpm's own registry counts as part of the set only while what it names, read through `pnpm config get registry` before each plan, is npm's own registry or one of the fallbacks, and is otherwise asked alone as a private one. A registry pnpm's own configuration already names is asked once. The lookup runs `pnpm view` with `--registry` and without pnpm's own retries, so a dead registry is reported within `inspectTimeoutMs` and the next one is asked; pnpm prints its refusal as JSON on stdout, which is read like stderr. The install keeps pnpm's retry settings. `registries()` answers the configured set and what pnpm names, for a picker. The [registry Agent Note](../../../.agents/notes/implemented/architecture/2026-09-18-plugin-install-registries.md) owns the rationale.

The browser-safe `@deepseek-ai/dsh-plugin-manager/registry` entry exports `OFFICIAL_NPM_REGISTRY` and `NPMMIRROR_REGISTRY` for consumers that identify those public registries.

`installBundle` accepts a caller-generated `requestId`, under which `plugin-manager/install-log` streams each pnpm run's output and `plugin-manager/install-state` announces `installing`, `cancelling`, and `applying`; `installing` is announced once per registry asked, with the `attempt`'s registry, position, and the plan's length. The install asks the same plan as the lookup, from `options.registry`, running `pnpm add` with `--registry` and restoring the profile files between attempts; it moves on for the failures another registry can change and stops at any other, and at a failure whose error line names the host a git or tarball spec is fetched from, which no registry stands in for; `failedAt` says which of the two the last failed run could not reach. `cancelInstall(requestId)` stops the run and answers `cancelled` only after the Git check or pnpm exited and the files are back, `too-late` once the bundle is being applied, and `not-running` for any other id; the install call then reports `application: 'cancelled'`. A run that fails, is cancelled, or adds a package without a bundle patch restores `package.json` and `pnpm-lock.yaml` as they were; `packageResult.kind` classifies the last run from its exit and output, `registries` names every registry asked, and `bundle` names the package a finished run added. `listBundles` carries each bundle's one-liner (the package `description`), the rows its patch declares with their live entries, and the built-in rows it overrides; it lists the profile's own bundles, the bundles the installation supplies, and a selected name without a bundle patch as a `not-bundle` problem, while an unselected plain dependency is left out. A bundle the launcher's `OPTIONAL_BUNDLES` names is `optional`: shipped switched off for the person to turn on, never removable, and selected by no shipped template ([rationale](../../../.agents/notes/implemented/process/2026-09-15-shipped-optional-bundles.md)). Every completed operation emits `plugin-manager/changed`; a patch generation applied outside the manager, by HMR's watcher after a CLI or hand edit, announces nothing, so the page learns of it on its next read.

`waitForInstall(requestId)` lets a client recover a lost response by waiting for the active installation, including its non-cancellable application phase. It returns the same outcome as the original call, or `null` if the request is not active. Completed results are not retained; `null` establishes neither success nor cancellation.

When pnpm 11 blocks dependency scripts, the failed installation reports every pending package name in the profile under `pendingBuilds`, including names left by earlier attempts; a failed run restores `package.json` and `pnpm-lock.yaml` but deliberately not `pnpm-workspace.yaml`, where pnpm records them. The Web plugin page offers **Allow these scripts and retry**; the tool can grant permission on the user's behalf through `approvedBuilds` on `install_bundle`, after the user approves those scripts in the conversation. The service validates pending names; it does not verify conversation approval. Approval persists by package name in this profile, permits commands with the host user's permissions, and survives another installation failure. Only currently undecided names can be approved; existing denials and wildcard rules cannot be overridden through this action. Approval rejects YAML anchors or aliases inside `allowBuilds`. Retry preserves the original activation choice.

<a id="version-compatibility-and-exemptions"></a>
### Version compatibility and exemptions

An install command that names packages (`add`, or `install` with specs) is checked before pnpm runs: a local path is read from its own `package.json`, and a registry spec is resolved through pnpm's registry lookup for the version its range selects and the peers that version declares. An incompatible DSH peer rejects the operation before pnpm runs, so nothing is downloaded and no build script runs; a build approval the caller supplied with the request is recorded before this check and remains. A git or tarball spec needs the fetch itself, so it is judged after installation: the operation then restores the profile manifest and lockfile, reinstalls the restored lockfile (or, when the profile had none, reinstalls from the restored manifest without creating one), and reports whether that recovery succeeded; already permitted build-script effects may remain. A dependency the run did not change never blocks an unrelated operation: it stays installed, the run reports a warning naming it, and profile startup denies it. Installation requests with `enabled: false` are checked the same way. Startup checks run independently; see [App boot](../app-boot/README.md#profiles) for range semantics. Version exemptions do not authorize dependency scripts.

An exemption is an exact `package-name@version` mapped to a list of exact DSH runtime versions in the profile's own `compatibility.json`, beside `package.json` and `cordis.patch.yml`. Writing it changes no dependency, no bundle selection, and no patch layer. Neither plugin upgrades nor DSH upgrades inherit permission. Use `plugin_manager` with `list_version_exemptions` to obtain the runtime version and saved grants, then `set_version_exemption` with `target`, `runtimeVersion`, and `enabled`. Granting also requires `acceptRisk: true`, only after warning the user that incompatible plugins may cause crashes or data loss and receiving explicit permission for that pair. The service checks the acknowledgement and versions, not conversation history. Revocation can remove historical runtime grants.

A grant takes effect on the next composition. A live profile recomposes, so the granted plugin mounts in the running session and the result reports `applied`; a startup-only profile keeps its current entries until restart and reports `restart-required`.

The CLI exposes `dsh plugin --profile <profile> version-exemptions`, `allow-version <package@version> --dsh-version <runtime> --accept-risk`, and `revoke-version <package@version> --dsh-version <runtime>`. A grant prints a risk warning before saving. A compatibility refusal carries the `incompatible-version` code with each refused package's `name`, `version`, `runtimeVersion`, and unsatisfied `peers`; each surface renders that record itself. The Web page words it through its locale dictionary, and a CLI refusal prints the exact `allow-version` command. Use the tool or CLI to grant an exemption and retry the original operation.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `pnpmCommand` | `pnpm` | The pnpm executable name or path, resolved through `PATH` like the `dsh plugin` command. |
| `inspectTimeoutMs` | `20000` | Bound on one registry lookup an inspection runs, in milliseconds. |
| `githubConnectionTimeoutMs` | `5000` | Deadline for the GitHub repository check before installation, in milliseconds. |
| `registry` | pnpm's own | The registry lookups and installations ask first, as an http(s) URL; absent, the one pnpm's own configuration names. |
| `fallbackRegistries` | `['https://registry.npmmirror.com/']` | Registries asked in turn, as http(s) URLs, while the one before is unreachable or holds no copy of the package; pnpm's own registry joins the order only while it names npm's own registry or one of these. |
| `outputBytes` | `16384` | Maximum pnpm diagnostic bytes returned per operation; the full output remains in the returned log path. |
| `lockWaitMs` | `120000` | Maximum time in milliseconds to acquire the profile write lock. |
| `idleTimeoutMs` | `600000` | Maximum time in milliseconds a service package run may capture no output before the manager terminates it; a run with inherited descriptors (`dsh plugin`) is never bound. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The service and `dsh plugin` share the package operations in [operations.ts](src/operations.ts). The launcher supplies the current profile; [DSH HMR](../hmr/README.md) serializes module reloads, file watching and management writes. Each refresh re-reads bundle selection and patch layers, updates the original root Include, and awaits removed plugin resources as well as the remaining Loader tree. CLI and service operations share the profile manifest writer lock to prevent concurrent package and manifest writes. HMR does not acquire that lock. Pnpm runs outside the HMR queue; installation selects the bundle after pnpm succeeds, while removal deselects and unloads the bundle before pnpm runs. A service run whose captured output stays silent for `idleTimeoutMs` is terminated, reports `timedOut` alongside its exit status, is classified `timeout` whatever status the signal left behind, and is not retried on the next registry, which bounds how long one operation can hold the profile lock; the CLI inherits the terminal, captures no output, and stays unbounded for its operator to interrupt. A run completes when its process exits, and the pipes then drain under a bounded grace period, so a descendant that inherited them cannot hold the operation open. A terminated run stops its whole process tree and waits for it, because a lifecycle script outlives the pnpm process that started it (issue #4981). Each operation records the pnpm run it starts in `.plugin-manager/run.json` and removes the record when the run ends. A lock whose holder process exited is taken over by the next writer, but that process's pnpm tree can still be running, so an operation that finds a record waits up to five seconds for the recorded run to stop and otherwise fails with a diagnostic that names the process and the record, without running pnpm. Dependency-only changes do not trigger configuration reloads.

Results contain the last attempted stage, target, saved-state change, application status and error codes. Web dictionaries render management text; pnpm and Loader diagnostics remain unmodified. Unrelated pre-existing inactive entries return warnings; new or changed failures and inactive explicit enablement targets fail the operation. A failed or cancelled installation restores the manifest and lockfile it snapshotted before pnpm ran ([rationale](../../../.agents/notes/implemented/architecture/2026-09-15-guided-plugin-installation.md)); a failed removal retains its partial changes and diagnostics. Installations are tracked by request id until their call settles, so a cancellation names one run and joins its settlement without taking the profile lock. The CLI inherits authentication variables and terminal descriptors; service operations use a scrubbed environment and captured output. No invariant companion is published because the manager reads files and Loader state directly and owns no independent state projection.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [App boot](../app-boot/README.md) — profile layers and startup policy.
- [Plugin inventory](../../host/plugin-inventory/README.md) — current Loader and preset observations.
- [Plugin manager page](../../client/ui-plugin-manager/README.md) — the Web sidebar page over this service.
- [Plugin settings](../../client/ui-settings-plugin-inventory/README.md) — the read-only Web inventory.

<a id="model-experience"></a>
## Model Experience

### Management tool

#### What the model sees

The [`plugin_manager` tool](../../../docs/tool-catalog.md#deepseek-aidsh-plugin-manager) lists plugin entries and bundles and performs profile-wide changes. Its results include saved-state changes, application status and package diagnostics. Management operations do not inject messages into Agents.

#### Token effect

The tool declaration is present when its consumer is mounted; each invocation adds its returned inventory or change result.

#### KV Cache effect

Tool results append to the transcript. Enabling or disabling other tools can change subsequent tool declarations and their cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Web approves the entire displayed pending group; it has no per-package selection.
- Package replacements require restarting the process to load a fresh JavaScript module generation.
- Startup-only profiles cannot remove packages used to start the current process; stop it and use `dsh plugin`.
- The manager cannot disable its own management components, change another profile, or edit an agent preset's composition.
- A failed removal may leave dependencies partially changed, and a failed or cancelled installation can leave downloaded files under `node_modules` or the pnpm store. Inactive dependencies with missing files remain removable. Diagnostic logs remain under the profile's `.plugin-manager/logs` directory.
- Management results describe Host activation. Browser synchronization failures appear separately in the Settings plugin list.
- Desktop package operations remain owned by the Desktop shell.

<a id="failure-behavior"></a>
### Failure behavior

Failures preserve completed steps and report the actual remaining state. Profile dependencies without valid bundle metadata remain visible and removable, with enablement unavailable.

| Failed operation | Handling |
|---|---|
| Install: pnpm or bundle validation fails | Restore `package.json` and `pnpm-lock.yaml` as snapshotted before pnpm ran; files pnpm downloaded may remain. Report installation failure. |
| Enable: saving selection or loading fails | Keep the installed dependency and any saved selection. Report enablement failure; allow repair, disablement or removal. |
| Remove: any step fails | Stop at the failed step. Preserve completed changes, retain remaining dependencies for retry, and report removal failure. Do not re-enable the bundle. |

Installation finishes after pnpm and bundle validation succeed; subsequent enablement failure does not undo installation. Removal proceeds in order: remove the bundle from `dsh.profile.bundles`, unload its runtime contributions, then run `pnpm remove`. A failed step prevents subsequent steps.

Restoration rewrites only the two snapshotted files; user-authored patch configuration, application data, diagnostic logs and files pnpm downloaded remain untouched, and the next package operation prunes packages no manifest references.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
