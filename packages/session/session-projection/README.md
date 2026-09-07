---
description: "The session-projection registry for developers serving whole current values of log-derived per-session state to client carriers, and for maintainers of the drive contract."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-projection

English | [中文](README.zh.md)

## Summary

`dsh-session-projection` serves whole current values of log-derived per-session state to client carriers — the history tail page and the `session/projection` push frame — through a registry (`ctx.sessionProjections`) that folds every committed session event through registered projection units. A domain registers a pure computation unit (initial state, a fold over events, and an optional client view); the framework owns the subscription, the drive, and change notification, so domains hold no subscriptions and clients receive finished values, never fold events themselves. Every served value is plain JSON validated against a schema, and a per-unit `stateVersion` anchors persisted-cache invalidation. Choose it when a client needs derived per-session state — a todo list, a goal snapshot, conversation stats — without folding the raw log itself.

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

Choose it when a domain keeps state that clients should see without re-deriving it — a todo list, a goal snapshot, conversation statistics. The registry drives units eagerly over committed events, so any registered unit's value is current by construction. Skip it for host-only bookkeeping that no client reads: a unit without a `wire` block stays host-only. A host reader either declares `sessionProjections` in its plugin `inject` or fails explicitly when the registry or required key is absent. Contributors may preserve optional registration through `ctx.inject(['sessionProjections'], ...)`.

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

`register(definition)` installs the unit; registrants with the same key and `stateVersion` share its cells, while an incompatible version or invalid `stateVersion` throws. Registration is an effect on the calling fiber, so the last unload removes the key and its cached cells. Carriers read a consistent synchronous cut over every client-visible unit with `snapshot(session)` — `{ asOfSeq, values }`, where `asOfSeq` is the seq of the last event every value reflects — and subscribe to per-change notifications with `onChanged(listener)`. `stateOf(session, key)` reads one unit's live read-only host state without computing unrelated views.

```text
const dispose = ctx.sessionProjections.register(definition)
const { asOfSeq, values } = ctx.sessionProjections.snapshot(session)
```

A domain that requires projected state declares `sessionProjections` as a Cordis service dependency; optional contributors may register under `ctx.inject(['sessionProjections'], …)`. Carriers use `ctx.get('sessionProjections')` and omit their block or frames when the registry is absent.

### Persisted checkpoints

Every unit's state is checkpointed — client-visible and host-only alike — through `checkpoint(session)`, and the sibling [session-projection-cache](../session-projection-cache/README.md) persists those checkpoints so cold reads skip full log loads. Checkpoint watermarks use `SessionSeqCursor` (`-1` for an empty log), while replay starts use `SessionLogOffset`; `restoreFloor` and `restore` implement the read recipe without conflating an existing event with a log gap.

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
| [`src/types.ts`](src/types.ts) | The merge-extensible `SessionProjectionMap` and `SessionProjectionStateMap` type tables |
| — | No runtime invariant companion is published; the registry's own contracts (duplicate-key and stateVersion rejection, effect-tied removal, the Object.is change gate) are enforced synchronously inside the service and proven by its spec, the drive relation (every committed `session/event` passes every unit) would require re-running the drive to check — duplicating the implementation rather than detecting drift — and the served-value relation (every served key has a live registration) lives on each carrier's wire path, which emits no cordis event this companion could observe; carrier specs assert it. Synchronous-unit discipline is enforced as far as practical by the boundary `schema.parse` (a Promise-returning view fails loudly). |

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

- **Every tail page carries every client-visible key** — there is no per-key opt-out or lazy-key request shape yet; acceptable while values are UI-scale whole states, revisit if a domain's value grows large.
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
