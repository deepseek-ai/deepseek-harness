/** Browser recording bytes conform to the Host's fixed PCM format. */
import { afterEach, expect, it, vi } from 'vitest'
import { audioBase64, encodeWave, Recording, RecordingError } from '../src/client/audio.ts'
import { captureFixture } from './audio-fixture.client.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('encodes bounded PCM samples and base64 across chunk boundaries', () => {
  const bytes = encodeWave(new Float32Array([-2, -0.5, 0, 0.5, 2]))
  const view = new DataView(bytes.buffer)
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF')
  expect(view.getUint32(24, true)).toBe(16000)
  expect(view.getUint32(40, true)).toBe(10)
  expect([0, 1, 2, 3, 4].map(i => view.getInt16(44 + i * 2, true))).toEqual([-32768, -16384, 0, 16384, 32767])
  const large = encodeWave(new Float32Array(17000))
  expect(Buffer.from(audioBase64(large), 'base64')).toEqual(Buffer.from(large))
})

it('reports unavailable recording and denied permission', async () => {
  vi.stubGlobal('navigator', {})
  const recording = new Recording(() => {})
  await expect(recording.start()).rejects.toMatchObject({ kind: 'unavailable' })
  await expect(recording.preview()).rejects.toMatchObject({ kind: 'unavailable' })
  vi.stubGlobal('MediaRecorder', function RecorderStub() {})
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => { throw new DOMException('denied', 'NotAllowedError') } } })
  await expect(recording.start()).rejects.toMatchObject({ kind: 'permission' })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => { throw new Error('device lost') } } })
  await expect(recording.start()).rejects.toThrow('device lost')
  expect(new RecordingError('empty').message).toBe('empty')
})

it('releases a microphone granted after cancellation', async () => {
  const permission = Promise.withResolvers<{ getTracks: () => { stop: () => void }[] }>()
  const stop = vi.fn(), dispose = vi.fn()
  vi.stubGlobal('MediaRecorder', function RecorderStub() {})
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => permission.promise } })
  const recording = new Recording(dispose)
  const acquiring = recording.start()
  await recording.dispose()
  permission.resolve({ getTracks: () => [{ stop }] })
  await expect(acquiring).rejects.toMatchObject({ kind: 'cancelled' })
  expect(stop).toHaveBeenCalledOnce()
  expect(dispose).toHaveBeenCalledOnce()
})


it('flushes final recording bytes, bounds timer overshoot and closes audio resources', async () => {
  const b = captureFixture()
  expect(b.recording.amplitude()).toBe(0)
  await b.recording.start()
  expect(b.recording.amplitude()).toBe(0.25)
  const result = await b.recording.stop(1)
  expect(new TextDecoder().decode(b.decoding.mock.calls[0]![0])).toBe('final audio')
  expect(b.offline).toHaveBeenCalledWith(1, 16000, 16000)
  expect(result).toEqual(encodeWave(new Float32Array([0.5, -0.5])))
  expect(b.trackStop).toHaveBeenCalled()
  expect(b.close).toHaveBeenCalledOnce()
  await b.recording.dispose()
  expect(b.close).toHaveBeenCalledOnce()
})

it.each([{ empty: true }, { recorderError: true }, { constructError: true }])('releases failed capture resources: %j', async (options) => {
  const b = captureFixture(options)
  if (options.constructError) await expect(b.recording.start()).rejects.toThrow('recorder unavailable')
  else { await b.recording.start(); await expect(b.recording.stop(120)).rejects.toMatchObject({ kind: 'empty' }) }
  expect(b.trackStop).toHaveBeenCalled()
  expect(b.close).toHaveBeenCalledOnce()
})

it('discards decoding results that finish after cancellation', async () => {
  const b = captureFixture(), decoded = Promise.withResolvers<{ duration: number }>()
  b.decoding.mockReturnValueOnce(decoded.promise)
  await b.recording.start()
  const stopping = b.recording.stop(120), rejected = expect(stopping).rejects.toMatchObject({ kind: 'cancelled' })
  await vi.waitFor(() => { expect(b.decoding).toHaveBeenCalledOnce() })
  await b.recording.dispose()
  decoded.resolve({ duration: 2 })
  await rejected
  expect(b.rendering).not.toHaveBeenCalled()
  await expect(b.recording.stop(120)).rejects.toMatchObject({ kind: 'empty' })
})

it('releases active capture on a spontaneous recorder error even when AudioContext.close rejects', async () => {
  const b = captureFixture()
  await b.recording.start()
  b.close.mockRejectedValueOnce(new Error('audio device disconnected'))
  b.failRecorder()
  await vi.waitFor(() => { expect(b.disposed).toHaveBeenCalledOnce() })
  expect(b.trackStop).toHaveBeenCalled()
  await expect(b.recording.dispose()).rejects.toThrow('audio device disconnected')
})

