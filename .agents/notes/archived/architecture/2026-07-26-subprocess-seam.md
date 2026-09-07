# Agent Note: The subprocess service is its own seam under the bash executors (`dsh-subprocess` / `dsh-subprocess-local`)

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-26-subprocess-seam.zh.md)

## Problem

`dsh-bash-local` bundled two capabilities that change for different reasons: *running a bash command* (command defaulting, timeout classification, model-friendly terminal environment, the stdout/stderr merge the bash tool renders) and *running and managing a child process* (detached process groups, bounded tail-keep output with spill files, the credential scrub and `DSH_*` merge order, SIGTERM→grace→SIGKILL escalation, kill-and-join disposal). The process half — `run.ts`, roughly half the package — had no seam of its own: a future non-shell runner (a direct-argv executor, a worker supervisor) would have to re-implement or reach into bash internals, and the shared `DSH_*`/`CollectedOutput` vocabulary lived in a package whose name promises shell semantics. The bundling also tied background-process lifetime to the executor's fiber: reloading the bash executor killed every live background process, unlike the sibling [job registry](2026-07-26-job-registry-seam.md), whose registrations deliberately outlive producer fibers.

## Decision

A new `subprocess/` capability family owns "run and manage a process"; the bash family keeps "run a bash command" and consumes it:

- **`@deepseek-ai/dsh-subprocess` (Service Definition)** — the abstract `SubprocessRuntime` owning `ctx.subprocess`: executable lookup, fully explicit ordinary spawns, and the terminal primitive added by the [portable execution-world decision](2026-07-28-portable-execution-world-consumers.md). Each stdio stream independently selects `'pipe'`, `'inherit'`, or bounded collection `{ maxBytes, spill? }`; stdin selects `'ignore'`, `'pipe'`, or `{ data }`. `SubprocessOutcome` carries exit facts with deliberately no timeout/cancel classification, while collected output remains on the handle after settlement. The Service Definition also owns process and terminal handles, the shared scrub, and `DSH_ENV_PREFIX`/`DshEnvironment`/`CollectedOutput`; `argv` is never shell-interpreted.
- **`@deepseek-ai/dsh-subprocess-local` (Service Provider)** — `LocalSubprocessRuntime` over the former `run.ts` plumbing (`spawn.ts`) plus `node-pty`: detached groups, bounded collection and private spill files, executable lookup, foreground/session inspection, and disposal that terminates and joins every managed process. `terminate()` owns TERM→grace→KILL for the tree, `waitForExit()` observes tree liveness, and injected `taskkill /T` covers Windows. Ordinary and terminal spawns apply the Service Definition's case-insensitive `KEY`/`PASSWORD`/`SECRET`/`TOKEN` scrub before explicit env. The provider has no config; every limit arrives on the spec, while Bash and PTY presentation environment overrides stay in their Consumers.
- **`dsh-bash-local` (Consumer)** — `inject: ['subprocess']`; maps each resolved `ShellExecSpec` onto a `SubprocessSpawnSpec` (`['bash', '-c', command]`), keeps its config, `resolve()` defaulting, fused-deadline `timedOut`/`aborted` classification, the `[stderr]`-marked background read merge with its consuming cursor, and the `onProcessDone` subclass hook. `dsh-bash-sandbox` is unchanged apart from redeclaring the inherited inject; it still wraps at the command-string level and re-enters the inherited spawn path.
- **`dsh-shell` (Service Definition)** — re-exports the moved vocabulary from `dsh-subprocess`, so no bash Consumer changes an import; `ShellExecRequest`/`ShellExecSpec`/`ShellProcess` and the sandbox facts remain bash-owned.

Every composition that loads a bash executor also loads `@deepseek-ai/dsh-subprocess-local` (CLI, examples, the Python bundled runtime, and inline test configs).

Background-process lifetime moved from the executor to the subprocess service: the executor no longer retains a live-process set, so an executor reload leaves background work running and readable, and composition teardown (the service's disposal) remains the kill-and-join boundary. One behavioral contract shifted with it: a background spawn failure can no longer be buffered as fake stderr inside the plumbing (the service rejects `done` and buffers nothing for a process that never ran), so the executor injects the `spawn failed: …` note into exactly one `readOutput()` delta.

Observed stream and lifecycle needs then moved the eligible process consumers onto the seam: LSP uses piped protocol streams plus a collected stderr tail; the ACP backend uses piped ndjson, inherited stderr, and a consumer-owned stdin-EOF disposal ladder; PTY uses `spawnTerminal()` while keeping readiness and terminal policy. `dsh-subagent-subprocess` and the private LSP tree helpers were deleted. MCP transport spawning and dependency-light test-support launchers remain outside by ownership or execution shape; their production callers share the scrub where applicable.

## Alternatives considered

**Leave the process plumbing inside `dsh-bash-local` (status quo).** Rejected for the same reason the [job registry split](2026-07-26-job-registry-seam.md) landed: the boundary is stable and already documented in-code (`run.ts`'s module doc said "this layer reacts to an abort signal; the executor owns deadlines and classifies causes"), and keeping it private makes every future non-shell runner either fork the mechanics or depend on a bash-named package for non-bash work. The user-visible driver for this change was exactly this split.

**Keep the original batch-only interface and leave stream consumers bespoke.** Rejected after the observed LSP, ACP, and PTY shapes showed that private process-tree signalling and environment scrubs would otherwise remain duplicated. The Node-shaped dispositions cover those consumers without buffering piped streams.

**Use one `stdio: 'pipe' | 'inherit' | 'collect'` mode for all streams.** Rejected because real consumers mix modes per stream: LSP uses pipe/pipe/collect, ACP uses pipe/pipe/inherit, and Bash uses data/collect/collect.

**Route every process launch through `ctx.subprocess`.** Rejected because the MCP SDK owns its transport spawn and support launchers deliberately stay independent of product seams. PTY allocation did move behind `spawnTerminal()` because the provider, not the consumer, owns that substrate-specific primitive.

**Put `run_in_background`/task semantics into the subprocess capability seam instead.** Rejected: that boundary already exists — `ctx.jobs` owns ids, ownership, and notices, and the bash tool adapts a `ShellProcess` into task hooks. The subprocess seam sits *below* the bash executor, not beside the job registry.

**Move `ENV_OVERRIDES` (TERM=dumb, PAGER=cat …) into the subprocess service.** Rejected: a generic subprocess service must not impose terminal presentation policy on non-terminal consumers; the ambient scrub (credential-shaped and `DSH_*` names) is a security/identity invariant and stays, but terminal friendliness is the bash tool's choice, expressed through the spec's explicit env where a caller's own entry still wins.

## Consequences

Bought: "run and manage a process" is a swappable capability used by Bash, LSP, PTY, and ACP consumers; a containerized or remote process backend slots in without changing their domain semantics; tree signalling, escalation, bounded collection, terminal mechanics, and credential scrubbing each have one implementation; and background processes survive executor reloads, matching the job registry's lifetime model. Process and terminal plumbing is tested through `dsh-subprocess-local`; consumer suites pin only their owned behavior against the real service.

Cost: one more package pair and one more composition row wherever a consumer loads; a missing subprocess provider leaves the consumer pending by standard service-injection behavior. Every backend implements executable lookup, three stdio modes, tree lifecycle, and one terminal primitive. The moved-vocabulary re-exports keep `dsh-shell` imports working but mean two packages name the same types; the subprocess seam is the owner. The spawn-failure note became single-delivery through Bash's consuming read cursor instead of repeatable stderr-buffer content.
