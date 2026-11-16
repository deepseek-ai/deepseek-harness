# Working Directory

English | [中文](working-directory.zh.md)

A Session's active directory is owned by [`dsh-working-directory`](../../packages/session/working-directory/README.md). The immutable header identifies the original project; `workspace-root/change` records each move of the directory used by later directory-based operations. The generated [persistence catalog](../persistence-catalog.md) owns the event declaration.

## Directory selection

`ctx.workingDirectory.get(session)` reads the logged value. `ensure(agent)` validates it and restores the original project when the directory disappeared. `set(agent, path)` validates and records a move that a Host operation chose, such as worktree creation, the forge panel, or an SDK request; the model has no tool that moves the directory. Sessions without a header directory use the configured runtime fallback; an unavailable fallback produces an error.

`get` is the one read of a Session's directory: relative paths resolve from it, and it is the workspace root for everything that follows the Session's checkout. Every change the service records is a `workspace-root/change`. A log written while the model could move the directory holds `working-directory/change` events, which have no writer now. The service ignores them: such a Session resumes in its original project, or in the directory of its last `workspace-root/change`, and the next request's context reports the directory.

Changes are local to one Session. Relative filesystem operations, newly started processes, instruction discovery, skills, and file completion use the active directory. Existing terminals and persistent shells retain their own directories. Sandbox writable roots and project membership remain anchored to the original project.

## Model context

The initial value and subsequent current values reach the model as required user-context snapshots, even when optional runtime context is disabled. Each committed change attempts to queue a notice through the ordinary Agent inbox; cancellation or disposal can discard notices before request admission. The directory event survives, and the next admitted request receives the current value. Directory context never enters the system prompt.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxworkingdirectory--workingdirectoryservice"></a>

### `ctx.workingDirectory` — `WorkingDirectoryService`

One owner for each Session's directory and its model-visible changes.

A Session works in one directory. Relative paths resolve from it, and it is the workspace root that the write boundary, file views, and discovery follow. Only Host operations move it, through set or the recovery of ensure. The `working-directory/change` events of a log written while the model could move the directory do not move it.

```ts cordis-catalog
/**
 * Read the committed directory without filesystem I/O: where relative paths resolve, and the workspace
 * root of everything that follows the Session's checkout.
 * @param session - Session whose directory is requested.
 * @returns the directory of the last Host move, the original project before any, or the deployment
 * default when none is recorded.
 */
get(session: Session): string

/**
 * Validate the current directory and restore the original project when it disappeared.
 * @param agent - live or unpublished Agent owning the Session.
 * @param signal - cancellation for filesystem inspection.
 * @returns the existing directory; recovery is committed before fulfillment. A notice failure is
 * warned without reverting the committed state.
 * @throws {@link WorkingDirectoryError} `WORKING_DIRECTORY_UNAVAILABLE` when the original project is also
 *   unavailable or the service is disposed, or the rejection of a `working-directory/access` listener.
 */
ensure(agent: Agent, signal?: AbortSignal): Promise<string>

/**
 * Move one Session's directory to `path`. Existing processes keep their directories. Callers are
 * Host operations that chose the directory; a model-supplied path would move the workspace-write
 * boundary with it.
 * @param agent - live or unpublished Agent owning the Session.
 * @param path - absolute path or a path relative to its current directory.
 * @param signal - cancellation before the durable change.
 * @returns the canonical absolute directory, committed before fulfillment.
 * A notice failure is warned; the next request still receives the committed directory.
 * @throws {@link WorkingDirectoryError} `WORKING_DIRECTORY_INVALID` for an empty path and
 *   `WORKING_DIRECTORY_NOT_FOUND` when the path is not an existing directory, or the rejection of a
 *   `working-directory/access` listener.
 */
set(agent: Agent, path: string, signal?: AbortSignal): Promise<string>
```

Types: [Agent](core.md) · [Session](session.md)

Source: [`packages/session/working-directory/src/index.ts`](../../packages/session/working-directory/src/index.ts)

<a id="working-directory-events"></a>

### `working-directory/*` events

<a id="working-directoryaccess--waterfall"></a>

#### `working-directory/access` — waterfall

Coordinate directory validation and publication with a resource operation on the directory, such as a checkout being removed. A listener that must wait awaits that operation, then calls `next()`; every other listener calls `next()` at once. A rejection fails this access and leaves the recorded directory unchanged; it is not a fallback.

```ts cordis-catalog
/**
 * Coordinate directory validation and publication with a resource operation
 * on the directory, such as a checkout being removed. A listener that must
 * wait awaits that operation, then calls `next()`; every other listener
 * calls `next()` at once. A rejection fails this access and leaves the
 * recorded directory unchanged; it is not a fallback.
 * @param request - owner, requested path (null validates the current directory), and the access's cancellation.
 * @param next - perform validation and commit.
 * @mode waterfall
 */
'working-directory/access'( request: { agent: Agent; path: string | null; signal: AbortSignal }, next: () => Promise<string>, ): Promise<string>
```

Types: [Agent](core.md)

Source: [`packages/session/working-directory/src/index.ts`](../../packages/session/working-directory/src/index.ts)
<!-- END GENERATED cordis-surface -->
