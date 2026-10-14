# Agent Note: Replace plugins whose loaded package files changed during profile recomposition

Status: implemented

English | [中文](2026-10-01-replace-changed-package-modules-on-recomposition.zh.md)

## Problem

Node caches an evaluated module by file URL. A profile installs packages with pnpm's hoisted layout, so a package lives at `node_modules/<name>` whatever its version. Overwriting, upgrading or reinstalling it keeps every file URL, and a later import or Loader entry restart returns the cached module of the previous version. The [package-refresh Note](2026-09-30-profile-package-refresh-and-manifest-invalidation.md) refreshes runtime resolution and package configuration but leaves this module cache; Plugin Manager therefore reported overwrites as `restart-required`, and a reinstall at the same path after removal reported `applied` while the previous version kept running. A `link:` development package hits the same cache whenever its build output changes, unless its directory is listed in HMR's source watch roots.

## Decision

### One recomposition path

`Hmr.reconcileProfile()` is the profile recomposition used by HMR's profile watches and by Plugin Manager; the Config Editor still recomposes through app-boot directly. It runs inside `runExclusive()`. Plugin Manager only edits profile files and runs pnpm, and refuses to install over an installed package it can name before pnpm runs; another version is a removal and an installation, each with its own recomposition. The steps of a recomposition are:

1. Read the profile patches and compare loaded modules below the profile directory and its linked package targets with disk.
2. Plan the replacement as below; a patch read or comparison failure throws or is reported before any module changes.
3. Evict the replaceable changed modules and their importers. A changed module whose importers reach the process entry point's static graph or a plugin that no Loader entry owns stays loaded with its importers; the other changes proceed.
4. Stop the Loader entries running the replaced plugins by deleting their runtimes, so the Loader does not record them as disabled.
5. Call app-boot's `recomposeProfile()` once with the entries that ran before the stops. It records the activation state, stops the rows the generation no longer lists by removing them from their groups, publishes the runtime resolution, runs the compatibility preflight against the published packages, and applies the generation. The Loader imports the current files when it starts an entry: rows the generation keeps start once with the new code and their new configuration; rows it disables, refuses or removes stay stopped and never run the new code; an entry it inserts links against the current files. Stopped entries the update did not try to start, below an unchanged Include or outside the profile composition, start afterwards; an entry whose import failed during the update is imported once more. Activation is judged: a stopped entry that failed afterwards fails the operation, while an entry waiting for a service is a warning, since it starts once a provider appears. If no generation applied, the published resolution and the stopped rows are restored, and the stopped entries start again.
6. Evict the loaded modules below the directories of the mappings the recomposition dropped, so a removed or deselected package, including its dynamically imported dependencies, is imported afresh when it returns. A bundle switched off while its package stays mapped keeps its unchanged modules.

### Detecting changed modules

[`ModuleFiles`](../../../../packages/boot/hmr/src/module-files.ts) records inode, size and modification time for the loaded ES and CommonJS modules below the profile directory and the real directories of its linked packages. Modules of the dsh installation are outside this scope. Change time is excluded: pnpm imports packages by hard link from its store, and adding a link elsewhere changes a loaded file's change time without changing its content. Records are taken at application readiness, after each recomposition, and for modules a source reload evaluated again. A recomposition records the identities it read before replacing anything, so a write during the recomposition stays detectable; modules first loaded during it are recorded after settlement to avoid an unnecessary restart during the next installation. An edit between first evaluation and that record can be missed; the timestamp fallback still covers modules first loaded outside recomposition. If the readiness observation fails, the fallback starts at HMR construction time, not the Unix epoch. A module is stale when its file disappeared or its identity differs. A module first loaded after the last recording has no record; it is stale when its file was modified at or after that recording, less a 2-second filesystem timestamp resolution, so a reinstall between loading and the next comparison is not missed. Version numbers are not consulted: lockfiles record no content identity for `file:` and `link:` dependencies, and file identity covers registry, tarball, directory and link installs alike.

### Replacing them

