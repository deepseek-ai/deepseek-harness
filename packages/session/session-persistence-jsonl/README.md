---
description: "The shipped JSONL session-persistence backend for deployments and maintainers choosing, configuring, or debugging per-session durable logs with optional Zstandard compression."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-jsonl

English | [中文](README.zh.md)

## Summary

`dsh-session-persistence-jsonl` stores each session in its own append-only JSONL log — checksummed Zstandard frames by default, raw newline-delimited lines when compression is disabled. It serves the same logical `SessionEvent` stream as any persistence backend, so choosing it changes nothing for the agent loop, the model, or replay; compression, packing, and crash recovery are storage-internal details. Choose it when consumers need a per-session file on disk; the logs are readable as plain lines when `compression: 'none'` is selected. A root directory is the one required configuration; durability, lazy materialization, and torn-tail crash recovery come with the backend.

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

Mount this backend when a composition needs durable sessions backed by per-session files. The common path is explicit: load the session service, mount the backend, and give it a root directory.

### When to choose it

Choose this backend when consumers benefit from one artifact per session — navigation, external tooling, or a raw line-readable log. It is the sole first-party Session-persistence provider. The backend keeps sessions under a deployment-controlled root: project-local, shared, temporary, or centralized.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: /absolute/path/to/session-logs
```

`root` is required and has no default: a `process.cwd()` default would scatter session files as the process's cwd changes. An existing root must be a readable directory; an absent root is created on first materialization.

| Field | Default | Meaning |
|---|---|---|
| `root` | required | Root directory for all session files |
| `packChunks` | `true` | Write eligible `assistant/chunk` runs as packed rows; `false` keeps one event per line for diagnostics |
| `compression` | `'zstd'` | Physical encoding: `'zstd'` checksummed frames, or `'none'` newline-delimited UTF-8 text |

Live-event write batching is not configuration: the batching window is the seam's internal scheduling policy inside each write handle.

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-persistence-jsonl) is the exhaustive source for every accepted field and its JSDoc.

### On-disk layout

Each session gets a session-owned directory under a readable project directory; the first logical line is the private v0 physical header, followed by one storage record per logical event (or one packed chunk row per eligible run). Its optional numeric `seedLength` remains byte-compatible: absence decodes to `SessionHeader.isSeeded: false`, while zero or a positive value decodes to `isSeeded: true` plus the exact `inheritedEventCount`. Storage records use the lossless provenance representation described below:

```text
<root>/
  --<normalized-cwd>--/          # readable project directory (or _no-cwd/)
    <encoded-id>/                # session-owned directory
      session.jsonl.zstd         # default: checksummed header frame + append frames
      session.jsonl              # only with compression: 'none'
