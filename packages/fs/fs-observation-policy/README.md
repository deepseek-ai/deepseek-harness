---
description: "The read-before-edit filesystem policy plugin for deployments and maintainers choosing or debugging guarded write and edit behavior."
kind: "package-reference"
---

# @deepseek-ai/dsh-fs-observation-policy

English | [中文](README.zh.md)

## Summary

`dsh-fs-observation-policy` adds the read-before-edit policy to the `ctx.fs` filesystem contract ([`dsh-fs`](../fs/README.md)): it records which files the calling session has observed, and guards every write and edit with that record — an unseen file can only be created, an observed file can only be replaced at the version last seen, and editing requires a prior read. It participates through the `fs/*` events only, so it registers no service and has no public methods; removing it leaves the bare provider's unconditional mutation behavior instead of breaking the tools. Loading it alongside a backend (`fs-local`, `fs-sandbox`) and the tools (`tool-fs`) makes model file edits fail with a clear remedy until the file has been read. Choose it for deployments that want agents to read before they mutate files.

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

Load this plugin alongside a `ctx.fs` backend and the `dsh-tool-fs` tools when a deployment wants the model to read a file before it can overwrite or edit it. The plugin needs no configuration and injects no service; it only listens for the `fs/*` events the tools dispatch.

### Minimal composition

Load a backend, then this plugin, then the tools. The policy listener should be the first decider registered for the `fs/*`-intent slots.

```yaml
- name: '@deepseek-ai/dsh-fs-local'
- name: '@deepseek-ai/dsh-fs-observation-policy'
- name: '@deepseek-ai/dsh-tool-fs'
```

### What changes for the model

With the policy mounted, `write` creates new files but refuses to overwrite an existing file that the session has not read, `edit` requires a prior read of the target, and a file that changed since it was read fails with `FS_STALE_VERSION`. Absence is recorded too: reading a missing file marks it confirmed absent, so a later `write` may recreate it through the guarded-create flow. A session resumes with no observed state, so it must re-read files before guarded mutations succeed again.

### Failures and recovery

An edit without a prior observation fails with code `FS_NOT_OBSERVED` and policy reason `edit requires reading "<path>" first`; editing a target observed absent fails with `FS_NOT_FOUND`. The tools normalize unread policy and provider failures to `cannot modify "<path>": file has not been read — read the file, then retry` while preserving the code and original cause. Following the remedy on an externally deleted file records absence, so the next guarded write can recreate it without clobbering a concurrent creator.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the policy plugin and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The plugin is built on two ideas:

- **Event gate, not method service.** The plugin influences the world only through the `fs/*` events, so it registers no `ctx.fsPolicy` service and has no public methods. Removing it cannot break `dsh-tool-fs` at a service-injection boundary — the tool falls through to the bare provider.
- **Observed state is a prior-observation record.** A weak owner-to-target map holds three logical states — unseen, confirmed absent, or present at a version. The plugin performs no filesystem I/O of its own; it converts recorded state into the provider's optional guard, and the provider performs the atomic freshness check.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The three `fs/*` listeners and the observed-state gate |
| [`src/types.ts`](src/types.ts) | The opaque event actor shape from which the owner session is derived |

### Decision flow

`fs/write-intent` resolves unseen or confirmed absent to `{ kind: 'createIfAbsent' }` and observed present to `{ kind: 'replaceIfVersion', version: vObserved }`. `fs/edit-intent` rejects an unseen target with `FS_NOT_OBSERVED`, a confirmed-absent target with `FS_NOT_FOUND`, and otherwise supplies the observed version as the compare-and-swap basis. `fs/observed` records `{ kind: 'present', version }` or `{ kind: 'absent' }` for the owner and target — a synchronous, side-effect-only `WeakMap.set`, because successful mutations have already committed.

### Single-slot, first-wins

Each intent slot holds exactly one decider: this plugin fully decides and never calls `next()`. The slot is first-wins by registration order — this plugin owning it is the default-deployment convention, not an event-enforced invariant. Layered permission, audit, or sandbox interception belongs on the `tools/execute` waterfall instead.

### Lifecycle

Observed state is dropped on plugin disposal (HMR safety) and is never persisted across sessions — a resumed session starts with no observations.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the policy to the contract, tools, and backends it composes with.

- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — exhaustive provider contract, policy events, and error taxonomy.
- [dsh-fs](../fs/README.md) — the `ctx.fs` contract and the `fs/*` event vocabulary.
- [tool-fs](../tool-fs/README.md) — the model-facing tools that dispatch the `fs/*` events.
- [fs-local](../fs-local/README.md) — the host-filesystem backend this policy guards.
- [fs-sandbox](../fs-sandbox/README.md) — the sandbox-enforcing backend this policy composes with.
- [Fsspec-style seam-split note](../../../.agents/notes/implemented/simplification/2026-06-26-fsspec-style-fs-seam.md) — why the policy is an event plugin rather than a provider method.

-----

<a id="model-experience"></a>
## Model Experience

### Filesystem tool outcome

#### What the model sees

This plugin adds no prompt or schema. It rejects an edit without a prior observation with code `FS_NOT_OBSERVED` and policy reason `edit requires reading "<path>" first`; editing a target observed absent returns `FS_NOT_FOUND`. Guarded mutations whose positive observation is stale propagate the provider-owned `FS_STALE_VERSION` error. [`dsh-tool-fs`](../tool-fs/README.md) owns the model-facing error wrapper: it normalizes every `FS_NOT_OBSERVED` source to `cannot modify "<path>": file has not been read — read the file, then retry`, while `FS_STALE_VERSION` retains the provider reason and adds `— re-read the file, then retry`; both preserve the code and original cause. Following the stale remedy on an externally deleted target records absence: the next guarded write may recreate it with `createIfAbsent`, while the provider atomically preserves any concurrent creator.

#### Token effect

Zero tokens on allowed operations beyond the ordinary tool result. A denial adds the small retained error result and avoids any success payload.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the policy is a poor fit or needs special operational care. They are current package constraints, not a general filesystem comparison or a task backlog.

- **Observed state does not survive a session resume** — persistence of the record is deferred, so a resumed session must re-read files before guarded writes and edits.
- **Actors without an agent session can never satisfy the policy** — their edits throw `FS_NOT_OBSERVED` and their writes always resolve `createIfAbsent`, so a non-agent caller cannot overwrite an existing file through the gate.
- **Direct `ctx.fs` reads emit no `fs/observed`** — a file read outside the `read` tool stays unobserved, and a later guarded edit rejects with `FS_NOT_OBSERVED` until the tool reads it.
- **Authorization is version freshness, not view completeness** — any windowed read authorizes a full-file overwrite of an unchanged file, deliberately weaker than a full-view rule ([seam-split note](../../../.agents/notes/implemented/simplification/2026-06-26-fsspec-style-fs-seam.md)).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam.