A stale module whose importer closure reaches the process entry point's static graph, including installed packages, stays loaded and is reported. The remaining stale modules and their static importers, across ES module links and CommonJS `require` children, form the affected set, and every manifest from a stale file up to its profile root or linked target expires through `PackageManifests.invalidate()`. The whole affected set is evicted without a backup before recomposition, so every entry that imports during recomposition reaches the current files. A plugin registered outside a Loader entry has no owner that can start its replacement, so the changes its modules import stay pending; plugins are read from the ES module namespace and from cached CommonJS exports, so a CommonJS plugin registered through `require` keeps its cache too. HMR imports no replacement code itself, so admission is the Loader's ordinary activation: a disabled, removed or refused row never evaluates the new module, and dynamic `disabled` expressions and nested Includes are evaluated as at startup. Every recomposition imports again each enabled entry whose last import failed, after expiring the package configuration below the profile roots and evicting the modules whose links or evaluation failed, which Node keeps cached, so a corrected file or a later-installed dependency takes effect without a restart. A plugin counts as owned only when an affected plugin's own Loader entry fiber starts it; a changed plugin another plugin registers through a dynamic import stays pending. Unchanged dependencies of a replaced plugin are not re-evaluated, so shared libraries keep one instance. Source reloads through `partialReload()` keep their own in-place replacement with rollback.

`reconcileProfile()` returns `pending`, each stale module that loads only after a restart with its reason (`host-module`, `unmanaged-plugin`, or `module-comparison` when planning failed). Pending modules stay stale, including modules first loaded after the last recording, so the next recomposition retries them. A module first loaded during a recomposition whose file was modified after the comparison also stays stale: activation may have evaluated it before that write. A failure while listing or comparing modules keeps the previous records and sets the profile-wide `restartReason: module-comparison`, even without known module URLs. Neither prevents recomposition. An activation failure, including a replacement that fails to import, is thrown with the Loader's import error; an unchanged failure is returned as a warning by later recompositions. Plugin Manager reports a thrown failure as `failed` with that diagnostic, and turns `pending` into `restart-required` with its `restartReason`, unless the operation reports `overridden`. The Web page localizes the reason, and the agent tool derives a `nextStep` sentence from it, so no surface parses a diagnostic string.

The [packed worker loader](../../../../packages/experimental/webworker-runtime/src/module-system/module-loader.ts) stores evaluated modules in a private map and its `require` exposes no cache. HMR cannot replace them through Node APIs and reports a restart requirement. Native Node still exposes its caches when using asynchronous module hooks.

### Plugin Manager and runtime resolution

Plugin Manager refuses to install over an installed package it can name before pnpm runs, so a new version or location is a removal and an installation: the removal stops the plugins, evicts their modules and drops the mappings, and the installation maps the package afresh. Runtime resolution accepts a retained profile mapping whose version changes while its normalized directory and scope stay, as a shared dependency upgraded by another installation does, and rejects one that moved to another directory. A linked root may point to another directory; a file Node's cached link real path selects below the previous target, for an importer outside it, is relocated below the current one. Rejected publications, including changes to installation mappings or local overrides, leave the resolution and the composition unchanged and report `restart-required` with reason `package-moved`.

## Alternatives considered

**A separate package-replacement call from Plugin Manager.** Plugin Manager knows which package it installed, but not which Loader entries import it, and row additions, removals and configuration changes in the new bundle patch must apply in the same step. A second operation would split one profile change into two transactions with an undefined order. Recomposition already reads the new profile; comparing loaded files there covers Plugin Manager, CLI installs followed by a recomposition, and link builds.

**Compare package versions from the profile manifest or lockfile.** The profile manifest stores specs, not resolved versions, and `pnpm update` can change a version without changing it. Lockfiles carry no content identity for `file:` and `link:` dependencies, and a same-version reinstall of a tarball changes content without changing the version.

**Let app-boot call HMR from inside its recomposition.** Hooks for the steps before applying and before judging would split the order of one operation between two owners. HMR instead stops everything it replaces first and passes the stopped entries to one app-boot call.

**Expose the recomposition's stages to HMR.** Separate calls to record activation, prepare after publication, apply, restore and drop mappings let HMR insert its stops between them, but they leave callers ordering obligations that the types cannot express. Stopping before the call costs a restart of the stopped plugins when preparation fails.

**Publish twice, keeping the dropped mappings while the generation applies.** A temporary table with both the new and the dropped mappings lets one Loader update stop and start entries, but it is a third generation that must stay recomputable when the update fails. Stopping the dropped rows first lets one publication follow them.

