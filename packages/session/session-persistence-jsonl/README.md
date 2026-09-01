---
description: "The shipped JSONL session-persistence backend for deployments and maintainers choosing, configuring, or debugging per-session durable logs with optional Zstandard compression."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-jsonl

English | [中文](README.zh.md)

## Summary

`dsh-session-persistence-jsonl` stores each session in its own append-only JSONL log — checksummed Zstandard frames by default, raw newline-delimited lines when compression is disabled. It serves the same logical `SessionEvent` stream as any persistence backend, so choosing it changes nothing for the agent loop, the model, or replay; compression, packing, and crash recovery are storage-internal details. Choose it when consumers need a per-session artifact on disk: `locate(meta)` returns the transcript path, and the logs are readable as plain lines when `compression: 'none'` is selected. A root directory is the one required configuration; durability, lazy materialization, and interrupted-turn recovery come with the backend.

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
| `preparedSessionCacheSize` | `5` | Cold session preparations retained for resume reuse |
| `writeBatchMaxDelayMs` | `200` | Fixed live-event coalescing window, in milliseconds |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-persistence-jsonl) is the exhaustive source for every accepted field and its JSDoc.

### On-disk layout

Each session gets a session-owned directory under a readable project directory; the first logical line of the log is the immutable `SessionHeader`, followed by one storage record per logical event (or one packed chunk row per eligible run). Storage records use the lossless provenance representation described below:

```text
<root>/
  --<normalized-cwd>--/          # readable project directory (or _no-cwd/)
    <encoded-id>/                # session-owned directory
      session.jsonl.zstd         # default: checksummed header frame + append frames
      session.jsonl              # only with compression: 'none'
```

Session ids are injectively escaped to one safe path segment before use (no traversal, no collision). The normalized cwd keeps the project directory readable for navigation; cwd strings that normalize alike share a project directory while session ids still select distinct session directories. `locate(meta)` returns `{ kind: 'jsonl', path }` for the fixed transcript inside the resolved directories, performing no filesystem I/O.

### Durability and crash semantics

A session is materialized lazily: `create(meta)` writes nothing, and the first `append` writes and `fsync`s the encoded header and first batch through a no-overwrite publish — so a created-but-never-appended session leaves nothing on disk unless a lifecycle consumer calls `ensureMaterialized`, which publishes one header frame without an event. Flushed events are never rewritten; each subsequent batch appends lines or one compressed frame, and a caught write or sync failure rolls the file back to its prior length. After a crash, `load` preserves an interrupted final turn: it keeps the complete decoded records of an incomplete last frame, truncates from that frame's start, and re-encodes the records with the synthetic tool, step, and turn closers required by the shared persistence contract. Only a never-fully-written torn tail is discarded; checksum, decompression, or structural failure in the committed prefix rejects as corruption.

### Reading the logs

`inspect(id)` returns an immutable balanced view without committing recovery. `readFrom(id, fromSeq)` returns stored events at or past a sequence number for watermark consumers; sequential media like JSONL parse the whole artifact and skip forward. With `compression: 'none'`, the log is newline-delimited text an external reader can consume directly; the compressed default must be read through the backend.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the physical encoding and write path; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The backend is a thin storage layer over the shared [PersistenceCoordinator](../session-persistence/README.md#understand-the-implementation): it loads stored records, appends batches, commits repairs, and delegates lifecycle orchestration to the coordinator. Its physical identity is a file revision: device, inode, size, and nanosecond timestamps identify one log and change after append or repair, which is what `listSnapshots` and retained-preparation validation use.

### Physical encoding

The default artifact is a standard concatenation of independent [Zstandard frames](../../../.agents/notes/implemented/architecture/2026-07-19-zstandard-jsonl-session-logs.md): one checksummed frame containing only the header line, then one checksummed frame per durable append batch, using Node's built-in Zstandard API at its default compression level (no level knob). `sourceEventSeqs` uses a lossless storage representation: consecutive runs of at least three sequence numbers become `[start, end]` pairs, any other list stays verbatim, and reading expands the exact in-memory array. Listing reads and validates only the header frame. `compression: 'none'` keeps the same storage-form logical lines without frame compression. A root belongs to one encoding: startup discovery and targeted lookup reject the opposite suffix, and there is no format or compression migration, mixed-root fallback, or dual write. When `packChunks` is enabled, an eligible run of ≥3 consecutive same-block `assistant/chunk` delta events becomes one packed row (`text-chunks`/`reasoning-chunks`/`tool-call-chunks`) whose `seq0`/`time0` and per-member `dt` gaps reconstruct every member exactly; the lossless codec lives in `dsh-session` and reading is layout-blind, so packed, unpacked, and mixed files load identically.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, backend class, coordinator wiring |
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
- **One live writer per session** — append and repair are coordinated only inside the owning backend instance; another instance or process must not write the same session until that owner reaches quiescent disposal.
- **POSIX materialization requires hard-link support** — first append uses `link()` so same-id races fail instead of overwriting a committed log; Windows uses write-through rename without replacement.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
