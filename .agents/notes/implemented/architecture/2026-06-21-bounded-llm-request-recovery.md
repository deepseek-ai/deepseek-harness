# Agent Note: Bounded recovery for transient LLM request failures

Status: implemented

English | [中文](2026-06-21-bounded-llm-request-recovery.zh.md)

The [per-provider request retry policy](../feature/2026-07-24-provider-retry-policies.md) extends this foundation with exact-provider configuration and an explicit unbounded mode. This note continues to own structured failure facts, the failed-attempt recovery boundary, normal mode's transient defaults, visible single attempts, and durable retry status. [Terminal LLM stream failures](2026-07-29-terminal-llm-stream-failures.md) supersedes its thrown-error identity and stream-sidecar mechanism.

## Problem

Provider adapters can fail by throwing during dispatch or iteration or by ending with `finish { kind: 'error' | 'aborted' }`. The final adapter boundary normalizes thrown values to that terminal finish protocol before `dsh-agent-loop` receives them; middleware and result-processing defects remain thrown. The loop offers a terminal model-request failure to `agent/request-error`. An unhandled failure is terminal; a handling listener repairs policy-owned state, returns `{ kind: 'retry' }`, and stops waterfall delegation. The [retry-action decision](../simplification/2026-07-27-request-error-retry-action.md) owns this return contract.

That boundary is already safe for another request attempt. Each failed stream commits one log-only `assistant/attempt` with its exact compact stream, message derivation ignores it, tool calls are dispatched only after a successful terminal finish and assembled `assistant/message`, and a retry reconstructs its next attempt from the durable surface. The harness therefore does not need a second response lifecycle or tentative-output protocol to keep two attempts separate.

The prior boundary left three narrower gaps.

- Provider failures retain only a message and usually a code. HTTP status, retry delay, and provider request id are discarded or recoverable only through provider-specific error objects, so generic recovery cannot make or explain a decision without parsing text.
- Retry ownership differs by adapter. The hand-written DeepSeek adapter makes one attempt, while pi-ai profiles can enable opaque library retries. Combining hidden transport retries with an `agent/request-error` listener would multiply attempts and omit intermediate failures from the session log.
- A recovered failure has no durable status fact. The failed step and chunks remain reconstructable, but an observer cannot tell whether the agent is deliberately backing off, for how long, or why. A long silent wait looks like a stalled loop.

The default policy provides bounded recovery from transient failures of the same explicit provider/model request. Provider or model failover, response splicing, and semantic output repair are different problems and have no current consumer.

## Decision

### Preserve failure facts without embedding policy

`@deepseek-ai/dsh-llm` exports one JSON-serializable `LlmFailure` payload:

```ts ignore-check
type ProviderRequestId = Branded<'ProviderRequestId'>

interface LlmFailure {
  message: string
  code: string
  status?: number
  providerRetryAfterMs?: number
  requestId?: ProviderRequestId
}
```

`code` remains the provider-neutral machine-routing taxonomy established by `HarnessError`; the new fields are observations from the provider boundary. `ProviderRequestId` is owned and constructed by `dsh-llm`, then serializes as its provider-issued string. The payload deliberately has no `retryable`, `failover`, `partialOutput`, provider, model, phase, or route id fields. Retryability belongs to policy, provider/model are already in the durable request header, and partial output is preserved by the failed attempt's embedded stream.

`LlmError` carries `failure: LlmFailure` and preserves `failure.code === error.code`. `FinishReasonMap.error` and `FinishReasonMap.aborted` carry the same payload instead of parallel failure shapes. The final adapter boundary detaches those facts from adapter-thrown values and emits the appropriate terminal finish; unknown SDK exceptions receive an `UNKNOWN` payload. Exact thrown-object identity does not cross the LLM stream seam.

The agent loop passes the terminal finish's `LlmFailure` to `agent/request-error` and uses the same payload when recording an unrecovered `turn/end.reason`.

