# Agent Note: Session developer transition rules

Status: proposed

English | [中文](2026-09-10-session-developer-transition.zh.md)

## Problem

The refactor spans several stages. The old system must remain usable, but new plugins are discouraged from continuing to depend on concrete `Session`, JSONL handles, or lifecycle events. Developers need rules that match the target branch state.

## Proposal

Fix one mental model: **obtain `LogicalSession` through `SessionService`, use its members for the logical session, and let only providers and composition know the physical implementation.**

| Stage | Development rule |
|---|---|
| Current master | Use the existing public API and do not present the unmerged stack as released. |
| After Stage 1 | Use `LogicalSession` for new parameters, fields, callbacks, and test doubles. Existing external code may keep deprecated `Session` imports and constructors temporarily. |
| After Stage 2 | `ctx.sessions` owns the live registry and storage attachment; Agent loop and plugins do not retain persistence handles. |
| After Stage 3 | New storage implements `SessionStorageReader` / `Writer`; ordinary features still do not use storage as the session API. |
| After Stages 4–5 | The logical session owns live writing and projection; repository code stops using compatibility aliases. |
| Long term | Composition selects session/service/storage/query providers; feature packages do not change with providers. |

### Maintenance rules

- Use `SessionService` to create, restore, fork, list, or find live sessions. Do not maintain a second registry.
- After obtaining a `LogicalSession`, use public members such as `header`, `id`, `seq`, `surface`, `append()`, `eventAt()`, and `snapshotEvents()`. Do not infer an event-array or in-memory Map.
- Persistence providers own formats, migrations, leases, revisions, and physical I/O. Search, statistics, titles, frontend, and telemetry use logical protocols or their own Service Definitions.
- New providers pass shared contract tests and register explicitly at composition. Core code does not branch on provider names or scan packages.
- New code does not use `SessionPersistence`, `ctx.sessionPersistence`, or old handle/access/snapshot/revision names. Stage 5 removes them after old consumers reach zero.
- Docs and tests label current, completed-stage, target, or compatibility behavior. They do not present draft PRs as released.

An ordinary plugin declares its Cordis dependency on `ctx.sessions`, accepts and passes `LogicalSession`, and uses its public members. Existing plugins may keep `Session`, `Session.create`, and `Session.fromRestore` while migrating, but new code uses the logical session type and detached factories. Only plugins implementing a backend touch storage/query protocols. They do not need to know which memory, persistence, or query-index implementation is selected.

### Common operation migrations

These are target pseudocode. The declarations on the current stage decide which members are available.

```ts ignore-check
// Types: Session -> LogicalSession
function render(session: LogicalSession) {}

// Create/open: new Session(...) or storage.open(...) -> SessionService
const created = await ctx.sessions.create(options)
const opened = await ctx.sessions.open(id, options)

// Live lookup/list: private Map or file scan -> SessionService
const one = ctx.sessions.get(id)
const live = ctx.sessions.list()

// Identity/header: concrete fields or storage metadata -> logical session
const id = session.id
const header = session.header

// Events: session.events[index] or handle.read(...) -> logical session
const event = session.eventAt(seq)
const events = session.snapshotEvents(from, to)

// Model-visible history: local event folding -> canonical surface
const surface = session.surface

// Write: push(events) or direct JSONL write -> logical session
session.append(type, data, surfaceIntent)

// Projection: concrete lifecycle subscription -> projection port
ctx.sessions.registerProjectionPort(projectionPort)

// Titles, statistics, filters, full-text retrieval, and cold reads -> SessionQuery
const page = await ctx.sessionQuery.query(request)

// Fork: copy arrays or files -> SessionService
const child = await ctx.sessions.fork(session, boundary, childId)

// Durability: flush a handle directly -> SessionService
const durable = await ctx.sessions.flush(session)
```

### How a new contributor starts

1. Read the [overview](2026-09-06-logical-session-storage-rebuild.md) first. Understand the single objective: completely decouple logical Session from every physical implementation.
2. Read [capability protocols](2026-09-10-session-capability-protocols.md) and current `docs/subsystems/session.md`. The first is the target; the second is current fact on the branch.
3. Read progress in stage order: 1.1→1.2→1.3→1.4→1.5→2→3. Do not edit an earlier stage after reading only the final stage diff.
4. Start with one migration that has an explicit caller: change its type and entry point, add contract coverage, and prove no new old-path use. Lifecycle, format, or failure-order changes remain separate stages.
5. Before handoff, run target tests, typecheck, docs checks, and dependency checks. Record current, target, gap, next removal condition, and exact branch/commit.

## Alternatives considered

**Wait for every stage to merge before migrating plugins.** Rejected because new concrete dependencies would enlarge the final cleanup.

**Keep old names permanently.** Rejected because dual entry points would permanently split docs and types. The temporary entries have compatibility tests and require a separate removal decision after external migration evidence exists.

## Acceptance criteria

- New code above Stage 1 treats `LogicalSession` as the recommended session object and obtains it from `SessionService`; deprecated `Session` entries remain compatible for existing external code.
- Ordinary plugins do not import concrete providers; a dependency gate checks the rule.
- Compatibility entries before Stage 5 have coverage, a named old consumer, and a removal condition.
- A new contributor can locate one safe migration task from the overview, protocols, current subsystem docs, and stage order.

## Risks

Different stack layers expose different APIs. Developers must target their branch and must not backport Stage 3 APIs into a lower stage. `LogicalSession` must also not absorb search, statistics, or I/O without natural ownership and become a new large object.
