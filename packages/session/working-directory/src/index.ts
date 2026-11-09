/**
 * Session working directories, workspace roots, durable changes, and model context.
 * @module @deepseek-ai/dsh-working-directory
 */

import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { WorkingDirectoryError } from './error.ts'
import { within } from './within.ts'

export { WorkingDirectoryError, type WorkingDirectoryErrorCode } from './error.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
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
    'working-directory/access'(
      request: { agent: Agent; path: string | null; signal: AbortSignal },
      next: () => Promise<string>,
    ): Promise<string>
  }
  interface Context {
    workingDirectory: WorkingDirectoryService
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Committed working-directory transition notices.
     * @persistenceAttribution
     */
    'working-directory': { kind: 'working-directory' }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Effective working directory; the immutable Session header retains the original project. */
    'working-directory/change': {
      /** Absolute directory used by subsequent directory-based operations. */
      cwd: string
      /**
       * Absolute checkout directory this change registers as a workspace anchor of the Session; it contains `cwd`.
       * Present only when the change enters another checkout, such as a created worktree; an ordinary `cd` omits it.
       */
      anchor?: string
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Recorded current directory for Session observations, or null when none is recorded. */
    workingDirectory: string | null
    /** Workspace root: the registered anchor containing the current directory, or null when none is recorded. */
    workspaceRoot: string | null
  }
}

/** Deployment default for Sessions without an original project directory. */
export interface Config {
  /** Absolute execution-world fallback directory; omitted values use the launch directory. */
  defaultDirectory?: string
}

/** Options of {@link WorkingDirectoryService.relocate}. */
export interface RelocateOptions {
  /** Directory to enter inside the new root, absolute or relative to that root; omission enters the root itself. */
  cwd?: string
  /** Cancellation before the durable change. */
  signal?: AbortSignal
}

/** Options of {@link WorkingDirectoryService.inherit}. */
export interface InheritOptions {
  /** Canonical absolute directory the Session starts in, spelled as the service records directories. */
  cwd: string
  /** Cancellation before the durable change. */
  signal?: AbortSignal
}

/** The committed outcome of {@link WorkingDirectoryService.relocate} and {@link WorkingDirectoryService.inherit}. */
export interface RelocatedDirectories {
  /**
   * Canonical absolute workspace root the commit selected: the longest registered anchor containing
   * `cwd`. This is the registered root unless a more specific anchor, such as an original project
   * inside it, already contains `cwd`.
   */
  root: string
  /** Canonical absolute current directory inside `root`. */
  cwd: string
}

/** Workspace anchors and the root they select, folded from the Session log. */
interface WorkspaceRootState {
  /** The longest registered anchor containing the current directory, or null while no anchor contains it. */
  root: string | null
  /** Registered anchors in registration order; the original project comes first when the header records one. */
  anchors: string[]
}

/** The longest anchor containing `path`, or undefined when none does. */
function anchorContaining(anchors: readonly string[], path: string): string | undefined {
  let selected: string | undefined
  for (const anchor of anchors) {
    if (within(anchor, path) && (selected === undefined || anchor.length > selected.length)) selected = anchor
  }
  return selected
}

/**
 * One owner for each Session's effective directory, its workspace root, and their model-visible changes.
 *
 * The current directory is the cursor every relative path resolves from. The
 * workspace root is the checkout that cursor is in: the longest registered
 * anchor containing it. Anchors are the original project plus every checkout a
 * {@link relocate} entered, so an ordinary {@link set} inside the root moves
 * only the cursor, a `set` into another anchor switches the root to that
 * anchor, and a `set` outside every anchor moves the cursor and leaves the root.
 */
export class WorkingDirectoryService extends Service {
  static inject = ['fs', 'sessionProjections', 'systemPrompt']

  static Config: z<Config> = z.object({
    defaultDirectory: z.string(),
  })

  /** Absolute deployment fallback for Sessions with no recorded original directory. */
  readonly defaultDirectory: string
  private readonly pending = new WeakMap<Session, Promise<void>>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly lifecycle = new AbortController()

