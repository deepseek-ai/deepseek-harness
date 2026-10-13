/** Persist an injected consumer's final event during provider-only unload. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-tool-todo'
import { scheduler } from 'node:timers/promises'

export const name = 'snapshot-persistence-provider-unload'
export const inject = ['loader', 'sessions']

/**
 * Hold the completed turn's flush until persistence and its consumer unload.
 * @param ctx - Shipped profile context with the Loader-owned persistence entry.
 */
export async function apply(ctx: Context): Promise<void> {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let live: Session | undefined
  let triggered = false
  await ctx.plugin({
    name: 'snapshot-persistence-consumer',
    inject: ['sessionPersistence'],
    apply(consumer: Context) {
      consumer.effect(() => async () => {
        if (live === undefined) return
        entered.resolve()
        await release.promise
        live.append('todo/write', {
          todos: [{ content: 'Persistence consumer cleanup completed', status: 'completed' }],
        })
      })
    },
  })
  ctx.on('session/flush', async (session) => {
    if (triggered || !session.snapshotEvents().some(event => event.type === 'turn/end')) return
    const provider = [...ctx.loader.entries()].find(entry => entry.options.id === 'session-persistence-jsonl')
    if (provider?.fiber === undefined) throw new Error('Snapshot persistence provider is missing')
    triggered = true
    // Finish the checkpoint before removing its writer; the nested callback is skipped.
    await ctx.sessions.flush(session)
    live = session
    let finished = false
    const unloading = provider.fiber.dispose().then(() => { finished = true })
    try {
      await Promise.race([
        entered.promise,
        unloading.then(() => { throw new Error('Persistence unloaded before its consumer cleanup') }),
      ])
      await scheduler.yield()
      if (finished) throw new Error('Persistence did not await its consumer cleanup')
    } finally {
      release.resolve()
      await unloading
    }
  })
}
