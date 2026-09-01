---
description: "Storage hub (ctx.storage) for compositions and maintainers choosing, mounting, or debugging named storage backends and data-form facilities."
kind: "package-reference"
---

# @deepseek-ai/dsh-storage

English | [中文](README.zh.md)

## Summary

Mount `dsh-storage` to give a composition durable, non-session storage: it is the hub where backends and data forms connect, so host packages can read and write typed records through `ctx.storageDomain`. The hub performs no IO itself — backends own the medium (a file-tree root, a database file), and data forms own semantics — so a composition pairs it with one or more backends and the domain form. It is optional and host-side only: it registers no tools, injects no prompts, and writes no session events, so the model and the agent loop never see it. Choose it whenever any package in the composition needs durable data that is not a session event log; a composition with no such data can omit the whole group.

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

Use this package to give a composition durable, non-session storage: mount it together with backend and domain-form packages, and host-side packages read and write validated records through `ctx.storageDomain`. The hub itself adds nothing observable — it is the meeting point that makes the family work, and everything below is what a composition gets from it.

### When to use it

Mount the hub whenever any package in the composition persists data that is not a session event log — workspace records, session sidecars. It is required by the domain form and both shipped backends, so the storage rows of a composition are `storage` plus a backend plus `storage-domain`. Skip the whole group when nothing stores such data; the agent loop never needs it.

### A minimal composition

```yaml
- name: '@deepseek-ai/dsh-storage'
- name: '@deepseek-ai/dsh-storage-json'
  config:
    root: /var/lib/dsh/data
- name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
```

With these rows, the `json` backend registers itself and the `domain` data form mounts; a consumer such as `dsh-workspace` then opens its domain over the routed backend and reads and writes records through `ctx.storageDomain`. Several backends can stay mounted side by side; which backend serves which domain is the domain form's configuration, never a hub-wide choice.

### What you get

- A mounted backend resolves by name, so a composition with both shipped backends can route each domain to either medium by configuration.
- A mounted data form resolves as `ctx.storage.<form>`; the domain form is additionally served directly as `ctx.storageDomain`.
- Misconfiguration fails loud with a stable `StorageError` code instead of silently deferring: an unknown backend name, a form read before its owner mounts, or a duplicate registration all throw.

### Failures and recovery

- `backend-not-found` — the domain form routes to a backend that is not mounted; add the backend package. The form waits for every configured backend to register, so row order is not a failure mode.
- `form-not-mounted` — a consumer reads `ctx.storage.domain` before `dsh-storage-domain` loads; mount the domain row before the consumer.
- `duplicate-backend` / `duplicate-mount` — the same name or form registers twice; that is a composition bug and fails loud.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The hub is a pure registration table with two faces, designed so backends and data forms stay replaceable without the hub knowing their internals.

### Design concept

- **Backends own media, data forms own semantics.** The hub never performs IO; it only holds the name → backend table and the form-name → facility map. Backend packages register their medium owner, data-form packages mount their facility, and neither needs the other's details.
- **Multiple backends stay side by side.** Which backend serves which consumer is the consumer's configuration (the domain form's route table), never a hub-global either-or.
- **Registration and mounting are effects.** `register()` and `mount()` return disposers; disposal removes only that registration's contribution, and does not close the backend — the owning plugin closes it after unregistering.
- **Activation cannot race registration.** Each backend plugin also publishes a lifecycle-only service key (`storage.backend.<name>`); form providers inject those keys, so the domain form activates only after every configured backend registers, while callers still resolve backends by name through the hub.

### The backend contract

[`src/backend.ts`](src/backend.ts) is the normative contract for backend implementers, checked clause by clause by the shared conformance suite in `tests/contract.ts`. A backend owns exactly one medium and exposes optional data-shape facets; `kv` is the only facet, and opening a unit yields a versioned, globally-singleton schema handle whose single calls are atomic and durable once resolved. Unit and table names must match `UNIT_NAME_RE`; record keys are arbitrary strings that never reach file paths. The unit does not serialize concurrent writes — ordering belongs to the caller — and a stored version differing from the descriptor rejects `version-mismatch` (no migration).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Storage` service, form mounting, `StorageForms` map |
| [`src/registry.ts`](src/registry.ts) | `BackendRegistry`: name → backend table, registration disposers |
| [`src/backend.ts`](src/backend.ts) | The backend contract: facets, units, `UNIT_NAME_RE` |
| [`src/error.ts`](src/error.ts) | `StorageError` codes shared by the hub and every backend |
| — | No runtime invariant companion is published; the hub is a pure registration table (names → backends, forms → facilities) whose consistency is fully enforced at the call sites (duplicate/missing entries fail loud synchronously); it owns no event stream or mutable medium to cross-check. |
| [`tests/contract.ts`](tests/contract.ts) | The shared conformance suite run against each backend |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the hub's view is not enough: the subsystem reference is the authoritative contract, and the Agent Note records the family design and its deferred work.

- [Storage subsystem](../../../docs/subsystems/storage.md) — the backend contract, domain semantics, change events, and generated API.
- [Storage package map](../README.md) — the family's packages and their repository position.
- [domain KV storage Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md) — the design behind the hub, the domain form, and the session-backend migration.

-----

<a id="model-experience"></a>
## Model Experience

### Backend and form registrations

#### What the model sees

Nothing. `ctx.storage` is a host-side registration table: the hub registers no tools, injects no prompts, and writes no session events, so no request field ever carries this package's data.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: the hub never touches a request prefix, so it cannot invalidate provider cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the hub cannot do. They are current package constraints, not a task backlog.

- **`kv` is the only data shape** — a backend implements one facet; the `log` facet for session event logs is deferred to the session-backend migration ([Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md)).
- **Forms resolve lazily** — reading `ctx.storage.domain` before the domain plugin mounts throws `form-not-mounted`; assemblies order plugins accordingly rather than silently deferring.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
