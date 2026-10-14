/** Real Slot/Factory rendering seats for standalone reasoning component tests. */
import { useState, type ReactNode } from 'react'
import { act, type RenderResult } from '@testing-library/react'
import { onTestFinished } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRenderFactories, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { en, NS, zh } from '../src/client/locale.ts'
import { derivePresentationPolicy, type CollapseTiming } from '../src/client/presentation-policy.ts'
import { registerChatNodeRenderers } from '../src/client/chat/register-node-renderers.ts'
import type { PerformanceUsageMode, TranscriptViewMode } from '../src/chat-settings.ts'

type RenderSeats = PropsRenderSlots<'conversation.chat.reasoning.body'> & PropsRenderFactories

/**
 * Bind the shipped default Body and Content Factory through the production renderer.
 * @param language - active locale for the official default labels.
 * @returns rendering seats and the registry for replacement/lifecycle assertions.
 */
export async function createReasoningRenderFixture(language = 'zh') {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  locale.register('common', { en: commonEn, zh: commonZh })
  locale.register(NS, { en, zh })
  locale.setLocale(language)
  runtime.slots.installLocale(locale)
  const captured: { seats?: RenderSeats; setContent?: (content: ReactNode) => void } = {}
  await runtime.root.declare({
    'conversation.chat.reasoning.body': { kind: 'single', scope: 'session' },
  }, function TestRoot(props) {
    const [content, setContent] = useState<ReactNode>(null)
    captured.seats = props
    captured.setContent = setContent
    return content
  })
  const owner = await runtime.mount({
    inject: ['slots'],
    apply: (ctx) => {
      registerChatNodeRenderers(ctx,
        createSnapshotStore<PerformanceUsageMode>('detailed'),
        derivePresentationPolicy(createSnapshotStore<TranscriptViewMode>('detailed'), createSnapshotStore<CollapseTiming>('completion')))
    },
  })
  await runtime.sessions.add({ id: 'reasoning-fixture' })
  const session = runtime.sessions.retainFor(runtime.ctx, SessionId('reasoning-fixture'))
  const view = runtime.renderRoot()
  const { seats, setContent } = captured
  if (seats === undefined || setContent === undefined) throw new Error('reasoning fixture root did not render')
  const { SessionProvider } = seats
  const renderSlot: RenderSeats['renderSlot'] = (key, props, options) => (
    <SessionProvider session={session}>{seats.renderSlot(key, props, options)}</SessionProvider>
  )
  const update = (content: ReactNode): void => { act(() => { setContent(content) }) }
  const render = (content: ReactNode): RenderResult => {
    update(content)
    return { ...view, rerender: update }
  }
  return { runtime, owner, locale, render, renderSlot, renderFactorySlot: seats.renderFactorySlot }
}
