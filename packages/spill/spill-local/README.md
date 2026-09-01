---
description: "The local filesystem spill backend: how spilled tool output is saved to private session-scoped files and retrieved with read or grep."
kind: "package-reference"
---

# @deepseek-ai/dsh-spill-local

English | [中文](README.zh.md)

## Summary

`dsh-spill-local` saves a tool's oversized text to a private, session-scoped file on the host filesystem and returns that file's path as the locator, with retrieval guidance telling the model to read or grep it. Mount it whenever a composition needs spill storage on the same machine the agent runs on. Files are private to the current user, names are unpredictable, and each session's files group under a stable directory, so a shared root cannot leak output or be redirected by a planted symlink. Configuration selects the root and the startup-cleanup retention period; previews and spill decisions live in other packages.

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

Mount this backend in a composition that spills tool output to the local filesystem. It registers as the `ctx.spillStore` service that the `dsh-spill-policy` plugin and other callers use.

### Minimal configuration

Loading the plugin with no config is safe: files land in a lazily-created private (0700) per-process directory under the OS temp directory. Set `root` when the files must live under a known location.

```yaml
- name: '@deepseek-ai/dsh-spill-local'
  config:
    root: /absolute/path/to/spill
    cleanupPeriodDays: 30
```

| Field | Default | Meaning |
|---|---|---|
| `root` | private 0700 temp dir | Root directory for spill files; set to keep them under a known location |
| `cleanupPeriodDays` | `30` | File age in days before the one-shot startup cleanup may delete it; `0` disables cleanup |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-spill-local) is the exhaustive source for every accepted field.

### What you get back

Each `saveText` call writes the full text to a fresh file and returns three fields: `locator` (the file path), `bytes` (the exact UTF-8 byte count), and `retrievalHint` — "Use read with offset/limit, or grep this path to search within it." A consumer shows that hint to the model, which can then read or search the file with its ordinary file tools.

### Where files land

Files are stored at `<root>/session-<hash>/<random>-<safeName>`, where `session-<hash>` is a short hash of the owning session id (so one session's files group together) and `<random>-<safeName>` pairs an unpredictable hex prefix with the caller's suggested name sanitized to one safe path segment. A relative `root` resolves from the process working directory.

### Startup cleanup

One best-effort sweep starts after activation without delaying service availability. It scans the configured root and prior default `dsh-spill-*` roots under the OS temp directory, deletes regular files whose modification time is strictly older than the configured cutoff, prunes empty session directories, and removes only empty prior-default roots. A long-lived process does not sweep again until restart. Disposal waits for the sweep, and a concurrent write recreates a session directory if cleanup removes it.

The sweep resolves filesystem identities, never follows or deletes symlinks, and skips unrelated entries. On POSIX it admits only roots and session directories owned by the current user, not writable by group or others, and protected from replacement through their ancestor path; writable sticky temporary directories such as `/tmp` are permitted. Unsafe paths produce a warning and remain untouched. Filesystem and warning-sink failures are contained, so cleanup cannot fail activation or a concurrent spill write.

### Failures and recovery

A real storage failure — permissions, no space left, an unwritable root — rejects the `saveText` call; the caller decides how to degrade. The shipped policy treats the rejection as best-effort and keeps the original inline result.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the backend; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The backend owns storage details only, on one principle: **a spilled tool result must be private and unredirectable**. The root is private (0700), the session directory is a stable hash, the leaf name is unpredictable, and the write is exclusive and owner-only. The storage mechanics live in a Cordis-free module so they are unit-testable without a context.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, the `LocalSpillStore` service, cleanup lifecycle, locator and retrieval-hint assembly |
| [`src/cleanup.ts`](src/cleanup.ts) | One-shot age sweep, filesystem-identity checks, symlink and ownership safeguards |
| [`src/store.ts`](src/store.ts) | Cordis-free storage mechanics: private root, session directory, safe-name encoding, exclusive write |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### File naming and write

`suggestedName` is untrusted input, so `encodeSegment` escapes every character outside `[A-Za-z0-9._-]` (and `~` itself) into a `~XXXX` form, making the mapping injective over all JS strings: separators, `../`, NUL, and absolute paths can never escape one segment, and the whole-segment tokens `.`/`..` are escaped too. The write is `open(path, 'wx', 0o600)` — it fails on any existing path, symlink or not, so a pre-planted target cannot redirect it. Two saves of the same suggested name get distinct random prefixes.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Spill storage service](../spill/README.md) — the `saveText` contract and vocabulary this backend implements.
- [Spill package map](../README.md) — the three-package family and each role.
- [dsh-spill-policy](../spill-policy/README.md) — the policy that calls this backend when a result is too large.
- [Spill subsystem](../../../docs/subsystems/spill.md) — the exhaustive vocabulary and ownership.
- [Tool output spill decision](../../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.md) — the capability boundary and design rationale.
- [Local spill startup cleanup](../../../.agents/notes/implemented/architecture/2026-07-17-local-spill-startup-cleanup.md) — retention, race handling, and safe deletion rules.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through spill consumers, which render the saved file path and read/grep retrieval guidance to the model.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the local backend is a poor fit or needs operational care. They are current package constraints.

- **A long-lived deployment is not swept until restart** — the one-shot sweep runs only after activation, so files that cross the age cutoff during a run are reclaimed on the next start.
- **Locators require a co-located filesystem consumer** — a remote or virtual deployment needs another `SpillStore` backend whose locator and retrieval hint are meaningful there.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open directions. It is explicitly non-authoritative.

#### Future: workspace-confinement interplay

The retrieval model assumes the model's `read`/`grep` tools can inspect the returned path even when the spill directory is outside the session working directory. A future workspace-confinement policy must either allow local spill paths explicitly or use a non-file spill backend.

</details>
