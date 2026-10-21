# Agent Note: Serve Session-list rows from a summary key set

Status: implemented

English | [中文](2026-10-18-session-list-summary-projections.zh.md)

## Problem

A Session-list row carries every registered client view. Four of those views are never rendered by a row: the whole-log turn outline, the whole-log conversation figures, the current todo list, and the host-wide image limits. The outline grows with the Session's log, so a list payload scales with corpus size and log length even though no row shows it. Omitting values from the list needs a rule that keeps the wire and client types honest: a summary consumer must not obtain an omitted key, a value that is omitted must still reach an opened Session, and the owning packages must not drift from whatever declaration drives the omission.

## Decision

The Session summary is every registered client view except the keys whose `SessionProjectionMap` entry carries the summary-exclusion mark.

- [`packages/session/session-projection/src/types.ts`](../../../../packages/session/session-projection/src/types.ts) declares the type-only mark `SessionProjectionSummaryExcluded<T>` over a unique symbol that is never exported and never present at runtime. `SessionProjectionViewValue<T>` strips it distributively, so a nullable entry keeps its `null`; `SessionProjectionSummaryExcludedKey` tests the non-nullish part; `SessionProjectionSummaryValues` is every view value minus those keys.
- Each owning package wraps only its own map entry: `turnOutline` (session-turn-outline), `sessionStats` (session-stats), `todos` (tool-todo), and `imageLimits` (session-controller's boot-constant attachment limits, which every Session shares). The todo entry is `SessionProjectionSummaryExcluded<TodoItem[]> | null`, because an intersection with `null` would absorb the null member.
- Registration carries the same decision as a plain boolean: `wire.summary` says whether a Session summary includes the unit, and omitting it means `true`. A key whose map entry carries the mark declares `false` so the runtime key set and the client view type agree. The mark itself has no runtime representation — `wire.view` and `viewSchema` are typed with `SessionProjectionViewValue`, which strips it, so the erase in `register` only widens the state type.
- [`packages/session/session-projection/src/index.ts`](../../../../packages/session/session-projection/src/index.ts) exposes `summaryKeys(): ReadonlySet<key>`, derived from the live registrations and rebuilt only when a new key registers or a key's last registrant disposes. `cachedSnapshot`, `viewCheckpoint`, and `snapshot` accept `ProjectionKeySelection` (`readonly Key[] | ReadonlySet<Key>`) and use a passed set as-is.
- [`packages/session/session-projection-cache/src/index.ts`](../../../../packages/session/session-projection-cache/src/index.ts) forwards that selection unchanged, and [`packages/api/session-controller/src/list.ts`](../../../../packages/api/session-controller/src/list.ts) passes `summaryKeys()` to the live and cold cached faces. `cachedPredecessorTitle` keeps its title-only read.
- Client types only: `SessionSummary.projectionValues` narrows to `Partial<SessionProjectionSummaryValues>`, while `SessionProjectionSnapshot.values` keeps every view value. No wire field, function, or UI name changes, and an opened Session still receives every key through `session/follow`, the control baseline, and `session.projections`.

Estimated effect: with logs whose outlines dominate the projection payload, the four keys are estimated at roughly two thirds of a Session-list response for a few hundred Sessions — the outline alone near 57%, the figures and todo list near 5% together, and the shared image limits near 5% — and at roughly 85% of the same response after transport compression, where the outline's unique text barely compresses while the remaining keys do.

## Alternatives considered

**A summary-specific read face per source** (`viewSummaryRecord` for checkpoint rows and `cachedSummarySnapshot` for live cells). Rejected: the summary key set would then be defined and carried by two read faces plus their call sites, and a caller could still pass explicit keys to the complete faces. The derived set plus the existing key-taking faces keeps one definition, one code path, and no per-read key copy.

**A hardcoded excluded-key list in the session controller.** Rejected: the list would drift from the owning packages, and nothing would fail when a package renamed a key or added a large value.

**Filtering keys after the complete block is built.** Rejected: the per-row state parse and view work would still happen, and the wire type would keep claiming the excluded keys are present.

**Making every projection opt in to summaries.** Rejected: it inverts today's default, requires touching every owning package, and silently drops a new large key from summaries whenever a package forgets to opt in.

**A lazy per-value read for large projections.** Rejected: rows do not need the values at all, and deferring one value per row adds a request shape and loading states the list never had.

## Consequences

Bought: a list response no longer scales with outline length or log count, a summary consumer cannot obtain an excluded key through the derived set (the complete faces still serve an explicitly named key), and reading an excluded key from a list row's type is a type error. `wire.summary` is a plain boolean, so keeping a marked key at `false` is the registering package's responsibility rather than a compile error.

A list row carries the summary projection, never the full projection: it promises the summary key set and nothing more. A connected Session's client store may hold more values from its control/follow baseline, but those are outside the list contract and must not be read from a row; the opened Session's own baselines keep every value.

No upgrade guide records this change. The externally perceptible part is the wire: `session/list` rows no longer carry the four keys, and a client type that reads `projectionValues.turnOutline` no longer compiles. A consumer migrating reads the opened Session instead — its `session/follow` opening snapshot, the `session/control` baseline, or a `session.projections` read — which keep every projected value; the package README and the subsystem page state the rule.

Paid: `ProjectionKeySelection` is a new public signature type and `ReadonlySet` joins the catalog's foundation types; `summaryKeys()` has two invalidation points (a new key, the last disposer) that a future registration path must not miss; the summary key set, like the unit table, is process-wide, so a key excluded by one preset is excluded for every Session; and a nullable value cannot be marked directly — its `null` must stay outside the wrapper.

## Testing

- [`packages/api/session-controller/tests/summary-list.host.spec.ts`](../../../../packages/api/session-controller/tests/summary-list.host.spec.ts): a list row's keys equal the registry's complete snapshot minus the marked keys, a `session/follow` opening snapshot still carries them with equal values, and two consecutive pulls do not re-add them.
- [`packages/session/session-projection/tests/summary.spec.ts`](../../../../packages/session/session-projection/tests/summary.spec.ts): the derived set, its stable identity, its rebuild after registration and disposal, summary-shaped reads through the key-taking faces, an empty summary set, and the nullable mark.
- [`packages/session/session-projection-cache/tests/cache.spec.ts`](../../../../packages/session/session-projection-cache/tests/cache.spec.ts): a summary read from stored rows omits the marked key and takes its watermark from the served rows only.
- [`packages/api/session-controller/tests/summary-types.client.spec.ts`](../../../../packages/api/session-controller/tests/summary-types.client.spec.ts): `@ts-expect-error` reads of `turnOutline`, `sessionStats`, and `todos` on `SessionSummary.projectionValues`, with the full snapshot still exposing them and `todos` still nullable.
- [`packages/api/session-controller/tests/manager.client.spec.ts`](../../../../packages/api/session-controller/tests/manager.client.spec.ts): a reconnect refresh replaces the row block, so a stale excluded key does not survive.
