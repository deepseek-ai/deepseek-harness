# Agent Note: Shared scoped-layer storage

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-12-scoped-layers-store.zh.md)

## Problem

Agent scoping ([decision](2026-07-08-agent-scope-contexts.md), [runtime design](2026-07-12-agent-scope-runtime-design.md)) gives scope-aware registries the same recurring shape: one global registration layer plus one exact agent layer. Seven registration facades use that shape: `tools.register`, `tools.restrict`, and `tools.guard` in `dsh-tools`; `SystemPrompt.section`, `SystemPrompt.tools`, and `SystemPrompt.variable` in `dsh-system-prompt`; and `CommandRuntime.register` in `dsh-commands`.

Without a shared primitive, each facade repeats the lifecycle choreography around its domain state: derive visibility from the calling context, create a scoped container on demand, attach ownership to the same Cordis fiber, install undo before notifying observers, return Cordis's exact disposer, and reclaim empty scoped state. Separate maps and collection types also leave a service without one object representing a scope's complete contribution.

The duplicated code carries three non-obvious requirements:

- Visibility and ownership must come from the same context; accepting them separately permits a registration visible in one scope but disposed with another.
- Undo must be collected before a change callback runs, so a throwing callback rolls the mutation back.
- The public disposer must be the exact function returned by `ctx.effect()`; wrapping it breaks Cordis's identity-based ordered teardown.

The shared part is lifecycle and insertion-ordered storage, not registry policy. Tool restrictions, reserved transport handling, prompt evaluation timing, command normalization, exact diagnostics, and callback containment remain different domain contracts.

## Decision

`@deepseek-ai/dsh-scope` provides a key-agnostic `store.ts` implementation module. The package continues to peer on Cordis and `@deepseek-ai/dsh-invariants`, and its invariant companion remains unchanged. The package root exports four storage symbols: `ScopeLayer`, `ScopedLayers`, `NamedEntries`, and `AnonymousEntries`. `EntryValues` remains internal, and `store.ts` is not a package subpath.

`ScopeLayer` keeps the aggregate concept explicit while requiring only whole-layer emptiness. A service defines one concrete layer whose tables and domain helpers fit that service; `ScopedLayers` owns construction, selection, lifecycle attachment, notification, and aggregate reclamation.

## Public interface

```ts ignore-check
export interface ScopeLayer {
  isEmpty(): boolean
}

export class ScopedLayers<L extends ScopeLayer> {
  constructor(
    createLayer: (scope: ScopeKey | undefined) => L,
    onChange: () => void,
  )

  readonly global: L
  peek(scope: ScopeKey | undefined): L | undefined

  merge<V>(
    scope: ScopeKey | undefined,
    pick: (layer: L) => NamedEntries<V>,
  ): Map<string, V>

  effect(
    ctx: Context,
    action: (layer: L) => () => void,
    options: { label: string; notify?: boolean },
  ): () => void
}

export class NamedEntries<V> {
  constructor(duplicateError: (name: string) => Error)
  insert(name: string, value: V): () => void
  get(name: string): V | undefined
  has(name: string): boolean
  keys(): IterableIterator<string>
  entries(): IterableIterator<[string, V]>
  values(): IterableIterator<V>
  isEmpty(): boolean
}

export class AnonymousEntries<V> {
  append(value: V): () => void
  values(): IterableIterator<V>
  isEmpty(): boolean
}
```

## Storage contract

- The constructor creates `global` once with `createLayer(undefined)`. A scoped layer is created only by `effect()`; `peek()` and `merge()` never create one, and `peek(undefined)` returns `undefined` because the global layer is already explicit.
- `merge()` is the only materialized generic read. It copies named global entries in insertion order, then applies matching scoped entries in their insertion order so same-name entries shadow without moving unrelated names.
- `NamedEntries.insert()` checks and inserts atomically, returns an idempotent exact-entry undo, and obtains the registry's exact duplicate diagnostic from the caller-supplied factory. Lookup and iterators retain native `Map` order and stay live within one nonempty table generation; draining the table starts a new generation so an in-flight iterator cannot observe a self-replacement.
- `AnonymousEntries.append()` assigns a unique internal key per registration, so equal callbacks or values remain independent. Its iterator is insertion-ordered and uses the same live-generation boundary.
- `effect()` derives the key with `scopeOf(ctx)` and attaches the action to that same `ctx.effect()`. It accepts one synchronous action returning one synchronous undo; actions must either return their undo or throw before retaining a contribution. The helper does not normalize the wider Cordis `Effect` union.
- `effect()` collects the action's undo before calling `onChange` and returns the exact `ctx.effect()` disposer. Disposal runs the action undo before notification, is idempotent through Cordis, and removes a scoped layer only after its complete `ScopeLayer.isEmpty()` becomes true.
- `options.notify` defaults to `true`. The callback's own policy stays authoritative: tool and prompt change callbacks may throw and trigger registration rollback; `CommandRuntime.notifyChange()` contains observer failures; tool guards pass `notify: false`.

## Registry migrations

