# Agent Note: Team messages use the target inbox

Status: implemented

English | [中文](2026-09-26-team-direct-inbox.zh.md)

## Problem

A second Team outbox duplicates Agent inbox ownership with separate identities, acknowledgements, persistence checkpoints, and retry ordering. Callers need an explicit admission result while the continuation owner already provides target locking, lifecycle authorization, and cold recovery.

## Decision

New Team sends return the accepted inbox `MessageId` or throw. They use live Lead Steer or the host-only subagent Steer adapter, retaining the actual sender through the existing `agent-message` source and the member name in content. Acceptance follows ordinary Agent persistence; it neither confirms model processing nor adds a synchronous flush guarantee. Team does not retain unaccepted intent, retry it after restart, or deduplicate explicit resends.

Historical mailbox records stay decodable and projected so existing Lead logs replay, but Team never delivers or acknowledges them. The package is experimental with no stability promise, and a second dispatch path with receipt inspection, per-target ordering, and its own disposal wait costs more than the undelivered old messages it would recover. This partially supersedes the mailbox decision in [Agent Teams](../feature/2026-08-05-agent-teams.md); roster and task decisions remain there. The [package reference](../../../../packages/experimental/agent-team/README.md#understand-the-implementation) owns the resulting limitation.

## Alternatives considered

**Keep the Team outbox for all sends.** This preserves a stronger retry promise but duplicates coordination and requires maintaining two acceptance states. Reintroduce it only for a concrete durable send-intent requirement that the Agent inbox cannot serve.

**Expand public sibling messaging permissions.** Team membership is separate from subagent parent authority. The host adapter authorizes the exact Lead without misattributing the sender or broadening public child controls.

**Drain historical pending items after restart.** This honors old accepted intent, but it keeps a second delivery owner beside the Agent inbox for data that only an experimental opt-in composition wrote. Removing the decoder as well is also rejected, because Lead logs containing mailbox records would then fail to replay.

## Consequences

New attempts have one identity and one inbox owner. A failed attempt is visible to its caller and has no Team retry promise. Historical logs still cost decoder and projection code. A historical message that its target had not recorded before the upgrade is never delivered. Tests cover direct Lead/peer acceptance, cold recovery, sender attribution, failures, cancellation, disposal, and that historical queued mail stays readable and undelivered after restart.
