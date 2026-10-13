# Agent Note: Build speed-ups that keep outputs unchanged

Status: implemented

English | [中文](2026-10-11-lossless-build-speedups.zh.md)

## Problem

A cold build carries three fixed costs that do not affect output contents:

- **JSX signatures in the Client test aggregate program.** The Check phase of `tsc -p tsconfig.client.json` takes 59.1 s, more than half of it computing the `@types/react` module specifier for every JSX file that imports React. TypeScript's `computeModuleSpecifiers` visits every symlink location of that declaration file and scans all 491 tsconfig `paths` entries at each location. pnpm creates one `node_modules/@types/react` link for each workspace package that declares `@types/react` itself; 66 manifests declare it, so the Client test aggregate program sees 65 locations. Counters measured 88 JSX files × 2 modules (`index.d.ts`, `jsx-runtime.d.ts`) × 65 locations: 11,457 `tryGetModuleNameFromPaths` calls and 5,623,782 entry scans, 32.6 s in total. A dose-response run at five truncation levels of the visible location count N (N = 1 to 65; Check 26.92 s to 58.40 s) fits Check ≈ 26.9 + 0.494·N s.
- **Typert inside the Host tsdown pass.** The Host tsdown pass takes about 21.6–22.6 s. Typert discovers and generates artifacts synchronously inside the first `writeBundle`; the CPU profile shows it blocking the tsdown main thread for about 12.4 s while every package build waits. Discovery takes 8.06 s: it parses all 362 package tsconfigs referenced by the two face aggregates (about 3.8 s), expands the Host aggregate's 2,064 literal `include` entries on every parse (1.6 s; the analyzer never reads those file names), and walks the public-export surface of 322 registrations (2.7–3.2 s). Only the 28 packages that declare a Typert export produce Host artifacts.
- **Manifest lookup in the Client tsdown pass.** The Client tsdown pass takes about 11.7 s with a saturated main thread (7.1% idle); 34.5% of it (3.95 s) is `workspaceManifest`: every package config runs `globSync('packages/*/*/package.json')` for its package name and parses manifests until the name matches. The module-level cache has no effect because tsdown's native config loader imports every package config through `import-without-cache`, creating a fresh module instance per config. Each glob takes 40–125 ms and runs inside the `neverBundle`/`alwaysBundle` callbacks of `tsdown:deps`, blocking every build.

#5849 merged Host fixture type narrowing and Typert memoization; this note's baseline is the master that follows it.

## Decision

The following eight speed-ups change neither the bytes of `lib/` and `apps/web/dist` outputs nor the set of type diagnostics that repository builds report. The only change in diagnostic ownership comes from item 4: Typert does not validate tsconfigs of packages it does not analyze, and only `tsc -b` reports those errors. [The build split note](2026-10-11-build-artifacts-check-split.md) records the command split and concurrent scheduling.

| # | Decision | Affected stage | Measured median | Outputs and diagnostics | Intended behavior difference |
|---|---|---|---|---|---|
| 1 | Only the root manifest declares React type packages | Client type checking | Test aggregate Check 59.1 → 26.3 s | Program file count and diagnostics unchanged | Package manifests do not list React type packages |
| 2 | Typert selects packages by manifest first | Host tsdown | 22.62 → 19.94 s | Byte-identical | None |
| 3 | Typert does not expand aggregate `include` | Host tsdown | 19.94 → 16.99 s | Byte-identical; registration inventory identical | None |
| 4 | Typert parses package tsconfigs lazily | Host tsdown | 16.99 → 16.25 s (within noise); Typert discovery 5.9–7.1 → 0.36–0.40 s | Byte-identical; registration inventory identical | Only `tsc -b` reports tsconfig errors in unanalyzed packages |
| 5 | The Typert workspace root also requires `packages/` | Host tsdown | Within noise | Byte-identical | Dual-face packages get artifacts in `package` mode |
| 6 | Typert generates in a Worker Thread | Host tsdown | 15.39 → 10.25 s | Byte-identical; failures still fail tsdown | Host tsdown max RSS about +0.6 GiB |
| 7 | The Typert `transform` hook filters by module id | Host tsdown | Within noise; hook calls 1,566 → 195 | Byte-identical | None |
| 8 | Client tsdown presets read the manifest from the package directory | Client tsdown | 12.78 → 8.73 s | Byte-identical; external decisions identical | The presets' first argument is the package directory |

