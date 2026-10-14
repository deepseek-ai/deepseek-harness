/** Plugin registration: the credential matcher and its keyed node renderer leave with the plugin fiber. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { TestSessions } from '@deepseek-ai/dsh-client-test-runtime'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/assembly.ts'
import { SecretText } from '../src/client/SecretText.tsx'
import { NS } from '../src/client/locales.ts'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

function TextSlotDeclaration(_props: PropsRenderSlots<'conversation.user.text.node'>): null {
  return null
}

describe('apply', () => {
  it('declares its services and releases the matcher and renderer on disposal', async () => {
    expect(inject).toEqual(['locale', 'slots', 'uiConversation'])
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    ctx.provide('locale', new LocaleRuntime(ctx))
    const sessions = new TestSessions(async (action) => { await action() }, ctx)
    onTestFinished(() => sessions.disposeScopes())
    ctx.provide('sessions', sessions)
    new UiConversation(ctx, sessions)
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.user.text.node': { kind: 'keyed', scope: 'session' } },
    }, TextSlotDeclaration)

    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.uiConversation.userText.entries().map(rule => rule.id)).toEqual(['secret'])
    expect(ctx.slots.entries('conversation.user.text.node')).toMatchObject([
      { options: { key: 'secret' }, component: SecretText },
    ])
    expect(ctx.locale.bind(NS)('secret.reveal')).toBe('Show secret')

    await fiber.dispose()
    expect(ctx.uiConversation.userText.entries()).toHaveLength(0)
    expect(ctx.slots.entries('conversation.user.text.node')).toHaveLength(0)
  })

  it('the node half applies without host-side behavior', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
