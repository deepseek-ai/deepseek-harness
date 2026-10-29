// @vitest-environment jsdom
/** The body registers into the shared card registry with its copy and leaves both on unload. */
import { cleanup, render, screen } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ActionCardDescriptor } from '@deepseek-ai/dsh-client-ui-action-cards/client'
import { FoldedText } from '@deepseek-ai/dsh-client-ui-action-cards/src/client/Card.tsx'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject } from '../src/client/mount.ts'
import { apply as hostApply } from '../src/index.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup(); localStorage.clear() })

it('registers the page body and its copy for the plugin lifetime', async () => {
  hostApply()
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const unregister = vi.fn()
  const register = vi.fn((_descriptor: ActionCardDescriptor<'creationRecommendations'>) => unregister)
  ctx.provide('actionCards', { register })
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const fiber = await ctx.plugin({ inject, apply })
  const descriptor = register.mock.calls[0]![0]
  expect(descriptor).toMatchObject({ action: 'create_personalized_page', locale: 'creationRecommendations' })
  expect(locale.bind('creationRecommendations')('heading')).toBe('Personalized pages')
  const t = locale.bind('creationRecommendations')
  render(<descriptor.Body proposal={{ callId: ToolCallId('card'), turn: 1, action: 'create_personalized_page', title: 'Counter', brief: 'Keep count.',
    details: { slot: 'page' } }} decision={undefined} sessionId={SessionId('session')} summary={null} Folded={FoldedText} act={vi.fn()} t={t} />)
  expect(screen.getByRole('note').textContent).toContain(en.creationCost)
  await fiber.dispose()
  expect(unregister).toHaveBeenCalledOnce()
  expect(locale.bind('creationRecommendations')('heading')).toBe('heading')
})
