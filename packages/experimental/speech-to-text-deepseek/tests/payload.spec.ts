/** Schema defaults, recording checks, and the multipart body of a recognition request. */
import { describe, expect, it } from 'vitest'
import { multipartBody, recordingSeconds } from '../src/audio.ts'
import { Config, resolveOptions } from '../src/config.ts'
import { wave } from './service-double.ts'

describe('configuration', () => {
  it('defaults to the service limits', () => {
    expect(resolveOptions(Config({}))).toEqual({ providerId: 'deepseek-asr', timeoutMs: 30_000,
      maxRequestBytes: 8 * 1024 * 1024, maxDurationSeconds: 120, maxResponseBytes: 64 * 1024 })
  })
})

describe('recording', () => {
  it('measures canonical WAV recordings', () => {
    expect(recordingSeconds(wave(64_000), 120, 1 << 20)).toBe(2)
  })

  it('classifies malformed, overlong, and oversized recordings as invalid audio before sending', () => {
    expect(() => recordingSeconds(new Uint8Array(10), 120, 1 << 20)).toThrow(expect.objectContaining({ code: 'invalid-audio' }))
    expect(() => recordingSeconds(wave(64_000), 1, 1 << 20)).toThrow(expect.objectContaining({ code: 'invalid-audio', message: 'Audio exceeds 1 seconds' }))
    expect(() => recordingSeconds(wave(1000), 120, 1000))
      .toThrow(expect.objectContaining({ code: 'invalid-audio', message: 'Recording is 1044 bytes; the service accepts 1000' }))
  })

  it('sends the WAV bytes unchanged as the single file field', async () => {
    const recording = wave(6)
    const { body, contentType } = multipartBody(recording)
    const form = await new Response(body, { headers: { 'content-type': contentType } }).formData()
    expect([...form.keys()]).toEqual(['file'])
    const file = form.get('file')
    expect(file).toBeInstanceOf(File)
    expect((file as File).name).toBe('recording.wav')
    expect((file as File).type).toBe('audio/wav')
    expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(recording)
  })
})
