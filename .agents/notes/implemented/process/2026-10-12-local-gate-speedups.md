# Agent Note: Local gate, hook, and test speed-ups

Status: implemented

English | [中文](2026-10-12-local-gate-speedups.zh.md)

## Problem

On the baseline, master at the merge of #6013, local runs of the Git hooks, `pnpm run test`, `test:docs`, and `doc-sync` spend most of their wall time on work that their results do not depend on:

- **Typert declarations from the bundler.** `typecheck`, the command the pre-push hook runs, executes `build:lib:host` (Host `tsc -b tsconfig.host.json`, the Host tsdown pass, and the Desktop bundle) before `tsc -b tsconfig.client.json`. The prerequisite of `lint`, `lint:fix`, `doc-typecheck`, and the CI `typert-contracts` gate runs Host package compilation and then the Host tsdown pass (`compile-referenced-projects.ts host-libraries`). Type checks read only package declarations and Typert declarations, yet `typecheck` with nothing to recheck takes 34.1/35.0 s and the prerequisite takes 52.2/29.6 s.
- **Third-party notices on every commit.** The pre-commit hook regenerates `THIRD_PARTY_NOTICES.md` whenever a staged file is a generator input. To find browser-side third-party imports, the generator test-bundles 75 Client packages and runs one Vite build, so every package source file is an input; on a commit that stages one file under a package `src/` subdirectory, the hooks take 16.5/17.8 s, of which the notices job takes 12.4/13.4 s.
- **Host CPUs as the local worker count.** `os.availableParallelism()` reports the host's CPUs (256 on the measurement host) rather than the container's CPU quota (64). With that default, `pnpm run test` starts 255 Vitest forks, peaks at 55.3 GiB RSS, and fails 12 additional files (14 timeouts) intermittently, while `doc-sync`, `test:docs`, `hygiene`, and `check:all` run at most 4 gates concurrently.
- **One Git prefix lookup per candidate.** `verify-repository-references` resolves each of about 26,000 abbreviated hexadecimal candidates with a Git prefix lookup through `git cat-file --batch-check`; the lookups take 135.7 s of the gate's 166.8 s.
- **Repeated Markdown parsing.** markdown links parses each anchor target twice more and probes target existence without a cache; translation pairing globs four times and parses each document again after link normalization; the package README model-experience and limitations checks each parse every README three times; type equivalence parses all 1,835 documents; Session format references parses each pair four times.
- **Repeated directory reads.** `uniqueRepoFiles`, the walker behind markdown wrap, doc refs, and package paths, reads each directory once per pattern and `**` level and resolves every matched file with `realpath`.
- **Serial help launches and repeated compiler probes.** `gen-cli-help` launches its 12 top-level source-mode `dsh … --help` processes one after another, each waiting mostly on profile boot I/O (49.9/53.9 s); `gen-doc-graphs` builds several compiler hosts and programs that repeat the same `ts.sys` file-system probes (48.7/44.7 s).
- **A test file bound by file-system probes.** Each of the 61 cases of the Typert generator's `type-model.spec.ts` copies its fixture to disk and runs a full analysis whose four TypeScript programs each load the DOM library, `@types/node`, and zod v4, about 22,000 stat calls per analysis. The file takes 316.3/329.1 s and is the long tail of `pnpm run test`.

## Decision

The eight decisions below shorten those runs. Each item states the evidence that its outputs and diagnostics stay the same, or the intended difference it accepts.

