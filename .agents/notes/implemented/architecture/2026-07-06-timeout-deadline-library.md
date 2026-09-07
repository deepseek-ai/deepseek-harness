# Agent Note: A shared timeout/deadline primitive, with hard-kill left to each capability

Status: implemented

English | [中文](2026-07-06-timeout-deadline-library.zh.md)

## Problem

Timeout handling was drifting apart across the tool-bearing capabilities, and the divergence was not superficial — it was the same logic re-implemented three ways, each with its own subtle correctness burden.

- **bash** (then in the bash-local implementation's `run.ts`) had a full, correct timeout inside the process plumbing: a config-clamped `timeoutMs`, two independent triggers — a `killTimer` for the timeout and an `onAbort` listener for upstream cancellation — each calling one `kill()` closure that drove the subprocess termination path, and two orthogonal outcome booleans (`timedOut`, `aborted`) latched independently. After this consolidation, the plumbing — [packages/subprocess/subprocess-local/src/spawn.ts](../../../../packages/subprocess/subprocess-local/src/spawn.ts) — only reacts to aborts; [packages/shell/bash-local/src/index.ts](../../../../packages/shell/bash-local/src/index.ts) owns the fused deadline and the `timedOut`/`aborted` classification.
- **web_fetch** ([packages/web/web-fetch-http/src/provider.ts](../../../../packages/web/web-fetch-http/src/provider.ts)) had a correct but *hand-rolled* timeout: it constructed an `AbortController`, wired `setTimeout(() => controller.abort(new WebError(…, 'WEB_FETCH_TIMEOUT')))`, manually added and removed the upstream-signal listener, cleared the timer in a `finally`, and recovered the timeout reason from `signal.reason` in a `translateAbortOrNetwork` helper because the reader surfaces a bare `AbortError`.
- **web_search** ([packages/web/tool-web/src/search.ts](../../../../packages/web/tool-web/src/search.ts)) had **no timeout at all**: `WebSearchRequest` ([packages/web/web/src/types.ts](../../../../packages/web/web/src/types.ts)) carries no `timeoutMs` field, and each provider's `search()` only forwards `exec.signal`. (web_search stays untimed here — see Consequences.)

Each new external-process or network tool re-derived the same four things — clamp the requested value, start a timer, fuse the timeout with upstream cancellation, and distinguish "timed out" from "cancelled" on the way out — and the fusion and reason-recovery are exactly the parts that are easy to get subtly wrong (web_fetch's `signal.reason` dance is evidence). At the same time, the *termination* each performs is irreducibly different: bash asks its subprocess provider to terminate an OS-owned range, while web aborts an in-process `fetch` and lets undici tear down the socket. The [native-containment decision](2026-08-28-subprocess-native-containment.md) owns the local scope, Job, and fallback mechanisms; there is no single mechanism that can stop every capability's work.

## Decision

`@deepseek-ai/dsh-timeout` lives under `packages/util/` (peer to `dsh-brand`) and owns the *timing and classification* half of timeout; the *termination* half — the hard kill — stays in each capability's implementation. It is a library of pure functions, **not** a cordis service or plugin: it takes no `ctx`, registers nothing, holds no cross-call state, and emits no events. There is deliberately no central "timeout service" that would have to know how to stop every capability's work — that knowledge is exactly what a microkernel keeps out of shared layers, and what Codex's exec-only `ExecExpiration` scope demonstrates.

### The library API

Four functions, one watchdog interface, and one reason type:

```ts ignore-check
/** The internal reason attached to a timeout abort, so consumers can classify it after the fact. */
export class TimeoutReason extends Error {
  override name = 'TimeoutReason'

  constructor(readonly code: string, readonly timeoutMs: number) {
    super(`${code} after ${timeoutMs}ms`)
  }
}

/** Validate/fill a caller's optional positive hint from the backend's default, then cap at its max. */
export function clampTimeout(
  requested: number | undefined,
  def: number,
  max: number,
  name = 'timeoutMs',
): number

/**
 * Build a deadline signal that aborts on upstream cancellation OR on timeout,
 * with the timeout carrying a `TimeoutReason`. `timeoutMs <= 0` means "no
 * timeout" (background jobs): forward only the upstream signal, arm no timer.
 * The returned object's `[Symbol.dispose]` clears the timer — `using` for a
 * scope-lifetime consumer, a manual call for an event-lifetime one.
 */
export function deadline(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
  code: string,
): { signal: AbortSignal; [Symbol.dispose](): void }

/** A stable signal plus one-at-a-time, timer-guarded async-iterator demand. */
export interface IdleWatchdog {
  readonly signal: AbortSignal
  next<T>(iterator: AsyncIterator<T>): Promise<IteratorResult<T>>
  pulse(): void
  [Symbol.dispose](): void
}

/** Arm only while one iterator `next()` is outstanding; rearm on later demand or out-of-band activity. */
export function idleWatchdog(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
  code: string,
): IdleWatchdog

/** Recover the TimeoutReason from an aborted signal (or error); `code` scopes the match to this deadline's timer. */
export function timeoutOf(x: AbortSignal | { reason?: unknown }, code?: string): TimeoutReason | undefined
```

`deadline` fuses an upstream signal with a one-shot timer through `AbortSignal.any`, adds a typed `TimeoutReason`, and exposes disposable timer cleanup. Non-positive timeouts are an internal no-timeout sentinel for backend-owned background work; external hints pass through `clampTimeout` and must be positive and finite. Without a timer or upstream signal, the function returns a never-aborting signal with the same disposal shape. `idleWatchdog` instead requires a positive finite interval, keeps one stable fused signal for the entire stream, and arms its timer only while one iterator `next()` is outstanding; resolution disarms it, later demand rearms it, and `pulse()` rearms that same outstanding demand after out-of-band transport activity. A pulse outside outstanding demand or after disposal is a no-op; concurrent demand fails, and disposal clears the active arm. Providers translate timeout reasons into seam-specific results. `timeoutOf(signal, code)` scopes classification so an outer nested deadline is treated as upstream cancellation rather than the inner capability's timeout.

### The division of labor

| Concern | Owner |
|---|---|
| Validate request hint and clamp default/max | `dsh-timeout` (`clampTimeout`) — pure arithmetic plus the shared positive-finite request contract |
| Arm one-shot timer, abort on deadline, carry reason, fuse with upstream cancel | `dsh-timeout` (`deadline`) |
| Arm and rearm only around outstanding iterator demand, including out-of-band activity | `dsh-timeout` (`idleWatchdog`) |
| Clear the timer | `dsh-timeout` (`[Symbol.dispose]` on either primitive) |
| Classify the first abort reason after abort | `dsh-timeout` (`timeoutOf`) |
| **Actually terminate the work** | the capability's implementation |
| The default/max *values* | the capability's config |
| The timeout `code` string | the capability (`WEB_FETCH_TIMEOUT` ≠ `BASH_TIMEOUT`) |

The signal only *notifies*; termination is always the listener's job, and the listener differs by capability. bash writes its own `addEventListener('abort', kill)` because the OS process lives outside this runtime and its subprocess provider must drive the owned range to settlement; web hands `d.signal` to `fetch` and undici tears down the socket. This is why file read/write/edit take **no** `timeoutMs`: a local syscall is best-effort-abortable at most, a timeout could not force `fsync`/`rename` to stop, and adding one would be an implicit default that violates explicit-over-implicit. Both reference agents leave file I/O untimed for the same reason.

### How each capability consumes it

- **web_fetch** — the tool stays validate-and-forward; the provider's hand-rolled controller + `setTimeout` + manual listener + `finally` + `signal.reason` recovery is replaced by provider-owned `deadline`/`timeoutOf`. A pre-aborted upstream signal still throws `WEB_ABORTED` up front; otherwise `fetch` runs against the fused `d.signal`, and `translateAbortOrNetwork` classifies a thrown error by the signal (`timeoutOf` → `WEB_FETCH_TIMEOUT`, else aborted → `WEB_ABORTED`, else network → `WEB_PROVIDER_ERROR`). The public error-code contract is unchanged, and `TimeoutReason` never crosses the web seam as the public error.
- **bash** — `resolve()` clamps the request into an explicit spec. Foreground `run()` creates the deadline and passes its signal to process execution, whose abort listener calls `SubprocessHandle.terminate()` and awaits the same provider-managed range. The executor classifies the first abort as timeout or cancellation. Background starts remain timeout-free and forward only upstream cancellation.
- **LLM adapters** — `dsh-llm-deepseek` and `dsh-llm-pi-ai` wrap actual transport iteration with `idleWatchdog`. The five-minute configured interval covers only outstanding provider demand, not time the downstream consumer spends between chunks. The direct DeepSeek adapter also pulses that outstanding demand when its SSE parser observes a comment, without yielding the comment as a `StreamChunk` or writing it to the session log. The pi-ai SDK does not expose comment activity to its adapter, so that path can rearm only when the SDK yields. The stable signal reaches `fetch` or the SDK for the whole call, so timeout closes the underlying request and maps to `TIMEOUT`, while an earlier caller abort maps to `ABORTED`.

## Consequences

- `runBash`'s outcome no longer independently latches `timedOut` and `aborted`; a timeout and a user abort racing before process close now report a single first-abort cause instead of both being true. Timeout classification does not alter provider-owned termination: local POSIX ranges use TERM→grace→KILL, while Windows ordinary ranges terminate immediately. The Service Definition type `ShellRunResult` keeps both booleans (now mutually exclusive), so `dsh-tool-bash`'s result rendering is untouched.
- `SpawnSpec.timeoutMs` and `SpawnOutcome.timedOut`/`aborted` were removed rather than kept as always-zero/always-false vestiges: with `runBash` owning no timer and the executor owning classification, they were read nowhere. An always-0 field read by nothing is dead weight under the per-file coverage gate.
- web_fetch shed its bespoke controller/timer/listener/reason-recovery; the classifier now keys off the deadline signal (`timeoutOf` + `aborted`) rather than the thrown error's shape, which is robust across both the request-phase reject-with-reason and the read-phase bare-`AbortError`.
- `AbortSignal.any` and `using`/`Symbol.dispose` enter the repo for the first time here (Node ≥ 24 baseline, already met).
- Model streams now share one rearmable timer contract without turning a sliding idle interval into a total-call deadline or charging consumer think time. Adapters that can observe out-of-band transport activity may pulse an outstanding demand; suppressed activity remains invisible to the watchdog. The primitive still only notifies; adapter tests prove their transports observe its stable signal and terminate.

Out of scope, named to mark the boundary: `web_search` can gain an optional model-facing `timeout_ms` once its tool-schema/snapshot coverage is planned; the ripgrep-backed fs discovery tools ([packaged ripgrep search](../../archived/architecture/2026-08-01-packaged-ripgrep-search.md)) consume the same provider-owned deadline shape through `dsh-tool-call-timeout-policy` and `exec.signal`; a `tools/execute` waterfall middleware could arm a default deadline for every tool call by driving `exec.signal` — that would be a plugin that *consumes* this library and still only notifies, the hard kill remaining each capability's job.

## Alternatives considered

**A unified timeout *plugin* / `ctx.timeout` service.** Rejected on microkernel grounds. A service that could stop any tool's work would have to understand every capability's termination mechanism (native scope or Job termination, fallback process-group signalling, socket teardown, syscall-boundary checks) — the "kernel knows too much" the architecture forbids. Codex's `ExecExpiration` is scoped to the exec family precisely because the kill it drives (`killpg`) is process-family-specific; MCP and model-stream keep their own. There is no coherent middle layer that owns termination for everything, so the shared piece can only be the pure timing/classification half — a library, not a service.

**Per-tool ad-hoc timeout, no shared code (the prior status quo, and Claude Code's choice).** Rejected because it was already producing divergence and duplicated correctness burden: web_fetch hand-rolled the exact controller/reason logic that future network/process-backed tools would each have to re-derive, and the fusion + `signal.reason` recovery are the error-prone parts. Claude Code tolerates full duplication; this repo has a single shared abort channel (`exec.signal` on every `execute`) that makes a small shared primitive strictly cleaner, so the cost/benefit differs.

**A `withTimeout(promise, ms)` wrapper instead of a signal factory.** Rejected because racing a promise against a timer resolves the *tool-call* promise on deadline without stopping the underlying work — the child process or fetch socket leaks on. Handing out a signal and requiring the capability to listen is what forces a real termination path to exist. This mirrors the "dispose must reach quiescence, not just request it" defensive rule.

**Keep separate bash timeout and cancellation triggers.** Rejected because one deadline signal removes the bespoke timer and standardizes classification. Racing causes report whichever abort arrived first, while the provider-owned termination path is independent of which cause won.
