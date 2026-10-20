---
description: "The session-projection registry for developers serving whole current values of log-derived per-session state to client carriers, and for maintainers of the drive contract."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-projection

English | [中文](README.zh.md)

## Summary

Use `dsh-session-projection` when clients need current per-session state—such as todos, goals, or conversation statistics—without replaying the raw event log. Domains define synchronous projections from committed session events, and clients receive complete, schema-validated JSON values through snapshots and change notifications. Snapshots identify the last event reflected by every returned value, so carriers can pair state with the matching history cut. Projection state can be checkpointed for faster cold reads, while host-only projections remain private to the host.

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

Mount `dsh-session-projection` wherever client carriers need current values of log-derived session state. Domain plugins register units; carriers read snapshots and subscribe to the change feed; neither knows the other.

### When to choose it

Choose it when a domain keeps state that clients should see without re-deriving it — a todo list, a goal snapshot, conversation statistics. The registry drives units eagerly over committed events, so any registered unit's value is current by construction. A unit without a `wire` block keeps its state host-only. Domain owners declare `sessionProjections` in their plugin dependencies and await registration before exposing synchronous service methods. Other plugins read those methods through the owning service.

### Define a projection unit

A domain contributes one `ProjectionDefinition` per state key: a key, a state schema, an initial state, a synchronous fold `apply(state, event)`, an optional `wire` block that projects state to a client view, and a `stateVersion` that bumps whenever the state fields or fold semantics change:

```text
const definition = {
  key: 'todo',
  stateSchema: todoStateSchema,
  stateVersion: 1,
  init: (_header, _inheritedEventCount) => ({ items: [] }),
  apply: (state, event) => event.type === 'todo/upsert'
    ? { items: event.data.items }
    : state,
  wire: {
    viewSchema: todoViewSchema,
    view: state => ({ items: state.items }),
  },
}
```

`init(header, inheritedEventCount)` receives both lightweight metadata and the exact fork-inherited cut; it must not infer that cut from `firstLiveSeq` or `session/end-seed`. `apply` must be synchronous and must return the same state reference for events that do not concern the unit — an unchanged reference means zero downstream work. The registry compares consecutive raw `wire.view` results with `Object.is`; an object or array view must reuse its reference to suppress publication across internal-only state changes, while a structurally equal new object is still a change. A state-carrying log event must carry the complete post-change state, never a bare delta.

### Register and read

`await register(definition)` infers the host state type from `stateSchema`, installs the unit, and returns a handle with synchronous `stateOf(session)` reads and `dispose(): Promise<void>`. Await `dispose()` to release the registration; repeated calls are safe. Registrants with the same key and `stateVersion` share cells; incompatible or invalid versions reject registration. Registration belongs to the calling fiber. The last unregister removes the unit from global event drives, snapshots, checkpoints, and change notifications. Existing handles remain readable: each retains its original unit and folds new Session events on demand, even if another version later registers the same key. Reading a handle does not initialize unrelated units or register it again. Carriers use `snapshot(session)` for a consistent client-view cut and `onChanged(listener)` for changes to registered units.

```text
const todoProjectionHandle = await ctx.sessionProjections.register(definition)
const state = todoProjectionHandle.stateOf(session)
const { asOfSeq, values } = ctx.sessionProjections.snapshot(session)
```

A domain that owns projected state declares `sessionProjections` as a Cordis service dependency and keeps its handle private. Consumers inject that domain service and use its methods, such as `ctx.agents.turnBoundaryOf(session)`, without importing definitions or retaining projection readers. Optional contributors may register under `ctx.inject(['sessionProjections'], …)`. Carriers use `ctx.get('sessionProjections')` and omit their block or frames when the registry is absent.

<a id="deprecated-plugin-compatibility"></a>
### Deprecated plugin compatibility

`register(definition)` keeps its public return type `Promise<ProjectionHandle<S>>`, but the runtime value is a callable thenable, not a native `Promise` (`typeof` is `"function"`; `instanceof Promise` is false). Awaiting it delivers the retained handle; calling it releases the registration through the original Cordis effect disposer. Calling the return value is deprecated; use `handle.dispose()` in new code. Use `Promise.resolve(registration)` when an API requires a native Promise or treats functions as callbacks, including Vitest Promise assertions. See the [upgrade guide](../../../docs/upgrade-guide/v0.2.1-rc.2/session-projection-handles/guide.md).

Legacy synchronous `return register(...)`, `ctx.effect(() => register(...))`, and synchronous generator yields retain cleanup ownership. Returning the registration from an async function assimilates the thenable into a handle, which Cordis rejects as `Invalid effect`. Yielding it from an async generator also yields the handle: that effect fails with `Invalid effect` when disposed and never adopts the registration, while the plugin stays active and its fiber releases the registration on unload. Async plugins and effects await registration and return `void`; the owning fiber releases the registration automatically.

Legacy `stateOf(session, key)` is deprecated and returns `unknown`. Reading a registered key materializes every registered unit at the Session cursor without producing unrelated wire views. An unregistered or fully released key returns `undefined`, while retained handles remain readable. Compatibility covers runtime calls; TypeScript consumers migrate their type declarations.

The first legacy `stateOf(session, key)` read of each key logs one `ctx.logger.warn` deprecation warning per registry instance. Registration, calls to its result, handle methods, and owner cleanup do not warn.

Definitions install synchronously, and handle delivery remains asynchronous. Registration errors reject the returned value. When no caller observes a rejection before the current macrotask and its microtasks finish, the registry logs it as an error instead of leaving an unhandled rejection, and the plugin stays active; after a key conflict, its keyed reads return the other registrant's state; a rejection whose owner is no longer loading or active is dropped. New plugins await registration before exposing readers. Synchronous `try/catch` cannot catch asynchronous registration errors.

