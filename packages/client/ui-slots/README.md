---
description: "Slot registry pure core for the dsh web client: ordinary extension slots, reusable Component Factories, derived props types, store seats, and the renderer install contract."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-slots

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-slots` lets web client plugins define and compose typed UI regions. Ordinary Slots provide parent-owned extension positions; Component Factories provide reusable assemblies with caller-selected local Components. Both APIs derive scoped state, injection, locale, and child-render props from declaration-merged types and report conflicting definitions during plugin loading. Pair this React-free package with `ui-renderer` when the client needs rendering.

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

Compose UI through this package whenever you write a client plugin: register a component into a slot your parent declared, or declare child slots your component renders. The five kinds cover the composition shapes — `single` (one occupant), `list` (ordered entries), `keyed` (dispatch by a key), `chain` (entries elect themselves), and `hoc` (layers nest around the owner's `children`, each rendering it at most once; an optional `key` limits a layer to the owner's matching `entryKey`).

### Reusable Component Factories

A designer may choose a Component Factory for a component or assembly they consider reusable, even with one current caller; unrelated parents, separate packages, and additional injection or local slots are not prerequisites. A one-off component need not use a Factory. Declare its complete type in `SlotFactoryMap`, install the definition with `ctx.slots.registerFactory()`, render occurrences through the injected `renderFactorySlot()`, and select each declared local Component through the call's `slots` option. The definition reads that choice through `useFactorySlot(name, fallback)`.

Factory `children` remain ordinary global Slots and must match `SlotMap`, while local `slots` select one Component per occurrence. An occurrence inherits its render-position scope; `renderFactorySlot()` does not accept a Session identity. Shared Store handles use ordinary scope resolution. A Store factory stays lazy until an occurrence first materializes, then creates one handle for that render position and rejects a persistent Store spec whose key would collide across occurrences.

In DOM queries, `[data-slot-factory]` marks a rendered Factory, and `[data-slot-factory-children]` marks a mounted local component explicitly selected by its caller. See the [Factory DOM migration guide](../../../docs/upgrade-guide/v0.2.3-alpha.2/factory-content-roots/guide.md) for selector examples and how to declare inline roots.

### The five framework props shares

Every registered component receives props composed from five framework shares: the runtime share (`owner` from the parent's render call site, plus the session standard kit and global seat), the child-render share (`renderSlot` statically narrowed to declared children), the Factory-render share (`renderFactorySlot`), the store share (the declared handle's selector hook and draft-stripped actions), and the business share (inferred from `inject`). Components reference the derived props aliases; they never re-type a share locally.

An open-key standard Hook, called as `useName(key, selector?, equal?)`, also accepts `useName(key, member)`: a string second argument reads the `KeyedStandardSource` resolver's `(key, member)` source without a selector. The resolver returns the same source object for the same arguments while that source is live.

### Store seats

A register call may declare a store seat with `store: defineStore(...)`: `init` infers the state schema and `actions` is the complete draft-transform write set. Components read through the selector hook and write through the baked callbacks; the engine implementation of `defineStore` lives in the runtime package and satisfies the `DefineStore` contract exported here.

### Declaration discipline

Declaring a slot is claiming it: the registering entry becomes the only entry allowed to render that key, and registering into an undeclared slot, declaring an already-declared child, mounting one shared handle under two scopes, or registering a chain without `select` throws at load. An entry's disposer collapses its declared child slots recursively — ledger rows, contributions, and store mounts die on one lifecycle axis.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The ordinary Slot design is one table: declaration = render authorization = runtime spec. `SlotMap` is declared empty here and merged by consumers via `declare module` augmentation, exactly like `SlotFactoryMap` and the standard-kit interfaces (`SessionStandardProps`, `GlobalStandardProps`). Factory definitions use a separate single-definition ledger because their occurrences have no parent declaration.

### Registration and routing

`SlotCore` seeds the a-priori `'root'` slot at construction and enforces load-time validation. `ChainSelect` selectors run in ascending `priority` order (ties in registration order); the first non-null return elects its entry and becomes the component's `matched` prop, and all-null falls to the owner's `renderSlotChain` fallback (`ChainRenderOpts`). Each key carries a declaration epoch that advances only on declaration and collapse; `ui-renderer` uses it for `ctx.slots.inject`, independently from ordinary entry versions. Live inspection uses strict `type: 'slot' | 'factory'` nodes and nests Factory-owned child Slots under their definition.

### The renderer contract

`renderer.ts` carries the installation contract (`SlotRenderer`, `SlotRendererHost`) plus `StaleAuthorizationError`/`SlotOwnershipError`; ui-renderer owns both the implementation and its plugin-lifecycle installation. Engine products and the renderer host contract carry bare snapshot sources (`getSnapshot`/`subscribe`), never React hooks — hook binding belongs to the render machinery. Factory crashes use the ordinary supervision channel, and an idempotent effect retains per-position Store handles only after commit.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the engine, the renderer, and the composition model.

- [ui-renderer](../ui-renderer/README.md) — the React slot renderer implementing this package's install contract.
- [Slot system standard](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md) — the definitive composition model.
- [Component Factories](../../../.agents/notes/implemented/architecture/2026-09-10-component-factories-and-local-slots.md) — reusable definitions, local Component selection, and occurrence lifetimes.
- [Web client architecture](../../../docs/subsystems/web-client.md) — the loading chain and object layer this registry plugs into.

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
- **Dynamic plugin package** — the package is a dynamic plugin package with `immediately: true`. Its `/client` entry, `lib/client.js`, built from `src/client/index.ts`, still exports values that other bundles require, a historical exception that will be reduced over time ([export discipline](../AGENTS.md#export-discipline-client-plugin-packages)); browser bundles reach those exports by package name or by the `/client` subpath, which name one module-table row. For compatibility with code outside the repository, the package root's types reuse the `./client` declarations, and its runtime, `lib/index.js` built from `src/index.js`, is the Host entry with an empty `apply` ([package roots](../AGENTS.md#hand-written-package-roots)). In Node the package root therefore provides no values: code imports them from the `/client` subpath, and tests that run them outside the browser resolve that subpath to source ([Client test runtime](../../test-support/client-runtime/README.md#module-resolution)); repository code names the package only through `/client`. Independent consumers supply its development dependencies ([dependency rules](../AGENTS.md#dependency-declaration)).
- **The `__renders` phantom anchor is visible on `PropsRenderSlots`** — the same accepted noise as the type-chain design's `__accepts`: generic method signatures compare loosely across key unions, so the contravariant marker is what enforces "component key set ⊆ children declaration".

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
