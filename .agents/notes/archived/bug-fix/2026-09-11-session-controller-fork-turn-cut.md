# Agent Note: Session Controller forks stop at the selected turn end

Status: implemented
Archived: 2026-09-16

English | [中文](2026-09-11-session-controller-fork-turn-cut.zh.md)

## Problem

A user input enters the durable inbox before its `turn/start`. Extending a completed-turn fork through the following between-turn events can copy the next input's insertion without its later removal. Continuing the child then executes an input from beyond the selected turn.

## Decision

The [Session Controller](../../../../packages/api/session-controller/README.md) copies the contiguous prefix through the selected `turn/end`, inclusive. Explicit anchors select the first closing event at or after the anchor; omitted and past-end anchors select the last closing event. No event after that closing event belongs to the seed, including queued input, titles, and model settings.

The lower-level `SessionStore.fork()` retains its explicit stable-event semantics from the [log-only event decision](../simplification/2026-07-28-remove-synthetic-log-only-turns.md). Selecting a completed turn in the controller does not request a later stable event.

## Alternatives considered

**Stop only at the next inbox event.** Event-type exceptions still copy unrelated state changes after the selected turn and require the controller to classify plugin-owned events.

**Copy the tail and clear the child's inbox.** Clearing adds child events to cancel input that lies outside the requested prefix, while still inheriting other state from after the selected turn.

## Consequences

A fork inherits the configuration recorded through its selected turn. Later configuration and title events are excluded. The client may independently assign the child's fork title. Events already inside the selected prefix retain their ordinary replay semantics; this decision does not redefine pending input inserted before the selected closing event.

## Verification

Controller tests execute the production loop and check that sending C after forking A excludes the parent's later B from child history and produces one model request. Message, closing-event, omitted, and past-end anchors share this assertion. Model-routing coverage excludes a later configuration change. The Web message-actions snapshot seeds a queued input after the completed turn and verifies the branch action creates a child without that input or its inbox insertion.
