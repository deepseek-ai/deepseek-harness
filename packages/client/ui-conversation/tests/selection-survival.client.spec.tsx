// @vitest-environment jsdom
/** Exercises Conversation persistence through the real SlotRegistry store axis. */
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { createConversationStore } from '../src/client/stores.ts'

const sid = (value: string): SessionId => value as SessionId

type ConversationInstance = ReturnType<ReturnType<typeof createConversationStore>['create']>

async function createBench() {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const conversation = createConversationStore()
  await runtime.root.declare({
    'conversation.session': { kind: 'single', scope: 'session' },
    'conversation.session.header': { kind: 'single', scope: 'session' },
  }, (_props: PropsRenderSlots<'conversation.session' | 'conversation.session.header'>) => null)
  runtime.slots.register({ name: 'conversation.session', store: conversation }, () => null)
  runtime.slots.register({ name: 'conversation.session.header', store: conversation }, () => null)
  runtime.renderRoot()
  return { runtime }
}

function storeFor(
  current: Awaited<ReturnType<typeof createBench>>,
  slot: 'conversation.session' | 'conversation.session.header',
  reference: ReturnType<typeof current.runtime.sessions.retain>,
): ConversationInstance {
  return current.runtime.storeOf(slot, reference) as ConversationInstance
}

beforeEach(() => {
  localStorage.clear()
})

describe('Conversation state survives on its store seat', () => {
  it('shares one instance between the Session body and header', async () => {
    const b = await createBench()
    await b.runtime.sessions.add({ id: 's1' })
    using reference = b.runtime.sessions.retain(sid('s1'))
    await reference.ready
    expect(reference.sessionId).toBe(sid('s1'))
    const body = storeFor(b, 'conversation.session', reference)
    const header = storeFor(b, 'conversation.session.header', reference)

    body.actions.setDraft('half-typed')
    header.actions.setView('trajectory')

    expect(header).toBe(body)
    expect(body.store.getSnapshot()).toMatchObject({ draft: 'half-typed', view: 'trajectory' })
    await b.runtime.dispose()
  })

  it('isolates Session instances and preserves identity across list projection updates', async () => {
    const b = await createBench()
    const oneId = sid('s1')
    await b.runtime.sessions.add({ id: 's1' })
    using retained = b.runtime.sessions.retain(oneId)
    await retained.ready
    await b.runtime.sessions.add({ id: 's2' })
    using second = b.runtime.sessions.retain(sid('s2'))
    await second.ready
    const one = storeFor(b, 'conversation.session', retained)
    const two = storeFor(b, 'conversation.session', second)
    one.actions.setDraft('only one')
    two.actions.setDraft('only two')

    await b.runtime.sessions.updateSummary(oneId, { displayTitle: 'projected' })

    expect(storeFor(b, 'conversation.session', retained)).toBe(one)
    expect(one.store.getSnapshot().draft).toBe('only one')
    expect(two.store.getSnapshot().draft).toBe('only two')
    await b.runtime.dispose()
  })

  it('recreates the instance and restores persisted state after the Session scope ends', async () => {
    const b = await createBench()
    await b.runtime.sessions.add({ id: 's1' })
    using reference = b.runtime.sessions.retain(sid('s1'))
    await reference.ready
    const doomed = storeFor(b, 'conversation.session', reference)
    doomed.actions.setDraft('to be buried')
    doomed.actions.setView('chat')
    expect(localStorage.getItem('dsh.conversation.s1')).not.toBeNull()

    reference.release()
    await b.runtime.flush()
    await b.runtime.sessions.remove('s1')

    expect(localStorage.getItem('dsh.conversation.s1')).not.toBeNull()
    await b.runtime.sessions.add({ id: 's1' })
    using replacement = b.runtime.sessions.retain(sid('s1'))
    await replacement.ready
    expect(replacement.binding).toBe(b.runtime.sessions.binding(sid('s1')))
    const reborn = storeFor(b, 'conversation.session', replacement)
    expect(reborn).not.toBe(doomed)
    expect(reborn.store.getSnapshot()).toEqual({ draft: 'to be buried', view: 'chat', viewRequest: null })
    await b.runtime.dispose()
  })
})
