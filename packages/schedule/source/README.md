---
description: "Compose typed source instances and deliver their output to automation tasks."
kind: "package-reference"
---

# @deepseek-ai/dsh-source

English | [中文](README.zh.md)

## Summary

Compose independent source instances in plugins and pass typed observations between them. A source class can have multiple instances, accept input from several other sources, and deliver output to several consumers. Connect final text output to stored automation tasks when it is ready to become model input. Delivery is asynchronous, and disconnecting waits for accepted work rather than dropping it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Extend `AutomationSource<T>` for each source class. Each instance owns its state, observations, and any timers. Its input methods keep their own types; subscribing to an upstream instance does not require a kind registry, a handler, or a task binding.

```ts
import { AutomationSource } from '@deepseek-ai/dsh-source/source'

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

For task delivery, a composing plugin injects `schedule` and calls `ctx.schedule.connectSource(source, taskId)` for an `AutomationSource<AutomationCandidate>` and an existing `ScheduleId`. This package is a library, not a plugin to mount. Schedule's readiness includes the connection operation; no separate receiver registration is needed. One source can connect to several tasks, and several sources can connect to the same task.

The composing plugin owns its sources through `ctx.effect()`; Schedule automatically owns each task connection in the calling context. `connectSource` synchronously returns the exact Cordis disposer function, not a `SourceConnection` object. A generator effect yields that `disconnect` function directly, without wrapping it, to order cleanup with its sources. Await the first invocation to drain accepted work; later invocations are no-ops and do not join an in-progress drain.

Stop and drain producers before releasing dependent sources or task storage. A composite source disconnects its own upstream subscriptions; it does not dispose borrowed upstream instances. A receiver must not await its own connection's disposal from inside that receiver, because disposal waits for the call to return.

Output waits for all receivers, even when one fails. Receivers can run concurrently, and consecutive outputs can overlap unless the producer serializes them. A `SOURCE_DELIVERY_FAILED` error retains all receiver failures in its aggregate cause. Some receivers may already have committed; neither the source nor Schedule retries the whole output. A task connection captures one Schedule runtime and rejects after it unloads instead of silently switching to a replacement.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Sources communicate through instance-owned subscription sets and typed callbacks. The base class tracks accepted calls before invoking receivers, so disconnection and source disposal can wait for them. It owns no polling cadence, recurrence evaluator, source factory, or dependency-graph interpreter. Subclasses stop external producers and drain input before disposing their output subscriptions.

Sources communicate directly with other sources. Schedule connects final source output to its existing tasks and owns task lookup, active-state checks, delivery limits, target Session activation, and durable acknowledgement. See [source.ts](src/source.ts) for subscriptions and [Schedule](../schedule/README.md#source-delivery) for task connections.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Schedule subsystem](../../../docs/subsystems/schedule.md#source-instances) — source and task-delivery semantics.
- [Schedule package](../schedule/README.md) — task storage, targets, and model-visible reminder framing.
- [Cordis primer](../../../docs/cordis-primer.md) — plugin dependencies and reversible effects.

-----

<a id="model-experience"></a>
## Model Experience

### Source-produced task input

#### What the model sees

Source-to-source observations are not model input. A task connection submits the candidate's text to the task service; [Schedule's source-delivery framing](../schedule/README.md#source-delivery) owns the resulting logged user message. This package adds no tools or prompt sections.

#### Token effect

Intermediate observations add no model tokens. Accepted task deliveries add the candidate text and the task service's framing to that Session's conversation.

#### KV Cache effect

Source subscriptions do not change request prefixes. Task delivery appends input through the receiving service; that service owns replay and request construction.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Source instances, connections, and intermediate state are process-local. A plugin must explicitly own any durable observation state and reconstruct its composition after restart.
- Composition is programmatic. This package supplies no source editor, persisted dependency graph, built-in observation provider, or generic polling/retry policy.
- Source owners bound observation size and output rate before publishing. This API preserves candidate text without truncation or a package-level size limit.
- Schedule's source receiver accepts active existing tasks and preserves their timing. This connection does not replace the stored timing model or create event-only tasks.