Adapters extract structured facts before falling back to message inspection. They validate HTTP status, parse `Retry-After` seconds or dates into a positive finite millisecond delay, brand the provider request id when exposed, and distinguish their own timeout from the caller's abort. Provider-specific codes and messages may refine a mapping, but no recovery listener parses them.

The shared transient-code set is intentionally small: adapter mappings for `RATE_LIMIT` and `SERVER`, explicit `TIMEOUT` and `TRANSPORT` codes for remote failures, and `EMPTY_RESPONSE` for a completed provider response with no content blocks. Both adapters classify the last case as an error finish; see [empty model responses are retryable](../bug-fix/2026-07-24-empty-model-response-is-retryable.md). Authentication, quota, invalid request, context overflow, protocol, abort, and unknown failures keep distinct stable codes and are not transient by default. Adding a code requires adapter fixtures and a documented policy decision; it does not require expanding a second failure-class enum.

### Put retry policy on the existing failed-step extension point

`@deepseek-ai/dsh-llm-retry` is a function plugin that listens to `agent/request-error`. It introduces no service or new loop branch; the agent-loop package changes only the data carried through its existing failed-step recovery control flow.

The `agent/request-error` waterfall carries the current `LlmFailure`, an immutable list of prior failures that authorized retries in the consecutive recovery sequence, and the serving registration's immutable retry policy. The loop transports but does not interpret that policy, owns the consecutive failure history, and clears it after a successful model request. Normal `dsh-llm-retry` policy counts durable retry records scheduled by the same exact-provider policy, while `dsh-compaction-basic` keeps its own context-overflow budget. Alternating transient and context-overflow failures therefore consume their owning finite budgets independently; the maximum request count is one plus the sum of the loaded finite budgets.

