# Agent Note: Explicit turn cancellation capability

Status: implemented

English | [中文](2026-07-16-explicit-turn-cancellation.zh.md)

## Problem

Cancellation is a control capability with a shorter lifetime than an Agent driver. A free-form string cannot distinguish callers exhaustively, and a step-local controller cannot interrupt prompt submission, prompt assembly, continuation, or terminal turn policy. Storing `Error`, `AbortSignal.reason`, or backend-private objects would also expose unstable runtime details to durable replay.

The [initiating Agent scope decision](2026-07-15-agent-initiator-scope.md) intentionally carries only the exact Agent through AsyncLocalStorage. Adding turn, step, or signal state to that driver-lifetime boundary would make stale asynchronous descendants appear to retain authority over later turns. Cancellation therefore needs one turn owner and explicit propagation without creating another ambient context or public turn wrapper.

## Decision

Agent owns the runtime-only `AgentCancelCause` union `{ kind: 'user' } | { kind: 'parent' }`; `agent.cancel()` defaults to `user`. TypeScript enforces that vocabulary at this typed same-process boundary, with no runtime validator, fallback, or special compatibility contract for untyped callers. An active `TurnCancellation` copies the typed discriminant into a fresh frozen signal reason; idle cancellation has no holder to mutate and does not arm later work.

An interrupted live turn ends with the coarse durable `{ kind: 'aborted' }` outcome. The terminal event records what happened to the turn, while the runtime signal identifies who requested cancellation; it does not duplicate `user` or `parent` into replay. Session seed/load rejects legacy aborted records with a reason or any other extra field, so replay cannot reintroduce caller-owned cancellation detail. The process-local `agent/cancel-requested` notification is not durable; a future audit requirement uses a separate durable control-request event so a request and its eventual outcome remain distinct. Durable events contain no stack, signal, error object, free-form cancellation text, or backend-private detail.

AgentLoop privately owns one `TurnCancellation` per prospective turn. It installs the holder before notifying `agent/status = running`, retains its single `AbortController` through inbox claim, `agent/pre-step`, prompt assembly, every step, model and tool execution, and `agent/turn-stopping`, then clears the exact holder immediately before publishing `turn/end`. Terminal event observers and the following durability flush therefore cannot cancel already-completed turn work even though driver status may remain `running` until the flush settles. Every participating method, event, and request value receives that same explicit signal; the next turn receives a fresh signal.

The driver keeps only a cause-less pre-run marker for queued work cancelled before a turn is claimed. An effective `cancel()` emits the observe-only `agent/cancel-requested` notification with its resolved typed cause before clearing queued and steering work or aborting the holder; notification failures cannot veto the stop, and an idle call emits nothing. Work synchronously queued by a notification observer is included in that clear, while work queued by a later signal abort observer is latched and runs when the aborted activity converges to idle — a `disposed` cancel leaves it parked ([cancel-convergence wake latch](../bug-fix/2026-08-07-cancel-convergence-wake-latch.md)). If a `running` listener synchronously cancels old work and sends a replacement, the driver discards the aborted holder and creates a fresh one for the replacement. Repeated cancellation is first-wins for the active holder, while later calls may still clear newly queued pending work.

The explicit event signatures pass a single payload object: agent-scoped events carry `agent` and `signal` in the payload with `next` last, and the remaining APIs keep `signal` immediately before a waterfall's final `next`. `PreStepContext` and `RequestFailureContext` are retired, with their fields folded into the `agent/pre-step` and `agent/request-error` payloads ([payload-object events](../../archived/architecture/2026-08-06-agent-event-payload-objects.md)). Pre-step entry, request configuration, request-error recovery, model generation, tool execution, approval, turn stopping, and subagent or workflow requests all receive the current signal. Hook bridges must also supply `RunHookOptions.signal`, so a turn cancellation reaches the bash executor's provider-managed termination and join boundary; the [native-containment decision](2026-08-28-subprocess-native-containment.md) owns the supported local scope, Job, and fallback mechanics. `SystemPrompt.assemble()` carries `signal?: AbortSignal` in `AssembleContext` because that object is an explicit request value that can also represent signal-less assembly outside a turn. Listeners may cooperate with the signal but must not retain it to control another turn.