The published `./tsdown` export `typertPlugin()` changes with items 5–7 (`transform` as `{ filter, handler }`, an asynchronous `writeBundle`, and a workspace root that must contain `packages/`); rolldown and tsdown consumers accept both hook forms, and the analyzer already required `<root>/packages`, so no external workspace that worked before stops working.

### Measurement conditions

All numbers come from one shared Linux host (256 vCPU, 4 TB memory, load average 23–111 during runs) with Node v24.18.0, TypeScript 6.0.3, and tsdown 0.22.2 (rolldown 1.1.1).

- **Host tsdown:** `node node_modules/tsdown/dist/run.mjs --config-loader native --env.DSH_BUILD_FACE host`, deleting every `lib/typert.*` before each run; variants run interleaved and sequentially, 3–4 samples per group. Items 2–4 come from the first round (starting from the baseline) and items 5–7 from the second round (starting from the code with items 2–4). Output comparison covers SHA-256 of the 743 top-level files of `packages/*/*/lib`, `apps/*/lib`, and `vendor/*/lib` (140 of them Typert artifacts). Medians of two groups running identical code differ by 0–0.11 s; samples within a group spread by up to 2.5 s.
- **Client test aggregate:** `tsc -p tsconfig.client.json --extendedDiagnostics` with prebuilt references and a fresh tsBuildInfo file; six samples of identical code spread by 3.8 s in Check (about 6%).
- **Client tsdown:** `node node_modules/tsdown/dist/run.mjs --config-loader native --env.DSH_BUILD_FACE client` on a built tree. The item 8 prototype ran three rounds in rotated order with a baseline spread of 1.56 s; the final implementation and the original ran interleaved, three samples each. Output comparison covers every file of `{packages,apps,vendor,native}/**/lib/**`, excluding `*.tsbuildinfo`.

### 1. Only the root manifest declares React type packages

