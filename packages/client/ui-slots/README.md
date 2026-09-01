---
description: "Slot registry pure core for the dsh web client: SlotMap declaration merging, the single register composition API, four-share props types, store seats, and the renderer install contract."
kind: "package-library"
---

# @deepseek-ai/dsh-client-ui-slots

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-slots` is the pure core of the web client's slot system: the type-level contract every UI feature composes through. One `register({ name, children?, store?, inject?, ...kind }, Component)` call contributes a component into a declared slot and, in the same breath, declares child slots, a store seat, and the registrant's business face. The component is checked at the call site against `ComposedProps` — the intersection of four shares, each derived from its single source of truth — so a wrong composition fails to compile. Chain-kind slots invert keyed routing: entries self-nominate through a pure selector instead of the dispatch site picking an `entryKey`. The package is React-free and Cordis-free at runtime (React types only); `ui-renderer` owns the engine implementation and React bindings.

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

Compose UI through this package whenever you write a client plugin: register a component into a slot your parent declared, or declare child slots your component renders. The four kinds cover the composition shapes — `single` (one occupant), `list` (ordered entries), `keyed` (dispatch by a key), and `chain` (entries elect themselves).

### The four props shares

Every registered component receives props composed from four shares: the runtime share (`owner` from the parent's renderSlot call site, plus the session standard kit and global seat), the child-render share (`renderSlot` statically narrowed to the declared children keys), the store share (the declared handle's selector hook and draft-stripped actions), and the business share (inferred from the `inject` factory's return). Components reference `ComposedProps`; they never re-type a share locally.

### Store seats

A register call may declare a store seat with `store: defineStore(...)`: `init` infers the state schema and `actions` is the complete draft-transform write set. Components read through the selector hook and write through the baked callbacks; the engine implementation of `defineStore` lives in the runtime package and satisfies the `DefineStore` contract exported here.

### Declaration discipline

Declaring a slot is claiming it: the registering entry becomes the only entry allowed to render that key, and registering into an undeclared slot, declaring an already-declared child, mounting one shared handle under two scopes, or registering a chain without `select` throws at load. An entry's disposer collapses its declared child slots recursively — ledger rows, contributions, and store mounts die on one lifecycle axis.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The design is one table: declaration = render authorization = runtime spec. `SlotMap` is declared empty here and merged by consumers via `declare module` augmentation, exactly like the standard-kit interfaces (`SessionStandardProps`, `GlobalStandardProps`), which the runtime package merges with real members.

### Registration and routing

`SlotCore` seeds the a-priori `'root'` slot at construction and enforces load-time validation. `ChainSelect` selectors run in ascending `priority` order (ties in registration order); the first non-null return elects its entry and becomes the component's `matched` prop, and all-null falls to the owner's `renderSlotChain` fallback (`ChainRenderOpts`). Each key carries a declaration epoch that advances only on declaration and collapse; `ui-renderer` uses it for `ctx.slots.inject`, independently from ordinary entry versions.

### The renderer contract

`renderer.ts` carries the installation contract (`SlotRenderer`, `SlotRendererHost`) plus `StaleAuthorizationError`/`SlotOwnershipError`; ui-renderer owns both the implementation and its plugin-lifecycle installation. Engine products and the renderer host contract carry bare snapshot sources (`getSnapshot`/`subscribe`), never React hooks — hook binding belongs to the render machinery.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the engine, the renderer, and the composition model.

- [Slot declaration injection decision](../../../.agents/notes/implemented/architecture/2026-08-05-slot-declaration-injection.md) — the lifecycle rules behind `ctx.slots.inject`.
- [ui-renderer](../ui-renderer/README.md) — the React slot renderer implementing this package's install contract.
- [Slot system standard](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md) — the definitive composition model.
- [Web client architecture](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) — the loading chain and object layer this registry plugs into.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the registry's scaling behavior and accepted type noise; they are current package constraints.

- **`isLive` scans all records linearly** — fine at UI-plugin registration counts (tens); revisit with an entry→record backref if ledgers ever grow hot.
- **The `__renders` phantom anchor is visible on `PropsRenderSlots`** — the same accepted noise as the type-chain design's `__accepts`: generic method signatures compare loosely across key unions, so the contravariant marker is what enforces "component key set ⊆ children declaration".

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. A zero-dependency pure registry core — it emits no cordis events itself (the `ui-renderer` SlotRegistry owns the event bridge and its invariants); define/register/dispose sequencing is asserted directly by this package's behavior specs.
