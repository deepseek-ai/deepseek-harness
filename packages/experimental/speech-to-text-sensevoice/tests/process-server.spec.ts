/** The private recognizer admits only authenticated bounded audio requests. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { SpeechInputError } from '../src/input.ts'
import { startRecognitionServer } from '../src/process-server.ts'

it('serves transcripts on an ephemeral loopback port and rejects unauthorized or invalid requests', async () => {
  const transcribe = vi.fn(() => ({ text: 'hello', audioSeconds: 1, inferenceSeconds: 0.1 }))
  const { server, port } = await startRecognitionServer('private-token', 100, transcribe)
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  })
  const base = `http://127.0.0.1:${port}`
  const headers = { authorization: 'Bearer private-token' }, body = Buffer.alloc(46)
  expect((await fetch(base)).status).toBe(401)
  expect((await fetch(base, { headers: { authorization: 'Bearer another-token' } })).status).toBe(401)
  expect((await fetch(`${base}/missing`, { headers })).status).toBe(404)
  expect((await fetch(`${base}/transcribe`, { method: 'POST', headers, body: Buffer.alloc(101) })).status).toBe(413)
  expect((await fetch(`${base}/transcribe`, { method: 'POST', headers, body: Buffer.alloc(1) })).status).toBe(413)
  const good = await fetch(`${base}/transcribe?language=zh`, { method: 'POST', headers, body })
  expect(await good.json()).toEqual({ text: 'hello', audioSeconds: 1, inferenceSeconds: 0.1 })
  expect(transcribe).toHaveBeenLastCalledWith(body, 'zh')
  transcribe.mockImplementationOnce(() => { throw new SpeechInputError('bad audio') })
  const bad = await fetch(`${base}/transcribe`, { method: 'POST', headers, body })
  expect(bad.status).toBe(400)
  expect(await bad.json()).toEqual({ error: 'bad audio', code: 'invalid-input' })
  expect(transcribe).toHaveBeenLastCalledWith(body, 'auto')
  transcribe.mockImplementationOnce(() => { throw 'native failure' })
  const failure = await fetch(`${base}/transcribe`, { method: 'POST', headers, body })
  expect(failure.status).toBe(500)
  expect(await failure.json()).toEqual({ error: 'native failure' })
  transcribe.mockImplementationOnce(() => { throw new Error('native decode failed') })
  const nativeFailure = await fetch(`${base}/transcribe`, { method: 'POST', headers, body })
  expect(nativeFailure.status).toBe(500)
  expect(await nativeFailure.json()).toEqual({ error: 'native decode failed' })
})
