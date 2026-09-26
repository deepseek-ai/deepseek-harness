// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionPendingInteractionBase } from '@deepseek-ai/dsh-client-ui-session/client'
import type { Shortcuts, ShortcutContext, ShortcutGesture } from '@deepseek-ai/dsh-client-shortcuts/client'
import { makeTranslate, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import { UiConversation } from '../src/client/conversation/assembly.ts'
import { ComposerBlockRegistry } from '../src/client/input/blocks.ts'
import { InputHub } from '../src/client/input/hub.ts'
import { ConversationController } from '../src/client/service.ts'
import { installStopShortcut } from '../src/client/stop-shortcut.ts'
import { zh } from '../src/client/locales.ts'

const disposers: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  document.body.replaceChildren()
  vi.useRealTimers()
})

async function bench() {
  const runtime = await SlotTestRuntime.create()
  disposers.push(() => runtime.dispose())
  const cancel = vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true as const } }))
  await runtime.sessions.add({ id: 's1', snapshot: { running: true }, session: { cancel }, events: [
    { type: 'event', event: { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } } },
  ] })
  const reference = runtime.sessions.retain('s1' as SessionId)
  await reference.ready
  const hub = new InputHub(runtime.ctx, makeTranslate(zh, {}))
  const fiber = runtime.ctx.plugin(ConversationController, {
    input: hub, blocks: new ComposerBlockRegistry(), maxConcurrentFileUploads: 2,
  })
  await fiber.await()
  const conversation = new UiConversation(runtime.ctx, runtime.sessions)
  let listener: Parameters<Shortcuts['observeFixedInput']>[0] | undefined
  const shortcuts = {
    stopSequenceMs: 500,
    observeFixedInput: (callback: NonNullable<typeof listener>) => {
      listener = callback
      return () => { listener = undefined }
    },
  } as Shortcuts
  const stop = (sessionId: SessionId): void => {
    const scoped = runtime.sessions.scope(sessionId)!.get('conversation') as ConversationController
    void scoped.cancel()
  }
  const dispose = installStopShortcut(shortcuts, runtime.sessions,
    binding => conversation.binding(binding).openTurn, runtime.ctx.uiSession, stop)
  disposers.push(dispose)
  const root = document.createElement('div')
  root.dataset.conversationSession = 's1'
  root.dataset.conversationRegion = 'chat'
  document.body.append(root)
  const input = document.createElement('textarea')
  input.dataset.conversationRegion = 'composer'
  root.append(input)
  input.focus()
  const press = (overrides: Partial<ShortcutGesture> = {}, target: Element = input,
    context: Partial<ShortcutContext> = {}) => {
    const consume = vi.fn()
    listener?.({ type: 'keydown', gesture: { code: 'Escape', control: false, alt: false, shift: false,
      meta: false, repeat: false, composing: false, defaultPrevented: false, ...overrides },
    context: { region: 'editable', modal: null, target, ...context }, consume })
    return consume
  }
  return { runtime, cancel, input, root, press, dispose,
    reset: () => listener?.({ type: 'reset' }),
    events: reference.binding.eventSource as MutableSessionEventSource }
}

