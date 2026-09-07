# Agent Note: Split the filesystem seam — provider text mutations plus the `dsh-fs-observation-policy` plugin

Status: implemented

English | [中文](2026-06-26-fsspec-style-fs-seam.zh.md)

## Problem

The filesystem capability from [filesystem-capability-seam](../../archived/architecture/2026-06-17-filesystem-capability-seam.md) currently makes one abstract `FileSystem` service own two different jobs:

1. **Provider operations** — resolving targets, stat/version metadata, text reads/streams, atomic writes, and guarded literal edits.
2. **Agent-facing policy** — line windows, literal edit semantics, and read-before-write/edit observed-state.

That makes every future backend reimplement model-facing read semantics and observation policy. `readPage` returns numbered lines and view metadata; the base service stores per-owner file state and distinguishes `full` from `partial` reads. Those are useful policies, but they are not filesystem-provider primitives. Literal text mutation is different: version guard, literal match, ambiguity detection, and atomic rewrite must stay together inside the provider mutation boundary, but the current `applyEdit` name and surrounding seam tie that provider operation to the old read-before-edit policy shape.

This also creates a real UX dead-end: a windowed read records `view: partial`, and partial views cannot authorize `edit`. A model that reads lines 100-150 of a large file therefore cannot edit line 120 unless it first gets a `full` read, which may be impossible for a file past the read cap. Literal edit only needs freshness: the bytes being matched must still be from the version the model read.

The old Agent Note already deferred a separate `@deepseek-ai/dsh-fs-observation-policy` package. This decision builds that layer and keeps `ctx.fs` close to fsspec-style storage primitives (`info`/`cat`/`open`), without turning it into full fsspec.

## Decision

Split the stack into four layers:

```text
tool          dsh-tool-fs       model-facing schemas + read windowing + text rendering; the EXECUTOR (reads/writes/edits via ctx.fs, dispatches the fs/* events)
policy        dsh-fs-observation-policy  observed-state + read-before-edit + write/edit freshness, contributed through the fs/* event gate (no service)
provider contract dsh-fs            ctx.fs: text IO + atomic mutation primitives (optional version guard)
provider      dsh-fs-local      local implementation of ctx.fs
```

`dsh-tool-fs` keeps the same model-facing `read`/`write`/`edit` schemas. It is the executor: it injects `fs` (not a policy service) and reaches `ctx.fs` directly, owns read windowing, and dispatches the `fs/*` events so `dsh-fs-observation-policy` can gate and record.

This Agent Note decided the four-layer split, the provider contract, and the freshness policy. The tool↔policy COUPLING was then refined by [the event-gate Agent Note](../architecture/2026-06-26-file-context-as-event-gate.md): `dsh-fs-observation-policy` is a gate PLUGIN that participates through the `fs/*` events rather than a `ctx.fileContext` method service, so the tool is not method-coupled to it and read windowing + the fs I/O live in `dsh-tool-fs`. This document describes that landed event-gate shape; the provider's version guard is optional (omit = unconditional bare provider).

## Provider Contract

`@deepseek-ai/dsh-fs` shrinks to provider text IO plus guarded text mutation:

```ts ignore-check
abstract resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
abstract stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
abstract readText(target: FsTarget, signal?: AbortSignal): Promise<string>
abstract streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>
abstract writeText(target: FsTarget, content: string, expected: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome>
abstract editText(target: FsTarget, edit: FsEditRequest, expected: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome>

interface FsInfo {
  version: FsVersion
  type: 'file' | 'directory' | 'other'
  size?: number
}

type FsWriteIntent =
  | { kind: 'createIfAbsent' }
  | { kind: 'replaceIfVersion'; version: FsVersion }
```

`stat` returns metadata, not content. `version` is the freshness token; `type` lets the executor reject directories/special files before reading; `size` lets the `read` tool choose `readText` vs `streamText` without probing by failure. `undefined` means absent.

`readText` reads the whole regular text file. `streamText` streams the same text semantics for large files. Both provider primitives own regular-file checks, UTF-8 decoding, binary/NUL rejection, and `FS_NOT_TEXT`; the policy layer never handles raw bytes or reimplements cross-chunk decoding. `readText` is the small-file/direct whole-file primitive, while large model-facing reads use `streamText`.

`writeText` is atomic temp-file + rename with an explicit write expectation. `createIfAbsent` creates a missing target and rejects an existing target with `FS_NOT_OBSERVED`; it is the path used when the owner has no prior read. `replaceIfVersion` replaces only when the target exists at the observed version; a missing target or version mismatch throws `FS_STALE_VERSION`.

