/**
 * Loader fixture that holds the parent's second step until settlement delivery.
 * @module subagent-settlement-fence
 */

import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-subagent'

/** Fixture plugin name. */
export const name = 'subagent-settlement-fence'

/**
 * Fence the parent's post-spawn request behind admission of the manager notice.
 *
 * This pins content order, not step placement: the held pre-step runs after its
 * own `Inbox.claim()`, so the notice lands after step 2's claim and is claimed at
 * step 3 because the child's settlement pipeline is strictly longer than the
 * parent's claim path, not because a barrier forces it.
 * @param ctx - assembled headless-agent context.
 */
export function apply(ctx: Context): void {
  const delivered = Promise.withResolvers<undefined>()
  let hasDelivered = false

  ctx.effect(() => {
    const disposeInbox = ctx[Context.root].on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent.session.header.parentSession !== undefined || message.source.kind !== 'subagent-settled') return
      hasDelivered = true
      delivered.resolve(undefined)
    })
    const disposeStep = ctx[Context.root].on('agent/pre-step', async ({ agent, turn, step }, next) => {
      if (agent.session.header.parentSession === undefined && turn === 1 && step === 2 && !hasDelivered) {
        await delivered.promise
      }
      return next()
    })
    return () => {
      disposeStep()
      disposeInbox()
    }
  }, 'subagent-settlement-fence.listeners')
}