### Persisted checkpoints

Every unit's state is checkpointed — client-visible and host-only alike — through `checkpoint(session)`, and the sibling [session-projection-cache](../session-projection-cache/README.md) persists those checkpoints so cold reads skip full log loads. Checkpoint watermarks use `SessionSeqCursor` (`-1` for an empty log), while replay starts use `SessionLogOffset`; `restoreFloor` and `restore` implement the read recipe without conflating an existing event with a log gap.

### Session summaries

A Session summary is every registered client view except the keys whose non-nullish `SessionProjectionMap` entry carries the `SessionProjectionSummaryExcluded<T>` mark. `summaryKeys()` returns that set, derived from the live registrations and stable — the same instance — until a registration or its disposal changes the key table. A summary consumer passes it to the existing key-taking reads — `cachedSnapshot(session, keys)` for live cells, `viewCheckpoint(rows, keys)` for checkpoint rows, and `cachedSnapshot(header, keys)` through the persisted cache — which treat a set as already selected, so there is no summary-specific read face, no copy per read, and no second definition of the set. Because the registry derives it, a summary consumer cannot request an excluded key through the derived set; a complete face still serves an explicitly named key, which is how an opened Session keeps every value. A list row carries the summary projection and never the full projection.

The mark decides the client view type; `wire.summary` decides the runtime key set, and omitting it means `true`. Declare `wire.summary: false` on a key whose map entry carries the mark so the two agree; the field is a plain boolean, not a type-level interlock. A nullable entry keeps `null` outside the wrapper (`SessionProjectionSummaryExcluded<TodoItem[]> | null`) so the pre-first-write value stays expressible. The keys currently marked are `turnOutline`, `sessionStats`, `todos`, and `imageLimits`: an outline grows with the whole log, no list row renders the stats or todo list, and the image limits are one host-wide boot constant every Session shares.

Summaries serve the Session list rows, which list Sessions without opening them. The `@` reference lists Sessions the same way but reads only its `title` and `subagent` label keys through the key-taking `snapshot(session, keys)` and `cachedSnapshot(header, keys)` faces. `snapshot`, `cachedSnapshot`, and `viewCheckpoint` still serve every wire key when called without a key subset, so an opened Session receives every projected value.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the drive machinery and the unit contract; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The package is the Service Definition and drive role of a capability seam: the framework drives, the domain computes. The registry subscribes to `session/event` once; every committed event passes every registered unit's `apply` eagerly (cells build lazily on first touch). The first `Object.is` gate skips view work when the state reference is unchanged; a two-slot live-drive cache reuses the previous raw view and a second `Object.is` gate suppresses publication while the raw view reference is unchanged. Carriers read `snapshot()` in the same tick as their page slice, which is what makes `asOfSeq` one consistent cut; an accidentally async view returns a Promise and fails `wire.viewSchema.parse`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `SessionProjectionRegistry` service, `ProjectionDefinition`, snapshot and checkpoint machinery |
| [`src/types.ts`](src/types.ts) | The merge-extensible client `SessionProjectionMap` type table, plus the summary-exclusion mark and its derived view and summary types |

### Drive and checkpoint flow

One committed event drives every registered unit in registration order; a client-visible unit whose raw view changes by `Object.is` notifies the change feed with its schema-validated view and the causing seq. The live drive retains its previous and current raw views; snapshots and cold reads remain complete independent reads. `checkpoint(session)` returns one detached `(key → {ver, seq, val})` row per unit for the persisted cache; `restoreFloor` anchors a tail read one event below the lowest usable watermark so a shrunk log is detected, and `restore` refolds persisted rows over a stored suffix, discarding any row whose `ver` does not match or that claims events past the stored end.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the unit contract to the read-model subsystem and the persisted cache.

- [Session projections subsystem](../../../docs/subsystems/session-projection.md) — the projection unit contract, drive semantics, and generated service API.
- [Session persistence subsystem](../../../docs/subsystems/persistence.md) — the event log projections fold over.
- [Session projection cache](../session-projection-cache/README.md) — the persisted checkpoints that make cold reads skip full log loads.
- [Session package map](../README.md) — adjacent persistence, title, and telemetry packages.
- [Session-projection RFC](../../../.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md) — the design rationale for projections and the command log.

-----

<a id="model-experience"></a>
## Model Experience

None, as the projection registry serves client-facing read models of already-logged session state and registers nothing model-facing.

#### KV Cache effect

None; projections never assemble or send provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the projection registry needs care at scale. They are current package constraints, not a task backlog.

- **Only a key-subset read omits keys; a tail page still carries every client-visible key and there is no lazy per-value request** — a summary omits exactly the keys whose `SessionProjectionMap` entry carries `SessionProjectionSummaryExcluded<T>` and whose registration declares `wire.summary: false`. The opt-out is per key, not per value: no read defers one large value.
- **The unit table is process-wide, so key presence is not a per-session capability signal** — a key registered by any agent preset appears in every session's snapshot; a client must read the value rather than treat an absent key as absence of the feature.
- **Eager drive touches every unit per event** — cheap by construction (whole-value rule and state/view reference gates), but a hot path would justify per-unit event-type prefilters.
- **Registry cells live in memory only** — a restart rebuilds by folding the log on first touch; compositions that mount `dsh-session-projection-cache` seed that fold from persisted rows instead.
- **Synchronous unit discipline is only partially mechanical** — `wire.viewSchema.parse` rejects a Promise-returning view, but an `apply` that blocks or reads torn non-session state is a review concern.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