| # | Decision | Affected commands | Measured wall | Outputs and diagnostics | Intended behavior difference |
|---|---|---|---|---|---|
| 1 | Type checks generate Typert declarations without bundling | `typecheck`, `lint`, `lint:fix`, `doc-typecheck`, CI `typert-contracts` | `typecheck` 34.1/35.0 → 21.9/20.0 s; prerequisite 52.2/29.6 → 12.5/11.3 s | 140 Typert files byte-identical; the same programs are checked | No runnable bundle and no client build record |
| 2 | The pre-commit hook does not regenerate third-party notices | `pre-commit` | 16.5/17.8 → 4.3/4.5 s | Freshness asserted in the test lane | Stale notices fail in the test lane, not at commit |
| 3 | Local default worker budget | run-gates aggregates, `build`, `typecheck`, `pnpm run test`, Oxlint, publint | `test` at 255 workers: 243.7 s, 55.3 GiB; `test:docs` 74.7 → 50.9 s | Same checks | Local defaults ignore CPUs above 12 or 48 |
| 4 | Repository-reference candidates resolve against one object listing | `verify-repository-references` | 166.8 → 15.7 s | 0 classification differences over 27,050 candidates | None |
| 5 | Documentation gates parse each document once | markdown links, translation pairing, README model experience and limitations, type equivalence, Session format references | markdown links 53.4/51.6 → 25.9/25.1 s; type equivalence 23.0/22.5 → 6.0/5.5 s | Byte-identical gate output | None |
| 6 | Repository file walks list each directory once | markdown wrap, doc refs, package paths | doc refs 8.8/7.0 → 3.2/3.4 s | Identical file lists | doc refs does not read nested `lib` directories |
| 7 | CLI help reads run concurrently; doc-graph probes are memoized | `verify-cli-help`, `verify-doc-graphs` | 49.9/53.9 → 6.9/7.2 s; 48.7/44.7 → 32.7/34.2 s | Byte-identical pages | CLI help uses about 3.6 GB at peak |
| 8 | `type-model.spec.ts` runs against an in-memory workspace | `pnpm run test` | 316.3/329.1 → 14.65/15.04 s | Same 61 cases and assertions; one snapshot line differs | Stubs replace zod, `@types/node`, and the DOM library outside the Emitter case |

### Measurement conditions

All numbers are wall times from one shared Linux container with a 64-CPU quota on a host that reports 256 CPUs, at a one-minute load average of 20–150, so samples carry noise. The working tree lives on a network filesystem, where each file-system probe costs more than on a local disk. `a/b` lists two samples, and `x → y` compares the baseline with this implementation.

### 1. Type checks generate Typert declarations without bundling

- **Purpose:** Give `typecheck` and the prerequisite of `lint`, `lint:fix`, `doc-typecheck`, and the CI `typert-contracts` gate the declarations they read, package declarations from `tsc` and Typert declarations, without the Host tsdown pass or the Desktop bundle.
- **Change:** `typecheck` is `tsx scripts/build.ts --scope typecheck`, which runs the steps below through the run-gates scheduler ([`scripts/build.ts`](../../../../scripts/build.ts)). The scope builds no native addon, tsdown bundle, Desktop bundle, or Web output, writes no client build record, and leaves runnable `lib/` output as the last `build:artifacts` left it; run `build:artifacts` before launching or testing built output. The prerequisite of `lint`, `lint:fix`, `doc-typecheck`, and `typert-contracts` is `compile-referenced-projects.ts host-contracts`, which runs host-typert before host-src ([`compile-referenced-projects.ts`](../../../../scripts/compile-referenced-projects.ts)). `build`, `build:artifacts`, benchmark builds, and the vendor rehearsal use the same source-only generation before compilation ([ordering decision](2026-10-18-source-first-metadata-builds.md)).

