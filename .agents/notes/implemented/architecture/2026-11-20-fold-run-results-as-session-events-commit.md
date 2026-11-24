# Agent Note: Fold run results as Session events commit

Status: implemented

English | [中文](2026-11-20-fold-run-results-as-session-events-commit.zh.md)

## Problem

Two run outcomes are derived from the events of one run interval. The local subagent backend selects `SubagentResult.output` and derives `stopReason` from the events of one activation. The headless runner selects its final text and the last `turn/end` reason, which become stdout and the exit code, from the events of one invocation.

Rereading the interval from the Session log at settlement is a [deprecated synchronous history read](2026-09-09-deprecate-synchronous-session-event-reads.md). It requires every event of the interval to stay in memory until settlement, and the interval of a continuable child has no size limit.

The headless runner also scans the whole log to learn which agent preset a Session it adopts with `--session-id` currently runs under.

Neither outcome is state that a later process recovers. A `SubagentResult` is produced once, inside `finishDisposal`, by the process that ran the activation. Its consumers run in that process: the activation receipt, `subagent/end`, and the settlement notice written to the parent's log. No API returns a result for a child that is not resident. A cold resume starts a new activation, and no event written by an earlier process is part of its result. The headless runner prints the outcome of its own invocation only.

## Decision

Both readers fold each event when it commits and read the folded state at settlement. `session/event` listeners run synchronously inside `Session.append`, after the event enters the log, so a listener registered for the whole interval receives exactly the events a read of that log suffix would return. No Session event, public result type, or model-visible text changes.

### Local subagent backend

[`SubagentManager`](../../../../packages/subagent/subagent/src/manager.ts) registers one global `session/event` listener on its activation-owner scope at construction. The listener is global because scoped dispatch admits a tagged listener only for Sessions at or below its own scope, and a child can run under a preset scope that the manager's context is not in. For an event of a resident local child's Session, the listener calls `foldLocalResult`, which advances the two folds stored on the activation: an `AssistantOutputFold` and a `foldConsumedWorkForEvent` state. Materialization creates both folds in the synchronous span that follows `agents.create` or `agents.resume`, so the folds start at the Session offset where the activation begins. `captureLocalResult` reads them.

`session/event` dispatch logs and discards a listener exception. `foldLocalResult` therefore keeps the first error each fold throws and stops that fold, and `captureLocalResult` rethrows it: the output fold's error first, then the stop-reason fold's error unless a live failure already decides the stop reason. The activation result rejects with that error.

The listener is registered on the activation-owner scope because the two nearer contexts lose events:

- **The child scope.** `AgentLoop` teardown cancels the Agent, waits for idleness, disposes the child scope, and then emits `agent/disposed`. The manager captures the result inside its `agent/disposed` listener when another owner disposed the child. A child-scope listener is already removed at that point, so the result would omit any event that a child-scope disposer appends. The cancelled turn's `turn/end` commits before the scope is disposed.
- **The manager context.** Fiber unload starts all disposers of a fiber together, so a listener on the manager context is removed while `drain()` still awaits the children it cancelled. The activation-owner scope's disposer runs after `drain()` settles.

### Headless runner

[`run`](../../../../packages/bundle/headless/src/index.ts) registers a `session/event` listener on its Agent's scope before submitting the task and folds each event of that Agent's Session there. `run` is not owned by the plugin fiber: when the tree is disposed during a run, listeners on the plugin context are removed before the cancelled turn commits its interrupted `assistant/message` and `turn/end`, and `run` then continues past `agent.whenIdle()`. The Agent's scope is disposed only after the Agent is idle. `run` captures the Session offset in the same synchronous span, and the fold ignores an event below that offset, so the interval is stated by the fold and does not rest on when the listener was registered. The rule within the interval: ignore events before the first `turn/start`; a `turn/start` clears the reason; non-empty `assistant/message` text replaces the text; a `turn/end` sets the reason. The listener keeps the first error the fold throws, and `run` rethrows it where it reads the outcome, after the flush and the live-failure check.

### Headless adoption check

The `dsh-headless` bundle enables the [agent preset registry](../../../../packages/preset/agent-preset-registry/README.md) supplied by `dsh-base` and preserves the defaults configured by earlier bundles. The registry maintains the `agentPreset` projection: the header's creation-time preset, replaced by each `agent-preset/selected` event. The runner refuses to adopt a Session whose projection value is not `null`. It reads the value from the observation taken before resume, and from `agentPresets.presetForSession` for a live Agent under the same id, after resume, and before it submits the task. The registry's `default` is optional so that a composition can mount the registry for this projection alone; a caller that requests no preset fails where it resolves or mounts one.

### Fold functions

