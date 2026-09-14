# Agent Note: Published dependency faces and bounded peer relays

Status: implemented

English | [中文](2026-08-26-published-dependency-faces.zh.md)

## Problem

A package may contain a browser bundle, a Host entry, shared TypeScript declarations, and Cordis injection metadata. Encoding all of those relationships as required npm peers made the published CLI expensive to install: npm installs peers automatically and repeatedly evaluates placement through deep, converging peer paths. Changing ranges or making the peers optional did not remove that traversal.

The package that chooses a Client build input is the shipped profile, while a Host value import is loaded by Node from the importing package. Those relationships need different npm sections. Applying one rule to every Host package would reduce the graph but would also create a large migration with no corresponding installation benefit.

## Decision

### Package selection

[`verify-package-dependencies`](../../../../scripts/verify-package-dependencies.ts) owns dependency-section policy. It always covers packages under `packages/client/` and every non-experimental package that declares `dsh.client`. Inside the directory, `dsh.client` marks a Client/Host package whose Host entry is scanned; a package without that declaration is a Client-only static build input. Outside the directory, `dsh.client` selects the same Client/Host scan. A `"./client"` export alone is an API and does not select npm dependency policy.

[`package-dependency-policy.ts`](../../../../scripts/package-dependency-policy.ts) provides explicit Client-face include and exclude lists. An include handles an exceptional package without `dsh.client`, while an exclude removes an automatically discovered dual-face package outside `packages/client/`. The verifier rejects unknown, stale, redundant, duplicate, overlapping, and ineffective entries. The include list is empty; the exclude list contains `@deepseek-ai/dsh-api-session-controller` and `@deepseek-ai/dsh-api-workspace-controller`. Adding Session Controller back would migrate nine more Host edges while its five-run candidate retest improved median resolution by only 0.15 seconds.

Host-only packages join the same policy through a separate explicit list. The list contains `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-session`; source imports do not expand it.

### Dependency sections

Every covered package keeps `@deepseek-ai/cordis` in matching `peerDependencies` and `devDependencies`. Cordis is the shared plugin runtime whose identity the application controls.

A workspace package reached by a runtime value import from the Host entry closure belongs only in `dependencies` when its complete runtime entry is listed in `duplicateSafePackages`, or when every imported runtime export appears in `safeHostDependencyExports`. The package-level list contains `@deepseek-ai/dsh-brand`, `@deepseek-ai/dsh-typert-protocol`, `@deepseek-ai/dsh-util-crypto`, and `@deepseek-ai/dsh-util-values`: their values are stateless, structurally recognized, or stored through versioned interoperable descriptors. The export table handles reviewed values from packages whose other exports cannot make the same guarantee.

An export whose constructor identity or module state must be shared appears in `peerRequiredHostExports`; importing one such export keeps the whole package edge in matching `peerDependencies` and `devDependencies`. Each export-table key is an exact module specifier and each value is a reviewed export set. The verifier follows runtime local imports from the Host entry, records named and default imports and re-exports, and rejects exports covered by neither the package list nor an export table; namespace, dynamic, and side-effect imports remain unbounded unless the complete exact entry is package-classified.

Workspace imports used by the Client bundle, type-only imports, module augmentations, `dsh.client.inject`, and existing metadata-only peers belong only in `devDependencies`. Host runtime imports, including additional Node entries, follow the Host classification. [Browser third-party build inputs](2026-09-08-browser-third-party-build-inputs.md) governs ordinary third-party declarations; it partially supersedes their preservation in this decision. Workspace references use `workspace:^`.

Some development relationships exist only in `dsh.client.inject` or TypeScript project references. The policy's `configurationOnlyDevDependencies` table names only those reviewed edges and keeps them in `devDependencies`.

The verifier reads source manifests and source files, so it runs on a clean tree without built `lib/`. Every selected Host face must have `src/index.ts`. An unclassified Host runtime export is a policy violation that blocks all `--fix` writes; a maintainer must review the export and classify it, change the source relationship, or change the package selection. Once source safety passes, `--fix` performs only the section and range changes implied by the classification and removes stale peer metadata.

### Maintainer workflow

Run the verifier without `--fix` for a read-only check of package selection, export classifications, dependency sections, workspace ranges, and peer metadata. An unclassified runtime import reports one clickable `path:line:column` diagnostic per imported export.

```sh
pnpm run verify-package-dependencies
```

Classify each new Host runtime export in [`package-dependency-policy.ts`](../../../../scripts/package-dependency-policy.ts) before generating manifests. `duplicateSafePackages` permits every runtime export from one exact root entry as an ordinary dependency; `safeHostDependencyExports` permits only listed exports; `peerRequiredHostExports` keeps the whole provider package edge in matching peer and development sections. An export may receive only one classification. After removing a package-wide identity or state requirement, classify its root entry at package level; after changing one export in a mixed package, update the exact export table. An edge becomes an ordinary dependency only after none of its imported exports remain peer-required.

