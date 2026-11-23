/**
 * Grants each Session that works in a linked Git worktree write access to the Git directory the worktree
 * shares with its repository, through `ctx.sandboxPolicy.registerWritableRoot`. The grant follows the
 * Session's directory and is never stored; the [README](../README.md) states when the layout is read.
 * @module @deepseek-ai/dsh-sandbox-policy-git
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-working-directory'
import { directoryAt, linkedWorktree, within } from './linked-worktree.ts'
import type { LinkedWorktree } from './linked-worktree.ts'

/** Cordis plugin name. */
export const name = 'sandbox-policy-git'
/** Services that read the Git layout, hold the grant, and report the Session's directory. */
export const inject = ['fs', 'sandboxPolicy', 'workingDirectory']

/** One Session's registered Git directory, with the Session directory it was read for. */
interface Grant {
  readonly root: string
  readonly directory: string
  readonly dispose: () => void
}

/**
 * Keep one grant per live Session in step with the directory it works in. Windows process confinement
 * ignores additional writable directories, so the plugin registers nothing there.
 * @param ctx - plugin context that owns every registration.
 */
export function apply(ctx: Context): void {
  if (process.platform === 'win32') return
  const grants = new WeakMap<Session, Grant>()
  const warned = new WeakMap<Session, string>()
  const disposed = new WeakSet<Agent>()
  const reads = new Set<Promise<void>>()
  const lifetime = new AbortController()
  ctx.effect(() => async () => {
    lifetime.abort(new Error('sandbox-policy-git disposed'))
    await Promise.allSettled(reads)
  })

  const release = (session: Session): void => {
    grants.get(session)?.dispose()
    grants.delete(session)
  }

  /**
   * Whether the Session can already write the pointer files that name `found.common`, through a directory
   * another party granted it. Such files prove nothing about a directory the Session does not hold yet. The
   * layout itself excludes an administration directory inside the Session's workspace root.
   */
  const forgeable = async (session: Session, found: LinkedWorktree, signal: AbortSignal): Promise<boolean> => {
    if (grants.get(session)?.directory === found.common) return false
    for (const granted of ctx.sandboxPolicy.resolve({ session }).additionalWritableRoots ?? []) {
      const directory = await directoryAt(ctx.fs, granted, granted, signal)
      if (directory !== undefined && within(directory, found.administration)) return true
    }
    return false
  }

  /** Read the layout of `root` and replace the Session's grant with its result; never rejects. */
  const read = async (agent: Agent, root: string, caller: AbortSignal | undefined): Promise<void> => {
    const session = agent.session
    // A grant read for another directory ends before this directory is read.
    if (grants.get(session)?.root !== root) release(session)
    const signal = caller === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, caller])
    let directory: string | undefined
    try {
      const found = await linkedWorktree(ctx.fs, root, signal)
      directory = found === undefined || await forgeable(session, found, signal) ? undefined : found.common
    } catch (error) {
      // A cancelled read decides nothing: the grant the Session holds for this directory stays.
      if (signal.aborted) return
      if (warned.get(session) !== root) {
        warned.set(session, root)
        ctx.logger.warn(`sandbox-policy-git: could not read the Git layout of ${JSON.stringify(root)}; its Git directory is not writable: ${String(error)}`)
      }
    }
    // A directory change during the read has its own read after it.
    if (signal.aborted || disposed.has(agent) || ctx.workingDirectory.get(session) !== root) return
    if (grants.get(session)?.directory === directory) return
    release(session)
    if (directory === undefined) return
    try {
      grants.set(session, { root, directory, dispose: ctx.sandboxPolicy.registerWritableRoot(session, directory) })
    } catch (error) {
      // The plugin's fiber refuses new effects from the start of its unload, before `lifetime` aborts.
      ctx.logger.debug(`sandbox-policy-git: could not register ${JSON.stringify(directory)}: ${String(error)}`)
    }
  }

  /** Start one read that the plugin's unload waits for. */
  const sync = (agent: Agent, root: string, caller: AbortSignal | undefined): Promise<void> => {
    const pending = read(agent, root, caller).finally(() => reads.delete(pending))
    reads.add(pending)
    return pending
  }

  ctx.on('agent/created', async ({ agent, signal }) => {
    await sync(agent, ctx.workingDirectory.get(agent.session), signal)
    return undefined
  })
  // Every Host move and the validation before each model request pass through this waterfall.
  ctx.on('working-directory/access', async ({ agent, signal }, next) => {
    const directory = await next()
    await sync(agent, directory, signal)
    return directory
  })
  // A grant ends in the step that commits the Session's move, before another observer of the move resolves a policy.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'workspace-root/change' && grants.get(session)?.root !== event.data.cwd) release(session)
  }, { prepend: true })
  ctx.on('agent/disposed', ({ agent }) => {
    disposed.add(agent)
    release(agent.session)
  })
}
