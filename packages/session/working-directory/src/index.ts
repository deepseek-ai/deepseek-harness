/**
 * Session working directories, durable changes, and model context.
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
import { WorkingDirectoryError } from './error.ts'

export type * from './types.ts'
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
    /**
     * Directory change recorded by releases whose model could move the directory. A reader keeps `cwd` only
     * when it lies inside the Session's original project; otherwise the Session returns to that project.
     * @deprecated Read only: no writer records this event. `WorkingDirectoryService.set` records
     * `workspace-root/change`.
     */
    'working-directory/change': {
      /** Absolute directory the Session worked in after the change. */
      cwd: string
    }
    /** Host move of the Session's directory; the immutable Session header retains the original project. */
    'workspace-root/change': {
      /** Absolute directory the Session works in from this event on. */
      cwd: string
    }
  }
}

/** Deployment default for Sessions without an original project directory. */
export interface Config {
  /** Absolute execution-world fallback directory; omitted values use the launch directory. */
  defaultDirectory?: string
}

/** The `workingDirectory` fold state. */
interface DirectoryState {
  /** Original project, or the first recorded directory of a Session without one; null before either. */
  readonly project: string | null
  /** Directory the Session works in, or null when none is recorded. */
  readonly cwd: string | null
}

/**
 * Whether `path` is `root` or lies below it. Both are absolute paths of one execution world; the test is
 * lexical, so a recorded directory is compared with the spelling the Session header recorded.
 */
function within(root: string, path: string): boolean {
  const rest = relative(root, path)
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
}

function moved(state: DirectoryState, cwd: string): DirectoryState {
  return state.cwd === cwd ? state : { project: state.project ?? cwd, cwd }
}

/**
 * One owner for each Session's directory and its model-visible changes.
 *
 * A Session works in one directory. Relative paths resolve from it, and it is the workspace root that
 * the write boundary, file views, and discovery follow. Only Host operations move it, through {@link set}
 * or the recovery of {@link ensure}. A log written while the model could move the directory is read under
 * the rule the `working-directory/change` event documents.
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

  private projection!: ProjectionHandle<DirectoryState>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'workingDirectory')
    const directory = config.defaultDirectory ?? process.cwd()
    if (!isAbsolute(directory)) throw new Error('working-directory: defaultDirectory must be absolute')
    this.defaultDirectory = directory
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    const directorySchema = zod.string().min(1).refine(isAbsolute).nullable()
    this.projection = await ctx.sessionProjections.register({
      key: 'workingDirectory',
      stateVersion: 2,
      stateSchema: zod.object({ project: directorySchema, cwd: directorySchema }).strict(),
      init: header => ({ project: header.cwd ?? null, cwd: header.cwd ?? null }),
      apply: (state, event) => {
        if (event.type === 'workspace-root/change') return moved(state, event.data.cwd)
        if (event.type !== 'working-directory/change') return state
        // The model chose some of these directories; one outside the project must not become the workspace.
        return moved(state, state.project === null || within(state.project, event.data.cwd) ? event.data.cwd : state.project)
      },
      wire: { viewSchema: directorySchema, view: state => state.cwd },
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
   * Read the committed directory without filesystem I/O: where relative paths resolve, and the workspace
   * root of everything that follows the Session's checkout.
   * @param session - Session whose directory is requested.
   * @returns the directory of the last Host move, the original project before any, or the deployment
   * default when none is recorded.
   */
  get(session: Session): string {
    return this.projection.stateOf(session).cwd ?? this.defaultDirectory
  }

  /**
   * Validate the current directory and restore the original project when it disappeared.
   * @param agent - live or unpublished Agent owning the Session.
   * @param signal - cancellation for filesystem inspection.
   * @returns the existing directory; recovery is committed before fulfillment. A notice failure is
   * warned without reverting the committed state.
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
        if (this.projection.stateOf(agent.session).cwd === null) {
          agent.session.append('workspace-root/change', { cwd: current })
        }
        return current
      }
      const original = agent.session.header.cwd ?? this.defaultDirectory
      const restored = await this.directory(original, original, control, () => new WorkingDirectoryError(
        `working-directory: directory does not exist: ${JSON.stringify(original)}; the current working directory ${JSON.stringify(current)} is also unavailable`,
        'WORKING_DIRECTORY_UNAVAILABLE',
      ))
      this.commit(agent, restored, true, control)
      return restored
    }))
  }

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
  set(agent: Agent, path: string, signal?: AbortSignal): Promise<string> {
    return this.serialize(agent, signal, control => this.ctx.waterfall('working-directory/access', { agent, path, signal: control }, async () => {
      if (path.length === 0) throw new WorkingDirectoryError('working-directory: path must not be empty', 'WORKING_DIRECTORY_INVALID')
      const directory = await this.directory(path, this.get(agent.session), control)
      this.commit(agent, directory, false, control)
      return directory
    }))
  }

  private contextText(session: Session): string {
    return `Current working directory: ${JSON.stringify(this.get(session))}.`
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

  private commit(agent: Agent, directory: string, recovered: boolean, signal: AbortSignal): void {
    signal.throwIfAborted()
    agent.ctx.fiber.assertActive()
    const previous = this.get(agent.session)
    if (previous === directory) return
    agent.session.append('workspace-root/change', { cwd: directory })
    const notice = createUserMessage({
      content: [{
        type: 'text',
        text: recovered
          ? `The working directory ${JSON.stringify(previous)} is unavailable. The working directory is now ${JSON.stringify(directory)}.`
          : `The working directory changed from ${JSON.stringify(previous)} to ${JSON.stringify(directory)}.`,
      }],
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
