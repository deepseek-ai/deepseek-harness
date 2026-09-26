# Agent Note: Add immutable profile resolution generations

Status: implemented

English | [中文](2026-09-09-profile-resolution-generations.zh.md)

## Problem

A profile loads plugin rows from its own package project, while Harness packages and packages carried by selected bundles can live outside that project's ordinary dependency tree. Bridging the trees through shared symlinks, profile-owned links, or packaged-executable proxy packages persists package selections across processes and installations. Those files require reconciliation and locking, expose generated proxy manifests to metadata readers, and cannot represent a process-local change atomically.

The runtime design keeps installation-first, ordered-bundle, and local-before-fallback precedence. It covers imports performed by plugin modules as well as Loader row imports and works in the main thread and Harness-owned Workers. Generation replacement preserves existing package mappings and local package names, permits linked-root membership changes, and never mutates a live table entry by entry.

## Decision

Profile startup computes one immutable `RuntimeResolution` and installs it into Node's ESM and CommonJS resolvers. Runtime is the only resolution backend; there is no mode selector or disk materializer. `PluginPackages.replace()` publishes a complete successor with one reference replacement.

### One selection algorithm

The package traversal belongs to `@deepseek-ai/dsh-app-boot` beside profile loading. Ordinary Node, source launches, packaged executables, and the Electron Host consume the same runtime resolution and interception.

The installation manifest is the first root. Its graph traverses `dependencies` followed by `peerDependencies` breadth-first, resolving each edge from the manifest that declares it. The first installed package reached under a name owns that name. Selected bundle roots then run in profile order, with each earlier root's complete graph taking precedence over every later root. Names supplied by the installation are reserved, and bundle package roots themselves do not become plugin fallbacks. Missing declared packages are skipped.

During dependency expansion, every installation root, selected bundle root, and recursive dependency manifest uses its package's real directory as the lookup anchor. Ancestor `node_modules` searches therefore follow the location from which Node normally executes the package, not the location of a symlink pointing to it. The same declaring anchor is recorded for runtime delegation. This can change the selected version or remove an otherwise discoverable dependency when logical and real ancestors differ; it is not merely a spelling change to stored paths.

Profile-local and plugin-private `node_modules` entries take precedence over runtime resolution entries. The runtime resolution records installed direct profile package names for a no-I/O native fast path. Each entry records the package name, version, selected lookup directory, declaring manifest anchor, and scope needed for native resolution and successor validation.

The profile-scope entries of the runtime resolution remain necessary for dependencies that the profile cannot find through its own ancestor directories. They expand installed manifest dependencies into the active profile's runtime resolution, not a separate graph for each plugin. It neither downloads packages nor scans source imports. Runtime hooks consume that table after native local candidates have been considered.

### Ordinary and linked package examples

In both layouts below, the profile selects `my-bundle`, whose manifest declares `bridge`; only `bridge` declares `leaf`. Neither the installation nor the profile's direct packages supplies `leaf`, and `bridge` has no private `node_modules/leaf`. The paths illustrate the two layouts exercised by the [shared CLI profile tests](../../../../apps/cli/tests/profiles/headless/tests/profile-resolution.ts).

With ordinary installed directories, `bridge` searches its containing bundle's `node_modules` and finds version 1.0.0. The unrelated version 2.0.0 is not on that search path:

```text
/case/home/profiles/headless/node_modules/my-bundle/
  node_modules/bridge/
  node_modules/leaf/                                  # 1.0.0
/case/dependencies/node_modules/leaf/                 # 2.0.0
```

With an npm-link-style bundle and a linked transitive dependency, the bundle expands from `/case/work/my-bundle`, and the next dependency expansion starts at `/case/dependencies/bridge`. That expansion finds version 2.0.0 beside the real package:

```text
/case/home/profiles/headless/node_modules/my-bundle -> /case/npm-global/node_modules/my-bundle
/case/npm-global/node_modules/my-bundle -> /case/work/my-bundle
/case/work/my-bundle/node_modules/bridge -> /case/dependencies/bridge
/case/work/my-bundle/node_modules/leaf/                # 1.0.0
/case/dependencies/node_modules/leaf/                 # 2.0.0
```

| Profile package layout | Declaring directory used to resolve `leaf` | `tsx/esm` source launch | Plain Node `lib` launch |
|---|---|---|---|
| Ordinary directories | `/case/home/profiles/headless/node_modules/my-bundle/node_modules/bridge` | 1.0.0 | 1.0.0 |
| Linked bundle and bridge | `/case/dependencies/bridge` | 2.0.0 | 2.0.0 |

