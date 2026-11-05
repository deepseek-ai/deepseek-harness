/** Session-owned write-grant changes observed through the real request context. */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-sandbox-policy'

/** Snapshot fixture plugin name. */
export const name = 'session-write-grant'
/** The shared policy owns effect-scoped directory registrations. */
export const inject = ['sandboxPolicy']

/**
 * Grant directories until the first tool result, before the next request.
 * @param ctx - fixture lifetime and policy service.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/created', ({ agent }) => {
    const extra = join(process.cwd(), 'extra')
    const dispose = ctx.sandboxPolicy.registerWritableRoot(agent.session, extra)
    ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'tool/result') {
        dispose()
      }
    })
  })
}
