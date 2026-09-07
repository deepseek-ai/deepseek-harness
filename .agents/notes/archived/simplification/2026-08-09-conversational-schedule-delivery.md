# Agent Note: Conversational Schedule delivery

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-09-conversational-schedule-delivery.zh.md)

## Problem

Schedule already delivers a due reminder by queuing a normal Agent follow-up. A second durable Web receipt represented the same occurrence through a Schedule projection, a persistence-success event, Host history and live sidecars, client same-sequence upgrades, a generic event-view slot, and a dedicated renderer. That path spread one feature's confirmation UI across Session, persistence, Host, client runtime, conversation UI, and an extra package.

The receipt also created a second meaning of delivery. It remained visible when the model turn failed, while the conversation itself contained no successful reminder answer. Users need the scheduled conversation to continue; they do not need a separate durable badge proving that an internal dispatch was attempted.

## Decision

A due reminder waits for the Agent's idle maintenance phase and calls `followup()`. The follow-up starts a normal later turn and appears through the ordinary conversation transcript; Schedule never calls `steer()` and never interrupts the current turn.

`schedule/change` remains the only durable Schedule state. Its dispatch operation records that the follow-up was synchronously queued, which prevents ordinary restart replay after the dispatch is durable. Dispatch does not claim model success, user acknowledgement, or an external notification. The narrow crash interval between enqueue and durable dispatch remains at-least-once.

Schedule exposes no delivery-receipt projection, Host sidecar, browser event node, keyed event slot, or receipt renderer. Session persistence retains its shared `flush()` contract and has no Schedule-driven success event. A separate Session projection may publish the complete currently active record set, and `dsh-client-ui-schedule` may render that set read-only; neither contains dispatch success, acknowledgement, or transcript history. The opt-in Web overlay loads the Host Schedule services and enables the Web bundle's default-disabled catalog row.

## Alternatives considered

**Keep the commit-aware receipt.** It could prove that a dispatch reached persistence even when the model failed, but that is an implementation outcome rather than the user's reminder. Its cross-component protocol and late same-sequence merge logic are disproportionate to that value.

**Render raw `schedule/change` events in the conversation.** This avoids a domain card but still exposes internal state transitions as user-facing messages and requires generic non-surface event presentation machinery solely for Schedule.

**Treat dispatch as successful reminder delivery.** The dispatch precedes the model request and cannot establish that an assistant answer exists or was read. Naming it delivery would overstate the durable fact.

**Steer the current turn when a reminder becomes due.** Steering changes the in-progress request path and lets timing interrupt unrelated work. Waiting for full idle and using `followup()` preserves one reminder per ordinary later turn.

## Verification

Package lifecycle tests pin idle waiting, maintenance ownership, follow-up-before-dispatch ordering, synchronous enqueue failure, model-independent dispatch, and restart replay. The assembled Web scenario snapshots the resulting assistant row and asserts that a persisted Schedule dispatch has no special history view, toast, or receipt. Projection and catalog tests separately prove that only active records appear and disappear on terminal transitions. Source and dependency audits reject the removed receipt symbols, event, sidecar, keyed event slot, and renderer path.

## Consequences

- Schedule delivery is contained in its package plus ordinary composition; Session, persistence, Host carriers, and conversation rendering carry no Schedule-specific receipt behavior. The optional active-state projection and header catalog remain a separate read-only concern.
- Users see the reminder only through the conversation's normal model response. A failed model turn remains a failed turn rather than a contradictory success receipt.
- Consumers that need external or acknowledged delivery require a different product boundary with its own notification and acknowledgement semantics.