ESM `import` and CommonJS `require` select these versions. Within each module format, importing `leaf` through profile fallback and importing it inside `bridge` reaches the same module instance. A higher-priority native profile package or an installation-reserved fallback name still wins according to the selection rules; the fallback does not force every importer to use version 2.0.0.

### Source and built module identity

The [source launcher](2026-07-29-dsh-source-launch-tsx-esm.md) uses tsx's ESM-only hook. tsx skips tsconfig `paths` for an importer URL containing `/node_modules/`. A logical workspace symlink used as a fallback declaring anchor can therefore select built `lib/` exports, while imports from the resulting real workspace files select `src/` through the paths map. Real declaring anchors let workspace imports follow the source map consistently; packages without a matching workspace mapping keep ordinary package-export resolution.

For example, `@deepseek-ai/dsh-tools` creates its scheduler key with `Symbol()`. A Tools instance loaded from `lib/` cannot expose that scheduler through a key imported from the separate `src/` module instance. Source launches keep Tools and AgentLoop in `src/`; plain Node launches keep them in `lib/`. The scheduler retains its local Symbol; correct imports share one module instance.

The source launcher does not install a CommonJS TypeScript hook. `createRequire().resolve()` still selects the package's published JavaScript entry and requires that file to exist. Source-mode resolution tests therefore use fixture-provided CommonJS files; checks of real installation CommonJS entries run with build outputs present.

<a id="immutable-generations"></a>
### Immutable generations

A runtime interception holds one `current` generation. Each synchronous resolution captures that reference once. Generation construction reads every required dependency-graph manifest before publication; an error leaves the current generation unchanged. Successful publication replaces one reference, and in-flight calls may finish against the generation they captured.

Selection and package-metadata caches belong to a generation. Publishing a successor invalidates them by making the old generation unreachable after its callers finish; update code does not mutate or clear individual entries. Profile-importer hits and successful native selections can be cached, but a generation miss is rescanned so a profile-local package installed after the miss becomes visible through native lookup. Linked importer routes are not cached: each resolution reads current peer declarations at the ancestor positions it visits. Explicit CommonJS paths bypass interception entirely; non-default conditions never reuse a default-resolution cache entry.

Linked-root membership is immutable within a generation. A successor may add or remove roots without restarting the process. When no remaining root covers a directory, subsequent resolutions there use native Node lookup, including new requests from already loaded modules. A request may then select a development copy or fail because the package is absent. Removing interception does not unload modules, replace existing references, or clear Node's own caches.

The router retains the real target of each successfully published link name for its lifetime, solely to validate successors. Removing a root does not erase that record or keep its directory intercepted. Re-adding the same name and target is allowed; a different target is rejected because Node caches real paths. Failed publication changes neither the current generation nor the recorded targets.

The launcher constructs one startup generation. The service accepts a complete successor, but no package-manager transaction invokes replacement in this implementation.

### Shared ESM and CommonJS rule

The resolver uses `node-addon-require-builtin` to read `internal/modules/esm/loader` and `internal/modules/cjs/loader`. The ESM adapter wraps the per-thread singleton `CascadedLoader` resolve methods. The CommonJS adapter wraps the internal builtin's `Module._resolveFilename`; that `Module` is the same object exported by `node:module`.

Both adapters call one routing function. It ignores builtins, relative or absolute paths, URLs, parents outside the profiles and registered linked roots, and every CommonJS request with explicit `paths`. A `#imports` request uses Node's mapping from its owning manifest; an external bare target follows the same package order with the request's conditions, while Node retains exact target resolution. Package self-references keep the original parent, including npm aliases. Profiles have a fixed interception position; linked importers apply current peer eligibility at each native ancestor position. Native CommonJS probes determine whether a legacy subpath miss continues to another position. The [lookup-order Note](2026-09-19-profile-resolution-lookup-order.md) owns the complete selection rule.

The adapters call the captured native resolver after routing. Node remains responsible for exports, import and require conditions, main files, subpaths, extensions, native caches, and error codes. Routed ESM failures replace the internal lookup anchor in Node's diagnostic with the original importer. A selected package's invalid export or missing target does not trigger another same-name candidate. CommonJS does not replace `_findPath` or reproduce `_resolveFilename`.

