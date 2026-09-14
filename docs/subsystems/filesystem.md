# Filesystem

English | [中文](filesystem.zh.md)

The optional filesystem capability has four parts: [dsh-fs](../../packages/fs/fs) owns `ctx.fs` and atomic text operations with optional guards, [dsh-fs-local](../../packages/fs/fs-local) implements local disk, [dsh-fs-observation-policy](../../packages/fs/fs-observation-policy) records observed presence or absence and adds freshness rules through events rather than a service, and [dsh-tool-fs](../../packages/fs/tool-fs) directly executes model-facing read/write/edit calls and renders windows. It is outside the agent-loop spine; alternate backends do not change policy or tool schemas.

`dsh-fs-observation-policy` is optional. Without it, the `FileSystem` Service Definition, a provider, and the `dsh-tool-fs` Consumer form the complete, unconstrained filesystem seam: `write` unconditionally creates or overwrites, and `edit` unconditionally replaces literal text. The policy plugin changes these operations by deciding the `fs/*` waterfalls. Removing it does not break the tool because the tool calls `ctx.fs` and dispatches events; it does not call policy methods. A deployment that loads `dsh-tool-fs` is expected to also load `dsh-fs-observation-policy` so the default behavior is read-before-write/edit.

Provider source: [`packages/fs/fs/src/types.ts`](../../packages/fs/fs/src/types.ts) and [`packages/fs/fs/src/index.ts`](../../packages/fs/fs/src/index.ts). Policy source: [`packages/fs/fs-observation-policy/src/types.ts`](../../packages/fs/fs-observation-policy/src/types.ts). Read-rendering source: [`packages/fs/tool-fs/src/read-render.ts`](../../packages/fs/tool-fs/src/read-render.ts).

## Target identity and metadata (provider contract)

Every operation resolves a user-supplied path to an opaque backend target first. Consumers may display `displayPath`, but must not parse `targetKey` (a branded opaque id) or assume it is a local absolute path.

Consumers that share the filesystem's execution world obtain cross-capability coordinates through the provider instead of interpreting that identity: `processPath(target)` returns the canonical absolute path a subprocess can open, `processPathFromHostPath(hostPath)` maps an absolute harness-host file only when that execution world shares it, `fileUrl(target)` returns its provider-platform `file:` URI, and `contains(parent, child)` tests canonical identity or descendant containment.

```ts type-equiv
/**
 * A path resolved by a backend into a stable identity. `resolve()` produces
 * this; every other operation takes it.
 */
interface FsTarget {
  /** Opaque key for stale guards and target lookup. */
  targetKey: FsTargetKey
  /**
   * Path for model/UI-facing output. May be a local absolute path,
   * workspace-relative path, or remote URI depending on the backend.
   */
  displayPath: string
}
```

The backend owns file-version tokens — the freshness token a write/edit guards against. The policy plugin stores them for stale checks; consumers do not interpret them. Both ids are branded opaque strings.

```ts type-equiv
/**
 * Opaque key for stale guards and target lookup. The local backend uses a
 * realpath-like string; a remote backend might use a workspace URI or file id.
 * Consumers MUST NOT parse it or assume it is a local absolute path.
 */
type FsTargetKey = Branded<'FsTargetKey'>
```

```ts type-equiv
/**
 * Opaque file-version token — the freshness token a write/edit guards against.
 * The local backend derives it from high-resolution stat identity and freshness
 * fields; a remote backend might use a revision id. The policy layer records it
 * for stale checks; consumers may display related metadata but MUST NOT
 * interpret this token.
 */
type FsVersion = Branded<'FsVersion'>
```

`stat` returns metadata (never content), or `undefined` when the target is absent. `type` lets consumers reject directories and special files before reading, and `size` lets text consumers choose `readText` vs `streamText` without probing by failure. A text consumer applies its own retention ceiling while consuming `streamText`. Raw-byte consumers use `readBytes(target, signal, maxBytes)`; its required complete-content cap makes a known or discovered overflow fail with `FS_TOO_LARGE` instead of truncating or buffering without a bound.

