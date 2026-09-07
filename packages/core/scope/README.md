---
description: "The scoped-registration library for plugin authors and maintainers building registries or event surfaces that isolate contributions per agent or per group."
kind: "package-library"
---

# @deepseek-ai/dsh-scope

English | [中文](README.zh.md)

## Summary

The dependency-free `dsh-scope` library gives registrations a per-agent home. Mint a tagged context with `createScope(ctx, key)` and everything registered through it is visible in one scope, unwinding when that scope disposes; read a context's scope tag with `scopeOf(ctx)`; and route scope-filtered events with `scopeTarget(base, key)` to listeners with the same key while leaving untagged listeners global. Keys can form a parent chain: a child scope sees its ancestors' layers (nearest shadows farthest), and a listener tagged with an ancestor receives descendant events — never the reverse. It is key-agnostic: the agent loop uses one scope per live agent and an agent preset's standing mount is a parent scope over its agents, but lower-level packages can use it without depending on either. Choose it when you build a registry or event surface that must isolate contributions per agent or per group.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Plugin authors use `dsh-scope` to give one agent (or one group) its own registration world. The registries in the core group build on it — a tool registered through `agent.ctx` is visible only to that agent — and the same primitive serves any custom registry or scope-filtered event.

### Mint a scope

`createScope(ctx, key)` creates a scope under `ctx`'s fiber: its `ctx` carries the scope tag, and everything registered through it is both scope-visible and scope-lifetime. `dispose()` unwinds every registration through the scope; `rawDispose` is the exact Cordis disposer for nesting the teardown in an ordered composite effect.

```text
const scope = createScope(ctx, agent)
scope.ctx.on('agent/status', ({ agent, status }) => track(agent, status))
// later:
await scope.dispose()   // unwinds every registration made through scope.ctx
```

### Route scoped events

`scopeTarget(base, key)` builds the opaque carrier a scope-filtered event dispatches with. Untagged listeners stay global; a listener tagged with `key` receives events for that key and its descendants. The carrier carries routing state only — the real subject travels in the event arguments.

### Build a scoped registry layer

Registry authors use `ScopedLayers`, `NamedEntries`, and `AnonymousEntries` to hold one eager global layer plus lazily created exact-scope layers: reads never create layers, `merge()` materializes insertion-ordered named shadows along the scope chain, and `effect()` derives visibility and ownership from the same context. A scoped layer is reclaimed only when its whole aggregate is empty.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the package realizes the behavior above; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The registration context determines both visibility and ownership: a registration made through a scoped context is visible in that scope and disposed with it, preventing a contribution from being visible in one scope but torn down with another. The primitive routes trusted same-process plugins; it is not a sandbox or an authority boundary. Handing out a scoped context also hands out the minting plugin's service-resolution API (resolution walks the minting fiber's dependency chain), so a scope is minted from the plugin whose dependencies the scoped registrations need.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `createScope`, `scopeOf`, `scopeTarget`, `bindScopeParent`/`scopeParentOf`/`scopeChainOf`, carrier marks |
| [`src/store.ts`](src/store.ts) | `ScopedLayers`, `NamedEntries`, `AnonymousEntries`, `ScopeLayer` |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion over the generated scoped-event map |
| [`src/scoped-events.generated.ts`](src/scoped-events.generated.ts) | Generated resolver map of declared scoped events |

### The parent chain

One relation powers both directions: registration views inherit DOWN the chain (a child scope sees its ancestors' layers), while event admission extends UP it (a listener tagged with an ancestor receives events dispatched to a descendant key). Binding is once — a key that already has a parent throws, and only the returned binding may re-link it — and every link rejects a cycle. `scopeChainOf` returns `[key, parent, …]` nearest-first.

### Event filtering

`scopeTarget` composes the base's existing `Context.filter` with the scope predicate: an untagged listener is admitted; a tagged listener is admitted iff its tag is the dispatch key or an ancestor of it; `key === undefined` admits untagged listeners only. `{ global: true }` listeners bypass filtering. The `Scoped<T>` brand demands the carrier as the `this` type of a scope-filtered event, so dispatching with a bare subject is a compile error.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The package-level contract is enough for most consumers; read these when you need the surrounding domain and the design rationale.

- [Scoped registration subsystem](../../../docs/subsystems/scope.md) — the identity, carrier, and layer types.
- [Agent-scope contexts Agent Note](../../../.agents/notes/implemented/architecture/2026-07-08-agent-scope-contexts.md) — the security non-goals and context design.
- [Agent-scope runtime design Agent Note](../../../.agents/notes/implemented/architecture/2026-07-12-agent-scope-runtime-design.md) — how the loop builds per-agent scopes.
- [Core group map](../README.md) — how the core packages compose.

-----

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the primitive needs special care. They are current package constraints, not a task backlog.

- **Only scope-aware APIs isolate state** — registries must file by `scopeOf()` and events must dispatch through `scopeTarget()`; an arbitrary Cordis service remains context-global merely because it is called through a scoped context.
- **A context carries one nearest scope key** — the hierarchy lives in the key-level parent relation, not in context tags; nested scope contexts still shadow to a single tag, and multi-membership policy sets remain unsupported.
- **Service reachability comes from the scope minter** — handing out `Scope.ctx` also hands out the minting plugin's injected services, so a broader minter cannot later be narrowed by the holder.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