The guarantee covers Node's default `import`, `import()`, `import.meta.resolve`, `require`, and `require.resolve` after installation in that thread. It does not cover already linked modules, custom `vm` linkers, opaque non-Node importers, or third-party Workers.

### Active plugin list and package metadata

The runtime resolution lists the packages it supplies; Loader entries form the active plugin list. Consumers keep using Loader's existing entry lifecycle and filter the entries relevant to their own scope. Consumers that need package metadata pass a specifier and owning tree base URL to a lightweight `app-boot` service without requiring a `./package.json` export. An installed runtime resolution is authoritative, including a miss; a service created without one retains native lookup for low-level embedders.

The resolver does not expose `imported(entry)` and does not observe ModuleJobs, wrap Entry methods, associate fibers with import calls, replace registry or tree methods, or adapt HMR transactions. Package-directory queries use the same package selection, including current ancestor peer declarations for linked importers, but do not validate the requested subpath or load its file. Non-Node importers that need package metadata must explicitly implement the same resolver interface.

The implementation lives under `app-boot/src/profile-resolution/`. `service.ts` provides the long-lived `ctx.pluginPackages` and owns the main-thread interception and the Worker resolution lifetime; `resolver.ts` implements runtime resolution lookup and the Node Internal adapters; `worker-bootstrap.ts` installs the inherited runtime resolution in one thread. Profile selection and runtime resolution construction remain in `profile.ts`. Workers reference the bootstrap only through the public `@deepseek-ai/dsh-app-boot/worker/profile-resolution-bootstrap` export.

The service definition and provider remain together in `app-boot` because profile boot owns the resolver lifetime. Extracting a separate capability seam becomes warranted when a launcher-independent provider or independently evolving consumers require it.

### Workers and generation updates

The main thread publishes a structured-clone representation of the current generation through Worker environment data. Each built Harness-owned Worker uses its build banner to obtain its own ESM and CommonJS internal objects and install the same adapters without traversing manifests. The bootstrap bundle has no static package imports. Source Worker entries retain their existing self-contained dependencies. Third-party Workers remain unchanged.

New Workers inherit the latest published generation. Existing Workers keep the generation they inherited, so a caller that publishes a successor must restart them. The ESM bootstrap cannot affect static dependencies linked before its execution, so Worker bundles keep pre-bootstrap static imports natively resolvable and start code needing the profile resolver through a later dynamic import.

### Additive package changes

A caller adding a package completes its pnpm transaction before constructing a successor generation. Replacement rejects any generation that changes the directory or version of an existing package. The caller publishes an additive successor before mounting the new Loader row; this implementation does not provide that package transaction. A mount failure may leave the package installed but inactive.

Changing or removing an existing runtime package mapping, or removing a recorded profile-local package name, requires process restart because Node's ESM Module Map, CommonJS cache, existing object references, and running Workers can retain the old module identity. These restrictions do not prohibit removing a linked root from the interception scope. Generation replacement does not claim to unload modules.

### Filesystem and runtime carriers

The resolver does not create, update, or remove fallback symlinks and proxy packages. Runtime resolution entries occupy their package names at `$DSH_HOME/profiles/node_modules`; every other name sees that directory as an ordinary ancestor. Construction records links to directories outside the shared profiles tree and the active profile itself, including targets without their own manifest. Installation-scope package directories stay outside linked interception even when a broader linked root contains them. Eligible linked importers retain native ancestor order and per-position peer mappings. The [lookup-order Note](2026-09-19-profile-resolution-lookup-order.md) records precedence and scope. Writable profile state and package-manager transactions remain outside the resolver.

Runtime resolution requires a supported Node Internal loader interface. The Electron Host runs through the Electron executable with `ELECTRON_RUN_AS_NODE=1`; packaged builds read the dsh tree from ASAR and map executable ASAR entries to electron-builder's unpacked tree. Pkg and Electron use the same runtime resolution mechanism as ordinary Node launches.

### Performance and verification

Generation construction is startup or update work, not resolve work, and its absolute latency is reported separately. Profile hot paths consist of scope classification, bare-name extraction, local-before-fallback selection, a Map lookup, and one native resolution; a cache hit returns the generation-owned result directly. Linked requests for supplied package names read the visited ancestor manifests and do not cache the selected route. CommonJS can probe multiple positions when legacy subpaths are missing. Out-of-scope calls do not read manifests and cache only whether each parent has an interception layer.