```ts type-equiv
/**
 * Metadata about a target — what {@link FileSystem.stat} returns. Lets the
 * policy layer reject directories/special files before reading and choose
 * `readText` vs `streamText` from `size` without probing by failure. `version`
 * is the freshness token. `undefined` from `stat` means the target is absent.
 */
interface FsInfo {
  /** Opaque freshness token of the target right now. */
  version: FsVersion
  /** Whether the target is a regular file, a directory, or something else. */
  type: 'file' | 'directory' | 'other'
  /** Byte size of a regular file, when the backend can report it. */
  size?: number
}
```

`lstat` is the path-level no-follow metadata primitive. It takes a path instead of an `FsTarget` because `resolve` intentionally follows symlinks to produce stable identity; consumers that need trust-boundary checks can call `lstat` first and reject `symlink` before resolving.

```ts type-equiv
/**
 * Metadata about a path without following the final path component when it is a
 * symbolic link. Unlike {@link FsInfo}, this path-level probe can report
 * `symlink` so consumers with trust-boundary rules can reject repository-owned
 * links before resolving a target.
 */
interface FsPathInfo {
  /** Opaque freshness token of the path entry right now. */
  version: FsVersion
  /** Whether the path entry is a regular file, directory, symlink, or other. */
  type: 'file' | 'directory' | 'symlink' | 'other'
  /** Byte size of the path entry, when the backend can report it. */
  size?: number
}
```

`listDir` returns direct child entries in stable name order. Each entry carries the child basename, type, resolved target, and cheap metadata when the backend can report it. It must not read file contents, so `size` is only for regular files and `version` is metadata-derived. Broken or disappeared children may be returned as `other` without metadata; permission or backend I/O failures while listing or resolving child metadata fail the whole listing with `FS_PERMISSION_DENIED` or `FS_IO_ERROR`.

```ts type-equiv
/**
 * One direct child returned by {@link FileSystem.listDir}. Listing returns
 * metadata and resolved targets only; it must not read file contents.
 */
interface FsDirEntry {
  /** Basename of the child inside the listed directory. */
  name: string
  /** Whether the child is a regular file, a directory, or something else. */
  type: 'file' | 'directory' | 'other'
  /** Resolved child target for follow-up operations. */
  target: FsTarget
  /** Opaque freshness token when the backend can report metadata cheaply. */
  version?: FsVersion
  /** Byte size of a regular file, when the backend can report it. */
  size?: number
}
```

## Write and edit guards (provider contract)

Both `writeText` and `editText` take their version guard OPTIONALLY: omit it for an unconditional (bare-provider) mutation, supply it to guard. `writeText`'s guard is an `FsWriteIntent` — `createIfAbsent` creates a missing target and rejects an existing one with `FS_NOT_OBSERVED`, including a target that appears after the provider's initial probe because publication itself must be no-replace; `replaceIfVersion` replaces only when the target exists at the observed version, else `FS_STALE_VERSION`. Omitting `expected` unconditionally creates-or-overwrites. The union itself carries only the two guarded intents; "no guard" is expressed by omission, so write and edit both use the same optional `expected` field.

```ts type-equiv
/**
 * Guarded write intent. `createIfAbsent` rejects an existing target with
 * `FS_NOT_OBSERVED`; `replaceIfVersion` rejects absence or mismatch with
 * `FS_STALE_VERSION`. Omitting the intent from `writeText` means unconditional
 * create-or-overwrite, not a third union arm.
 */
type FsWriteIntent =
  | { kind: 'createIfAbsent' }
  | { kind: 'replaceIfVersion'; version: FsVersion }
```

