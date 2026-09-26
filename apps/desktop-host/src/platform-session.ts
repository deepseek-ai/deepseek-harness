/** Keeps Electron's private Platform credentials bound to the active account provider. */
import type { Context } from '@deepseek-ai/cordis'
import type { PlatformSession } from '@deepseek-ai/dsh-deepseek-account'

/**
 * Publish account sessions for each provider lifetime, clearing them on removal or stream termination.
 * @param ctx - Host context owning the account dependency subscription.
 * @param publish - Synchronous private IPC delivery; never forwards credentials to the renderer.
 */
export function installPlatformSessionPublisher(ctx: Context, publish: (session: PlatformSession | null) => void): void {
  ctx.inject(['deepseekAccount'], (accountCtx) => {
    const account = accountCtx.deepseekAccount
    accountCtx.effect(() => {
      const lifetime = new AbortController()
      const updates = (async () => {
        try {
          for await (const _state of account.watch(lifetime.signal)) {
            if (lifetime.signal.aborted) break
            const session = await account.getPlatformSession()
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Disposal can abort during the credential read.
            if (!lifetime.signal.aborted) publish(session)
          }
        } catch {
          if (!lifetime.signal.aborted) accountCtx.logger('desktop-platform').warn('Account session subscription failed')
        } finally {
          if (!lifetime.signal.aborted) publish(null)
        }
      })()
      return async () => {
        lifetime.abort()
        publish(null)
        await updates
      }
    })
  })
}