  private workingDirectoryProjectionHandle!: ProjectionHandle<string | null>
  private workspaceRootProjectionHandle!: ProjectionHandle<WorkspaceRootState>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'workingDirectory')
    const directory = config.defaultDirectory ?? process.cwd()
    if (!isAbsolute(directory)) throw new Error('working-directory: defaultDirectory must be absolute')
    this.defaultDirectory = directory
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    const directorySchema = zod.string().min(1).refine(isAbsolute).nullable()
    const anchorSchema = zod.string().min(1).refine(isAbsolute)
    this.workingDirectoryProjectionHandle = await ctx.sessionProjections.register({
      key: 'workingDirectory',
      stateVersion: 1,
      stateSchema: directorySchema,
      init: header => header.cwd ?? null,
      apply: (state, event) => event.type === 'working-directory/change' ? event.data.cwd : state,
      wire: { viewSchema: directorySchema, view: state => state },
    })
    this.workspaceRootProjectionHandle = await ctx.sessionProjections.register({
      key: 'workspaceRoot',
      stateVersion: 1,
      stateSchema: zod.object({ root: directorySchema, anchors: zod.array(anchorSchema) }),
      init: header => header.cwd === undefined ? { root: null, anchors: [] } : { root: header.cwd, anchors: [header.cwd] },
      apply: (state, event) => {
        if (event.type !== 'working-directory/change') return state
        const { cwd, anchor } = event.data
        const anchors = anchor === undefined || state.anchors.includes(anchor) ? state.anchors : [...state.anchors, anchor]
        const root = anchorContaining(anchors, cwd) ?? state.root
        return root === state.root && anchors === state.anchors ? state : { root, anchors }
      },
      wire: { viewSchema: directorySchema, view: state => state.root },
    })
    ctx.systemPrompt.context({
      name: 'working-directory:current',
      order: ctx.systemPrompt.getContextOrder('WORKING_DIRECTORY'),
      required: true,
      interpolate: false,
      text: context => context.agent === undefined ? '' : this.contextText(context.agent.session),
    })
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (context.agent === undefined) return next()
      await this.ensure(context.agent, context.signal)
      const assembly = await next()
      this.lifecycle.signal.throwIfAborted()
      const text = this.contextText(context.agent.session)
      const contribution = assembly.contexts.find(entry => entry.name === 'working-directory:current')
      if (contribution === undefined) assembly.contexts.unshift({ name: 'working-directory:current', text, interpolate: false })
      else {
        contribution.text = text
        contribution.interpolate = false
      }
      return assembly
    }, { prepend: true })
    ctx.effect(() => async () => {
      this.lifecycle.abort(new WorkingDirectoryError('working-directory service disposed', 'WORKING_DIRECTORY_UNAVAILABLE'))
      await Promise.allSettled(this.operations)
    })
  }

  /**
   * Read the committed directory without filesystem I/O.
   * @param session - Session whose directory is requested.
   * @returns its effective absolute directory.
   */
  get(session: Session): string {
    return this.workingDirectoryProjectionHandle.stateOf(session) ?? this.defaultDirectory
  }

  /**
   * Read the committed workspace root without filesystem I/O.
   * @param session - Session whose root is requested.
   * @returns the registered anchor containing the current directory, or the deployment default when none is recorded.
   */
  rootOf(session: Session): string {
    return this.workspaceRootProjectionHandle.stateOf(session).root ?? this.defaultDirectory
  }

  /**
   * Read the registered workspace anchors without filesystem I/O.
   * @param session - Session whose anchors are requested.
   * @returns anchors in registration order, the original project first when the header records one.
   */
  anchorsOf(session: Session): readonly string[] {
    return this.workspaceRootProjectionHandle.stateOf(session).anchors
  }

  /**
   * Validate the current directory and restore the original project when it disappeared.
   * @param agent - live or unpublished Agent owning the Session.
   * @param signal - cancellation for filesystem inspection.
   * @returns the existing directory; recovery is committed before fulfillment.
   * A Session without a recorded project records the deployment fallback as its first anchor on its
   * first validation, and a recovery destination outside every anchor joins the anchors.
   * A notice failure is warned without reverting the committed state.
   * @throws {@link WorkingDirectoryError} `WORKING_DIRECTORY_UNAVAILABLE` when the original project is also
   *   unavailable or the service is disposed, or the rejection of a `working-directory/access` listener.
   */
  ensure(agent: Agent, signal?: AbortSignal): Promise<string> {
    return this.serialize(agent, signal, control => this.ctx.waterfall('working-directory/access', { agent, path: null, signal: control }, async () => {
      const current = this.get(agent.session)
      const target = await this.ctx.fs.resolve(current, { signal: control })
      const info = await this.ctx.fs.stat(target, control)
      control.throwIfAborted()
      agent.ctx.fiber.assertActive()
      if (info?.type === 'directory') {
        if (this.workingDirectoryProjectionHandle.stateOf(agent.session) === null) {
          // A Session without a recorded project records the deployment fallback as its first anchor.
          const fallback = this.ctx.fs.processPath(target)
          agent.session.append('working-directory/change', { cwd: fallback, anchor: fallback })
          return fallback
        }
        return current
      }
      const original = agent.session.header.cwd ?? this.defaultDirectory
      const restored = await this.directory(original, original, control, () => new WorkingDirectoryError(
        `working-directory: directory does not exist: ${JSON.stringify(original)}; the current working directory ${JSON.stringify(current)} is also unavailable`,
        'WORKING_DIRECTORY_UNAVAILABLE',
      ))
      // A destination no anchor contains, such as a header recorded by another spelling, becomes one.
      const anchor = anchorContaining(this.anchorsOf(agent.session), restored) === undefined ? restored : undefined
      this.commit(agent, restored, true, control, anchor)
      return restored
    }))
  }

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
   * @throws {@link WorkingDirectoryError} `WORKING_DIRECTORY_INVALID` for an empty path and
   *   `WORKING_DIRECTORY_NOT_FOUND` when the path is not an existing directory, or the rejection of a
   *   `working-directory/access` listener.
   */
  set(agent: Agent, path: string, signal?: AbortSignal): Promise<string> {
    return this.serialize(agent, signal, control => this.ctx.waterfall('working-directory/access', { agent, path, signal: control }, async () => {
      if (path.length === 0) throw new WorkingDirectoryError('working-directory: cd must not be empty', 'WORKING_DIRECTORY_INVALID')
      const directory = await this.directory(path, this.get(agent.session), control)
      this.commit(agent, directory, false, control)
      return directory
    }))
  }

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
   * @throws {@link WorkingDirectoryError} `WORKING_DIRECTORY_INVALID` for an empty path or a directory outside
   *   the root and `WORKING_DIRECTORY_NOT_FOUND` when either path is not an existing directory.
   */
  relocate(agent: Agent, root: string, options: RelocateOptions = {}): Promise<RelocatedDirectories> {
    return this.serialize(agent, options.signal, async (control) => {
      if (root.length === 0) throw new WorkingDirectoryError('working-directory: root must not be empty', 'WORKING_DIRECTORY_INVALID')
      if (options.cwd !== undefined && options.cwd.length === 0) {
        throw new WorkingDirectoryError('working-directory: cwd must not be empty', 'WORKING_DIRECTORY_INVALID')
      }
      const anchor = await this.directory(root, this.get(agent.session), control)
      const cwd = options.cwd === undefined ? anchor : await this.directory(options.cwd, anchor, control)
      if (!within(anchor, cwd)) {
        throw new WorkingDirectoryError(
          `working-directory: ${JSON.stringify(cwd)} lies outside the workspace root ${JSON.stringify(anchor)}`, 'WORKING_DIRECTORY_INVALID',
        )
      }
      if (agent.session.header.cwd === undefined && this.anchorsOf(agent.session).length === 0) {
        // The deployment fallback is the recovery destination; registering it first lets leaving the checkout select it.
        const fallback = await this.directory(this.defaultDirectory, this.defaultDirectory, control)
        agent.session.append('working-directory/change', { cwd: this.get(agent.session), anchor: fallback })
      }
      this.commit(agent, cwd, false, control, anchor)
      return { root: this.rootOf(agent.session), cwd }
    })
  }

  /**
   * Start a Session's directories from another Session's. When `source` works in a registered checkout
   * other than the starting Session's own original project and `options.cwd` lies inside that checkout,
   * the checkout is registered as the starting Session's anchor and `cwd` entered through {@link relocate};
   * otherwise only the current directory is set through {@link set}. Only the source's current root is
   * passed on, never its other anchors, and later changes to `source` do not reach the starting Session.
   * @param agent - live or unpublished Agent owning the Session that starts.
   * @param source - Session whose current root may be passed on; the call leaves it unchanged.
   * @param options - canonical absolute directory to start in and cancellation before the durable change.
   * @returns the committed current directory and the workspace root selected after the commit.
   * @throws {@link WorkingDirectoryError} `WORKING_DIRECTORY_NOT_FOUND` when `options.cwd` is not an existing
   *   directory, or the rejection of a `working-directory/access` listener.
   */
  async inherit(agent: Agent, source: Session, options: InheritOptions): Promise<RelocatedDirectories> {
    const root = this.rootOf(source)
    // The deployment fallback a source without a recorded project reports is no anchor, and the starting
    // Session's own original project is registered already.
    const checkout = this.anchorsOf(source).includes(root) && root !== agent.session.header.cwd && within(root, options.cwd)
    if (checkout) return this.relocate(agent, root, options)
    const cwd = await this.set(agent, options.cwd, options.signal)
    return { root: this.rootOf(agent.session), cwd }
  }

  private contextText(session: Session): string {
    const cwd = this.get(session)
    const root = this.rootOf(session)
    const current = `Current working directory: ${JSON.stringify(cwd)}.`
    return root === cwd ? current : `${current}\nWorkspace root: ${JSON.stringify(root)}.`
  }

  private async directory(
    path: string,
    cwd: string,
    signal: AbortSignal,
    missing = (): WorkingDirectoryError => new WorkingDirectoryError(
      `working-directory: directory does not exist: ${JSON.stringify(path)}`,
      'WORKING_DIRECTORY_NOT_FOUND',
    ),
  ): Promise<string> {
    const target = await this.ctx.fs.resolve(path, { cwd, signal })
    const info = await this.ctx.fs.stat(target, signal)
    signal.throwIfAborted()
    if (info?.type !== 'directory') throw missing()
    return this.ctx.fs.processPath(target)
  }

  private commit(agent: Agent, directory: string, recovered: boolean, signal: AbortSignal, anchor?: string): void {
    signal.throwIfAborted()
    agent.ctx.fiber.assertActive()
    const session = agent.session
    const previous = this.get(session)
    const previousRoot = this.rootOf(session)
    if (previous === directory && (anchor === undefined || this.anchorsOf(session).includes(anchor))) return
    session.append('working-directory/change', { cwd: directory, ...anchor === undefined ? {} : { anchor } })
    const root = this.rootOf(session)
    const rootChange = root === previousRoot ? '' : `${JSON.stringify(root)} is now the workspace root.`
    const directoryChange = previous === directory
      ? ''
      : recovered
        ? `The working directory ${JSON.stringify(previous)} is unavailable. The working directory is now ${JSON.stringify(directory)}.`
        : `The working directory changed from ${JSON.stringify(previous)} to ${JSON.stringify(directory)}.`
    const text = [directoryChange, rootChange].filter(part => part !== '').join(' ')
    if (text === '') return
    const notice = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'working-directory' },
    })
    try {
      agent.inject(notice)
    } catch (error) {
      this.ctx.logger.warn(`working-directory: committed ${JSON.stringify(directory)}, but could not queue its notice: ${String(error)}`)
    }
  }

  private serialize<T>(agent: Agent, signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const session = agent.session
    const control = signal === undefined
      ? this.lifecycle.signal
      : AbortSignal.any([this.lifecycle.signal, signal])
    const operation = (this.pending.get(session) ?? Promise.resolve()).then(() => {
      control.throwIfAborted()
      agent.ctx.fiber.assertActive()
      return action(control)
    })
    const settled = operation.finally(() => this.operations.delete(settled))
    this.operations.add(settled)
    this.pending.set(session, settled.then(() => {}, () => {}))
    return settled
  }
}

export default WorkingDirectoryService