One-off local measurements taken during implementation ran built JavaScript under plain Node in fresh processes and compared it with a process that installed no hook. The measurement script and results are not committed, and these figures are not a benchmark or CI budget. Seven alternating rounds covered outside, profile-local, and fallback imports through dynamic import, `import.meta.resolve`, require, and `require.resolve`. Across Node 22.19, 24.18, and 26.8, the largest positive hot-path median was 4.5%. On Node 24.18, a 256-package cold workload regressed by at most 11.2% and generation construction took 16.027 ms median; the 32-package local `require.resolve` case added 1.033 ms across the batch (+34.7%) from fixed startup cost.

Behavior tests exercise root order, transitive and peer dependencies, local and external precedence, exports and subpath errors, conditions, and explicit CommonJS options. The Node compatibility matrix runs the resolver, service, and bootstrap specifications across the supported internal-loader variants. Worker tests verify environment-data publication and bootstrap installation with mocked thread and native-loader interfaces; they do not launch a built Worker. Generation tests prove failed construction does not publish partial state and successful replacement is atomic.

## Alternatives considered

**Keep disk projections permanently.** This preserves native lookup without process hooks, but retains cross-process mutation, stale generations, proxy manifests, writer locks, and packaged-runtime divergence. Retaining link and dual as comparison modes would also keep the materializer and its lifecycle without a supported launcher that needs them.

**Preserve logical symlink anchors.** This keeps lookup under the symlink's ancestors, but can select a different dependency from the one imported by the real package and can suppress tsx's workspace paths map. Canonical anchors keep eager dependency discovery and runtime delegation aligned with the package's execution location.

**Expand the dependency graph lazily during resolve.** This spreads manifest reads and errors across first-use calls, changes timing from the disk implementation, complicates Worker startup, and makes the hot path depend on graph size. Complete generation construction is easier to compare and replace atomically.

**Use `module.registerHooks`.** The public API puts every relevant resolution through Node's global hook dispatch before profile scope can reject it. Direct access to the existing internal ESM and CommonJS resolver objects permits a smaller fast path while retaining Node as the final resolver.

**Record each Entry's actual import through Loader and HMR adapters.** Actual import records support stateful resolvers that return different targets for identical inputs. This design instead makes the generation authoritative and deterministic, so those records duplicate the resolver's answer while adding Entry, fiber, registry, ModuleJob, and HMR lifecycle state.

**Mutate one long-lived table after each package operation.** Incremental mutation exposes partial graphs and requires targeted cache invalidation. Building a complete successor makes failure atomic and keeps all caches generation-owned.

**Hot-replace already loaded package versions.** A resolution-table swap cannot invalidate every live module instance or object reference. Restart preserves one package identity per process.

## Verification

- One eager computation supplies the runtime resolution; startup neither writes nor retires module-resolution data.
- [Generation tests](../../../../packages/boot/app-boot/tests/profile-resolution.spec.ts) cover installation and selected-bundle graphs with ordinary directories and recursive symlinks, including different dependency versions beside logical and real anchors. They also cover linked-root removal, same-target restoration, overlapping roots, native misses, new requests from loaded modules, and relink rejection after removal.
- [Source-launch tests](../../../../apps/cli/tests/source-launch.compat.spec.ts) and [built-bin tests](../../../../apps/cli/tests/built-bin.e2e.ts) run both profile layouts through the real CLI. They assert ESM/CJS versions, loaded paths, per-format dependency identity, and consistent Tools/AgentLoop module instances with an accessible scheduler key.
- Pkg and Electron carriers select runtime resolution; Electron executes its Host in Node mode from the ASAR-backed dsh tree while native executable entries remain unpacked.
- ESM and CommonJS adapters share one router and delegate final resolution to Node without `module.registerHooks` or `_findPath` replacement.
- Production metadata lookup does not record Loader import results or wrap Entry, registry, tree, or HMR methods.
- The Node compatibility matrix runs main-thread resolver specifications across supported loader interfaces; service and bootstrap specifications cover Worker environment-data and installation interfaces without launching a built Worker.
- One-off built plain-Node measurements produced the hot and cold observations above against no-hook Node; the script and results are not committed evidence.

## Consequences

Runtime startup avoids disk mutation and proxy manifests while retaining package-precedence rules. Real-directory anchors align dependency discovery with default Node loading and tsx workspace mapping, including cases where a logical symlink path would select another version. The implementation accepts the maintenance cost of Node Internal compatibility tests and an early, self-contained bootstrap in each owned Worker; it provides no disk-only backend or dual comparison mode. Package mappings and local package names remain additive; linked-root membership may change without unloading modules.