- **Shared generation:** [`scripts/generate-typert.ts`](../../../../scripts/generate-typert.ts) calls `WorkspaceTypertGenerator.generateContributors()` for `WORKSPACE_TYPERT_FACES` ([`scripts/typert-faces.ts`](../../../../scripts/typert-faces.ts)), the repository generation faces, and writes the result with `writeWorkspaceArtifacts()` from [`artifact-files.ts`](../../../../packages/typert/generator/src/artifact-files.ts), the writer the plugin uses. Like the plugin, it skips TypeScript diagnostics, which Host package compilation reports; a Typert analysis error fails host-typert before dependent compilation. host-typert runs under Node with tsx's ESM hook rather than through `pnpm exec`, whose startup would lengthen the path to Client compilation.
- **Aggregate checks in build mode:** host-check and client-check start after their own face's package compilation, so build mode finds every reference up to date, checks only the aggregate root program, and skips a root program whose tsbuildinfo is current.
- **Source-only analysis:** host-typert can run before host-src because its Host program reads no workspace build output. `tsconfig.base.json` maps `@deepseek-ai/dsh-client-file-upload/types` to source; without that alias the specifier resolves through package `exports` to `lib/types/types.d.ts`. With it, the Host program loads 1,289 files, none of them under a workspace package's `lib/`. `generate-typert.ts` enables `rejectBuildOutputs`: [`build-output-guard.ts`](../../../../packages/typert/generator/src/build-output-guard.ts) fails analysis with a `TypertAnalysisError` when a face program loads a file from a workspace package's `lib/` directory, or cannot resolve an import of a workspace package, as on a tree whose packages are not yet compiled, naming each such import specifier and the `paths` entry that maps it to source. Either way a missing alias fails generation whether or not host-src has run. The public tsdown plugin retains its independent generation policy; root artifact builds use the source-only pass. The [Typert generator README](../../../../packages/typert/generator/README.md) documents the writers and the option.
- **Why it is lossless:** No workspace tsconfig sets `allowJs`, every `exports` `types` condition points into `lib/types/` or at `lib/typert.*`, and every tsdown config sets `dts: false`, so no type check reads tsdown output. The 140 Typert files (28 packages × 5 outputs) are byte-identical across the baseline tsdown pass, the current tsdown pass, `generate-typert.ts` after every Typert output is deleted, and `generate-typert.ts` with all 344 `lib/types` directories hidden; with one Remote method temporarily added to `packages/goal/goal`, the tsdown pass and `generate-typert.ts` also write identical files. `typecheck` checks every package project of both faces and both aggregate root programs, the programs that `build` checks.
- **Performance:** `typecheck` with nothing to recheck takes 34.1/35.0 → 21.9/20.0 s. When both aggregate root programs must be rechecked, it takes 83.5 → 76.0/72.1 s, and its critical path is the Host aggregate check at about 66–70 s. The prerequisite of `lint` and `doc-typecheck` takes 52.2/29.6 → 12.5/11.3 s.
- **Trade-off:** `typecheck`, `lint`, `lint:fix`, `doc-typecheck`, and `typert-contracts` write Typert declarations but no bundle, so runnable `lib/` JavaScript can lag behind those declarations until the next `build:artifacts`.
- **Relation to the build:** [Source-first metadata ordering](2026-10-18-source-first-metadata-builds.md) owns generation placement and its measured cost. Declaration-only commands still omit bundling. [The build split note](2026-10-11-build-artifacts-check-split.md) owns command responsibilities.
- **Known gap:** Incremental `tsc -b` does not record `lib/typert.remote-client.d.ts`, which Client sources reach through package `exports`, as an input of the consuming project; when a Remote signature changes and no Client source does, an incremental check does not recheck the consumers. The gap is independent of which pass writes the declarations; Issue #6022 tracks it.

### 2. The pre-commit hook does not regenerate third-party notices

- **Change:** The `pre-commit` hook in [`lefthook.yml`](../../../../lefthook.yml) has no third-party notices job. [`gen-third-party-notices.spec.ts`](../../../../scripts/gen-third-party-notices.spec.ts) asserts the committed bytes of `THIRD_PARTY_NOTICES.md` in the test lane, including the required `node 24 / coverage` lane, and names `pnpm run gen-third-party-notices` when they are stale. [The generated third-party notices note](2026-07-30-generated-third-party-notices.md) owns this freshness decision.
- **Performance:** A commit that stages one file under a package `src/` subdirectory spends 4.3/4.5 s in the hooks instead of 16.5/17.8 s, of which the notices job took 12.4/13.4 s.
- **Trade-off:** A commit that leaves the notices stale fails in the test lane after push rather than being corrected at commit time.

### 3. Local default worker budget

- **Purpose:** Size default parallelism for a shared workstation or container, where Node reports host CPUs rather than the CPU quota.
- **Change:** [`scripts/parallelism.ts`](../../../../scripts/parallelism.ts) owns the default. With `CI=true` it is the CPU count Node reports. Otherwise it is capped at 12 (`LOCAL_PARALLELISM_CAP`) for the run-gates scheduler, `build`, `typecheck`, Oxlint, and publint, and at 48 (`LOCAL_TEST_PARALLELISM_CAP`) for Vitest forks and the local coverage budget. `doc-sync`, `test:docs`, `hygiene`, and `check:all`, whose gates each build a full `ts.Program`, run at most 8 gates concurrently, in CI as well. Explicit `DSH_GATE_CONCURRENCY`, `DSH_OXLINT_THREADS`, `DSH_COVERAGE_MAX_WORKERS`, and Vitest `--maxWorkers` take precedence; in CI, Vitest and Oxlint keep their own defaults unless the run-gates CI environment sets these variables. The [development guide](../../../../docs/development.md) states the defaults for contributors.