The [provider-policy decision](../feature/2026-07-24-provider-retry-policies.md) owns the current configuration shape. Provider adapters register their nested `retryPolicy`; omission uses normal defaults: two transient retries, a 500 millisecond initial delay, a 10 second delay cap, 10 percent jitter, and the five transient codes above. The count and delay bounds match the conservative edge of the inspected implementations: [OpenCode uses two request retries with 500 ms/10 s bounds](https://github.com/anomalyco/opencode/blob/9976269ab1accfc9f9dc98a4a688c516934de422/%70ackages/llm/src/route/executor.ts#L36-L39), [Pi separates three agent-level retries from provider retries and defaults provider retries to zero](https://github.com/earendil-works/pi/blob/3da591ab74ab9ab407e72ed882600b2c851fae21/%70ackages/coding-agent/docs/settings.md#L139-L147), and [Codex uses finite request/stream budgets plus a five-minute idle timeout](https://github.com/openai/codex/blob/0fb559f0f6e231a88ac02ea002d3ecd248e2b515/codex-rs/model-provider-info/src/lib.rs#L25-L33). Ten percent follows [Codex's bounded jitter](https://github.com/openai/codex/blob/0fb559f0f6e231a88ac02ea002d3ecd248e2b515/codex-rs/codex-client/src/retry.rs#L40-L47).

For an eligible failure with budget remaining, the one-based transient retry count uses bounded exponential backoff. A valid `providerRetryAfterMs` replaces exponential backoff only when it does not exceed `maxDelayMs`; a longer provider delay causes delegation instead of an earlier retry that violates the provider instruction. Local backoff multiplies by an injected random factor in `[1 - jitterRatio, 1 + jitterRatio]` and clamps the final value to `maxDelayMs`; provider delay is not jittered.

The plugin owns a lifetime `AbortController` and tracks every active recovery callback, including delegated waterfall work and backoff. Effect cleanup first unregisters the listener, then aborts and awaits the active callbacks; abort wins over a late delegated retry decision, and a captured callback can neither retry nor enter the rest of its waterfall after disposal. This makes HMR disposal quiescent even though Cordis has already captured the listener.

Before sleeping, `dsh-llm-retry` appends one non-surface `llm/retry` session event containing the turn, failed step, provider, policy mode, complete resolved-policy key, provider-policy retry number, mode-specific finite maximum when present, scheduled delay, and `LlmFailure`. The key sorts the code set and separates retry histories when a provider route is replaced by a behaviorally different same-mode policy. The plugin owns the `SessionEventMap` augmentation and exports the payload through its browser-safe `./types` subpath; `dsh-session` remains generic persistence and does not absorb the optional policy's vocabulary. The event says what was scheduled, not that the next request completed; cancellation during the delay is subsequently visible on `turn/end`. The event ships with production renderers and replay/snapshot coverage, because its purpose is operational state rather than trace collection.

The listener calls `next()` for a non-transient code, an exhausted policy budget, or an over-cap provider delay. This preserves composition with context-overflow recovery and later policy plugins. For an owned failure it records and awaits the delay, then returns `{ kind: 'retry' }` without delegating. Turn cancellation and plugin disposal end the wait without returning a retry; the loop's cancellation/disposal checks remain authoritative.

The `dsh-base` and `dsh-sdk-minimal` patches load the plugin as an explicit row, so base-backed profiles and the standalone SDK profile use the same provider-routed policy. Library consumers retain explicit plugin composition: omitting the plugin leaves request failures terminal.

### Make one layer own visible attempts

Adapters perform one provider request per `stream()` call. The pi-ai adapter removes public `maxRetries` and `maxRetryDelayMs` profile fields and disables library retries; the hand-written adapter keeps its current single-attempt behavior. This prevents an SDK budget from multiplying the agent budget and ensures every transient retry is represented by its recorded failed attempt plus `llm/retry`.

`ctx.llm.stream()` remains the raw one-attempt waterfall. Direct callers such as compaction summarization receive the structured failure but do not gain automatic retry, because they have no agent step boundary or general durable place to separate attempts. A future direct-call consumer may justify a buffering helper that retries only before emitting a chunk; this decision adds no such helper.

### Bound stalled streams where they can be stopped

Each adapter exposes a validated `streamIdleTimeoutMs` configuration field with the five-minute prior-art default cited above. The interval is capped at Node's maximum timer delay so it cannot be clamped to one millisecond. It covers each outstanding iterator `next()` from demand to adapter-recognized provider activity; time a consumer spends between `next()` calls is not provider idle time. DeepSeek SSE comments count as transport activity but never become `StreamChunk` values or session-log events.

`@deepseek-ai/dsh-timeout` exposes a rearmable idle-watchdog primitive. One stable local `AbortController` is fused with the caller signal and passed to the transport for the whole adapter call; each outstanding `next()` arms the watchdog, resolution disarms it, and the next demand rearms it. Out-of-band transport activity calls `pulse()` to rearm an outstanding demand without yielding a value. Timeout aborts that stable controller with a capability-owned `TimeoutReason`, and `finally` clears the timer. The adapter classifies its watchdog as `TIMEOUT` and an earlier upstream abort as `ABORTED`. The existing one-shot `deadline()` is not presented as a sliding timer.

Boundary tests prove termination at both actual transports. The hand-written adapter aborts its fetch/reader, and the pi-ai adapter maps the stable signal through the SDK and proves the SDK closes the response. A timer that merely rejects a consumer promise while leaving the request running does not satisfy the contract.

### Keep attempts separate in the existing log

A failed attempt appends `assistant/attempt` with its embedded stream, but never appends a surface `assistant/message` or dispatches a tool. A retry continues inside the failing turn and step, reconstructs the request from the durable surface, and produces its own settlement; only the final outcome closes the turn. UIs may render transient `assistant/live-chunk` updates while a step is open, then settle the failed attempt when `llm/retry` identifies it or `turn/end` records failure. Web validates the complete retry payload contract, projects each producer-correlated `retryId` chain into one stable row updated to the latest attempt, and derives scheduled, started, or cancelled status from `llm/retry-started` and the owning turn and step boundaries' closure. Its countdown anchors the scheduled delay to browser receipt rather than the Host event clock, uses ceiling-rounded seconds with a one-second floor, animates only while unresolved, and keeps exact latest failure details collapsed behind the row. Retry nodes anchor their own trajectory turn even when the failed attempt has no surface Assistant node. Message derivation ignores `assistant/attempt`, and Web applies the same projection during history rebuild so refreshing cannot promote failed partials into model history or duplicate retry rows.

If recovery is exhausted, the final failure is stored once on `turn/end.reason` with the structured facts. Web derives one `turn-error` node at that sequence position and renders its display-safe message and optional code inline; AUTH projections replace provider copy that may echo credential fragments with `API key is invalid`, while the raw diagnostic remains in the session log. The same fold runs for live events and history replay. While transient recovery continues, `llm/retry` is the durable home for each intermediate failure and delay; the terminal row exists only once `turn/end` records the error, and because exhausted recovery shares the failing turn, the turn's retry history never suppresses that row — the settled retry chain and the terminal error render side by side. No standalone final-error event or response-id vocabulary is added.

## Out of scope

- Automatic provider or model failover. Requests already select one explicit provider and model, and the provider registry deliberately has one adapter owner per provider.
- Retrying or continuing after a successful terminal finish, or splicing chunks from two attempts into one assistant message.
- Repairing malformed tool arguments, refusals, content filters, or other semantic model output.
- Circuit breakers, shared provider health, or cross-agent retry budgets.
- Changing `llm/stream` into a response lifecycle or adding convenience generation APIs without a production consumer.

## Alternatives considered

- **Retry inside `llm/stream` or the provider SDK** — rejected because a raw stream has no durable attempt boundary after emitting chunks, hidden SDK retries multiply budgets, and neither path can record each failed attempt consistently.
- **Add response start, interrupted, discarded, failed, and committed events to `dsh-llm`** — rejected because the agent log already separates raw chunks, successful messages, and numbered attempts. A second state machine would duplicate ownership without enabling the bounded same-route retry.
- **Add logical routes, capability matrices, and failover selection** — rejected because current requests already name provider and model explicitly, one adapter owns each provider, and no current consumer requires automatic fallback or can prove semantic compatibility.
- **Put `retryable` or `failover` on `LlmFailure`** — rejected because adapters report facts while deployment policy decides action. The same 429 may be retried in an interactive bundle and rejected in a cost-capped batch.
- **Retry forever while the caller remains active** — the [per-provider policy](../feature/2026-07-24-provider-retry-policies.md) supersedes this rejection for explicit `always` entries while retaining bounded normal mode as the default.
- **Log retry status only through the process logger** — rejected because process logs do not reconstruct session behavior and cannot drive replayed UI state.
- **Keep only flat codes** — rejected because retry delay and provider request id are structured provider facts, and HTTP status is necessary for diagnosis when different wire failures share one stable code.

## Verification

- `LlmFailure` is the single serializable payload for adapter throws, error finishes, and aborted finishes; normalization preserves stable code, status, retry delay, branded provider request id, and caller-abort versus adapter-timeout classification where available.
- Adapter throws become terminal failure chunks before reaching consumers; middleware and consumer exceptions remain thrown outside model-request recovery.
- DeepSeek and pi-ai adapter tests cover representative 400, 401/403, 429, 5xx, connection, malformed/truncated stream, timeout, abort, retry-after seconds/date, request-id, and unknown-SDK-error paths without recovery policy parsing message text.
- Pi-ai pins the SDK option to zero retries and performs one observed wire attempt for a retryable provider response; separate tests make removing either boundary fail.
- `agent/request-error` carries current failure facts, immutable prior-retried failure facts, and the serving registration's immutable retry policy; a success clears the history, and alternating transient/context-overflow integration tests prove the two policies consume only their own finite budgets.
- Each provider adapter validates its nested retry policy at Loader startup, and `ctx.llm` captures it with the route; normal mode delegates ineligible paths and makes at most `maxRetries + 1` provider requests when no other policy applies.
- HMR-during-backoff tests prove disposal unregisters the listener, aborts and awaits its captured callbacks, emits no retry decision after disposal, and leaves no timer or promise alive.
- Pure unit tests cover transient-code selection, exponential backoff and jitter bounds, valid and over-cap `Retry-After`, exhausted budgets, deterministic timer/random hooks, and abort during backoff.
- Real agent-loop tests cover failure before chunks, partial chunks then failure, thrown and in-band failures, retry to success inside the same turn, exhaustion to structured `turn/end.reason`, and composition with `dsh-compaction-basic` context-overflow recovery.
- The partial-chunk integration test proves failed chunks remain attributed to the failed step, no assistant message or tool side effect is committed for that step, and the successful retry records its own chunk seqs and provider/model route.
- The plugin-owned `llm/retry` event is non-surface, survives a JSONL round trip, is ignored by message derivation, and drives TUI and Web retraction plus scheduled-retry rendering. Client tests cover complete wire validation, clock-independent countdown, cancellation versus completed retry labels, and trajectory attribution; keyless UI snapshots cover Web scheduling and success, real Web composition tests cover partial transport failure through recovery and exhausted recovery's terminal error row beside the settled retry chain, and ACP automation snapshots confirm that a discarded attempt stays off the wire while the recovered reply is emitted.
- Idle-watchdog tests prove the stable signal is rearmed only while `next()` is outstanding, disarmed during consumer think time and in `finally`, and classified separately from a total-call deadline and an earlier caller abort; adapter tests prove the signal stops the underlying request rather than merely detaching it.
- Direct `ctx.llm.stream()` callers remain single-attempt and receive the same structured failure facts.

## Consequences

- Every retry attempt is visible inside its owning turn as the failed attempt's chunks plus `llm/retry`, and adapter-level single-attempt behavior prevents hidden SDK retries from multiplying policy decisions. A retry can still duplicate provider billing even when no chunk arrived; normal mode limits that risk, while explicit always mode accepts it until cancellation or success.
- Provider SDKs may hide status or retry headers. Those adapters retain the stable facts they expose and otherwise use a coarse code rather than letting recovery policy parse fragile text.
- Durable retry events expand the session protocol and UI state machine. Shipping the event and its consumer together prevents an unused telemetry vocabulary, but later schema changes still require persistence and replay work.
- Clearing a failed step's live chunks can visibly retract output. That is preferable to presenting discarded text or partial tool JSON as committed history, and snapshots pin the transition.
- Adapter-local idle enforcement stops stalled transports without counting consumer think time. Contract tests at each transport boundary guard against SDK drift.
- Multiple normal recovery plugins add their finite budgets. Always mode delegates first and then supplies an unbounded fallback; overlapping classifiers remain registration-order policy and must be documented and tested by the plugins that introduce them.

## Related

- [Structured error taxonomy](../../implemented/architecture/2026-06-11-structured-error-taxonomy.md) owns stable machine-routable codes and cause chaining.
- [Reconstructable requests](../../implemented/architecture/2026-07-05-reconstructable-requests.md) makes provider/model and complete request inputs durable before dispatch.
- [Timeout deadline library](../../implemented/architecture/2026-07-06-timeout-deadline-library.md) separates shared deadline classification from capability-owned termination.
- [After-call compaction pressure and context-overflow recovery](../../implemented/architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.md) owns the current closed-step request-recovery extension point and bounded overflow retry.
- [Provider-routed LLM adapters](../../implemented/architecture/2026-07-14-provider-routed-llm-adapters.md) owns explicit provider/model routing and the one-adapter-per-provider invariant.
- [Terminal turn errors survive same-turn retry history](../bug-fix/2026-08-20-turn-error-survives-same-turn-retry-history.md) owns the removal of the Web retry-history suppression that hid exhausted recovery's terminal error row.