- `foldConsumedWorkForEvent(state, event)` takes the fold over the preceding events and the next event, and returns the fold that includes it. `undefined` stands for the state before the first event, so the package exports no initial value. `ConsumedWorkFoldState` extends `ConsumedWork` with the fold's own fields: the open turn and two turn-number sets. The sets are updated in place and carried into the returned state, so a caller advances each state once.
- `foldConsumedWork(events)` keeps its signature and its returned fields. It advances one state over the array with `foldConsumedWorkForEvent`, so both functions apply one rule.
- `AssistantOutputFold` discards its stream-text fallback once a non-empty message exists. `collect()` never reads the fallback after that point. The SDK and ACP backends use the same class.

## Alternatives considered

**Keep the outcome in a Session projection.** A projection persists state for recovery after a restart. No consumer reads a run outcome after the process that produced it exits, and a new activation starts from an empty fold. The state would also hold a complete message, which is not fixed-size.

**Log an activation-start or settlement event and read between markers.** The markers would let a later process find the interval, which no consumer needs. Settlement would still read the interval, through storage instead of memory.

**Read the suffix through an explicit asynchronous storage read.** Settlement needs two derived values, not the records. The read would add I/O proportional to the interval on every settlement, and the `agent/disposed` path captures the result synchronously after the write handle closed.

**Require every child to hand back its result through a tool.** This answers a different question: what the result is, not how it is computed. A child that ends without calling the tool still needs the last-message rule, so the fold remains. A child-only tool and prompt section also break KV-cache reuse of a forked child's inherited prefix, which the [fork decision](2026-08-10-fork-children-stay-one-shot.md) avoids.

**Decide adoption from the Session header alone.** The header records the preset a Session was created with. A blank Session can select another preset, which is logged as `agent-preset/selected` and leaves the header unchanged. A Session created without a preset and later reused under one would be adopted and continued under the headless tools and prompts.

**Copy the turn-number sets for each event.** A fully immutable state would copy both sets on every event of every resident child, and `claimed` grows with the number of turns. The one consumer owns its state privately and uses only the returned value, so a later immutable implementation needs no caller change.

**Replace `foldConsumedWork(events)` with the per-event function.** The array form is a published export of `@deepseek-ai/dsh-agent`. Keeping it leaves its callers and its existing specs unchanged, at the cost of one more value export from that plugin entry.

**Replace the two turn-number sets in `foldConsumedWork` with scalars for the open turn.** The state becomes constant-size, but `step/start` and `turn/end` are keyed by their own turn number and not by the open turn, so equivalence needs a separate argument. Both sets release the turn number when that turn closes.

## Consequences

- `activation.ts` and the headless runner contain no synchronous history read.
- Every headless Session's projection checkpoint carries an `agentPreset` row, and the plugin package list sent with DeepSeek requests names the registry package.
- `--session-id` requires the `agentPresets` service. Adoption reads a cached projection row where one exists, so a damaged cache row can refuse a Session that its log would allow.
- A malformed `agent-preset/selected` record is not reported as malformed. A persisted Session with a missing or non-string value fails projection at observation; a live Session with such a value, or any Session with an empty string, is refused under that value's text as the preset name; a `null` value reads as no preset and the Session is adopted. Writers record non-empty strings only.
- With the registry mounted, a `tool-subagent` row that selects an agent preset activates in a composition that declares none; the unknown preset is reported when a child is started.
- The fold step runs inside `Session.append` for every event of every resident child, where a suffix read would run once per settlement. The owner-scope listener is also called for every other Session event in the process and returns after one map lookup.
- After a tree disposal, the headless fold ends when the Agent's scope is disposed, while `run` reads the outcome later. A `turn/start`, `assistant/message`, or `turn/end` appended in between is not folded. Only the agent loop's driver appends those types, and it is idle before its scope is disposed.
- The manager releases the activation-owner scope and removes its listener even when `drain()` rejects.
- A result must be read outside `session/event` dispatch. A batch append pushes every member into the log before it dispatches the first, so a read from inside a listener would see folds that lag the log.
- This decision does not own the rule that a run's output is its last non-empty assistant message, or the redelivery of a settlement notice lost while the parent was offline.

## Testing

- `consumed-work.spec.ts` asserts each scenario through `foldConsumedWork(events)`, which runs `foldConsumedWorkForEvent` for every event, and advances one state from `undefined` directly.
- `continuation.spec.ts` asserts that the activation result equals the batch folds over the child's log suffix in three teardowns: another owner disposes the child, the manager unloads, and a child-scope disposer appends a message after the child scope's listeners are gone. The last two fail when the listener is registered on the manager context or the child scope.
- `continuation.spec.ts` mounts the manager under a scope its child is not in and asserts the child's output; it fails without the global listener. It also appends an event the output fold cannot read and asserts the result rejects with the fold's error.
- `local-result.spec.ts` covers the order in which the two folds' errors are rethrown and the live-failure case that skips the stop-reason fold.
- `terminal-failures.spec.ts` disposes the runner's plugin during a streaming turn and asserts the `final` event carries the partial text and the `disposed` abort reason. It fails when the fold is registered on the plugin context.
- `headless.spec.ts` covers the interval rule, its starting offset, exit codes, and live-failure precedence through `run`, and a fold error reported as the run's failure.
