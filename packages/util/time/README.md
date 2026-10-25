---
description: "Strict RFC 3339 instant, local-calendar, and IANA zone parsing, plus a millisecond span type, for maintainers accepting a caller-reported zone, a wall-clock selector, or an elapsed time at a boundary."
kind: "package-library"
---

# dsh-util-time

English | [中文](README.zh.md)

## Summary

Shared time vocabulary for the boundaries that accept a caller's zone, a wall-clock selector, or an elapsed time. `canonicalClientTimeZone` answers the platform-canonical `UTC` or IANA `Area/Location` spelling, so an alias never reaches a durable record. The strict parsers read RFC 3339 instants, local calendar fields, and zone names as discriminated results, and `resolveLocalInstant` applies maintained `Temporal` DST and overlap behavior. `Duration` holds a span in milliseconds and splits it into whole parts. The library owns no failure vocabulary and no model-facing text: each caller maps a reason onto its own domain code.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

It is a **library, not a service or plugin**: no `ctx`, registers nothing, holds no state.

Call it at the boundary that receives the zone or the wall-clock selector, before the value reaches anything durable. `dsh-api-session-controller` and `dsh-subagent` admit a caller-reported zone through `canonicalClientTimeZone`; `dsh-time-context` admits the zone a request turn reports through `canonicalizeTimeZone` and refuses an alias rather than rewriting it; `dsh-schedule` reads every absolute and wall-clock selector through the strict parsers and resolves its local targets through `resolveLocalInstant`; `dsh-session-format-v0-to-v1` validates a stored schedule instant through `fourDigitYearEpoch` while keeping its own released-log error. `dsh-time-context` reads its elapsed reading through `Duration` and keeps the wording of the line it injects. A consumer that owns calendar or interval arithmetic of its own keeps that arithmetic and calls these entries only for the boundary value.


### Entry point

```ts
import { Duration, canonicalClientTimeZone, fourDigitYearEpoch, parseLocalCalendar, resolveLocalInstant } from '@deepseek-ai/dsh-util-time'

const zone = canonicalClientTimeZone('US/Eastern')            // 'America/New_York' or undefined
const stored = fourDigitYearEpoch('2026-03-08T02:30:00.000Z') // { kind: 'accepted', epoch } or a rejection reason
const local = parseLocalCalendar('2026-03-08', '02:30:00')    // { kind: 'accepted', time } or a rejection reason

if (local.kind === 'accepted') {
  resolveLocalInstant(local.time, zone ?? 'UTC') // epoch milliseconds, or undefined inside a DST gap
}

Duration.fromMilliseconds(1_500).decompose() // { days: 0, hours: 0, minutes: 0, seconds: 1, milliseconds: 500 }
```

`canonicalClientTimeZone` answers `undefined` for a name it refuses, and the caller raises its own refusal — `session/invalid-time-zone` for the Session prompt, `subagent/invalid-time-zone` for a subagent continuation. `canonicalizeTimeZone`, the strict parsers, and `fourDigitYearEpoch` instead report why they refused, as a discriminated result whose `rejected` arm carries a stable reason, so each caller chooses its own code and diagnostic. `formatFourDigitYearInstant` and `resolveLocalInstant` take already-validated values and answer a string, or epoch milliseconds, with `undefined` for an unrepresentable epoch or a wall-clock value inside a DST gap. `Duration` is a frozen value type over one millisecond count: it validates that the count is finite and inside the exactly representable range, and splits a non-negative span into whole parts. It publishes only the operations its consumers call; a member for another unit or for span arithmetic lands with the caller that needs it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/instant.ts` holds the parsers and `src/duration.ts` the span; `src/index.ts` re-exports both and adds `canonicalClientTimeZone`, the `string | undefined` form the wire boundaries already consume. The module JSDoc there states each entry's accepted profile and every reason.

The strict parsers match a fixed regular expression before constructing any date, so a malformed spelling, an out-of-range clock field, and a date the calendar does not have answer distinct reasons. Local resolution defers to `@js-temporal/polyfill`: `disambiguation: 'earlier'` picks the first instant of an overlap, and the local-field round trip answers `undefined` for a value inside a forward transition's gap.

| Entry | Accepted input |
|---|---|
| `canonicalClientTimeZone` | `UTC` or an IANA `Area/Location` name; answers `undefined` when refused. |
| `canonicalizeTimeZone` | The same names; answers the canonical spelling or a refusal reason, and carries the platform error when the platform refused a well-formed name. |
| `parseLocalCalendar` | `YYYY-MM-DD` and `HH:mm:ss`, with optional one-to-three fractional digits. |
| `parseOffsetInstant` | RFC 3339 with an explicit `Z` or numeric offset; the offset is part of the input. |
| `fourDigitYearEpoch` | The canonical stored profile: exactly three fractional digits and a `Z`. |
| `formatFourDigitYearInstant` | An integral epoch inside the four-digit-year range; answers `undefined` outside it or when non-integral. |
| `isFourDigitYearInstant` | The same range, as a predicate, so a caller that only needs the bound does not re-derive it. |
| `resolveLocalInstant` | Exact calendar fields of a real date, or an already-built `Temporal.PlainDateTime`, plus an already-canonical zone. |
| `Duration` | One finite millisecond count inside the exactly representable range, and its split into whole days, hours, minutes, seconds, and the remaining fraction. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Schedule Host storage](../../schedule/schedule/README.md) — the consumer that stores committed UTC targets.
- [Session controller](../../api/session-controller/README.md) — the request boundary that canonicalizes a browser zone.
- [Time context](../../context/time-context/README.md) — the request consumer that refuses a non-canonical browser zone.
- [util/ package map](../README.md) — where this library sits among the shared utilities.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the consumers that store a canonical zone or a committed UTC instant on durable records: `dsh-time-context` renders the turn's model-visible zone instruction and timestamp from the zone, and `dsh-schedule` renders its model-visible scheduler text from the committed instant.

#### KV Cache effect

None of its own. The consumer that injects a zone- or schedule-derived line into a request owns that request's cache behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Alias resolution follows the runtime's ICU data** — which name an alias group canonicalizes to is the platform's answer, so two processes on different Node builds can disagree about it.
- **No recurrence arithmetic** — instant validity, local-calendar parsing, zone resolution, canonical formatting, and a millisecond span only; a caller that walks candidate dates or intervals owns that search.
- **`Duration` has no calendar units** — a day is exactly 24 hours and a month has no fixed length, so a caller that needs local calendar days derives them from the zone.
- **`Duration` publishes only what a consumer calls** — `fromMilliseconds` and `decompose()`; a conversion, an arithmetic operation, or a `zero` identity lands with the caller that needs it, so the published contract grows with a caller rather than ahead of one.
- **Seconds-unit spans still multiply** — `dsh-schedule`'s interval and delay fields and the DeepSeek file store's refresh margin are second-valued spans converted with `* 1_000`; none has moved onto this library, and an epoch expressed in seconds is not a span and must not be built into one.
- **The `Temporal` polyfill is a runtime dependency** — a consumer that imports only `canonicalClientTimeZone` still resolves it at module load, because both entries share one module.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
