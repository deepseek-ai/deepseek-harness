// @vitest-environment jsdom
/** Quote registrations follow their plugin and Slot declaration lifetimes. */
import { Context } from '@deepseek-ai/cordis'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestSessions } from '@deepseek-ai/dsh-client-test-runtime'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as plugin from '../src/client/index.ts'

async function fixture() {
  const ctx = new Context()
  const sessions = new TestSessions(async (action) => { await action() }, ctx)
  onTestFinished(async () => {
    await sessions.disposeScopes()
    await ctx.fiber.dispose()
  })
  const sessionId = await sessions.add({ id: 'quote' })
  sessions.retainFor(ctx, sessionId)
  ctx.provide('sessions', sessions)
  const conversation = new UiConversation(ctx, sessions)
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const fiber = ctx.plugin(plugin)
  await fiber.await()
  const declareSlots = () => ctx.slots.register({
    name: 'root',
    children: {
      'conversation.chat.text-interaction': { kind: 'keyed', scope: 'session' },
      'conversation.user.text.node': { kind: 'keyed', scope: 'session', inline: true },
    },
  } as never, (() => null) as never)
  return { ctx, sessions, sessionId, conversation, fiber, declareSlots }
}

const selection = () => ({
  trigger: 'selection' as const,
  hasSelection: true,
  readText: () => 'selected text',
  preventDefault: vi.fn(),
})

describe('Quote browser plugin', () => {
  it('opens only valid selections in writable conversations and preserves native context menus', async () => {
    const { conversation, sessions, sessionId } = await fixture()
    const gesture = selection()
    expect(conversation.interactions.dispatch(sessionId, gesture)).toBe('quote')
    expect(conversation.interactions.dispatch(sessionId, { ...gesture, trigger: 'contextmenu' })).toBeNull()
    expect(conversation.interactions.dispatch(sessionId, { ...gesture, readText: () => null })).toBeNull()
    expect(conversation.interactions.dispatch(SessionId('absent'), gesture)).toBeNull()
    expect(gesture.preventDefault).not.toHaveBeenCalled()

    await sessions.updateSessionSnapshot(sessionId, (draft) => { draft.removed = true })
    expect(conversation.interactions.dispatch(sessionId, gesture)).toBeNull()
    await sessions.updateSessionSnapshot(sessionId, (draft) => { draft.removed = false })
    const child: NonNullable<SessionSnapshot['subagent']> = {
      address: { parentSessionId: SessionId('parent'), childSessionId: sessionId, mode: 'continuable' },
      parentAvailable: true,
    }
    await sessions.updateSessionSnapshot(sessionId, (draft) => { draft.subagent = child })
    expect(conversation.interactions.dispatch(sessionId, gesture)).toBe('quote')
    await sessions.updateSessionSnapshot(sessionId, (draft) => { draft.subagent = { ...child, parentAvailable: false } })
    expect(conversation.interactions.dispatch(sessionId, gesture)).toBeNull()
    await sessions.updateSessionSnapshot(sessionId, (draft) => {
      draft.subagent = { ...child, address: { ...child.address, mode: 'one-shot' } }
    })
    expect(conversation.interactions.dispatch(sessionId, gesture)).toBeNull()
  })

  it('mounts with late Slot declarations, reattaches after their replacement, and releases every contribution', async () => {
    const { ctx, conversation, fiber, declareSlots, sessionId } = await fixture()
    const evaluate = conversation.userText.createEvaluator()
    expect(evaluate({ text: '> excerpt', facts: {} })[0]?.id).toBe('quote')
    const firstDeclaration = declareSlots()
    expect(ctx.slots.entries('conversation.chat.text-interaction').map(entry => entry.options.key)).toEqual(['quote'])
    expect(ctx.slots.entries('conversation.user.text.node').map(entry => entry.options.key)).toEqual(['quote'])
    firstDeclaration()
    const replacement = declareSlots()
    expect(ctx.slots.entries('conversation.chat.text-interaction')).toHaveLength(1)
    expect(ctx.slots.entries('conversation.user.text.node')).toHaveLength(1)

    await fiber.dispose()
    expect(conversation.interactions.dispatch(sessionId, selection())).toBeNull()
    expect(evaluate({ text: '> excerpt', facts: {} })[0]?.id).toBe('text')
    expect(ctx.slots.entries('conversation.chat.text-interaction')).toEqual([])
    expect(ctx.slots.entries('conversation.user.text.node')).toEqual([])

    await ctx.plugin(plugin).await()
    expect(conversation.interactions.dispatch(sessionId, selection())).toBe('quote')
    expect(evaluate({ text: '> excerpt', facts: {} })[0]?.id).toBe('quote')
    expect(ctx.slots.entries('conversation.chat.text-interaction')).toHaveLength(1)
    replacement()
  })
})
