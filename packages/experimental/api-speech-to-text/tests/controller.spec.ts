/** Authenticated speech domain methods validate audio before selecting a recognizer. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import SpeechToText from '@deepseek-ai/dsh-experimental-speech-to-text'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import SpeechController from '../src/index.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => root.fiber.dispose())) })
const id = 'sensevoice-local' as SpeechProviderId
function fixture(maxAudioBytes = 32044, maxDurationSeconds = 1) {
  const ctx = new Context(); roots.push(ctx)
  const speech = new SpeechToText(ctx, SpeechToText.Config({ defaultProvider: id, language: 'auto' }))
  const recognize = vi.fn(async () => ({ text: '你好', audioSeconds: 1, inferenceSeconds: 0.1 }))
  speech.register({ info: { id, name: 'test', location: 'host-local', languages: ['auto', 'zh', 'en', 'ja'] }, transcribe: recognize })
  return { api: new SpeechController(ctx, { maxAudioBytes, maxDurationSeconds }), recognize }
}
function recording(): string {
  const b = Buffer.alloc(32044)
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(32000, 40)
  return b.toString('base64')
}

it('lists limits without inference and forwards explicit provider and language', async () => {
  const { api, recognize } = fixture()
  expect(api.catalog()).toMatchObject({ selection: { providerId: id }, maxAudioBytes: 32044, providers: [{ id }] })
  expect(recognize).not.toHaveBeenCalled()
  api.prepare(id)
  await api.cancelPreparation(id)
  const lifetime = new AbortController(), observation = api.follow(lifetime.signal)[Symbol.asyncIterator]()
  expect((await observation.next()).value).toMatchObject({ providers: [{ id, preparation: { phase: 'ready' } }] })
  lifetime.abort(); await observation.next()
  expect(await api.transcribe({ audioBase64: recording(), providerId: id, language: 'zh' }, new AbortController().signal)).toMatchObject({ text: '你好' })
  expect(recognize).toHaveBeenCalledWith(expect.objectContaining({ language: 'zh' }), expect.any(AbortSignal))
  await api.transcribe({ audioBase64: recording() }, new AbortController().signal)
  expect(recognize).toHaveBeenLastCalledWith(expect.objectContaining({ language: 'auto' }), expect.any(AbortSignal))
})

it('forwards an explicit download source to the registered preparation owner', async () => {
  const ctx = new Context(); roots.push(ctx)
  const speech = new SpeechToText(ctx, SpeechToText.Config({ defaultProvider: id }))
  const prepare = vi.fn()
  speech.register({ info: { id, name: 'local', location: 'host-local', languages: ['auto'], downloadSources: ['https://hf-mirror.com'] },
    preparation: { snapshot: () => ({ phase: 'unprepared' }), subscribe: () => () => {}, prepare, cancel: async () => {} },
    transcribe: async () => ({ text: '', audioSeconds: 0, inferenceSeconds: 0 }),
  })
  const api = new SpeechController(ctx, { maxAudioBytes: 32044, maxDurationSeconds: 1 })
  expect(api.catalog().providers[0]?.downloadSources).toEqual(['https://hf-mirror.com'])
  api.prepare(id, { downloadSource: 'https://hf-mirror.com' })
  expect(prepare).toHaveBeenCalledWith({ downloadSource: 'https://hf-mirror.com' })
})

it('rejects oversized, noncanonical, malformed and overlong audio without inference', async () => {
  const { api, recognize } = fixture()
  for (const audioBase64 of ['x'.repeat(50000), 'AAAA?', '', 'QQ==', recording() + '\n']) {
    await expect(api.transcribe({ audioBase64 }, new AbortController().signal)).rejects.toThrow()
  }
  await expect(fixture(32043).api.transcribe({ audioBase64: recording() }, new AbortController().signal)).rejects.toThrow('byte limit')
  const oversized = Buffer.concat([Buffer.from(recording(), 'base64'), Buffer.alloc(2)]).toString('base64')
  await expect(api.transcribe({ audioBase64: oversized }, new AbortController().signal)).rejects.toThrow('byte limit')
  await expect(fixture(32044, 0.5).api.transcribe({ audioBase64: recording() }, new AbortController().signal)).rejects.toThrow('exceeds')
  expect(recognize).not.toHaveBeenCalled()
})

it('preserves cancellation and reports recognizer failures', async () => {
  const { api, recognize } = fixture()
  await expect(api.configure({ language: 'zh' })).rejects.toThrow('settings service')
  await expect(api.transcribe({ audioBase64: recording() }, AbortSignal.abort(new Error('cancel')))).rejects.toThrow('cancel')
  recognize.mockRejectedValueOnce(new Error('offline'))
  await expect(api.transcribe({ audioBase64: recording() }, new AbortController().signal)).rejects.toMatchObject({ code: 'speech/transcription-failed', message: 'offline' })
  recognize.mockRejectedValueOnce('failed')
  await expect(api.transcribe({ audioBase64: recording() }, new AbortController().signal)).rejects.toMatchObject({ message: 'failed' })
})