`pnpm run test` at four fork counts, with the disk-backed `type-model.spec.ts` that item 8 replaces, which sets the wall of the 32-worker run:

| Vitest workers | Wall | Peak RSS | Additional intermittent failures | Every file except the slowest finished at |
|---|---|---|---|---|
| 255 (the reported CPU count) | 243.7 s | 55.3 GiB | 12 files, 14 timeouts | about 135–170 s |
| 32 | 310.4 s | 15.7 GiB | 4 files, 4 timeouts | 193 s |
| 24 | 337.2 s | 13.2 GiB | 5 files, 5 timeouts | 233 s |
| 12 | 410.5 s | 8.4 GiB | 2 files, 3 timeouts | 406 s |

- **Oxlint:** Oxlint's own default is 64 threads, read from the cgroup quota; at 12 threads its wall stays about 87–90 s with about 15% less CPU, and at 8 threads it takes about 4 s longer.
- **Documentation aggregates:** `test:docs` takes 50.9 s at 8 concurrent gates against 74.7 s at 4. `doc-sync`, measured without item 4, takes 341.8, 295.0, and 253.2 s at 4, 8, and 12 concurrent gates, with peak RSS of 10.0, 13.5, and 16.3 GiB.
- **Trade-off:** A machine whose CPU quota exceeds the caps gets no more default parallelism than 12 or 48 and needs the override variables; a container whose quota is below a cap still oversubscribes, because Node reports host CPUs. At 8 concurrent gates `doc-sync` peaks at 13.5 GiB RSS against 10.0 GiB at 4; 12 concurrent gates finish 41.8 s sooner at 16.3 GiB. The CI documentation workflow also runs `doc-sync` at 8 concurrent gates.

### 4. Repository-reference candidates resolve against one object listing

- **Change:** [`verify-repository-references.ts`](../../../../scripts/verify-repository-references.ts) lists every object name once with `git cat-file --batch-all-objects --batch-check=%(objectname)`, about 1.2 million objects in 0.6 s, sorts the list, and binary-searches each lowercase candidate prefix in memory; one `--batch-check=%(objectname) %(objecttype)` call then reads the types of the matched objects. A candidate is a commit reference only when its prefix matches exactly one available object and that object is a commit, the rule Git's own prefix lookup applies; the listing covers unreachable and alternate objects, as Git's lookup does.
- **Performance:** 166.8 → 15.7 s.
- **Why it is lossless:** Git's per-candidate prefix lookup and the in-memory search classify all 27,050 real and synthetic candidates identically, including ambiguous prefixes, blob and tree prefixes, and random strings.
- **Trade-off:** The listing is about 49 MiB of Git output for 1.2 million objects, read under a 1 GiB output limit.

### 5. Documentation gates parse each document once

- **Change:** Each gate below parses a Markdown document once and passes the tree to every consumer in that run.

| Gate | Single-parse mechanism | Wall |
|---|---|---|
| markdown links ([`verify-md-links.ts`](../../../../scripts/verify-md-links.ts)) | One per-run cache parses each file once for its destinations and anchors and probes each resolved target once | 53.4/51.6 → 25.9/25.1 s |
| translation pairing ([`verify-translation-pairing.ts`](../../../../scripts/verify-translation-pairing.ts)) | One glob covers every scope pattern; the record reuses the authored tree under the guard below | 51.0/47.1 → 30.3/29.3 s |
| package README model experience, package README limitations | Each check parses a README once and passes the tree to `markdownProseLines()` and `markdownHeadingLines()` | about 12 → 5.9 s each |
| type equivalence ([`verify-type-equiv.ts`](../../../../scripts/verify-type-equiv.ts)) | A text prefilter skips documents that cannot hold a source-equivalence fence; each manifest TypeScript source is parsed once | 23.0/22.5 → 6.0/5.5 s |
| Session format references | The persistence renderer passes the trees it parses to the pairing record | 10.2 → 5.3 s |

