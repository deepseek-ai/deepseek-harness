---
description: "The shipped JSONL session-persistence backend for deployments and maintainers choosing, configuring, or debugging per-session durable logs with optional Zstandard compression."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-jsonl

English | [中文](README.zh.md)

## Summary

`dsh-session-persistence-jsonl` stores each session in a current append-only JSONL log and retains immutable historical format generations — checksummed Zstandard frames by default, raw newline-delimited lines when compression is disabled. It serves the current logical `SessionEvent` stream through persistence handles, so format migration, compression, historical decoding, and crash recovery remain storage-internal details. Choose it when consumers need a per-session file on disk; the logs are readable as plain lines when `compression: 'none'` is selected. A root directory is the one required configuration; durability, lazy materialization, released-v0/v1 migration, and torn-tail crash recovery come with the backend.

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
| `compression` | `'zstd'` | Physical encoding: `'zstd'` checksummed frames, or `'none'` newline-delimited UTF-8 text |

Live-event write batching is not configuration: the batching window is the seam's internal scheduling policy inside each write handle.

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-persistence-jsonl) is the exhaustive source for every accepted field and its JSDoc.

### On-disk layout

Each session gets a session-owned directory under a readable project directory. Every canonical generation starts with a physical header whose version equals its filename. Current v2 stores one physical row per durable event; the frozen v0 and v1 readers also understand their historical packed Assistant-delta rows. V2 stores `isSeeded` in the header and derives the inherited cut from the last tagged `session/end-seed` marker, while historical codecs translate their numeric `seedLength`. The format catalog completes that translation before a handle exposes current logical values. Current storage records use the lossless provenance representation described below:

```text
<root>/
  --<normalized-cwd>--/          # readable project directory (or _no-cwd/)
    <encoded-id>/                # session-owned directory
      session.jsonl.zstd         # released v0, compressed root
      session.v1.jsonl.zstd      # released v1, compressed root
      session.v2.jsonl.zstd      # released v2, compressed root
      session.jsonl              # released v0, raw root
      session.v1.jsonl           # released v1, raw root
      session.v2.jsonl           # released v2, raw root; later versions use vN
```

Session ids are injectively escaped to one safe path segment before use (no traversal, no collision). The normalized cwd keeps the project directory readable for navigation; cwd strings that normalize alike share a project directory while session ids still select distinct session directories. Runtime operations select the numerically highest canonical generation, and format-refusal diagnostics name that absolute path so an operator can find the raw log a build refused to interpret.

### Durability and crash semantics

A session is materialized lazily: `create(header)` writes nothing and returns the owned write handle, and the handle's first `append` writes and `fsync`s the encoded header and first batch through a no-overwrite publish — so a created-but-never-appended session leaves nothing on disk unless its owner calls `handle.flush()`, which publishes one header frame without an event. Each subsequent batch appends lines or one compressed frame and `fsync`s before the append resolves; a caught write or sync failure rolls the file back to its prior length. Committed events are never rewritten. After a crash, the stored log keeps its interrupted final turn — every record in the committed prefix survives, and the resuming reader appends synthetic closers through its write handle. An incomplete final raw line is discarded. A torn final Zstandard frame contributes only its complete decoded JSONL records; a write handle truncates the torn bytes and durably rewrites those recovered records before its first new batch. Checksum, decompression, or structural failure in a complete committed frame rejects as corruption.

### Reading the logs

`open(id, 'read'|'write')` selects the highest canonical generation. Current input follows the ordinary fast path. For historical input, a read open decodes and migrates the source once, validates the current logical result, and returns it without publishing a successor. A write open reuses that revision-keyed preparation when available, or performs the same preparation, then encodes a same-directory temporary file in bounded chunks, verifies it in a Worker Thread, rechecks the source revision, and publishes the current successor without overwrite before returning. The source remains byte-identical. Source drift after preparation rejects that write open without replacing the logical history already returned to readers; a later write open prepares the new revision. The backend marks decoded event graphs `shared-frozen` when it freezes them before memoization; handle reads and slices preserve that state, including empty slices. Only an unmaterialized pending log reports `detached`. `stat(id)` and `list()` select and translate only the highest generation header without reading event rows or starting migration; snapshots carry `sizeBytes` and a best-effort stat-derived revision for the selected file. With `compression: 'none'`, the log is newline-delimited text an external reader can consume directly; the compressed default must be read through the backend.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the physical encoding and write path; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The backend owns its complete storage runtime (`src/storage.ts`): `JsonlSessionHandle` carries the per-handle mutation chain, the routed live-event buffer with its fixed batching window and single-flight drain, monotonic reads, and idempotent close; a tracker holds the in-process single-writer claims, the open-handle set teardown sweeps, and the created-but-unmaterialized pending sessions the backend's own session listeners route into. Historical body reads share one per-session Decode/Migrate preparation, and a bounded revision-keyed memo lets an immediate observe-to-resume handoff reuse that parse; the backend deep-freezes each event graph once before memoization, so later handle reads reuse it without copying or freezing. Only a write open publishes the prepared successor. The package deliberately exposes only its default plugin export plus configuration types — the concrete class is not a named export, so consumers couple to `ctx.sessionPersistence`, and the shared seam suites (`runPersistenceContract`/`runLiveWritePathContract`) pin its observable behavior. Its change token is a best-effort file revision: device, inode, size, and nanosecond timestamps identify one log for `stat`/`list`, for the stable-read loop that retries a read torn by a concurrent append, and for the pre-publication source check.