it.each([false, true])('shares pending AudioContext closure across repeated release (failure=%s)', async (failed) => {
  const b = captureFixture(), closing = Promise.withResolvers<undefined>()
  b.close.mockReturnValueOnce(closing.promise)
  await b.recording.start()
  const first = b.recording.dispose(), second = b.recording.dispose()
  const results = Promise.allSettled([first, second])
  try {
    expect(first).toBe(second)
    expect(b.trackStop).toHaveBeenCalledOnce()
    expect(b.close).toHaveBeenCalledOnce()
    expect(b.disposed).not.toHaveBeenCalled()
  } finally {
    if (failed) closing.reject(new Error('audio close failed'))
    else closing.resolve(undefined)
    await results
  }
  expect(b.disposed).toHaveBeenCalledOnce()
  expect(b.recording.dispose()).toBe(first)
  expect((await results).map(result => result.status)).toEqual(failed ? ['rejected', 'rejected'] : ['fulfilled', 'fulfilled'])
})

it('reports a device interruption once while resource closure is still pending', async () => {
  const b = captureFixture(), closing = Promise.withResolvers<undefined>(), failure = vi.fn()
  b.close.mockReturnValueOnce(closing.promise)
  await b.recording.start(failure)
  try {
    b.failRecorder(); b.failRecorder()
    expect(failure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'interrupted' }))
    expect(b.trackStop).toHaveBeenCalledOnce()
    expect(b.disposed).not.toHaveBeenCalled()
  } finally { closing.resolve(undefined); await b.recording.dispose() }
  expect(b.disposed).toHaveBeenCalledOnce()
})

it('contains a failing interruption callback and still releases the microphone', async () => {
  const b = captureFixture(), error = new Error('callback failed'), report = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await b.recording.start(() => { throw error })
    b.failRecorder()
    await b.recording.dispose()
    expect(b.trackStop).toHaveBeenCalledOnce()
    expect(b.disposed).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith('Speech recording error handler failed', error)
  } finally { report.mockRestore(); await b.recording.dispose() }
})

it('previews an exact microphone without creating a recorder and releases it when disconnected', async () => {
  const b = captureFixture({ constructError: true }), failure = vi.fn()
  const preview = new Recording(() => {}, 'usb-microphone')
  expect(preview.deviceInfo()).toBeUndefined()
  try {
    await preview.preview(failure)
    expect(preview.deviceInfo()).toEqual({ label: 'Fixture microphone', groupId: 'fixture-input' })
    vi.spyOn(b.stream.getAudioTracks()[0]!, 'getSettings').mockReturnValue({})
    expect(preview.deviceInfo()).toEqual({ label: 'Fixture microphone', groupId: '' })
    expect(b.getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: 'usb-microphone' },
      echoCancellation: true, noiseSuppression: true }, video: false })
    expect(preview.amplitude()).toBe(0.25)
    b.track.dispatchEvent(new Event('ended'))
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ kind: 'interrupted' }))
    expect(b.trackStop).toHaveBeenCalledOnce()
    expect(preview.amplitude()).toBe(0)
  } finally { await preview.dispose() }
})

it.each(['NotFoundError', 'OverconstrainedError'])('reports an unavailable selected microphone on %s without falling back', async (name) => {
  const b = captureFixture(), recording = new Recording(() => {}, 'removed')
  b.getUserMedia.mockRejectedValueOnce(new DOMException('missing device', name))
  try {
    await expect(recording.start()).rejects.toMatchObject({ kind: 'deviceMissing' })
    expect(b.getUserMedia).toHaveBeenCalledOnce()
  } finally { await recording.dispose() }
})

it('releases the microphone if audio analysis cannot initialize', async () => {
  const b = captureFixture()
  vi.stubGlobal('AudioContext', function AudioUnavailable() { throw new Error('audio unavailable') })
  try {
    await expect(b.recording.preview()).rejects.toThrow('audio unavailable')
    expect(b.trackStop).toHaveBeenCalledOnce()
  } finally { await b.recording.dispose() }
})

it('preserves browser device-busy errors', async () => {
  const b = captureFixture(), error = new DOMException('busy', 'NotReadableError')
  b.getUserMedia.mockRejectedValueOnce(error)
  try { await expect(b.recording.preview()).rejects.toBe(error) } finally { await b.recording.dispose() }
})

it('does not create a recorder after cancellation at preview completion', async () => {
  const b = captureFixture(), ready = Promise.withResolvers<undefined>(), proceed = Promise.withResolvers<undefined>()
  const preview = b.recording.preview.bind(b.recording)
  vi.spyOn(b.recording, 'preview').mockImplementation(async (onError) => { await preview(onError); ready.resolve(undefined); await proceed.promise })
  const starting = b.recording.start(), rejected = expect(starting).rejects.toMatchObject({ kind: 'cancelled' })
  try {
    await ready.promise
    await b.recording.dispose()
    proceed.resolve(undefined)
    await rejected
    expect(b.trackStop).toHaveBeenCalledOnce()
  } finally { proceed.resolve(undefined); await b.recording.dispose() }
})
