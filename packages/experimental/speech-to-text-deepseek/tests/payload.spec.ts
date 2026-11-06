/** Endpoint validation, credential names, schema defaults, PCM alignment, and multipart encoding. */
import { describe, expect, it } from 'vitest'
import { multipartBody, pcmPayload } from '../src/audio.ts'
import { Config, resolveOptions } from '../src/config.ts'
import { wave } from './service-double.ts'

describe('configuration', () => {
  it('defaults to the production endpoint and the service limits', () => {
    const options = resolveOptions(Config({}))
    expect(options).toMatchObject({ providerId: 'deepseek-asr', timeoutMs: 30_000,
      maxRequestBytes: 3_932_160, maxDurationSeconds: 120, maxResponseBytes: 65_536,
      languages: ['auto', 'zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt', 'yue', 'ko'] })
    expect(options.endpoint.href).toBe('https://harness.deepseek.com/api/v0/asr/transcribe')
  })

  it('requires automatic detection among the configured languages', () => {
    expect(() => resolveOptions(Config({ endpoint: 'https://api.example/asr', languages: ['zh'] }))).toThrow('must include `auto`')
    expect(() => Config({ endpoint: 'https://api.example/asr', languages: ['zh-CN'] })).toThrow()
  })

  it('sends tokens only over HTTPS or explicitly allowed loopback HTTP', () => {
    for (const endpoint of ['https://user:pass@api.example/asr', 'https://api.example/asr?x=1', 'https://api.example/asr#f']) {
      expect(() => resolveOptions(Config({ endpoint }))).toThrow('credentials, a query or a fragment')
    }
    expect(() => resolveOptions(Config({ endpoint: 'http://api.example/asr', allowLoopbackHttp: true }))).toThrow('HTTPS')
    expect(() => resolveOptions(Config({ endpoint: 'http://127.0.0.1:9/asr' }))).toThrow('HTTPS')
    expect(resolveOptions(Config({ endpoint: 'http://127.0.0.1:9/asr', allowLoopbackHttp: true })).endpoint.origin).toBe('http://127.0.0.1:9')
    expect(() => resolveOptions(Config({ endpoint: 'not a url' }))).toThrow()
  })
})

describe('audio payload', () => {
  it('strips the WAV header and zero-pads samples to 32 bytes', () => {
    const { pcm, seconds } = pcmPayload(wave(93_502), 120)
    expect(pcm.byteLength).toBe(93_504)
    expect(seconds).toBeCloseTo(93_502 / 32_000)
    expect([...pcm.subarray(0, 3)]).toEqual([0, 1, 2])
    expect([...pcm.subarray(93_502)]).toEqual([0, 0])
    expect(pcmPayload(wave(64), 120).pcm.byteLength).toBe(64)
  })

  it('classifies malformed and overlong recordings as invalid audio', () => {
    expect(() => pcmPayload(new Uint8Array(10), 120)).toThrow(expect.objectContaining({ code: 'invalid-audio' }))
    expect(() => pcmPayload(wave(64_000), 1)).toThrow(expect.objectContaining({ code: 'invalid-audio', message: 'Audio exceeds 1 seconds' }))
  })

  it('encodes fields and the file as standard multipart form data', async () => {
    const bytes = new Uint8Array([0, 13, 10, 45, 45, 255])
    const { body, contentType } = multipartBody([['format', 'pcm'], ['audio_id', 'id-1']], { name: 'file', filename: 'recording.pcm', bytes })
    const form = await new Response(body, { headers: { 'content-type': contentType } }).formData()
    expect(form.get('format')).toBe('pcm')
    expect(form.get('audio_id')).toBe('id-1')
    const file = form.get('file')
    expect(file).toBeInstanceOf(File)
    expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(bytes)
  })
})