```ts type-equiv
/** Outcome of a full-file write. */
interface FsWriteOutcome {
  /** Whether the write created a new file or replaced an existing one. */
  operation: 'create' | 'update'
  /** Opaque version of the file after the write. */
  version: FsVersion
  /**
   * The file's content BEFORE the write, or `null` when the file did not exist
   * (a create) or the backend declined a contextual basis (for example, a
   * binary/non-UTF-8 prior file or either overwrite side reaching its exclusive limit).
   * LF-normalized storage text (the diff basis), never a diff — a consumer
   * computes the result-time contextual diff from `before`/`after` when
   * `before` is present, else falls back to a whole-file diff.
   */
  before: string | null
  /** The file's content AFTER the write, LF-normalized to share `before`'s diff basis. */
  after: string
}
```

`editText` is a provider-level mutation, not a `read` plus `write` composed elsewhere. When guarded it verifies the expected version BEFORE literal matching (so a stale edit reports `FS_STALE_VERSION`, not a match failure against newer content); unguarded it edits the current content. Either way it applies the replacement and writes atomically — keeping matching, line-ending handling, the stale check, and atomic replacement inside one mutation critical section — and a missing target reports `FS_STALE_VERSION` on both paths.

```ts type-equiv
/** A literal-replacement edit request. */
interface FsEditRequest {
  /** Literal non-empty text to replace. Must match exactly (after line-ending normalization). */
  oldString: string
  /** Literal replacement text. An empty string deletes the matched text. */
  newString: string
  /** Replace every match instead of requiring exactly one. */
  replaceAll: boolean
}
```

```ts type-equiv
/** Outcome of a literal edit. */
interface FsEditOutcome {
  /** Opaque version of the file after the edit. */
  version: FsVersion
  /**
   * The file's content BEFORE the edit. Raw storage text (LF-normalized by the
   * backend), never a diff — a consumer computes the result-time contextual diff
   * (the applied hunk with context) from `before`/`after`.
   */
  before: string
  /** The file's content AFTER the edit. */
  after: string
}
```

## The fs policy events (provider contract vocabulary)

`dsh-fs` owns three events the tool dispatches and the policy plugin listens for, so the emitter (`dsh-tool-fs`) and the listener (`dsh-fs-observation-policy`) share a vocabulary without the emitter depending on the policy plugin. They carry only `dsh-fs` vocabulary plus an opaque `object` actor — no model-facing concepts and no agent/session owner structure.

`fs/write-intent` and `fs/edit-intent` are **single-slot decision waterfalls**: the tool dispatches each with a default thunk returning `undefined` (the bare provider), and a listener fully decides without calling `next()`. The slot is first-wins by registration order — the policy plugin owning it is a deployment convention, not an enforced invariant. `fs/observed` is a fire-and-forget recording event carrying an `FsObservation`: present at a version or confirmed absent. It is dispatched with a plain `ctx.emit`; its listener MUST be synchronous and side-effect-only, because the tool does NOT guard the emit — a throwing listener can replace a read error or surface as the tool's `isError` result after a mutation already succeeded. The generated [cordis surface](#cordis-surface) below shows the exact signatures.

```ts type-equiv
/**
 * One authoritative observation of a target. A present observation carries the
 * version used by guarded replacement; an absent observation authorizes only a
 * guarded create, never an edit.
 */
type FsObservation =
  | { readonly kind: 'present'; readonly version: FsVersion }
  | { readonly kind: 'absent' }
```

## Execution context (policy plugin)

The policy plugin needs just enough execution context to derive the observed-state owner by narrowing the opaque `object` actor the `fs/*` events carry. `ToolExecution` has the required fields, so `dsh-tool-fs` passes its execution object through as the actor without making `dsh-fs-observation-policy` import the tool, agent, or session packages.

