// @vitest-environment jsdom
/**
 * ui-message-feedback browser half on a real cordis Context with fake slots/remote
 * faces: the plugin registers the feedback entry at
 * conversation.chat.assistant-actions, one controller per Session backs every
 * message in that Session, a reconnect refreshes only Sessions that were
 * already read, and registration plus controller disposal ride the plugin
 * fiber (HMR safety). The node half stays inert.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { MessageId } from '@deepseek-ai/dsh-api-remotes/client'
import type { MessageFeedbackItem, MessageFeedbackVersion } from '@deepseek-ai/dsh-message-feedback/types'
import type { MessageFeedbackInjected } from '../src/client/slots.ts'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

afterEach(cleanup)

const sid = (k: string): SessionId => k as SessionId
const MSG = 'm-1' as MessageId

const seeded: MessageFeedbackItem = {
  messageId: MSG,
  rating: 'positive',
  version: 'v1' as MessageFeedbackVersion,
  createdAt: 1,
  updatedAt: 1,
}

/** Boot the plugin over fake faces; the Remote namespace records every call. */
async function bench() {
  const ctx = new Context()
  const calls: { method: string; request: unknown }[] = []
  // The generated face wraps every business result in the carrier envelope.
  const carried = <T,>(value: T) => Promise.resolve({ ok: true as const, value })
  const messageFeedback = {
    list: (request: unknown) => {
      calls.push({ method: 'list', request })
      return carried({ ok: true as const, value: { items: [seeded] } })
    },
    put: (request: unknown) => {
      calls.push({ method: 'put', request })
      return carried({ ok: true as const, value: seeded })
    },
    delete: (request: unknown) => {
      calls.push({ method: 'delete', request })
      return carried({ ok: true as const, value: { absent: true as const } })
    },
  }
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  ctx.provide('remote.messageFeedback', messageFeedback)
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: { 'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' } },
  } as never, (() => null) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  return {
    ctx,
    fiber,
    calls,
    entry: () => {
      const entry = ctx.slots.entries('conversation.chat.assistant-actions')[0]
      if (entry === undefined) return undefined
      return {
        ...entry.options,
        locale: entry.locale,
        inject: entry.inject as unknown as ((sessionId: SessionId) => MessageFeedbackInjected) | undefined,
      }
    },
  }
}

describe('ui-message-feedback browser plugin', () => {
  it('registers the feedback entry with the documented id, order, and locale', async () => {
    const b = await bench()
    await b.fiber.await()

    expect(b.entry()).toMatchObject({ id: 'feedback', order: 10, locale: 'feedback' })
    expect(b.entry()?.inject).toBeTypeOf('function')
  })

  it('exposes the feedback hook plus the ensure/rate/clear verbs', async () => {
    const b = await bench()
    await b.fiber.await()

    const face = b.entry()!.inject!(sid('s1'))
    expect(face.hooks.feedback.getSnapshot()).toMatchObject({ status: 'cold' })
    expect(face.ensure).toBeTypeOf('function')
    expect(face.rate).toBeTypeOf('function')
    expect(face.clear).toBeTypeOf('function')
  })

  it('shares one controller across every message in the same Session', async () => {
    const b = await bench()
    await b.fiber.await()

    const first = b.entry()!.inject!(sid('s1'))
    const second = b.entry()!.inject!(sid('s1'))
    expect(first.hooks.feedback).toBe(second.hooks.feedback)

    await first.ensure()
    await second.ensure()
    expect(b.calls.filter(call => call.method === 'list')).toHaveLength(1)
  })

  it('keeps separate Sessions on separate controllers', async () => {
    const b = await bench()
    await b.fiber.await()

    const one = b.entry()!.inject!(sid('s1'))
    const two = b.entry()!.inject!(sid('s2'))
    expect(one.hooks.feedback).not.toBe(two.hooks.feedback)

    await one.ensure()
    await two.ensure()
    expect(b.calls.filter(call => call.method === 'list').map(call => call.request)).toEqual([
      { sessionId: 's1' },
      { sessionId: 's2' },
    ])
  })

  it('routes rate and clear to the Remote with the addressed message', async () => {
    const b = await bench()
    await b.fiber.await()

    const face = b.entry()!.inject!(sid('s1'))
    expect(await face.rate(MSG, 'negative', 'wrong answer')).toEqual({ ok: true })
    expect(await face.clear(MSG)).toEqual({ ok: true })

    expect(b.calls.filter(call => call.method === 'put')[0]?.request).toMatchObject({
      sessionId: 's1', messageId: MSG, rating: 'negative', note: 'wrong answer',
    })
    expect(b.calls.filter(call => call.method === 'delete')[0]?.request).toMatchObject({
      sessionId: 's1', messageId: MSG,
    })
  })

  it('routes toggle and clearNote to the controller', async () => {
    const b = await bench()
    await b.fiber.await()

    const face = b.entry()!.inject!(sid('s1'))
    expect(await face.toggle(MSG, 'negative')).toEqual({ ok: true })
    expect(await face.clearNote(MSG)).toEqual({ ok: true })

    // The seeded item is positive with no note, so a negative toggle replaces it
    // through put, and clearNote has nothing to drop and touches no wire.
    const puts = b.calls.filter(call => call.method === 'put').map(call => call.request)
    expect(puts).toHaveLength(1)
    expect(puts[0]).toMatchObject({ messageId: MSG, rating: 'negative' })
  })

  it('refreshes only Sessions already read when the connection resets', async () => {
    const b = await bench()
    await b.fiber.await()

    const warm = b.entry()!.inject!(sid('warm'))
    await warm.ensure()
    b.entry()!.inject!(sid('cold'))
    const before = b.calls.filter(call => call.method === 'list').length

    b.ctx.emit('connection/reset')
    await Promise.resolve()

    const reads = b.calls.filter(call => call.method === 'list')
    expect(reads).toHaveLength(before + 1)
    expect(reads.at(-1)?.request).toEqual({ sessionId: 'warm' })
  })

  it('withdraws the registration and disposes controllers with the plugin fiber', async () => {
    const b = await bench()
    await b.fiber.await()
    const face = b.entry()!.inject!(sid('s1'))
    await face.ensure()

    await b.fiber.dispose()

    expect(b.ctx.slots.entries('conversation.chat.assistant-actions')).toHaveLength(0)
    // A disposed controller refuses further mutations, so no request outlives the fiber.
    const before = b.calls.length
    expect(await face.rate(MSG, 'positive')).toMatchObject({ ok: false, error: { code: 'disposed' } })
    expect(b.calls).toHaveLength(before)
  })

  it('re-registers cleanly when the plugin is reloaded', async () => {
    const b = await bench()
    await b.fiber.await()
    await b.fiber.dispose()

    const reloaded = b.ctx.plugin({ inject: [...inject], apply })
    await reloaded.await()

    expect(b.ctx.slots.entries('conversation.chat.assistant-actions')).toHaveLength(1)
    expect(b.entry()).toMatchObject({ id: 'feedback' })
  })

  it('the node half applies without host-side behavior', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