**Overwrite an installed bundle in one operation.** Stopping the bundle before pnpm and starting it afterwards, or detecting moved packages from the loaded module files, keeps one call for an upgrade, but needs a restart path for every pnpm failure, a selection restored in its order, and a release rule for moved directories. Refusing the overwrite leaves a removal and an installation, which the existing operations already run in this order.

**Preload the replacement and keep the previous plugin when it fails to load.** HMR would import new code before stopping the previous runtime and restore the previous caches on failure. Preloading must not evaluate a row the generation disables, removes or refuses, so HMR would decide admission before the Loader does; dynamic `disabled` expressions and nested Includes cannot be decided without activation, so those changes would need a restart. Rollback must also remove new importers of restored modules, and the previous code would still receive the new configuration. A restart would load the same broken files, so keeping the previous plugin only delays a failure that needs a fix anyway.

**Restart replaced plugins in place before recomposition.** New code would start with the previous configuration, which an upgraded version may reject, and a row the new composition disables or refuses, for example an incompatible version left on disk by a failed install, would briefly run.

**Replace running plugins after recomposition.** Recomposition would restart the previous code with the new configuration, which the previous version may reject, so a successful upgrade would be reported as a failure; an entry inserted during recomposition would also link against the previous copy of a changed dependency still cached for a running plugin.

**Stop affected plugins before pnpm runs.** This prevents previous code from lazily loading files pnpm has already replaced, but adds downtime for the whole install and holds the HMR queue during pnpm.

**Re-evaluate every dependency of a replaced plugin.** Source reloads reload a plugin's non-`node_modules` dependency tree. Doing the same below `node_modules` would create second instances of unchanged shared libraries and Cordis packages used by other plugins.

**Record identities in a module load hook.** `module.registerHooks()` could record each file at load time and close the window for modules loaded between recordings, but it adds a hook to every module load and interacts with TSX and the vendored Loader's internals. The timestamp rule only causes an extra reload in that window.

## Consequences

- Upgrades through a removal and an installation, and packages whose files changed in place, take effect without a restart when the replacement loads and starts; a replacement that fails to load or start stops the previous plugin and reports `failed` with the error, and it starts once its files or dependencies are corrected.
- Each recomposition stats every loaded file of the profile; the module graph is walked when a file changed, and the host graph is collected on first use.
- Dynamic `import()` edges are not followed: an importer keeps running while its next dynamic import evaluates the new file. Existing Workers and the TSX loader thread keep their caches.
- Replaced Loader entries stop before recomposition and start once afterwards; the previous version does not return.
- Loader entries outside the profile composition restart with replaced code without a new compatibility check ([limitation](../../../../packages/boot/hmr/README.md#known-limitations-and-deferred-work)).
- `ModuleFiles` belongs to one HMR instance. A recomposition that restarts the `hmr` entry itself starts a new instance whose first observation records the current files, so changes pending at that point are no longer reported or retried.
- `pending` describes the whole profile, so a host module brought into scope by a linked workspace package makes later unrelated operations report `restart-required` until the process restarts.
- A file replaced by a hard link to an older store file keeps an older modification time; when its module was first loaded after the last recording, the change is not detected.
- A change confined to `package.json` is not detected. HMR's profile watches do not recompose for dependency-only manifest changes, so installs performed outside Plugin Manager wait for the next recomposition or restart.

## Verification

| Coverage | Location |
|---|---|
| In-place upgrades with bundle patch changes, configurations the previous version rejects, inserted entries and disabled rows, plugins without a Loader entry, shared-dependency importers, linked packages, hard links, CommonJS `require` children and their failures, failed replacement and retry, nested groups and Includes, dynamic disabling, same-path reinstall, late-loaded modules, host-graph modules, comparison and recomposition failures, eviction of packages a recomposition stopped using or whose mappings it dropped, and the restart of stopped entries after a rejected publication or failed preparation | `packages/boot/hmr/tests/package-reload.spec.ts` |
| Refused overwrites, removal then installation with HMR, failed installation, relinked and link-to-registry reinstalls, unmanaged plugins, comparison failures | `packages/boot/plugin-manager/tests/package-reload.spec.ts`, `packages/boot/plugin-manager/tests/manager.spec.ts` |
| In-place profile mapping version change, retained directory and scope rejection including a relinked path inside the profiles tree, relinked roots and native lookups relocated below the current target | `packages/boot/app-boot/tests/profile-resolution.spec.ts` |

Tests need no API key and make no model calls.
