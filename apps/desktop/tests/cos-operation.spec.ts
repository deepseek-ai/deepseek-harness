import { Readable, Writable } from 'node:stream'
import type { ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cosOperation } from '../scripts/cos-operation.ts'
import { createDesktopCos } from '../scripts/desktop-cos.ts'
import { answer, cosError, startCosLoopback, type CosLoopback } from './cos-loopback.ts'

const loopbacks: CosLoopback[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(loopbacks.splice(0).map(loopback => loopback.close()))
})

const object = { Bucket: 'fixture-1250000000', Region: 'ap-beijing', Key: 'object' }

async function fixture(retry = false) {
  const received = Promise.withResolvers<ServerResponse>()
  const disconnected = Promise.withResolvers<undefined>()
  const loopback = await startCosLoopback((_request, response) => {
    if (retry && loopback.requests.length === 1) {
      vi.advanceTimersByTime(20_000)
      answer(response, 500, cosError('InternalError'))
      return
    }
    response.once('close', () => { disconnected.resolve(undefined) })
    received.resolve(response)
  })
  loopbacks.push(loopback)
  const cos = createDesktopCos({ secretId: 'fixture-id', secretKey: 'fixture-key' })
  loopback.redirect(cos)
  // Only deadline timers are virtual; socket delivery and stream close remain real observations.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  return { cos, loopback, received: received.promise, disconnected: disconnected.promise }
}

describe('COS operation total deadlines', () => {
  it('aborts a stalled versioning retry within the original operation budget', async () => {
    const f = await fixture(true)
    const pending = cosOperation(f.cos, 30_000, () => f.cos.getBucketVersioning(object))
    const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
    await f.received
    vi.advanceTimersByTime(10_000)
    await rejected
    await f.disconnected
    // The aborted signal also prevents the SDK from opening sockets for later retry attempts.
    expect(f.loopback.requests).toHaveLength(2)
  })

  it('aborts an active download despite ongoing data and closes its request', async () => {
    const f = await fixture()
    let received = Promise.withResolvers<undefined>()
    let size = 0
    const output = new Writable({ write(bytes: Buffer, _encoding, done) {
      size += bytes.length; received.resolve(undefined); done()
    } })
    const pending = cosOperation(f.cos, 900_000, () => f.cos.getObject({ ...object, Output: output }))
    const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
    try {
      const response = await f.received
      response.writeHead(200, { 'content-length': '100' })
      for (let i = 0; i < 3; i++) {
        received = Promise.withResolvers<undefined>()
        response.write('x')
        await received.promise
        vi.advanceTimersByTime(300_000)
      }
      await rejected
      await f.disconnected
      expect(size).toBe(3)
      expect(f.loopback.requests).toHaveLength(1)
    } finally { output.destroy() }
  })

  it('aborts a PUT awaiting confirmation without resending the object', async () => {
    const f = await fixture()
    const body = Readable.from(['bytes'])
    const pending = cosOperation(f.cos, 900_000, () => f.cos.putObject({ ...object, Body: body, ContentLength: 5 }))
    const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
    try {
      await f.received
      vi.advanceTimersByTime(900_000)
      await rejected
      await f.disconnected
      expect(f.loopback.requests).toHaveLength(1)
      expect(f.loopback.requests[0]!.body.toString()).toBe('bytes')
    } finally { body.destroy() }
  })

  it('clears the deadline after success and leaves another client running', async () => {
    const first = await fixture()
    const second = await fixture()
    const read = (f: Awaited<ReturnType<typeof fixture>>) => cosOperation(f.cos, 30_000, () => f.cos.getBucketVersioning(object))
    const success = read(first)
    const pending = read(second)
    answer(await first.received, 200, '<VersioningConfiguration/>')
    await success
    await first.disconnected
    const response = await second.received
    vi.advanceTimersByTime(29_999)
    answer(response, 200, '<VersioningConfiguration/>')
    await pending
    await second.disconnected
    expect(vi.getTimerCount()).toBe(0)
  })
})
