# Agent Note: Add immutable profile resolution generations

Status: implemented

English | [中文](2026-09-09-profile-resolution-generations.zh.md)

## Problem

A profile loads plugin rows from its own package project, while Harness packages and packages carried by selected bundles can live outside that project's ordinary dependency tree. The current launcher bridges the trees by calculating package precedence at startup and materializing that result as shared symlinks, profile-owned links, or packaged-executable proxy packages. The files persist across processes and installations, require reconciliation and locking, expose generated proxy manifests to metadata readers, and cannot represent a process-local change atomically.

The runtime design preserves the existing selection rules rather than introducing a second package policy. It covers imports performed by plugin modules as well as Loader row imports and works in the main thread and Harness-owned Workers. Generation replacement accepts only additive package sets and never mutates a live table entry by entry.

## Decision

Profile startup computes one immutable `ResolutionGeneration` from the same dependency traversal that supplies the disk module fallback. The launcher defaults to link mode and preserves the existing materialized lookup behavior. Internal callers and tests can select runtime mode, which installs the generation into Node's ESM and CommonJS resolvers, or dual mode, which materializes and verifies the same generation. `PluginPackages.replace()` publishes a complete additive successor with one reference replacement.

### One selection algorithm

The package traversal remains in `@deepseek-ai/dsh-app-boot` beside profile loading. The disk materializer and the runtime resolver consume one pure plan; neither owns a copy of the precedence algorithm. Ordinary Node callers can select link, dual, or runtime mode, while an omitted mode selects link. Packaged executables and the Electron Host select runtime mode because their dependency trees may live in a virtual filesystem; dual remains an internal comparison path.

The installation manifest is the first root. Its graph traverses `dependencies` followed by `peerDependencies` breadth-first, resolving each edge from the manifest that declares it. The first installed package reached under a name owns that name. Selected bundle roots then run in profile order, with each earlier root's complete graph taking precedence over every later root. Names supplied by the installation are reserved, and bundle package roots themselves do not become plugin fallbacks. Missing declared packages are skipped as before.

Profile-local and plugin-private `node_modules` entries stay outside the fallback entries, and Node checks them before the virtual fallback position. The generation records only installed direct profile package names for a no-I/O native fast path. Each fallback entry records the package name, version, selected lookup directory, declaring manifest anchor, and scope needed to rerun Node's native resolution from the selected package and validate that a successor preserves existing mappings.

The existing `healProfilesModuleFallback()` remains as the disk materializer for the same computed result, which permits direct comparison without rewriting the selection rules. The launcher uses it by default. Runtime mode computes the generation without materializing it, while dual mode materializes and installs that generation for comparison.

### Immutable generations

A resolver registration holds one `current` generation. Each synchronous resolution captures that reference once. Generation construction reads every required manifest before publication; an error leaves the current generation unchanged. Successful publication replaces one reference, and in-flight calls may finish against the generation they captured.

Selection and package-metadata caches belong to a generation. Publishing a successor invalidates them by making the old generation unreachable after its callers finish; update code does not mutate or clear individual entries. A generation hit and a successful native selection can be cached, but a generation miss is rescanned so a profile-local package installed after the miss becomes visible as it does in link mode. Calls with explicit CommonJS paths or non-default conditions never reuse a default-resolution cache entry.

The launcher constructs one startup generation. The service accepts an additive successor, but no package-manager transaction invokes replacement in this implementation.

### Shared ESM and CommonJS rule

The resolver uses `node-addon-require-builtin` to read `internal/modules/esm/loader` and `internal/modules/cjs/loader`. The ESM adapter wraps the per-thread singleton `CascadedLoader` resolve methods. The CommonJS adapter wraps the internal builtin's `Module._resolveFilename`; that `Module` is the same object exported by `node:module`.

Both adapters call one routing function. It ignores builtins, relative or absolute paths, URLs, parents outside the profile scope, and explicit calls outside the supported lookup. A `#imports` request uses Node's mapping from its owning manifest; an external bare target follows the same local, generation, and after-fallback package order with the request's conditions, while Node retains exact target resolution. For a scoped bare request, a package self-reference keeps the original parent even when an npm alias gives its installed directory another name. A profile-local or plugin-private package also keeps the original parent when Node resolves the requested entry before the virtual shared-fallback position; a CommonJS package directory without `exports` does not suppress the fallback when only its requested subpath is absent. Otherwise the router uses a generation hit through that entry's declaring anchor or continues native lookup after the virtual fallback. Explicit CommonJS path lists apply the same insertion rule independently to each path in caller order.

