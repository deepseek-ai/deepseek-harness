// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  downloadUrl, SessionLogDownloadController, sessionLogZipFilename,
} from '../src/client/controller.ts'

const SID = 'session-export-controller' as SessionId

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('SessionLogDownloadController', () => {
  it('downloads the host ZIP and publishes one shared success state', async () => {
    const fetcher = vi.fn(async () => new Response('zip', { status: 200 }))
    const save = vi.fn()
    const controller = new SessionLogDownloadController(fetcher, save)

    await controller.download(SID)

    expect(fetcher).toHaveBeenCalledOnce()
    const [route, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(route).toBe(`api/session.export?sessionId=${SID}&includeDescendants=true`)
    expect(init.method).toBe('HEAD')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(save).toHaveBeenCalledWith(
      route,
      'dsh-session-session-export-controller.zip',
    )
    expect(controller.store.getSnapshot().bySession[SID]).toEqual({
      open: true, status: 'success', error: null,
    })
  })

  it('collapses concurrent gestures and preserves a dismissed dialog', async () => {
    const response = Promise.withResolvers<Response>()
    const fetcher = vi.fn(() => response.promise)
    const controller = new SessionLogDownloadController(fetcher, vi.fn())

    const first = controller.download(SID)
    const second = controller.download(SID)
    expect(first).toBe(second)
    controller.dismiss(SID)
    response.resolve(new Response('zip', { status: 200 }))
    await first

    expect(fetcher).toHaveBeenCalledOnce()
    expect(controller.store.getSnapshot().bySession[SID]?.open).toBe(false)
    controller.dismiss(SID)
  })

  it('publishes HTTP and transport failures without leaking rejections', async () => {
    const http = new SessionLogDownloadController(
      async () => new Response('backend unavailable', { status: 500 }), vi.fn(),
    )
    await http.download(SID)
    expect(http.store.getSnapshot().bySession[SID]).toEqual({
      open: true,
      status: 'error',
      error: 'Export failed: HTTP 500 backend unavailable',
    })

    const transport = new SessionLogDownloadController(async () => { throw 'offline' }, vi.fn())
    await transport.download(SID)
    expect(transport.store.getSnapshot().bySession[SID]?.error).toBe('offline')

    transport.dismiss('absent' as SessionId)

    const emptyDetail = new SessionLogDownloadController(
      async () => ({
        ok: false, status: 503, text: async () => { throw new Error('body unavailable') },
      }) as unknown as Response,
      vi.fn(),
    )
    await emptyDetail.download(SID)
    expect(emptyDetail.store.getSnapshot().bySession[SID]?.error).toBe('Export failed: HTTP 503')
  })

  it('aborts active fetches on disposal and rejects later requests', async () => {
    let signal: AbortSignal | undefined
    const fetcher = vi.fn((_input: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal ?? undefined
      signal?.addEventListener('abort', () => {
        reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
      }, { once: true })
    }))
    const controller = new SessionLogDownloadController(fetcher, vi.fn())
    const pending = controller.download(SID)

    await controller.dispose()

    await expect(pending).resolves.toBeUndefined()
    expect(signal?.aborted).toBe(true)
    await expect(controller.download(SID)).resolves.toBeUndefined()
    await controller.dispose()
  })

  it('requests the document-relative route through the default carrier', async () => {
    const fetcher = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response('zip'))
    vi.stubGlobal('fetch', fetcher)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const controller = new SessionLogDownloadController()

    await controller.download(SID)

    expect(fetcher.mock.calls[0]?.[0]).toBe(`api/session.export?sessionId=${SID}&includeDescendants=true`)
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'HEAD' })
    expect(click).toHaveBeenCalledOnce()
  })

  it('defaults dialog openness when state is externally cleared before settlement', async () => {
    const success = Promise.withResolvers<Response>()
    const successful = new SessionLogDownloadController(() => success.promise, vi.fn())
    const successRun = successful.download(SID)
    successful.store.set({ bySession: {} })
    success.resolve(new Response('zip'))
    await successRun
    expect(successful.store.getSnapshot().bySession[SID]?.open).toBe(true)

    const failure = Promise.withResolvers<Response>()
    const failing = new SessionLogDownloadController(() => failure.promise, vi.fn())
    const failureRun = failing.download(SID)
    failing.store.set({ bySession: {} })
    failure.reject(new Error('failed after clear'))
    await failureRun
    expect(failing.store.getSnapshot().bySession[SID]?.open).toBe(true)
  })
})

describe('browser download helpers', () => {
  it('sanitizes the archive filename and hands the relative route to a download anchor', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    expect(sessionLogZipFilename('a/b' as SessionId)).toBe('dsh-session-a_b.zip')
    downloadUrl('api/session.export?sessionId=a', 'archive.zip')
    expect(click).toHaveBeenCalledOnce()
    const anchor = click.mock.instances[0] as HTMLAnchorElement
    expect(anchor.getAttribute('href')).toBe('api/session.export?sessionId=a')
    expect(anchor.download).toBe('archive.zip')
  })
})
