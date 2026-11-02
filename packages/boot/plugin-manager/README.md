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

Base-backed profiles provide the manager. In Web, the sidebar's **Plugins** page ([ui-plugin-manager](../../client/ui-plugin-manager/README.md)) manages the profile's bundles and their uniquely addressable rows; the Settings Plugin list stays read-only. Agent-preset rows remain read-only. The `plugin_manager` tool exposes the same operations and is enabled in the Standard and Creator presets. Other Web presets keep it disabled by default. The full SDK profile enables it at profile scope in native/PTC mode; without HMR, saved changes return `restart-required` with `no-hmr` and apply after the runtime restarts. Every tool action requires `danger-full-access` or approval for that call. Under lower sandbox modes, `ask` requests approval; `never`, rejection, cancellation, or an unavailable approval channel prevents execution. An approval leaves the session permission mode unchanged. Profile changes persist across sessions, and installed Host code executes in-process outside the workspace sandbox. Dependency build-script approval remains separate.

For a deployment without agent presets other than the full SDK profile, enable the tool in the profile patch. Package installation/removal requires pnpm on `PATH` or an explicit `pnpmCommand`; a launcher-provided package manager takes precedence. Preset-backed sessions use their preset’s `tool-plugin-manager` entry.

```yaml
- id: tool-plugin-manager
  disabled: false
```

A plugin toggle updates only `disabled` in the last matching override in the profile's `cordis.patch.yml`, or appends an override when none matches. Matching uses the entry id and any module-name assertion. An override holding only `id` and `disabled` is removed, and none is appended, when the bundle layers and the remaining profile patches already give the entry the requested state, so the profile patch records only departures from the bundles. Home and invocation patches are left out of that comparison; they apply after the profile patch and do not decide what it records. A bundle toggle changes `package.json`'s ordered `dsh.profile.bundles` list. Disabling retains the dependency; enabling appends the bundle at the end, which can change configuration precedence. Installation enables a new bundle by default. Home and invocation patches retain their higher priority.

Bundle platform declarations are checked before saving an enabled selection. Unsupported Hosts return `unsupported-platform`. The bundle remains visible with its display metadata and can still be deselected. Automatic activation after a package operation uses the same check. The agent-facing next step asks the user to run the bundle on a supported Host.

`listBundles` retains default-hidden bundles and derives `listedByDefault` from each package’s visibility declaration and Host platform support. Unsupported bundles are hidden from default GUI lists, including More; explicit profile dependencies and saved selections remain manageable with the platform reason and deselection available. The offline Official catalog carries the same package-owned platform declaration, so uninstalled entries are checked without resolving provider code or querying a registry. These checks do not change selection or activation. A non-boolean declaration returns a metadata diagnostic. A selected bundle that cannot load remains in `listBundles` with an `error`; `enabled` records the saved selection, not successful loading. The plugin page shows the error and allows deselection. A broken bundle cannot be enabled. Management bundles remain protected if their files become unreadable.

`listBundles` includes optional display `meta` for each bundle and its declared plugin rows, including disabled bundles. The Client selects a language from these values. The separate `description` field is the bundle's raw `package.json.description`; a metadata diagnostic does not block management. `source` gives a profile dependency as a spec `pnpm add` accepts: a git address or URL as recorded without the user information of an http(s) URL (a query string stays as recorded), a `file:` or `link:` path made absolute against the profile or the home directory for `~`, and a registry range, tag, or alias after the package name, as is any spec of a package installed under another name; a bundle the installation supplies has none, even when the profile also depends on it, because the installation's copy is the one that loads. The `plugin_manager` tool omits UI display metadata and update eligibility from list results.

`listBundles` marks shipped optional bundles and on-demand catalog entries as `official`, independently of package installation. `availability` identifies a readable installation-provided or profile package, or `missing`; on-demand catalog entries exclude undeclared transitive copies. `installed` only records whether the profile declares the dependency. An absent on-demand entry carries embedded localized metadata and a host-derived `installTarget` containing the running DSH version and install spec, without registry access. Profile-declared packages with unreadable files retain their declaration and expose the normal error.