`editText` is a provider-level guarded text mutation. When guarded it first verifies the target still exists at `expected.version`, then reads the current text, applies literal replacement, and writes atomically. The stale check must happen before literal matching so an edit based on an old read reports `FS_STALE_VERSION`, not `FS_EDIT_NOT_FOUND` or `FS_AMBIGUOUS_EDIT` from matching against newer content. Keeping this primitive on the provider contract preserves backend-local locking and lets a future remote backend implement native compare-and-edit without forcing the policy layer to pull the whole file through it.

This is a *text-storage* seam, deliberately half a level above byte-level fsspec (`cat`/`open` hand back raw bytes). UTF-8 decoding, binary/NUL rejection, guarded full-file writes, and guarded literal text edits live in the provider so the policy layer never touches raw bytes, reimplements cross-chunk decoding, or separates stale checks from the mutation critical section. Model-facing concepts still stay out of the provider: no line windows, numbered lines, rendered footers, or observed-state store leak down.

Deleted from `dsh-fs`: `readPage`, `FsExpectation`, `FsView`, `FsStateSource`, `FsReadRequest`, `FsTextLine`, line/window constants, `formatReadBody`, and the observed-state `WeakMap`. `applyEdit` is replaced by the narrower provider primitive `editText`, whose contract is version-guarded literal text mutation rather than policy-layer read authorization. The `FS_PARTIAL_OBSERVATION` code also leaves the `FsErrorCode` taxonomy: freshness authorization has no partial/full distinction, so nothing can raise it. `FsTargetKey` and `FsVersion` become branded opaque ids under the existing [branded-ids Agent Note](../../archived/architecture/2026-06-20-branded-ids.md).

## Policy Contract

`@deepseek-ai/dsh-fs-observation-policy` is a plugin, not a service: it registers no `ctx.*` key and injects nothing. It owns the write/edit freshness policy and observed-state that do not belong on the `FileSystem` provider base class (where a sandboxed/remote backend would otherwise inherit model-facing observation policy it has no business carrying). It contributes that policy through the `fs/*` event gate the executor dispatches.

Observed state lives here as `WeakMap<owner, Map<targetKey, FsVersion>>`. An entry exists iff the owner has read, written, OR edited that target (every success emits `fs/observed`), so its presence *is* the prior-observation record — there is no separate `hasRead` flag. The owner is derived structurally from the opaque event actor (`{ agent?: { session? } }`), a shape that lives in `dsh-fs-observation-policy`, not `dsh-fs`.

The plugin decides three `fs/*` events:

- `fs/write-intent` — no prior observation ⇒ `{ kind: 'createIfAbsent' }` (only new files can be created blindly); a prior observation ⇒ `{ kind: 'replaceIfVersion', version: vObserved }` (existing files replaced only if unchanged since the observation). Single-slot decision; does not call `next()`.
- `fs/edit-intent` — requires a prior observation by the owner (else `FS_NOT_OBSERVED`); returns `{ version: vObserved }` as the CAS basis. It does not implement literal replacement — it authorizes and supplies the version, and the provider's mutation critical section applies the guard, so concurrent edits based on the same observed version remain one-wins/one-stale.
- `fs/observed` — records `{ version }` for this owner+target after a successful read/write/edit. Synchronous, side-effect-only `WeakMap.set`.

The plugin does NO filesystem I/O: "have you observed this file?" is a `WeakMap` lookup, and "is the version you read still current?" is decided inside `ctx.fs.editText`/`writeText` in the same atomic lock that performs the mutation — the plugin only supplies `vObserved` as the basis.

## Tool Contract

`dsh-tool-fs` keeps the same schemas and prompt entry. `read` still exposes `file_path`, `offset`, and `limit`; `write` and `edit` are unchanged. It is the executor: it validates model args, reads/writes/edits through `ctx.fs` directly, owns line windowing and result rendering (`N: text`, footer, `<path>/<content>` envelope), and dispatches the `fs/*` events.

Each mutation dispatches its intent waterfall with an `undefined` bare-provider default, then calls `ctx.fs`, then emits `fs/observed`: e.g. `write` does `ctx.waterfall('fs/write-intent', target, exec, () => undefined)` → `ctx.fs.writeText(target, content, intent)` → `ctx.emit('fs/observed', …)`. A `read` stats once, reads/streams, builds the window, and emits `fs/observed`. Passing `exec` as the actor lets `dsh-fs-observation-policy` derive the owner without the tool reaching into the policy.

Because the policy is contributed through events with an `undefined` default, `dsh-tool-fs` is not method-coupled to `dsh-fs-observation-policy`: with the plugin absent, every intent waterfall falls through to `undefined` (unconditional bare-provider write/edit) and `fs/observed` has no listener. Loading the plugin back layers the read-before-write/edit policy on.

