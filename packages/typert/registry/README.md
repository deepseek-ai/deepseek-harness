---
description: "The runtime Typert registry: stores generated package reflection, live Zod schemas, and Remote invocation descriptors, and resolves them for consumers."
kind: "package-reference"
---

# @deepseek-ai/dsh-typert-registry

English | [中文](README.zh.md)

## Summary

`dsh-typert-registry` makes generated Typert artifacts queryable at runtime: each package's reflection — services, events, and objects — its live Zod schemas, and Remote invocation descriptors live under stable keys that consumers can query or resolve on demand. Registrations are atomic and fiber-scoped: a contribution lands whole or not at all and is withdrawn automatically when the registering component unloads. The same service hosts the lookup and scoped-Context provider registries that Remote calls resolve through. It performs no TypeScript analysis and generates no schemas; the generator and the loader handle those.

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

Mount the registry in any Host or Client composition that stores or consumes generated Typert artifacts; it provides `ctx.typert`. There is no configuration.

### Minimal setup

Load the registry plugin; the Client face is installed the same way by the Client runtime's own metadata, and both faces run the same implementation:

```yaml
- name: '@deepseek-ai/dsh-typert-registry'
```

### Querying schemas and reflection

Consumers read schemas with `get(key)`, `resolve(key)`, or `list(filter?)` and package reflection with `getPackage(name, face?)` or `listPackages(filter?)`. `resolve()` distinguishes a malformed key, an absent package, and a registered package that contributes no schema under that name, each with its own error. `toJSONSchema(key)` projects a live Zod schema to JSON Schema without caching.

### Registering a contribution

Generated artifacts register through the [loader](../loader/README.md) in Loader compositions; any other owner calls `ctx.typert.register(contribution)` directly and receives the exact disposer that withdraws it. Duplicate package-face identities, schema keys, invocation ids, or endpoints reject the whole batch before anything is committed.

### Lookup and Context providers

Remote calls resolve Host objects and scoped Contexts through `ctx.typert.lookups` and `ctx.typert.contexts`. `registerHost()` installs one bidirectional Host Context adapter and its wire declaration, while `configureHost()` replaces only its resolver. `registerClient()` installs the bidirectional Client adapter for the same merge-declared kind. `identifyHost(ctx)` asks the Host adapters for the single kind and identity represented by a live Context and rejects ambiguous recognition.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the registry stores and owns contributions; the consumer API is covered in [Use this package](#use-this-package).

### Design concept

The registry is built on one principle: a contribution is one atomic, fiber-owned commit. `register()` validates the package-face identity, schemas, and invocation descriptors first, then commits everything under a single Cordis effect whose disposer withdraws exactly that contribution. Duplicate identities fail at the owning operation boundary before any state changes.

### Sub-registries

- `ctx.typert.local` — current-environment invocation definitions, including `hasSeen()` history for source-mode fallback.
- `ctx.typert.remotes` — consumer-selected contributions mounted in the calling fiber.
- `ctx.typert.lookups` — lookup providers plus composition-owned resolver overrides per key.
- `ctx.typert.contexts` — Host Context providers and Client Context binders per scoped key.

Each sub-registry publishes `TypertRegistryChange` events to subscribed listeners; a throwing listener is logged and does not stop later listeners.

### Identity and validation

Keys are stable: `<package>#<face>` for reflection, `<package>#<name>` for schemas, and `<namespace>/<method>` for endpoints. Validation rejects names containing `#`, wire names outside the RPC segment grammar, duplicate keys, and lookup definitions whose wire declaration changes during the registry lifetime; strict codecs must carry a parseable schema.

### Source map

| File | Role |
|---|---|
| [`src/service.ts`](src/service.ts) | `TypertRegistry` service, stores, validation, effect wiring |
| [`src/types.ts`](src/types.ts) | Contribution, record, and filter types |
| [`src/client/index.ts`](src/client/index.ts) | Client face installing the same registry |
| — | No runtime invariant companion is published; schema and package-reflection records mutate together inside register/dispose, with no independent event or second data source to cross-check; duplicate identities fail at the owning operation boundary. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the registry to what feeds it and what consumes it.

- [Typert loader](../loader/README.md) — automatic registration of generated host artifacts.
- [Typert generator](../generator/README.md) — what produces the contributions the registry stores.
- [Typert protocol](../protocol/README.md) — the descriptors, codecs, and provider contracts the registry serves.
- [Typert subsystem reference](../../../docs/subsystems/typert.md) — the literal `ctx.typert` contract.
- [API Gateway reference](../../../docs/api-gateway.md) — the main consumer of invocation descriptors and providers.

-----

<a id="model-experience"></a>
## Model Experience

None, as this runtime type registry's consumers (cordis_inspect, wire faces, gates) own any model-visible projection of registry contents.

#### KV Cache effect

No direct effect; a consumer that places reflection or schemas in a request owns the resulting prefix change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the registry stores and rejects; they are current package constraints, not a task backlog.

- **No graph merging** — the registry stores generated reflection per face but does not merge host and client graphs or resolve TypeScript references; those are analyzer and emitter concerns.
- **Schema keys omit the face** — host and client run in separate contexts, so registering same-named schemas from both faces into one context is rejected as a duplicate.
- **JSON Schema projection is uncached** — `toJSONSchema()` returns a fresh document per call; consumers that project repeatedly own caching.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
