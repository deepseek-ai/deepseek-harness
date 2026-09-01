---
description: "The host-filesystem backend for ctx.fs for deployments and maintainers choosing or debugging local file access."
kind: "package-reference"
---

# @deepseek-ai/dsh-fs-local

English | [中文](README.zh.md)

## Summary

`dsh-fs-local` implements the `ctx.fs` filesystem contract ([`dsh-fs`](../fs/README.md)) on the host filesystem: loading it as a plugin populates `ctx.fs` with real file access — resolve, read, list, atomic write, and literal edit against the local machine's files. Relative paths resolve from a configurable base directory, and the same file reached through different paths or symlinks shares one identity. Because this backend shares the host filesystem, it can also map an absolute host path into the process path used by this execution world. Writes are atomic and preserve file permissions; the optional version guard makes stale overwrites fail instead of clobbering. Choose it when a process needs direct, unconfined access to host files; choose `fs-sandbox` when mutations must be confined, or `fs-e2b` when file state belongs in a remote execution world.

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

Mount this backend when a composition needs `ctx.fs` backed by the real host filesystem and accepts a process-local implementation. The common path is explicit: load the backend, give it a base directory, and the model-facing tools (`dsh-tool-fs`) or your own plugins can read, write, and edit files.

### When to choose it

Choose `fs-local` for ordinary host-file access in a single process. Choose [`fs-sandbox`](../fs-sandbox/README.md) when a session's writes and edits must be confined to its workspace and temp roots — it extends this backend and adds only the mode fence. Choose [`fs-e2b`](../../e2b/fs-e2b/README.md) when files must live in a remote execution world shared with subprocesses. `config.cwd` is a resolution default, not a containment boundary: absolute paths and `..` escape it.

### Minimal configuration

Load the backend with a base directory; relative paths resolve against it, and absolute paths ignore it.

```yaml
- name: '@deepseek-ai/dsh-fs-local'
  config:
    cwd: /absolute/path/to/workspace
```

| Field | Default | Meaning |
|---|---|---|
| `cwd` | `process.cwd()` | Base directory for relative paths |
| `diffBasisMaxBytes` | `10 MiB` | UTF-8 byte limit per overwrite-diff side; larger overwrites return `before: null` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-fs-local) is the exhaustive source for every accepted field and its JSDoc.

### What you can do

Read any regular UTF-8 text file whole or as a stream, read raw bytes up to a cap you choose, and list one directory level in stable name order. Create or replace a file atomically, and apply a literal text edit atomically; both mutations serialize per file, so concurrent writers never interleave. The version guard is optional: omit it for unconditional create-or-overwrite, or supply it to fail when the file changed since you last observed it.

Failures are typed `FsError`s with stable codes — `FS_NOT_FOUND`, `FS_NOT_TEXT` (binary content), `FS_STALE_VERSION` (changed since observation), `FS_EDIT_NOT_FOUND` or `FS_AMBIGUOUS_EDIT` (no unique literal match), and others — so callers branch on the code, never on message text. A missing target on a guarded edit reports `FS_STALE_VERSION` either way.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the local backend and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The backend builds on three ideas:

- **Realpath identity.** The `targetKey` is the file's `realpath`, so two input paths reaching the same file through symlinks share one identity, and writes land on the link target while preserving the link.
- **Atomic publication.** Writes stage into an exclusive temp file inside a private staging directory next to the target, fsync, then publish; an existing file's mode is preserved and Windows DACLs survive replacement.
- **One mutation critical section.** A per-target FIFO lock serializes read→guard→write windows, so concurrent writes and edits are deterministically ordered — one wins, the rest see the new version and reject as stale.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service wiring: `LocalFileSystem`, `Config`, per-target mutation lock |
| [`src/fsio.ts`](src/fsio.ts) | Cordis-free raw I/O: probe, reads, atomic write, literal edit, line-ending handling |
| [`src/win32.ts`](src/win32.ts) | Windows-specific DACL preservation for atomic replacement |

### Write path

Each write probes the target, enforces the optional guard (`createIfAbsent` or `replaceIfVersion`), captures a bounded `before` diff basis when both sides are small enough, stages the new content next to the target, fsyncs, and publishes atomically. Guarded creation uses a hard-link publication that never replaces a concurrent creator, rejecting it with `FS_NOT_OBSERVED` instead.

### Edit path

Each edit probes, verifies the version guard before literal matching (so stale edits report `FS_STALE_VERSION`, never a misleading no-match), reads the file, applies the literal replacement with LF normalization, restores the file's dominant line-ending style, and republishes — all inside the per-target lock.

### Ownership and invariants

Raw I/O is Cordis-free and independently unit-tested in `src/fsio.ts`; `src/index.ts` stays thin wiring. `config.cwd` is a resolution default only — containment is the job of `fs-sandbox` or a `tools/execute` permission plugin. Cancellation is a best-effort `AbortSignal` checked before and after each asynchronous probe.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the contract to the adjacent backends, tools, and policies.

- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — exhaustive provider contract, policy events, and error taxonomy.
- [dsh-fs](../fs/README.md) — the `ctx.fs` contract this backend implements.
- [fs-sandbox](../fs-sandbox/README.md) — the sandbox-enforcing backend that extends this one.
- [tool-fs](../tool-fs/README.md) — the model-facing tools that consume `ctx.fs`.
- [fs-observation-policy](../fs-observation-policy/README.md) — the policy plugin that guards mutations through the `fs/*` events.
- [Windows DACL preservation note](../../../.agents/notes/implemented/bug-fix/2026-07-19-windows-atomic-write-dacl-preservation.md) — why atomic replacement copies the target's access policy.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-fs`, which renders this provider's line-windowed UTF-8 content, mutation acknowledgements, and exact provider messages in capped retained results while versions, atomic-write mechanics, and directory metadata remain internal.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the local backend is a poor fit or needs special operational care. They are current package constraints, not a general filesystem comparison or a task backlog.

- **`config.cwd` is not a sandbox** — it is a resolution default, not containment: absolute paths and `..` escape it. Enforce containment with a stricter `ctx.fs` backend or a permission plugin on the `tools/execute` waterfall ([capability-seam note](../../../.agents/notes/implemented/architecture/2026-06-17-filesystem-capability-seam.md)).
- **Version tokens depend on filesystem metadata** — they combine device, inode, size, nanosecond mtime, and nanosecond ctime; a storage layer that cannot update any of those facts for a rewrite can still defeat the stale guard.
- **`editText` holds the whole file (plus the edited copy) in memory** — streaming exists only on the read path.
- **A sub-limit overwrite still buffers a contextual basis** — `writeText` may retain up to just below `config.diffBasisMaxBytes` of prior text in addition to the caller-owned replacement; the bound does not cap the returned `after` value or the whole-file presentation fallback.
- **Binary detection is asymmetric** — reads NUL-sample only the first 8192 bytes while edits scan the whole buffer, so a file with a late NUL reads fine but rejects edits.
- **The per-target mutation lock is in-process only** — guarded creation still uses an atomic no-replace publication across processes, but replacement writers in another process are caught only when the optional version guard observes their metadata change; they are never serialized.
- **Guarded creation requires hard-link support** — filesystems or mounts that reject hard-link publication cannot serve `createIfAbsent`; the backend preserves the missing target and reports `FS_IO_ERROR`.
- **Post-commit cleanup is best effort** — a successful publication remains successful if removal of its owner-only staging directory fails, leaving private residue for later operator cleanup.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam.
