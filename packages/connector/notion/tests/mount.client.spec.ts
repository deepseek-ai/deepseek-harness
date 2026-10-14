/** The browser half registers the Notion dictionary and account while the Notion row is on and withdraws both with it. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

it('registers the Notion account under its dictionary and removes both on disposal', async () => {
  const ctx = new Context()
  const dictionaryRemoved = vi.fn(), accountRemoved = vi.fn()
  const locale = { register: vi.fn(() => dictionaryRemoved) }
  const mcpAccounts = { register: vi.fn(() => accountRemoved) }
  ctx.provide('locale', locale)
  ctx.provide('mcpAccounts', mcpAccounts)
  try {
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber
    expect(locale.register).toHaveBeenCalledWith('notion', { zh, en })
    expect(mcpAccounts.register).toHaveBeenCalledWith({ server: 'notion', packageName: '@deepseek-ai/dsh-notion', locale: 'notion' })
    await fiber.dispose()
    expect(dictionaryRemoved).toHaveBeenCalledOnce()
    expect(accountRemoved).toHaveBeenCalledOnce()
  } finally { await ctx.fiber.dispose() }
})
