# Agent Note: Split build:artifacts and build:check, with build running both concurrently

Status: implemented

English | [中文](2026-10-11-build-artifacts-check-split.zh.md)

## Problem

`pnpm run build` runs the native addon, the package-library build (Host `tsc -b tsconfig.host.json` → Host tsdown → Desktop bundle → Client `tsc -b tsconfig.client.json` → Client tsdown), and the Web build serially. Besides referencing package projects, the Host and Client aggregates each carry a `noEmit` root program covering tests, scripts, benchmarks, and website. These two root programs emit no files and feed no later artifact step, yet sit on the serial critical path: timed alone, the Host root program takes 68.5 s and the Client root program 36.0 s, while the serial package-library build takes about 249 s (median of 2).

Development iterations need only artifacts; test and script type checks are needed before work is declared complete. The only way to skip the two root programs is the CI-oriented `pnpm run build --artifacts-only`, which has no local development command name and no counterpart that runs only those two checks. Meanwhile, `pnpm run build` must stay complete and detect every type error.

## Decision

### Commands

Each command does only its own job.

| Command | Responsibility | Steps | Scheduling | Client build record |
|---|---|---|---|---|
| `pnpm run build:artifacts` | Produces every artifact of `build`; package projects are fully type-checked as usual, the two aggregate root programs are not checked | native → host-src → host-bundle → desktop-bundle → client-src → client-bundle → web | One linear chain | Deleted at start, written after every step passes |
| `pnpm run build:check` | Type-checks only the two aggregate root programs | host-check, client-check | Both steps concurrent, no prerequisite steps | Neither read nor written |
| `pnpm run build` | Every step of `build:artifacts` and `build:check` | The dependency graph below | Concurrent through the run-gates scheduler | Deleted at start, written after every step passes |

`build:check` neither detects, rebuilds, nor validates `build:artifacts` outputs; when prerequisite outputs are missing or stale, the compiler's own diagnostics (for example TS6305 and TS2307) report it, and no command adds prerequisite checks, guards, or fallbacks. `build:artifacts` produces the same artifacts and record as `build` and replaces `--artifacts-only`; that flag and the `libraries` mode of `compile-referenced-projects.ts` are removed, and the Python executable builder uses `--build-artifacts`. `build:official` remains `tsx scripts/build.ts --profile official` and runs the complete `build`.

### Steps and dependencies

| Step | Command | `needs` in `build` |
|---|---|---|
| native | `pnpm run build:native-system` | — |
| host-src | `node --max-old-space-size=4096 <tsc> -b <references of tsconfig.host.json>` | native |
| host-bundle | `tsdown --config-loader native --env.DSH_BUILD_FACE host` (runs Typert) | host-src |
| desktop-bundle | `pnpm --filter @deepseek-ai/dsh-desktop run bundle` | host-bundle |
| client-src | `<tsc> -b <references of tsconfig.client.json>` | desktop-bundle |
| client-bundle | `tsdown --config-loader native --env.DSH_BUILD_FACE client` | client-src |
| web | `pnpm run build:web` | client-bundle |
| host-check | `node --max-old-space-size=4096 <tsc> -p tsconfig.host.json` | host-src |
| client-check | `<tsc> -p tsconfig.client.json` | client-src |

```text
native → host-src ─┬─ host-check ───────────────────────────────────────────────────────┐
                   └─ host-bundle → desktop-bundle → client-src ─┬─ client-check ───────┤ → record
                                                                 └─ client-bundle → web ┘
```