- **Purpose:** Reduce the number N of `@types/react` locations that the Client test aggregate program sees from 65 to 1, removing module-specifier work that grows linearly with N.
- **Change:** The root `package.json` declares `@types/react` `~18.3.1` and `@types/react-dom` `~18.3.0` in `devDependencies`, the ranges every package used before; manifests under `apps/*`, `packages/*/*`, and `vendor/*` declare neither in any dependency section. TypeScript resolves the root `node_modules/@types/react` from every package. Packages still declare runtime `react` and `react-dom` under the [Client dependency declaration rules](../../../../packages/client/AGENTS.md#dependency-declaration); `packages/client/ui-slots`, which references React only through `import type`, declares `react` in `devDependencies`. pnpm `dedupeDirectDeps` stays off. Lockfile changes are confined to the importers section, plus one reordered `papaparse` entry with the same integrity.
- **Regression guard:** [`verify-package-dependencies`](../../../../scripts/verify-package-dependencies.ts) runs in `hygiene` and CI. It requires the root manifest's `devDependencies` to declare both packages and rejects either one in the `dependencies`, `devDependencies`, `optionalDependencies`, or `peerDependencies` of any manifest under `apps/*`, `packages/*/*`, or `vendor/*`; the diagnostic names the entry to delete and links Client dependency declaration rule 8. The rule matches only these two exact names; other `@types/*` packages remain DefinitelyTyped type providers. Dependency-section inference does not treat these two packages as type providers for `react`/`react-dom`: when a package lacks a `react` declaration, the verifier reports `react` as missing and `--fix` refuses to repair it until a version range is declared; `--fix` never writes back or deletes the two packages. [`verify-package-dependencies.spec.ts`](../../../../scripts/verify-package-dependencies.spec.ts) covers rejection in each dependency section, a root manifest missing the declarations, the accepted layout, and the type-provider exclusion.
- **Performance:**

  | Measurement | Per-package declarations (N = 65) | Root manifest declaration (N = 1) |
  |---|---|---|
  | Client test aggregate Check | 59.08 s (median of 3) | 26.28 s (median of 5), −56% |
  | Client test aggregate wall | 68–71 s | 33.6–34.9 s |
  | Client test aggregate user CPU | 79–83 s | 44.5–45.3 s |
  | Check sum of the 76 client-only package projects | 34.6 s (median of 2) | 26.5 s (median of 2), −23% |
  | Wall of the 76 client-only package projects | 55.7 s (median of 2) | 44.5 s (median of 2) |

- **Why it is lossless:** The 66 package-level links and the root link share one realpath (`.pnpm/@types+react@18.3.31`), so the program reads the same declarations; the program keeps 2,613 files, and `tsc -b --force tsconfig.client.json` exits 0 without diagnostics. `devDependencies` are not installed with published packages, so the [published dependency faces](2026-08-26-published-dependency-faces.md) conclusion that independent TypeScript consumers install referenced type packages themselves is unchanged; runtime resolution never reads `@types/*`.
- **Trade-off:** Package manifests do not list their own React type dependency, and every workspace package shares one React types version; a package that needs a different version requires a new Agent Note overturning this item. The check covers only `apps/*`, `packages/*/*`, and `vendor/*`; other pnpm members such as `website`, `benchmarks`, `native/system`, and `python/sdk-runtime` are out of scope, and none of them currently declares React type packages.

### 2. Typert selects packages by manifest first

- **Purpose:** Workspace mode generates artifacts only for packages that declare a Typert export, so it skips the surface walk for every other candidate.
- **Change:** `WorkspaceAnalyzer.discoverPackages(includeManifest?)` and `WorkspaceTypertGenerator.discover(faces?, includeManifest?)` accept an optional `package.json` predicate applied before the surface walk; a rejected package has neither its sources read nor its project config parsed. `WorkspaceTypertGenerator.generateContributors(faces?)` passes `hasTypertExport` (`exports` contains `./typert`, `./client/typert`, or `./remote`). Callers that pass no predicate (the Cordis catalog, `generate()` without packages) behave as before.
- **Performance:** Host tsdown 22.62 s → 19.94 s (medians of 3).
- **Why it is lossless:** The predicate is the filter previously applied after discovery, and a package it rejects never produced artifacts; the 743 output files are byte-identical except the Typert generator's own `lib/index.js`, whose source is this change.

### 3. Typert does not expand aggregate `include`

- **Purpose:** The analyzer reads only an aggregate's compiler options and project references; expanding `include` only fills `fileNames`, which it never uses.
- **Change:** `WorkspaceCaches.aggregate(path)` returns and caches `AggregateConfig { path, options, projectReferences }`. An aggregate that declares its own `references` is parsed with a `ParseConfigHost` whose `readDirectory` returns an empty list; an aggregate without `references` is expanded as usual.
- **Performance:** Host tsdown 19.94 s → 16.99 s (medians of 3).
- **Why it is lossless:** TypeScript reports TS18003 (no inputs) only for a config with neither `files` nor `references`, so an aggregate that declares `references` yields the same diagnostics, options, and references without expansion. The registration inventory dumped after forcing every lazy config (408 registrations, including `fileNames` and options, plus the aggregates' options and references) is byte-identical to the baseline, and the outputs are byte-identical. The tests `reads aggregate options and references without expanding include patterns` and `reports an aggregate without references or inputs` pin both kinds of config.

### 4. Typert parses package tsconfigs lazily

- **Purpose:** Parse only the tsconfigs of packages selected for analysis, not every package that an aggregate references.
- **Change:** `PackageRegistration.config` is a getter over `caches.config(configPath)` that parses on first read. The registration inventory keeps its order, faces, names, roots, and export subpaths.
- **Performance:** Host tsdown 16.99 s → 16.25 s (medians of 3), within the 2.5 s within-group spread. Together, items 2–4 reduce Typert discovery in an isolated benchmark from 5.9–7.1 s to 0.36–0.40 s, tsconfig parses from 362 to 28, surface walks from 322 to 28, and total Typert time from 9.7–11.8 s to 4.4–4.5 s.
- **Why it is lossless:** The inventory comparison is the one in item 3 (byte-identical), and the outputs are byte-identical. The test `reads only the project configs of manifests selected for discovery` pins that only selected configs are parsed.
- **Trade-off (not lossless):** Typert does not parse tsconfigs of packages it does not analyze, so a syntax or configuration error in such a tsconfig does not fail Typert. In the same build, the Host package compilation `tsc -b` that runs before the Host bundle and the Client package compilation `tsc -b` parse every referenced tsconfig and reject those errors; the `PackageRegistration.config` JSDoc and the [Typert generator README](../../../../packages/typert/generator/README.md) state this ownership. A consumer that runs Typert without `tsc -b` does not receive those diagnostics.

### 5. The Typert workspace root also requires `packages/`

- **Purpose:** Correct workspace-root resolution. 24 dual-face packages carry their own `tsconfig.host.json` leaf; searching upward for `tsconfig.host.json` alone took each of them as a root, so workspace mode ran one empty discovery per such package per build, and `package` mode silently produced no artifacts for dual-face packages.
- **Change:** The workspace root is the nearest ancestor of the bundle output that contains both `tsconfig.host.json` and `packages/`.
- **Performance:** Host tsdown 14.82 s → 15.39 s (medians of 3), within noise.
- **Why it is lossless:** The repository root [`tsdown.config.ts`](../../../../tsdown.config.ts) uses only workspace mode, and the 743 output files are byte-identical. The test `resolves the workspace root above a dual-face package leaf` pins the rule.
- **Behavior difference:** A `package`-mode consumer building a dual-face package receives that package's Typert artifacts; repository builds do not use `package` mode.

### 6. Typert generates in a Worker Thread

- **Purpose:** Overlap Typert analysis with bundling on the tsdown main thread instead of blocking every package build inside the first `writeBundle`.
- **Change:** [`src/worker.ts`](../../../../packages/typert/generator/src/worker.ts) is the Worker Thread entry; it runs `generateContributors(faces)` and posts one `artifacts` or `failure` message. In workspace mode, the build's first `buildStart` locates the workspace root from `options.cwd` and starts generation; `writeBundle` is asynchronous, the first finishing bundle claims emission and awaits the result, and later bundles return immediately. An analysis error, a worker crash or early exit, a malformed or undeserializable response, or a worker that cannot be terminated fails the claiming bundle with a `TypertWorkerError` naming the workspace and cause, which fails the whole tsdown pass; the worker is terminated before the outcome settles, and an unclaimed outcome never becomes an unhandled rejection. Built output starts the worker from `./worker.js`; source runs (tests) load `worker.ts` through `tsx/esm/api`. `package` mode still generates on the main thread.
- **Performance:** Host tsdown 15.39 s → 10.25 s (medians of 3). Profile of the final configuration (items 2–7): main thread 10.1 s, first `buildStart` at 4.18 s (tsdown config resolution), `writeBundle` on the main thread only 0.37 s; worker 5.0 s (module load about 0.4 s, discovery 0.28 s, generation 3.88 s including `createProgram` 2.21 s), ending at about 9.3 s. Host tsdown wall is about max(bundling, 4.2 s + Typert).
- **Why it is lossless:** All 54 second-round runs exit 0, and each run's 743 output files match the baseline except the generator's own `lib/index.js`. The test `writes the artifacts in-process generation produces` compares worker and in-process artifacts; in a scratch workspace with one package's `files` broken, tsdown exits 1 within 2.4 s, reporting `TypertWorkerError` with the worker's `TypertAnalysisError`, and writes no artifacts. The `typertPlugin workspace mode` test group covers each failure path.
- **Trade-off:** The worker heap is about 300–420 MiB; the final configuration's median Host tsdown max RSS is 6,296–6,408 MiB against 5,676 MiB at baseline. Under heavy shared-host load the worker can land on the critical path: one sample took 21.91 s with the artifact-owning package build waiting about 14 s for the worker, not reproduced in 10 later samples; at load average about 100, two runs took 17.86 s and 14.3 s. The worker also completes under a 1,024 MiB heap limit, so GC pressure is not the cause; attribution to host contention is unproven.

### 7. The Typert `transform` hook filters by module id

- **Purpose:** Stop every module from crossing from rolldown into the JavaScript `transform` hook only to be rejected by an extension check.
- **Change:** `transform` declares `filter: { id: /^[^?]*\.[cm]?tsx?(?:\?|$)/ }`, and its handler still checks the id with the same regular expression.
- **Performance:** Hook calls per Host build fall from 1,566 to 195 (195 TypeScript modules, 4 of them with decorators). Wall medians are 11.07 s (3 samples) and 9.98 s (4 samples) against 10.25 s for item 6, while the identical-code control groups give 11.07 s and 9.87 s; the difference is within noise.
- **Why it is lossless:** The regular expression uses only ASCII constructs and matches the same id set in rolldown's Rust regex engine and in JavaScript; the handler applies the same check, so hosts that ignore filters behave the same. Outputs are byte-identical; the test `filters transform calls to TypeScript module ids` pins the filter.

### 8. Client tsdown presets read the manifest from the package directory

- **Purpose:** Each package config reads only its own `package.json`, removing the glob over every manifest by package name.
- **Change:** The first argument of `clientBundle`, `staticLinked`, and `clientLibrary` in [`packages/client/tsdown.client.ts`](../../../../packages/client/tsdown.client.ts) is the package directory, normally the config file's `import.meta.dirname`; the preset reads `<packageDir>/package.json` once and uses its `name` as the plugin id and diagnostic name; when that manifest is missing, unreadable, or has no `name`, config loading fails with an error naming the path and cause. 82 package configs call these presets. The presets keep no module-level manifest cache; the Node half's production-dependency external list is computed from that manifest on first resolve and cached in that config's closure.
- **Performance:** Client tsdown falls from 12.78 s to 8.73 s (medians of 3), −4.05 s (−31.7%), with disjoint sample ranges; user CPU falls from 26.1 s to 25.2 s and sys from 5.9 s to 4.9 s, so the saving comes mainly from unblocking the main thread rather than from less total CPU. The prototype (one glob building a name index) measured 11.72 s → 7.46 s (−36%). In Host tsdown only 5 `hostPhase` packages reach the lookup; one sample pair measured 11.92 s → 10.71 s, with low confidence.
- **Why it is lossless:** The 11,566 lib files are byte-identical across 11 runs. After the 82 call sites switched to package directories, no resolved package name differs from the name previously written at the call site. An in-process comparison of the external decisions for 82 configs × 3 faces × 1,600 specifiers matches the original implementation exactly; a negative control with one extra external changes 75 decisions. `client-bundle-purity.spec.ts` covers these manifest errors.
- **Behavior difference:** The presets' calling convention changes from a package name to a package directory.

## Alternatives considered

- **Enable pnpm `dedupeDirectDeps` (item 1):** It applies to every direct dependency and changes the link layout of every workspace package, a global side effect.
- **Patch TypeScript (item 1):** An upstream-style patch (precomputed candidate endings and cached normalized `paths` patterns) lowers Check by 31.9 s, comparable to the hoist; on the hoisted tree it adds nothing (references Check 25.76 s against 26.47 s) and must be maintained across every TypeScript upgrade.
- **Alias `react` in tsconfig `paths` (item 1):** tsx, vitest, and vite also read `paths`, so the alias changes their resolution of runtime `react`.
- **Narrow `paths` to each face's reference closure (item 1):** The 328-entry version that keeps wildcard keys checks in 55.73 s against 59.08 s (one sample), within noise; the version without wildcard keys produces 18 diagnostics.
- **Split the Client test aggregate program (item 1):** Every sub-program must inject the 242 files carrying module augmentations to pass, and the visible location count stays at 33–49; splitting into 2, 4, or 8 groups leaves the Check sum nearly flat while user CPU rises by 9%, 30%, and 57%, lowering only wall, and the 4- and 8-group splits each produce 1–2 diagnostics.
- **Cache resolution results and make the discovery queue O(1) (Typert):** After items 2–4 only 28 surface walks remain, about 0.18 s, below noise.
- **Move Typert into a separate build step in artifact builds (Typert):** After item 6 the worker already overlaps bundling, leaving at most about 1 s. Type checks, which need no bundle, run a source-only generation step ([local gate speed-ups](2026-10-12-local-gate-speedups.md)).
- **Filter `transform` by code content (item 7):** rolldown interprets `^` and `\s` with Rust regex semantics, which differ from JavaScript on lone CR, U+2028, and BOM, so a decorated module could be missed.
- **Build a process-wide manifest index on `globalThis` (item 8):** The prototype saves about as much time as item 8, but it is process-global state without an owner, violating the shared-state ownership rule in the [package rules](../../../../packages/AGENTS.md).
- **Disable tsdown's gzip report (item 8):** `--no-report` lowers Client tsdown by 0.95 s, within the 1.56 s baseline spread.
- **Add rolldown filters to DSH `resolveId`/`load` hooks (item 8):** Lowers it by 1.16 s, within noise.
- **Memoize the input-isolation check per module id (item 8):** Lowers it by 0.93 s, within noise; on top of the manifest index it saves only another 0.18 s.

## Consequences

Client type checking spends substantially less CPU and wall time, and the Host and Client tsdown passes take substantially less wall time, without changing runtime resolution, published installation semantics, or any output byte. In the serial build segments (master → branch, one sample each), Host tsdown falls from 22.5 to 11.7 s, Client package compilation from 55.6 to 48.7 s, the Client aggregate check from 68.2 to 35.9 s, and Client tsdown from 13.9 to 10.5 s; the serial segments sum to 308.5 s on master and 254.9 s on the branch (see [the build split note](2026-10-11-build-artifacts-check-split.md)). Host tsdown lies on the critical path of both `build` and `build:artifacts`, Client tsdown on that of `build:artifacts`, and the Client aggregate check is the last step of the `build` critical path.

Costs: every workspace package shares one React types version; Typert does not validate tsconfigs of packages it does not analyze, and `tsc -b` owns those errors; Host tsdown max RSS grows by about 0.6 GiB, and under heavy shared-host load the worker can become Host tsdown's critical path.

Reevaluation conditions: remeasure item 1 when migrating to TypeScript 7, and reconsider per-package declarations if the location count no longer affects Check time. tsdown's own config loading still takes 1.8–2.3 s per Client build (one uncached module instance per config) and needs an upstream change. The first `buildStart` arrives about 4.2 s into the Host build; starting the worker at plugin construction with an explicit root would start Typert earlier.

Verification: the Typert generator's `tsdown-plugin.spec.ts`, `tsdown-plugin-worker.spec.ts`, and `type-model.spec.ts` pin the behavior of items 2–7; the generator tests report 209 passed and 28 skipped, and `tsc -b tsconfig.host.json` exits 0. The repository coverage gate excludes `packages/typert/*/src/**`; under a scratch coverage config, `tsdown-plugin.ts` reaches 100% statements, branches, functions, and lines. Five negative controls (the old root rule, eager package configs, an expanded aggregate, no emission claim, a skipped worker termination) each fail the test that guards them; the real tsdown failure path exits 1 within 2.4 s and reports `TypertWorkerError`. Item 1: `verify-package-dependencies` exits 0 (74 packages), its spec passes 47/47, `verify-client-packages` exits 0, `tsc -b tsconfig.client.json` reports no diagnostics, and the Client aggregate Check takes 26.48 s. Item 8: all 72 focused specs pass.
