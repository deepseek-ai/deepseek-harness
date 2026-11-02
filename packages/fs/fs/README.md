---
description: "The ctx.fs filesystem service contract for deployments choosing or mounting a filesystem backend and developers implementing one."
kind: "package-reference"
---

# @deepseek-ai/dsh-fs

English | [中文](README.zh.md)

## Summary

Use `dsh-fs` for consistent file access across local, confined, and SSH execution environments. Consumers can resolve stable identities, read text or bounded bytes, list directories, watch targets, write files, apply literal edits or patch hunks, delete files, and move text files with optional patching. Optional version guards reject stale mutations. Moves report destination publication separately from source removal. Mount a provider for the chosen environment; `dsh-tool-fs` supplies model-facing tools separately.

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

You rarely load `dsh-fs` directly: you mount a backend that registers as `ctx.fs`, then either call the service from your own plugin or let the `dsh-tool-fs` tools call it for you. This page serves the two audiences that do touch it — deployments choosing a backend, and developers implementing or consuming the contract.

### Choosing and mounting a backend

Pick [`fs-local`](../fs-local/README.md) for ordinary host files or [`fs-sandbox`](../fs-sandbox/README.md) when a session's mutations must be confined to its workspace and temp roots. Mounting any backend populates `ctx.fs`; swapping backends changes nothing for the policy plugin, the tools, or the tool schemas. A composition that mounts no backend has no `ctx.fs` at all, and the tools fail at registration.

### What the service lets you do

Through `ctx.fs`, resolve paths, read text or bounded bytes, list direct children, and perform guarded mutations. `patchText` applies parsed hunks under the same lock as its version check. `deleteFile` removes a regular file. `moveFile` locks both targets, optionally patches the source text, publishes the destination, then removes the source. Guards are optional: omission mutates the current state unconditionally. Failures carry stable `FsError` codes from the runtime `FS_ERROR_CODES` list, which transport validators reuse.

`watch(target, changed, signal)` reports invalidations for one file or a directory's direct entries. It resolves once observation is ready with an asynchronous close function that the caller must await. The signal cancels initialization; unsupported providers reject without polling.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the contract and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The contract is built on one separation and three commitments:

- **Contract over mechanism.** The service names what a storage layer can do — resolve, stat, read, list, watch, write, edit, patch, delete, move — and never how it stores bytes. Backends own target identity, execution-world coordinates, decoding, binary rejection, and atomicity.
- **Policy stays off the base class.** Observed-state, read-before-edit, and version-guarded mutations are a plugin's job (`dsh-fs-observation-policy`), added by supplying the optional guard — so a sandboxed or remote backend inherits no model-facing observation policy.
- **`editText` stays on the seam.** Version check, literal match, and atomic rewrite share one critical section, so error attribution and one-wins/one-stale concurrency stay correct; a remote backend may implement it as a native compare-and-edit.
- **Bounds live at this seam.** `readBytes` requires `maxBytes` and fails with `FS_TOO_LARGE` rather than truncating, so no backend ever buffers an unbounded file. `readByteRange` is bounded by its window instead: a backend transfers at most the requested `length` beyond the prefix it skips, so the caller's cap on `length` is the guard.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service definition: the abstract `FileSystem` class, the `ctx.fs` declaration, and the `fs/*` event vocabulary |
| [`src/types.ts`](src/types.ts) | Vocabulary: `FsTarget`/`FsTargetKey`, `FsVersion`, `FsObservation`, `FsWriteIntent`, `FsError` and its codes |

### How a call flows

Every operation uses a target from `resolve(path, { cwd })`; aliases share an opaque identity. Cross-capability coordinates come from the provider. Single-file mutations own their version check and atomic publication. A move acquires both target locks in lexical order and releases them in reverse order; destination publication and source removal remain separate effects.

### The `fs/*` policy events

The package declares four events shared by consumers and observation policy. Intent waterfalls have one decision owner; observation recording is synchronous and carries an opaque actor. Callers dispatch the applicable intent before a mutation and record completed effects afterwards.

| Event | Use |
|---|---|
| `fs/write-intent` | Write and move destination guards. |
| `fs/edit-intent` | Literal edit, patch, and move source guards. |
| `fs/delete-intent` | Delete source guard. |
| `fs/observed` | Patch/write: present with version; delete: absent; move: destination present and source absent only if removed. |

### Invariants

- `targetKey` and `version` are branded opaque ids: consumers must not parse or interpret them; only `displayPath` is for model/UI output.
- Read, listing, and mutation failures are typed `FsError`s with stable codes, never ad-hoc message strings; watch initialization may reject with an ordinary exception.
- The seam arms no I/O deadline; cancellation is an optional per-primitive `AbortSignal`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the exhaustive contract to the backends and consumers built on it.

- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — exhaustive provider contract, policy events, and error taxonomy.
- [fs-local](../fs-local/README.md) — the host-filesystem backend implementing this contract.
- [fs-sandbox](../fs-sandbox/README.md) — the sandbox-enforcing backend implementing this contract.
- [tool-fs](../tool-fs/README.md) — the model-facing tools that consume `ctx.fs`.
- [fs-observation-policy](../fs-observation-policy/README.md) — the policy plugin that guards mutations through the `fs/*` events.
- [Capability seams note](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md) — why the filesystem stack splits into contract, provider, policy, and tools.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-fs`, which renders provider text and errors as bounded, retained filesystem tool results.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the contract is a poor fit or needs special operational care. They are current package constraints, not a general filesystem comparison or a task backlog.

- Literal edits, patches, and moves require UTF-8 text; deletion also accepts binary regular files and returns `before: null` for them.
- Moves are two effects, not a transaction: `sourceDeleted: false` means the destination is published and the source remains.
- Resolved targets follow symlinks; callers that reject symlink sources use `lstat` before `resolve`. Copying and recursive directory operations are outside this API.
- **No I/O deadline** — the seam arms no timeout; cancellation is a best-effort optional `AbortSignal` per primitive ([fs family stance](../README.md)).
- **Resolve-then-operate costs a remote backend two round-trips per tool call** — folding or caching resolution is left to such a backend.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
