---
description: "The ctx.fs filesystem service contract for deployments choosing or mounting a filesystem backend and developers implementing one."
kind: "package-reference"
---

# @deepseek-ai/dsh-fs

English | [中文](README.zh.md)

## Summary

`dsh-fs` defines the `ctx.fs` filesystem service: a compact, backend-neutral contract for one execution world that resolves paths to stable identities, maps shared host files when supported, reads text and raw bytes within bounds, lists directories, and applies atomic writes and literal edits. It deliberately leaves storage mechanics to the backends that implement it — `fs-local` for the host filesystem, `fs-sandbox` for policy-enforced confinement, and `fs-e2b` for a remote execution world. Both mutations take an optional version guard, so a backend mounted without the policy plugin still gives complete, unconstrained, atomic file operations. The package also owns the `fs/*` policy-event vocabulary that the tool package dispatches and the policy plugin decides. Choose it when you need a swappable filesystem surface; the model-facing tools themselves live in `dsh-tool-fs`.

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

Pick [`fs-local`](../fs-local/README.md) for ordinary host files, [`fs-sandbox`](../fs-sandbox/README.md) when a session's mutations must be confined to its workspace and temp roots, and [`fs-e2b`](../../e2b/fs-e2b/README.md) when file state must live in a remote execution world. Mounting any backend populates `ctx.fs`; swapping backends changes nothing for the policy plugin, the tools, or the tool schemas. A composition that mounts no backend has no `ctx.fs` at all, and the tools fail at registration.

### What the service lets you do

Through `ctx.fs` you can resolve any path to a stable target identity, read a whole text file or stream it in chunks, read raw bytes up to an explicit cap, list one directory level, atomically create or replace a file, and apply a literal text edit atomically. The version guard on both mutations is optional: omit it for unconditional create-or-overwrite, or supply it to fail when the file changed since you last observed it. Every operation returns data or a typed `FsError` carrying a stable code such as `FS_NOT_FOUND`, `FS_STALE_VERSION`, or `FS_AMBIGUOUS_EDIT`, so callers branch on the code, never on message text.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the contract and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The contract is built on one separation and three commitments:

- **Contract over mechanism.** The service names what a storage layer can do — resolve, stat, read, list, write, edit — and never how it stores bytes. Backends own target identity, execution-world coordinates, decoding, binary rejection, and atomicity.
- **Policy stays off the base class.** Observed-state, read-before-edit, and version-guarded mutations are a plugin's job (`dsh-fs-observation-policy`), added by supplying the optional guard — so a sandboxed or remote backend inherits no model-facing observation policy.
- **`editText` stays on the seam.** Version check, literal match, and atomic rewrite share one critical section, so error attribution and one-wins/one-stale concurrency stay correct; a remote backend may implement it as a native compare-and-edit.
- **Bounds live at this seam.** `readBytes` requires `maxBytes` and fails with `FS_TOO_LARGE` rather than truncating, so no backend ever buffers an unbounded file.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service definition: the abstract `FileSystem` class, the `ctx.fs` declaration, and the `fs/*` event vocabulary |
| [`src/types.ts`](src/types.ts) | Vocabulary: `FsTarget`/`FsTargetKey`, `FsVersion`, `FsObservation`, `FsWriteIntent`, `FsError` and its codes |

### How a call flows

Every ordinary operation starts with `resolve(path, { cwd })`, which produces a stable `FsTarget` (an opaque `targetKey` plus a `displayPath` for model/UI output); the same file reached through different paths yields the same key. `processPathFromHostPath(hostPath)` separately maps an absolute host file into this execution world when the backend shares or explicitly maps it, and otherwise returns `undefined`. Reads then go `stat` → `readText`/`streamText`/`readBytes`, listings go `listDir`, and mutations go through one per-target critical section: the optional guard is checked, the new content is applied, and the result is published atomically.

### The `fs/*` policy events

The package declares three events so the emitter (`dsh-tool-fs`) and the policy listener (`dsh-fs-observation-policy`) share a vocabulary without the emitter depending on the policy plugin. `fs/write-intent` and `fs/edit-intent` are single-slot decision waterfalls: the first listener decides outright and never calls `next()`. `fs/observed` is a fire-and-forget recording event carrying an `FsObservation` — present with a version, or confirmed absent. The events carry only `dsh-fs` vocabulary plus an opaque `object` actor.

### Invariants

- `targetKey` and `version` are branded opaque ids: consumers must not parse or interpret them; only `displayPath` is for model/UI output.
- Failures are typed `FsError`s with stable codes, never ad-hoc message strings.
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

- **Text-only mutations by contract** — text reads and both mutations reject binary or non-UTF-8 content with `FS_NOT_TEXT`; `readBytes` is the single raw-byte primitive, and binary-safe mutations remain deferred.
- **Thirteen primitives only** — no delete, rename, copy, or watch; `listDir` lists a single level, with recursion, globbing, pagination, and search out of scope ([directory-listing note](../../../.agents/notes/archived/architecture/2026-07-03-filesystem-directory-listing-seam.md)).
- **No I/O deadline** — the seam arms no timeout; cancellation is a best-effort optional `AbortSignal` per primitive ([fs family stance](../README.md)).
- **Resolve-then-operate costs a remote backend two round-trips per tool call** — folding or caching resolution is left to such a backend.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
