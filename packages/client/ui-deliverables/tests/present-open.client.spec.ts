/** Delivery gestures share pending state, report failures, and cancel with the plugin. */
import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { PresentedOpenController } from '../src/client/present-open.ts'

afterEach(() => { vi.unstubAllGlobals() })

const id = SessionId('fork')
const url = '/api/present.open?sessionId=fork&seq=2&index=1'

it('coalesces concurrent card and mention gestures, then allows another open', async () => {
  const reply = Promise.withResolvers<Response>()
  const fetcher = vi.fn().mockReturnValue(reply.promise)
  vi.stubGlobal('fetch', fetcher)
  const controller = new PresentedOpenController()
  const first = controller.open(id, 2, 1)
  await controller.open(id, 2, 1)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher).toHaveBeenCalledWith(url, { method: 'POST', signal: expect.any(AbortSignal) as AbortSignal })
  expect(controller.state.getSnapshot()[url]).toBe('opening')
  reply.resolve(new Response(null, { status: 204 }))
  await first
  expect(controller.state.getSnapshot()[url]).toBe('opened')
  await controller.open(id, 2, 1)
  expect(fetcher).toHaveBeenCalledTimes(2)
  await controller.dispose()
})

it.each(['http', 'network'])('publishes retryable %s failures', async (failure) => {
  const fetcher = vi.fn()
  if (failure === 'http') fetcher.mockResolvedValueOnce(new Response(null, { status: 500 }))
  else fetcher.mockRejectedValueOnce(new Error('offline'))
  fetcher.mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetcher)
  const controller = new PresentedOpenController()
  await controller.open(id, 2, 1)
  expect(controller.state.getSnapshot()[url]).toBe('error')
  await controller.open(id, 2, 1)
  expect(controller.state.getSnapshot()[url]).toBe('opened')
  await controller.dispose()
})

it('awaits cancellation and prevents late state publication or new requests after disposal', async () => {
  const aborted = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<Response>()
  const fetcher = vi.fn((_url: string, { signal }: RequestInit) => {
    signal!.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
    return release.promise
  })
  vi.stubGlobal('fetch', fetcher)
  const controller = new PresentedOpenController()
  const open = controller.open(id, 2, 1)
  const state = controller.state.getSnapshot()
  let disposed = false
  const disposal = controller.dispose().then(() => { disposed = true })
  await aborted.promise
  expect(disposed).toBe(false)
  release.resolve(new Response(null, { status: 204 }))
  await Promise.all([open, disposal])
  expect(controller.state.getSnapshot()).toBe(state)
  await controller.open(id, 2, 1)
  expect(fetcher).toHaveBeenCalledOnce()
})


it('shares pending state across open and reveal and retries the selected action', async () => {
  const reply = Promise.withResolvers<Response>()
  const fetcher = vi.fn().mockReturnValueOnce(reply.promise).mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetcher)
  const controller = new PresentedOpenController()
  const revealing = controller.open(id, 2, 1, 'reveal')
  await controller.open(id, 2, 1)
  expect(controller.state.getSnapshot()[url]).toBe('revealing')
  expect(fetcher).toHaveBeenCalledOnce()
  expect(fetcher.mock.calls[0]?.[0]).toBe(`${url}&action=reveal`)
  reply.resolve(new Response(null, { status: 500 }))
  await revealing
  expect(controller.state.getSnapshot()[url]).toBe('revealError')
  await controller.open(id, 2, 1, 'reveal')
  expect(controller.state.getSnapshot()[url]).toBe('revealed')
  await controller.dispose()
})

it.each([null, {}, { name: 'host', available: 'yes', fileManager: 'finder' },
  { name: 'host', available: true, fileManager: 'unknown' }, 'invalid json', 'http', 'network',
])('makes invalid Host metadata retryable: %j', async (value) => {
  const host = { name: 'linux-host', available: true, fileManager: 'directory' }
  const fetcher = vi.fn()
  if (value === 'network') fetcher.mockRejectedValueOnce(new Error('offline'))
  else if (value === 'http') fetcher.mockResolvedValueOnce(new Response(null, { status: 500 }))
  else if (value === 'invalid json') fetcher.mockResolvedValueOnce(new Response('bad JSON'))
  else fetcher.mockResolvedValueOnce(Response.json(value))
  fetcher.mockResolvedValueOnce(Response.json(host))
  vi.stubGlobal('fetch', fetcher)
  const controller = new PresentedOpenController()
  await controller.loadHost()
  expect(controller.host.getSnapshot()).toBe('error')
  await controller.loadHost()
  expect(controller.host.getSnapshot()).toEqual(host)
  await controller.dispose()
  await controller.loadHost()
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('coalesces metadata reads and suppresses their publication after disposal', async () => {
  const reply = Promise.withResolvers<Response>()
  const fetcher = vi.fn().mockReturnValue(reply.promise)
  vi.stubGlobal('fetch', fetcher)
  const controller = new PresentedOpenController()
  const first = controller.loadHost()
  const second = controller.loadHost()
  expect(fetcher).toHaveBeenCalledOnce()
  const disposal = controller.dispose()
  expect((fetcher.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true)
  reply.resolve(Response.json({ name: 'host', available: false, fileManager: null }))
  await Promise.all([first, second, disposal])
  expect(controller.host.getSnapshot()).toBeNull()
})


it('invalidates cached desktop metadata without eagerly fetching an unused Host', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ name: 'old', available: false, fileManager: null }))
  vi.stubGlobal('fetch', fetcher)
  const controller = new PresentedOpenController()
  await controller.loadHost()
  controller.resetHost()
  expect(controller.host.getSnapshot()).toBeNull()
  expect(fetcher).toHaveBeenCalledOnce()
  fetcher.mockResolvedValue(Response.json({ name: 'new', available: true, fileManager: 'finder' }))
  await controller.loadHost()
  expect(controller.host.getSnapshot()).toMatchObject({ name: 'new', available: true })
  await controller.dispose()
})

it('discards a replaced Host response and keeps the new metadata request coalesced', async () => {
  const oldReply = Promise.withResolvers<Response>()
  const newReply = Promise.withResolvers<Response>()
  const fetcher = vi.fn().mockReturnValueOnce(oldReply.promise).mockReturnValue(newReply.promise)
  vi.stubGlobal('fetch', fetcher)
  const controller = new PresentedOpenController()
  const oldLoad = controller.loadHost()
  controller.resetHost()
  expect((fetcher.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true)
  const newLoad = controller.loadHost()
  oldReply.resolve(Response.json({ name: 'old', available: false, fileManager: null }))
  await oldLoad
  expect(controller.host.getSnapshot()).toBeNull()
  const coalesced = controller.loadHost()
  expect(fetcher).toHaveBeenCalledTimes(2)
  newReply.resolve(Response.json({ name: 'new', available: true, fileManager: 'finder' }))
  await Promise.all([newLoad, coalesced])
  expect(controller.host.getSnapshot()).toMatchObject({ name: 'new' })
  await controller.dispose()
})


it.each(['open', 'reveal'] as const)('reports an unavailable Host path for %s while retaining the declaration', async (action) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 422 })))
  const controller = new PresentedOpenController()
  await controller.open(id, 2, 1, action)
  expect(controller.state.getSnapshot()[url]).toBe('nativeUnavailable')
  await controller.dispose()
})