### Physical encoding

The default artifact is a standard concatenation of independent [Zstandard frames](../../../.agents/notes/implemented/architecture/2026-07-19-zstandard-jsonl-session-logs.md): one checksummed frame containing only the header line, then one checksummed frame per durable append batch, using Node's built-in Zstandard API at its default compression level (no level knob). Current v2 writes one event per row; `sourceEventSeqs` uses a lossless storage representation in which consecutive runs of at least three sequence numbers become `[start, end]` pairs, any other list stays verbatim, and reading expands the exact in-memory array. Historical migration reuses one Zstandard decoder, passes parsed rows through stateful format stages, and streams current records through one compression context in about 1 MiB main-thread slices while retaining only final current events, bounded decoder state, and the required sequence-remap table. Listing reads and validates only the header frame. `compression: 'none'` keeps the same storage-form logical lines without frame compression. A root belongs to one encoding: startup discovery and targeted lookup reject generations with the other suffix; format migration preserves the configured encoding, while compression conversion, mixed-root fallback, and dual write remain unsupported. Frozen v0 and v1 codecs retain their packed-row decoders solely for historical generations.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, the backend service class, and file storage primitives |
| [`src/storage.ts`](src/storage.ts) | The JSONL handle, routed live-event buffer, in-process writer bookkeeping, listeners, teardown |
| [`src/format.ts`](src/format.ts) | Log path derivation, header encoding, and current record scanning |
| [`src/generation.ts`](src/generation.ts) | Single-pass historical restore, bounded stage encoding, source revision check, and exclusive successor publication |
| [`src/migration-verifier.ts`](src/migration-verifier.ts) | Worker lifecycle for staged and competing-generation verification |
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
- [Released Session format migrations](../../../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md) — immutable generations, adjacent migration edges, and publication rules.

-----

<a id="model-experience"></a>
## Model Experience

### Resumed conversation history

#### What the model sees

JSONL storage contributes no live prompt or schema. Loading restores stored surface history and preserves prior request headers for reconstruction; the new loop composes its current envelope. Recovery balances an assistant request without a durable call with `TOOL_NOT_STARTED`; a durable call without a result becomes `TOOL_OUTCOME_UNKNOWN`, which tells the model to retry only read-only or idempotent work and to verify possible side effects or ask the user. Embedded Assistant streams and log-only attempts do not duplicate messages.

#### Token effect

Zero live-request tokens. A resumed agent pays for retained history and its current envelope, plus the quoted repair result for each interrupted call.

#### KV Cache effect

JSONL storage does not mutate live request prefixes. A resumed loop can reuse provider cache only when its reconstructed history, current envelope, and model route match; crash-repair results append.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this backend is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Format migration preserves the configured encoding and supports only the catalogued chain** — this build migrates released v0 or v1 to current v2; changing compression requires a separate root, and retained predecessors do not provide automatic fallback or downgrade support.
- **The flat-file storage layout does not load** — use a separate root or move pre-release artifacts into the project/session directory layout before loading.
- **Compressed files are not directly line-readable** — use the backend to load them, or select `compression: 'none'` before writing a fresh root when external line readers are required.
- **Nothing deletes session files** — logs accumulate under `root` until removed externally; the seam has no deletion API.
- **One live writer per session** — the write-handle claim excludes a second writer inside the owning backend instance, and a kernel lock (non-blocking `flock(2)` on `session.lock`; on Windows a named kernel semaphore derived from that path, with no filesystem footprint) excludes every other instance and process; the lock is taken at write-open of an existing artifact and, for a created session, only right before its first materializing write, so an unmaterialized session leaves no filesystem footprint. A crashed holder's lock dies with its process, so its session is writable again immediately, while a live-but-wedged holder blocks writers until its process exits (on POSIX, removing the lock file forfeits that exclusion; release itself never removes it). Advisory `flock` is unreliable on some network filesystems (NFSv3), and the Windows semaphore name is per login session.
- **POSIX materialization requires hard-link support** — first append uses `link()` so same-id races fail instead of overwriting a committed log; Windows uses write-through rename without replacement.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
