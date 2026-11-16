# Agent Note: Typed source instances for automation input

Status: implemented

English | [中文](2026-11-11-typed-source-instances.zh.md)

## Problem

Observing an event and deciding whether to emit it can require the same local state and timer. Separating these operations into a source provider and one task handler obscures which object owns that state. Registering one object per source kind also conflates an implementation class with the independently configured observations that use it.

## Decision

[`AutomationSource<TOut>`](../../../../packages/schedule/schedule/source/README.md) represents one output-producing instance. Concrete classes own observation, typed inputs, timing, and condition evaluation; the same class can have multiple independent instances. The receiver connects to an upstream output with `sourceB.connect(sourceA.output)`. Sources and runtimes use the same `SourceInput` protocol: `ctx.schedule.input(id).connect(source.output)` accepts final `{ text }` candidates for an existing task. Source-to-source data retains its own types. Source classes require no separate router, task-id registry, handler, or receiver registration.

`connection.send(value)` addresses one receiver; `emit(value)` broadcasts through the same operation over the output's connection snapshot. Sharing a connection retains its direction and closure state. Broadcast waits for all receivers and aggregates failures without rollback, so one failure does not suppress unrelated receivers. Connection disposal rejects new sends; repeated disposal joins accepted calls even after the connection detaches from its endpoints. A composite closes and drains its owned inputs before closing output, allowing accepted inputs to finish derived delivery; it does not dispose borrowed upstream instances. Composers explicitly keep downstream inputs and storage alive until dependent producers drain. The composer declares the Schedule dependency; drain-ordered consumer children inherit it. An independent declaration on a child lets provider deactivation close that child before the composer's ordered cleanup reaches it.

`TimeSource` owns clock production, coalesced acknowledged requests, and a segmented timer. It accepts computed deadlines and emits actual wall-clock milliseconds through the common output protocol. The runtime's numeric input awaits the transactional due scan; runtime policy owns recurrence rules, delivery floors, batching, and persistence. Clock production does not replace task timing policy.

This supersedes the provider/trigger implementation split in the [event-triggered tasks proposal](../../proposed/feature/2026-10-29-event-triggered-automation-tasks.md), not its unimplemented product features. The proposal remains active for event-only task storage, external-source integrations, observation records, and their task UI. Existing timed task storage and evaluation remain independent of these programmatic source connections.

## Alternatives considered

**One provider per kind with task bindings and a separate handler.** This prevents independent instances from owning their observations directly and divides timing and condition state between two extensibility interfaces. A composite condition is instead another source class with typed inputs.

**An instance-address registry and persistent dependency graph.** No current source composition requires serialization or string lookup. Direct references retain input types and avoid defining graph scheduling, routing loops, unknown-payload validation, or reconnection semantics before a consumer needs them.

**A source factory service wrapping Cordis scopes.** Cordis already owns plugin effects. Adding another creation and scope mechanism would duplicate that ownership without a source-specific operation; task delivery uses the existing Schedule service that owns its store.

**A separate task router with receiver registration.** Readiness of two services does not order a receiver registration performed by another injection child. A composer can become active before that child registers the receiver. Keeping the connection operation on Schedule makes task delivery available with Schedule itself, without requiring a router in existing timed-only compositions.

## Consequences

Plugin authors explicitly construct and dispose source instances. They retain responsibility for polling budgets, input serialization, durable observation state, and reporting failures from background producers. Source instances, connections, and intermediate observations are process-local; a task connection does not create an event-only task or a restricted execution mode. External observation providers must establish their own trust and permission policy before sending data to an ordinary task.

Tasks remain durable in Schedule. The task input preserves the stored instruction, timing, and status, appends source data to the logged user message, and acknowledges Session persistence and the task receipt rather than model completion. Its two commits are not atomic, and source broadcast is not transactional; automatic replay could duplicate already committed deliveries. The lifetime obligations apply both when Loader unloads a composing plugin and when a required provider becomes inactive.