`inspect(spec, options)` reads what a spec names before anything installs: a registry name is asked of the registry through `pnpm view`, run in the profile directory so the same proxy and authentication settings apply as to the install; an absolute path has its `package.json` read; a git address or tarball answers only its form and the `host` it is fetched from. The answer carries the name, version, description, whether the package declares a bundle, and the `registry` that answered, or a `problem`: `invalid-spec`, `already-installed`, `not-found`, `not-a-package`, `not-a-bundle`, `network`, or `unknown`, with the `registries` asked. A caller's `signal` or `inspectTimeoutMs` ends the lookup.

Published installations offer `package@<running DSH version>`. Source Web and development Desktop offer `link:<absolute workspace package directory>` from the running CLI installation, including its development symlink. Package names resolve through workspace manifests; current working directory and prerelease suffixes do not select a checkout. Missing packages, bundle patches, or built entry points produce a diagnostic without registry fallback. Prepare the checkout with `pnpm install` and `pnpm run build`. Linked packages use that checkout’s dependencies and peers; rebuilding and restarting remain necessary after code changes. A registry copy or another checkout’s link can need replacement even when its version matches.

Official on-demand installs call the same `installBundle` operation as other bundles. Registry targets use `saveExact: true`; development targets retain the ordinary `link:` dependency. An explicit update removes the installed package and installs the target with the current `enabled` selection; without HMR, a bundle that runs since startup cannot be removed, so the installation goes over it and reports `restart-required`. A failed or cancelled installation after the removal leaves the package uninstalled, and the reinstalled bundle joins the end of the selection. Turning Off only deselects the layer, and Remove uses the existing removal checks. Installation failure restores the profile manifest and lockfile; activation failure after installation can retain the saved dependency and selection. The existing peer-compatibility check still applies, without an additional Official-only version admission rule.

`listVersions(name, options)` reads the published versions newer than an installed bundle that `listBundles` marks `updatable`: a third-party profile dependency saved as a registry spec under its own name, not an `npm:` alias, whose manifest declares a semver version, and that carries no plugin management. One `pnpm view <name> versions time dist-tags` asks the registry plan from `options.registry`, else the registry this process last installed the package from, else the configured one. The newest `versionListLimit` versions above the installed one are then read from the registry that answered, one `pnpm view <name>@<version>` each and at most `versionLookupConcurrency` at a time, because pnpm prints only the highest match of a range. The list orders them newest first with their dist-tags, publication time, prerelease flag, deprecation message, whether they declare a bundle, and an `incompatible` record when their `engines.dsh` or DSH peers reject the running version without an exemption; `omitted` counts the newer versions left out, and `attempts` names every registry asked with what each failed with. A refusal is `not-updatable`, `not-found`, `network`, or `unknown`; one version lookup that fails refuses the whole list. Official bundles follow the DSH version and are not listed.

`updateBundle(name, version, options)` replaces an updatable bundle with an exact newer version; an older version is refused. The target is first viewed over the same plan as `listVersions`, and a version that is missing, declares no bundle, or whose `engines.dsh` or DSH peers reject the running DSH stops the update at `step: 'check'` with the profile unchanged. With HMR the update removes the installed version, so its plugins stop, then installs `name@version` with `saveExact` and the current selection from the registry that answered. When that installation fails, is cancelled, or installs but cannot start, the target is removed if it stayed and the removed version is installed again from the registry it was installed from in this process, else over the configured plan as its removal asks, and reported as `restore`; a reinstallation that also fails leaves the package uninstalled. A removal or installation that rejects, for example on a lock timeout, is reported as that step's failure. Without HMR the target is installed over the running version and the result reports `restart-required`. `plugin-manager/update-state` announces `checking`, `removing`, `installing`, and `restoring` under the caller's `requestId`; the target's installation streams its logs and accepts `cancelInstall` under the same id, while the reinstallation carries none, so a cancellation cannot stop it.

