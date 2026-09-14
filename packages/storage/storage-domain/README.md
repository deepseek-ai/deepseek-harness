---
description: "Domain data form (ctx.storageDomain) for hosts and maintainers choosing, mounting, or debugging schema-validated, change-emitting KV domains over storage backends."
kind: "package-reference"
---

# @deepseek-ai/dsh-storage-domain

English | [中文](README.zh.md)

## Summary

Use this package to declare schema-validated key-value domains and open them through `ctx.storageDomain` over a configured storage backend. Reads return synchronously from validated in-memory state, while each write becomes durable before it resolves and emits `domain/changed` in order. Product packages use domain handles instead of accessing storage backends directly. This host-side state does not add tools, prompts, or session events, so it remains invisible to the model and agent loop.

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

Use this package when a host package keeps durable, schema-validated records — workspace records, session sidecar metadata. The owning package declares the domain once; consumers open it and get synchronous reads and durable, change-emitting writes without ever touching a backend.

### When to use it

Choose it for any host-side data that must survive restarts and stay valid against a schema: the domain form validates every stored record at open, and every write is durable before it resolves. Avoid it when the data belongs in a session event log — the session persistence seam owns that surface.

### Declaring a domain

The owning package declares the domain once with `defineDomain` — name, version, and zod record schemas — and exports it. `defineDomain` fails loudly at module load on a bad name, a version that is not a non-negative integer, or a global schema that accepts `null`.

```text
// Owning package, once:
const workspaceSpec = defineDomain({
  name: 'workspace',
  version: 1,
  tables: { workspaces: domainTable(workspaceRecordSchema) },
})
```

### Opening and using a domain

A consumer opens the declared domain through `ctx.storageDomain` and keeps the returned handle; reads are synchronous, writes are durable:

```text
const domain = await ctx.storageDomain.open(workspaceSpec)
await domain.table('workspaces').put(id, { path: '/work/demo' })
const record = domain.table('workspaces').get(id) // synchronous, from memory
domain.table('workspaces').update(id, (r) => ({ ...r, path: newPath }))
```

The caller owns the handle's lifecycle and releases it with `domain.close()` when the feature shuts down (typically its own `ctx.effect` disposer); domains still open when the plugin unmounts are closed by the facility.

### Routing domains to backends

The domain plugin's configuration decides which backend serves which domain — never the hub. `backend` names the default route; `routes` overrides it per domain name. A route naming an unregistered backend fails loudly at open with `backend-not-found`.

| Field | Default | Meaning |
|---|---|---|
| `backend` | required | Default backend name for every domain without an explicit route |
| `routes` | `{}` | Per-domain overrides: domain name → backend name |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-storage-domain) is the exhaustive source for every accepted field and its JSDoc.

### Observable behavior and failures

Every write resolves only after the backend acknowledges durability, and each emits one `domain/changed` event in write order. Failures carry stable `DomainError` codes: `already-open` (the name is open or still closing), `facet-unsupported` (the routed backend serves no `kv` facet), `invalid-record` (a stored record or global fails its schema, naming the table and key), `missing-key` (an `update` on an absent record), and `closed` (any use after close). Backend failures such as `version-mismatch` pass through unchanged.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The domain layer is a single implementation, not an abstracted seam: consumers depend on this package and never touch backends directly, which concentrates all domain logic — schema validation, write serialization, change events — in one place instead of doubling it per backend.

### Design concept

- **The spec object is the single source of truth.** `defineDomain` pins the spec's literal types and validates its fields at the owning package's module load, before any medium is touched. Record schemas are zod, so `z.infer` avoids duplicating consumer types; plugin `Config` stays schemastery.
- **Memory is authoritative; the medium is the durable projection.** Reads are synchronous from validated in-memory state. Every write queues on one per-domain write chain: backend durability first, then memory mutation, then `domain/changed` — a rejected backend write leaves memory untouched, so reads never diverge from the medium.
- **One write chain per domain.** `put`, `delete`, `update`, and `global.set` all queue on it; `update`'s transform runs at its chain slot, so concurrent updates never interleave. Records are plain immutable data — returned values are the stored objects themselves and must not be mutated in place.
- **Writes emit after the commit point.** `domain/changed` is a notification, not a transaction participant: a throwing listener is contained with a logged warning rather than rejecting the already-durable write.

### Open sequence

`DomainFacility.open(spec)` runs a strict sequence, each step failing the whole call: reject a name already open or still closing (`already-open`); resolve the route (`backend-not-found`); require the `kv` facet (`facet-unsupported`); open the unit (backend `version-mismatch`/`malformed-medium` pass through); load and validate every stored record and the global against the spec's schemas (`invalid-record`); construct the domain. The caller owns the handle; the facility closes any domain left open when it unmounts, and a closed domain's name frees for reopening only after teardown completes.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `DomainFacility`, routing, `Config`, form mounting |
| [`src/spec.ts`](src/spec.ts) | Domain declarations: `defineDomain`, `domainTable`, descriptor projection |
| [`src/domain.ts`](src/domain.ts) | Open-domain runtime: write chain, table and global handles, close |
| [`src/events.ts`](src/events.ts) | The `domain/changed` event vocabulary |
| [`src/error.ts`](src/error.ts) | `DomainError` codes |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: every `domain/changed` agrees with in-memory state |

### Invariant

The `storage-domain-invariant` companion registers the owned relationship: every `domain/changed` event must agree with the emitting domain's authoritative in-memory state at emission — a divergence means a write path skipped the chain or emitted a stale value.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the domain layer's view is not enough: the subsystem reference is the authoritative contract, and the Agent Note records the design and deferred work.

- [Storage subsystem](../../../docs/subsystems/storage.md) — the domain contract, backend contract, change events, and generated API.
- [Storage package map](../README.md) — the family's packages and their repository position.
- [domain KV storage Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md) — why domains exist, the workspace consumer, and deferred work such as cross-process change push.
- [Workspace subsystem](../../../docs/subsystems/workspace.md) — the first consumer of the domain data form.

-----

<a id="model-experience"></a>
## Model Experience

### Durable domain state

#### What the model sees

Nothing. The package registers no tools, injects no prompts, and appends no session events; it stores non-session data behind `ctx.storageDomain` and emits only the in-process `domain/changed` event, which reaches a model only if a consumer renders it through its own documented surface.

#### Token effect

Zero: no text from this package enters any model request.

#### KV Cache effect

Independent: domain reads and writes never touch request prefixes, so nothing here can invalidate provider cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the domain layer is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Single-process change visibility** — `domain/changed` is an in-process event; a second host process or a reconnecting GUI observes no changes until the cross-process revision pattern lands ([Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md)).
- **No cross-table transactions, secondary indexes, or multi-segment keys** — each write touches one record; these extensions are deferred in the Agent Note's out-of-scope list.
- **No data migration** — a domain whose stored version differs from its spec rejects at open (`version-mismatch`); changing a schema requires migrating the stored data by hand.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
