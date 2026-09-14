# Agent Note: Sandboxed Node execution for PTC

Status: implemented

English | [中文](2026-09-11-sandboxed-node-ptc-runtime.zh.md)

## Problem

A Node worker isolates JavaScript state but does not apply the calling Session's OS sandbox policy. Model code can import filesystem and subprocess APIs directly, bypassing the tool-policy path even when nested `tools.*` calls receive the correct checks. Terminating the worker also does not establish that its child processes have stopped.

The [PTC foundation](../feature/2026-06-15-ptc.md) remains responsible for registry presentation, generated bindings, dispatch logging and one-shot settlement. This decision supersedes its worker-based execution, trust and budget realization while preserving those consumer rules.

## Decision

`dsh-ptc-runtime-node` runs each program in one fresh Node process. The host resolves execution choices, confines the launch through the same `ctx.sandbox` provider as Bash, and gives process lifetime to `ctx.subprocess`. The child evaluates erasable TypeScript with direct Node APIs, an empty model environment and host-provided asynchronous bindings. No worker or persistent kernel remains inside this provider.

### Resolved inputs and policy

`PtcRuntime.resolve(request)` validates supported options and supplies a complete `PtcRunSpec`; `run(spec)` does not introduce defaults. PTC passes the calling Session's cwd and resolved standing policy. Direct runtime callers receive deployment defaults through the same resolver. The filesystem and subprocess providers share one execution world, and bootstrap paths cross through the filesystem's explicit host-file mapping or a configured preinstalled bootstrap.

File mode, observed denial and enforcement completeness travel in `PtcRunResult.sandbox` separately from the program outcome. Restricted execution fails if the required sandbox backend cannot launch. Full access is an explicit policy mode. Program success does not prove full enforcement, and neither the `process` descriptor nor the extra control pipe claims multi-tenant isolation.

The private Python provider keeps its existing execution implementation and configured wall deadline. Its resolver accepts cwd but rejects an explicit file policy or per-call timeout override; a capability descriptor never silently grants unsupported protection.

### Control and lifetime

The subprocess owner supplies a dedicated inherited binary control channel, separate from program stdout/stderr and launcher lifecycle IPC. The host bounds frames, queued writes, pending calls and outstanding argument bytes, then validates call identity and the binding allowlist before dispatch. Model code can write to that channel, so its bytes remain untrusted.

Program completion, timeout, cancellation and protocol failure all close execution through the managed process owner. Result selection stops the execution timer; cleanup then waits for the direct outcome and managed-range quiescence. The PTC bridge separately aborts and drains nested tool dispatches before its outer tool result settles. A denial or transport failure never automatically replays a program whose effects may already have occurred.

### Resource limits

The default elapsed deadline is 120 seconds, capped at 600 seconds by default. Trusted service consumers may request `timeoutMs: null` to disable this timer; [workflow sandbox reuse](2026-09-13-workflow-ptc-sandbox-reuse.md) owns that caller-controlled lifetime. Omitted and numeric requests, including model-facing `run_code`, retain the numeric defaults and caps. An enabled deadline includes runtime setup and nested tool or approval waits. V8 old-generation memory, serialized outer output and control traffic have separate configured bounds. The heap limit excludes native allocations and descendant memory, and elapsed time is not a process-tree CPU budget.

## Alternatives considered

**Keep the worker and add tool checks.** Tool checks cannot intercept direct Node imports or establish OS confinement. Keeping a worker inside a confined supervisor process preserves worker metering but adds another execution lifetime without supplying a process-tree CPU limit.

**Use an in-process JavaScript realm.** A language-level realm does not enforce the filesystem and process policy required for direct Node APIs. OS confinement and a host-owned process lifetime are the required protections.

**Copy Codex Code Mode's execution model.** [Codex Code Mode](https://github.com/openai/codex/blob/02a8f038b87ad34d4a1dc5058eda26972ed7aa6c/codex-rs/code-mode-protocol/src/description.rs) exposes fresh raw-JavaScript isolates and host tool callbacks, with yield/wait observations separate from execution lifetime. Removing Node APIs or adding resumable cells would change PTC's programming and logging model. The retained design keeps direct Node access under OS policy and one-shot results.

**Treat worker active time as a CPU limit.** Event-loop utilization counts active wall time in one worker, not CPU consumed by Node and its descendants. The process provider uses a host-owned elapsed deadline and does not make that stronger claim.

## Consequences

Each `run_code` pays for a Node process launch and OS sandbox setup. Long nested tools and approvals consume the same elapsed budget as direct program work. Cleanup can extend the caller's wait beyond that deadline. Stronger descendant containment remains dependent on the selected subprocess backend; its fallback limitations remain visible rather than being upgraded by the runtime label.

`run_code` requires the program and its description. Service callers can resolve supported execution choices; model-facing timeout and approval controls have a separate consumer owner. Every nested tool still passes through its normal policy and logging path.

<a id="deferred-timeout-design"></a>
## Deferred timeout design

The elapsed defaults are a revisitable deployment choice. Further design must separate responsiveness from termination: yielding output to a model does not itself stop a program, and adding waitable cells introduces ownership, cancellation, partial-output logging, turn-end and resume obligations.

Open questions include whether approval waits consume the program budget, how sequential long-running tools compose, whether a separate total-lifetime backstop is needed, and which process-tree CPU/RSS limits can be enforced consistently. A persistent kernel additionally needs a Session-log representation of retained state. These questions do not silently pause or extend the shipped elapsed timer.