describe('fixed stop routing', () => {
  it('cancels through the scoped ConversationController only after two eligible Escapes', async () => {
    const b = await bench()
    expect(b.press()).toHaveBeenCalledOnce()
    expect(b.cancel).not.toHaveBeenCalled()
    b.press()
    await Promise.resolve()
    expect(b.cancel).toHaveBeenCalledOnce()
  })

  it.each(['repeat', 'composing', 'defaultPrevented', 'control', 'alt', 'shift', 'meta'] as const)(
    'clears the sequence when %s owns a key', async (field) => {
      const b = await bench()
      b.press()
      expect(b.press({ [field]: true })).not.toHaveBeenCalled()
      b.press()
      expect(b.cancel).not.toHaveBeenCalled()
      b.press()
      expect(b.cancel).toHaveBeenCalledOnce()
    },
  )

  it('clears on other keys, local consumption, modal ownership and leaving Conversation', async () => {
    const b = await bench()
    for (const invalidate of [
      () => b.press({ code: 'KeyA' }), () => b.reset(),
      () => b.press({}, b.input, { modal: 'settings' }),
      () => b.press({}, document.body),
      () => b.press({}, b.input, { region: 'terminal' }),
    ]) {
      b.press()
      invalidate()
      b.press()
      expect(b.cancel).not.toHaveBeenCalled()
      b.reset()
    }
  })

  it('never combines a press with the next turn even while running remains true', async () => {
    const b = await bench()
    b.press()
    b.events.append({ type: 'event', event: { type: 'turn/end', seq: SessionSeq(2), time: 2,
      data: { turn: 1, reason: { kind: 'completed' } } } })
    b.events.append({ type: 'event', event: { type: 'turn/start', seq: SessionSeq(3), time: 3, data: { turn: 2 } } })
    b.press()
    expect(b.cancel).not.toHaveBeenCalled()
    b.press()
    expect(b.cancel).toHaveBeenCalledOnce()
  })

  it('clears when an approval appears and disappears between presses', async () => {
    const b = await bench()
    const publish = b.runtime.ctx.uiSession.registerPendingInteraction<SessionPendingInteractionBase>(() => 0)
    b.press()
    const remove = publish({ kind: 'approval', key: 'request-a', sessionId: 's1' as SessionId }, async () => {})
    expect(b.press()).not.toHaveBeenCalled()
    remove()
    b.press()
    expect(b.cancel).not.toHaveBeenCalled()
    const removeSecond = publish({ kind: 'approval', key: 'request-b', sessionId: 's1' as SessionId }, async () => {})
    removeSecond()
    b.press()
    expect(b.cancel).not.toHaveBeenCalled()
    b.press()
    expect(b.cancel).toHaveBeenCalledOnce()
  })

  it('excludes terminal, iframe, approval and inert descendants even inside Conversation', async () => {
    const b = await bench()
    for (const [tag, attribute] of [['div', 'class'], ['iframe', ''], ['div', 'data-approval-key'], ['div', 'inert']]) {
      const element = document.createElement(tag!)
      if (attribute !== '') element.setAttribute(attribute!, attribute === 'class' ? 'xterm' : '')
      b.root.append(element)
      b.press()
      expect(b.press({}, element)).not.toHaveBeenCalled()
      b.press()
      expect(b.cancel).not.toHaveBeenCalled()
      b.reset()
    }
  })

  it('clears on running and removed lifecycle changes', async () => {
    const b = await bench()
    b.press()
    await b.runtime.sessions.updateSessionSnapshot('s1', (draft) => { draft.running = false })
    expect(b.press()).not.toHaveBeenCalled()
    await b.runtime.sessions.updateSessionSnapshot('s1', (draft) => { draft.running = true })
    b.press()
    expect(b.cancel).not.toHaveBeenCalled()
    await b.runtime.sessions.updateSessionSnapshot('s1', (draft) => { draft.removed = true })
    expect(b.press()).not.toHaveBeenCalled()
  })

  it('requires a live binding and observed turn start before arming', async () => {
    const b = await bench()
    b.root.dataset.conversationSession = 'missing'
    expect(b.press()).not.toHaveBeenCalled()
    b.root.dataset.conversationSession = 's1'
    b.events.replace([], false)
    expect(b.press()).not.toHaveBeenCalled()
    expect(b.cancel).not.toHaveBeenCalled()
  })

  it('retains the first press across step updates in the same running turn', async () => {
    const b = await bench()
    b.press()
    b.events.append({ type: 'event', event: { type: 'step/start', seq: SessionSeq(2), time: 2,
      data: { turn: 1, step: 1 } } })
    b.press()
    expect(b.cancel).toHaveBeenCalledOnce()
  })

  it('uses the existing stop path for continuable children and excludes one-shot children', async () => {
    const b = await bench()
    await b.runtime.sessions.updateSessionSnapshot('s1', (draft) => {
      draft.subagent = { address: { parentSessionId: 'parent' as SessionId,
        childSessionId: 's1' as SessionId, mode: 'one-shot' } }
    })
    expect(b.press()).not.toHaveBeenCalled()
    await b.runtime.sessions.updateSessionSnapshot('s1', (draft) => {
      draft.subagent = { parentAvailable: false, address: { parentSessionId: 'parent' as SessionId,
        childSessionId: 's1' as SessionId, mode: 'continuable' } }
    })
    b.press()
    b.press()
    expect(b.cancel).toHaveBeenCalledOnce()
  })

  it('does not arm without a cancellable live turn or after disposal', async () => {
    const b = await bench()
    b.events.append({ type: 'event', event: { type: 'turn/end', seq: SessionSeq(2), time: 2,
      data: { turn: 1, reason: { kind: 'completed' } } } })
    expect(b.press()).not.toHaveBeenCalled()
    b.press()
    b.dispose()
    b.press()
    expect(b.cancel).not.toHaveBeenCalled()
  })
})