- **Pairing reuse guard:** `normalizedTopLevelBlocks()` in [`translation-pairing-record.ts`](../../../../scripts/translation-pairing-record.ts) reuses the authored tree for normalized text only when every link-normalization edit replaces a complete, title-free destination that does not start a line, the authored text equals the node's `url`, and both the authored and the replacement text contain only `[A-Za-z0-9._/:#%-]`. Those characters cannot end a destination or start or end another construct, so the normalized text parses to the same nodes with shifted offsets. Any other edit falls back to a full parse of the normalized text.
- **Type-equivalence prefilter:** [`type-equiv-prefilter.ts`](../../../../scripts/type-equiv-prefilter.ts) keeps a document for parsing when it contains `type-equiv` or `public-api`, or when a line containing `` ``` `` or `~~~` also contains `&` or `\`. Parsing changes an info string only by decoding character references and backslash escapes, so `ts type&#45;equiv` and `ts type\-equiv` keep their documents; [`type-equiv-prefilter.spec.ts`](../../../../scripts/type-equiv-prefilter.spec.ts) covers both forms.
- **Why it is lossless:** Every gate's output on the repository is byte-identical, and seeded faults are reported identically. For pairing, the top-level blocks of all 1,886 corpus documents and the records of all 943 pairs match those of a full reparse, as do randomized destinations.

### 6. Repository file walks list each directory once

- **Change:** `uniqueRepoFiles()` in [`scripts/repo-files.ts`](../../../../scripts/repo-files.ts) shares one directory-listing cache across all patterns of a call, so each directory is read at most once, and calls `realpath` only for matches reached through a symbolic link; a regular file reached through real directories canonicalizes to the repository's realpath joined with its relative path. Its optional `skipDirectory` predicate keeps the walker out of a directory whose every path the caller excludes; [`verify-doc-refs.ts`](../../../../scripts/verify-doc-refs.ts) skips every `lib` directory below the first path segment, whose files it excludes in any case.
- **Performance:** markdown wrap 25.8/25.0 → 21.3/21.2 s; doc refs 8.8/7.0 → 3.2/3.4 s; package paths 9.9/8.1 → 7.2/5.5 s.
- **Why it is lossless:** All three gates receive identical file lists, and a broken or cyclic symbolic link still fails through `realpath`.
- **Behavior difference:** doc refs does not list a skipped `lib` directory, so an unreadable one does not fail the gate with EACCES.

### 7. CLI help reads run concurrently; doc-graph probes are memoized

