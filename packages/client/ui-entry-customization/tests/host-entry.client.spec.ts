/** The browser plugin retains a loadable, inert Host companion. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import * as companion from '../src/index.ts'

it('loads and releases the Host companion through Cordis', async () => {
  const ctx = new Context()
  try {
    const fiber = ctx.plugin(companion)
    await fiber
    expect(fiber.uid).not.toBeNull()
    await fiber.dispose()
    expect(fiber.uid).toBeNull()
  } finally {
    await ctx.fiber.dispose()
  }
})
