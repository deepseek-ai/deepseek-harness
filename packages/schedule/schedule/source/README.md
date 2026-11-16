---
description: "Connect typed Source outputs to receiving Sources and Schedule inputs; this reference covers directed delivery, broadcast, cleanup, TimeSource, and shared constructor identity."
kind: "package-reference"
---

# @deepseek-ai/dsh-schedule/source

English | [中文](README.zh.md)

## Summary

Compose independent Source instances and connect each receiver to an upstream output. Send a value through one connection or broadcast to all connected receivers. Intermediate values keep their own types; final text can accompany an existing automation task's instruction. Several Sources can feed one input, and one output can feed several inputs. Connections wait for accepted work when closed. Instances and intermediate state remain process-local.

## Table of Contents

- [Use this entry](#use-this-entry)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-entry"></a>
## Use this entry

Extend `AutomationSource<TOut>` to own output and any inputs created with `createInput<TIn>(receive)`. A composite exposes the input's bound `connect` function: `sourceB.connect(sourceA.output)` establishes delivery from A to B. A class with distinct input types can expose `connectLeft` and `connectRight`. A pure producer needs only its output and production methods.

```ts
import { AutomationSource } from '@deepseek-ai/dsh-schedule/source'
import type { AutomationCandidate } from '@deepseek-ai/dsh-schedule'

class StatusSource extends AutomationSource<string> {
  publish(status: string): Promise<void> {
    return this.emit(status)
  }
}

class StatusText extends AutomationSource<AutomationCandidate> {
  readonly connect = this.createInput<string>(async status => {
    await this.emit({ text: status })
  }).connect
}

const first = new StatusSource()
const second = new StatusText()
const connection = second.connect(first.output)
await first.publish('changed')
await connection.send('direct observation')
await connection.dispose()
await second.dispose()
await first.dispose()
```

`SourceInput<T>` accepts a `SourceReceiver<T>` callback returning `Promise<void>`. Resolution acknowledges that input operation, not every future output it might produce. A receiver can update state and wait for another input before emitting; a receiver that awaits derived output includes that delivery in its acknowledgement. `SourceOutput<T>` and `SourceInput<T>` are also available directly from the Schedule root entry. This subpath is not a Loader plugin and has no `apply` or default export; mount the Schedule package normally.

### Directed delivery and broadcast

`connection.send(value)` delivers only to that connection's receiver. Sharing the connection shares its direction, pending calls, and closed state: any holder can send or close it. `emit(value)` broadcasts through a snapshot of the output's current connections. Both paths record accepted work before deferred receiver callbacks run. Receivers must not mutate shared values. Concurrent sends and broadcasts can overlap; the protocol supplies no FIFO.

A directed send preserves the receiver's rejection. Broadcast waits for every receiver and reports failures as `SOURCE_DELIVERY_FAILED` with an aggregate cause. Other receivers may already have committed: delivery is not atomic, and the protocol does not retry or replay. An output without connections completes without delivery.

### Connect a task input

A composing plugin declares a `schedule` dependency and uses `ctx.schedule.input(taskId).connect(source.output)` for output containing `AutomationCandidate.text`. Schedule owns the returned `SourceInput<AutomationCandidate>` in the caller's context and closes it when its runtime stops. Each connection is an ordinary `AutomationConnection<AutomationCandidate>` with `send()` and `dispose()`; repeated disposal joins accepted work. The [Schedule package](../README.md#source-delivery) owns task admission, persistence acknowledgement, and message framing.

`input(taskId)` requires a ready, running Schedule service; otherwise it throws `SOURCE_TASK_RECEIVER_UNAVAILABLE`. A callback reaching the service after its mutation FIFO stops admitting work rejects with `SOURCE_CLOSED`; previously admitted FIFO work still finishes. A stopped runtime closes its inputs and connections without rebinding them. Sending through a closed connection rejects with `SOURCE_CONNECTION_CLOSED`; broadcasting from an otherwise open output with no remaining connections produces no delivery. Reconnect to a new input after the replacement service becomes ready.

### Time input

`TimeSource` outputs actual `Date.now()` samples as numbers. Its constructor takes a failure-reporting callback that must not throw. `request()` cancels the timer and requests a sample; requests during a pending broadcast coalesce into one next sample. `arm(next)` sets one bounded timer segment toward a finite epoch-millisecond deadline; `arm(undefined)` cancels it. Each long-wait segment emits a sample, and the receiver rearms from its computed deadline. Disposal stops requests and waits for accepted output.

The Schedule runtime uses `runtime.connect(time.output)`, backed by `SourceInput<number>`. Its receiver directly awaits the due scan inside the mutation FIFO rather than requesting another time signal. Runtime task policy computes the next deadline and owns recurrence evaluation, batching, delivery floors, and stored occurrences. `TimeSource` does not parse timing rules. Its numeric output cannot connect directly to a text task input; common connection semantics do not remove payload type constraints.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

### Cleanup ownership

Input and output endpoints track accepted calls even after a connection detaches. Closing either endpoint rejects new connections and closes its existing connections; closing a connection rejects new sends. Repeated disposal joins the same drain. An individually disposed input remains owned by its Source until its drain succeeds; the Source then releases that input without closing other inputs or output. With no owned inputs remaining, Source disposal closes output admission immediately. `AutomationSource.dispose()` closes and drains its owned inputs while output remains usable, then closes and drains output. Subclasses stop external producers before calling it. Borrowed upstream Sources remain owned by their creators.

A receiver must not await its own connection, input, Source, or current emitter's disposal from inside an accepted call: that cleanup waits for the call to return. Connection and endpoint disposal wait for settlement; delivery errors belong to the original send or broadcast.

A composite that can emit while draining must finish before its task input closes. The composing plugin must declare `schedule`; its explicitly owned consumer child inherits that binding with `ctx.inject([])`. Repeating `schedule` in the child's injections lets provider deactivation unload it independently, before the composite drains. The task input's caller-owned Cordis effect is separate from its public disposer: yielding a wrapper around `input.dispose()` or `connection.dispose()` does not transfer that effect's ownership. Yield the exact child disposer before composite cleanup in one synchronous generator effect. Reverse cleanup order drains the composite first and disposes the consumer child afterward.

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { AutomationCandidate, AutomationSource, ScheduleId } from '@deepseek-ai/dsh-schedule'

export function ownComposite(ctx: Context, id: ScheduleId, composite: AutomationSource<AutomationCandidate>): void {
  const consumer = ctx.inject([], scope => {
    scope.schedule.input(id).connect(composite.output)
  })
  ctx.effect(function* () {
    yield consumer.dispose
    yield () => composite.dispose()
  })
}
```

### Publication and implementation owners

The root entry owns the runtime constructors for `SourceError`, `SourceInput`, `SourceOutput`, and `TimeSource`. The leaf imports those constructors from `@deepseek-ai/dsh-schedule` and re-exports the input, output, and time classes. Root and leaf consumers therefore share constructor identity. The root only type-exports `AutomationSource`, with no runtime import of the leaf. The root-owned protocol imports its error relatively; the emitted leaf must not import separate relative copies of root-owned classes.

[`source-protocol.ts`](../src/source-protocol.ts) owns inputs, outputs, and directed connections; [`source.ts`](../src/source.ts) owns composite input-before-output cleanup; [`time-source.ts`](../src/time-source.ts) owns clock requests and the segmented timer. [`source-types.ts`](../src/source-types.ts) defines receiver, connection, candidate, and error-code types. Schedule retains task lookup, activation, admission, and persistence responsibilities.

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

Source-to-source observations and TimeSource samples are not model input. A text task input submits the candidate's text to Schedule; the [Schedule source observations section](../README.md#source-observations-in-the-target-session) owns the logged user message and framing. This entry adds no tools or prompt sections.

#### Token effect

Intermediate observations add no model tokens. Accepted task deliveries add the candidate text and Schedule's framing to that Session's conversation; the linked Schedule section owns the exact tokens.

#### KV Cache effect

Source connections do not change request prefixes. Task delivery appends input through the Schedule service; that service owns replay and request construction.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Source instances, connections, and intermediate state are process-local. A plugin must explicitly own any durable observation state and reconstruct its composition after restart.
- Composition is programmatic, without a Source editor, persisted dependency graph, handler layer, or generic polling/retry policy. TimeSource accepts computed deadlines; it does not add a task kind or configuration format.
- Source owners bound observation size and output rate before publishing. This API preserves candidate text without truncation or an entry-level size limit. A producer that continuously publishes at the shared interval can postpone timed delivery indefinitely; it must leave capacity for timed work.
- Text task input preserves existing task timing. An executing task, a task inside its minimum delivery interval, or a task recovering an outstanding delivery rejects the current candidate with `SOURCE_TASK_BUSY`. Direct send preserves that error; broadcast aggregates it. The task does not store or queue the candidate, and recovery holds the previous inbox delivery. The producer owns retry and rate limiting.
- Source delivery adds no event-only task schema or durable connection graph. Connection sharing does not transfer exclusive ownership or provide caller-specific access control.
