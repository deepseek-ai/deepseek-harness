# Development guide

English | [中文](development.zh.md)

The setup tutorial takes a new contributor from prerequisites to a checked checkout. The contributor reference that follows covers repository layout, daily workflow, and CI organization. Design rationale and implementation details belong to the linked Agent Notes and scripts.

## Setup tutorial

### Prerequisites

- Node.js 24.9 or newer. CI covers 24.9, the latest 24, and 26; see the [Node engine floor Agent Note](../.agents/notes/implemented/process/2026-10-15-node-24-runtime-floor.md).
- Node.js TypeScript type stripping enabled. The repository build scripts load `tsdown.config.ts` with tsdown's native config loader, so they fail when `--no-experimental-strip-types` is in `NODE_OPTIONS` or the Node.js build lacks TypeScript support; `pnpm run build` checks this first and names the cause.
- Corepack-enabled pnpm. The repo pins `pnpm@11.28.5` in `package.json`; run `corepack enable` if `pnpm --version` does not resolve through Corepack.
- Git 2.26 or newer; hook setup enables Git's worktree-specific configuration extension.
- Optional: a DeepSeek API key for the Web, headless, and ACP automation demos and real-API e2e tests.

### Windows and WSL 2

On Windows, you can develop with native tools or use WSL 2 for a Linux environment. WSL 2 is useful for verifying Linux behavior and for using Linux toolchains when native dependency compilation or filesystem permissions obstruct Windows development. Each environment needs its own runtime, build tools, and permissions; WSL is optional.

Keep the checkout, installed dependencies, and toolchain in the same operating system environment. For WSL 2, store the checkout in the Linux filesystem; for native Windows tools, use the Windows filesystem. Accessing files across the two filesystems adds overhead to I/O-intensive operations such as Git, dependency installation, and builds. See Microsoft's [file storage and performance guidance](https://learn.microsoft.com/en-us/windows/wsl/filesystems#file-storage-and-performance-across-file-systems).

Install dependencies separately in each environment because native binaries and links can differ between operating systems. Test results apply to the environment where the tests ran; Windows-specific behavior still needs native Windows validation.

### First-time setup

pnpm uses its strict symlinked linker so undeclared dependencies fail instead of relying on hoisting. Keep dependency build scripts explicitly allowlisted in `pnpm-workspace.yaml`.

Install dependencies from the repo root:

```sh
pnpm install
```

The install also configures worktree-local Lefthook hooks through `scripts/install-lefthook.mjs`. The [worktree-local hooks Agent Note](../.agents/notes/implemented/process/2026-07-27-worktree-local-lefthook.md) owns the hook-path safety contract.

