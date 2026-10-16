# Agent Note: Refresh runtime resolution after package operations and expire HMR package configuration

Status: implemented

English | [中文](2026-09-30-profile-package-refresh-and-manifest-invalidation.zh.md)

## Problem

Two pieces of Host state did not follow changes while the process ran:

- **Runtime resolution was built only at startup.** After a GUI install or enablement, nothing published the latest generation, so a bundle's private dependencies never reached the profile fallback and its bare plugins could not be found. After disablement or removal, a new generation could not remove profile-scoped entries or profile-local names, so stale records and package metadata remained. A newly installed package directory is new, and Node holds no stale cache for it; only the table was missing.
- **Package configuration and module evaluation have separate caches.** Clearing a plugin's module cache does not refresh the package.json fields that Node uses for exports, main, imports, and format detection. A package.json can also be imported as a JSON module, in which case its consumers need ordinary module reloads.

## Decision

### Responsibilities

| Owner | Does | Does not |
|---|---|---|
| resolver (`app-boot/src/profile-resolution/resolver.ts`) | `replace()` allows removing `scope: profile` entries and profile-local names, and changing a retained profile entry's version in place | Touch any Node cache |
| plugin-manager | Without HMR, calls `pluginPackages.refresh()` at fixed points of package operations; with HMR, leaves publication to its recomposition | Construct resolutions or manage module and package-configuration caches |
| HMR (`packages/boot/hmr`) | Expires package configuration and preserves ordinary reloads for manifests loaded as JSON modules; replaces plugins whose loaded package files changed during recomposition ([replacement Note](2026-10-01-replace-changed-package-modules-on-recomposition.md)) | Reload plugins for configuration-only manifests |

### Runtime resolution

The [generation Note](2026-09-09-profile-resolution-generations.md) owns package identity and Worker inheritance rules.

Validation of a new generation in `replace()`:

- `scope: profile` entries may be removed.
- Profile-local package names may be removed.
- Retained profile entries keep their normalized directory and scope, but may change declaring anchor when another selected bundle supplies the same package, and may change version when the package is upgraded in place ([replacement Note](2026-10-01-replace-changed-package-modules-on-recomposition.md)). Installation mappings and declaring anchors remain unchanged. The profile scope cannot change; a new local name cannot override an existing entry. A published link name may select another real directory; Node's cached real paths of the previous one are relocated.

### Plugin Manager

| Operation | Publication point |
|---|---|
| Install, enable, disable or remove with HMR | Inside HMR's recomposition, after the rows the generation drops stopped and before the generation applies ([replacement Note](2026-10-01-replace-changed-package-modules-on-recomposition.md)) |
| Install a new package or enable a bundle without HMR | After the profile files are saved, before reconciliation |
| Remove without HMR | After pnpm remove succeeds |
| Disable without HMR, an install over an installed package, a failed or cancelled install, a failed removal | No publication; an install over a package the spec names is refused before pnpm runs |

`createRuntimeResolution()` returns a `ProfileRuntimeResolution`, which privately keeps the installation anchor, Harness home, and profile directory it was computed from. Its `computeLatestResolution()` rereads that profile with the same inputs and returns a new object for the latest generation, leaving the original unchanged; Workers receive only the table fields. `PluginPackages.refresh()` calls the current resolution's `computeLatestResolution()` and then `replace()`; a resolution constructed as plain data cannot be refreshed and makes the call throw. app-boot's `recomposeProfile()` first stops the rows the generation no longer lists, so their plugins dispose while their packages are still mapped, then publishes the latest generation once; a table that is already published is not published again.

Without HMR, deselecting a startup bundle does not stop its plugins. While such a bundle remains deselected, later package operations keep the existing runtime table instead of publishing its removal. Other no-HMR installations and removals of non-running bundles still publish normally.

A successful package operation is not rolled back when publication is rejected afterwards. The result reports the failed runtime application and retains the successful disk changes. Recomputing uses the captured profile directory on disk, not synthetic in-memory layers; a computed resolution without a profile recomputes installation packages only.

### HMR package-configuration expiry

In HMR's change dispatch, a changed file named `package.json` outside `node_modules` goes to `PackageManifests.invalidate()`. A manifest in the host dependency graph still requests a host reload; one loaded as a JSON module still reloads its consumers. A configuration-only manifest schedules no module reload. Configuration-owned paths stay with their dedicated watcher. Source changes in the same batch reload afterwards.

`invalidate(manifest)` records the directory as expired. Afterwards:

- package.json reads, scope lookups, type lookups, and nearest-manifest lookups below that directory read the current file. Ownership follows the real directory when a consumer reaches the package through a link.
- ESM `ResolveCache` is cleared. Its entries do not record every consulted manifest, and a package entry may resolve outside the package directory.
- CommonJS `_pathCache` is cleared for the same reason. Unrelated requests recompute their resolution without unloading their modules.
- CommonJS loads using the default resolver pass the freshly resolved filename to the native loader. Its private request alias cannot select an older entry; cached module instances remain intact.

Configuration invalidation alone leaves loaded modules unchanged. Loader entries retain their raw import results before export normalization. HMR matches imported Node module objects to cached ModuleJob namespaces and reloads the loaded URLs. All matching entry records, including disabled entries, update only after a successful reload and remain unchanged on failure. Stopping and restarting a Loader entry resolves its package name again and selects the new entry.

Entry names are scoped by configuration-tree base URL and retain all distinct imported namespaces. An uninitialized entry contributes the name without erasing loaded namespaces; name-based resolution is used only when none is recorded, or for `cordis:` builtins. Dependency analysis considers every recorded module. Entries sharing a plugin runtime use one replacement operation, while each Loader entry selects its replacement by its original namespace. Module imports and export normalization finish before the old runtime is removed. Failed imports or activation restore the previous modules and plugin implementations and clean up partially activated replacements.

