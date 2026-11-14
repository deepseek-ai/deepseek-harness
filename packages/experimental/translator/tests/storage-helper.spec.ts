/** Storage helpers classify their own failures before a provider consumer can catch them. */
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TranslationStorage } from '../src/storage.ts'
import type { TranslationIdentity } from '../src/types.ts'
import { storageFixture } from './storage-fixture.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const identity: TranslationIdentity = { provider: 'bing', text: 'source', sourceLanguage: 'auto', targetLanguage: 'zh', recipe: 'fixture' }
const stages = ['request', 'result'] as const

describe('storage helper failures', () => {
  it.each(stages)('classifies %s I/O failures before returning them to the consumer', async (stage) => {
    const b = await storageFixture(cleanups), original = await b.createSession(), storage = new TranslationStorage(b.ctx)
    let observed: unknown
    const outcome = await storage.run(original.id, identity, new AbortController().signal, async (log) => {
      const seq = stage === 'result' ? await log.request(identity) : SessionSeq(0)
      vi.spyOn(b.ctx.sessionPersistence, 'open').mockRejectedValueOnce(new Error('private storage path or source'))
      try {
        if (stage === 'request') await log.request(identity)
        else await log.result(seq, 'complete')
      } catch (error) { observed = error; throw error }
      return 'unexpected success'
    }).catch((error: unknown) => error)
    expect(observed).toMatchObject({ code: 'TRANSLATION_STORAGE_ERROR', message: 'Stored translation records are invalid or unavailable' })
    expect(outcome).toBe(observed)
    expect(b.requests).toEqual([])
  })

  it.each(stages)('classifies %s writer failures after its artifact is removed', async (stage) => {
    const b = await storageFixture(cleanups), original = await b.createSession(), storage = new TranslationStorage(b.ctx)
    let observed: unknown
    const outcome = await storage.run(original.id, identity, new AbortController().signal, async (log) => {
      const seq = stage === 'result' ? await log.request(identity) : SessionSeq(0)
      await rm(original.file)
      try {
        if (stage === 'request') await log.request(identity)
        else await log.result(seq, 'complete')
      } catch (error) { observed = error; throw error }
      return 'unexpected success'
    }).catch((error: unknown) => error)
    expect(observed).toMatchObject({ code: 'TRANSLATION_STORAGE_ERROR' })
    expect(outcome).toBe(observed)
    expect(b.requests).toEqual([])
  })

  it.each(stages)('preserves the exact caller abort reason inside %s', async (stage) => {
    const b = await storageFixture(cleanups), original = await b.createSession(), storage = new TranslationStorage(b.ctx)
    const caller = new AbortController(), reason = { canceled: true }
    let observed: unknown
    const outcome = await storage.run(original.id, identity, caller.signal, async (log) => {
      const seq = stage === 'result' ? await log.request(identity) : SessionSeq(0)
      caller.abort(reason)
      try {
        if (stage === 'request') await log.request(identity)
        else await log.result(seq, 'complete')
      } catch (error) { observed = error; throw error }
      return 'unexpected success'
    }).catch((error: unknown) => error)
    expect(observed).toBe(reason)
    expect(outcome).toBe(reason)
    expect(b.requests).toEqual([])
  })
})
