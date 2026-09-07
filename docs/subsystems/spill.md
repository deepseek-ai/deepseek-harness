# Spill Storage

English | [中文](spill.zh.md)

The spill storage [capability seam](../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.md) persists caller-provided text and returns a model-facing locator with retrieval guidance. Its Service Definition is [dsh-spill](../../packages/spill/spill) (`ctx.spillStore`), and its local Service Provider is [dsh-spill-local](../../packages/spill/spill-local). Consumers include the [tool-result policy](../../packages/spill/spill-policy) and [session references](../../packages/context/session-reference/README.md). Spill is optional, not part of the [agent-loop spine](core.md); consumers own preview and spill decisions, while storage saves the supplied text verbatim.

Source: [`packages/spill/spill/src/types.ts`](../../packages/spill/spill/src/types.ts)

## The save request

`saveText` is the sole service operation: persist `content` verbatim, return an opaque locator, a backend-supplied retrieval hint, and the exact byte count. The request carries the save-time storage namespace (`owner`), descriptive producer provenance (`source`, never access control), and a `suggestedName` the backend may use as a naming hint, not a path. Tool provenance identifies the actual tool call; session-reference provenance identifies the captured source session, while its owner is the target session receiving the context.

```ts type-equiv
/** One request to persist text to a spill artifact. */
interface SaveTextSpill {
  owner: SpillOwner
  source: SpillSource
  /**
   * A caller-suggested base name (e.g. `web_fetch.txt`). The backend sanitizes
   * it to a single safe path segment before use — it is a hint, never a path.
   */
  suggestedName: string
  /** The full text to persist (UTF-8). */
  content: string
}
```

```ts type-equiv
/**
 * Save-time storage namespace for a spilled artifact. The session id lets a
 * backend group storage under the producing session, but the returned
 * {@link SpillLocator} is the model-facing handle. Forked sessions inherit
 * locators already present in the seeded log; those artifacts are not copied or
 * re-owned, and spills produced after the fork use the child session id.
 */
interface SpillOwner {
  sessionId: SessionId
}
```

A retention-period cleanup may expire old locators with other old session artifacts; the spill seam does not define a per-session cleanup policy.

```ts type-equiv
/**
 * Producer of a spilled artifact. Tool results carry their model-issued call id;
 * session references identify the captured source session instead. Descriptive
 * provenance only, never access control.
 */
type SpillSource = {
  kind: 'tool'
  /** The tool whose result was spilled (e.g. `web_fetch`). */
  toolName: string
  /** The model-issued call id the result belongs to. */
  callId: ToolCallId
  /** A short human label for the artifact (e.g. `result`). */
  label: string
} | {
  kind: 'session-reference'
  /** Session whose projected conversation was captured. */
  sessionId: SessionId
  /** Host-provided label for the referenced session. */
  label: string
}
```

## The result

```ts type-equiv
/** A saved spill artifact: its locator, byte length, and backend-specific retrieval guidance. */
interface SpillRef {
  locator: SpillLocator
  bytes: number
  retrievalHint: string
}
```

`SpillLocator` is a [branded](core.md#branded-ids) model-facing handle returned by the backend. The local backend renders it as a filesystem path; a remote or database backend can render a URI, key, or command token. Consumers treat it as opaque and render it with `retrievalHint` instead of assuming `read` is always the right retrieval mechanism.

```ts type-equiv
/**
 * Opaque model-facing handle for one spilled artifact. A local backend may use a
 * filesystem path; a remote or database backend may use a URI or key. Consumers
 * render it with {@link SpillRef.retrievalHint}, but do not parse it.
 */
type SpillLocator = Branded<'SpillLocator'>
```

## The service

`SpillStore` (`ctx.spillStore`, defined in [`packages/spill/spill/src/index.ts`](../../packages/spill/spill/src/index.ts)) is a one-method abstract service: `saveText(input) → Promise<SpillRef>`. It persists the FULL `content` and REJECTS on a real storage failure (permissions, ENOSPC, backend unavailable). The seam owns storage only: no retention policy, no tool-result replacement, no retrieval/search API.

The local backend ([dsh-spill-local](../../packages/spill/spill-local)) writes under `<root>/session-<hash>/<random>-<safeName>` — a configured or lazily-created private (0700) root, a `sha256(sessionId)` session subdir, and an exclusive owner-only (`open(path, 'wx', 0o600)`) write so a planted symlink cannot redirect it. Its `locator` is the local path and its `retrievalHint` tells the model to use `read` or `grep` on that path. The policy consumer ([dsh-spill-policy](../../packages/spill/spill-policy)) replaces an over-`maxInlineBytes` plain-text final result with a retention-library head/tail preview plus the spill reference, best-effort: a save failure keeps the original inline result rather than turning a successful call into an `isError`.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxspillstore--spillstore-abstract-seam"></a>

### `ctx.spillStore` — `SpillStore` (abstract seam)

Abstract spill storage service. Subclass, implement saveText, and load the subclass as a plugin — it registers as `ctx.spillStore` (one implementation per context; loading a second throws, cordis' standard duplicate-service behavior).

Semantics every implementation must honor:

- saveText persists the FULL `content` verbatim and returns an opaque locator, exact byte length, and model-facing retrieval guidance.
- Storage is scoped by the request's SaveTextSpill.owner session; the backend chooses a private (not world-readable) location and a collision-free name derived from — never equal to — the caller's `suggestedName`.
- `saveText` REJECTS on a real storage failure (permissions, ENOSPC, backend unavailable); the caller decides how to degrade (the spill policy treats a rejection as best-effort and keeps the inline result).

```ts cordis-catalog
/**
 * Persist `input.content` to a session-scoped spill artifact.
 * @param input - the owner, caller-supplied source fields, suggested name, and full text to save.
 * @returns the saved artifact's {@link SpillRef}; rejects on a storage failure.
 */
abstract saveText(input: SaveTextSpill): Promise<SpillRef>
```

Source: [`packages/spill/spill/src/index.ts`](../../packages/spill/spill/src/index.ts)
<!-- END GENERATED cordis-surface -->
