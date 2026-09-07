# Agent Note: Filesystem capability seam — ctx.fs, local backend, and model-facing filesystem tools

Status: implemented
Archived: 2026-09-04

English | [中文](2026-06-17-filesystem-capability-seam.zh.md)

## Problem

The harness has a concrete `bash` capability seam (`dsh-shell` / `dsh-bash-local` / `dsh-tool-bash`), but filesystem operations were about to land as model-facing tools without an equivalent seam. If `read`, `write`, and `edit` directly used `node:fs`, the model-facing tool package would own filesystem execution policy, local path resolution, atomic write behavior, text decoding, symlink behavior, and edit semantics all at once.

That couples three concerns that change independently:

1. The filesystem contract: what operations plugins can ask for.
2. The backend: local disk now, sandboxed/remote/project-scoped filesystem later.
3. The consumer API: model-facing `read` / `write` / `edit` schemas and result formatting.

Without a `ctx.fs` interface, swapping local filesystem access for a sandboxed or remote backend would churn the tool schemas, demos, and prompt guidance even when the model-facing contract should stay stable. It also makes permission/sandbox boundaries harder to reason about: a `cwd` option can look like a sandbox even though it is only a base path unless an explicit backend or `tools/execute` policy enforces containment.

The filesystem tools must land in the same capability-seam shape as bash before they become a public package surface.

## Decision

Filesystem access is a first-class capability seam following [the capability-seam Agent Note](2026-06-13-capability-seams.md):

1. `@deepseek-ai/dsh-fs` (`packages/fs/fs`) owns the abstract `ctx.fs` service, the filesystem vocabulary types, and the `fs/*` policy event vocabulary.
2. `@deepseek-ai/dsh-fs-local` (`packages/fs/fs-local`) provides the first implementation, backed by the local filesystem.
3. `@deepseek-ai/dsh-tool-fs` (`packages/fs/tool-fs`) provides the model-facing `read`, `write`, and `edit` tools over `ctx.fs`, and is the executor that dispatches the `fs/*` events.

The Consumer package depends only on the Service Definition package, never on `dsh-fs-local`. A deployment that wants a different backend loads a different provider for `ctx.fs` without changing the tool schemas or model-facing prompt guidance.

The read-before-write/edit and observed-state policy is a fourth package, `@deepseek-ai/dsh-fs-observation-policy` (`packages/fs/fs-observation-policy`), contributed through the `fs/*` event gate rather than living on `ctx.fs`; a deployment loading `dsh-tool-fs` also loads `dsh-fs-observation-policy` to get read-before-write/edit. This decision established the three-package boundary; the split of policy off the provider base class is decided by [the split-fs-seam Agent Note](../simplification/2026-06-26-fsspec-style-fs-seam.md), and its realization as an event-gate plugin (not a method service) by [the event-gate Agent Note](2026-06-26-file-context-as-event-gate.md).

The first backend is deliberately local-only: `dsh-fs-local` implements `ctx.fs` against the host filesystem. Future sibling backends can provide sandboxed, remote, virtual, or project-scoped filesystems behind the same interface.

The first consumer is deliberately text-file-only: `dsh-tool-fs` exposes model-facing `read`, `write`, and `edit` tools for UTF-8 text files. Future consumers can add directory listing, search/glob, binary-safe operations, file watching, or higher-level project operations without changing the local backend package, as long as the needed capability exists on `ctx.fs`. Direct directory listing was later added by [Add direct directory listing to the filesystem seam](../../archived/architecture/2026-07-03-filesystem-directory-listing-seam.md).

Filesystem permissions and sandboxing are not implied by this split. The local backend resolves relative paths from its configured base directory, but containment policy is a separate decision: either a stricter `ctx.fs` implementation enforces it, or a permission/sandbox plugin wraps `tools/execute` and vetoes calls before they reach the consumer.