The adapters call the captured native resolver after routing. Node remains responsible for exports, import and require conditions, main files, subpaths, extensions, native caches, and error codes. Routed ESM failures replace the internal lookup anchor in Node's diagnostic with the original importer. A selected package's invalid export or missing target does not trigger another same-name candidate. CommonJS does not replace `_findPath` or reproduce `_resolveFilename`.

The guarantee covers Node's default `import`, `import()`, `import.meta.resolve`, `require`, and `require.resolve` after installation in that thread. It does not cover already linked modules, custom `vm` linkers, opaque non-Node importers, or third-party Workers.

### Active plugin list and package metadata

The resolution generation lists available fallback packages; Loader entries form the active plugin list. Consumers keep using Loader's existing entry lifecycle and filter the entries relevant to their own scope. Consumers that need package metadata pass a specifier and owning tree base URL to a lightweight `app-boot` service without requiring a `./package.json` export. An installed generation is authoritative, including a miss; a service created without a generation retains native lookup for low-level embedders.

The resolver does not expose `imported(entry)` and does not observe ModuleJobs, wrap Entry methods, associate fibers with import calls, replace registry or tree methods, or adapt HMR transactions. A repeated query uses the same generation and therefore cannot drift from the route used for the import. Non-Node importers that need package metadata must explicitly implement the same deterministic resolver interface.

The implementation lives under `app-boot/src/profile-resolution/`. `service.ts` provides the long-lived `ctx.pluginPackages` and owns the main-thread resolver and Worker-generation lifetimes; `resolver.ts` implements generation lookup and the Node Internal adapters; `worker-bootstrap.ts` installs an inherited generation in one thread. Existing profile selection and disk materialization remain in `profile.ts`. Workers reference the bootstrap only through the public `@deepseek-ai/dsh-app-boot/worker/profile-resolution-bootstrap` export.

The service definition and provider remain together in `app-boot` because profile boot owns the resolver lifetime. Extracting a separate capability seam becomes warranted when a launcher-independent provider or independently evolving consumers require it.

### Workers and generation updates

The main thread publishes a structured-clone representation of the current generation through Worker environment data. Each built Harness-owned Worker uses its build banner to obtain its own ESM and CommonJS internal objects and install the same adapters without traversing manifests. The bootstrap bundle has no static package imports. Source Worker entries retain their existing self-contained dependencies. Third-party Workers remain unchanged.

New Workers inherit the latest published generation. Existing Workers keep the generation they inherited, so a caller that publishes a successor must restart them. The ESM bootstrap cannot affect static dependencies linked before its execution, so Worker bundles keep pre-bootstrap static imports natively resolvable and start code needing the profile resolver through a later dynamic import.

### Additive package changes

A caller adding a package completes its pnpm transaction before constructing a successor generation. Replacement rejects any generation that changes the directory or version of an existing package. The caller publishes an additive successor before mounting the new Loader row; this implementation does not provide that package transaction. A mount failure may leave the package installed but inactive.

Replacing, upgrading, or removing an already loaded package requires process restart because Node's ESM Module Map, CommonJS cache, existing object references, and running Workers can retain the old module identity. Generation replacement does not claim to unload modules.

### Disk migration

Runtime-only launch paths do not create, update, or retire symlinks and proxy packages. The resolver treats the legacy shared fallback and `.dsh-module-fallback` projections as virtual insertion positions: a generation hit uses the table target, while a miss skips those old positions before continuing native ancestor lookup. During a dual phase, the launcher materializes and installs the same generation; tests disable each backend in turn and compare their targets.

Legacy disk state remains available to link-only launches, old processes, and rollback without participating in runtime-only selection. Removing that state is a separate maintenance operation outside this change.

### Mode behavior

Link, dual, and runtime modes use the same generation schema and dependency-selection policy. Link mode persists the computed result, runtime mode installs it only in the process, and dual mode requires Node's materialized result to equal the generation route.

The `dsh` launcher selects link mode when an ordinary Node caller omits `resolutionMode`, so existing npm-installed profile startup keeps its filesystem behavior. A pkg executable always selects runtime mode, and the Electron Host installs its runtime generation before any profile row mounts. Tests and low-level embedders can still select runtime or dual explicitly.

Runtime mode requires a supported Node Internal loader interface and does not create, update, or retire fallback links. Dual mode retains link writes and fails when Node's disk result differs from the generation. Writable profile state and package-manager transactions remain outside the resolver.

