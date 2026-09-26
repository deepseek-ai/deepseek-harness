/** Source races are controlled by response barriers and share preparation cancellation. */
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { orderModelSources } from '../src/model-sources.ts'

const origins = ['https://huggingface.co', 'https://hf-mirror.com'] as const
const path = '/owner/model/resolve/pinned/model.onnx'
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

function race() {
  const requests = new Map<string, ReturnType<typeof Promise.withResolvers<Response>> & { signal: AbortSignal }>()
  const fetcher = vi.fn((url: string, init: RequestInit) => {
    const signal = init.signal!
    const pending = Promise.withResolvers<Response>()
    const abort = () => { pending.reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    requests.set(url, { ...pending, signal })
    return pending.promise.finally(() => { signal.removeEventListener('abort', abort) })
  })
  vi.stubGlobal('fetch', fetcher)
  const cancel = new AbortController()
  const result = orderModelSources(origins[0] + path, origins, 50, cancel.signal)
  onTestFinished(async () => { cancel.abort(); await result.catch(() => {}) })
  const request = (origin: string) => requests.get(origin + path)!
  return { request, fetcher, cancel, result }
}

it.each(origins)('prefers %s after its first successful response and joins the other request', async (winner) => {
  vi.useFakeTimers()
  const { request, fetcher, result } = race()
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher).toHaveBeenCalledWith(winner + path, expect.objectContaining({ method: 'HEAD' }))
  request(winner).resolve(new Response(null))
  expect(await result).toEqual([winner + path, ...origins.filter(origin => origin !== winner).map(origin => origin + path)])
  expect(origins.every(origin => request(origin).signal.aborted)).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('ignores a faster HTTP error and releases any returned bodies', async () => {
  const { request, result } = race()
  const cancel = vi.fn()
  request(origins[0]).resolve(new Response(new ReadableStream({ cancel }), { status: 503 }))
  request(origins[1]).resolve(new Response(null))
  expect(await result).toEqual([origins[1] + path, origins[0] + path])
  expect(cancel).toHaveBeenCalledOnce()
})

it('preserves configured order if every probe fails', async () => {
  const { request, result } = race()
  request(origins[0]).reject(new TypeError('offline'))
  request(origins[1]).resolve(new Response(null, { status: 405 }))
  expect(await result).toEqual(origins.map(origin => origin + path))
})

it('bounds probes without cancelling the following download', async () => {
  vi.useFakeTimers()
  const { request, result, cancel } = race()
  await vi.advanceTimersByTimeAsync(50)
  expect(await result).toEqual(origins.map(origin => origin + path))
  expect(origins.every(origin => request(origin).signal.aborted)).toBe(true)
  expect(cancel.signal.aborted).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it('rejects preparation cancellation after joining both probes', async () => {
  const { request, result, cancel } = race()
  const reason = new Error('cancelled')
  const rejected = expect(result).rejects.toBe(reason)
  cancel.abort(reason)
  await rejected
  expect(origins.every(origin => request(origin).signal.aborted)).toBe(true)
})

it('uses a single deduplicated origin without probing and rejects already cancelled preparation', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  expect(await orderModelSources(origins[0] + path, ['https://private.example', 'https://private.example/'], 50,
    new AbortController().signal)).toEqual(['https://private.example' + path])
  await expect(orderModelSources(origins[0] + path, origins, 50, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled')
  expect(fetcher).not.toHaveBeenCalled()
})

it('waits for body cleanup without changing the winning source', async () => {
  const { request, result } = race()
  const cleanup = Promise.withResolvers<undefined>(), cancelling = Promise.withResolvers<undefined>(), settled = vi.fn()
  void result.then(settled)
  request(origins[1]).resolve(new Response(new ReadableStream({ cancel() { cancelling.resolve(undefined); return cleanup.promise } })))
  try {
    await cancelling.promise
    expect(settled).not.toHaveBeenCalled()
    cleanup.resolve(undefined)
    expect(await result).toEqual([origins[1] + path, origins[0] + path])
  } finally { cleanup.resolve(undefined); await result }
})