- client-src must follow host-bundle: Client packages import `@deepseek-ai/dsh-*/remote`, whose types `lib/typert.remote-client.d.ts` Typert writes, inside Host tsdown in these scopes and through `scripts/generate-typert.ts` in the typecheck scope. host-check reads no Typert output; clean serial builds have always finished the Host aggregate check before Host tsdown.
- The artifact chain keeps the two non-data edges native → host-src and desktop-bundle → client-src; only the two check steps attach to the chain in parallel.
- [`compile-referenced-projects.ts`](../../../../scripts/compile-referenced-projects.ts) owns the package-library step list `libraryBuildSteps`, the references argument construction `referencedProjectsCompilerArgs` (relative paths keep the command below Windows' command-line limit), and the aggregate-check arguments `aggregateCheckArgs`. The vendor release rehearsal (`host-libraries`) and CI benchmarks (`--noCheck`) run the same step list serially.
- The check steps use project mode (`tsc -p`): it reads the declarations that references already emitted and compiles no reference, writing incremental state to the aggregates' existing `tsconfig.{host,client}.tsbuildinfo`. `build` and `build:check` run the same command, so their diagnostics are identical.

### Scheduling, failure, and output

- [`scripts/build.ts`](../../../../scripts/build.ts) owns the step table and the three scopes and executes them through `runAggregate` from [`scripts/run-gates.ts`](../../../../scripts/run-gates.ts): each step is a gate with `needs`, and shell-free spawning, per-step buffered output, fail-fast process-tree termination, Windows `taskkill`, and host signal forwarding come from the run-gates implementation. `build:artifacts` is `tsx scripts/build.ts --scope artifacts`, `build:check` is `--scope check`, and `build` omits `--scope` and runs both as one graph; `--profile` applies only to artifact scopes, and combining it with `--scope check` fails argument parsing.
- The concurrency limit is `DSH_GATE_CONCURRENCY`, defaulting to the available CPU count; the dependency graph is at most 3 wide (client-check and client-bundle can start while host-check is still running). Master serial reference lanes set `DSH_GATE_CONCURRENCY=1`, so `build` runs serially in topological order there, consistent with the [serial reference decision](2026-07-21-serial-cross-platform-ci-reference.md) and without workflow edits.
- By default (locally), every dependent of a failed step is recorded as skipped, while running steps and steps unrelated to the failure run to completion; the executed set depends only on step outcomes, so one run reports every independent type error. With `DSH_GATE_FAIL_FAST=1` (set in every building PR lane), the first failure terminates the process trees of the other running steps and records every unfinished step as skipped.
- A failed step prints `== FAILED <step> ==`, its command, the exit reason, and the step's complete buffered output, and the final summary lists failed and skipped steps; a passing step prints only its PASS line, and `DSH_GATE_VERBOSE=1` prints all output. The exit code is 1 when any step failed or was skipped, and the client build record is not written. Every step inherits the public Client environment selected by `clientBuildProcessEnvironment`.
- In CI, `build` itself is one gate of an outer run-gates aggregate; outer fail-fast termination propagates to the inner scheduler. `check:node-compat` and `check:ci:lint:contracts-ready` already nest the same way.

### Callers

| Caller | Command | Aggregate root-program checks |
|---|---|---|
| `build`, `build:official`, `Makefile` `build`, `scripts/publish-npm-baseline.ts`, `apps/desktop/scripts/package-target.ts`, `scripts/dev-bundle-registry.ts`, `release-publish.yml`, `sandbox.yml`, and the non-PR branches of `e2e.yml` and `release.yml` | `build` / `build:official` | Yes |
| `test:web`, `test:web:refresh`, `test:web:perf`, `test:web:stress`, `apps/desktop` `test:updates:local`, `test:bench` / `build:bench` | `build`; `build:bench` runs `build:native-system`, `build:lib`, and the benchmark tsdown | Yes |
| `typecheck` (run by the pre-push hook) | `build.ts --scope typecheck`: host-src beside host-typert (the bundle-free, source-only Typert pass `generate-typert.ts`) → client-src, with `tsc -b tsconfig.{host,client}.json` after each face's package compilation; no bundle | Yes |
| `dev:web` ([`scripts/dev-web.ts`](../../../../scripts/dev-web.ts)), `dev:desktop` (`apps/desktop/scripts/dev.ts`) | `build:artifacts` | None before launch; after `dev:web` launches, its `tsc -b tsconfig.client.json --watch` keeps checking the Client aggregate root program |
| Prerequisite step of `lint`, `lint:fix`, `doc-typecheck`, and the CI Typert contracts gate | Host package compilation beside the bundle-free Typert pass (`compile-referenced-projects.ts host-contracts`), without any bundle | None |
| CI node 24 / snapshots and artifacts (`check:ci:consumers`), windows node 24 / build & observational (`check:ci:windows-blocking`) | `build` | Yes, the two required lanes |
| CI node-compat 22.19 | `build:artifacts` (through run-gates) | None |
| CI python runtime | `build-exe-for-python-sdk.ts --build-artifacts` | None |
| PR rehearsals in `e2e.yml` and `release.yml` | `pnpm run build:artifacts --profile official` | None |
| `build-preview-cloudflare.yml` | `pnpm run build:artifacts` | None |
| CI node 24 / benchmarks | `run-ci-bench.ts` (`tsc -b --noCheck`) | None |
| PR rehearsal in `release-vendor.yml` | `compile-referenced-projects.ts host-libraries` | None |
| Non-PR branch of `release-vendor.yml`, `release-vendor-publish.yml` | `build:lib:host` | Host aggregate root program only |

`lint`, `lint:fix`, `doc-typecheck`, and the Typert contracts gate read only Typert outputs and package declarations: both aggregates are `noEmit`, oxlint builds its own programs, `doc-typecheck` references only package projects, and none of them reads a bundle. Their prerequisite step therefore skips the Host aggregate check and every bundle; skipping the Host aggregate check and the Desktop bundle alone took it from 159.8 s to 90.9 s (see the measurements below).

The consumers lane's HMR Web test starts `dev:web` and therefore uses `build:artifacts` inside that lane; the same lane's `build` gate still runs both aggregate checks. CI does not call `build:check` separately: the two required lanes already get the same checks through `build`. The [PR artifact build decision](2026-10-05-pr-artifact-typechecks.md) keeps its required complete builds, benchmark `--noCheck`, job and worker ceilings, serial node-compat Vitest, coverage weights, and pnpm packing checks; its PR artifact build is `build:artifacts`.

### Measurements

Prototype conditions: a shared 256 vCPU Linux host (load average 23–70), Node v24.18.0, TypeScript 6.0.3, React type packages hoisted to the root, without the Typert changes of [the lossless speed-ups note](2026-10-11-lossless-build-speedups.md); scope is the package-library build (excluding native and web). Every round starts from `pnpm run clean`, running once each in the order serial, concurrent, `build:lib`, `build:lib`, concurrent, serial; `/usr/bin/time -v` times each step, and summed process-tree RSS is sampled every 250 ms. The prototype runs the aggregate checks as `tsc -b tsconfig.{host,client}.json` once references are up to date, when build mode builds only the aggregate root program.

| Mode (medians of 2) | Wall (s) | CPU user+sys (s) | Process-tree RSS peak (GiB) |
|---|---|---|---|
| Serial `pnpm run build:lib` | 249.4 | 378.0 | 5.95 |
| Each step run separately in sequence | 255.1 | 373.8 | 5.82 |
| Concurrent by dependency graph | 172.1 | 392.1 | 8.00 |

Median wall falls from 249.4 s to 172.1 s (−77.3 s, −31%). The two runs of each step separately differ by 28 s, so the overhead of running the steps as separate processes is not resolvable. CPU grows by about 14 s (+3.7%), mostly Host aggregate check user time under contention; the RSS peak grows by about 2.1 GiB where the Host aggregate check (about 4 GiB) overlaps Host tsdown (about 5.7 GiB). The concurrent critical path is host-src → host-bundle → desktop-bundle → client-src → client-check; host-check finishes about 33 s before the end and client-bundle about 21 s before.

Final measurements: master (the merge base) and this branch run interleaved, each from clean, in a 64-core cgroup; values are medians of 2 samples unless marked n=1.

| Scenario | master | This branch | CPU user+sys (master → branch) | Process-tree RSS peak (master → branch) |
|---|---|---|---|---|
| Complete build `pnpm run build` | 317.1 s | 169.1 s (−46.7%) | 423.1 → 374.4 s (−11.5%) | 6.11 → 7.53 GiB (+1.42) |
| Serial branch build `DSH_GATE_CONCURRENCY=1 pnpm run build` (n=1) | — | 266.7 s | 389.5 s | 6.27 GiB |
| Artifact build: master `build --artifacts-only`, branch `build:artifacts` | 185.8 s | 153.6 s (−17.3%) | 256.2 → 231.2 s | 6.58 → 6.18 GiB |
| Development iteration: master `build`, branch `build:artifacts` | 317.1 s | 153.6 s (−51.6%) | 423.1 → 231.2 s (−45.4%) | 6.11 → 6.18 GiB |
| `pnpm run build:check` after `build:artifacts` | — | 67.7 s | 144.6 s | 5.33 GiB |
| `pnpm run build:check` no-op rerun | — | 19.4 s | 33.1 s | Not measured |
| Prerequisite of `lint` and `doc-typecheck`: master `build:lib:host`, branch `host-libraries` (since replaced by `host-contracts`, see [local gate speed-ups](2026-10-12-local-gate-speedups.md)) | 159.8 s | 90.9 s (−43.2%) | 234.7 → 136.0 s | Not measured |

The serial branch sample overlapped other work on the host (742 s of foreign CPU), so its wall likely overstates the serial cost. In the serial build segments (master → branch, one sample each), Host tsdown falls from 22.5 to 11.7 s, Client package compilation from 55.6 to 48.7 s, the Client aggregate check from 68.2 to 35.9 s, and Client tsdown from 13.9 to 10.5 s; the segments sum to 308.5 s and 254.9 s. Those reductions come from [the lossless speed-ups note](2026-10-11-lossless-build-speedups.md); the further reduction from 254.9 s of serial segments to the 169.1 s concurrent build comes from this note's scheduling, which takes the Host aggregate check (about 66 s) off the critical path. In the concurrent build, the critical path is native → host-src → host-bundle → desktop-bundle → client-src → client-check, and host-check ends about 30 s before the last step (one earlier sample). `build:check` runs the Host and Client aggregate checks concurrently, so its wall is the Host check's (about 65 s).

### Completeness and lossless evidence

`build` runs the same set of compiler programs as the serial build: host-src and client-src compile every package project of both faces, and host-check and client-check check both aggregate root programs with the same commands as `build:check`. Across the prototype's six rounds, the 11,580 files of `{packages,apps,vendor,native}/**/lib/**` (excluding `*.tsbuildinfo`) are byte-identical between serial and concurrent runs, and after every round `tsc -b --dry tsconfig.host.json tsconfig.client.json` reports no out-of-date project. tsbuildinfo writers are host-src (292), client-src (76, exactly the client-only projects), and one per aggregate check; client-src rewrites no tsbuildinfo or declaration that host-check reads, so the graph has no write race. The fixture tests `checks only the aggregate program in project mode` and `reports missing package declarations without compiling references` show that `tsc -b --dry` treats the tsbuildinfo written by `tsc -p` as up to date and that project mode compiles no reference. In this implementation, the concurrent `build` and `DSH_GATE_CONCURRENCY=1 pnpm run build` produce byte-identical `lib/` (11,584 files), `apps/web/dist` (156 files), and client build record; afterwards `tsc -b --dry` reports all 372 projects of both aggregates up to date, with none to build.

| Error | `build:artifacts` | `build:check` | `build` | `typecheck` | Required CI lanes |
|---|---|---|---|---|---|
| Package source type error | host-src / client-src | Not reported (reads existing declarations) | host-src / client-src | Reported | Reported |
| Type error only in an aggregate root program's tests, scripts, benchmarks, or website | Not reported | host-check / client-check | host-check / client-check | Reported | consumers, windows-build |
| Package tsconfig configuration error | host-src / client-src | Not reported (`tsc -p` does not validate referenced projects' tsconfig options or syntax) | host-src / client-src | Reported | Reported |
| Typert analysis error | host-bundle | Not reported | host-bundle | Reported (through host-typert) | Reported |
| Missing prerequisite output | — | Compiler diagnostic (TS6305, TS2307) | — | — | — |

Negative controls: after a type error (TS2322) is added to `scripts/pnpm-invocation.spec.ts`, which only the Host aggregate root program contains, `build:artifacts` exits 0; `build:check` exits 1 with the Host aggregate check failing and the Client aggregate check passing; `build` exits 1 with 8 of 9 steps passing and 1 failing, and writes no client build record. In a scratch fixture whose referenced project's tsconfig has an invalid `target`, a JSON syntax error, or an unknown compiler option, `tsc -p` exits 0, while `tsc -b` reports TS6046, TS5092 with TS1012, and TS5023 respectively and exits 1; when the referenced project lacks `composite`, both report TS6306.

CI evidence: on PR #6005 both required lanes that run the concurrent `pnpm run build` passed, `node 24 / snapshots and artifacts` (`check:ci:consumers` on `blacksmith-16vcpu-ubuntu-2404`) and `windows node 24 / build & observational` (`check:ci:windows-blocking` on `blacksmith-16vcpu-windows-2025`); the GitHub-hosted 4 vCPU benchmarks lane does not run `build`. The inner concurrency follows `DSH_GATE_CONCURRENCY`: master serial lanes set 1, the consumers lane sets 10 under self-hosted failover, and an unset value selects the available CPU count, capped at the 9 steps.

### Intentional trade-offs (not lossless)

- **Some commands skip the aggregate checks:** `build:artifacts`, the launch builds of `dev:web` and `dev:desktop`, and the prerequisite steps of `lint`, `lint:fix`, `doc-typecheck`, and the Typert contracts gate do not type-check the two aggregate root programs, and these prerequisite steps produce declarations and Typert outputs but no bundle. `build`, `build:check`, `typecheck` (pre-push hook), and the two required CI lanes own completeness; `dev:web` and `dev:desktop` do not refuse to launch because of test type errors.
- **`build:check` does not check freshness:** When sources change after `build:artifacts`, `build:check` checks against stale declarations, including Typert Remote declarations; rerun `build:artifacts` first. The complete `build` is unaffected.
- **Concurrent `build` raises the memory peak:** This branch's complete `build` peaks at 7.53 GiB of process-tree RSS against 6.11 GiB for the master serial build (+1.42 GiB, medians of 2) and 6.27 GiB for the branch's serial build (n=1); CPU meanwhile falls from 423.1 s to 374.4 s because [the lossless speed-ups note](2026-10-11-lossless-build-speedups.md) removes more work than concurrent contention adds. In the prototype (without the Typert changes), concurrent scheduling alone raises the RSS peak by about 2.1 GiB (5.9 → 8.0 GiB) and CPU by about 3.7%. `DSH_GATE_CONCURRENCY` bounds it; under memory pressure use `DSH_GATE_CONCURRENCY=1 pnpm run build`, or run `build:artifacts` and `build:check` separately. In the windows-build lane, `build` runs concurrently with `docs:build`.
- **Passing steps' output is hidden by default:** Only failed steps print their complete output.
- **`tsc -p` does not skip an up-to-date root program:** An immediate rerun of `build:check` without changes still takes 19.4 s and 33.1 s of CPU because both programs are parsed again; `tsc -b` skips an up-to-date root.
- **On many-core cold builds `build:artifacts` is only 15.5 s faster than `build`:** This branch's cold `build` takes 169.1 s and `build:artifacts` 153.6 s (medians of 2), because host-check is off the critical path and client-check is only about 16 s longer than client-bundle plus web. The rest of `build:artifacts`'s saving is CPU and memory: 374.4 → 231.2 s of CPU and 7.53 → 6.18 GiB of peak RSS; on few-core machines and in incremental rebuilds this also turns into wall time.
- **CI invokes public commands in the root manifest:** PR artifact builds invoke `build:artifacts` rather than an internal helper flag; a PR that edits these root manifest scripts activates the separate Node Addon System platform matrix.

## Alternatives considered

- **Keep the aggregate checks only in `typecheck`:** `pnpm run build` must stay complete and detect every error.
- **Keep `--artifacts-only` and add a `build:artifacts` alias:** One operation would have two names.
- **Name the commands `build:src` and `build:test`:** `build:artifacts` produces every artifact, including the tsdown bundles, the Desktop bundle, and Web, not only compiled sources; `build:check` checks scripts, benchmarks, and website code as well as tests.
- **Name the commands after compiler terms (`build:b`/`build:p`, `build:project`, `build:emit`) or `build:dist`:** tsc runs in only two artifact steps, and `-p` is an implementation choice for the check steps; TypeScript calls the `tsc -p` side the project; `emit` reads as the emit-only `--noCheck` mode although package projects stay fully checked; package outputs live under `lib/`, and `dist` suggests release packaging.
- **`build:check` runs `tsc -b <aggregate>`:** Build mode compiles out-of-date references, doing `build:artifacts`'s work.
- **`build:check` first completes or validates prerequisite outputs:** It violates each command doing only its own job and adds prerequisite logic; compiler diagnostics already name missing outputs.
- **A new scheduler (shell `&`/`wait`, `concurrently`, turbo/nx):** It duplicates run-gates' failure summary, process-tree termination, and Windows handling.
- **Expand `build` into several gates in CI's run-gates:** `pnpm run build` must be a complete command usable directly locally and by release workflows, and it writes the record.
- **Relax the non-data edges in the artifact chain (native ∥ host-src, desktop-bundle ∥ client-src):** Not measured; the Desktop bundle itself takes only 4.0–4.5 s.
- **Move tests into a new tsconfig:** The existing aggregates already separate package references from the root program.
- **Split the aggregate root programs into sub-programs:** Each sub-program must inject the 242 files carrying module augmentations, CPU grows by 9–57%, and only wall falls (see [the lossless speed-ups note](2026-10-11-lossless-build-speedups.md)).
- **Run `build:check` separately in CI:** The required lanes already get the same checks through `build`; a separate run repeats the work.

## Consequences

Development iterations can skip the two aggregate root programs with `build:artifacts` (51.6% faster cold than master's `build`) and complete the checks with `build:check` or `build` before declaring work complete. `build` stays complete: the Host aggregate check is off the critical path, the Client aggregate check runs alongside the Client bundle and web, and a cold build is 46.7% faster than master (including the lossless speed-ups note's changes; medians of 2). The costs are a higher memory peak, a little extra CPU from concurrent contention, less passing output by default, and several development and prerequisite commands that do not check test types (see the trade-offs above).

Removing or changing `build` in the two required lanes, consumers and windows-build, requires first transferring both aggregate checks to another blocking owner. The typecheck scope and the lint prerequisites generate Typert contracts without bundling ([local gate speed-ups](2026-10-12-local-gate-speedups.md)); the artifact scopes keep generating them inside Host tsdown.

client-src's dependency on host-bundle guarantees the "Host and Remote artifacts complete before Client compilation" ordering that [Typert Remote method calls](../architecture/2026-08-02-typert-remote-method-calls.md) describes.

Verification: `scripts/build.spec.ts` covers the type-stripping check, rejection of the removed flag and invalid scopes, the conflict between `--profile` and `--scope check`, scope selection, step dependencies, and the environment; `compile-referenced-projects.spec.ts` covers project mode checking only the aggregate program, the diagnostic for missing declarations, and `tsc -b --dry` accepting the tsbuildinfo that `tsc -p` writes; failure propagation, output buffering, and process-tree termination come from the run-gates scheduler and its tests; `run-gates.spec.ts`, `ci-workflow.spec.ts`, `preview-workflow.spec.ts`, `build-exe-for-python-sdk.spec.ts`, `dev-web.spec.ts`, and `tests/ci-release-selfhosted.spec.ts` pin each caller's command.