Pkg and packaged Electron carriers force runtime resolution. The Electron Host runs through the Electron executable with `ELECTRON_RUN_AS_NODE=1`, reads its dsh tree from ASAR, and maps executable ASAR entries to electron-builder's unpacked tree. Neither carrier creates, updates, or removes legacy resolution links.

### Performance and verification

Generation construction is startup or update work, not resolve work, and its absolute latency is reported separately. Ordinary hot paths consist of scope classification, bare-name extraction, local-before-fallback selection, a Map lookup, and one native resolution; a cache hit returns the generation-owned result directly. A CommonJS request may perform one native probe followed by one routed resolution when a local package directory exists without `exports` but lacks the requested subpath. Out-of-scope calls do not read manifests and cache only whether each parent belongs to the profile scope.

One-off local measurements taken during implementation ran built JavaScript under plain Node in fresh processes and compared it with a process that installed no hook. The measurement script and results are not committed, and these figures are not a benchmark or CI budget. Seven alternating rounds covered outside, profile-local, and fallback imports through dynamic import, `import.meta.resolve`, require, and `require.resolve`. Across Node 22.19, 24.18, and 26.8, the largest positive hot-path median was 4.5%. On Node 24.18, a 256-package cold workload regressed by at most 11.2% and generation construction took 16.027 ms median; the 32-package local `require.resolve` case added 1.033 ms across the batch (+34.7%) from fixed startup cost.

Behavior tests compare the runtime generation with the disk materializer over the same package trees, then exercise root order, transitive and peer dependencies, local and external precedence, exports and subpath errors, conditions, and explicit CommonJS options. The Node compatibility matrix runs the resolver, service, and bootstrap specifications across the supported internal-loader variants. Worker tests verify environment-data publication and bootstrap installation with mocked thread and native-loader interfaces; they do not launch a built Worker. Generation tests prove failed construction does not publish partial state and successful replacement is atomic.

## Alternatives considered

**Keep disk projections permanently.** This preserves native lookup without process hooks, but retains cross-process mutation, stale generations, proxy manifests, writer locks, and packaged-runtime divergence. A bounded dual migration remains useful because both backends consume the same generation.

**Expand the dependency graph lazily during resolve.** This spreads manifest reads and errors across first-use calls, changes timing from the disk implementation, complicates Worker startup, and makes the hot path depend on graph size. Complete generation construction is easier to compare and replace atomically.

**Use `module.registerHooks`.** The public API puts every relevant resolution through Node's global hook dispatch before profile scope can reject it. Direct access to the existing internal ESM and CommonJS resolver objects permits a smaller fast path while retaining Node as the final resolver.

**Record each Entry's actual import through Loader and HMR adapters.** Actual import records support stateful resolvers that return different targets for identical inputs. This design instead makes the generation authoritative and deterministic, so those records duplicate the resolver's answer while adding Entry, fiber, registry, ModuleJob, and HMR lifecycle state.

**Mutate one long-lived table after each package operation.** Incremental mutation exposes partial graphs and requires targeted cache invalidation. Building a complete successor makes failure atomic and keeps all caches generation-owned.

**Hot-replace already loaded package versions.** A resolution-table swap cannot invalidate every live module instance or object reference. Restart preserves one package identity per process.

## Verification

- One eager computation supplies the retained disk materializer and runtime generation.
- Link-only, dual, and runtime-only tests consume the same generation; runtime startup neither writes nor retires module-resolution data.
- Pkg and Electron carriers select runtime resolution; Electron executes its Host in Node mode from the ASAR-backed dsh tree while native executable entries remain unpacked.
- ESM and CommonJS adapters share one router and delegate final resolution to Node without `module.registerHooks` or `_findPath` replacement.
- Production metadata lookup does not record Loader import results or wrap Entry, registry, tree, or HMR methods.
- The Node compatibility matrix runs main-thread resolver specifications across supported loader interfaces; service and bootstrap specifications cover Worker environment-data and installation interfaces without launching a built Worker.
- One-off built plain-Node measurements produced the hot and cold observations above against no-hook Node; the script and results are not committed evidence.
- Package READMEs, architecture references, generated catalogs, and the bilingual pair describe the shipped implementation.

## Consequences

Runtime startup avoids disk mutation and proxy manifests while preserving the existing package-selection algorithm. It accepts the maintenance cost of Node Internal compatibility tests and an early, self-contained bootstrap in each owned Worker. Link remains the ordinary Node launcher default, dual keeps a migration comparison path, and pkg plus Electron carriers force runtime resolution without retiring old links. Generation replacement remains additive until the product owns module-cache invalidation and Worker restart.
