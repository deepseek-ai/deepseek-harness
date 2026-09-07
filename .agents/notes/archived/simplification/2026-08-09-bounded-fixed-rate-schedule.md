# Agent Note: Bounded fixed-rate Schedule

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-09-bounded-fixed-rate-schedule.zh.md)

## Problem

Users need simple repeating reminders, but the initial recurrence layer of [durable Session-local reminders](../feature/2026-08-05-durable-web-schedule.md) treated fixed intervals and calendar expressions as one general subsystem. It added a Cron language and evaluator, time-zone-sensitive occurrence search, tzdata replay rules, a cross-record 300-second admission gate, persisted gate evidence, deferred-delivery fields, and gate-exhaustion states. Those mechanisms enlarged the durable protocol and live owner even when the requested behavior was only “repeat every N seconds.”

A cold or busy Session also cannot usefully replay every missed interval. Doing so would create a model-turn backlog whose size depends on downtime, while shifting the next target to delivery time would make the fixed rate drift.

## Decision

The retained recurring selector is only `every_seconds`, a safe integer of at least 300. Creation stores the first target at creation time plus the interval. Each dispatch stores the record id and one wall-clock `acceptedAt`; pure integer arithmetic selects the latest creation-anchor-aligned occurrence at or before that decision and advances directly to the first aligned target after it. No missed occurrences are enumerated, persisted, or replayed.

When no one-shot is due, every distinct overdue Every record participates in one follow-up batch in target and creation order. Each contributes exactly one latest occurrence, and every dispatch in that batch uses the same decision time. Due one-shots retain priority so an already-promised single reminder is not hidden inside a recurrence batch.

The five-minute minimum is a property of each Every rule rather than a global gate. There is no `lastRecurringAcceptedAt`, `deliveryNotBefore`, cooldown, quota, gate-exhaustion state, or generic recurring-record abstraction. If arithmetic cannot represent the next four-digit-year UTC target, the final dispatch terminates that record.

Calendar and Cron expressions, their evaluator dependency, parser, canonicalizer, zone search, frequency proof, durable record and dispatch variants, tests, snapshots, and third-party notice entry are removed. Old pre-release Cron records are rejected by the strict version-1 decoder rather than migrated or accepted through compatibility residue.

## Alternatives considered

**Retain the global recurring gate.** A shared gate bounds total model turns but makes unrelated reminders delay one another and requires durable cross-record history. Batching already turns every currently overdue fixed-rate record into one model request, while the per-rule minimum bounds wake frequency.

**Replay every missed occurrence.** This preserves each nominal event but creates unbounded backlog after downtime and is poor reminder behavior. Latest-only catch-up communicates current due work without pretending the Session was live.

**Advance from dispatch time.** This is simpler arithmetic but changes a fixed rate into a drifting delay loop. Retaining the next anchor-aligned target preserves the user's interval.

**Keep Cron as an optional branch.** Even isolated behind a selector, Cron retains a calendar grammar, dependency, time-zone and daylight-saving policy, replay validation, and large test surface. Fixed intervals deliver the useful recurring case without spreading that complexity.

**Dispatch only one Every record per turn.** This serializes unrelated overdue work and lets a large set monopolize later turns. One batch preserves distinct reminders while bounding model requests.

## Verification

Strict decoder and invariant tests reject unsupported rule and dispatch shapes. Domain and property tests prove minimum-frequency validation, creation-anchor arithmetic, latest-only selection, advancement, and range exhaustion. Runtime tests prove one-shot priority, one shared batch for all overdue Every records, one occurrence per record, fixed ordering, and no immediate backlog loop. The assembled Web snapshot proves a two-record overdue batch becomes one ordinary assistant response with two same-time durable transitions and no Schedule UI sidecar. Source, dependency, and generated-catalog audits reject Cron and global-gate residue.

## Consequences

- The durable rule union is After, At, and Every; the tool selector union is `after_seconds`, `at`, and `every_seconds`.
- Reopening a long-cold Session produces current reminder work, not a historical turn storm.
- Multiple overdue Every records share one model request without sharing schedule state or delaying one another.
- Calendar-based recurrence requires a future product boundary rather than dormant compatibility code.
