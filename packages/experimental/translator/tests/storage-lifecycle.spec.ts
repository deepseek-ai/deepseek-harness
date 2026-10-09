/** Queued cancellation, native storage ownership, and quiescent translator disposal. */
import { pluginRecordOf, SessionId } from '@deepseek-ai/dsh-session'
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { storageFixture, storageReply } from './storage-fixture.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('translation storage lifecycle', () => {
  it('rejects a canceled queued request promptly without dispatching it', async () => {
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const b = await storageFixture(cleanups, { reply: async (call, response) => {
      entered.resolve(undefined); await release.promise; storageReply(call, response)
    } })
    cleanups.push(async () => { release.resolve(undefined) })
    const original = await b.createSession()
    const first = b.ctx.translator.translate(b.ctx.translator.resolve({ text: 'first', targetLanguage: 'zh', sessionId: original.id }))
    await entered.promise
    const cancellation = new AbortController(), reason = { canceled: true }
    const queued = b.ctx.translator.translate(b.ctx.translator.resolve({ text: 'first', targetLanguage: 'zh', sessionId: original.id }), cancellation.signal)
    cancellation.abort(reason)
    await expect(queued).rejects.toBe(reason)
    expect(b.requests.map(request => request.text)).toEqual(['first'])
    release.resolve(undefined)
    await expect(first).resolves.toBe('Stored translation')
    await [...b.ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-experimental-translator')?.fiber?.dispose()
    expect(b.requests.map(request => request.text)).toEqual(['first'])
  })

  it('joins an accepted storage checkpoint after public cancellation on unload', async () => {
    const b = await storageFixture(cleanups), original = await b.createSession()
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    cleanups.push(async () => { release.resolve(undefined) })
    const flush = b.ctx.sessions.flush.bind(b.ctx.sessions)
    vi.spyOn(b.ctx.sessions, 'flush').mockImplementation(async (session) => {
      entered.resolve(undefined); await release.promise; return flush(session)
    })
    const translating = b.ctx.translator.translate(b.ctx.translator.resolve({ text: 'source', targetLanguage: 'zh', sessionId: original.id }))
    const rejected = expect(translating).rejects.toThrow('Translator service disposed')
    await entered.promise
    const fiber = [...b.ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-experimental-translator')?.fiber
    if (fiber === undefined) throw new Error('Translator was not mounted')
    let disposed = false
    const disposing = fiber.dispose().then(() => { disposed = true })
    await rejected
    expect(disposed).toBe(false)
    expect(b.requests).toEqual([])
    release.resolve(undefined)
    await disposing
    expect(disposed).toBe(true)
  })

  it('refuses a withdrawn persistence provider after its metadata lookup settles', async () => {
    const b = await storageFixture(cleanups), original = await b.createSession()
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    cleanups.push(async () => { release.resolve(undefined) })
    const stat = b.ctx.sessionPersistence.stat.bind(b.ctx.sessionPersistence)
    vi.spyOn(b.ctx.sessionPersistence, 'stat').mockImplementation(async (id, options) => {
      const value = await stat(id, options); entered.resolve(undefined); await release.promise; return value
    })
    const translating = b.ctx.translator.translate(b.ctx.translator.resolve({ text: 'source', targetLanguage: 'zh', sessionId: original.id }))
    const rejected = expect(translating).rejects.toMatchObject({ code: 'TRANSLATION_SESSION_REQUIRED' })
    await entered.promise
    await [...b.ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-session-persistence-jsonl')?.fiber?.dispose()
    release.resolve(undefined)
    await rejected
    expect(b.requests).toEqual([])
  })

  it('pins the live Session used by an accepted translation', async () => {
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const b = await storageFixture(cleanups, { async reply(call, response) {
      entered.resolve(undefined); await release.promise; storageReply(call, response)
    } })
    cleanups.push(async () => { release.resolve(undefined) })
    const original = await b.createSession()
    const translating = b.ctx.translator.translate(b.ctx.translator.resolve({ text: 'source', targetLanguage: 'zh', sessionId: original.id }))
    const rejected = expect(translating).rejects.toMatchObject({ code: 'TRANSLATION_SESSION_REQUIRED' })
    await entered.promise
    await original.scope?.dispose()
    release.resolve(undefined)
    await rejected
    expect((await b.readEvents(original.id)).filter(event => pluginRecordOf(event)?.type === 'plugin:translator/result')).toEqual([])
    expect(b.requests).toHaveLength(1)
  })

  it('requires an active live writer rather than treating an in-memory append as durable', async () => {
    const b = await storageFixture(cleanups), original = await b.createSession(SessionId('live-without-writer'), true)
    await original.writer?.close()
    await expect(b.ctx.translator.translate(b.ctx.translator.resolve({ text: 'source', targetLanguage: 'zh', sessionId: original.id })))
      .rejects.toMatchObject({ code: 'TRANSLATION_STORAGE_ERROR' })
    expect(await b.readEvents(original.id)).toEqual(original.events)
    expect(b.requests).toEqual([])
  })

  it('refuses a historical artifact deleted after admission before dispatch', async () => {
    const b = await storageFixture(cleanups), original = await b.createSession(SessionId('deleted'), false)
    const stat = b.ctx.sessionPersistence.stat.bind(b.ctx.sessionPersistence)
    vi.spyOn(b.ctx.sessionPersistence, 'stat').mockImplementation(async (id, options) => {
      const value = await stat(id, options); await rm(original.file); return value
    })
    await expect(b.ctx.translator.translate(b.ctx.translator.resolve({ text: 'source', targetLanguage: 'zh', sessionId: original.id })))
      .rejects.toMatchObject({ code: 'TRANSLATION_SESSION_REQUIRED' })
    expect(b.requests).toEqual([])
  })
})