An instance without a Loader entry has no recorded module identity. If a shared runtime's replacement modules have different plugin callbacks, HMR reports an ambiguity error and rolls back instead of assigning that instance to an arbitrary module.

Package invalidation lives in `packages/boot/hmr/src/package-manifest.ts`, which encapsulates its Node internal interfaces. `index.ts` dispatches manifest changes and locates loaded entries by module identity. HMR's `node_modules` exclusion is unchanged.

| Interface | Action |
|---|---|
| modules binding `readPackageJSON`, `getPackageScopeConfig`, `getPackageType` | Replaced: paths in an expired directory read the current file; other calls reach the native method |
| `package_json_reader.getNearestParentPackageJSON` | Replaced: expired directories bypass its JS cache; a lookup without a manifest returns the native absent result |
| The ESM Loader's `ResolveCache` instance | The prototype `get` is replaced for one lookup to obtain the instance and restored at once; the resolution cache is then cleared |
| CommonJS `Module._pathCache` | The request-to-filename cache is cleared |
| CommonJS `Module._load` | Default-resolver requests load by resolved filename; builtins and registered resolve hooks keep the original path |

The binding's `getNearestParentPackageJSON` is called only by `package_json_reader` and is not replaced. Each HMR instance owns a separate configuration cache. Its replacements are installed at the first expiry and restored when the service is disposed, alongside watcher and reload-queue cleanup.

### Future Work

- A retained profile mapping that moves to another directory waits for a restart; Plugin Manager moves a package by removing and installing it. In-place replacement inside `node_modules` is handled by the [replacement Note](2026-10-01-replace-changed-package-modules-on-recomposition.md).
- TSX versions using an asynchronous loader thread keep that thread's package configuration outside these hooks. Synchronizing it is deferred; this change does not provide general Worker cache synchronization.
- CommonJS private-request-cache refresh with registered synchronous resolve hooks is deferred. Those requests retain their original loader behavior.
- Disposing HMR restores the native readers, whose previous cached configuration can become visible again. Preserving invalidation state across HMR replacement is deferred.

## Alternatives considered

**Read current disk on every lookup (#4703).** Resolution follows the disk, but module caches stay and running plugins do not reload. Same-URL contents do not take effect, and different URLs load a second version beside the first in one process. It also maintains its own entry resolver, bypasses custom bare-name hooks, and does not refresh runtime resolution, so GUI-installed private dependencies still cannot be found.

**Reread every observed manifest when runtime resolution publishes (#5496).** This places package-configuration expiry in table publication, decoupled from module caches: overwriting an installed package reports restart, yet the next unrelated publication makes new imports load the new version while the old plugin still runs. Package configuration is content and belongs with module caches, in HMR.

**Let HMR reload packages inside `node_modules`.** It requires finding affected plugins over a module graph that includes `node_modules`, preventing duplicate evaluation of shared libraries and Cordis, and handling missing dynamic-import edges, module side effects, and Workers. It is not done here; the [replacement Note](2026-10-01-replace-changed-package-modules-on-recomposition.md) adds it at profile recomposition.

**Reload every plugin for a package.json change.** Configuration-only manifests do not require module evaluation. Manifests actually imported as JSON modules retain ordinary dependency-driven reloads.

**Re-import reloaded plugins by package name.** It would let an entry rename follow a source reload, but changes `partialReload`'s rule that the loaded URL is the reload unit. Entry renames already take effect when the Loader entry restarts, so this is not changed.

**Keep one namespace per entry name.** Entries with the same name and base URL can have loaded different modules before and after a manifest change. Keeping only the first or last namespace loses a live module; an uninitialized entry must not erase another entry's imported namespace.

## Verification

| Coverage | Location |
|---|---|
| A new generation removes profile entries and local names and still rejects retained-entry changes | `packages/boot/app-boot/tests/profile-resolution.spec.ts` |
| GUI install, deferred enablement, disablement, removal, overwrite, failure, and cancellation, with and without HMR | `packages/boot/plugin-manager/tests/package-reload.spec.ts` |
| Captured-directory recomputation, computed installation-only refresh, and plain-data rejection | `packages/boot/app-boot/tests/profile-resolution.spec.ts`, `packages/boot/app-boot/tests/profile-resolution-service.spec.ts` |
| Sequential no-HMR operations, shared dependency declarers, and disk-success/publication-failure outcomes | `packages/boot/plugin-manager/tests/package-reload.spec.ts` |
| Expired exports, main, imports, type, scope, and nearest manifests; native-reader parity; actual CommonJS loads and retained module instances; the `node_modules` boundary; restoration | `packages/boot/hmr/tests/package-manifest.spec.ts` |
| Configuration-only manifests, JSON-module and host reloads, source reloads, same-name and shared-runtime entries, import and activation rollback, entry restarts, and the `node_modules` exclusion | `packages/boot/hmr/tests/package-manifest-dispatch.spec.ts` |

Tests need no API key and make no model calls.

## Consequences

- With HMR, supported package operations publish the updated private dependencies and remove unused mappings after plugins stop. Without HMR, a pending startup-bundle disablement defers later publications until restart, preserving running plugins' mappings.
- In the supported thread, package.json configuration reads use the changed fields; JSON modules retain their own reload behavior. The separate module, loader-thread, and Worker limitations above still apply.
- Package configuration below expired directories is parsed in JavaScript and must keep the native reader's field and error semantics; tests compare it with the native reader on Node 22, 24, and 26.
- The implementation depends on several Node internal interfaces, and these tests must run again for Node upgrades.
