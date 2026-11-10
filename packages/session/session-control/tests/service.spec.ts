import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SessionControl from '../src/index.ts'
import type { SessionControlProvider } from '../src/index.ts'

const roots: Context[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function fixture() {
  const ctx = new Context()
  roots.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const loop = await mountAgentLoopTestHarness(ctx)
  const caller = await loop.create(SessionId('caller'))
  await ctx.plugin(SessionControl)
  const signal = new AbortController().signal
  const runtime = { caller, signal }
  return { ctx, loop, caller, runtime }
}

describe('Session control acceptance', () => {
  it('rejects blank messages and absent providers without attempting delivery', async () => {
    const { ctx, runtime } = await fixture()
    const id = SessionId('target')
    await expect(ctx.sessionControl.sendMessage({ id, message: ' \t\n' }, runtime))
      .rejects.toMatchObject({ name: 'SessionControlError', code: 'SESSION_CONTROL_INVALID_MESSAGE' })
    await expect(ctx.sessionControl.sendMessage({ id, message: 'hello' }, runtime))
      .rejects.toMatchObject({ name: 'SessionControlError', code: 'SESSION_CONTROL_UNAVAILABLE' })
    await expect(ctx.sessionControl.sendAgentContent({ id, content: [] }, runtime))
      .rejects.toMatchObject({ code: 'SESSION_CONTROL_UNAVAILABLE' })
  })

  it('serializes both message entrypoints for one target while other targets can proceed', async () => {
    const { ctx, runtime } = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const order: string[] = []
    ctx.sessionControl.register({
      async deliver(request) {
        order.push(`ordinary:${request.id}`)
        if (request.id === 'target') {
          entered.resolve(undefined)
          await release.promise
        }
        return { messageId: request.message.id }
      },
    })
    const tree = vi.fn<SessionControlProvider['deliver']>(async (request) => {
      order.push(`tree:${request.id}`)
      expect(request.message.source).toEqual({ kind: 'agent-message', form: 'relay', senderSessionId: runtime.caller.id })
      expect(request.message.content).toEqual([
        { type: 'text', text: 'Agent lead sent a message: ' }, { type: 'text', text: 'tree message' },
      ])
      return { messageId: request.message.id }
    })
    ctx.sessionControl.registerTreeDelivery({ senderName: () => 'lead', deliver: tree })
    const first = ctx.sessionControl.sendMessage({ id: SessionId('target'), message: 'first' }, runtime)
    await entered.promise
    const next = ctx.sessionControl.sendAgentContent({
      id: SessionId('target'), content: [{ type: 'text', text: 'tree message' }],
    }, runtime)
    await ctx.sessionControl.sendMessage({ id: SessionId('other'), message: 'parallel' }, runtime)
    expect(order).toEqual(['ordinary:target', 'ordinary:other'])
    release.resolve(undefined)
    const [a, b] = await Promise.all([first, next])
    expect(a.messageId).not.toBe(b.messageId)
    expect(order).toEqual(['ordinary:target', 'ordinary:other', 'tree:target'])
  })

  it('does not retry failures and admits the next queued operation', async () => {
    const { ctx, runtime } = await fixture()
    const failure = new Error('unknown delivery outcome')
    const deliver = vi.fn<SessionControlProvider['deliver']>()
      .mockRejectedValueOnce(failure)
      .mockImplementation(async request => ({ messageId: request.message.id }))
    ctx.sessionControl.register({ deliver })
    const request = { id: SessionId('target'), message: 'hello' }
    const first = ctx.sessionControl.sendMessage(request, runtime)
    const second = ctx.sessionControl.sendMessage(request, runtime)
    await expect(first).rejects.toBe(failure)
    await expect(second).resolves.toHaveProperty('messageId')
    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it('refuses a stale caller before dispatch', async () => {
    const { ctx, caller, runtime } = await fixture()
    const deliver = vi.fn<SessionControlProvider['deliver']>(async request => ({ messageId: request.message.id }))
    ctx.sessionControl.register({ deliver })
    const registered = ctx.agents.get.bind(ctx.agents)
    vi.spyOn(ctx.agents, 'get').mockImplementation(id => id === caller.id ? undefined : registered(id))
    await expect(ctx.sessionControl.sendMessage({ id: SessionId('target'), message: 'hello' }, runtime))
      .rejects.toMatchObject({ name: 'SessionControlError', code: 'SESSION_CONTROL_CALLER_UNAVAILABLE' })
    expect(deliver).not.toHaveBeenCalled()
  })

  it('cancels queued work before dispatch and keeps accepted receipts after cancellation', async () => {
    const { ctx, runtime } = await fixture()
    const release = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const accepted = new AbortController()
    const deliver = vi.fn<SessionControlProvider['deliver']>(async (request) => {
      entered.resolve(undefined)
      await release.promise
      accepted.abort()
      return { messageId: request.message.id }
    })
    ctx.sessionControl.register({ deliver })
    const request = { id: SessionId('target'), message: 'hello' }
    const first = ctx.sessionControl.sendMessage(request, { ...runtime, signal: accepted.signal })
    await entered.promise
    const controller = new AbortController()
    const next = ctx.sessionControl.sendMessage(request, { ...runtime, signal: controller.signal })
    const denied = expect(next).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    release.resolve(undefined)
    await expect(first).resolves.toHaveProperty('messageId')
    await denied
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('withdraws a provider, aborts its work, and waits for quiescence before replacement', async () => {
    const { ctx, runtime } = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const aborted = Promise.withResolvers<undefined>()
    const unregister = ctx.sessionControl.register({
      async deliver(_request, current) {
        entered.resolve(undefined)
        current.signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
        await release.promise
        current.signal.throwIfAborted()
        throw new Error('unreachable after provider cancellation')
      },
    })
    expect(() => ctx.sessionControl.register({ deliver: async request => ({ messageId: request.message.id }) }))
      .toThrow('already registered')
    const request = { id: SessionId('target'), message: 'hello' }
    const pending = ctx.sessionControl.sendMessage(request, runtime)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await entered.promise
    let disposed = false
    const disposal = unregister().then(() => { disposed = true })
    await aborted.promise
    expect(disposed).toBe(false)
    await expect(ctx.sessionControl.sendMessage(request, runtime)).rejects.toMatchObject({ code: 'SESSION_CONTROL_UNAVAILABLE' })
    release.resolve(undefined)
    await Promise.all([disposal, rejected])
    ctx.sessionControl.register({ deliver: async value => ({ messageId: value.message.id }) })
    await expect(ctx.sessionControl.sendMessage(request, runtime)).resolves.toHaveProperty('messageId')
  })
})
