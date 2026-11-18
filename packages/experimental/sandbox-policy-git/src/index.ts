/**
 * Grants each Session that works in a linked Git worktree write access to the Git directory the worktree
 * shares with its repository, through `ctx.sandboxPolicy.registerWritableRoot`. The grant follows the
 * Session's directory and is never stored; the [README](../README.md) states when the layout is read.
 * @module @deepseek-ai/dsh-sandbox-policy-git
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-working-directory'
import { sharedGitDirectory } from './linked-worktree.ts'

/** Cordis plugin name. */
export const name = 'sandbox-policy-git'
/** Services that read the Git layout, hold the grant, and report the Session's directory. */
export const inject = ['fs', 'sandboxPolicy', 'workingDirectory']

/**
 * Keep one grant per live Session in step with the directory it works in. Windows process confinement
 * ignores additional writable directories, so the plugin registers nothing there.
 * @param ctx - plugin context that owns every registration.
 */
export function apply(ctx: Context): void {
  if (process.platform === 'win32') return
  /** Disposer of each Session's registration. */
  const grants = new WeakMap<Session, () => void>()
  const warned = new WeakMap<Session, string>()
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort(new Error('sandbox-policy-git disposed')) })

  const release = (session: Session): void => {
    grants.get(session)?.()
    grants.delete(session)
  }

  /** Read the layout of `root` and replace the Session's grant with its result; never rejects. */
  const sync = async (session: Session, root: string): Promise<void> => {
    let directory: string | undefined
    try {
      directory = await sharedGitDirectory(ctx.fs, root, lifetime.signal)
    } catch (error) {
      if (lifetime.signal.aborted) return
      if (warned.get(session) !== root) {
        warned.set(session, root)
        ctx.logger.warn(`sandbox-policy-git: could not read the Git layout of ${JSON.stringify(root)}; its Git directory is not writable: ${String(error)}`)
      }
    }
    // A directory change during the read has its own read after it.
    if (lifetime.signal.aborted || ctx.workingDirectory.get(session) !== root) return
    release(session)
    if (directory !== undefined) grants.set(session, ctx.sandboxPolicy.registerWritableRoot(session, directory))
  }

  ctx.on('agent/created', async ({ agent }) => {
    await sync(agent.session, ctx.workingDirectory.get(agent.session))
    return undefined
  })
  // Every Host move and the validation before each model request pass through this waterfall.
  ctx.on('working-directory/access', async ({ agent }, next) => {
    const directory = await next()
    await sync(agent.session, directory)
    return directory
  })
  ctx.on('agent/disposed', ({ agent }) => { release(agent.session) })
}
