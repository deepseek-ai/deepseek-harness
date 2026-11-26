/** Controlled handoff around the actual Loader-owned JSONL create method. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader } from '@deepseek-ai/dsh-session'

/**
 * Pause before or after real persistence creates its handle; restore the method with the owner.
 * @param ctx - Fixture owner whose Session persistence is the real JSONL service.
 * @param phase - Side of the create handoff at which the fixture releases provider ownership.
 * @returns Observed creation headers and the entry and release signals.
 */
export function installCreateGate(ctx: Context, phase: 'before' | 'after') {
  const entered = Promise.withResolvers<SessionHeader>()
  const release = Promise.withResolvers<undefined>()
  const attempts: SessionHeader[] = []
  const persistence = ctx.sessionPersistence
  const descriptor = Object.getOwnPropertyDescriptor(persistence, 'create')
  const original = persistence.create.bind(persistence)
  ctx.effect(() => {
    persistence.create = async (header, options) => {
      attempts.push(header)
      if (phase === 'before') {
        entered.resolve(header)
        await release.promise
      }
      const handle = await original(header, options)
      if (phase === 'after') {
        entered.resolve(header)
        await release.promise
      }
      return handle
    }
    return () => {
      if (descriptor === undefined) Reflect.deleteProperty(persistence, 'create')
      else Object.defineProperty(persistence, 'create', descriptor)
    }
  })
  return { entered, release, attempts }
}
