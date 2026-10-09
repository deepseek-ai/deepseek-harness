/** Successful Session translations survive remounts and restarts without another provider query. */
import { pluginRecordOf, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TranslationStorage } from '../src/storage.ts'
import type { TranslationIdentity } from '../src/types.ts'
import { storageFixture, storageReply } from './storage-fixture.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Translation storage fixture teardown failed')
})

const identity: TranslationIdentity = { provider: 'bing', text: 'Original paragraph', sourceLanguage: 'auto', targetLanguage: 'zh', recipe: 'fixture-recipe' }
const requests = (events: readonly SessionEvent[]) => events.filter(event => pluginRecordOf(event)?.type === 'plugin:translator/request')
const results = (events: readonly SessionEvent[]) => events.filter(event => pluginRecordOf(event)?.type === 'plugin:translator/result')

describe('durable translation results', () => {
  it.each(['bing', 'google'] as const)('reuses a %s result after a complete Host restart with zero new HTTP', async (provider) => {
    const b = await storageFixture(cleanups), original = await b.createSession()
    const spec = () => b.ctx.translator.resolve({ text: 'Original paragraph', targetLanguage: 'zh', provider, sessionId: original.id })
    expect(await b.ctx.translator.translate(spec())).toBe('Stored translation')
    const first = await b.readEvents(original.id)
    expect(first.slice(0, original.events.length)).toEqual(original.events)
    expect(requests(first)).toHaveLength(1)
    expect(results(first)).toHaveLength(1)
    expect(requests(first)[0]).toMatchObject({ ignorable: true, data: { provider, text: 'Original paragraph',
      sourceLanguage: 'auto', targetLanguage: 'zh' } })
    expect((requests(first)[0]?.data as { recipe: string }).recipe).toEqual(expect.any(String))
    expect(results(first)[0]).toMatchObject({ ignorable: true, data: { requestSeq: requests(first)[0]?.seq, text: 'Stored translation' } })
    expect((await readFile(original.file)).subarray(0, original.bytes.length)).toEqual(original.bytes)
    await b.restart()
    expect(b.ctx.sessions.list()).toEqual([])
    expect(await b.ctx.translator.translate(spec())).toBe('Stored translation')
    expect(b.requests).toHaveLength(1)
    expect(await b.readEvents(original.id)).toEqual(first)
    expect(b.ctx.sessions.list()).toEqual([])
    expect(b.errors).toEqual([])
  })

  it('persists request before dispatch and result before return through the existing live writer', async () => {
    let atDispatch: readonly SessionEvent[] = []
    const b = await storageFixture(cleanups, { async reply(call, response) {
      atDispatch = await b.readEvents(SessionId('stored-translation'))
      storageReply(call, response)
    } })
    const original = await b.createSession()
    const messages = original.session?.deriveMessages()
    expect(await b.ctx.translator.translate(b.ctx.translator.resolve({ text: 'Original paragraph', targetLanguage: 'zh', sessionId: original.id })))
      .toBe('Stored translation')
    expect(requests(atDispatch)).toHaveLength(1)
    expect(results(atDispatch)).toEqual([])
    const committed = await b.readEvents(original.id)
    expect(results(committed)).toHaveLength(1)
    expect(original.session?.deriveMessages()).toEqual(messages)
    expect(committed.slice(0, original.events.length)).toEqual(original.events)
  })

  it('serializes simultaneous identical requests and reuses the first completed result', async () => {
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const b = await storageFixture(cleanups, { async reply(call, response) {
      entered.resolve(undefined); await release.promise; storageReply(call, response)
    } })
    const original = await b.createSession(), spec = b.ctx.translator.resolve({ text: 'Original paragraph', targetLanguage: 'zh', sessionId: original.id })
    const first = b.ctx.translator.translate(spec)
    const second = b.ctx.translator.translate(spec)
    try {
      await entered.promise
      expect(b.requests).toHaveLength(1)
      release.resolve(undefined)
      expect(await Promise.all([first, second])).toEqual(['Stored translation', 'Stored translation'])
      expect(b.requests).toHaveLength(1)
      expect(results(await b.readEvents(original.id))).toHaveLength(1)
    } finally { release.resolve(undefined); await Promise.allSettled([first, second]) }
  })

  it('lets another Session translate while the first Session provider request is held', async () => {
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const b = await storageFixture(cleanups, { async reply(call, response) {
      if (call.text === 'Held source') { entered.resolve(undefined); await release.promise }
      storageReply(call, response)
    } })
    const firstSession = await b.createSession(SessionId('first-session')), secondSession = await b.createSession(SessionId('second-session'))
    const pending = b.ctx.translator.translate(b.ctx.translator.resolve({ text: 'Held source', targetLanguage: 'zh', sessionId: firstSession.id }))
    try {
      await entered.promise
      expect(await b.ctx.translator.translate(b.ctx.translator.resolve({ text: 'Other source', targetLanguage: 'zh', sessionId: secondSession.id })))
        .toBe('Stored translation')
      expect(b.requests.map(call => call.text)).toEqual(['Held source', 'Other source'])
      release.resolve(undefined)
      await pending
    } finally { release.resolve(undefined); await Promise.allSettled([pending]) }
  })

  it('overlaps different fragments through the same Session writer', async () => {
    const release = Promise.withResolvers<undefined>()
    const b = await storageFixture(cleanups, { async reply(call, response) {
      await release.promise; storageReply(call, response, `Translation of ${call.text}`)
    } })
    cleanups.push(async () => { release.resolve(undefined) })
    const original = await b.createSession()
    const pending = ['First fragment', 'Second fragment'].map(text => b.ctx.translator.translate(b.ctx.translator.resolve({
      text, targetLanguage: 'zh', sessionId: original.id,
    })))
    try {
      await expect.poll(() => b.requests.length).toBe(2)
      expect(results(await b.readEvents(original.id))).toEqual([])
      expect(requests(await b.readEvents(original.id))).toHaveLength(2)
      release.resolve(undefined)
      expect(await Promise.all(pending)).toEqual(['Translation of First fragment', 'Translation of Second fragment'])
      const committed = await b.readEvents(original.id)
      expect(committed.map(event => event.seq)).toEqual(committed.map((_event, index) => index))
      expect(results(committed)).toHaveLength(2)
    } finally { release.resolve(undefined); await Promise.allSettled(pending) }
  })

  it('retains an unmatched failed request and permits a successful retry', async () => {
    let fail = true
    const b = await storageFixture(cleanups, { reply(call, response) {
      if (fail) { response.writeHead(503); response.end() } else storageReply(call, response)
    } })
    const original = await b.createSession(), spec = b.ctx.translator.resolve({ text: 'Original paragraph', targetLanguage: 'zh', sessionId: original.id })
    await expect(b.ctx.translator.translate(spec)).rejects.toMatchObject({ code: 'TRANSLATION_HTTP_ERROR' })
    expect(requests(await b.readEvents(original.id))).toHaveLength(1)
    expect(results(await b.readEvents(original.id))).toEqual([])
    fail = false
    expect(await b.ctx.translator.translate(spec)).toBe('Stored translation')
    const committed = await b.readEvents(original.id)
    expect(requests(committed)).toHaveLength(2)
    expect(results(committed)[0]?.data).toEqual({ requestSeq: requests(committed)[1]?.seq, text: 'Stored translation' })
  })

  it('cancels before provider completion and leaves no successful result', async () => {
    const entered = Promise.withResolvers<undefined>(), closed = Promise.withResolvers<undefined>()
    let held: ServerResponse | undefined
    const b = await storageFixture(cleanups, { reply(_call, response) {
      held = response; response.once('close', () => { closed.resolve(undefined) }); entered.resolve(undefined)
    } })
    const original = await b.createSession(), caller = new AbortController(), reason = new Error('Stop translation')
    const pending = b.ctx.translator.translate(b.ctx.translator.resolve({ text: 'Original paragraph', targetLanguage: 'zh', sessionId: original.id }), caller.signal)
    const rejected = expect(pending).rejects.toBe(reason)
    try {
      await entered.promise; caller.abort(reason); await rejected; await closed.promise
      expect(requests(await b.readEvents(original.id))).toHaveLength(1)
      expect(results(await b.readEvents(original.id))).toEqual([])
    } finally { held?.destroy(); await Promise.allSettled([pending]) }
  })

  it('separates provider, target, source, text, and effective endpoint recipes', async () => {
    const b = await storageFixture(cleanups), original = await b.createSession()
    const base = { text: 'Original paragraph', targetLanguage: 'zh', sessionId: original.id }
    for (const selection of [base, { ...base, provider: 'google' as const }, { ...base, targetLanguage: 'ja' },
      { ...base, sourceLanguage: 'en' }, { ...base, text: 'Different paragraph' }]) {
      await b.ctx.translator.translate(b.ctx.translator.resolve(selection))
    }
    const entry = [...b.ctx.loader.entries()].find(row => row.options.id === 'translator')
    if (entry === undefined) throw new Error('Missing translator Loader row')
    await entry.update({ config: { ...b.config, bingEndpoint: b.config.bingEndpoint + '-alternate' } })
    await b.ctx.loader.await()
    await b.ctx.translator.translate(b.ctx.translator.resolve(base))
    expect(b.requests).toHaveLength(6)
    expect(new Set(requests(await b.readEvents(original.id)).map(event => (event.data as { recipe: string }).recipe)).size).toBe(3)
  })

  it('does not change cache identity for provider-owned endpoint query parameters', async () => {
    const b = await storageFixture(cleanups), original = await b.createSession()
    const base = { text: 'Original paragraph', targetLanguage: 'zh', sessionId: original.id }
    await b.ctx.translator.translate(b.ctx.translator.resolve(base))
    const entry = [...b.ctx.loader.entries()].find(row => row.options.id === 'translator')
    if (entry === undefined) throw new Error('Missing translator Loader row')
    await entry.update({ config: { ...b.config, bingEndpoint: b.config.bingEndpoint + '?from=legacy&to=legacy&isEnterpriseClient=true' } })
    await b.ctx.loader.await()
    expect(await b.ctx.translator.translate(b.ctx.translator.resolve(base))).toBe('Stored translation')
    expect(b.requests).toHaveLength(1)
  })
})

