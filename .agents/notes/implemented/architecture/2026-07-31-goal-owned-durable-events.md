# Agent Note: Goal-owned durable events

Status: implemented

English | [中文](2026-07-31-goal-owned-durable-events.zh.md)

## Problem

Goal state and inbox state have different lifecycles. A goal mutation must survive restart and fork whether or not any related model context is admitted, while an inbox message may be edited, claimed, rejected, or discarded as part of step scheduling. Encoding a goal mutation inside a round-zero inbox message made queue placement the domain commit point and required replay to reconcile insertion, admission, message identity, source metadata, and rendered content.

The goal domain needs durable state, but it does not need ownership of pending model input. Continuation scheduling still needs the inbox; goal persistence does not.

## Decision

`@deepseek-ai/dsh-goal` owns a durable `goal/change` session event. Each event carries the complete post-mutation goal snapshot or a revisioned clear tombstone. `GoalService` appends that event synchronously, then emits `goal/changed`; strict replay and the `goal` session projection fold only `goal/change` for lifecycle state.

`GoalMessageSource` identifies only positive admitted continuation rounds. A matching `user/message` advances `roundsStarted`; ordinary user messages and inbox splice events do not change goal state. The goal package never inserts, claims, removes, or inspects inbox messages. `@deepseek-ai/dsh-goal-round-driver` remains responsible for queuing and tracking its own continuation prompts through the public inbox lifecycle.

Activation remains process-local. The service associates the synchronously appended event sequence with the requested activation while its cache observes the event; replayed or externally appended changes default to disarmed. The session log remains the only durable authority.

The domain does not automatically project each mutation into model input. Goal tools return current state, and continuation prompts include the objective and round state when work is actually scheduled. Any future always-visible goal context is a separate context plugin that owns its inbox message rather than a persistence side effect.

## Alternatives considered

- **Keep round-zero goal messages as the durable record.** Rejected because it couples domain commits to queue mutation and requires the goal fold to understand claim and admission reconciliation even though queue outcomes cannot roll back domain state.
- **Derive goal state only from model-visible messages.** Rejected because a mutation may be valid and durable without opening a step, and cancellation or policy rejection must not erase it.
- **Store goals in a separate database.** Rejected because the ordered session log already supplies persistence, replay, and fork inheritance without a second atomicity boundary.

## Consequences

Goal state is independent of inbox placement and admission. Replay has one mutation path, projections advance directly on `goal/change`, and continuation messages carry only round attribution. The model does not receive a mutation-only `<goal_state>` message; model-visible state appears through goal tools and scheduled continuation prompts. Direct session writers remain trusted and can append malformed changes, which the strict fold and invariant companion reject.

Focused goal, goal-round-driver, command, TUI, and Client RemoteMock tests pin durable replay, positive-round accounting, inbox independence, projection updates, and restored-session behavior. The keyless process test inspects the persisted `goal/change` event and verifies that creation alone starts no continuation round.