`installBundle` checks GitHub repositories with `git ls-remote` before starting pnpm, using the profile directory and the installer's Git and proxy configuration. `githubConnectionTimeoutMs` defaults to 5000 ms and limits only this check, not package download or builds. The check disables credential helpers and prompts; only network failures and timeouts stop installation, reporting `failedAt: 'spec-host'` with the existing failure kind and diagnostic log. A stopped installation streams that failure under its `requestId` as the installation's only `plugin-manager/install-log` run, named by the `git ls-remote` command line with any URL user information removed; a timed-out check reports no exit code. The answer's `packageResult` stays a plain result, without the command line. Authentication, repository lookup and other failures are left to pnpm, including its HTTPS-to-SSH fallback. Cancellation and manager disposal stop the check and its descendants. Registry packages, paths, tarballs and other Git hosts skip this check. A reachable repository can still fail during download or bundle validation.

An HTTP(S) Git URL on a host for which pnpm has no HTTPS-to-SSH fallback, that is, any host `hosted-git-info` does not know, such as a self-hosted GitLab, is probed with `git ls-remote` before pnpm starts. The probe uses the installer's Git configuration and credential helpers with Git's terminal and askpass prompts disabled; on POSIX it also has no controlling terminal, so SSH cannot prompt. When HTTP(S) cannot read the repository and `ssh://git@<host>/<path>` can, pnpm installs that SSH URL with the original fragment, and the profile records it. Otherwise the spec is installed unchanged. Each probe is bounded by `gitTransportTimeoutMs`, 5000 ms by default; cancellation and manager disposal stop it. URLs with credentials or a query skip the probe.

