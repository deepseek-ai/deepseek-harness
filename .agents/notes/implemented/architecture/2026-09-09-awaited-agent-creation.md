# Agent Note: Awaited per-agent initialization

Status: implemented

English | [中文](2026-09-09-awaited-agent-creation.zh.md)

## Problem

Shared presets install tools and prompt sections separately for each Agent. That installation can await plugin activation, and external SessionStart hooks can produce context asynchronously. A creator must know that these contributions have finished before the Agent's first model request.

## Decision

`agent/created` is the serial initialization event after factory setup and registry entry. Each listener finishes before the next starts; a throw or rejection fails creation and skips later listeners. The payload retains `SessionStartSource` and accepts the factory's cancellation signal. `register()` and `announce()` are awaited by their callers. Lifecycle source selection belongs to factory publication through `announce()`; `register()` announces fresh startup.

AgentLoop holds its existing maintenance activity through setup and creation dispatch. Input may enter the inbox during initialization, but the driver starts only after successful completion. Failure cancels that activity without waking queued input; ordered teardown owns inbox cleanup. Keeping these operations separate preserves the initialization error when another teardown has already removed the inbox projection.

Creation dispatch retains the scope and Session while listeners await. Disposal cancels initialization and joins the dispatch before releasing those resources. A listener must not await its own Agent's idle state or its owner's disposal, because each waits for that listener to finish. Background work on another Agent follows that Agent's own initialization lifecycle.

This decision owns asynchronous creation timing. The [scope runtime decision](2026-07-12-agent-scope-runtime-design.md) retains registry identity and teardown ownership, while the [interception decision](../feature/2026-06-30-interception-extension-points.md) retains policy and tool-event semantics.

## Alternatives considered

**A separate setup event.** Existing creation listeners already install per-agent contributions. A second initialization event splits that responsibility without a distinct consumer need.

**Detached initialization.** Returning before plugin activation or hook context settles lets the first request omit required tools or context and disconnects initialization failure from the creator.

## Consequences

Creation latency includes asynchronous plugin and SessionStart work. Initializer failures become caller-visible creation failures, and cancellation relies on listeners settling cooperatively. Notifications already delivered cannot be undone; rollback pairs them with disposal notifications.

Scoped installer tests verify rollback, lifecycle tests verify ordered completion and cancellation, and the SDK serial-created scenario verifies that asynchronous prompt context reaches the first request. Hook tests cover awaited context injection and subprocess disposal.
