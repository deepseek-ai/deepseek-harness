/**
 * Bringing a Session up through the composition's own activation path.
 *
 * This host activates a Session — a write share's source, or a child recorded in an earlier process —
 * before it drives that Session, so every plugin that installs itself from the `agent/created`
 * announcement has run first. The capability it reads is the merge-declared `agent` lookup, whose
 * resolver the composition owns, so this host needs no Session-controller endpoint of its own; a
 * deployment that installs no such lookup, or whose lookup activates nothing, is refused loudly rather
 * than left looking activated.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { activateSession } from '../src/host/share-host.ts'

const session = 'session-child'

/** A host context that provides the `agent` lookup, recording every identity asked of it. */
function host(resolve?: (sessionId: string) => unknown): { ctx: Context; asked: string[] } {
  const ctx = new Context()
  const asked: string[] = []
  ctx.provide('typert', {
    lookups: {
      get: (key: string) => key === 'agent' && resolve !== undefined
        ? {
          resolve: (sessionId: string) => {
            asked.push(sessionId)
            return resolve(sessionId)
          },
        }
        : undefined,
    },
  })
  return { ctx, asked }
}

describe('session activation through the agent lookup', () => {
  it('resolves the Session through the lookup and waits for the answer', async () => {
    let settled = false
    const { ctx, asked } = host(async () => {
      await Promise.resolve()
      settled = true
      return { id: session }
    })

    await activateSession(ctx, session)

    expect(asked).toEqual([session])
    expect(settled).toBe(true)
    await ctx.fiber.dispose()
  })

  it('refuses a deployment that installs no agent lookup', async () => {
    const { ctx } = host()

    await expect(activateSession(ctx, session)).rejects.toThrow(/no agent lookup is registered/u)
    await ctx.fiber.dispose()
  })

  it('refuses an answer that activates no Agent', async () => {
    const { ctx } = host(() => undefined)

    await expect(activateSession(ctx, session)).rejects.toThrow(/answered with nothing/u)
    await ctx.fiber.dispose()
  })

  it('reports the resolver’s own failure instead of an acknowledgement', async () => {
    const { ctx } = host(() => Promise.reject(new Error('session not found')))

    await expect(activateSession(ctx, session)).rejects.toThrow(/session not found/u)
    await ctx.fiber.dispose()
  })
})
