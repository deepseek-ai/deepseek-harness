---
description: "The spill storage service: save oversized tool text or captured session references and return a retrievable locator."
kind: "package-reference"
---

# @deepseek-ai/dsh-spill

English | [中文](README.zh.md)

## Summary

`dsh-spill` lets any plugin or tool save oversized text through `ctx.spillStore` and receive an opaque locator, the exact byte count, and retrieval guidance the model can act on. It defines what a spill backend does, not how it stores — a deployment mounts a backend such as `dsh-spill-local` for real persistence, and the `dsh-spill-policy` plugin decides when a tool result is too large. Choose it when a deployment must keep oversized text retrievable without flooding the model's context. The service owns storage only: no retention policy, no tool-result replacement, and no retrieval or search API. A real storage failure rejects loudly, so the caller decides how to degrade.

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

A composition that saves spill artifacts mounts one backend — this package alone stores nothing. `dsh-spill-policy` decides when tool results spill; `dsh-session-reference` directly saves truncated reference transcripts without requiring that policy. Callers use `ctx.spillStore.saveText()` with an explicit owner; optional consumers discover the backend with `ctx.get("spillStore")`.

### When to choose it

Choose spill storage when a deployment needs to keep full text retrievable after the model sees a bounded preview, such as a fetched page body or a captured session-reference transcript. A backend whose locator and retrieval hint are usable in the deployment is a prerequisite; local filesystem access is not a service requirement.

### Smallest working composition

Mount a backend and the policy together; with `maxInlineBytes` set, any oversized plain-text tool result becomes a preview plus a locator automatically.

```yaml
- name: '@deepseek-ai/dsh-spill-local'
- name: '@deepseek-ai/dsh-spill-policy'
  config:
    maxInlineBytes: 50000
```

### Saving text

With a backend mounted, call `ctx.spillStore.saveText()` with the owning session, a source description, a suggested file name, and the full text:

```text
const ref = await ctx.spillStore.saveText({
  owner: { sessionId: 'session-1' },
  source: { kind: 'tool', toolName: 'web_fetch', callId: 'call-1', label: 'result' },
  suggestedName: 'web_fetch.txt',
  content: fullText,
})
```

The returned `SpillRef` carries three fields: `locator`, an opaque model-facing handle the backend produces (a local file path for `dsh-spill-local`, possibly a URI or key for another backend); `bytes`, the exact UTF-8 byte count written; and `retrievalHint`, the guidance a consumer shows the model — for the local backend, read or grep the path. Consumers render the locator with the hint and never parse the locator itself.

### Ownership and boundaries

Storage is grouped by the owning session: forked sessions inherit existing locators from the seeded log without copying or re-owning them, and new spills after a fork use the child session id. A session-reference artifact belongs to the target session receiving the context, not the referenced source session. `suggestedName` is only a hint — backends sanitize it to one safe segment and never trust it as a path. Consumers own preview and spill decisions; the backend owns storage and artifact expiry.

### Failures and recovery

`saveText` rejects only on a real storage failure — permissions, no space left, or a backend that is down. The caller decides how to degrade: the shipped policy treats a rejection as best-effort, logs a warning, and keeps the original inline result, so a spill failure never turns a successful tool call into an error or hides content. If no backend is mounted, there is nothing to save; load `dsh-spill-local` or another backend in the composition.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the service; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The package is built on one separation and a deliberate minimum:

- **Contract, implementation, and policy stay separate.** This package defines what a backend does (`saveText`); `dsh-spill-local` implements it; `dsh-spill-policy` decides when. Each concern evolves and swaps independently.
- **One method, nothing else.** The seam owns no retention policy, no result replacement, and no retrieval or search API — those have owning packages.
- **Reject, never silently degrade at the seam.** The caller owns degradation; the seam reports real storage failures.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the abstract `SpillStore` service and its `saveText` contract |
| [`src/types.ts`](src/types.ts) | Vocabulary: `SaveTextSpill`, `SpillRef`, branded `SpillLocator`, `SpillOwner`, `SpillSource` |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Data model

`SaveTextSpill` separates storage ownership from descriptive provenance. `SpillSource` accepts either the tool source `{ kind: "tool", toolName, callId, label }` or `{ kind: "session-reference", sessionId, label }`, whose id names the captured source session. Session references never fabricate tool call ids. Neither provenance nor the owner namespace grants read access. Consumers treat the returned locator as opaque and present it with its retrieval hint.

### Lifecycle

A backend subclasses `SpillStore` and loads as a plugin, registering as `ctx.spillStore`; one implementation per context, and a second load fails. Disposal releases the service. The abstract class itself registers nothing — this package contributes the contract and vocabulary only.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the shipped backend, the policy, and the design rationale.

- [Spill subsystem](../../../docs/subsystems/spill.md) — the exhaustive vocabulary, ownership, and backend relationships.
- [Spill package map](../README.md) — the three-package family and each role.
- [dsh-spill-local](../spill-local/README.md) — the shipped local filesystem backend.
- [dsh-spill-policy](../spill-policy/README.md) — the policy that decides when a final result is too large.
- [dsh-output-retention](../../util/output-retention/README.md) — the preview mechanics behind the policy.
- [Tool output spill decision](../../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.md) — the capability boundary and design rationale.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through spill consumers, which render the backend's locator and retrieval guidance to the model.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the spill storage service is incomplete on its own. They are current package constraints.

- **No retrieval or deletion API** — consumers can only render the backend's locator and guidance; lifecycle and access semantics remain backend-specific.
- **Storage is not access control** — the owner session namespaces writes but does not authorize reads of a locator; each backend and retrieval consumer must enforce its own boundary.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: undecided directions and open questions. It is explicitly non-authoritative.

#### Future: executor spill-file integration

The seam has only `saveText`; a save-file or link/copy path for existing executor spill files (for example normalizing bash temp files) and tool-owned spill for subagent rollouts remain deferred, per the [tool output spill decision](../../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.md).

#### Future: non-local backends and cleanup

Remote or database backends remain open. The local backend applies its [startup-cleanup policy](../spill-local/README.md#startup-cleanup); the service defines no per-session cleanup or locator-refresh API.

</details>
