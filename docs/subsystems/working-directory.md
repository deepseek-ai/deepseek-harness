# Working Directory

English | [中文](working-directory.zh.md)

A Session's active directory is owned by [`dsh-working-directory`](../../packages/session/working-directory/README.md). The immutable header identifies the original project; `working-directory/change` records the effective directory used by later directory-based operations. The generated [persistence catalog](../persistence-catalog.md) owns the event declaration.

## Directory selection

`ctx.workingDirectory.get(session)` reads the logged value. `ensure(agent)` validates it and restores the original project when the directory disappeared. `set(agent, path)` validates and records a requested change. Sessions without a header directory use the configured runtime fallback; an unavailable fallback produces an error.

`rootOf(session)` reads the workspace root: the longest registered anchor that contains the current directory. The anchors are the original project and every checkout `relocate(agent, root, { cwd? })` entered; that operation validates the root and the directory inside it, then records both in one `working-directory/change` whose `anchor` names the root. `anchorsOf(session)` lists them. A `set` inside the root moves only the current directory; a `set` into another anchor selects that anchor as the root; a `set` outside every anchor leaves the root unchanged. Recovery to the original project selects it as the root again. Anchors compare lexically on canonical paths: producers record the original project by its canonical spelling, a Session without a recorded project registers the deployment fallback as its first anchor, and a recovery destination outside every anchor joins the anchors.

Changes are local to one Session. The model's relative filesystem operations and the processes its tools start use the current directory. What the user sees follows the workspace root: the sandbox `workspace-write` boundary, the Files tree and directory listings, the change summaries, new sidebar terminals, `@` file completion, the skill catalog, project-instruction discovery, and the LSP workspace. Existing terminals and persistent shells retain their own directories. Project membership remains anchored to the original project.

## Model context

The initial value and subsequent current values reach the model as required user-context snapshots, even when optional runtime context is disabled; a snapshot adds a `Workspace root` line while the current directory differs from the root. Each committed change attempts to queue a notice through the ordinary Agent inbox, and a change that selects another root ends its notice with that root; cancellation or disposal can discard notices before request admission. The directory event survives, and the next admitted request receives the current value. Directory context never enters the system prompt. [`working_directory`](../../packages/session/tool-working-directory/README.md) exposes one optional `cd` argument.

## Relocation

`relocate` takes the new root and these options, and resolves to the directories it committed.

```ts type-equiv
/** Options of {@link WorkingDirectoryService.relocate}. */
interface RelocateOptions {
  /** Directory to enter inside the new root, absolute or relative to that root; omission enters the root itself. */
  cwd?: string
  /** Cancellation before the durable change. */
  signal?: AbortSignal
}
```

```ts type-equiv
/** The committed outcome of {@link WorkingDirectoryService.relocate}. */
interface RelocatedDirectories {
  /**
   * Canonical absolute workspace root the commit selected: the longest registered anchor containing
   * `cwd`. This is the registered root unless a more specific anchor, such as an original project
   * inside it, already contains `cwd`.
   */
  root: string
  /** Canonical absolute current directory inside `root`. */
  cwd: string
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxworkingdirectory--workingdirectoryservice"></a>

### `ctx.workingDirectory` — `WorkingDirectoryService`

One owner for each Session's effective directory, its workspace root, and their model-visible changes.

The current directory is the cursor every relative path resolves from. The workspace root is the checkout that cursor is in: the longest registered anchor containing it. Anchors are the original project plus every checkout a relocate entered, so an ordinary set inside the root moves only the cursor, a `set` into another anchor switches the root to that anchor, and a `set` outside every anchor moves the cursor and leaves the root.

```ts cordis-catalog
/**
 * Read the committed directory without filesystem I/O.
 * @param session - Session whose directory is requested.
 * @returns its effective absolute directory.
 */
get(session: Session): string

/**
 * Read the committed workspace root without filesystem I/O.
 * @param session - Session whose root is requested.
 * @returns the registered anchor containing the current directory, or the deployment default when none is recorded.
 */
rootOf(session: Session): string

/**
 * Read the recorded workspace root without the deployment fallback and without filesystem I/O.
 * @param session - Session whose root is requested.
 * @returns the longest registered anchor containing the current directory, or undefined while the
 * log registers no anchor; consumers apply their own fallback.
 */
recordedRootOf(session: Session): string | undefined

/**
 * Read the registered workspace anchors without filesystem I/O.
 * @param session - Session whose anchors are requested.
 * @returns anchors in registration order, the original project first when the header records one.
 */
anchorsOf(session: Session): readonly string[]

/**
 * Validate the current directory and restore the original project when it disappeared.
 * @param agent - live or unpublished Agent owning the Session.
 * @param signal - cancellation for filesystem inspection.
 * @returns the existing directory; recovery is committed before fulfillment.
 * A Session without a recorded project records the deployment fallback as its first anchor on its
 * first validation, and a recovery destination outside every anchor joins the anchors.
 * A notice failure is warned without reverting the committed state.
 * @throws when the original project is also unavailable.
 */
ensure(agent: Agent, signal?: AbortSignal): Promise<string>

/**
 * Change one Session's directory without changing existing processes or permissions.
 * The workspace root follows the registered anchors: a path inside the current
 * root keeps it, a path inside another anchor selects that anchor, and a path
 * outside every anchor leaves the root unchanged.
 * @param agent - live or unpublished Agent owning the Session.
 * @param path - absolute path or a path relative to its current directory.
 * @param signal - cancellation before the durable change.
 * @returns the canonical absolute directory, committed before fulfillment.
 * A notice failure is warned; the next request still receives the committed directory.
 * @throws when the requested path is not an existing directory.
 */
set(agent: Agent, path: string, signal?: AbortSignal): Promise<string>

/**
 * Enter another checkout: register `root` as a workspace anchor of the Session and
 * move its current directory to `options.cwd`, or to the root itself. One committed
 * event carries both; existing processes and permissions are unchanged.
 * @param agent - live or unpublished Agent owning the Session.
 * @param root - absolute checkout directory, or a path relative to the current directory.
 * @param options - directory to enter inside the root and cancellation before the durable change.
 * @returns the committed current directory and the workspace root selected after the commit;
 * the registered root is that root unless a more specific anchor already contains the directory.
 * A notice failure is warned; the next request still receives the committed directories.
 * @throws when either path is not an existing directory or the directory lies outside the root.
 */
relocate(agent: Agent, root: string, options: RelocateOptions = {}): Promise<RelocatedDirectories>
```

Types: [Agent](core.md) · [Session](session.md)

Source: [`packages/session/working-directory/src/index.ts`](../../packages/session/working-directory/src/index.ts)
<!-- END GENERATED cordis-surface -->