describe('translation storage guards', () => {
  it.each([false, true])('refuses uncached inactive Sessions with live store=%s before external I/O or writes', async (withSessions) => {
    const b = await storageFixture(cleanups, { withSessions }), original = await b.createSession(SessionId('inactive'), false)
    const opened = vi.spyOn(b.ctx.sessionPersistence, 'open')
    await expect(b.ctx.translator.translate(b.ctx.translator.resolve({ text: 'source', targetLanguage: 'zh', sessionId: original.id })))
      .rejects.toMatchObject({ code: 'TRANSLATION_SESSION_INACTIVE' })
    expect(opened.mock.calls.every(([, access]) => access === 'read')).toBe(true)
    expect(await readFile(original.file)).toEqual(original.bytes)
    expect(b.requests).toEqual([])
    expect(b.ctx.get('sessions')?.list() ?? []).toEqual([])
  })
  it('refuses missing storage or a missing Session before external I/O', async () => {
    const absent = await storageFixture(cleanups, { withPersistence: false })
    await expect(absent.ctx.translator.translate(absent.ctx.translator.resolve({ text: 'source', targetLanguage: 'zh', sessionId: SessionId('missing') })))
      .rejects.toMatchObject({ code: 'TRANSLATION_SESSION_REQUIRED' })
    const b = await storageFixture(cleanups)
    await expect(b.ctx.translator.translate(b.ctx.translator.resolve({ text: 'source', targetLanguage: 'zh', sessionId: SessionId('missing') })))
      .rejects.toMatchObject({ code: 'TRANSLATION_SESSION_REQUIRED' })
    expect([...absent.requests, ...b.requests]).toEqual([])
  })

  it('does not return a provider response when result durability fails', async () => {
    const b = await storageFixture(cleanups, { async reply(call, response) {
      await original.writer?.close()
      storageReply(call, response)
    } })
    const original = await b.createSession()
    await expect(b.ctx.translator.translate(b.ctx.translator.resolve({ text: 'source', targetLanguage: 'zh', sessionId: original.id })))
      .rejects.toMatchObject({ code: 'TRANSLATION_STORAGE_ERROR' })
    expect(b.requests).toHaveLength(1)
    expect(results(await b.readEvents(original.id))).toEqual([])
  })

  it.each([
    ['request missing provider', 'plugin:translator/request', { text: 'source', sourceLanguage: 'auto', targetLanguage: 'zh', recipe: 'recipe' }],
    ['request metadata array', 'plugin:translator/request', { ...identity, metadata: [] }],
    ['result orphan', 'plugin:translator/result', { requestSeq: 0, text: 'orphan' }],
    ['result unsafe seq', 'plugin:translator/result', { requestSeq: 0.5, text: 'orphan' }],
    ['result negative zero', 'plugin:translator/result', { requestSeq: -0, text: 'orphan' }],
    ['result non-text', 'plugin:translator/result', { requestSeq: 0, text: 1 }],
  ] as const)('refuses persisted %s before provider dispatch', async (_kind, type, data) => {
    const b = await storageFixture(cleanups), original = await b.createSession(SessionId('malformed'), false)
    let record = JSON.stringify({ type, data, seq: original.events.length, time: Date.now(), ignorable: true })
    if (_kind === 'result negative zero') record = record.replace('"requestSeq":0', '"requestSeq":-0')
    await writeFile(original.file, Buffer.concat([original.bytes, Buffer.from(record + '\n')]))
    await expect(b.ctx.translator.translate(b.ctx.translator.resolve({ text: 'source', targetLanguage: 'zh', sessionId: original.id })))
      .rejects.toMatchObject({ code: 'TRANSLATION_STORAGE_ERROR' })
    expect(b.requests).toEqual([])
  })

  it('preserves request metadata, ignores unrelated records, and reuses matching success', async () => {
    const b = await storageFixture(cleanups), original = await b.createSession(), storage = new TranslationStorage(b.ctx)
    const request = { ...identity, metadata: { model: 'owned-model', maxTokens: 12 } }
    await storage.run(original.id, identity, new AbortController().signal, async (log) => {
      const seq = await log.request(request); await log.result(seq, 'Retained result'); return 'Retained result'
    })
    const saved = await b.readEvents(original.id)
    await appendFile(original.file, JSON.stringify({ type: 'plugin:other/unrelated', seq: saved.length, time: Date.now(),
      data: { opaque: true }, ignorable: true }) + '\n')
    const cached = await storage.run(original.id, identity, new AbortController().signal, async () => { throw new Error('Cached translation must skip provider dispatch') })
    expect(cached).toBe('Retained result')
    expect(requests(await b.readEvents(original.id))[0]?.data).toEqual(request)
    expect(b.requests).toEqual([])
  })
})