```ts type-equiv
/**
 * Minimal structural view of a tool execution the policy plugin needs to derive
 * an observed-state owner. `@deepseek-ai/dsh-tools`' `ToolExecution` contains
 * these fields, so the tool passes its `exec` straight through as the opaque
 * `object` actor on the `fs/*` events; this plugin narrows that actor to
 * `FsObservationActor` without importing `dsh-tools`, `dsh-agent`, or `dsh-session`.
 *
 * The owner is `agent.session` when present. It is treated as an opaque object
 * identity (a `WeakMap` key); this package never reads any of its fields.
 */
interface FsObservationActor {
  /** The agent on whose behalf the call runs, when there is one. */
  agent?: {
    /** The session that owns observed-file state, used as an opaque key. */
    session?: object
  }
}
```

## Read outcome (consumer / read rendering)

A text read is bounded by line window, byte cap, and backend limits. After the byte cap is reached, scanning continues without retaining more lines so `totalLines` remains exact. The result the model-facing `read` tool renders is purely presentational; there is no `full`/`partial` view — authorization is freshness-based (the tool emits a present `fs/observed` directly with the stat's version), so any windowed read can authorize a later write/edit when the file is unchanged. A metadata miss emits an absent observation before the tool returns `FS_NOT_FOUND`, allowing a later guarded write to recreate an externally deleted target without authorizing edit. `dsh-tool-fs`, the executor that owns the read, implements read windowing and constructs this result; the policy plugin does not.

```ts type-equiv
/** Outcome of a bounded text read — what {@link formatReadOutput} renders. */
interface FileReadOutcome {
  /** 1-based first line requested. */
  offset: number
  /** Returned lines, already numbered. */
  lines: FileTextLine[]
  /** Exact total line count in the file. */
  totalLines: number
  /** Whether selected output hit the byte cap. */
  truncatedByBytes?: true
}
```

## Observed-file state (policy plugin)

Observed state is a `WeakMap<owner, Map<targetKey, FsObservation>>` held inside the `dsh-fs-observation-policy` plugin. Missing map entry means unseen; `{ kind: 'absent' }` means a `read` or `str_replace_editor` `view`, `str_replace`, or `insert` metadata miss confirmed absence; `{ kind: 'present', version }` means a read, write, or edit observed that version. The write decision maps unseen and absent to `createIfAbsent`, while present maps to `replaceIfVersion`; the edit decision maps unseen to `FS_NOT_OBSERVED`, absent to `FS_NOT_FOUND`, and present to its version guard. The owner is derived from the event actor (normally `exec.agent.session`), treated as opaque and never read. Disposal drops everything (HMR safety), and the policy performs no filesystem I/O.

## Error taxonomy (provider contract)

Filesystem failures use stable `FsErrorCode` strings carried by `FsError` (`HarnessError`). The tool registry preserves `{ name, code }` on error results, so retry, permission, and UI layers can branch without parsing text.

```ts type-equiv
/**
 * Stable, machine-routable codes for filesystem failures. Carried on
 * {@link FsError}; the tool registry exposes `{ name, code }` on `isError`
 * results so retry/permission/UI layers can branch without parsing messages.
 */
type FsErrorCode =
  | 'FS_NOT_FOUND'
  | 'FS_NOT_DIRECTORY'
  | 'FS_NOT_TEXT'
  | 'FS_NOT_REGULAR_FILE'
  | 'FS_TOO_LARGE'
  | 'FS_PERMISSION_DENIED'
  | 'FS_SANDBOX_DENIED'
  | 'FS_IO_ERROR'
  | 'FS_STALE_VERSION'
  | 'FS_NOT_OBSERVED'
  | 'FS_AMBIGUOUS_EDIT'
  | 'FS_EDIT_NOT_FOUND'
  | 'FS_ABORTED'