## Concurrency Boundary

In-process updates are safe: the local backend keeps the existing per-target mutation lock, so version-check-then-rename is serialized and a losing update sees `FS_STALE_VERSION`.

In-process creates are guarded by the same per-target mutation lock: two callers racing with `createIfAbsent` serialize, one creates, and the next sees the target exists and receives `FS_NOT_OBSERVED`. Cross-process creates are best-effort only; a local stat-then-rename guard cannot make portable create-exclusive guarantees across all future backends.

Cross-process writes are best-effort freshness plus atomic replacement: `mtime:size` usually catches editor saves, but same-tick same-size writes can miss; atomic temp+rename prevents torn files but not every lost update.

## Supersedes

This Agent Note reverses two decisions from [filesystem-capability-seam](../../archived/architecture/2026-06-17-filesystem-capability-seam.md) and narrows a third:

- Read-before-write/edit policy moves out of `ctx.fs` and into the `dsh-fs-observation-policy` plugin (on the `fs/*` event gate).
- Text reads no longer return backend-numbered line records or `full`/`partial` views; authorization is based on version freshness, so a windowed read can authorize edit when the file is unchanged.
- Literal edit no longer sits behind the old `applyEdit` API that mixed backend mutation with seam-owned observation policy. It remains a provider primitive as `editText`, because version guard + literal match + atomic rewrite must stay inside the provider's mutation critical section.

It keeps the Service Definition / Service Provider / Consumer discipline, consumer-never-imports-backend rule, backend-defined target/version/display metadata, atomic local writes, and the shared `FsError` taxonomy.

## Verification

`dsh-fs` exposes exactly `resolve`/`stat`/`readText`/`streamText`/`writeText`/`editText` (`stat` returning `FsInfo | undefined`, `writeText` taking `FsWriteIntent`), with the removed types/primitives gone; `dsh-fs-local` carries no line, view, or `formatReadBody` logic; model-facing schemas stayed byte-for-byte unchanged. Tests pin that a windowed read authorizes a later edit of an unchanged file, that an edit based on a stale read reports `FS_STALE_VERSION` before attempting literal matching, that version-CAS behavior is preserved, and that the observation contract holds (a `read`-tool read records observed-state; a direct `ctx.fs` read does not); `dsh-fs-observation-policy` has HMR/disposal coverage.

## Later extension

The seam was later extended with direct directory listing by [Add direct directory listing to the filesystem seam](../../archived/architecture/2026-07-03-filesystem-directory-listing-seam.md). That follow-up is recorded separately so this note continues to describe the fsspec-style refit that originally shipped.

## Alternatives considered

- **Byte-level fsspec (`cat`/`open` handing back raw bytes)** — rejected: the seam is deliberately text-storage, half a level up, so UTF-8 decoding, binary/NUL rejection, and guarded text mutations live once in the provider and the policy layer never touches raw bytes or separates stale checks from the mutation critical section.
- **A concrete `ctx.fileContext` method service** — this Agent Note's original policy shape; reworked by [the event-gate Agent Note](../architecture/2026-06-26-file-context-as-event-gate.md) into the gate plugin, so the tool is never method-coupled to the policy.
- **Keeping `readPage` and `full`/`partial` view authorization on the provider** — the pre-refit shape the Supersedes section reverses: view completeness is not what edit safety needs, version freshness is, and the view rule made large files past the read cap impossible to edit.

## Consequences

- Adds a fourth fs package and a new plugin layer. This is intentional: it is the previously deferred policy layer, not a second abstract backend contract.
- Direct `ctx.fs` use bypasses the policy: a direct `ctx.fs.readText` emits no `fs/observed`, so under the default policy a later `edit` rejects with `FS_NOT_OBSERVED` until the file is read through the `read` tool. The failure is explicit and documented.
- Large-file line windowing moves from the backend to the `read` tool in `dsh-tool-fs`; text decoding and binary rejection stay in `ctx.fs.streamText`, so this is relocation of windowing only, not a second text-IO implementation.
- Keeping `editText` in the provider contract means every backend must implement the literal replacement contract. This is intentional: the operation is not pure storage, but stale guard + literal match + atomic rewrite is the unit that must stay together for correct error attribution and concurrency behavior. The contract should stay narrow and text-only so future backends can implement it natively or by whole-file rewrite.
- Freshness permits full-file `write` after a windowed read. That is weaker than the old view check, but avoids making large files impossible to edit; prompt guidance still discourages blind full replaces.
