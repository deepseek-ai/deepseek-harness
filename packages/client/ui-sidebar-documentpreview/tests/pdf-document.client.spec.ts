// @vitest-environment jsdom
/** Page rendering cancellation is driven by controlled pdfjs promises, not scheduler delays. */
import { describe, expect, it, vi } from 'vitest'
import type { PDFPageProxy } from 'pdfjs-dist'
import { renderPdfPage } from '../src/client/pdf/document.ts'

describe('PDF canvas rendering', () => {
  it('cancels when the owner aborts during the library render call, before the abort listener attaches', async () => {
    const controller = new AbortController()
    const cancel = vi.fn()
    const cleanup = vi.fn()
    const page = {
      getViewport: () => ({ width: 100, height: 80 }),
      render: () => {
        controller.abort()
        return { cancel, promise: Promise.resolve() }
      },
      cleanup,
    } as unknown as PDFPageProxy
    await expect(renderPdfPage({ numPages: 1, getPage: async () => page }, 1, document.createElement('canvas'), controller.signal, 1))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('does not touch a canvas when getPage settles after cancellation', async () => {
    const lookup = Promise.withResolvers<PDFPageProxy>()
    const controller = new AbortController()
    const canvas = document.createElement('canvas')
    const cleanup = vi.fn()
    const render = vi.fn()
    const pending = renderPdfPage({ numPages: 1, getPage: () => lookup.promise }, 1, canvas, controller.signal, 1)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    lookup.resolve({ cleanup, render } as unknown as PDFPageProxy)
    await rejected
    expect(render).not.toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(canvas.width).toBe(300)
    expect(canvas.style.getPropertyValue('--pdf-page-width')).toBe('')
  })

  it('cancels an active task and cleans up only after its promise settles', async () => {
    const running = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const controller = new AbortController()
    const cleanup = vi.fn()
    const cancel = vi.fn()
    const page = {
      getViewport: vi.fn(() => ({ width: 100, height: 80 })),
      render: vi.fn(() => { entered.resolve(undefined); return { promise: running.promise, cancel } }),
      cleanup,
    } as unknown as PDFPageProxy
    const pending = renderPdfPage({ numPages: 1, getPage: async () => page }, 1, document.createElement('canvas'), controller.signal, 2)
    const rejected = expect(pending).rejects.toThrow('cancelled')
    await entered.promise
    controller.abort()
    expect(cancel).toHaveBeenCalledOnce()
    expect(cleanup).not.toHaveBeenCalled()
    running.reject(new Error('cancelled'))
    await rejected
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('bounds raster allocation while retaining the selected display dimensions', async () => {
    const cleanup = vi.fn()
    const getViewport = vi.fn(() => ({ width: 8192, height: 8192 }))
    const page = {
      getViewport,
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup,
    } as unknown as PDFPageProxy
    const canvas = document.createElement('canvas')
    await expect(renderPdfPage({ numPages: 1, getPage: async () => page }, 1, canvas, new AbortController().signal, 2))
      .resolves.toEqual({ width: 8192, height: 8192 })
    expect(getViewport).toHaveBeenCalledWith({ scale: 96 / 72 })
    expect(canvas.width * canvas.height).toBe(16_777_216)
    expect(canvas.style.getPropertyValue('--pdf-page-width')).toBe('8192px')
    expect(cleanup).toHaveBeenCalledOnce()
  })
})