`dsh-tools` defines one `ToolLayer` containing named tools plus anonymous compiled restrictions and guard registrations. `ToolRuntime` retains its private domain resolver for visible definitions, pre-restriction known names, restrictable global names, scoped shadowing, restrictions, and reserved `run_code` insertion. Guard evaluation live-iterates global then scoped registrations: additions to a nonempty generation can run in the current dispatch, while a self-replacement after draining the guard table begins with the next dispatch.

`dsh-system-prompt` defines one `PromptLayer` containing named sections and variables plus anonymous tool providers. Assembly merges sections before evaluating them, so a shadowed provider is never called. Tool-provider membership is materialized once per assembly. Variable providers live-iterate global then scoped tables: additions to a nonempty generation can run in the current assembly, while a self-replacement after draining the variable table begins with the next assembly.

`dsh-commands` defines a one-table layer containing `NamedEntries<RegisteredCommand>`. Effective views use `merge()`, while `CommandRuntime` retains definition normalization and freezing, exact duplicate diagnostics, sorted immutable descriptors, direct execution, HMR cleanup, and independently contained `commands/change` observers.

All seven facades keep validation and diagnostics in their owning registry and continue to return the exact Cordis disposer. The migration changes neither public registry behavior nor model-, human-, wire-, persistence-, or configuration-visible output.

## Alternatives considered

**Keep the independent implementations.** This avoids a new library interface but leaves lifecycle ordering, disposer identity, and scope reclamation duplicated across seven facades.

**One helper per table.** This removes some local code but preserves multiple per-scope maps and cannot reclaim one scope's aggregate contribution correctly.

**Per-scope registry instances.** Child registries would need delegation for global-plus-scoped views, special subtraction for restrictions, and observer discovery across instances. They would move complexity rather than remove it.

**Explicit scope parameters on registration methods.** Separate visibility and ownership inputs make mismatched lifetimes representable, while an omitted scope silently becomes global.

**Accept the complete Cordis `Effect` union.** None of the seven registrations has asynchronous setup, multiple undos, or an independent settlement boundary. General normalization would duplicate Cordis lifecycle machinery without a current consumer.

**Expose `ScopedLayers.values()`, `ScopedLayers.keys()`, or a global-admission predicate.** Those operations encode consumer-specific live/materialized and filtering policies. Direct table iteration preserves explicit live semantics, `merge()` covers the shared named shadowing operation, and `ToolRuntime` keeps its richer private resolver.

**Put `values()` on `ScopeLayer` or export `EntryValues`.** A layer aggregates heterogeneous tables and has no coherent value type or iteration policy. `EntryValues` is useful only to share implementation details between the two table classes; making it public would enlarge the interface without giving callers a meaningful layer-wide read.

**Generate layers from a mapped-type table description.** Three-table and one-table concrete layers are short, inspectable, and free to hold domain helpers. A class generator would add a second construction model and generated runtime shape for little leverage.

## Consequences

- Scope-aware registries express one aggregate layer and reuse the same construction, ownership, rollback, notification, and reclamation choreography. Domain-specific validation, diagnostics, filtering, evaluation, and observer policy remain in each registry.
- The public read API stays narrow: direct table iteration preserves explicitly live behavior, while `merge()` is the one shared materialized shadowing operation. A heterogeneous `ScopeLayer` has no layer-wide `values()` contract.
- The helper is deliberately synchronous. A future registration that needs asynchronous setup or several independently owned undos must identify its ownership and settlement boundaries before widening this contract.
- An action must throw before retaining a contribution or return an undo for everything it retained; the helper cannot repair mutation outside that contract. The provided entry operations are atomic, and migrated registries perform fallible validation before insertion.
- A scoped layer remains allocated until every table in its aggregate is empty. Disposing one facade therefore cannot discard sibling contributions owned by the same scope.
- The four public symbols become a reusable package contract. Keeping `EntryValues` internal and consumer policy outside the helper limits the compatibility API.
- The migration changes no public registry behavior and no model-, human-, wire-, persistence-, configuration-, or dependency-graph output.

## Verification

- `dsh-scope` unit tests cover global construction, lazy scoped construction, non-creating reads, named merge order and shadowing, aggregate reclamation, factory and action failure cleanup, notification ordering and rollback, `notify: false`, effect labels, exact disposer identity, idempotent teardown, caller-owned duplicate errors, independent anonymous duplicates, live iterators, and drained-generation detachment.
- Focused tool, system-prompt, and command suites cover restrictions, reserved transport handling, known/restrictable-name agreement, guard re-entrancy and self-replacement, validation order, exact diagnostics, section shadow-before-evaluate, provider snapshot membership, variable re-entrancy and self-replacement, contained command observers, frozen and sorted views, direct execution, and lifecycle disposal.
- The scoped core-data type-equivalence check ties `ScopeLayer` documentation to its source declaration. Repository documentation, module-graph, build, hygiene, coverage, and built-artifact gates exercise the root export and package boundary.
- Existing ACP, headless, and TUI keyless snapshots remain the regression boundary for tool schemas and prompt assembly; TUI coverage owns human commands. The implementation does not update any expected transcript.
