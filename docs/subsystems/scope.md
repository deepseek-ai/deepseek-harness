# Scoped Registration

English | [中文](scope.zh.md)

The [scope package](../../packages/core/scope) supplies the identity, carrier, and scoped-layer vocabulary that makes one registration context mean both per-agent visibility and shared lifetime ownership. It is a library primitive rather than a Cordis service; the [agent-scope runtime-design Agent Note](../../.agents/notes/implemented/architecture/2026-07-12-agent-scope-runtime-design.md#scope-routing-one-opaque-key-selects-one-layer) owns the lifecycle rationale, and the package [README](../../packages/core/scope/README.md) owns the callable API and filtering semantics.

Sources: [`packages/core/scope/src/index.ts`](../../packages/core/scope/src/index.ts) and [`packages/core/scope/src/store.ts`](../../packages/core/scope/src/store.ts).

## Identity and dispatch carrier

`ScopeKey` is an opaque object identity. The shipped loop uses the live `Agent` object as its own key, but the primitive never inspects the object.

```ts type-equiv
/** An opaque, identity-compared scope key. */
type ScopeKey = object
```

`Scoped<T>` is the compile-time brand on the opaque routing receiver returned by `scopeTarget(base, key)`. Scope-filtered event declarations require this carrier as their `this` type, while the real event subject remains an explicit argument.

```ts type-equiv
/**
 * A routing-only event receiver built by {@link scopeTarget}. The type
 * parameter records the subject type for dispatch checking; the carrier does
 * not expose the subject's properties. Event payloads carry the real subject.
 */
type Scoped<T extends object> = object & { readonly [ScopedBrand]: T }
```

## Owned registration context

`Scope` pairs the tagged registration context with two teardown paths. `rawDispose` preserves the exact Cordis disposer identity needed by an ordered composite effect; `dispose()` is the public shared quiescence boundary for direct and racing callers.

```ts type-equiv
/** A minted registration scope and its quiescent disposal boundaries. */
interface Scope {
  /** Context through which scope-owned registrations are made. */
  ctx: Context
  /** Exact Cordis disposer, used when nesting this scope in an ordered composite effect. */
  rawDispose: () => Promise<void> | void
  /** Dispose every scope-owned registration; racing calls await the same completion. */
  dispose(): Promise<void>
}
```

## Scoped registry layer

`ScopeLayer` represents one registry's complete contribution at the global or exact-scope level. A concrete layer may aggregate multiple named and anonymous tables; whole-layer emptiness lets `ScopedLayers` reclaim scoped state without discarding a sibling table.

```ts type-equiv
/** One scope's aggregate contribution to a registry. */
interface ScopeLayer {
  /** Whether every table in this layer is empty. */
  isEmpty(): boolean
}
```

`ScopedLayers<L>` owns the eager global layer and lazily created exact-scope layers. Reads do not create layers: `peek(undefined)` means no overlay, while `merge()` materializes insertion-ordered global named entries followed by scoped shadows. Registrations use one context for both visibility and Cordis effect ownership, collect one synchronous undo before optional notification, return Cordis's exact disposer, and reclaim a scoped layer only when its complete `ScopeLayer` is empty.

`NamedEntries<V>` supplies insertion-ordered lookup and live iteration with caller-owned duplicate errors. `AnonymousEntries<V>` gives every append a unique identity so equal values remain independent. Iteration stays live within one nonempty table generation; draining the table detaches existing iterators from later insertions. Both return idempotent exact-entry undos; the shared `EntryValues` implementation interface is not public.