```

Session ids are injectively escaped to one safe path segment before use (no traversal, no collision). The normalized cwd keeps the project directory readable for navigation; cwd strings that normalize alike share a project directory while session ids still select distinct session directories. Format-refusal diagnostics name the absolute path of the fixed transcript inside the resolved directories, so an operator can find the raw log a build refused to interpret.

### Durability and crash semantics

A session is materialized lazily: `create(header)` writes nothing and returns the owned write handle, and the handle's first `append` writes and `fsync`s the encoded header and first batch through a no-overwrite publish — so a created-but-never-appended session leaves nothing on disk unless its owner calls `handle.flush()`, which publishes one header frame without an event. Each subsequent batch appends lines or one compressed frame and `fsync`s before the append resolves; a caught write or sync failure rolls the file back to its prior length. Committed events are never rewritten. After a crash, the stored log keeps its interrupted final turn — every record in the committed prefix survives, and the resuming reader appends synthetic closers through its write handle. A torn tail — an incomplete final line, or a torn final frame — is never returned to a reader and is discarded whole, truncated durably before the write handle's first new append, because its own append never resolved and nothing in it was acknowledged durable; checksum, decompression, or structural failure in the committed prefix rejects as corruption.

### Reading the logs

`open(id, 'read')` returns a handle whose `read(offset?, length?)` serves validated contiguous slices; the artifact is re-scanned on demand under a bounded stable read, so a slice never contains a torn tail. A torn final Zstandard frame is partially decoded: complete JSONL records already flushed into it are recovered into the logical log, and the write handle's first mutation truncates the torn bytes and durably rewrites the recovered records ahead of its own batch. `open(id, 'write')` primes the handle with the validated stored prefix, so resume's whole-log read costs no second parse before the first append. A bounded memo keyed by session id and the stat-derived revision lets an immediately following open reuse the parsed log — the cold observe-then-resume handoff parses once — and every local mutation invalidates its id. `stat(id)` and `list()` read only the header line and one `fs.stat`, carrying `sizeBytes` and a best-effort stat-derived revision (device, inode, size, nanosecond timestamps) without parsing the log. With `compression: 'none'`, the log is newline-delimited text an external reader can consume directly; the compressed default must be read through the backend.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the physical encoding and write path; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The backend owns its complete storage runtime (`src/storage.ts`): `JsonlSessionHandle` carries the per-handle mutation chain, the routed live-event buffer with its fixed batching window and single-flight drain, monotonic reads, and idempotent close; a tracker holds the in-process single-writer claims, the open-handle set teardown sweeps, and the created-but-unmaterialized pending sessions the backend's own session listeners route into. The package deliberately exposes only its default plugin export plus configuration types — the concrete class is not a named export, so consumers couple to `ctx.sessionPersistence`, and the shared seam suites (`runPersistenceContract`/`runLiveWritePathContract`) pin its observable behavior. Its change token is a best-effort file revision: device, inode, size, and nanosecond timestamps identify one log for `stat`/`list` and for the stable-read loop that retries a read torn by a concurrent append.

### Physical encoding

The default artifact is a standard concatenation of independent [Zstandard frames](../../../.agents/notes/implemented/architecture/2026-07-19-zstandard-jsonl-session-logs.md): one checksummed frame containing only the header line, then one checksummed frame per durable append batch, using Node's built-in Zstandard API at its default compression level (no level knob). `sourceEventSeqs` uses a lossless storage representation: consecutive runs of at least three sequence numbers become `[start, end]` pairs, any other list stays verbatim, and reading expands the exact in-memory array. Listing reads and validates only the header frame. `compression: 'none'` keeps the same storage-form logical lines without frame compression. A root belongs to one encoding: startup discovery and targeted lookup reject the opposite suffix, and there is no format or compression migration, mixed-root fallback, or dual write. When `packChunks` is enabled, an eligible run of ≥3 consecutive same-block `assistant/chunk` delta events becomes one packed row (`text-chunks`/`reasoning-chunks`/`tool-call-chunks`) whose `seq0`/`time0` and per-member `dt` gaps reconstruct every member exactly; the lossless codec lives in `dsh-session` and reading is layout-blind, so packed, unpacked, and mixed files load identically.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, the backend service class, and file storage primitives |
| [`src/storage.ts`](src/storage.ts) | The JSONL handle, routed live-event buffer, in-process writer bookkeeping, listeners, teardown |
| [`src/format.ts`](src/format.ts) | Log path derivation, header encoding, record scanning, packed-row layout |
| [`src/zstd.ts`](src/zstd.ts) | Zstandard frame compression, decoding, and frame scanning |
| [`src/win32.ts`](src/win32.ts) | Windows write-through publish and directory creation |
| — | No runtime invariant companion is published; persistence correctness requires backend round-trip and crash-tail tests; this package exposes no continuously observable in-process relation. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared persistence model to the sibling backend and the physical-format decisions.

- [Session persistence subsystem](../../../docs/subsystems/persistence.md) — backend-neutral service semantics and provider relationships.
- [Session persistence seam](../session-persistence/README.md) — the service contract this backend implements.
- [Project-session directory decision](../../../.agents/notes/implemented/architecture/2026-07-24-project-session-directories.md) — the layout tradeoff behind project and session directories.
- [Zstandard JSONL session logs](../../../.agents/notes/implemented/architecture/2026-07-19-zstandard-jsonl-session-logs.md) — the checksummed-frame encoding rationale.

-----

<a id="model-experience"></a>
## Model Experience

### Resumed conversation history

#### What the model sees

JSONL storage contributes no live prompt or schema. Loading restores stored surface history and preserves prior request headers for reconstruction; the new loop composes its current envelope. Recovery balances an assistant request without a durable call with `TOOL_NOT_STARTED`; a durable call without a result becomes `TOOL_OUTCOME_UNKNOWN`, which tells the model to retry only read-only or idempotent work and to verify possible side effects or ask the user. Raw `assistant/chunk` records do not duplicate messages.

#### Token effect

Zero live-request tokens. A resumed agent pays for retained history and its current envelope, plus the quoted repair result for each interrupted call.

#### KV Cache effect

JSONL storage does not mutate live request prefixes. A resumed loop can reuse provider cache only when its reconstructed history, current envelope, and model route match; crash-repair results append.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this backend is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Only the configured encoding and current `SESSION_FORMAT_VERSION` (v0) load** — changing compression requires a separate or fresh root, or selecting raw mode; the pre-release format has no migration.
- **The flat-file storage layout does not load** — use a separate root or move pre-release artifacts into the project/session directory layout before loading.
- **Compressed files are not directly line-readable** — use the backend to load them, or select `compression: 'none'` before writing a fresh root when external line readers are required.
- **Nothing deletes session files** — logs accumulate under `root` until removed externally; the seam has no deletion API.
- **One live writer per session, in-process only** — the write-handle claim excludes a second writer inside the owning backend instance; another instance or process must not write the same session until that handle closes (the durable cross-process lease is the seam's planned next layer).
- **POSIX materialization requires hard-link support** — first append uses `link()` so same-id races fail instead of overwriting a committed log; Windows uses write-through rename without replacement.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