Generate the managed manifests and every directly derived artifact with one command. `--fix` writes nothing while a policy violation exists; after success it refreshes `pnpm-lock.yaml`, regenerates both module-graph languages and their pairing record, and prints the ordinary-dependency and peer-required edge lists.

```sh
pnpm run verify-package-dependencies -- --fix
git diff -- packages pnpm-lock.yaml docs/module-graph.md docs/module-graph.zh.md docs/module-graph.i18n.yaml
```

Measure the working-tree graph and a Git ref through the local metadata-only registry. Each run creates a fresh consumer and npm cache, replaces inherited npm configuration with explicit peer, hoisting, and registry settings, executes `npm install --package-lock-only`, rejects archive downloads, and leaves the repository unchanged. `--runs` controls repetitions, `--timeout-ms` terminates the npm process tree after its deadline, and optional `--max-ms` makes the command fail when the slowest run exceeds a threshold.

```sh
pnpm run benchmark:npm-resolution -- --runs=5 --timeout-ms=300000
pnpm run benchmark:npm-resolution -- --ref=origin/master --runs=5 --timeout-ms=300000
```

Verify package placement through two incompatible synthetic DSH releases. The verifier copies every current DSH manifest into `0.1.0` and `0.2.0`, asks npm for a package lock only, and rejects cross-release DSH resolution, unexpected DSH locations, unequal release inventories, multiple Cordis installations, and package archive requests. The local index contains only installed current-platform metadata, so npm-accepted probes for unavailable optional packages are reported without failing the check.

```sh
pnpm run verify-npm-install-layout
```

Rank the next Host package by applying the current policy in memory, measuring a baseline, trying each reachable unconfigured package, and serially retesting the fastest coarse candidates. Positive `gainSeconds` is `baseline median - candidate median`; `--candidates` limits the roster, `--jobs` controls coarse concurrency, and neither phase writes manifests. A selected candidate still requires export classification before it joins `hostPackages`.

```sh
pnpm run benchmark:npm-resolution:next -- --runs=1 --finalist-runs=5 --finalists=5 --jobs=8 --timeout-ms=120000
```

### Performance verification

[`verify-npm-install-layout`](../../../../scripts/verify-npm-install-layout.ts) is a deterministic package-path and version check in the `Release (dsh)` workflow on every pull request and master push; it does not enforce resolver duration. [`benchmark-npm-resolution`](../../../../scripts/benchmark-npm-resolution.ts) and [`benchmark-next-package-dependency`](../../../../scripts/benchmark-next-package-dependency.ts) remain manual because resolver time varies with machine load and metadata completion order. Their fresh-consumer, metadata-only runs isolate npm's dependency-tree calculation from registry latency and archive downloads, so relative results identify peer relays without creating a release-time performance promise.

The generated policy currently leaves 27 managed Host runtime edges in `dependencies` across 13 packages. Two edges remain in `peerDependencies`: `dsh-api-remotes → dsh-scope` for `carrierKeyOf`, and `dsh-session → dsh-scope` for `scopeOf` and `scopeTarget`.

## Alternatives considered

**Keep internal relationships as peers.** npm must place and validate each required peer along converging ancestry paths, which recreates the reported install-time failure even when all internal versions are compatible.

**Use the `"./client"` export as the Client-face roster.** A package may publish Client-facing types or a browser API without contributing a dynamically loaded row. Selecting that package broadens the migration to unrelated Host packages such as Goal, Session Title, and Todo. `dsh.client` identifies dynamic rows, while the `packages/client/` directory independently covers static Client inputs.

**Flatten every Host package.** This removes more peer work but expands the migration to packages whose individual benchmark result is negligible. The explicit Host list preserves the remaining peer contracts until measurement justifies another entry.

**Move every Client-related declaration to development-only.** A dual-face package's Host value imports remain real Node loads. Omitting them from the published dependency graph makes the package depend on accidental hoisting by a profile.

**Enforce a wall-clock threshold in CI.** Resolver time varies with machine load and metadata completion order. Deterministic manifest classification belongs in CI; timing remains a maintainer benchmark.

## Consequences

The published dependency graph follows artifact ownership instead of source-directory coupling. Client bundles and shipped profiles provide browser identities, Host modules install duplicate-safe values they load, and Cordis plus explicitly peer-required Host exports retain shared package instances.

Moving a public type-only relationship to `devDependencies` means a standalone TypeScript consumer must install the referenced type package when it consumes that declaration. The shipped profiles install the complete supported package family; supporting independently assembled TypeScript consumers would require a different policy.

The explicit overrides, Host list, package classifications, and export classifications are reviewable decisions. Class constructors used by `instanceof`, private symbols, and module-local registries require peers when identity or inaccessible state crosses package boundaries. A stable structural marker or versioned prototype descriptor can make a specific value interoperable, but being a value import alone does not. Changing a classification changes the installed graph and requires the focused verifier tests, the two-release layout check, and a fresh next-package benchmark. The metadata-only benchmark is diagnostic evidence, not a release-time performance promise.
