// @vitest-environment jsdom
/** The body registers into the shared card registry while the Plugins navigation is present, and leaves with its copy on unload. */
import { act, cleanup, render, screen } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ActionCardId } from '@deepseek-ai/dsh-action-cards/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ActionCardDescriptor } from '@deepseek-ai/dsh-client-ui-action-cards/client'
import { FoldedText } from '@deepseek-ai/dsh-client-ui-action-cards/src/client/Card.tsx'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'

afterEach(cleanup)

/** A Client context with every required service and a mock card registry. */
function fixture() {
  hostApply()
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const unregister = vi.fn()
  const register = vi.fn((_descriptor: ActionCardDescriptor<'pluginRecommendations'>) => unregister)
  ctx.provide('actionCards', { register })
  const describe = vi.fn().mockResolvedValue({ ok: true, value: { status: 'available', title: { en: 'Session search' },
    description: { en: 'Search past conversations' }, enabled: false } })
  ctx.provide('remote', { pluginRecommendations: { describe } })
  ctx.provide('remote.pluginRecommendations', { describe })
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  return { ctx, unregister, register, describe, locale }
}

it('registers the plugin body and its copy for the plugin lifetime and shares catalog text between cards', async () => {
  const { ctx, unregister, register, describe, locale } = fixture()
  const openBundle = vi.fn()
  ctx.provide('pluginNavigation', { openBundle })
  const fiber = await ctx.plugin({ inject, apply })
  await vi.waitFor(() => { expect(register).toHaveBeenCalledOnce() })
  const descriptor = register.mock.calls[0]![0]
  expect(descriptor).toMatchObject({ action: 'enable_official_plugin', locale: 'pluginRecommendations' })
  expect(locale.bind('pluginRecommendations')('heading')).toBe('Recommended plugin')
  const proposal = { cardId: brandString<ActionCardId>('card'), turn: 1, action: 'enable_official_plugin', title: 'Search', brief: 'Find old sessions.',
    details: { name: 'official-search' } }
  const card = () => <descriptor.Body proposal={proposal} decision={undefined} sessionId={brandString<SessionId>('session-one')} summary={null}
    fallback={null} Folded={FoldedText} act={vi.fn()} t={locale.bind('pluginRecommendations')} />
  render(card())
  await act(async () => {})
  expect(describe).toHaveBeenCalledWith('session-one', 'card')
  screen.getByRole('button', { name: 'View details: Session search' }).click()
  expect(openBundle).toHaveBeenCalledWith('official-search')
  cleanup()
  describe.mockReturnValueOnce(new Promise(() => {}))
  render(card())
  expect(screen.getByText('Search past conversations')).toBeTruthy()
  cleanup()
  describe.mockResolvedValueOnce({ ok: false })
  render(card())
  await act(async () => {})
  // A lost catalog lookup asks for another lookup rather than reporting an action result.
  expect(screen.getByRole('alert').textContent).toBe('Could not load this plugin’s details. Try again.')
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  await fiber.dispose()
  expect(unregister).toHaveBeenCalledOnce()
  expect(locale.bind('pluginRecommendations')('heading')).toBe('heading')
  vi.spyOn(locale, 'register').mockImplementation(() => { throw new Error('registration failed') })
  const failed = ctx.plugin({ inject, apply })
  await expect(failed.await()).rejects.toThrow('registration failed')
  await failed.dispose()
})

it('registers the body only while the Plugins navigation is present', async () => {
  const { ctx, unregister, register } = fixture()
  await ctx.plugin({ inject, apply })
  expect(register).not.toHaveBeenCalled()
  const navigation = ctx.plugin({ apply: (child: Context) => { child.provide('pluginNavigation', { openBundle: vi.fn() }) } })
  await navigation
  await vi.waitFor(() => { expect(register).toHaveBeenCalledOnce() })
  await navigation.dispose()
  await vi.waitFor(() => { expect(unregister).toHaveBeenCalledOnce() })
})
