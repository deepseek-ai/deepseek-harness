# Agent Note: Collapse agent-loop events around the observable state machine

Status: implemented

English | [中文](2026-07-24-agent-loop-observable-state-machine.zh.md)

## Problem

The agent loop exposed its control flow as a large set of Cordis events. Separate `pre-step` and `post-step` checkpoints bracketed a step, `session-prefix` and `step-result` transformed request and response messages, `request-error` decided whether a failed request retried inside its turn, and `turn-continuation` plus `turn-stop` composed competing continuation decisions.

Those events made internal phases public even when the durable session log already owned the corresponding turn and step facts. They also mixed two extension models: some listeners observed a boundary and issued an agent command, while others returned control decisions that the loop interpreted. Understanding the public machine therefore required reconstructing event order, waterfall precedence, and special terminal overrides together.

Agent lifetime, whole-agent activity, inbox-item progress, and per-turn settlement are independent state dimensions. Treating them as one status or one linear callback sequence makes ordinary questions ambiguous: an agent can remain `running` across several turns, an accepted item can be discarded without opening a turn, and one turn can settle while later work keeps the agent active.

## Decision

The public contract exposes four orthogonal state dimensions:

- Registration lifetime is the `agent/created` to `agent/disposed` interval. Disposal is the terminal registry edge, not an `AgentStatus`.
- Whole-agent activity is `AgentStatus = 'idle' | 'running'`. Consecutive turns may share one `running` interval.
- A pending message emits `agent/inbox/inserted` when inserted, then either `agent/inbox/claimed` after an atomic pure-deletion claim or `agent/inbox/discarded` after an ordinary removal. `MessageId` correlates the exact message; durable splice coordinates retain placement and cancellation. Inbox events describe insertion, claim, and discard rather than turn completion.
- A claimed turn passes through pre-step entry and zero or more request steps. An automatic retry closes the failed turn and immediately opens another; `agent/settled` reports only the terminal turn in that chain and remains distinct from the whole-agent transition to `status === 'idle'`.

The loop keeps four machine extension events. `agent/pre-step` decides reject or enter for one exclusive claimed batch and runs before every proposed step. `agent/request` is the waterfall for the frozen call configuration; the configuration comes only from `await next()`, not from a duplicate positional argument. `agent/request-error` serializes ownership of awaited model-request recovery. `agent/turn-stopping` runs when the turn otherwise has no work left; a listener that needs another step records real steering with `agent.steer()`, and the loop decides from that data after all listeners settle.

Continuation and termination are data rather than returned control enums. Tool calls and accepted steering require another step. A tool result carrying `concludesTurn` ends the tool loop at its step. The loop does not expose general `ContinuationDecision` or terminal-stop return channels.

A model-request failure closes its step, then enters `agent/request-error` with the exact error, normalized `LlmFailure`, and live turn signal. A listener that owns recovery repairs state, returns `{ kind: 'retry' }`, and stops delegating. The loop closes the failed turn and opens one retry turn over that state without an intervening idle notification; retry is not another step inside the failed turn. `agent/settled` reports the terminal outcome, and `agent/error` remains the live error notification for consumers that report failures independently of turn settlement. The [retry-action decision](2026-07-27-request-error-retry-action.md) supersedes the command-shaped part of this design.

The event taxonomy removes the legacy prompt preparation/submission and serial step hooks together with `agent/post-step`, `agent/session-prefix`, `agent/step-result`, `agent/turn-continuation`, and `agent/turn-stop`. The single `agent/pre-step` waterfall owns claimed-message entry. Durable turn and step boundaries remain session events. Model-facing additions use logged message channels, request configuration uses `agent/request`, response content is recorded as assembled, failed-request recovery uses the `agent/request-error` return action, and end-of-turn continuation uses `agent/turn-stopping` plus steering.

## Alternatives considered

**Keep the fine-grained event sequence.** This preserves a dedicated interception point for every internal phase, including request-only prefixes, assistant-message rewriting, post-step work, in-turn request recovery, and terminal stop overrides. It also makes the loop's private sequencing a permanent public contract and lets overlapping extension points express conflicting decisions. The decision accepts the lost interception points in exchange for one boundary per supported extension responsibility.

**Represent disposal as a third `AgentStatus`.** This gives retained handles a terminal status value but duplicates the registry lifecycle already expressed by `agent/disposed`. The decision keeps `AgentStatus` about live activity and makes registration lifetime a separate dimension.

**Return a retry decision from `agent/request-error`.** This alternative is superseded by the [retry-action decision](2026-07-27-request-error-retry-action.md), which removes the duplicate command and keeps the decision local to the waterfall result.

**Mirror durable turn and step boundaries as agent events.** This gives live consumers a second event stream for the same facts. The decision keeps the session log as the source of truth and exposes only extension checkpoints or live-only facts that the durable stream cannot carry.

## Consequences

The observable machine is smaller and compositional: registration lifetime, activity, item progress, and terminal settlement can be followed independently. In particular, `agent/settled` does not imply `agent.status === 'idle'`; it reports the terminal turn of one drain chain, while `agent/status` reports whether the whole agent is active.

Plugins no longer rewrite every phase of the loop. There is no request-only message prefix, assistant-message transform, post-step checkpoint, generic continuation enum, generic terminal-stop result, or in-turn request retry. Extensions use the remaining owned channels instead of recreating those phases.

Continuation plugins publish durable steering rather than returning an unlogged reason. Recovery plugins act after the failed step and return an explicit retry action. This makes every attempt a complete turn while keeping asynchronous repair and policy ownership at one narrow waterfall boundary.

The inbox lifecycle complements, rather than replaces, the durable session log. `MessageId` correlates acceptance with claim or discard; turn and step numbers, messages, tool activity, and terminal reasons remain session facts.

## Related

- [Unify agent delivery routing and coalesce injected context into user/message](../../archived/architecture/2026-07-22-unified-send-and-coalesced-user-messages.md)
- [Remove implicit batching from ordinary sends](2026-07-17-one-send-one-turn.md)
- [Microkernel event taxonomy](../architecture/2026-06-11-microkernel-event-taxonomy.md)
- [Bounded LLM request recovery](../architecture/2026-06-21-bounded-llm-request-recovery.md)
- [Reconstructable requests](../architecture/2026-07-05-reconstructable-requests.md)
