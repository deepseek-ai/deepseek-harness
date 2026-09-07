# Agent Note: The job registry is a capability seam (`dsh-jobs` / `dsh-jobs-local`)

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-26-job-registry-seam.zh.md)

## Problem

The [background-job runtime](2026-06-20-generic-long-running-tool-runtime.md) shipped `JobRegistry` as one concrete package: `@deepseek-ai/dsh-jobs` owned both the `ctx.jobs` contract every producer and controller programs against and the process-local provider (the in-memory store, settlement bookkeeping, owner-cleanup effects, teardown). That bundling recouples the two rates of change the repository's [capability-seam rule](2026-06-13-capability-seams.md) separates: swapping the registry's storage or lifecycle backend would churn the same package whose types and `ctx.jobs` API producers (`dsh-tool-bash`, `dsh-tool-terminal`, `dsh-tool-subagent`), the controller (`dsh-tool-jobs`), and `JobKindMap` extenders import. Every other swappable capability in the harness — bash, pty, fs, skill, subagent, web, session persistence — already carries the Service Definition / Service Provider / Consumer split; the job registry was the remaining `core`-mode exception, guarded only by a `TODO(job-service-backend)` comment.

## Decision

`jobs/` is now a three-package capability family in the bash-trio shape:

- **`@deepseek-ai/dsh-jobs` (Service Definition)** — the abstract `JobRegistry extends Service` owning `ctx.jobs`, the nine-method contract (`start`, `list`, `get`, `read`, `kill`, `wait`, `onJobDone`, `onJobsChanged`, `attachController`), all vocabulary types (`JobId`, `JobKindMap`, `JobStart`, `JobHooks`, `JobOutcome`, `JobSnapshot`, `JobRead`, `JobDoneListener`), and the snapshot invariant companion. The class-level JSDoc states the semantics every Service Provider owes: registrations outlive producer and controller fibers, owned access is session-fenced, settlement is first-wins with contained listeners, and `start` refuses work while no attached job controller serves the spec's owner (controllers and listeners are scope-layered, so one process-wide registry answers both questions per owner).
- **`@deepseek-ai/dsh-jobs-local` (Service Provider)** — `LocalJobRegistry`, the process-local registry: the in-memory store, per-kind id counters, waiter bookkeeping, `TASK_WAIT_TIMEOUT` deadline code, owner-cleanup effects, force-fail teardown, and the default-10 configurable admission policy. Admission derives `running` plus `stopping` capacity from the same records per exact owner, with one unowned bucket; it adds no public count or second state owner. The `dsh-timeout` dependency and Schemastery-owned provider config live here; the Service Definition package has no provider dependencies.
- **`@deepseek-ai/dsh-tool-jobs` (Consumer)** — unchanged; it injects `'jobs'` and never imports provider types.

Compositions load `dsh-jobs-local` where they previously loaded `dsh-jobs` (`dsh-base`, `sdk-minimal`, test harnesses, and the tool-catalog generator boot). Producer misconfiguration diagnostics ("background jobs unavailable: load …") name `dsh-jobs` — the Service Definition package that declares the absent `ctx.jobs` service — and the Service Definition package's own APIs (its README and the direct-mount fence) point at Service Providers, so the producer message stays correct when another backend becomes the recommended default. Producers, `JobKindMap` declaration merges, and the controller keep importing `@deepseek-ai/dsh-jobs` only.

The seam keeps the in-process contract semantics unchanged: `JobStart.run()` still passes callbacks and exact `Agent` objects, so a durable or cross-process backend still has design work to do before it can satisfy this Service Definition (identity, restart, ownership, observation). The split moves that future work out of every Consumer's dependency graph; it does not pre-design the backend.

## Alternatives considered

**Keep the concrete service until a second backend exists (status quo).** This was the original runtime note's position: extracting a Service Definition before a second provider risks freezing the wrong boundary. It lost because the boundary is no longer speculative — the nine service methods and their semantics have been stable across every producer integration since introduction, they are exactly the API `dsh-tool-jobs` and the producers already program against, and the repository convention treats swappable capabilities as three packages by default. The residual risk (a durable backend needing contract changes) is unchanged by the split: those changes would land in the Service Definition package either way, and they would also churn every Consumer's provider dependency.

**Service-Definition-only extraction inside one package (export an abstract class beside the concrete one).** Rejected because it separates nothing operationally: Consumers still depend on the package that carries the provider and its dependencies, and a replacement backend still cannot ship without the local one in its graph. The package boundary is the unit of independent evolution here.

**Splitting `types.ts` out but leaving the service concrete.** Rejected for the same reason — the types are not the complete capability; the `ctx.jobs` Service Definition and its method contract are. Producers need the service key and semantics, not just the shapes.

## Consequences

Bought: the job registry now matches the repository-wide seam shape; a durable, remote, or instrumented registry is a sibling Service Provider implementing nine abstract methods, and no producer, controller, or `JobKindMap` extender changes when one lands. The Service Definition README states the contract; the provider README owns the lifecycle bookkeeping facts. The registry behavior suite (owner cleanup, settlement, waits, teardown) lives with `dsh-jobs-local`; the Service Definition package keeps a stub-subclass test pinning registration under `ctx.jobs` and single-service duplication behavior, plus the probe-based invariant suite.

Cost: one more package (manifest, tsconfig, README, invariant companion), and compositions must name the Service Provider package. `abstract` erases at runtime and this package name used to be the mountable registry, so the Service Definition constructor fails loudly when mounted directly — a stale composition row gets "load a Service Provider such as @deepseek-ai/dsh-jobs-local" at load time instead of a half-registered `ctx.jobs` failing far from the misconfiguration.
