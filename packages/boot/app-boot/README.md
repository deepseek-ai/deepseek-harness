---
description: "Shared Loader boot support for dsh profiles and the temporary Python SDK runtime: environment layers, patches, diagnostics, and configuration preview."
kind: "package-library"
---

# @deepseek-ai/dsh-app-boot

English | [中文](README.zh.md)

## Summary

`dsh-app-boot` is the shared Loader boot library behind `dsh` profiles, including the CLI packaged by the Python runtime wheel. It loads environment layers, composes profile bundles and patches, boots every plugin, and returns the running app or identifies the failed plugin and cause. Product applications use the `dsh` launcher instead of publishing separate bins; direct-config helpers remain only for lower-level embedders and tests. You can preview the effective configuration before booting, configure HMR through profile YAML, and let a terminal-owning app restore its terminal before a fatal exit.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Starting an app with this package is a small, explicit entry point: you give it a config file and it runs the whole boot. This section covers what you can do and what you get; the helper calls behind each outcome are documented in the folded implementation section.

### When to use it

Use it when implementing the shared `dsh` launcher or embedding its lower-level boot helpers. Product features belong in profile bundles instead of new application bins; code that only adds plugins to an already-running app mounts those plugins directly.

### Starting the app

You give your entry point a config file, and the process starts the whole app: it loads your environment layers, applies patches and profiles, boots every plugin, and returns once the app is running. In replay mode it boots the sibling `cordis.snapshot.yml` instead, so a recorded session reproduces identically. The smallest entry point is two calls:

```text
installFailLoud('dsh')
const ctx = await boot('dsh', resolveConfigPath(argv[2], process.env.DSH_SNAPSHOT))
```

With that entry point, startup keeps every plugin that can activate. An enabled failed plugin produces a labelled warning. A failed required entry makes startup dispose the whole app and exit nonzero; required ids absent from a profile and disabled required entries do not affect startup. The global required list covers shared Agent execution, application endpoints, and Web bootstrap/transport: `agent-loop`, `webserver`, `modules`, `connection`, `headless-runner`, `acp`, and `sdk-jsonrpc-server`.

<a id="profiles"></a>
### Profiles

Import profile and bundle declaration types from [`@deepseek-ai/dsh-package-manifest`](../../util/package-manifest/README.md). App-boot adapts `DshPackageManifest` to `ProfileManifest` with optional package identity because local profiles need no published version. App-boot owns profile loading, JSON validation, and resolved runtime data.

A profile is how one dsh installation ships different app surfaces: `web`, `headless`, `acp`, `sdk`, and `sdk-minimal` start distinct compositions from the same launcher. A profile lives at `$DSH_HOME/profiles/<name>` and combines installable bundles with its own `cordis.patch.yml`. The YAML composition enables or disables HMR. The shipped `web` template uses live reload, while the other shipped templates apply patches only at startup. `sdk-minimal` names only its standalone bundle; the other templates retain base-plus-mode stacks. `dsh --profile <name> --from-default-profile <template>` creates a custom profile at a new non-shipped name from one shipped template, while `dsh plugin` initializes a base-backed profile and manages its installed bundles. A missing bundle or one without a patch declaration fails startup loudly. Application-owned npm projects, such as Electron's reserved Desktop profile, use `loadProfileDirectory` to load an already initialized directory without exposing it through CLI profile lookup.

Your machine-local preferences also live in the Harness home:

- **`.env`** — your ordinary environment layers: the invoking directory's file outranks the Harness-home file, and both sit below the inherited environment. Variables that decide how the process starts (`PATH`, `DSH_*`, `XDG_*` and similar) are rejected from files: export them instead. The four proxy names (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`) are accepted from the Harness-home file only, never from the invoking directory's, which arrives with a clone. For a non-product bin that just wants one directory's `.env`, a missing file is fine and an unloadable one prints one labelled warning line.
- **`cordis.patch.yml`** — your tweak layer, applied after every bundle layer (per-profile first, then the home-level file, which therefore outranks it): replace one entry's whole config (restating the fields you keep), insert new entries, or interpolate `!!js` expressions at boot. A patch naming an entry that does not exist prints a stderr warning; an empty or comments-only file fails boot — disable the layer with `[]` instead.

