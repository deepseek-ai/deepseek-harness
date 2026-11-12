---
description: "Compose typed source instances and connect their output to existing Schedule tasks; open this reference for the source class, subscription and disposer semantics, error identity, and model-visible effects."
kind: "package-reference"
---

# @deepseek-ai/dsh-schedule/source

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-schedule/source` is the typed source entry of the Schedule package. Compose independent source instances in plugins and pass typed observations between them. Source-to-source data uses each source's own type and is not constrained to task text. A source class can have multiple instances, accept input from several other sources, and deliver output to several consumers. Connect final text output to stored automation tasks when it is ready to become model input. Delivery is asynchronous, and disconnecting waits for accepted work rather than dropping it.

## Table of Contents

- [Use this entry](#use-this-entry)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-entry"></a>
## Use this entry

Extend `AutomationSource<T>` for each source class. Each instance owns its state, observations, and any timers. Its input methods keep their own types; subscribing to an upstream instance does not require a kind registry, a handler, or a task binding.

```ts
import { AutomationSource } from '@deepseek-ai/dsh-schedule/source'

class StatusSource extends AutomationSource<string> {
  publish(status: string): Promise<void> {
    return this.emit(status)
  }
}

const first = new StatusSource()
const second = new StatusSource()
const connection = first.subscribe(status => second.publish(status))
await first.publish('changed')
await connection.dispose()
await first.dispose()
await second.dispose()
```

For task delivery, a composing plugin injects `schedule` and calls `ctx.schedule.connectSource(source, taskId)` for an `AutomationSource<AutomationCandidate>` and an existing `ScheduleId`. This entry is not a Loader plugin and has no `apply` or default export; mount the Schedule package normally and import the class from this subpath. Schedule's readiness includes the connection operation; no separate receiver registration is needed. One source can connect to several tasks, and several sources can connect to the same task. Calling `connectSource` before Schedule is ready or while Schedule is stopping throws `SOURCE_TASK_RECEIVER_UNAVAILABLE`; declare the `schedule` dependency and retry after readiness. Schedule does not retry automatically.

The composing plugin owns its sources through `ctx.effect()`; Schedule automatically owns each task connection in the calling context. `connectSource` synchronously returns the exact Cordis disposer function, not a `SourceConnection` object. A direct `source.subscribe` returns a `SourceConnection` whose `dispose()` awaits the same accepted work on every call; the task connection's first call returns a Promise that drains accepted work; await that result or the owning plugin's disposal, and later calls are no-ops that do not join an in-progress drain. A generator effect yields that `disconnect` function directly, without wrapping it, to order cleanup with its sources.

Stop and drain producers before releasing a source or task storage that depends on them. A composite source disposes only its own upstream subscriptions, not borrowed upstream instances. A receiver must not await its own connection's `dispose()` or the current emitter source's `dispose()` from inside an accepted call; either waits for that call to return and self-deadlocks.

Output waits for every receiver, even when one fails. Receivers may run concurrently, and consecutive outputs can overlap unless the producer serializes them. A `SOURCE_DELIVERY_FAILED` error preserves every receiver failure in the aggregate cause. Some receivers may already have committed; neither the source nor Schedule retries the whole output. A task connection captures one Schedule runtime; it rejects delivery after that runtime stops and never switches to a replacement. The source fan-out surfaces that rejection as `SOURCE_DELIVERY_FAILED`. Recreate the connection against a valid runtime after declaring the `schedule` dependency; Schedule does not retry or rebind automatically.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

Sources communicate through instance-owned subscription sets and typed callbacks. `SourceReceiver<T>` is an asynchronous callback; `SourceConnection.dispose()` stops new calls and joins the same accepted work on every call; `AutomationCandidate.text` carries the extra input without truncation. The base class records accepted calls before invoking a receiver, so both disconnecting and disposing the source wait for those calls. The base class owns no polling frequency, recurrence evaluator, source factory, or dependency-graph interpreter. A subclass stops external producers and drains input before it disposes output subscriptions.

`SourceError` is declared in [`src/source-error.ts`](../src/source-error.ts). The Schedule root bundle contains its single constructor: the package entry runtime-exports `SourceError` and type-exports `AutomationSource`, while the [`./source`](../src/source.ts) leaf imports `SourceError` from the root package specifier. The root entry does not runtime-import the leaf, so this import creates no runtime cycle. A relative leaf import would load the tsc-emitted `source-error.js` copy, producing a second constructor and breaking `instanceof` and error identity between the leaf and the root bundle.

Sources communicate directly with other sources. Schedule connects final source output to existing tasks and owns task lookup, active-status checks, delivery admission, target Session activation, and persistence acknowledgement. See [`src/source.ts`](../src/source.ts) for subscriptions and [`src/source-types.ts`](../src/source-types.ts) for receiver, connection, candidate, and error-code types; the [Schedule package](../README.md#source-delivery) owns task connection and delivery framing.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Schedule subsystem](../../../../docs/subsystems/schedule.md#source-instances) — source and task delivery semantics.
- [Schedule package](../README.md) — task storage, targets, and model-visible reminder framing.
- [Cordis primer](../../../../docs/cordis-primer.md) — plugin dependencies and reversible effects.

-----

<a id="model-experience"></a>
## Model Experience

### Source-produced task input

#### What the model sees

Source-to-source observations are not model input. A task connection submits the candidate's text to the Schedule task service; the [Schedule source observations section](../README.md#source-observations-in-the-target-session) owns the logged user message and framing. This entry adds no tools or prompt sections.

#### Token effect

Intermediate observations add no model tokens. Accepted task deliveries add the candidate text and Schedule's framing to that Session's conversation; the linked Schedule section owns the exact tokens.

#### KV Cache effect

Source subscriptions do not change request prefixes. Task delivery appends input through the Schedule service; that service owns replay and request construction.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Source instances, connections, and intermediate state are process-local. A plugin must explicitly own any durable observation state and reconstruct its composition after restart.
- Composition is programmatic. This entry supplies no source editor, persisted dependency graph, built-in observation provider, or generic polling/retry policy.
- Source owners bound observation size and output rate before publishing. This API preserves candidate text without truncation or an entry-level size limit. A producer that continuously publishes at the shared interval can postpone timed delivery indefinitely; it must leave capacity for timed work.
- Schedule's source connection accepts active existing tasks and preserves their timing. This connection does not replace the stored timing model or create event-only tasks. An executing task, a task inside its minimum delivery interval, or a task recovering an outstanding delivery rejects the current candidate delivery with `SOURCE_TASK_BUSY`; the source fan-out surfaces that rejection as `SOURCE_DELIVERY_FAILED`. The task does not store or queue the candidate, and recovery holds the previous inbox delivery. The producer owns retry and rate limiting.