Read-before-write/edit and observed state belong to `dsh-fs-observation-policy`, not `ctx.fs`. Through the `fs/*` event gate, the policy records versions per opaque actor and supplies optional mutation expectations; the provider enforces freshness atomically. `dsh-tool-fs` emits the events without depending on the policy. See the [split-seam](../simplification/2026-06-26-fsspec-style-fs-seam.md) and [event-gate](2026-06-26-file-context-as-event-gate.md) Agent Notes.

## Package topology

The filesystem seam uses the same dependency direction as the bash trio:

```text
@deepseek-ai/dsh-tool-fs  --depends on-->  @deepseek-ai/dsh-fs  <--depends on--  @deepseek-ai/dsh-fs-local
        consumer                                interface                         implementation
```

`@deepseek-ai/dsh-fs` depends only on `cordis` plus the repo-wide `HarnessError` base from `@deepseek-ai/dsh-llm`. It declares the `ctx.fs` key, the abstract `FileSystem` service, the vocabulary types shared by backends and consumers, the filesystem error vocabulary, and the `fs/*` policy event vocabulary. It carries no observed-state store and no owner-derivation shape; the events pass an opaque `object` actor that the provider never reads, and the `dsh-fs-observation-policy` plugin owns the owner-derivation shape and the observed-state store on top of those events.

`@deepseek-ai/dsh-fs-local` depends on `@deepseek-ai/dsh-fs` and `cordis`. It subclasses `FileSystem`, registers itself as `ctx.fs`, owns local-backend configuration such as the base directory, and contains all direct `node:fs` / `node:path` access. It holds no observed-state store — freshness is a version token the backend mints and the policy plugin records.