`ctx.agents` continues to carry only the initiating Agent. Ambient Agent presence does not imply liveness, a current turn, or cancellation authority. The cause reader is private to the loop and states the machine-private slot invariant (only `cancel()` aborts a turn controller, always with a canonical frozen cause) instead of re-validating the reason structurally; no public helper reads a cause off an arbitrary signal. Concurrent Agents isolate both their initiator identities and their turn signals; a child driver shadows the parent initiator while its parent request signal still travels through the subagent seam.

Agent disposal requests the runtime-only `{ kind: 'disposed' }` interruption on the active holder. If cancellation already won the controller reason, the reason cannot be rewritten, so terminal classification first checks lifecycle state: disposed wins, then a supported `user` or `parent` cause becomes the coarse aborted outcome, and unrelated exceptions retain the existing error path. ACP cancellation maps to `user`; in-process spawn and fork propagation map to `parent`. Remote ACP subagents retain their existing wire protocol.

Cancellation remains cooperative. The loop checks interruption before and after awaited boundaries but does not use `Promise.race` to abandon an in-process listener, adapter, or tool Promise. Work that ignores the signal must settle before `whenIdle()`, handle disposal, and scope teardown report quiescence.

## Verification

Contract tests verify the typed caller union, frozen detachment, default and first-wins behavior, the coarse Session JSON round trip and legacy-record rejection, ACP `user`, in-process subagent `parent`, and disposal precedence. Loop tests make cooperative listeners wait on the signal at pre-step, system-prompt assembly, request, model stream, request-error recovery, tool execution, and turn stopping; they assert one signal within a turn, a fresh signal across turns, and no cancellation authority during terminal publication or a blocked durability flush. A real hook bridge test cancels and reaps a blocked prompt hook before idle.

Initiator-scope tests assert that every hook still observes the exact Agent and no ambient turn signal, concurrent Agents retain independent identities and signals, and a nested child driver shadows only identity. Race tests cover idle cancellation, pre-run cancellation, replacement submission from a `running` listener, repeated cancellation, and cancel-versus-dispose quiescence.

## Alternatives considered

**Store the signal in ALS.** ALS follows asynchronous descendants for the entire driver lifetime, while cancellation authority ends with one turn. A leaked callback could observe a stale signal or require mutable ambient state, so the initiator scope continues to carry only the Agent and control remains explicit.

**Persist a free-form string reason.** Strings admit spelling drift, prevent exhaustive switching, and encourage consumers to parse presentation text. The runtime uses a closed discriminated union, while the terminal record needs only the stable aborted outcome.

**Persist the typed caller cause in `turn/end`.** No production replay, UI, ACP, telemetry, or workflow consumer distinguishes `user` from `parent`. Copying the request source into the terminal result would conflate two facts and add Session-specific validation without a consumer; a future audit trail can record a separate cancellation-request event.

**Define speculative `superseded`, `timeout`, and `shutdown` variants now.** No current Agent cancellation producer implements those semantics. `shutdown` is already lifecycle disposal, and timeout or supersession should enter the union only with an owning policy and unique terminal meaning.

**Expose public turn or step context wrappers.** Existing seams already identify Agent, turn, and step. A wrapper would widen every API, duplicate ownership, and tempt callers to treat a captured object as durable authority.

**Abandon uncooperative work after a grace period.** Returning idle while same-process work still runs breaks teardown and resource-ownership guarantees. Hard termination requires a worker or process isolation boundary and is outside this control boundary.

## Consequences

Cancellation has one runtime owner, one signal per live turn, and one typed runtime caller vocabulary. Session retains the coarse `aborted` outcome that its consumers actually use, rejects reason-bearing legacy forms, and stays isolated from runtime objects. Cooperative cancellation reaches every asynchronous turn extension point, including work before the first step and after the last one, while terminal publication and persistence remain outside its authority.

The explicit signal adds parameters to several public events and requires plugins to forward cancellation deliberately. This is intentional: authority is visible at the call boundary, lifetime matches the turn, and stale ambient descendants cannot acquire control. Uncooperative in-process work may delay cancellation, but the reported quiescent state remains truthful.
