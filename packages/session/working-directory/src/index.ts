/**
 * Session working directories, workspace roots, durable changes, and model context.
 * @module @deepseek-ai/dsh-working-directory
 */

import { isAbsolute, relative, sep } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'

declare module '@deepseek-ai/cordis' {
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

/** The committed outcome of {@link WorkingDirectoryService.relocate}. */
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

/**
 * Whether `path` is `root` or lies below it. Both paths are canonical absolute
 * paths of one execution world; the test is lexical and never touches the filesystem.
 * @param root - canonical absolute directory.
 * @param path - canonical absolute path to test.
 * @returns true for `root` itself and every path below it.
 */
export function within(root: string, path: string): boolean {
  const rest = relative(root, path)
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
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
      this.lifecycle.abort(new Error('working-directory service disposed'))
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
   * @throws when the original project is also unavailable.
   */
  ensure(agent: Agent, signal?: AbortSignal): Promise<string> {
    return this.serialize(agent, signal, async (control) => {
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
      const restored = await this.directory(original, original, control)
      // A destination no anchor contains, such as a header recorded by another spelling, becomes one.
      const anchor = anchorContaining(this.anchorsOf(agent.session), restored) === undefined ? restored : undefined
      this.commit(agent, restored, true, control, anchor)
      return restored
    })
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
   * @throws when the requested path is not an existing directory.
   */
  set(agent: Agent, path: string, signal?: AbortSignal): Promise<string> {
    return this.serialize(agent, signal, async (control) => {
      if (path.length === 0) throw new Error('working-directory: cd must not be empty')
      const directory = await this.directory(path, this.get(agent.session), control)
      this.commit(agent, directory, false, control)
      return directory
    })
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
   * @throws when either path is not an existing directory or the directory lies outside the root.
   */
  relocate(agent: Agent, root: string, options: RelocateOptions = {}): Promise<RelocatedDirectories> {
    return this.serialize(agent, options.signal, async (control) => {
      if (root.length === 0) throw new Error('working-directory: root must not be empty')
      if (options.cwd !== undefined && options.cwd.length === 0) throw new Error('working-directory: cwd must not be empty')
      const anchor = await this.directory(root, this.get(agent.session), control)
      const cwd = options.cwd === undefined ? anchor : await this.directory(options.cwd, anchor, control)
      if (!within(anchor, cwd)) {
        throw new Error(`working-directory: ${JSON.stringify(cwd)} lies outside the workspace root ${JSON.stringify(anchor)}`)
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

  private contextText(session: Session): string {
    const cwd = this.get(session)
    const root = this.rootOf(session)
    const current = `Current working directory: ${JSON.stringify(cwd)}.`
    return root === cwd ? current : `${current}\nWorkspace root: ${JSON.stringify(root)}.`
  }

  private async directory(path: string, cwd: string, signal: AbortSignal): Promise<string> {
    const target = await this.ctx.fs.resolve(path, { cwd, signal })
    const info = await this.ctx.fs.stat(target, signal)
    signal.throwIfAborted()
    if (info?.type !== 'directory') {
      throw new Error(`working-directory: directory does not exist: ${JSON.stringify(path)}`)
    }
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