The enabled `dsh-hmr` plugin watches the profile manifest and both user patch files, re-reads the ordered bundle layers, and applies the [reload failure policy](#startup-and-reload-failures). [DSH HMR](../hmr/README.md) serializes these reloads with [Plugin Manager](../plugin-manager/README.md) configuration writes; package operations run outside its queue. The launcher does not install HMR or watchers; disabled or absent HMR means changes require restart.

Inserted plugin names may be absolute filesystem paths, file URLs, or package specifiers. Patch loading converts absolute paths and patch-relative `./` or `../` paths to file URLs within `insert` rows and their nested groups; existing-entry name assertions and replacement `config` values remain literal.

Before mounting profile rows, the `dsh` launcher computes one immutable package-resolution generation from the installation and ordered bundle dependency graphs. The default link mode materializes the existing shared and profile-owned fallback links, so supported launch behavior stays unchanged. Internal callers and test harnesses can instead install the generation through Node's ESM and CommonJS resolvers in runtime mode, or materialize and verify the same generation in dual mode.

### Previewing the effective configuration

Before you boot, you can print the exact configuration the app will mount: the dump shows the composed entry list with `!!js` expressions verbatim, grouped under comments naming each source file and the patch layers that changed it, as one loadable YAML document. Patches that match no row are reported with their layer label; a missing, unparsable, or invalid config fails the dump.

<a id="startup-and-reload-failures"></a>
### Startup and reload failures

Profile reconciliation returns diagnostics for unchanged inactive entries without failing an unrelated mutation. A new inactive entry, a changed configuration or fiber, or a changed diagnostic fails reconciliation; removed fibers must still finish disposal. Explicit enablement targets must activate even when their failure predates the operation.

After the Loader settles, app-boot reports optional failures as warnings and rejects startup if an enabled required entry cannot activate. In the table, stopping startup means disposing any mounted plugins and exiting nonzero without reporting readiness; continuing keeps successful plugins running. Later configuration HMR does not repeat the required-startup audit and does not roll back the whole update.

| Failure pattern | Optional entry at startup | Required entry at startup | Later configuration HMR |
|---|---|---|---|
| Root config or required overlay is missing, unreadable, malformed, or contains invalid entries | Stop startup | Stop startup | Malformed or invalid live patches are rejected without changing the running configuration; a valid edit applies |
| Module import fails or module evaluation throws | Warn; continue | Stop startup | Report the error; keep successful siblings; a corrected import can activate |
| Plugin config schema validation fails | Warn; continue | Stop startup | A new entry stays inactive; an existing entry retains its prior instance and config; a valid correction applies |
| Config `!!js` evaluation throws | Warn; continue | Stop startup | Report the error; keep successful siblings; a valid correction can activate |
| `disabled: !!js` evaluation throws | Warn; continue | Stop startup | Report the evaluation error rather than treating the entry as disabled; a valid correction can activate |
| Synchronous `apply()` throws | Warn; continue | Stop startup | Report the error; keep successful siblings; corrected config can activate |
| Asynchronous `apply()` throws | Warn after settlement; continue | Stop startup after settlement | Report the error after settlement; keep successful siblings; corrected config can activate |
| An injected service is unavailable | Warn; continue while the entry waits for its dependencies | Stop startup | Keep the entry waiting; adding the missing provider can activate it |
| HTTP port binding fails | Warn; continue without that endpoint | Stop startup | Keep the process running without the failed endpoint; corrected config can restore it |
| Detached asynchronous work outside the `apply()` return Promise produces an unhandled rejection | Fatal: dispose the app and exit nonzero | Fatal: dispose the app and exit nonzero | Fatal: dispose the app and exit nonzero, regardless of entry id |
| Entry is absent or explicitly disabled | Ignore it | Ignore it | Do not activate it; no required-startup audit |

The required list above includes `modules` and `connection`; Web startup cannot succeed when either enabled entry fails. Failure of an optional provider can also prevent a required consumer from activating. Schema rejection before an existing entry updates is not a transactional rollback of sibling changes.

The [Web process matrix](../../../apps/cli/tests/profiles/web/tests/web-failure-matrix.expected.e2e.ts) and [startup acceptance](../../../apps/cli/tests/profiles/web/tests/web-best-effort-startup.expected.e2e.ts) verify these outcomes through the shipped Web profile; [app-boot tests](tests/app-boot.spec.ts) also exercise root Include failures.

If your app owns the terminal, it can hand the terminal back before the process exits, so your shell is never left in raw mode. The handoff is bounded: a stuck cleanup delays the fatal exit but never cancels it.

### Telling the agent where the harness lives

When your app boots a model-backed agent, you can tell the agent where the DSH implementation checkout lives: it learns that path and that it must not infer the working directory from it — it should use `pwd`. The instruction appears once near the top of the system prompt. Apps without a system prompt service skip it; in development, reloading the system prompt drops it until the next boot.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the outcomes above are realized and points at the code that realizes them; everything here is developer-facing and not needed to use the package.

### Design notes

- **Profile launch data.** `ctx.profileContext` contains only profile locations, startup bundle names, parsed invocation overlays and the telemetry opt-out value. `readProfilePatches()` composes the supplied startup profile or reads current files at those locations; callers schedule and apply the result.
- **Process-local module resolution.** Runtime and dual modes install one generation on Node's internal ESM and CommonJS resolvers before profile rows mount; link mode leaves both resolvers unchanged. Node still owns exports, conditions, subpaths, module caches, and error codes; routed ESM failures report the original importer instead of the internal lookup anchor. `ctx.pluginPackages` exposes package metadata from the same generation without recording Entry imports; an installed generation is authoritative even for a miss, while low-level embedders that install the service without one retain native lookup.
- **Two Loader builtins.** `mountRootInclude` registers `cordis:include` and `cordis:group` as Loader builtins: a group row gives one `isolate` realm to a provider and its consumers together, and an agent preset outside this workspace cannot resolve `@deepseek-ai/cordis-plugin-group` by name. Both load through the ambient module pipeline rather than the included tree's own specifier resolution.
- **Consumer-owned strictness.** Ordinary Loader groups keep successful siblings. App-boot applies the global required-entry policy after initial settlement; agent presets and dynamic multi-entry compositions own and dispose their separate generation when they require all-or-nothing setup. App-boot reads failed fibers to report their recorded errors and coalesces duplicate Loader rejection notifications through one process checkpoint.
- **One fallback generation.** The installation-first and ordered-bundle breadth-first traversal produces both the runtime table and the retained disk materializer. Runtime mode creates no resolution links and ignores stale projections at their former lookup positions. External bare targets selected by package `imports` use the same package order, while Node retains mapping, conditions, and exact target resolution. Link mode materializes the same table; dual mode also compares Node's disk result with the table. A complete successor may add package names atomically, while changing or removing an existing mapping requires restart.
- **Application-owned profiles.** Link mode projects missing installation and bundle packages inside the profile without writing a shared Harness-home fallback. Runtime mode supplies the same installation and bundle generation without creating links. Package operations remove only profile links owned by dsh; pnpm-managed entries remain untouched.
- **Owned Workers.** Worker build banners import `@deepseek-ai/dsh-app-boot/worker/profile-resolution-bootstrap` before bundled business code. Each Worker installs the structured-cloned generation in its own isolate. The bootstrap bundle has no static package imports. Source Worker entries retain their self-contained dependency closure, and third-party Workers receive no injection.
- **Update completion.** App boot observes restart failures through the `internal/update` waterfall. Live patch reloads wait for the tree's fibers before auditing activation; `Fiber.update()` and `Entry.update()` alone do not establish restart success.
- **One rejection checkpoint.** `assertEntriesActivated` keeps the exact reasons it folds into the boot diagnostic visible through the next process rejection checkpoint, so `installFailLoud` coalesces Loader's duplicate notification while unrelated unhandled rejections remain fatal.
- **Two-stage failure labels.** `boot()` distinguishes `host preparation failed` — `prepare` threw before any config-tree entry mounted — from `plugin tree failed to load`, and appends the deepest plugin error's stack. Plugin diagnostics retain nested causes and aggregate member failures; cyclic causes stop traversal without replacing the original error.

### Helper behavior

The exports each own one stage of the boot: config resolution and snapshot replay, layered environment loading, fail-loud reporting, activation auditing, patch parsing, root-include mounting, config dump rendering, profile composition, and the harness-source section. Per-export contracts live in the code, not this README — see [`src/index.ts`](src/index.ts) and [`src/profile.ts`](src/profile.ts).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Boot helpers: config resolution, environment loading, fail-loud guard, activation audit, patch parsing, config dump, harness-source section |
| [`src/profile.ts`](src/profile.ts) | Profile discovery, initialization, bundle resolution, module fallback |
| [`src/profile-plugins.ts`](src/profile-plugins.ts) | Installed dependencies, bundle activation policy, and manifest updates |
| [`src/profile-resolution/`](src/profile-resolution/) | Runtime resolver, package-metadata service, and built Worker bootstrap |
| — | No runtime invariant companion is published; one registration owns each resolver generation, and dual mode compares the independently materialized result at resolution time. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared boot mechanics to the composition model and the decision evidence behind it.

- [Cordis primer](../../../docs/cordis-primer.md) — Loader, `!!js` config expressions, and include/group semantics.
- [dsh app](../../../apps/cli/README.md) — the `dsh` bin that consumes these helpers.
- [dsh-cmdline](../cmdline/README.md) — the launcher-to-app command-line handoff the bins use.
- [Profile bundles](../../bundle/README.md) — installable patch layers composed into `dsh --profile`.
- [dsh-home-paths](../../util/home-paths/README.md) — the Harness-home resolver (`resolveDshHome`).
- [Configuration source ownership](../../../.agents/notes/implemented/architecture/2026-08-04-configuration-source-ownership.md) — why a discovered file may not decide bootstrap behavior.
- [Profile plugin bundles](../../../.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.md) — the profile and bundle composition design.
- [User-patch HMR tests](../../../.agents/notes/implemented/testing/2026-09-09-user-patch-hmr-test-delivery.md) — ownership of live-patch behavior and native filesystem delivery.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the loaded plugin tree, which alone contributes model context; the one export that adds model-visible text, `addHarnessSourceSection`, does so only when a consumer calls it after boot.

#### KV Cache effect

Boot itself changes no request prefix. `addHarnessSourceSection` places its source path after first-party reusable instructions, so different checkouts leave those preceding bytes unchanged when tools and configuration match. Provider cache reuse is not guaranteed.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe when this boot library is a poor fit or needs special care. They are current package constraints, not a task backlog.

- **Runtime resolution depends on Node internals** — supported Node versions require the native builtin-access addon and executable compatibility coverage. Only built Harness-owned Workers receive the generation bootstrap; third-party Workers and custom `vm` linkers keep native resolution.
- **Snapshot replay swapping is basename-specific** — only a config ending in `cordis.yml` or `cordis.yaml` maps to the sibling `cordis.snapshot.yml`; custom config names require caller-managed selection.
- **Environment discovery is launch-scoped** — `loadLayeredEnv` reads only the invocation directory and Harness home once; it does not search parents or follow a workspace selected later. `loadEnv` remains the one-directory helper for non-product bins.
- **A user patch replaces the whole matched config** — an id-targeted patch does not deep-merge, so a profile override restates the bundle fields it keeps.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Open: config dump stability

`renderConfigDump` output is a loadable YAML document whose `# ==` source comments and `!!js`-verbatim rendering serve the `--dump-config` diagnostic. Nothing promises byte stability across package versions; decide whether the dump becomes a serialization contract before anything consumes it programmatically.

</details>
