# Host-wide Schedule

English | [中文](schedule.zh.md)

Schedule stores Host tasks independently of Session activation. One management API addresses tasks by id, and one evaluator handles seven authoritative timing kinds: `after`, `at`, `every`, `daily`, `weekly`, `cron`, and `rrule`. Targets reuse an existing Session, create one Session and reuse it, or create a Session for each delivery. The [package README](../../packages/schedule/schedule/README.md) owns composition and reminder framing; [`types.ts`](../../packages/schedule/schedule/src/types.ts) owns the complete value and request types.

<a id="durable-tasks"></a>
## Durable tasks

The plugin README owns the current [v2 task schema, v1 defaults, and persisted JSON example](../../packages/schedule/schedule/README.md#storage-format). The domain retains its name, routing, and whole-unit layout. All seven timing kinds remain authoritative; normalization preserves committed occurrences and does not convert Cron into RRULE.

Malformed storage, invalid rows, mismatched task keys, and unsupported versions reject before tasks activate. Failed opening leaves the medium unchanged. An absent file starts empty. Missing target Sessions remain visible in management; reading a task never activates its Session.

<a id="storage-versioning"></a>
## Storage versioning

The README defines [when tasks upgrade](../../packages/schedule/schedule/README.md#storage-format), SQLite's unchanged physical schema, mutation costs, and a future compatible v3. `compatibleVersions` admits old unit stamps for current decoding; normal edits and delivery persist current rows. Reads leave storage unchanged. The shared [domain version policy](storage.md#domain-versioning) applies to both JSON and SQLite.

<a id="recurrence-rules"></a>
## Recurrence rules

[`dsh-util-time`](../../packages/util/time/README.md) owns reusable `Cron` and `RRule` parsing and bounded occurrence arithmetic. Both parsed values expose their authoritative expression and zone, `next(after)`, and `resolve(scheduledAt, acceptedAt)`. Parsers return an accepted value or a rejection reason; Schedule maps reasons to its own input errors and owns record validation, admission limits, persistence, and dispatch.

Every stored `scheduledAt` is a canonical RFC 3339 UTC instant with millisecond precision and a year from 0001 through 9999. Decoding never recalculates it from current zone data. Latest-only catch-up preserves that committed floor, delivers the latest due occurrence once, and commits the first future occurrence. Exhaustion leaves the task stored as `ended`.

| Kind | Authoritative timing |
|---|---|
| `after` | Positive integer `afterSeconds` and the committed one-shot UTC target. |
| `at` | Committed one-shot UTC target. Input accepts an explicit-offset instant or a local date, time, and explicit zone. |
| `every` | Integer `everySeconds` of at least 60; occurrences stay aligned to their committed interval anchor. |
| `daily` | Local `time` as `HH:mm:ss.SSS` and explicit `timeZone`. |
| `weekly` | Daily fields plus a nonempty, unique, ascending ISO `weekdays` set, Monday 1 through Sunday 7. |
| `cron` | Canonical five-field `expression` and explicit `timeZone`. |
| `rrule` | One normalized `DTSTART` line and one `RRULE` line in `rrule`; `DTSTART` supplies the anchor and zone. |

Local calendar rules skip missing wall times and choose the earlier instant of an overlap. Fixed intervals retain their elapsed-time meaning. A one-shot delay may be shorter than a minute; the per-task delivery floor still applies after its first delivery.

<a id="absolute-time-input"></a>
## Absolute-time input

An `at` selector accepts an RFC 3339 instant with an explicit `Z` or numeric offset, or `{ date, time, time_zone }`. Local dates use `YYYY-MM-DD`; local times use `HH:mm:ss` with optional one-to-three fractional digits. Ambiguous or nonexistent calendar values are validated through the shared time utilities. A new absolute target must be strictly future and representable.

<a id="daily-wall-clock-input"></a>
## Daily and weekly input

Daily input supplies `{ time, time_zone }`; Weekly adds explicit `weekdays`. Creation chooses the first strictly future actual occurrence. Catch-up chooses the latest actual due occurrence and advances to a later matching local date. Equivalent edits retain the stored IANA alias and pinned UTC target, including milliseconds.

<a id="fixed-rate-input-and-catch-up"></a>
## Fixed-rate input and catch-up

Every input supplies `every_seconds`. A new interval starts from acceptance time; a changed interval establishes a new anchor at edit acceptance. An unchanged interval or a name/prompt edit keeps the old anchor. Downtime coalesces missed intervals instead of replaying each occurrence.

<a id="cron-wall-clock-input"></a>
## Cron input

Cron input supplies `{ expression, time_zone }`. Its five numeric fields are minute, hour, day-of-month, month, and day-of-week. Supported atoms are `*`, a value, an inclusive range, a star or range step, and comma-separated lists. Sunday accepts 0 or 7 and canonicalizes to 0. Names, macros, a seconds field, and a value followed by a step are rejected.

Cron keeps Vixie day matching: when both day fields are restricted, day-of-month **or** day-of-week may match; when either field starts with `*`, including a stepped star, both matched sets must match. Canonicalization preserves that distinction. Searches are bounded by one 400-year Gregorian cycle and the four-digit UTC range. A rule with no representable future occurrence is refused when armed.

Cron records are never converted into RRULE. Their saved expression and zone remain authoritative through reads, descriptive edits, retargeting, and restart. The Custom editor accepts a five-field Cron expression and exposes its explicit zone selector.

<a id="rrule-input"></a>
## RRULE input

RRULE accepts a bounded RFC 5545 subset, defined by the shared [`rrule.ts` parser](../../packages/util/time/src/rrule.ts). Input has exactly two nonempty content lines: `DTSTART` followed by `RRULE`. The start is a real `YYYYMMDDTHHMMSS` date-time with UTC `Z` or an explicit IANA `TZID`; floating local time, numeric offsets, date-only values, and extra content lines are rejected. The engine uses `rrule` 2.8.1 and supports `MINUTELY`, `HOURLY`, `DAILY`, `WEEKLY`, `MONTHLY`, and `YEARLY`. A one-shot uses `COUNT=1`.

Only `FREQ`, `INTERVAL`, `COUNT`, `UNTIL`, `WKST`, `BYSECOND`, `BYMINUTE`, `BYHOUR`, `BYDAY`, `BYMONTHDAY`, `BYYEARDAY`, `BYWEEKNO`, `BYMONTH`, and `BYSETPOS` are accepted; names and list values must be unique. `INTERVAL` is a positive safe integer. `WKST` is a weekday from `MO` through `SU` and defaults to `MO`. Numeric lists must fit the parser's ranges. Minute/hour rules accept no `BY` parts. `BYMONTHDAY` and ordinal `BYDAY` require Monthly or Yearly; `BYYEARDAY` and `BYWEEKNO` require Yearly. Ordinal `BYDAY` cannot combine with `BYWEEKNO`, and `BYSETPOS` requires another `BY` part.

Validation precedes enumeration. `SECONDLY`, multiple `BYSECOND` values, and more than 10,080 possible candidates per frequency period are rejected. `COUNT` is 1 through 1,000 and cannot coexist with `UNTIL`; `UNTIL` is an absolute UTC date-time ending in `Z`. Starts and limits use years 0100 through 9999. At most 31 set positions are accepted, each from −366 through −1 or 1 through 366 and within its bounded period. The stricter new-rule authoring profile also rejects `BYSETPOS` when a period has at most one candidate; decoding and resuming an unchanged supported rule use its normal evaluator.

A nonexistent local `DTSTART` is rejected. Later missing local occurrences are skipped without consuming `COUNT`; overlaps choose the earlier instant. `COUNT` counts each actual occurrence once, including when positive and negative set positions select the same occurrence.

Custom RRULE text retains its `DTSTART` zone. The model-facing tools continue to teach and accept RRULE; the shared management API accepts each timing kind explicitly.

<a id="delivery-targets"></a>
## Delivery targets

| Target | Delivery behavior |
|---|---|
| `session` | Deliver to one existing Session. Arming checks inside the management FIFO that it exists, is not archived, and is not a delegated child. Delivery rechecks archived destinations. |
| `new_once` | Reserve a Session id before first delivery, create that exact Session when needed, then store `session` and reuse it. Retries and restart keep the reservation. |
| `new` | Create a Session per delivery. Persist `pendingDelivery.targetSessionId` before creation so a failed attempt retries the same Session. |

An omitted creation target defaults to `new_once`. Adding or replacing a `new` or `new_once` target requires the embedding's Session creation provider. SDK compositions without it reject those requests with `invalid_rule` before saving; existing `session` targets remain available. Creation values `cwd` and `agentPreset` are optional and use Host defaults. A created Session joins the Workspace registered at its directory, if any, and takes the task title while untitled; `new` adds its creation minute in the rule's zone. Join or rename failures are logged without blocking delivery.

<a id="task-management"></a>
## Task management

All callers use the same `ScheduleCreateRequest`, `ScheduleCatalogEntry`, `ScheduleTiming`, and `ScheduleEditRequest`. Browser-safe types come from `@deepseek-ai/dsh-schedule/client`. There is no Session-bound management surface or second family of type aliases.

| Operation | Behavior |
|---|---|
| `create(request, actorSessionId?, signal?)` | Allocate the id and store title, prompt, typed `timing`, and optional target. |
| `list(request?)` | Read a page; default 100, maximum 500, optional `active` filter and nonnegative `offset`. |
| `catalog()` / `view({ id })` | Read all tasks without a page limit, or one task. |
| `history({ id, limit, before? })` | Read saved deliveries without Session activation; limit is 1 through 100. |
| `edit(request, actorSessionId?, signal?)` | Apply an `update` patch or `delete` atomically by id. |
| `deleteInactive()` | Remove only `ended` tasks in one batch, preserve active and paused tasks, and return `{ deleted }`. An empty set performs no write. |
| `run({ id }, signal?)` | Deliver now through normal admission without changing the scheduled occurrence or lifecycle. |
| `deliveryLimits()` | Read the configured minimum spacing for `new` targets. |

Remote routes expose `create`, `list`, `catalog`, `view`, `history`, `edit`, `deleteInactive`, `run`, and `deliveryLimits`; the transport wrappers delegate to the same management methods. Remote validation failures use `schedule/input-invalid` with the Schedule input code. Native callers receive `ScheduleInputError`.

A successful nonempty `deleteInactive` batch emits `schedule/changed` for readers to refresh; it queues no Agent notices. A rejected batch also emits that event so readers discard stale state. A normal failure preserves all rows; an `unknown-state` failure can have removed rows and quarantines the domain until reopening. The failed call rejects instead of reporting a deletion count.

An update may replace title, prompt, typed timing, target, or activity. Omitted fields keep their values. A changed rule or explicit resume computes a future occurrence at FIFO acceptance; equivalent timing and descriptive edits keep the committed target. A delivered one-shot needs new future timing to resume. Retargeting does not require converting its timing kind.

`expectedUpdatedAt` is an optional optimistic comparison. A string compares with the saved revision; explicit `null` compares with an absent revision. Mismatch returns `schedule_conflict`. An edit of a row without a revision creates one; later revisions advance monotonically even if the clock rolls back. Cancellation is checked before the write begins, and a started durable write is not rolled back.

<a id="timing-edits"></a>
## Timing edits

The `timing` discriminant selects exactly its matching payload, for example `{ kind: "cron", cron: { expression: "0 9 * * 1-5", time_zone: "Asia/Shanghai" } }` or `{ kind: "rrule", rrule: "DTSTART:20990101T090000Z\nRRULE:FREQ=DAILY" }`. Other selectors use `after_seconds`, `at`, `every_seconds`, `daily`, or `weekly`. Invalid combinations are refused before persistence. The UI saves typed Cron/RRULE input through this same API and preserves untouched timing.

<a id="saved-delivery-records"></a>
## Saved delivery records

A receipt records `scheduledAt`, `deliveredAt`, `messageId`, and `targetSessionId`; it acknowledges a durable Session inbox write, not model completion. A saved record may also have its immutable sent `prompt`. Old receipts without a target id use their resolved reusable destination before any retargeting edit, so a later target cannot rewrite their history. A receipt without either an explicit destination or a known reusable target rejects decoding; a new default reservation cannot establish a historical destination.

New tasks start with known empty history. An old row without `deliveryHistory` exposes its latest receipt, if present, and sets `earlierRecordsUnavailable: true`; it does not invent lost history or prompt snapshots. An omitted `earlierRecordsPruned` reads as false. Duplicate message ids or disagreement between the latest saved record and `lastDelivery` reject decoding.

History follows append order despite clock rollback. Acknowledgment appends and prunes in the same task commit, keeping at most 200 records and 30 days by default while retaining the latest receipt. Query pages are newest first and use an exclusive message-id cursor. Hard deletion removes the task and its history without removing already queued Session messages.

<a id="host-delivery"></a>
## Host delivery

One Host timer drives active tasks. Runtime and management writes share one FIFO. Existing and reserved Sessions resolve through `schedule/resolve-agent`, so the embedding owns activation and the injected Web controller is the fallback. Reused-Session tasks hold their execution slot until the target Agent becomes idle; intervening occurrences coalesce. A `new` target permits executions beside one another. Due recurring records targeting the same existing Session share one message; `after` and `at` deliver separately.

Timed and manual deliveries obey a per-task minimum interval of 60 seconds. `newSessionIntervalSeconds` can raise it for `new` targets, up to one week. The floor uses the last occurrence when the saved successor preserves the interval, otherwise the last acknowledgment, so delivery latency does not move the rule's anchor. Reads expose `executionActive` and `deliveryFloorEndsAt` only while applicable.

Session inbox persistence precedes the task receipt write, so a crash between stores can repeat a delivery. The Host must be running. An active task targeting a Session contributes archive-admission activity; an archive stop deletes those active tasks.

After a committed management change, Schedule queues a best-effort notice to each involved loaded Agent except the actor. Notices join the next model step without opening a turn, and their Session I/O does not hold the management/delivery queue. New-per-delivery Sessions are not accumulated in involvement metadata.

<a id="historical-session-changes"></a>
## Historical Session changes

Historical version-1 `schedule/change` events retain the frozen `LegacyScheduleRecord` types: `after`, `at`, and `every`, including old optional titles. They remain recorded Session data without a Schedule interpreter, warning hook, importer, or timer. Existing Host tasks in `schedule.json` still use the normal decoder and evaluator.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxschedule--scheduleservice"></a>

### `ctx.schedule` — `ScheduleService`

Shared management service; reads and management writes never activate a Session, and only delivery creates or resumes one.

`sessionPersistence` supplies header-only target validation and the `session/flush` listener that acknowledges durable inbox delivery through `ctx.sessions.flush()`.

```ts cordis-catalog
/** Read effective delivery limits without loading or activating a task.
 * @returns The configured minimum spacing between deliveries that each create a Session, in seconds.
 */
@Remote('deliveryLimits') deliveryLimits(): { readonly newSessionIntervalSeconds: number }

/**
 * Create one task with a Host-generated identity for a human Remote caller.
 * @param request - Title, prompt, recurrence, and delivery destination.
 * @param signal - Cancellation checked before the durable write begins, including after FIFO waits.
 * @returns The stored task. Cancellation does not roll back an in-flight write.
 */
@Remote('create') async remoteCreate(request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleCatalogEntry>

/**
 * Create one task and record the acting Agent's Session as involved; the Remote form omits that Session.
 *
 * The record is built from the clock reading taken before the request joins the serialized queue. A `session`
 * target must exist and must not belong to a delegated child; a `new_once` target reserves its Session identity.
 * @param request - Title, prompt, recurrence, and delivery destination.
 * @param actorSessionId - Session of the acting Agent, or undefined for a human caller.
 * @param signal - Cancellation checked before the durable write begins, including after FIFO waits.
 * @returns The stored task. Cancellation does not roll back an in-flight write.
 */
async create( request: ScheduleCreateRequest, actorSessionId?: SessionId, signal?: AbortSignal, ): Promise<ScheduleCatalogEntry>

/**
 * Read one page of Host tasks without activating target Sessions.
 * @param request - Optional activity filter, page size, and offset.
 * @returns The requested page and total matching task count.
 */
async list(request: ScheduleListRequest = {}): Promise<ScheduleListResult>

/**
 * Remote form of the shared Host-wide list.
 * @param request - Optional activity filter, page size, and offset.
 * @returns The requested page and total matching task count.
 */
@Remote('list') async remoteList(request: ScheduleListRequest): Promise<ScheduleListResult>

/**
 * Read every Host task without a page bound or Session activation.
 * @returns All tasks, active first, with target and execution metadata.
 */
@Remote('catalog') async catalog(): Promise<ScheduleCatalogEntry[]>

/**
 * Read one task without activating its target Sessions.
 * @param request - Task identity.
 * @returns The task, or a non-mutating miss.
 */
@Remote('view') async view(request: ScheduleViewRequest): Promise<ScheduleViewResult>

/**
 * Read one page of saved deliveries without activating or reading a target Session.
 * @param request - Task identity, explicit page size, and optional exclusive cursor.
 * @returns Newest-first saved deliveries, or a task/cursor lookup failure.
 */
async history(request: ScheduleDeliveryHistoryRequest): Promise<ScheduleDeliveryHistoryResult>

/**
 * Remote form of the target-based {@link ScheduleService.history}; an invalid limit rejects with
 * `schedule/input-invalid`.
 * @param request - Task identity, explicit limit, and optional exclusive message cursor.
 * @returns Newest-first deliveries in append order, or a task/cursor lookup failure.
 */
@Remote('history') async remoteHistory(request: ScheduleDeliveryHistoryRequest): Promise<ScheduleDeliveryHistoryResult>

/**
 * Deliver one task now without consuming or moving its scheduled occurrence; an archived destination Session rejects
 * with `schedule/target-archived`.
 * @param request - Task identity.
 * @param signal - Cancellation checked after entering the delivery transaction and before delivery.
 * @returns Task state after Session persistence acknowledged the delivery, `schedule_execution_pending` while
 * another execution of the task is queued, running, or inside its delivery floor, or a non-mutating miss.
 */
@Remote('run') async run(request: ScheduleRunRequest, signal?: AbortSignal): Promise<ScheduleRunResult>

/**
 * Delete every ended Host task, leaving active tasks armed.
 *
 * Ended tasks never schedule another delivery, so the removal changes no pending
 * target and no timer is recomputed. Rows are enumerated and removed in one FIFO
 * slot, so a delivery ordered behind this call ends its task after the
 * enumeration rather than during it. The batch is one domain write: a normal
 * failure rejects with every listed row still stored, while a backend
 * `unknown-state` failure may have removed rows and quarantines the Host
 * domain, so later schedule operations reject until the domain is reopened.
 * A successful nonempty batch emits `schedule/changed` without Agent notices.
 * A rejected batch announces `schedule/changed` because it does not establish
 * which rows landed, and clients then re-read the catalog.
 * @returns Count of removed rows; zero when the Host held no ended task.
 */
@Remote('deleteInactive') async deleteInactive(): Promise<ScheduleDeleteInactiveResult>

/**
 * Update or delete one task for a human Remote caller; an invalid patch rejects with `schedule/input-invalid`.
 * @param request - Task identity and one update or delete operation.
 * @param signal - Cancellation checked before the durable write begins, including after FIFO waits.
 * @returns The updated task, the deletion outcome, or a non-mutating miss or conflict.
 */
@Remote('edit') async remoteEdit(request: ScheduleEditRequest, signal?: AbortSignal): Promise<ScheduleEditResult>

/**
 * Update or delete one task and record the acting Agent's Session as involved; the Remote form omits that Session.
 *
 * An update applies every patch field in one write and recomputes the next occurrence when the rule changes or
 * the task resumes. A supplied `expectedUpdatedAt` that differs from the stored value returns `schedule_conflict`.
 * @param request - Task identity and one update or delete operation.
 * @param actorSessionId - Session of the acting Agent, or undefined for a human caller.
 * @param signal - Cancellation checked before the durable write begins, including after FIFO waits.
 * @returns The updated task, the deletion outcome, or a non-mutating miss or conflict.
 */
async edit( request: ScheduleEditRequest, actorSessionId?: SessionId, signal?: AbortSignal, ): Promise<ScheduleEditResult>
```

Types: [SessionId](core.md)

Source: [`packages/schedule/schedule/src/index.ts`](../../packages/schedule/schedule/src/index.ts)

<a id="schedule-events"></a>

### `schedule/*` events

<a id="schedulechanged--emit"></a>

#### `schedule/changed` — emit

Durable task set changed; clients refetch global task and Session-active catalogs.

```ts cordis-catalog
/** Durable task set changed; clients refetch global task and Session-active catalogs.
 * @mode emit
 */
'schedule/changed'(): void
```

Source: [`packages/schedule/schedule/src/types.ts`](../../packages/schedule/schedule/src/types.ts)

<a id="scheduleresolve-agent--waterfall"></a>

#### `schedule/resolve-agent` — waterfall

Restore a reminder's Session through its embedding's owning controller. Call next() to use the Web Session controller.

```ts cordis-catalog
/**
 * Restore a reminder's Session through its embedding's owning controller.
 * Call next() to use the Web Session controller.
 * @param sessionId - Original Session receiving the reminder.
 * @mode waterfall
 */
'schedule/resolve-agent'(sessionId: SessionId, next: () => Promise<Agent>): Promise<Agent>
```

Types: [Agent](core.md) · [SessionId](core.md)

Source: [`packages/schedule/schedule/src/index.ts`](../../packages/schedule/schedule/src/index.ts)
<!-- END GENERATED cordis-surface -->