The [DevTools frontend](../packages/experimental/inspector/README.md#use-this-package) is compiled locally from a pinned npm source package and Vite. After dependencies are installed, its build needs no network access or browser installation. Workspace and published-package installation run no DevTools resource-download hook; published Inspector packages contain the built frontend.

If the hooks are missing because dependencies were restored from cache or `postinstall` was skipped, install them manually:

```sh
node scripts/install-lefthook.mjs
```

If the wrapper rejects existing Git configuration or reports a stale lock, follow its diagnostic and the linked Agent Note rather than editing worktree metadata speculatively. After moving a checkout, rerun the wrapper to regenerate the owned path.

Run typecheck once after a fresh clone:

```sh
pnpm run typecheck
```

Setup is complete when `pnpm run typecheck` exits successfully.

## Contributor reference

### TypeScript project layout

The repository uses isolated Host and Client aggregates. An ordinary package is registered in exactly one aggregate: Host packages in `tsconfig.host.json` and Client packages in `tsconfig.client.json`; three packages (`host/webserver`, `compaction/compaction`, `typert/registry`) are referenced by both aggregates as shared leaves so each side type-checks the same source.

| File | Role | Forms a program? |
|---|---|---|
| `tsconfig.json` | Solution root: `extends` base, `files: []`, and references to the two aggregates. It is the tsserver discovery entry and the entry for explicitly running the complete Project Reference graph; through the inherited `paths`, it is also the resolution config for tsx running `scripts/`. | No |
| `tsconfig.host.json` | Host aggregate: Host packages, examples, tests, scripts, website, and the exceptional Host project of `api/remotes`. | Yes |
| `tsconfig.client.json` | Client aggregate: `packages/client/*` packages and their tests, `apps/web`, and the exceptional Client project of `api/remotes`. | Yes |
| `tsconfig.base.json` | Shared compilerOptions and the source `paths` map. Also the resolution facade the vitest configs point vite-tsconfig-paths at: it has no `include`, so its `paths` apply to every importer. | No |
| `tsconfig.base.client.json` | Browser compiler settings (`jsx`, DOM libs, `types: []`) extended by the Client aggregate and every `packages/client/*` package. | No |

Host and Client stay two aggregate programs because both sides declaration-merge the cordis `Context` interface under the same keys with different services; one program seeing both merges reports a collision. The collision exists only inside a `ts.Program` — module resolution never triggers it — which is why the solution may reference both aggregates and one paths facade may span both sides. Three disciplines follow:

- `tsconfig.base.json` never gains `include` or `files`: they would leak into every extending package project and narrow the facade's match-all scope.
- A script that builds a repo-wide `ts.Program` seeds `tsconfig.host.json` or `tsconfig.client.json` explicitly — never the root solution, because flattening both aggregates into one program collides the `Context` merges.
- A new package is registered in exactly one aggregate; only the split packages above carry both leaf configs, and the shared leaves are registered in both aggregates because each side must type-check the same source. Having both a Node loader entry and a browser entry is not a reason to split a package; an ordinary Client plugin produces both runtime artifacts during the Client build phase.

Seven packages split Host and Client tsconfigs: `api/remotes`, `api/gateway`, `api/session-controller`, `api/workspace-controller`, `client/connection`, `session-query/session-log-export`, and `experimental/liveshare-protocol`. `api/remotes`' Host entry participates in the Host Typert graph while its Client entry imports generated `/remote` declarations; `session-log-export` keeps Node archive production out of its browser controller; `liveshare-protocol` keeps the Node wire codecs on its Host leaf and the browser viewer carrier on its Client leaf. Each split package-root `tsconfig.json` is therefore only a solution, and the two aggregates and direct consumers reference `tsconfig.host.json` or `tsconfig.client.json` respectively. The workspace `constraints` gate walks the reachable Project Reference graph and checks each referencing project's own compiler face: a single-config target remains valid from either face, while a split target must name the matching leaf rather than its solution root or opposite leaf; it discovers split packages from the presence of both leaf configs, so a new split joins the gate automatically. The [`api-remotes` README](../packages/api/remotes/README.md) and [`session-log-export` README](../packages/session-query/session-log-export/README.md) explain their splits.

`pnpm run build:artifacts` emits every artifact, checking and compiling only the package references of each compiler face. Client compilation waits for Host and Desktop bundling to finish: split compiler faces rewrite shared `lib/types` files read by those bundles. Client bundling follows Client compilation. The artifact order is:

```sh
pnpm run build:native-system
pnpm exec tsx scripts/generate-typert.ts
tsc -b <tsconfig.host.json references>
tsdown --env.DSH_BUILD_FACE host
pnpm --filter @deepseek-ai/dsh-desktop run bundle
tsc -b <tsconfig.client.json references>
tsdown --env.DSH_BUILD_FACE client
pnpm run build:web
```

`pnpm run build:check` runs only `tsc -p tsconfig.host.json` and `tsc -p tsconfig.client.json` concurrently. Project mode checks each aggregate's repository-wide test and script program against the package declarations already on disk and never compiles a reference, so `build:check` neither detects nor rebuilds missing or stale `build:artifacts` output; missing output surfaces as compiler errors. `pnpm run build` runs both step sets as one [scheduled](../scripts/run-gates.ts) dependency graph: each aggregate check starts once its own face's package compilation finishes and overlaps the remaining artifact steps. In all three commands `DSH_GATE_CONCURRENCY` bounds concurrent steps (`1` runs them in dependency order) and `DSH_GATE_FAIL_FAST=1` stops the remaining steps at the first failure; otherwise a failure skips only its dependents, so independent errors are all reported. A failed step prints its own output, and any failure exits non-zero without writing the client build record.

Choose the command by what the change needs:

| Situation | Command |
|---|---|
| Iterating on package sources and needing runnable artifacts | `pnpm run build:artifacts`; `dev:web` and `dev:desktop` run it before launching |
| Type-checking tests, scripts, benchmarks, or website code | `pnpm run build:check` after the latest `build:artifacts`; rerun `build:artifacts` first when package sources changed |
| Before declaring TypeScript work complete | `pnpm run build:check` after the latest `build:artifacts`, or `pnpm run build` |
| Complete verification, as the required CI build lanes run it | `pnpm run build` |
| Type checks without the Web and Desktop artifacts | `pnpm run typecheck` |
| Lint or documentation code-block checks | `pnpm run lint` or `pnpm run doc-typecheck`; each prepares `host-contracts` itself |

PR artifact builders run `build:artifacts`; required Linux and Windows normal builds and public `typecheck` also check the repository-wide test and script programs. CI benchmark preparation additionally uses `--noCheck` for its disposable library outputs, relying on those required builds for diagnostics; other artifact builders keep package checking ([rationale](../.agents/notes/implemented/process/2026-10-05-pr-artifact-typechecks.md)).

Both tsdown passes match `vendor/*`, `packages/*/*`, and `apps/cli`; the Host pass also matches `apps/desktop-host`. They neither scan build artifacts to discover Client packages nor maintain a Host/Client package filter list. Package-local tsdown configs select entries for the current phase through `DSH_BUILD_FACE`: an ordinary Client plugin produces both its Node loader and browser bundle during the Client phase; `api-remotes` uses `hostPhase: true` to produce its Host entry early and only its browser bundle during the Client phase. Tsdown consumes only the JavaScript emitted to `lib/types` by the preceding tsc phase. Tsdown builds the matched workspace members concurrently, so `apps/desktop`, whose main bundle inlines workspace devDependencies from their `lib/` output, bundles in its own step after the Host pass ([Desktop README](../apps/desktop/README.md#bundled-workspace-dependencies)).

Typert analyzes Host types through `tsconfig.host.json` and generates Host reflection and Host-for-Client Remote declarations before package compilation. The source-only [`generate-typert.ts`](../scripts/generate-typert.ts) pass rejects workspace imports that require built output, including metadata dependencies that return to generated declarations. Host tsdown lowers source decorators without generating metadata again; Client tsdown also consumes the existing metadata. `pnpm run typecheck` generates metadata, compiles Host and Client packages in reference order, and checks each aggregate with `tsc -b` after its package compilation. It skips the native addon, bundles, Web, and the client build record. `lint`, `lint:fix`, and `doc-typecheck` prepare metadata and Host package declarations through `compile-referenced-projects.ts host-contracts`; generation failure stops dependent compilation. These declaration-only commands do not update runtime bundles: run `build:artifacts` before launching or testing built output.

`pnpm run build` and `build:artifacts` embed the root package version, the seven-character source commit, and a dirty marker when Git reports local changes; they also inherit other caller-supplied `DSH_CLIENT_*` values. `pnpm run build:official` is the cross-platform local equivalent of the CI and release artifact build and omits the local dirty marker. Each successful `build` or `build:artifacts` writes a gitignored record that binds the exact public values to the Vite output and dynamic client bundles; release packing and built Web tests reject a missing record or artifacts changed by a later partial build. `pnpm run dev:web` runs `build:artifacts` first (`--skip-build` reuses an existing artifact tree instead), then samples the current version and Git state once and shares that environment across every watcher stage for the session; it does not validate the complete-build record because the watcher stages rewrite its recorded artifacts.

`pnpm run build --profile local` explicitly selects local client branding, preserves repository version, commit and dirty metadata, and discards inherited client title and other public overrides. `build:official` retains its exact official values. [Desktop packaging](../apps/desktop/packaging/README.md#configuration-and-local-builds) selects the profile for each signing mode.

Static analysis and tests resolve workspace imports through the base `paths` map to `src` and must pass on a clean tree; gates that consume built `lib/` output declare that dependency explicitly. Generated Host-for-Client Remote declarations are the deliberate exception: the public `typecheck`, `lint`, and `doc-typecheck` commands generate them first, while internal `*:contracts-ready` scripts assume that an invoking public command or scheduler gate already depends on the Typert contract-generation pass or the complete build. See the [Typert Remote note](../.agents/notes/implemented/architecture/2026-08-02-typert-remote-method-calls.md) for the gate-preparation contract.

Business services declare callable methods on the Host with `@Remote` or `@RemoteScope`; the Host build generates Host-for-Client types and runtime contributions, and the Client's `api-remotes` composition loads those contributions under `ctx.remote` and scoped `agentCtx.remote` namespaces. See [API Gateway](api-gateway.md) for the generated artifacts on both sides, their assembly relationships, the SRC development fallback, and the Web build order.

If a relevant local check consumes built package output, build once first:

```sh
pnpm run build
```

`pnpm run hygiene` includes `publint`, which validates package entrypoints against the built `lib/*.js` files, and `verify-node-next-types`, which validates built declarations against a temporary NodeNext consumer. A fresh worktree has no bundled JS or declarations until `pnpm run build` runs; ordinary commits and pushes do not require that build unless their selected checks consume it.

### Environment variables

The real DeepSeek adapter and key-backed agent demos read credentials from the environment or from a gitignored `.env` at the repo root:

```sh
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://... # optional
```

`DEEPSEEK_BASE_URL` is optional and defaults to the public API. Never commit real credentials. The real-API e2e suites self-skip when `DEEPSEEK_API_KEY` is not set.

### Git integrations

`.i18n.yaml` records use Git's default text merge. A record conflicts only when both branches changed language-specific content in the same heading section; resolve the Markdown, then rerun `pnpm run verify-translation-pairing --write <pair>`. If `pre-merge-commit` rejects an otherwise clean merge, Git leaves the complete result staged without a commit; repair the failure and run `git commit`, or run `git merge --abort`.

lefthook is configured in `lefthook.yml` as a fast local checkpoint:

- `pre-commit` verifies staged pairing records against the staged owner blobs, validates staged files with the project-free `.oxlintrc.staged.json` profile and applies Oxlint fixes with one bounded retry, checks the staged diff for whitespace errors, checks pi-ai provider metadata when its inputs or generated file are staged, and runs the vendor manifest guard.
- `pre-merge-commit` performs the same index-backed pairing check before Git creates an automatic merge commit.
- `pre-push` runs `pnpm run typecheck`, which generates Typert contracts without bundling before the Client TypeScript check and checks both aggregates.

The vendor manifest guard checks that changes under `vendor/*/src` are staged with the matching `vendor/README.md` manifest update. See `vendor/README.md` before editing vendored code.

The pi-ai check regenerates expected metadata in memory. It rejects stale data without rewriting or staging files. After a pi-ai dependency or generator change, follow the package's [provider metadata update steps](../packages/llm/llm-pi-ai/README.md#generated-provider-metadata).

Apart from the scoped pairing and provider metadata checks, the hooks intentionally do not run tests, snapshots, documentation checks, builds, or hygiene. Contributors run the [checks relevant to the changed behavior](../AGENTS.md#run-relevant-checks-locally) once; CI owns exhaustive coverage, built-artifact smokes, and the Node 24.9, latest 24, and 26 compatibility matrix.

Contributors can opt into the comprehensive local gate set with `pnpm run check:all`. The command is independent of the Git hooks and is not an agent instruction.

Outside CI (`CI` other than `true`), default worker counts follow the [local worker budget](../scripts/parallelism.ts): 12 for gate schedulers, `build`, `typecheck`, Oxlint, and publint, and 48 for Vitest forks and local coverage. `doc-sync`, `test:docs`, `hygiene`, and `check:all` run at most 8 gates at once, in CI as well. `os.availableParallelism()` reports host CPUs rather than a container's CPU quota, so uncapped defaults oversubscribe shared hosts. CI keeps the runner's CPU count. `DSH_GATE_CONCURRENCY`, `DSH_OXLINT_THREADS`, `DSH_COVERAGE_MAX_WORKERS`, and Vitest `--maxWorkers` override the defaults.

### CI gates

The keyless [CI workflow](../.github/workflows/ci.yml) groups independent gates into broad lanes and runs a smaller compatibility signal across supported Node versions. Artifact consumers wait for one build within their lane. Coverage partitions reuse file timings scoped to their platform and runner pool to balance work within the configured worker limit. Native Windows lanes run in the separate [CI Windows workflow](../.github/workflows/ci-windows.yml) and Python checks in the separate [CI Python workflow](../.github/workflows/ci-python.yml), each of which can be re-run independently. Required benchmarks run separately on standard GitHub-hosted Linux; the [benchmark runner reference](../benchmarks/AGENTS.md) owns routing and the job timeout. The separate real-API workflow runs `pnpm run test:e2e` with its configured worker bound. See [scripts/run-gates.ts](../scripts/run-gates.ts) and the workflow files for the current gate and job inventory.

The credential-free dsh dependency-layout and dsh/vendor pack rehearsals use the existing Linux self-hosted pool only when `DSH_CI_FAILOVER_LINUX=selfhosted` and the event is a trusted master push or same-repository, non-fork, non-Dependabot pull request. All other cases, including manual dispatch, use `ubuntu-24.94`; manual publication stays hosted. See the [release rehearsal runner reference](../.agents/notes/implemented/process/2026-07-26-ci-failover-runbook.md) for persistent-store isolation and fallback limits.

### Daily commands

The root [contributor instructions](../AGENTS.md#commands) summarize common commands, while [`package.json`](../package.json) and [scripts/run-gates.ts](../scripts/run-gates.ts) own the current script and gate inventories. Select the smallest checks that cover the changed surface. Documentation changes use `pnpm run doc-sync`; package-public behavior changes also update the owning README or JSDoc, and built-artifact checks require `pnpm run build` first.

### Profile runs

Run the repository build separately before using these source-checkout demos:

```sh
pnpm run build
```

The one-shot Headless coding agent needs `DEEPSEEK_API_KEY` in the environment or repo-root `.env`:

```sh
pnpm dsh --profile headless "summarize this workspace"
```

The PTC mode demo runs the same headless profile with code presentation enabled:

```sh
pnpm run demo:ptc -- "summarize this workspace"
```

### Application commands

Web and Desktop share one command pair. `start:*` launches the artifacts of a prior `pnpm run build` or `build:artifacts`; `dev:*` runs `build:artifacts` first and then launches. Web additionally keeps client bundles rebuilt on source edits, because its Host runs from source while the browser loads built bundles:

```sh
pnpm run start:web       # serve built Web artifacts through the source launcher (the same launch as pnpm dsh web)
pnpm run dev:web         # build, serve, and rebuild Web client bundles on source edits
pnpm run start:desktop   # launch built Desktop artifacts
pnpm run dev:desktop     # build, then launch Desktop
```

Arguments after a Web command reach `dsh web`, for example `pnpm run dev:web --no-open --port 3081`; `dev:web` also accepts `--skip-build` to reuse the existing artifact tree and `--no-serve` to run only the rebuild watchers beside a server started elsewhere. Both Web commands use the normal Harness home, while the Desktop commands use the isolated development home described in the [Desktop README](../apps/desktop/README.md). The root `Makefile` names the same commands as `make web`, `make dev-web`, `make desktop`, `make dev-desktop`, and `make build`; `ARGS='--no-open'` forwards options.

### TODO markers

Use one of three comment tags to flag known issues in the code, ordered by urgency:

- `FIXME` — an issue that should block a new release. A release should not ship with an open `FIXME` unless reviewers explicitly agree the change can be merged anyway.
- `TODO` — an issue that should be fixed soon, once we have the resources.
- `XXX` — an issue that we may fix someday; lowest priority, no commitment.

Pick the tag that matches the urgency so anyone scanning the code can tell a release blocker from a someday-maybe.

### Documenting types verbatim (`ts type-equiv`)

The [subsystems](subsystems/README.md) pages paste source-equivalent declarations together with their original JSDoc so a reader sees the exact type definition and source contract. To keep a paste from drifting when source changes, fence it as ` ```ts type-equiv ` (instead of ` ```ts `) and register it in `scripts/type-equiv.manifest.json` with the source file and symbol it mirrors:

```json
{ "doc": "docs/subsystems/session.md", "symbol": "SessionEvent", "source": "packages/core/session/src/types.ts" }
```

`pnpm run verify-type-equiv` (part of `doc-sync`) then extracts that symbol's declaration and attached JSDoc from source via the TypeScript parser and asserts the block matches both. For a class whose implementation bodies do not belong in the catalog, use ` ```ts public-api ` and set `"projection": "public-api"`; the checked projection retains the public fields, constructor, accessors, methods, and original class/member JSDoc while omitting bodies and private or protected members. Comparison ignores whitespace and non-JSDoc comments but requires every original JSDoc comment, including member documentation, so readers see the source contract beside the exact type definition. The gate enforces a 1:1 correspondence by document, symbol, and projection between primary blocks and manifest entries; a paired `.zh.md` block reuses its unsuffixed sibling's entry only when the whole tracked fence sequence is byte-identical and ordered identically. `doc-typecheck` applies the same derivative rule to compilable fences, while skipping both source-equivalence fence kinds from compilation and its opt-out ratio. When you change a documented declaration or its JSDoc, the gate fails until you update the paste; when you add or remove a primary block, update the manifest in the same change.