`@deepseek-ai/dsh-tool-fs` depends on `@deepseek-ai/dsh-fs`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-system-prompt`, and `cordis`. It registers model-facing tools and prompt sections. It must not import `node:fs`, `node:path`, or `@deepseek-ai/dsh-fs-local`; filesystem execution always goes through `ctx.fs`. If the implementation needs concrete agent or session helper types, those dependencies belong in `tool-fs`; they must not leak back into `dsh-fs`.

The root `tool-fs` plugin registers the full filesystem tool suite (`read`, `write`, and `edit`) by composing the per-tool registration helpers. It injects `fs` and never imports a Service Provider package.

## `ctx.fs` contract

`@deepseek-ai/dsh-fs` owns a semantic filesystem service. It is higher-level than `readFile` / `writeFile` so `tool-fs` does not reimplement path resolution, versioning, text decoding, binary rejection, pagination, atomic replacement, symlink behavior, or literal edit semantics.

The interface covers these semantic operations:

- Resolve a model/plugin-supplied path into a backend-defined target.
- Convert a resolved target to the canonical process path or `file:` URI for the same execution world, and test containment without parsing its opaque key.
- Stat target metadata without reading file contents.
- Read complete or streamed UTF-8 text; consumers apply their own view and retention limits.
- Create or replace a UTF-8 text file.
- Edit an existing UTF-8 text file by literal replacement.

The provider contract also carries the freshness hooks that policy builds on — but the observed-state store and owner derivation live in the `dsh-fs-observation-policy` plugin, not on `ctx.fs`:

- The backend mints an opaque `version` token per target (in `stat` and in every read/mutation outcome).
- `writeText`/`editText` take an OPTIONAL version expectation: omit it for an unconditional bare-provider mutation, or supply it to guard the mutation inside the backend's atomic critical section.
- The `dsh-fs-observation-policy` plugin decides that expectation on `fs/write-intent`/`fs/edit-intent` and records observed versions on `fs/observed`, keyed by an owner it derives from the opaque event actor (normally `exec.agent.session`).

Authorization is version freshness, not a full/partial view distinction: any read records the target's version, and a later write/edit is authorized as long as the file is still at that version — so a windowed read of lines 100-150 authorizes an edit of line 120. The observed-state store is a `WeakMap<owner, Map<targetKey, version>>` inside `dsh-fs-observation-policy`; `dsh-fs` holds none of it and treats the actor as opaque. (This decision first modeled a `FileState` cache with `full`/`partial` views on `ctx.fs`; the split-fs-seam and event-gate notes replaced that with the freshness-based policy plugin described here.)

Path resolution is explicit and allowed to be async. Local resolution may only normalize a path, but sandboxed/remote/project-scoped backends may need I/O to resolve a user-supplied path into a stable target identity.

Resolved targets must expose at least three concepts:

- The original input path, for diagnostics.
- An opaque `targetKey`, used for stale guards and file-state lookup. The local backend might use a realpath-like key; a remote backend might use a workspace URI or file id. Consumers must not parse or assume this is a local absolute path.
- A `displayPath`, used for model/UI-facing output. It may be a local absolute path, workspace-relative path, or remote URI depending on the backend.

`targetKey` remains opaque even when another capability shares the provider's execution world. Such consumers ask the provider for `processPath(target)`, `fileUrl(target)`, or `contains(parent, child)`; the [portable execution-world decision](2026-07-28-portable-execution-world-consumers.md) owns why these facts sit on the filesystem seam.

Read and mutation results must include an opaque file `version`. The local backend derives its token from bigint stat metadata (`dev`, `ino`, `size`, `mtimeNs`, and `ctimeNs`) so same-size rewrites and inode replacement invalidate consumers reliably; a remote backend can use a revision id or hash-like token. The `dsh-fs-observation-policy` plugin records versions for stale checks; consumers may display related metadata but must not interpret the version token.

The provider hands back decoded text: `readText` returns a whole regular text file and `streamText` streams the same text semantics for large files or consumer-owned retention limits. Line windowing, byte ceilings, numbered-line rendering, and total-line accounting live in consumers such as `dsh-tool-fs` and `dsh-lsp-stdio`. The provider owns regular-file checks, UTF-8 decoding, and binary/NUL rejection; it does not know about line windows, protocol limits, or views.

Observed-state recording is not on `ctx.fs`: after a successful read the executor emits `fs/observed`, and the `dsh-fs-observation-policy` plugin records `{ version }` for the deriving owner. There is no `full`/`partial` view — a read at any window records the version, and freshness (not view completeness) authorizes a later write/edit.

Full-file writes create or replace UTF-8 text files. Backends may create parent directories when that behavior is supported and documented. Existing non-regular targets are rejected. `writeText` takes an optional expectation: `createIfAbsent` creates a missing target and rejects an existing one with `FS_NOT_OBSERVED` (the path the policy uses for an unobserved owner); `replaceIfVersion` replaces only when the target exists at the observed version, else `FS_STALE_VERSION`; omitting the expectation is the unconditional bare-provider create-or-overwrite. The policy plugin chooses which expectation to supply from the owner's observed state.

Literal edit is a provider primitive (`editText`), not composed in `tool-fs` from a read plus write. Literal matching, duplicate-match rejection, CRLF preservation, binary rejection, optional stale-version checking, and atomic read-modify-write must stay together inside the backend's mutation critical section. `editText` takes the same optional version expectation; the stale check runs before literal matching so an edit against an old read reports `FS_STALE_VERSION`. A remote backend may implement edit as a native compare-and-edit operation; the consumer does not force local-style composition.

The policy plugin, not `ctx.fs`, gates on prior observation: an `edit` requires a prior observation by the owner (else `FS_NOT_OBSERVED`), and the recorded version is passed to `editText` as the CAS basis. With the policy plugin absent, `ctx.fs` alone is a complete unconstrained seam (unconditional write/edit); the tool is never method-coupled to the policy.

Filesystem contract failures are thrown as `FsError extends HarnessError`, and the tool registry converts them into `isError` tool results with structured `{ name, code }` metadata. `dsh-fs` owns this vocabulary rather than each tool inventing messages. The codes are `FS_NOT_FOUND`, `FS_NOT_TEXT`, `FS_STALE_VERSION`, `FS_NOT_OBSERVED`, `FS_NOT_REGULAR_FILE`, `FS_AMBIGUOUS_EDIT`, `FS_EDIT_NOT_FOUND`, and `FS_ABORTED`. (An earlier draft included `FS_PARTIAL_OBSERVATION`; freshness-based authorization has no partial/full distinction, so it was dropped. Directory-listing-specific codes were added later by [Add direct directory listing to the filesystem seam](../../archived/architecture/2026-07-03-filesystem-directory-listing-seam.md).)

## Tool consumer behavior

`@deepseek-ai/dsh-tool-fs` is the model-facing consumer. It owns tool names, JSON schemas, argument validation at the model boundary, prompt sections, and result formatting. It does not own filesystem execution.

The first tool suite contains:

- `read`: inspect a UTF-8 text file and return line-numbered content with pagination guidance.
- `write`: create or fully replace a UTF-8 text file.
- `edit`: update an existing UTF-8 text file by replacing literal text, requiring a unique match by default and allowing an explicit replace-all mode.

Each tool follows the same execution shape:

1. Validate and normalize model arguments.
2. Call the appropriate `ctx.fs` operation.
3. Format the result as `ContentBlock[]` for the model.
4. Let thrown backend/tool errors flow through `ToolRuntime.execute()`, which converts them into `isError` tool results.

The package registers prompt guidance through `ctx.systemPrompt.section(...)` and registers schemas through `ctx.tools.register(...)`. Tool schemas still flow into the normal prompt assembly path via `SystemPrompt.assemble()` and `ToolRuntime.schemas()`; no agent-loop changes are required.

The tool package keeps model-facing contracts stable when backends change: a local backend and a remote backend may resolve paths differently internally, but the `read` / `write` / `edit` schemas do not change solely because the backend changes.

The default deployment requires a prior `read` before updating an existing file with `write` or `edit`. `tool-fs` does not implement this by checking whether a tool named `read` ran: it dispatches the `fs/write-intent`/`fs/edit-intent` events (passing the execution context as the opaque actor), and the `dsh-fs-observation-policy` plugin derives the owner, gates on prior observation, and supplies the version expectation. Any windowed read authorizes a later write/edit as long as the file is unchanged. Creating a new file with `write` does not require prior observation.

The root plugin registers the full suite by composing the per-tool registration helpers. It injects `fs`, `tools`, and `systemPrompt`.

## Testing

Tests follow the package boundary, not only the user-visible tools: the service contract in `dsh-fs`; real filesystem behavior through the `ctx.fs` interface in `dsh-fs-local` (resolution, symlinks, streaming, binary/UTF-8 rejection, unconditional and version-guarded writes, literal-edit semantics, line-ending preservation, structured `FsError` codes); the consumer surface in `dsh-tool-fs` against the real local provider (mock only the model/clock, never the collaborator); and integration through `ctx.tools.execute()` with and without `dsh-fs-observation-policy`, world-verified by reading files back from disk rather than trusting either the canonical value or rendered content. The observed-state/owner-derivation policy is tested in `dsh-fs-observation-policy`, not here.

The defensive-pattern classes this repo has been bitten by are pinned directly:

- **Atomic-write temp-file safety.** Write/edit stage through a private random `0700` directory next to the target with an exclusive owner-only (`'wx'`, `0o600`) temp file, cleanup on failure, and a final atomic rename — mirroring the bash spill-file rules, because predictable world-readable temp paths invite symlink races and disclosure. Tests assert the permissions and that a pre-existing temp path is not clobbered; this primitive is a standing requirement of the seam.
- **`targetKey` identity through symlinks.** Two input paths resolving to the same realpath share one observed-state entry: a `read` via path A satisfies the read-before-edit guard for an `edit` via symlink path B, and a stale write through one path is detected through the other.
- **Concurrency / stale races.** Two concurrent write/edit operations against the same target settle deterministically — one succeeds, the other is rejected with `FS_STALE_VERSION` — and a successful edit refreshes recorded state so the same owner's next edit proceeds.
- **HMR safety and disposal.** Disposing the backend's fiber withdraws the `ctx.fs` provider; a later provider starts with no inherited state.

## Alternatives considered

- **Model-facing tools directly over `node:fs`** — the tool package would own execution policy, path resolution, atomic writes, text decoding, and edit semantics at once, coupling the three independently-changing concerns the Problem names and churning schemas on any backend swap.
- **One combined `dsh-fs-tools` package** — the pre-seam shape; rejected for the same Service Definition / Service Provider / Consumer split as bash, and the combined name never became public API.
- **Observed-state on `ctx.fs`** — the shape this Agent Note first landed; superseded by [the split-fs-seam Agent Note](../simplification/2026-06-26-fsspec-style-fs-seam.md) and [the event-gate Agent Note](2026-06-26-file-context-as-event-gate.md): a sandboxed/remote backend must not inherit model-facing observation policy, so the provider keeps only the version token and the optional version-guarded mutation.

## Consequences

**`cwd` can be mistaken for a sandbox.** The local backend's base directory is a resolution default, not automatically a containment boundary. If containment is required, it must be enforced by the backend contract or by a permission/sandbox plugin on `tools/execute`.

**The interface can become too local.** Returning fields such as `absolutePath` from `ctx.fs` would make remote, sandboxed, or virtual backends awkward. The contract should expose display metadata without requiring consumers to understand host paths.

**The interface can become too thin.** If `ctx.fs` only mirrors `node:fs` primitives, `tool-fs` will reimplement binary detection, pagination, atomic writes, and edit semantics. That recreates the coupling this decision avoids.

**Edit semantics are race-prone by nature.** Literal edit is a read-modify-write operation; the guard is the backend's atomic mutation critical section plus the optional version expectation, so concurrent edits settle deterministically — one wins, the other gets `FS_STALE_VERSION`.

**Observed state does not belong on `ctx.fs`.** Recording what an execution context has seen is workflow policy, not raw filesystem I/O. This decision first placed it inside the filesystem seam; the split-fs-seam note then established that a sandboxed/remote backend should not inherit model-facing observation policy, and moved it into the `dsh-fs-observation-policy` plugin. The provider contract keeps only what write/edit safety genuinely needs at the storage layer — a backend-minted version token and an optional version-guarded mutation — while the policy plugin owns owner derivation, observed-state, and read-before-edit gating over the `fs/*` events.

**The `resolve`-then-operate shape costs an extra round-trip per call.** Each tool may resolve a path to an `FsTarget` and then issue the read/write/edit as a separate `ctx.fs` call. For the local backend this is negligible (resolution is in-memory path normalization), but a remote/sandboxed backend may turn each step into its own request, so a single `read` can become two network round-trips. Backends where the round-trip matters can cache or fold resolution internally while preserving the observable contract.

**Observed-state persistence is deferred.** Observed state lives in memory (the `WeakMap` inside `dsh-fs-observation-policy`), so a resumed session conservatively requires files to be read again before write/edit until a future session-event or persistence mechanism makes observation replayable.

**Error codes become part of the seam.** `FsError` codes make stale-version and observation failures machine-routable through the existing structured error taxonomy. The cost is that `dsh-fs` imports the shared `HarnessError` base from `dsh-llm`; that dependency is intentional and stays limited to the error vocabulary.

**Package churn is front-loaded.** The three-package split adds boilerplate before there is more than one backend. This is intentional: filesystem access is a likely sandbox/remote boundary, and changing the package API after shipping model-facing tools would be more expensive.
