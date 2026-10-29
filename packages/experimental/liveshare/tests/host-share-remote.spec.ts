/**
 * The owner share-management Remote is one delegation surface: every method calls the single
 * operations implementation that owns the side effect, and the audit read is one of them.
 *
 * The Gateway decides each call through remote access before a method runs, so this spec covers the
 * mapping rather than the policy.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveshareShares } from '../src/host/share-remote.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

describe('owner share Remote', () => {
  it('reads one share’s Relay audit trail through the operations implementation', async () => {
    const audit = vi.fn(async () => ({ events: [] }))
    ctx = new Context()
    const remote = new LiveshareShares(ctx, { audit } as never)

    await expect(remote.audit({ shareId: 'share-one' })).resolves.toEqual({ events: [] })
    expect(audit).toHaveBeenCalledWith({ shareId: 'share-one' })
  })
})
