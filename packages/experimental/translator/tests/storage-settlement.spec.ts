/** Accepted writes retain translation admission after a consumer's cancellation race settles. */
import type { Context } from '@deepseek-ai/cordis'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TranslationError } from '../src/error.ts'
import { TranslationStorage } from '../src/storage.ts'
import type { TranslationIdentity } from '../src/types.ts'
import { storageFixture } from './storage-fixture.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const identity: TranslationIdentity = { provider: 'bing', text: 'source', sourceLanguage: 'auto', targetLanguage: 'zh', recipe: 'fixture' }

describe('accepted translation write settlement', () => {
  it.each([false, true])('holds identical admission until the accepted result write settles (reject=%s)', async (rejectWrite) => {
    const b = await storageFixture(cleanups), original = await b.createSession(), storage = new TranslationStorage(b.ctx)
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const deadline = Promise.withResolvers<never>()
    const stopped = new TranslationError('TRANSLATION_TIMEOUT', 'consumer deadline'), writeFailure = new Error('verification unavailable')
    const flush = b.ctx.sessions.flush.bind(b.ctx.sessions)
    let flushes = 0
    vi.spyOn(b.ctx.sessions, 'flush').mockImplementation(async (session) => {
      const flushed = await flush(session)
      if (++flushes === 2) {
        entered.resolve(undefined); await release.promise
        if (rejectWrite) throw writeFailure
      }
      return flushed
    })
    const stat = vi.spyOn(b.ctx.sessionPersistence, 'stat')
    const writes: { settled?: Promise<unknown> } = {}
    const first = storage.run(original.id, identity, new AbortController().signal, async (log) => {
      const seq = await log.request(identity), writing = log.result(seq, 'Saved translation')
      writes.settled = writing.catch((error: unknown) => error)
      return await Promise.race([writing.then(() => 'Saved translation'), deadline.promise])
    })
    const rejected = expect(first).rejects.toMatchObject({ code: 'TRANSLATION_TIMEOUT' })
    const pending: Promise<unknown>[] = [first]
    try {
      await entered.promise
      deadline.reject(stopped)
      await rejected
      let retrySettled = false
      const dispatch = vi.fn(async () => 'Unexpected second provider call')
      const retry = storage.run(original.id, identity, new AbortController().signal, dispatch)
      pending.push(retry)
      void retry.then(() => { retrySettled = true }, () => { retrySettled = true })
      const otherIdentity = { ...identity, text: 'other source' }
      expect(await storage.run(original.id, otherIdentity, new AbortController().signal, async (log) => {
        const seq = await log.request(otherIdentity)
        await log.result(seq, 'Other translation')
        return 'Other translation'
      })).toBe('Other translation')
      expect(stat).toHaveBeenCalledTimes(2)
      expect(retrySettled).toBe(false)
      release.resolve(undefined)
      expect(await retry).toBe('Saved translation')
      expect(dispatch).not.toHaveBeenCalled()
      expect(await writes.settled).toEqual(rejectWrite ? expect.objectContaining({ code: 'TRANSLATION_STORAGE_ERROR' }) : undefined)
      expect((await b.readEvents(original.id)).filter(event => pluginRecordOf(event)?.type === 'plugin:translator/result')).toHaveLength(2)
    } finally {
      release.resolve(undefined)
      await Promise.allSettled(pending)
      await writes.settled
    }
  })

  it('keeps storage disposal pending until a write outliving its consumer settles', async () => {
    const b = await storageFixture(cleanups), original = await b.createSession()
    let storage: TranslationStorage | undefined
    const owner = b.ctx.plugin({ apply(ctx: Context) { storage = new TranslationStorage(ctx) } })
    await owner.await()
    if (storage === undefined) throw new Error('Storage owner did not activate')
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const deadline = Promise.withResolvers<never>()
    const flush = b.ctx.sessions.flush.bind(b.ctx.sessions)
    let flushes = 0
    vi.spyOn(b.ctx.sessions, 'flush').mockImplementation(async (session) => {
      const flushed = await flush(session)
      if (++flushes === 2) { entered.resolve(undefined); await release.promise }
      return flushed
    })
    const first = storage.run(original.id, identity, new AbortController().signal, async (log) => {
      const seq = await log.request(identity)
      return await Promise.race([log.result(seq, 'Saved translation').then(() => 'Saved translation'), deadline.promise])
    })
    const rejected = expect(first).rejects.toMatchObject({ code: 'TRANSLATION_TIMEOUT' })
    let disposing: Promise<void> | undefined
    try {
      await entered.promise
      deadline.reject(new TranslationError('TRANSLATION_TIMEOUT', 'consumer deadline'))
      await rejected
      let disposed = false
      disposing = owner.dispose().then(() => { disposed = true })
      await b.readEvents(original.id)
      expect(disposed).toBe(false)
      release.resolve(undefined)
      await disposing
      expect(disposed).toBe(true)
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([first, disposing])
    }
  })
})
