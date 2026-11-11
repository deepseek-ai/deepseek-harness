# Agent Note: Typed source instances for automation input

Status: implemented

English | [中文](2026-11-11-typed-source-instances.zh.md)

## Problem

Observing an event and deciding whether to emit it can require the same local state and timer. Separating these operations into a source provider and one task handler obscures which object owns that state. Registering one object per source kind also conflates an implementation class with the independently configured observations that use it.

## Decision

[`AutomationSource<T>`](../../../../packages/schedule/source/README.md) represents one output-producing instance. Concrete classes own observation, input methods, timing, and condition evaluation. They compose through typed object references and asynchronous subscriptions; the same class can have multiple independent instances. Source-to-source data is not constrained to task text. The task router only connects final `{ text }` candidates to an installed task receiver and does not create, look up, or schedule sources.

Subscription disposal stops accepting new calls and drains accepted calls. A composite source owns its subscriptions, not borrowed upstream instances. Fan-out waits for every receiver and reports aggregate failure without implying rollback. These obligations preserve task-storage lifetime through pending delivery and keep one failing subscriber from suppressing unrelated subscribers.

This supersedes the provider/trigger implementation split in the [event-triggered tasks proposal](../../proposed/feature/2026-10-29-event-triggered-automation-tasks.md), not its unimplemented product features. The proposal remains active for event-only task storage, restricted event turns, observation records, and notifications. Existing timed task storage and evaluation remain independent of these programmatic source connections.

## Alternatives considered

**One provider per kind with task bindings and a separate handler.** This prevents independent instances from owning their observations directly and divides timing and condition state between two extensibility interfaces. A composite condition is instead another source class with typed inputs.

**An instance-address registry and persistent dependency graph.** No current source composition requires serialization or string lookup. Direct references retain input types and avoid defining graph scheduling, routing loops, unknown-payload validation, or reconnection semantics before a consumer needs them.

**A source factory service wrapping Cordis scopes.** Cordis already owns plugin effects. Adding another creation and scope mechanism would duplicate that ownership without a source-specific operation; only task delivery needs a mounted service shared with the task store.

## Consequences

Plugin authors explicitly construct and dispose source instances. They retain responsibility for polling budgets, input serialization, durable observation state, and reporting failures from background producers. Source instances and intermediate observations are not automatically persisted, and a task connection does not create an event-only task or a restricted execution mode. External observation providers must establish their own trust and permission policy before sending data to an ordinary task.

The task receiver preserves the stored instruction and schedule, appends source data to the logged user message, and acknowledges Session persistence and the task receipt rather than model completion. Its two commits are not atomic, and source fan-out is not transactional; automatic replay could duplicate already committed deliveries. Verification therefore includes multiple instances, typed composite inputs, receiver failures, disconnection during accepted output, real Loader disposal, and durable task acknowledgement.
