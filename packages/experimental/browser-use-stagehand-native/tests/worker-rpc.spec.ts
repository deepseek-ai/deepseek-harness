/** Message-port requests retain their errors and release canceled reply channels. */

import { getEventListeners, once } from 'node:events'
import { MessageChannel } from 'node:worker_threads'
import type { MessagePort } from 'node:worker_threads'
import { afterEach, expect, it, vi } from 'vitest'
import { StagehandError } from '../src/error.ts'
import { answer, request, requestSchema } from '../src/worker-rpc.ts'

const cleanups: Array<() => Promise<void>> = []

function channel() {
  const pair = new MessageChannel()
  const closed = Promise.all([once(pair.port1, 'close'), once(pair.port2, 'close')])
  cleanups.push(async () => {
    pair.port1.close()
    pair.port2.close()
    await closed
  })
  return pair
}

async function receive(port: MessagePort): Promise<unknown> {
  const [raw] = await once(port, 'message') as [unknown]
  const { reply } = requestSchema.parse(raw)
  const closed = once(reply, 'close')
  cleanups.push(async () => {
    reply.close()
    await closed
  })
  return raw
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

it('round-trips the operation and structured data through a dedicated reply channel', async () => {
  const { port1, port2 } = channel()
  const incoming = receive(port2)
  const result = request(port1, 'extract', { pageId: 'tab-1', instruction: 'Read the heading.' })
  const raw = await incoming
  const execute = vi.fn(async () => ({ heading: 'Fixture', count: 2 }))
  await answer(raw, execute)
  expect(await result).toEqual({ heading: 'Fixture', count: 2 })
  expect(execute).toHaveBeenCalledWith('extract', { pageId: 'tab-1', instruction: 'Read the heading.' })
})

it.each([new Error('Browser operation failed'), 'Browser operation refused'])(
  'reports an operation rejection to the requesting peer: %s',
  async (failure) => {
    const { port1, port2 } = channel()
    const incoming = receive(port2)
    const result = request(port1, 'navigate', { url: 'https://example.com' })
    const rejected = expect(result).rejects.toMatchObject({
      constructor: StagehandError, code: 'STAGEHAND_OPERATION_FAILED', message: failure instanceof Error ? failure.message : failure,
    })
    const raw = await incoming
    await answer(raw, async () => { throw failure })
    await rejected
  },
)

it('rebuilds a StagehandError from its transported name and code', async () => {
  const { port1, port2 } = channel()
  const incoming = receive(port2)
  const result = request(port1, 'act', { instruction: 'Click the button.' })
  const rejected = expect(result).rejects.toMatchObject({ constructor: StagehandError, name: 'StagehandError', code: 'STAGEHAND_ACT_FAILED', message: 'Button missing' })
  await answer(await incoming, async () => { throw new StagehandError('Button missing', 'STAGEHAND_ACT_FAILED') })
  await rejected
})

it.each([
  { ok: false, error: 'Unknown failure', name: 'StagehandError', code: 'STAGEHAND_UNKNOWN' },
  { ok: false, error: 'Foreign failure', name: 'OtherError', code: 'STAGEHAND_ACT_FAILED' },
])('classifies an unknown transported identity as an operation failure: %j', async (response) => {
  const { port1, port2 } = channel()
  const incoming = receive(port2)
  const result = request(port1, 'act', { instruction: 'Click the button.' })
  const rejected = expect(result).rejects.toMatchObject({ name: 'StagehandError', code: 'STAGEHAND_OPERATION_FAILED', message: response.error })
  const { reply } = requestSchema.parse(await incoming)
  reply.postMessage(response)
  await rejected
})

it.each([
  { ok: true, value: 'unexpected', extra: true },
  { ok: false, error: 42 },
  { value: 'missing status' },
])('rejects a malformed peer response and closes its reply port: %j', async (response) => {
  const { port1, port2 } = channel()
  const incoming = receive(port2)
  const result = request(port1, 'tabs', { action: 'list' })
  const rejected = expect(result).rejects.toMatchObject({ name: 'StagehandError', code: 'STAGEHAND_WORKER_FAILED', message: 'Stagehand Worker returned a malformed response' })
  const raw = await incoming
  const { reply } = requestSchema.parse(raw)
  const closed = once(reply, 'close')
  reply.postMessage(response)
  await rejected
  await closed
})

it('rejects peer shutdown before a response instead of leaving the request pending', async () => {
  const { port1, port2 } = channel()
  const incoming = receive(port2)
  const result = request(port1, 'observe', { instruction: 'Find a button.' })
  const rejected = expect(result).rejects.toMatchObject({ name: 'StagehandError', code: 'STAGEHAND_WORKER_FAILED', message: expect.stringContaining('Worker reply channel closed') as string })
  const raw = await incoming
  const { reply } = requestSchema.parse(raw)
  const closed = once(reply, 'close')
  reply.close()
  await Promise.all([rejected, closed])
})

it.each([new Error('Session disposed'), 'canceled'])(
  'closes an unanswered reply channel and removes its cancellation listener: %s',
  async (reason) => {
    const { port1, port2 } = channel()
    const incoming = receive(port2)
    const controller = new AbortController()
    const result = request(port1, 'act', { instruction: 'Click the button.' }, controller.signal)
    const rejected = expect(result).rejects.toMatchObject(reason instanceof Error ? reason : { name: 'StagehandError', code: 'STAGEHAND_WORKER_FAILED', message: 'Stagehand Worker request canceled' })
    const raw = await incoming
    const { reply } = requestSchema.parse(raw)
    const closed = once(reply, 'close')
    controller.abort(reason)
    await Promise.all([rejected, closed])
    expect(getEventListeners(controller.signal, 'abort')).toEqual([])
  },
)

it('does not dispatch an already canceled request', async () => {
  const { port1, port2 } = channel()
  const received = vi.fn()
  port2.on('message', received)
  const controller = new AbortController()
  controller.abort(new Error('Canceled before dispatch'))
  await expect(request(port1, 'tabs', undefined, controller.signal)).rejects.toThrow('Canceled before dispatch')
  expect(getEventListeners(controller.signal, 'abort')).toEqual([])
  const closed = once(port1, 'close')
  port1.close()
  await closed
  expect(received).not.toHaveBeenCalled()
})

it('reports clone failure when request arguments cannot cross a Worker boundary', async () => {
  const { port1 } = channel()
  await expect(request(port1, 'extract', { callback() {} })).rejects.toMatchObject({ name: 'StagehandError', code: 'STAGEHAND_WORKER_FAILED', message: expect.stringMatching(/clone/u) as string })
})

it('rejects malformed request envelopes before invoking the operation', async () => {
  const execute = vi.fn(async () => undefined)
  await expect(answer({ method: 1, args: {} }, execute)).rejects.toThrow()
  expect(execute).not.toHaveBeenCalled()
})

it('returns a clone failure to the caller when the operation result is not transferable', async () => {
  const { port1, port2 } = channel()
  const incoming = receive(port2)
  const result = request(port1, 'extract')
  const rejected = expect(result).rejects.toThrow(/clone/u)
  const raw = await incoming
  await answer(raw, async () => ({ callback() {} }))
  await rejected
})
