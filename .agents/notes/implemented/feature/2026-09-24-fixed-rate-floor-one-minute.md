# Agent Note: One-minute fixed-rate floor

Status: implemented

English | [中文](2026-09-24-fixed-rate-floor-one-minute.zh.md)

## Problem

`every_seconds` refused every interval below 300 seconds, and the Web client restated that bound as its own per-unit floors of 1 hour, 5 minutes, or 300 seconds. The same product already offered a `cron` selector whose finest granularity is one minute, so two selectors that both describe a repeating cadence disagreed about the shortest one a person could ask for: a reminder that repeats every minute was expressible as `cron` and rejected as `every_seconds`. The floor also made a shipped default Web surface awkward to try, because the first repeating reminder anyone creates cannot come back in under five minutes.

## Decision

`MIN_EVERY_INTERVAL_SECONDS` in `packages/schedule/schedule/src/domain.ts` is 60. The Host decoder, the create and update validation, the `every_seconds` tool parameter description, and its refusal message all read that constant, so one change moves the bound everywhere the Host states it.

The client keeps its own `MIN_INTERVAL_SECONDS = 60`, which the Run time card uses for the seconds row and to derive the per-unit floors: 1 hour, 1 minute, or 60 seconds. The localized hint and refusal copy states 1 minute and 60 seconds for those rows.

One minute is the shortest cadence that does not need a new protocol decision: it matches the cron selector's granularity, and every accepted value remains a whole-second interval the durable record already stores. A stored record keeps whatever the Host accepted when it was created; a record written under the old bound (300 seconds or more) stays valid and replayable, and no migration runs because the previous bound rejected anything below it.

## Alternatives considered

**Keep the 300-second floor.** The two selectors would keep disagreeing about the shortest repeating cadence, and a person could still reach a one-minute cadence only through `cron`.

**Lower the bound to one second.** Sub-minute intervals multiply durable follow-up messages and timer re-anchoring per reminder without a request behind them; the minute granularity already covers the shortest cadence the product names elsewhere.

## Consequences

- A fixed-rate reminder may now repeat every minute; the smallest accepted value is model-visible in the `every_seconds` description and in the client's hint copy.
- Delivery behavior, batching, catch-up, and the interval arithmetic are unchanged: an accepted interval still anchors to creation or to the accepted save, and each overdue record still contributes only its latest occurrence.
- A deployment cannot raise the floor through configuration; the bound is a protocol constant, so a deployment that needs a longer minimum enforces it in the interface that creates tasks.