Registries are asked in turn. The plan starts at `options.registry`, else the configured `registry` (`null` is the one pnpm's own configuration names), and continues through `fallbackRegistries` while a registry is unreachable, times out, or answers that it has no such package or version, which a mirror not yet synced does. A registry outside the configured set is asked alone, so a private registry never falls through to a public one; pnpm's own registry counts as part of the set only while what it names, read through `pnpm config get registry` before each plan, is npm's own registry or one of the fallbacks, and is otherwise asked alone as a private one. A registry pnpm's own configuration already names is asked once. The lookup runs `pnpm view` with `--registry` and without pnpm's own retries, so a dead registry is reported within `inspectTimeoutMs` and the next one is asked; pnpm prints its refusal as JSON on stdout, which is read like stderr. The install keeps pnpm's retry settings. `registries()` answers the configured set and what pnpm names, for a picker. The [registry Agent Note](../../../.agents/notes/implemented/architecture/2026-09-18-plugin-install-registries.md) owns the rationale.

The browser-safe `@deepseek-ai/dsh-plugin-manager/registry` entry exports `OFFICIAL_NPM_REGISTRY` and `NPMMIRROR_REGISTRY` for consumers that identify those public registries.

`installBundle` accepts a caller-generated `requestId`, under which `plugin-manager/install-log` streams each pnpm run's output and `plugin-manager/install-state` announces `installing`, `cancelling`, and `applying`; a pnpm run that fails without printing streams the diagnostic its log carries, so the details panel is not left empty. `installing` is announced once per registry asked, with the `attempt`'s registry, position, and the plan's length. The install asks the same plan as the lookup, from `options.registry`, running `pnpm add` with `--registry` and restoring the profile files between attempts; it moves on for the failures another registry can change and stops at any other, and at a failure whose error line names the host a git or tarball spec is fetched from, which no registry stands in for; `failedAt` says which of the two the last failed run could not reach. `cancelInstall(requestId)` stops the run and answers `cancelled` only after the Git check or pnpm exited and the files are back, `too-late` once the bundle is being applied, and `not-running` for any other id; the install call then reports `application: 'cancelled'`. A run that fails, is cancelled, or adds a package without a bundle patch restores `package.json` and `pnpm-lock.yaml` as they were; `packageResult.kind` classifies the last run from its exit and output, `registries` names every registry asked, `bundle` names the package a finished run added, and `version` its manifest version, which can differ from the version `inspect` read, for example when pnpm's `minimumReleaseAge` holds back a recent release. `listBundles` carries each bundle's one-liner (the package `description`), the rows its patch declares with their live entries, and the built-in rows it overrides; it lists the profile's own bundles, the bundles the installation supplies, and a selected name without a bundle patch as a `not-bundle` problem, while an unselected plain dependency is left out. A bundle the launcher's `OPTIONAL_BUNDLES` names is `optional`: shipped switched off for the person to turn on, never removable, and selected by no shipped template ([rationale](../../../.agents/notes/implemented/process/2026-09-15-shipped-optional-bundles.md)). Every completed operation emits `plugin-manager/changed`; a patch generation applied outside the manager, by HMR's watcher after a CLI or hand edit, announces nothing, so the page learns of it on its next read.

`waitForInstall(requestId)` lets a client recover a lost response by waiting for the active installation, including its non-cancellable application phase. It returns the same outcome as the original call, or `null` if the request is not active. Completed results are not retained; `null` establishes neither success nor cancellation.

When pnpm 11 blocks dependency scripts, the failed installation reports every pending `allowBuilds` key in the profile under `pendingBuilds`, including keys left by earlier attempts, names the run reported as ignored, and the key pnpm suggests for a git-hosted package it refused to prepare. A key whose git URL carries a credential (a password, or a user name over HTTP(S)) is not recorded, so that installation offers only manual approval. pnpm writes those entries into `pnpm-workspace.yaml` only when it can prompt, so the manager records the reported names itself; a failed run restores `package.json` and `pnpm-lock.yaml` but deliberately not `pnpm-workspace.yaml`. The Web plugin page offers **Allow these scripts and retry**; the tool can grant permission on the user's behalf through `approvedBuilds` on `install_bundle`, after the user approves those scripts in the conversation. The service validates pending names; it does not verify conversation approval. Approval persists by the recorded key in this profile, which pins a git-hosted package to its commit, permits commands with the host user's permissions, and survives another installation failure. Only currently undecided names can be approved; existing denials and wildcard rules cannot be overridden through this action. Approval rejects YAML anchors or aliases inside `allowBuilds`. Retry preserves the original activation choice.

<a id="version-compatibility-and-exemptions"></a>
### Version compatibility and exemptions

An install command that names packages (`add`, or `install` with specs) is checked before pnpm runs: a local path is read from its own `package.json`, and a registry spec is resolved through pnpm's registry lookup for the version its range selects and the `engines` and `peerDependencies` that version declares. An unmet DSH requirement rejects the operation before pnpm runs, so nothing is downloaded and no build script runs; a build approval the caller supplied with the request is recorded before this check and remains. A git or tarball spec needs the fetch itself, so it is judged after installation: the operation then restores the profile manifest and lockfile, reinstalls the restored lockfile (or, when the profile had none, reinstalls from the restored manifest without creating one), and reports whether that recovery succeeded; already permitted build-script effects may remain. A dependency the run did not change never blocks an unrelated operation: it stays installed, the run reports a warning naming it, and profile startup denies it. Installation requests with `enabled: false` are checked the same way. Startup checks run independently; see [App boot](../app-boot/README.md#profiles) for range semantics. Version exemptions do not authorize dependency scripts.

An exemption is an exact `package-name@version` mapped to a list of exact DSH runtime versions in the profile's own `compatibility.json`, beside `package.json` and `cordis.patch.yml`. Writing it changes no dependency, no bundle selection, and no patch layer. Neither plugin upgrades nor DSH upgrades inherit permission. Use `plugin_manager` with `list_version_exemptions` to obtain the runtime version and saved grants, then `set_version_exemption` with `target`, `runtimeVersion`, and `enabled`. Granting also requires `acceptRisk: true`, only after warning the user that incompatible plugins may cause crashes or data loss and receiving explicit permission for that pair. The service checks the acknowledgement and versions, not conversation history. Revocation can remove historical runtime grants.

A grant takes effect on the next composition. A live profile recomposes, so the granted plugin mounts in the running session and the result reports `applied`; a startup-only profile keeps its current entries until restart and reports `restart-required`.

The CLI exposes `dsh plugin --profile <profile> version-exemptions`, `allow-version <package@version> --dsh-version <runtime> --accept-risk`, and `revoke-version <package@version> --dsh-version <runtime>`. A grant prints a risk warning before saving. A compatibility refusal carries the `incompatible-version` code with each refused package's `name`, `version`, `runtimeVersion`, and unmet `requirements`, keyed `engines.dsh` or by DSH peer package name; each surface renders that record itself. The Web page words it through its locale dictionary, and a CLI refusal prints the exact `allow-version` command. Use the tool or CLI to grant an exemption and retry the original operation.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `pnpmCommand` | `pnpm` | The pnpm executable name or path, resolved through `PATH` like the `dsh plugin` command. |
| `inspectTimeoutMs` | `20000` | Bound on one registry lookup an inspection runs, in milliseconds. |
| `githubConnectionTimeoutMs` | `5000` | Deadline for the GitHub repository check before installation, in milliseconds. |
| `gitTransportTimeoutMs` | `5000` | Deadline for each HTTP(S) and SSH access probe of a self-hosted Git repository before installation, in milliseconds. |
| `registry` | pnpm's own | The registry lookups and installations ask first, as an http(s) URL; absent, the one pnpm's own configuration names. |
| `fallbackRegistries` | `['https://registry.npmmirror.com/']` | Registries asked in turn, as http(s) URLs, while the one before is unreachable or holds no copy of the package; pnpm's own registry joins the order only while it names npm's own registry or one of these. |
| `outputBytes` | `16384` | Maximum pnpm diagnostic bytes returned per operation; the full output remains in the returned log path. |
| `lockWaitMs` | `120000` | Maximum time in milliseconds to acquire the profile write lock. |
| `versionListLimit` | `20` | How many of the newest versions above the installed one a version listing reads and returns. |
| `versionLookupConcurrency` | `4` | How many single-version registry lookups a version listing runs at once. |
| `idleTimeoutMs` | `600000` | Maximum time in milliseconds a service package run may capture no output before the manager terminates it; a run with inherited descriptors (`dsh plugin`) is never bound. |
| `detailMaxBytes` | `1048576` | Largest bundle detail document, and largest locale file read for one, in bytes. |
| `detailImageMaxBytes` | `5242880` | Largest image served beside a bundle detail document, in bytes. |
| `detailFetchTimeoutMs` | `15000` | Deadline of one npm file CDN request for an offered bundle's detail document. |
| `detailNpmFileSources` | `['jsdelivr', 'unpkg', 'npmmirror']` | npm file CDNs offered bundles are read from, in order; a read's `npmFileSources` moves the CDNs it names first. |

<a id="bundle-detail-documents"></a>
### Bundle detail documents

`readBundleDetail(name, language, { npmFileSources? })` reads the long description that a bundle's page in **Plugins** shows, for a bundle `listBundles()` lists: the locale `meta.detail` file, otherwise the README, as steps 1 and 2 of the [document order](../../util/plugin-detail/README.md#document-order) define them. Without either, the result is `{ status: 'none' }`; the repository a bundle declares is not read. `npmFileSources` names npm file CDNs to ask first for an offered bundle, in order; configured CDNs it omits follow, and CDNs that `detailNpmFileSources` does not list are not asked. A found document carries its `origin` (`locale` or `readme`), its `path` inside the package, and its Markdown without a leading YAML front matter block.

An installed bundle is read from its directory, without network access. An official bundle the installation offers before it is installed is read from the npm file CDNs at its offered version; one offered as a development link has no document. Nothing is cached, so a reinstalled bundle shows its own document.

`GET /api/plugin-manager/detail-file?bundle=<name>&document=<path>&path=<destination>`, with `&sources=<cdn>,...` to ask those CDNs first, serves an image beside a bundle's document to authenticated owner connections. The destination is relative to the document, or to the package root when it starts with `/`. Only PNG, JPEG, GIF, WebP, AVIF, and SVG files inside the package are served, with `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff`, and `Cache-Control: no-store`; another path or an unlisted bundle answers 404.

Failures: `plugin-manager/unknown-bundle` for a bundle `listBundles()` does not list or whose directory cannot be resolved, `plugin-manager/invalid-language`, and `plugin-manager/detail-unavailable` with `reason` `too-large`, `network`, or `invalid` for a malformed locale file or `meta.detail`, or a named file that does not exist. The image route answers them with 404, 413, 502, and 400.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The service and `dsh plugin` share the package operations in [operations.ts](src/operations.ts). The launcher supplies the current profile; [DSH HMR](../hmr/README.md) serializes module reloads, file watching and management writes. Each configuration refresh re-reads bundle selection and patch layers, updates the original root Include, and awaits removed plugin resources as well as the remaining Loader tree. CLI and service operations share the profile manifest writer lock to prevent concurrent package and manifest writes. HMR does not acquire that lock. Pnpm runs outside the HMR queue; installation selects the bundle after pnpm succeeds, while removal deselects and unloads the bundle before pnpm runs.

Without HMR, installing a new package, enabling a bundle and a successful removal publish the profile's runtime resolution; with HMR, every operation leaves publication to [HMR](../hmr/README.md)'s recomposition, which removes dropped mappings after their plugins stop. Shared dependencies may pass to another bundle's declaration when their normalized directory and scope stay unchanged. Without HMR, a deselected startup bundle still runs: while any such bundle is absent from the saved selection, subsequent package operations retain the entire current table and report `restart-required`. Other new installations and removals of non-running bundles can still publish without HMR; activation waits for restart. With HMR, `installBundle()` refuses a package that is already installed with `already-installed`, before pnpm runs, when the spec names it: a registry name, a local directory, or the git or tarball spec its dependency was saved with. A package that cannot be removed, such as a bundle carrying plugin management, therefore cannot be installed over with HMR. Installing another version is a removal and an installation, so the previous version's plugins stop, its modules are evicted and its mappings removed before the new one is installed; the Web page's Update for an Official plugin does both. A git or tarball spec whose package is known only after pnpm ran can still install over an installed package: without HMR it reports `restart-required`, and with HMR the recomposition replaces the running plugins whose loaded files changed. A replacement that fails to import or start reports `failed` with the activation diagnostic, which names the import error; the previous version no longer runs, and every later operation imports it again, so it starts once its files or dependencies are corrected. An unchanged import failure is a warning of later operations; a changed one fails them. A publication the runtime resolution rejects, because an installed package now resolves to another directory or a mapping of the DSH installation changed, leaves the composition as it was, after stopping and starting again the rows it would drop, and reports `restart-required` with `package-moved`. Disabling or removing a bundle evicts the modules of the packages whose mappings it drops. Every `restart-required` result carries `restartReason`: `no-hmr`, `package-moved`, or the [HMR pending reason](../hmr/README.md) of a changed module that loads only after a restart, unless the operation reports `overridden` ([decision](../../../.agents/notes/implemented/architecture/2026-09-30-profile-package-refresh-and-manifest-invalidation.md)).

A service run whose captured output stays silent for `idleTimeoutMs` is terminated, reports `timedOut` alongside its exit status, is classified `timeout` whatever status the signal left behind, and is not retried on the next registry, which bounds how long one operation can hold the profile lock; the CLI inherits the terminal, captures no output, and stays unbounded for its operator to interrupt. A run completes when its process exits, and the pipes then drain under a bounded grace period, so a descendant that inherited them cannot hold the operation open. The diagnostic file is closed before the call settles, including preparation or spawn failures. A terminated run stops its whole process tree and waits for it, because a lifecycle script outlives the pnpm process that started it (issue #4981). Each operation records the pnpm run it starts in `.plugin-manager/run.json` and removes the record when the run ends. A lock whose holder process exited is taken over by the next writer, but that process's pnpm tree can still be running, so an operation that finds a record waits up to five seconds for the recorded run to stop and otherwise fails with a diagnostic that names the process and the record, without running pnpm. Dependency-only changes do not trigger configuration reloads.

Results contain the last attempted stage, target, saved-state change, application status and error codes. Web dictionaries render management text; pnpm and Loader diagnostics remain unmodified. Unrelated pre-existing inactive entries return warnings; new or changed failures and inactive explicit enablement targets fail the operation. A failed or cancelled package run, or failed bundle validation, restores the manifest and lockfile snapshotted before pnpm ran ([rationale](../../../.agents/notes/implemented/architecture/2026-09-15-guided-plugin-installation.md)); later failures retain saved changes as described in [Failure behavior](#failure-behavior). Installations are tracked by request id until their call settles, so a cancellation names one run and joins its settlement without taking the profile lock. The CLI inherits authentication variables and terminal descriptors; service operations use a scrubbed environment and captured output.

The `plugin-manager/operation` event correlates each service invocation with its start and observed result, or an unknown outcome when an exception escapes result construction. Installation targets retain only parsed registry package names; bundle toggles and removals require the exact package name without a version range or surrounding whitespace. Plugin targets retain only known entry IDs. Recorded targets need not be installed; operations that require their files still refuse missing packages. Version-exemption records retain the validated package name and exact exemption version, not the currently installed version. If either the package or runtime identity is invalid, target is null and version is omitted. Exemptions reuse reason `bundle`, stage `enable`, and the exemption's `enabled` value; when the exemption version matches the installed version, their records cannot distinguish an exemption change from a bundle toggle. Versions describe request-time observations before locking or the resolved installation; invalid or oversized metadata is omitted without losing the operation. Platform refusals retain the `unsupported-platform` error code. Raw specs and error text are excluded. Subscribers run independently without delaying management; synchronous throws and asynchronous rejections do not starve later subscribers or change the result. Direct CLI package operations do not emit this service event.

The `@deepseek-ai/dsh-plugin-manager/diagnostic` entry supplies Desktop Host and shell readers with run IDs, operation records and a parser that retains only whitelisted fields. Malformed or oversized records are rejected; readers report omissions and truncation. The shell accepts records only for the run ID announced by its Host. Diagnostic consumers own persistence and delivery limits; missing records never imply successful operations.

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

The [`plugin_manager` tool](../../../docs/tool-catalog.md#deepseek-aidsh-plugin-manager) lists plugin entries and bundles and performs profile-wide changes. Its results include saved-state changes, application status and package diagnostics. A change result that is not plainly applied adds `nextStep`, a sentence derived from its application status, refusal code, package-manager failure kind or restart reason that says what the model does next or tells the user. Management operations do not inject messages into Agents.

#### Token effect

The tool declaration is present when its consumer is mounted; each invocation adds its returned inventory or change result.

#### KV Cache effect

Tool results append to the transcript. Enabling or disabling other tools can change subsequent tool declarations and their cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Web approves the entire displayed pending group; it has no per-package selection.
- An approved git key stays in `pnpm-workspace.yaml` after the plugin moves to a newer commit; nothing removes stale approvals.
- pnpm verifies every lockfile tarball URL against its default registry when a command changes the lockfile. After a package was installed from another registry, installing a different package with the default registry, or removing that package after a restart, can fail with `ERR_PNPM_TARBALL_URL_MISMATCH`.
- An update saves the target as an exact version, and a reinstallation after a failed update saves the previous version exactly, even when the profile had saved a range. With HMR the reinstalled bundle joins the end of the selection, which can change which bundle's configuration takes precedence.
- An update runs its removal and its installation as two profile operations; another operation can run between them.
- The Git transport probe keeps the parent console on Windows, so an SSH host-key or passphrase prompt can appear in the launching terminal until `gitTransportTimeoutMs`. On POSIX a host missing from `known_hosts` fails the SSH probe, so installation stays on HTTPS until the host key is accepted once, for example with `ssh -T git@<host>`. A credential-helper dialog or ssh-agent confirmation, such as a Touch ID or `ssh-add -c` dialog, that takes longer than the deadline counts as a failed probe, and an HTTPS probe that times out lets a reachable SSH form be saved to the profile. A private repository waits up to twice `gitTransportTimeoutMs` before pnpm starts. The SSH form always uses the `git` user and SSH's default port; other SSH endpoints need a `url.<base>.insteadOf` rule. When both probes fail, the diagnostic is pnpm's HTTPS failure; the SSH probe's reason is not reported.
- A newer version whose dependencies need new build-script approval fails to update and is reinstalled at the previous version; approve its scripts through an ordinary installation after removing the package.
- Package replacements require restarting the process without HMR. A package relinked outside Plugin Manager while it is still installed waits for a restart.
- Startup-only profiles cannot remove packages used to start the current process; stop it and use `dsh plugin`.
- The manager cannot disable its own management components, change another profile, or edit an agent preset's composition.
- A failed removal may leave dependencies partially changed, and a failed or cancelled installation can leave downloaded files under `node_modules` or the pnpm store. Inactive dependencies with missing files remain removable. Diagnostic logs remain under the profile's `.plugin-manager/logs` directory.
- Management results describe Host activation. Browser synchronization failures appear separately in the Settings plugin list.
- Desktop package operations remain owned by the Desktop shell.

<a id="failure-behavior"></a>
### Failure behavior

Failures preserve completed steps and report the actual remaining state. Profile dependencies without valid bundle metadata remain visible and removable, with enablement unavailable. If `dsh plugin` installs a bundle whose platform declaration excludes the Host, automatic activation returns exit code 1 and a diagnostic naming the package. Installed dependencies remain, and bundle selection stays unchanged. Use a supported Host or remove the dependency with `dsh plugin --profile <name> remove <package>`.

| Failed operation | Handling |
|---|---|
| Install: pnpm or bundle validation fails | Restore `package.json` and `pnpm-lock.yaml` as snapshotted before pnpm ran; files pnpm downloaded may remain. Report installation failure. |
| Enable: saving selection or loading fails | Keep the installed dependency and any saved selection. Report enablement failure; allow repair, disablement or removal. |
| Resolution publication after a successful package operation fails | Keep completed disk changes and the previous runtime table. Report `application: 'failed'` with the publication diagnostic; pnpm's zero exit code does not mean publication succeeded. |
| Remove: any step fails | Stop at the failed step. Preserve completed changes, retain remaining dependencies for retry, and report removal failure. Do not re-enable the bundle. |

Installation finishes after pnpm and bundle validation succeed; subsequent publication or enablement failure does not undo installation. Removal proceeds in order: remove the bundle from `dsh.profile.bundles`, unload its runtime contributions, run `pnpm remove`, then publish runtime resolution unless a deselected startup bundle still runs without HMR. `pnpm remove` runs with the registry this manager last installed the package from in the running process, because pnpm verifies lockfile tarball URLs against its default registry; a package installed before the process started is removed with the registry an installation asks first. A failed step prevents subsequent steps; publication failure after removal does not restore deleted packages. A selected name that neither the profile's dependencies nor the installation holds, such as a retired bundle, is also removable; its removal stops after deselection and runs no pnpm.

Restoration rewrites only the two snapshotted files; user-authored patch configuration, application data, diagnostic logs and files pnpm downloaded remain untouched, and the next package operation prunes packages no manifest references.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
