/** Common paid requests and results survive Host restart without altering main conversation input. */
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { pluginRecordOf, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { setImmediate } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { paidFixture } from './paid-fixture.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Paid storage fixture teardown failed')
})

const providers = ['deepseek-account', 'deepseek-official'] as const
const requests = (events: readonly SessionEvent[]) => events.filter(event => pluginRecordOf(event)?.type === 'plugin:translator/request')
const results = (events: readonly SessionEvent[]) => events.filter(event => pluginRecordOf(event)?.type === 'plugin:translator/result')

function historicalEvents(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: SessionSeq(1), time: 2, surfaceOp: 'append',
      data: createUserMessage({ content: [{ type: 'text', text: 'Private main conversation' }], source: { kind: 'user' } }) },
    { type: 'step/start', seq: SessionSeq(2), time: 3, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: SessionSeq(3), time: 4, surfaceOp: 'append', data: { turn: 1, step: 1, stream: [],
      message: createAssistantMessage({ content: [{ type: 'reasoning', text: 'Original paragraph' }, { type: 'text', text: 'Main answer' }],
        source: { provider: 'main-provider', model: 'main-model' } }) } },
    { type: 'step/end', seq: SessionSeq(4), time: 5, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: SessionSeq(5), time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

describe.each(['jsonl', 'sqlite'] as const)('common paid translation persistence (%s)', (backend) => {
  it.each(['caller cancellation', 'provider deadline'] as const)(
    'keeps a pending result ahead of an immediate retry after %s without billing again', async (interruption) => {
      const b = await paidFixture(cleanups, backend, { translator: { deepseekTimeoutMs: 60_000 } })
      const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
      cleanups.push(async () => { release.resolve(undefined) })
      let resultPending = false
      b.ctx.on('session/event', (_session, event) => {
        if (pluginRecordOf(event)?.type === 'plugin:translator/result') resultPending = true
      })
      const flush = b.ctx.sessions.flush.bind(b.ctx.sessions)
      vi.spyOn(b.ctx.sessions, 'flush').mockImplementation(async (session) => {
        if (resultPending) {
          entered.resolve(undefined)
          await release.promise
        }
        return flush(session)
      })
      const caller = new AbortController(), reason = new Error('Canceled while saving the translation')
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const scheduled = vi.spyOn(globalThis, 'setTimeout')
      try {
        const first = b.translate('deepseek-official', 'Original paragraph', caller.signal).catch((error: unknown) => error)
        await entered.promise
        expect(b.requests).toHaveLength(1)
        if (interruption === 'caller cancellation') caller.abort(reason)
        else {
          const deadlines = scheduled.mock.calls.filter(([, delay]) => delay === 60_000)
          expect(deadlines).toHaveLength(1)
          // Advancing the shared clock would also flush the accepted result behind the write barrier.
          deadlines[0]![0]()
        }
        const rejected = await first
        if (interruption === 'caller cancellation') expect(rejected).toBe(reason)
        else expect(rejected).toMatchObject({ code: 'TRANSLATION_TIMEOUT' })
        expect(results(await b.readEvents(b.session!.id))).toEqual([])
        const open = vi.spyOn(b.ctx.sessionPersistence, 'open')
        const retry = b.translate('deepseek-official').then(text => ({ text }), (error: unknown) => ({ error }))
        // Retry admission starts in promise reactions; one event-loop turn drains those without releasing the write barrier.
        await setImmediate()
        const readsBeforeCommit = open.mock.calls.length
        release.resolve(undefined)
        await expect(retry).resolves.toEqual({ text: '翻译结果' })
        expect(readsBeforeCommit).toBe(0)
        expect(b.requests).toHaveLength(1)
        const committed = await b.readEvents(b.session!.id)
        expect(requests(committed)).toHaveLength(1)
        expect(results(committed)).toHaveLength(1)
        expect(results(committed)[0]).toMatchObject({ data: { requestSeq: requests(committed)[0]?.seq, text: '翻译结果' } })
        expect(b.errors).toEqual([])
      } finally {
        release.resolve(undefined)
        scheduled.mockRestore()
        vi.useRealTimers()
      }
    })

  it.each(providers.flatMap(provider => ['credentials', 'native-owner'].map(unavailable => ({ provider, unavailable }))))(
    'reuses $provider after a complete restart with unavailable $unavailable and zero new HTTP', async ({ provider, unavailable }) => {
      const b = await paidFixture(cleanups, backend), id = b.session!.id, oldContext = b.ctx
      const specification = () => b.ctx.translator.resolve({ provider, text: 'Original paragraph', targetLanguage: 'zh', sessionId: id })
      expect(await b.ctx.translator.translate(specification())).toBe('翻译结果')
      const committed = await b.readEvents(id)
      expect(requests(committed)).toHaveLength(1)
      expect(results(committed)).toHaveLength(1)
      expect(results(committed)[0]).toMatchObject({ ignorable: true, data: { requestSeq: requests(committed)[0]?.seq, text: '翻译结果' } })
      b.setConfigured(false)
      b.setSignedIn(false)
      await b.restart({ withNativeOwners: unavailable !== 'native-owner' })
      expect(b.ctx).not.toBe(oldContext)
      expect(b.ctx.sessions.list()).toEqual([])
      expect(await b.ctx.translator.availableProviders()).toEqual(['bing', 'google'])
      expect(await b.ctx.translator.translate(specification())).toBe('翻译结果')
      expect(await b.readEvents(id)).toEqual(committed)
      expect(b.requests).toHaveLength(1)
      await expect(b.ctx.translator.translate(b.ctx.translator.resolve({ provider, text: 'Uncached fragment', targetLanguage: 'zh', sessionId: id })))
        .rejects.toMatchObject({ code: 'TRANSLATION_SESSION_INACTIVE' })
      expect(await b.readEvents(id)).toEqual(committed)
      expect(b.requests).toHaveLength(1)
      expect(b.errors).toEqual([])
    })

  it.each(providers)('requires a live writer for uncached %s before preparation and retains independent input and result', async (provider) => {
    const id = brandString<SessionId>('historical-paid-translation')
    const b = await paidFixture(cleanups, backend, { withSession: false, withSessionQuery: true })
    const original = await b.createHistorical(id, historicalEvents())
    await b.restart()
    using observation = await b.ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
    expect(observation.source).toBe('prepared')
    expect(b.ctx.sessions.get(id)).toBeUndefined()
    const spec = b.ctx.translator.resolve({ provider, text: 'Original paragraph', targetLanguage: 'zh', sessionId: id })
    const prepare = vi.spyOn(b.ctx.llm, 'prepareCall')
    await expect(b.ctx.translator.translate(spec)).rejects.toMatchObject({ code: 'TRANSLATION_SESSION_INACTIVE' })
    expect(prepare).not.toHaveBeenCalled()
    expect(b.requests).toEqual([])
    expect(await b.readEvents(original.id)).toEqual(original.events)
    expect(b.ctx.sessions.list()).toEqual([])
    const session = await b.activate(id)
    const resumed = await b.readEvents(id), surface = await b.ctx.sessionQuery.readSurface(id)
    const open = vi.spyOn(b.ctx.sessionPersistence, 'open')
    expect(await b.ctx.translator.translate(spec)).toBe('翻译结果')
    expect(open.mock.calls.every(([, access]) => access === 'read')).toBe(true)
    const wire = b.requests[0]!
    expect(wire.audit.slice(0, resumed.length)).toEqual(resumed)
    expect(wire.audit).toHaveLength(resumed.length + 1)
    expect(requests(wire.audit)[0]).toMatchObject({ ignorable: true, data: { provider, text: 'Original paragraph', sourceLanguage: 'auto', targetLanguage: 'zh',
      metadata: { modelRequest: { config: { provider, model: 'deepseek-flash', reasoningEffort: 'off', maxTokens: 8192 },
        system: wire.body.system, messages: wire.body.messages } } } })
    expect(wire.body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Original paragraph' }] }])
    expect(wire.body.thinking).toEqual({ type: 'disabled' })
    expect(wire.sessionHeader).toBe(false)
    expect(JSON.stringify(wire.body)).not.toContain('Private main conversation')
    const committed = await b.readEvents(id)
    expect(committed.slice(0, resumed.length)).toEqual(resumed)
    expect(results(committed)).toHaveLength(1)
    expect(results(committed)[0]).toMatchObject({ ignorable: true, data: { requestSeq: requests(committed)[0]?.seq, text: '翻译结果' } })
    expect(committed.slice(0, original.events.length)).toEqual(original.events)
    expect((await b.ctx.sessionPersistence.stat(id))?.header).toEqual(original.header)
    const after = await b.ctx.sessionQuery.readSurface(id)
    expect(after.events).toEqual(surface.events)
    expect(after.session).toEqual(surface.session)
    expect(b.ctx.sessions.get(id)).toBe(session)
    expect(b.errors).toEqual([])
  })

  it('refuses a missing historical Session before paid dispatch', async () => {
    const b = await paidFixture(cleanups, backend, { withSession: false })
    await expect(b.ctx.translator.translate(b.ctx.translator.resolve({ provider: 'deepseek-official', text: 'source',
      targetLanguage: 'zh', sessionId: brandString<SessionId>('missing-historical') })))
      .rejects.toMatchObject({ code: 'TRANSLATION_SESSION_REQUIRED' })
    expect(b.requests).toEqual([])
    expect(b.ctx.sessions.list()).toEqual([])
  })

  it('does not claim a historical writer on a cache miss or dispatch paid work', async () => {
    const b = await paidFixture(cleanups, backend, { withSession: false }), original = await b.createHistorical(brandString<SessionId>('owned-history'), historicalEvents())
    await using writer = await b.ctx.sessionPersistence.open(original.id, 'write')
    await expect(b.ctx.translator.translate(b.ctx.translator.resolve({ provider: 'deepseek-official', text: 'source',
      targetLanguage: 'zh', sessionId: original.id })))
      .rejects.toMatchObject({ code: 'TRANSLATION_SESSION_INACTIVE' })
    expect((await writer.read()).events).toEqual(original.events)
    expect(await b.readEvents(original.id)).toEqual(original.events)
    expect(b.requests).toEqual([])
    expect(b.ctx.sessions.list()).toEqual([])
  })

  it('withholds paid translated text when its durable result cannot be written', async () => {
    const b = await paidFixture(cleanups, backend), session = b.session!
    const flush = b.ctx.sessions.flush.bind(b.ctx.sessions)
    const checkpoint = vi.spyOn(b.ctx.sessions, 'flush').mockImplementation(async (value) => {
      if (b.requests.length > 0) throw new Error('Fixture result storage unavailable')
      return flush(value)
    })
    await expect(b.ctx.translator.translate(b.ctx.translator.resolve({ provider: 'deepseek-official', text: 'Original paragraph',
      targetLanguage: 'zh', sessionId: session.id })))
      .rejects.toMatchObject({ code: 'TRANSLATION_STORAGE_ERROR' })
    expect(b.requests).toHaveLength(1)
    expect(requests(b.requests[0]!.audit)).toHaveLength(1)
    checkpoint.mockRestore()
    await b.ctx.sessions.flush(session)
    expect(b.errors).toEqual([])
  })

  it('does not reuse a saved paid result when the configured output-token cap changes', async () => {
    const b = await paidFixture(cleanups, backend), id = b.session!.id
    const spec = () => b.ctx.translator.resolve({ provider: 'deepseek-official', text: 'Original paragraph', targetLanguage: 'zh', sessionId: id })
    expect(await b.ctx.translator.translate(spec())).toBe('翻译结果')
    await b.restart({ translator: { deepseekMaxOutputTokens: 16 } })
    await expect(b.ctx.translator.translate(spec())).rejects.toMatchObject({ code: 'TRANSLATION_SESSION_INACTIVE' })
    expect(b.requests).toHaveLength(1)
    await b.activate(id)
    expect(await b.ctx.translator.translate(spec())).toBe('翻译结果')
    expect(b.requests).toHaveLength(2)
    expect(b.requests[1]?.body.max_tokens).toBe(16)
    const committed = await b.readEvents(id)
    expect(requests(committed)).toHaveLength(2)
    expect(results(committed)).toHaveLength(2)
    expect(results(committed)[1]?.data).toEqual({ requestSeq: requests(committed)[1]?.seq, text: '翻译结果' })
  })
})