```

`FS_NOT_DIRECTORY`, `FS_PERMISSION_DENIED`, and `FS_IO_ERROR` are used by directory listing to distinguish an existing non-directory target, a denied listing, and an unexpected backend I/O failure. `FS_SANDBOX_DENIED` is a POLICY refusal from a sandbox-enforcing backend (`dsh-fs-sandbox`) — the mode fence denied a write/edit — distinct from `FS_PERMISSION_DENIED` (the host kernel refusing). `FS_NOT_OBSERVED` means the policy plugin has no prior-observation record for this owner (or a `createIfAbsent` hit an existing file). `FS_NOT_FOUND` also represents an edit rejected from confirmed absence. `FS_STALE_VERSION` means the backend version no longer matches the observed one (or the provider itself receives an edit for a missing target). Freshness authorization has no partial/full distinction, so there is no `FS_PARTIAL_OBSERVATION`.

## No timeouts on file IO

`read`/`write`/`edit` take **no** `timeoutMs`, and the provider contract arms no deadline — unlike bash and web (which consume [`@deepseek-ai/dsh-timeout`](../../packages/util/timeout/README.md)) and the subprocess-backed `glob`/`grep` (whose declared `timeoutMs` is enforced by `@deepseek-ai/dsh-tool-call-timeout-policy`): those are process-backed, where a deadline can really kill the work. A local syscall is best-effort-abortable at most — a timeout could not force an in-progress `fsync`/`rename` to stop, so a `timeoutMs` here would be a deadline the seam cannot enforce, and an implicit default in the exact place explicit-over-implicit forbids. Cancellation still propagates through the tool-execution signal for best-effort abort at syscall boundaries.

## The service and the plugin

`FileSystem` (`ctx.fs`, abstract) owns the provider primitives: `resolve`, `processPath`, `processPathFromHostPath`, `fileUrl`, `contains`, `stat`, `lstat`, `readText`, `streamText`, `readBytes`, `listDir`, `writeText`, and `editText`. `dsh-fs-observation-policy` registers **no service** — it is a plugin that adds policy through the `fs/*` event gate: it decides the write/edit intent waterfalls from unseen/absent/present state and records `FsObservation` values. The executor is `dsh-tool-fs`: it reads/writes/edits through `ctx.fs`, dispatches the waterfalls, and emits the recording event. The generated [`ctx.fs` section](#ctxfs--filesystem-abstract-seam) below shows the exact signatures.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxfs--filesystem-abstract-seam"></a>

### `ctx.fs` — `FileSystem` (abstract seam)

Abstract filesystem provider. Targets must preserve identity across aliases; reads expose regular UTF-8 text or typed errors, listings are stable and content-free, and mutations are atomic. Optional guards add stale protection without changing the unguarded provider contract.

```ts cordis-catalog
/**
 * Resolve a model/plugin-supplied path into a stable {@link FsTarget}. May perform I/O (a
 * remote/sandboxed backend may need a round-trip to map a path to a stable identity), hence
 * async even though the local backend only normalizes + realpaths.
 *
 * @param path - the path to resolve; relative paths resolve against `opts.cwd`.
 * @param opts - optional cwd override and cancellation signal.
 * @returns the stable target; the same file yields the same `targetKey`.
 */
abstract resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>

/**
 * Return the canonical absolute path a subprocess in this filesystem's
 * execution world can open. The path is deliberately separate from
 * {@link FsTarget.targetKey}: consumers may pass this value to another OS
 * capability, but must continue treating the target key as opaque.
 * @param target - the resolved target whose process path is required.
 * @returns an absolute path in the backend's execution world.
 */
abstract processPath(target: FsTarget): string

/**
 * Map an absolute path from the harness host into this filesystem's
 * execution world when both paths identify the same file. The base provider
 * exposes no mapping; host-backed or explicitly shared backends override it.
 * @param hostPath - absolute path in the harness host filesystem.
 * @returns the process path for the same file, or undefined when this
 *   execution world cannot read that host file.
 */
processPathFromHostPath(hostPath: string): string | undefined

/**
 * Return the canonical `file:` URI for a target in this filesystem's
 * execution world. Backends own URI encoding because the host platform may
 * differ from the execution platform.
 * @param target - the resolved target to encode.
 * @returns the target's canonical file URI.
 */