- **CLI help:** `prefetchHelp()` in [`scripts/gen-cli-help.ts`](../../../../scripts/gen-cli-help.ts) starts the 12 top-level `dsh … --help` reads (the launcher, `plugin`, and each profile's shorthand and `--profile` forms) within the default worker budget, each with its own temporary `DSH_HOME` and `DSH_AGENTS_HOME`, and the in-order traversal consumes them; nested reads share the same limit. A failed read reaches the traversal when it requests that invocation, and `close()` aborts queued and running reads and waits for every started child. The gate takes 49.9/53.9 → 6.9/7.2 s.
- **Doc graphs:** `withMemoizedFileSystemProbes()` in [`scripts/gen-doc-graphs.ts`](../../../../scripts/gen-doc-graphs.ts) memoizes `ts.sys` `fileExists`, `directoryExists`, `realpath`, `readDirectory`, and `getDirectories` while `renderDocs` runs, so every compiler host and config parse in one run shares one view of the file system. The workspace must not change during the run, and the original methods are restored before pages are written. The gate takes 48.7/44.7 → 32.7/34.2 s.
- **Why it is lossless:** Both generators produce byte-identical pages.
- **Trade-off:** The concurrent help processes use about 3.6 GB of memory combined at peak.

### 8. `type-model.spec.ts` runs against an in-memory workspace

- **Change:** [`type-model.spec.ts`](../../../../packages/typert/generator/tests/type-model.spec.ts) mocks `node:fs` with `memoryFileSystem()` and the `ts.sys` host from [`type-model-workspace.ts`](../../../../packages/typert/generator/tests/type-model-workspace.ts), so fixture copies, case edits, write-mode annotations, tsconfig expansion, and module resolution under the in-memory root never touch the disk. Each workspace mounts minimal `zod` and `@types/node` declaration stubs; only the Emitter case keeps real zod. The fixture's `tsconfig.base.json` sets `lib: ["ES2024"]`, which excludes the DOM library, and cases that read the unmodified fixture share one deep-frozen analysis. The generator source has no test-specific path.
- **Performance:** The file alone takes 316.3/329.1 → 14.65/15.04 s.
- **Why the behavior coverage stays:** The 61 case names and their assertions are the same. The snapshot differs in one line, the external zod symbol path, which names the stub (`<external>:node_modules/zod/index.d.ts#ZodType`) rather than a pnpm store version.
- **Trade-off:** Outside the Emitter case, the spec does not exercise the analyzer against the real file system, the DOM library, or the real zod and `@types/node` declarations. The memory file system implements only the `node:fs` calls the analyzer makes (`existsSync`, `readFileSync`, `realpathSync`, and `writeFileSync`); another call on an in-memory path reaches the real file system, where the path does not exist.

### Repository-wide comparison

Both trees were measured in the same session, alternating baseline and implementation runs of each command after `pnpm run build:artifacts` (`pnpm run test` fails the same environment-dependent files on both trees, 42 on the baseline and a subset of 28 here):

| Command | Baseline | This implementation | Change | Items |
|---|---|---|---|---|
| `pre-commit` hooks, one staged file under a package `src/` subdirectory | 16.5/17.8 s | 4.3/4.5 s | −75% | 2 |
| `pnpm run typecheck` (pre-push), nothing to recheck | 29.7/23.3 s | 14.2/16.1 s | −43% | 1, 3 |
| `pnpm run lint` | 110.0 s | 106.7 s | −3% | 1 |
| `pnpm run doc-typecheck` | 45.2 s | 36.1 s | −20% | 1 |
| `pnpm run test:docs` | 102.4/104.0 s | 26.8/29.3 s | −73% | 3–6 |
| `pnpm run doc-sync` | 186.8 s | 70.3 s | −62% | 3–7 |
| `pnpm run test` | 222.7 s (255 workers) | 148.1 s (48 workers) | −34% | 3, 8 |

`lint` time is Oxlint itself; its prerequisite falls as item 1 states. CPU time falls with wall: `typecheck` user time 39.5 → 14.2 s, `test:docs` 212.6 → 126.3 s, `doc-sync` 628.2 → 503.2 s, and `test` 3,417 → 3,014 s.

## Alternatives considered

- **Cap every local default at 12, including Vitest forks (item 3):** `pnpm run test` takes 410.5 s at 12 workers against 243.7 s at 255, 68% longer.
- **Use half of the cgroup CPU quota as the local budget (item 3):** Reading the quota is a larger change and helps only inside containers.
- **Parse documents in parallel `worker_threads` (item 5):** It adds more complexity than parsing each document once, which removes the repeated work itself.
- **Regenerate third-party notices in the pre-commit hook (item 2):** Browser inputs make every package source file a generator input, so the hook runs the 16-second generator on nearly every commit while few commits change its output; [the generated third-party notices note](2026-07-30-generated-third-party-notices.md) owns the decision.

## Consequences

The pre-push `typecheck` with nothing to recheck takes about 14–22 s, the `lint` and `doc-typecheck` prerequisite about 12 s, and the hooks of a one-file commit about 4 s. `pnpm run test` starts at most 48 forks locally, and `test:docs` and `doc-sync` run up to 8 gates at once. Typert outputs, generated pages, file lists, and reference classifications are byte-identical to the baseline.

Costs: type-check commands do not refresh runnable bundles; a stale notices file fails in the test lane after push; local defaults ignore CPUs above the caps and still oversubscribe a container whose quota is below them; 8 concurrent documentation gates raise the `doc-sync` RSS peak; CLI help uses about 3.6 GB at peak; doc graphs and markdown links assume the tree does not change during a run; `type-model.spec.ts` exercises stubs rather than real zod, `@types/node`, the DOM library, and disk I/O outside the Emitter case; and incremental `typecheck` inherits the Remote-declaration gap that Issue #6022 tracks.

Verification: `generate-typert.spec.ts` pins byte-identical files against the workspace-mode plugin, rejection of a Host program that loads a compiled workspace declaration with the missing alias named, and each failure stage; `compile-referenced-projects.spec.ts` pins the `host-contracts` steps and their failure reporting; `build.spec.ts` pins the typecheck scope's steps; `parallelism.spec.ts`, `run-gates.spec.ts`, and `run-oxlint.spec.ts` pin the CI and local budgets and the overrides; `repo-files.spec.ts`, `markdown.spec.ts`, `translation-pairing.spec.ts`, `type-equiv-prefilter.spec.ts`, `verify-md-links.spec.ts`, `gen-cli-help.spec.ts`, and `gen-doc-graphs.spec.ts` pin single directory listing, parse reuse, the pairing guard, the prefilter, the prefetch order and failure path, and probe memoization with restoration.