abstract fileUrl(target: FsTarget): string

/**
 * Test canonical containment without exposing or parsing backend target
 * keys. Both targets must come from this provider.
 * @param parent - canonical directory target.
 * @param child - canonical candidate target.
 * @returns true when `child` is `parent` or a descendant of it.
 */
abstract contains(parent: FsTarget, child: FsTarget): boolean

/**
 * Return target metadata, or `undefined` when the target does not exist.
 * @param target - the resolved target to stat.
 * @param signal - aborts the metadata round-trip.
 * @returns metadata only, never content; undefined for an absent target.
 */
abstract stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>

/**
 * Return path metadata without following the final path component when it is a
 * symbolic link. This is intentionally path-shaped, not target-shaped:
 * {@link resolve} follows symlinks to produce the stable identity used by
 * normal reads/writes, while `lstat` lets a consumer reject the path itself
 * before that follow happens.
 *
 * `opts.cwd` follows {@link resolve}'s cwd rules. `undefined` means the path is
 * absent.
 * @param path - the path to inspect; relative paths resolve against `opts.cwd`.
 * @param opts - `cwd` overrides the backend's default base for relative paths.
 * @param signal - aborts the metadata round-trip.
 * @returns metadata only, never content; undefined for an absent path.
 */
abstract lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined>

/**
 * Read the whole regular text file as a single decoded string.
 * @param target - the resolved target to read.
 * @param signal - aborts the read.
 * @returns the full decoded UTF-8 content.
 */
abstract readText(target: FsTarget, signal?: AbortSignal): Promise<string>

/**
 * Stream the whole regular text file as decoded text chunks (same text
 * semantics as {@link readText}, for large files). The backend owns
 * cross-chunk UTF-8 decoding and binary rejection so the policy layer never
 * touches raw bytes.
 * @param target - the resolved target to read.
 * @param signal - aborts the stream, including between chunks.
 * @returns the chunk iterable, decoded and validated like {@link readText}.
 */
abstract streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>

/**
 * Read the whole regular file as raw bytes with no decoding or binary
 * rejection. The bound lives at this seam so a backend can never buffer an
 * unbounded file: a target known or discovered to exceed `maxBytes` fails
 * with `FS_TOO_LARGE` instead of returning a truncated result.
 * @param target - the resolved target to read.
 * @param signal - aborts the read.
 * @param maxBytes - inclusive byte cap on the complete content.
 * @returns the full raw content, at most `maxBytes` long.
 */
abstract readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>

/**
 * Read one byte window of the regular file as raw bytes with no decoding or
 * binary rejection: the bytes at `[offset, offset + length)`, shorter when
 * the file ends inside the window and empty when `offset` lies at or past
 * its end. The window is the bound here, not the file: a backend transfers
 * at most `length` bytes of content beyond the prefix it skips to reach
 * `offset` and never buffers the whole file, so the caller's cap on `length`
 * is the guard against unbounded buffering.
 * @param target - the resolved target to read.
 * @param range - `offset`, the 0-based first byte, and `length`, the largest byte count; both non-negative integers.
 * @param signal - aborts the read.
 * @returns the window's bytes, at most `length` long.
 */
abstract readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array>

/**
 * List direct children of a directory in stable name order. Returns resolved
 * child targets plus cheap metadata only; never reads file contents.
 * @param target - the resolved directory target.
 * @param signal - aborts the listing.
 * @returns one entry per direct child, in stable name order.
 */
abstract listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>

/**
 * Atomically create or replace UTF-8 text. `expected` guards intent and
 * staleness; omission allows unconditional overwrite.
 * @param target - the resolved target to write.
 * @param content - the full new file content.
 * @param expected - the write intent guarding the write; omit for unconditional.
 * @param signal - aborts before atomic publication takes effect.
 * @param sandboxPolicy - the per-call mode and workspace root this write
 *   runs under; a sandboxing backend fences the write by it, the bare backend
 *   ignores it. Omit to leave the backend its own default.
 * @returns the outcome, including the version the write produced.
 */
abstract writeText( target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy, ): Promise<FsWriteOutcome>

/**
 * Atomically edit literal text. When supplied, the version guard is checked
 * before matching so stale content reports `FS_STALE_VERSION`; omission edits
 * the current content without a freshness precondition.
 * @param target - the resolved target to edit.
 * @param edit - the literal search/replace request.
 * @param expected - the version guard; omit for an unconditional edit.
 * @param signal - aborts before atomic publication takes effect.
 * @param sandboxPolicy - the per-call mode and workspace root this edit runs
 *   under; a sandboxing backend fences the edit by it, the bare backend
 *   ignores it. Omit to leave the backend its own default.
 * @returns the outcome, including the version the edit produced.
 */
abstract editText( target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy, ): Promise<FsEditOutcome>
```

Types: [SandboxExecutionPolicy](sandbox.md)

Source: [`packages/fs/fs/src/index.ts`](../../packages/fs/fs/src/index.ts)

<a id="fs-events"></a>

### `fs/*` events

<a id="fsedit-intent--waterfall"></a>

#### `fs/edit-intent` — waterfall

Single-slot decision for the next FileSystem.editText. Calling `next()` yields an unconditional edit; the first returned guard wins.

```ts cordis-catalog
/**
 * Single-slot decision for the next {@link FileSystem.editText}. Calling
 * `next()` yields an unconditional edit; the first returned guard wins.
 * @param target - the resolved target about to be edited.
 * @param actor - the opaque tool-execution context the decider keys off.
 * @mode waterfall
 */
'fs/edit-intent'(target: FsTarget, actor: object | undefined, next: () => { version: FsVersion } | undefined | Promise<{ version: FsVersion } | undefined>): Promise<{ version: FsVersion } | undefined>
```

Source: [`packages/fs/fs/src/index.ts`](../../packages/fs/fs/src/index.ts)

<a id="fsobserved--emit"></a>

#### `fs/observed` — emit

Record an authoritative positive or negative observation. Listeners must be synchronous recorders: throws fail the tool call and returned promises are not awaited.

```ts cordis-catalog
/**
 * Record an authoritative positive or negative observation. Listeners must
 * be synchronous recorders: throws fail the tool call and returned promises
 * are not awaited.
 * @param target - the target whose presence or absence was observed.
 * @param observation - present with its version, or confirmed absent.
 * @param actor - the observing tool-execution context; undefined records nothing useful.
 * @mode emit
 */
'fs/observed'(target: FsTarget, observation: FsObservation, actor: object | undefined): void
```

Source: [`packages/fs/fs/src/index.ts`](../../packages/fs/fs/src/index.ts)

<a id="fswrite-intent--waterfall"></a>

#### `fs/write-intent` — waterfall

Single-slot decision for the next FileSystem.writeText. Calling `next()` yields the bare provider's unconditional write; the first listener that returns an intent owns the decision rather than composing with peers.

```ts cordis-catalog
/**
 * Single-slot decision for the next {@link FileSystem.writeText}. Calling
 * `next()` yields the bare provider's unconditional write; the first listener
 * that returns an intent owns the decision rather than composing with peers.
 * @param target - the resolved target about to be written.
 * @param actor - the opaque tool-execution context the decider keys off.
 * @mode waterfall
 */
'fs/write-intent'(target: FsTarget, actor: object | undefined, next: () => FsWriteIntent | undefined | Promise<FsWriteIntent | undefined>): Promise<FsWriteIntent | undefined>
```

Source: [`packages/fs/fs/src/index.ts`](../../packages/fs/fs/src/index.ts)
<!-- END GENERATED cordis-surface -->
