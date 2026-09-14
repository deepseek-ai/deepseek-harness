/** Installed PDF.js parses and draws a deterministic fixture using a real worker thread. */
import { Worker as Thread, type Transferable } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import { getDocument, PDFWorker } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { renderPdfPage } from '../src/client/pdf/document.ts'
import { pdfFixture } from './pdf-fixture.ts'

describe('PDF.js real-library smoke', () => {
  it('parses two pages and draws their distinct vector colors in a real worker', async () => {
    const thread = new Thread(new URL('./pdf-worker.fixture.mjs', import.meta.url), {
      workerData: { workerUrl: import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs') },
    })
    const ready = Promise.withResolvers<undefined>()
    const failed = Promise.withResolvers<never>()
    thread.once('message', () => { ready.resolve(undefined) })
    thread.once('error', (error) => { failed.reject(error) })
    const listeners = new Map<EventListenerOrEventListenerObject, (data: unknown) => void>()
    const port = {
      postMessage: (message: unknown, transfer: readonly Transferable[]) => { thread.postMessage(message, transfer) },
      addEventListener: (_type: string, listener: EventListener) => {
        const forward = (data: unknown): void => { listener({ data } as unknown as Event) }
        listeners.set(listener, forward)
        thread.on('message', forward)
      },
      removeEventListener: (_type: string, listener: EventListener) => {
        const forward = listeners.get(listener)
        if (forward !== undefined) thread.off('message', forward)
        listeners.delete(listener)
      },
    }
    let bridge: PDFWorker | undefined
    let loading: ReturnType<typeof getDocument> | undefined
    try {
      await Promise.race([ready.promise, failed.promise])
      // The adapter carries browser-style messages across an actual Node worker thread.
      bridge = PDFWorker.create({ port: port as unknown as Worker })
      loading = getDocument({ data: pdfFixture(), worker: bridge })
      const pdf = await Promise.race([loading.promise, failed.promise])
      expect(pdf.numPages).toBe(2)
      const factory = pdf.canvasFactory as {
        create(width: number, height: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D }
        destroy(value: { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D }): void
      }
      for (const page of [1, 2]) {
        const target = factory.create(1, 1)
        Object.defineProperty(target.canvas, 'style', { value: { setProperty: () => {} } })
        try {
          await renderPdfPage(pdf, page, target.canvas, new AbortController().signal, 1)
          const pixel = target.context.getImageData(Math.floor(target.canvas.width / 2), Math.floor(target.canvas.height / 2), 1, 1).data
          expect(pixel[3]).toBe(255)
          if (page === 1) expect(pixel[0]! - pixel[2]!).toBeGreaterThan(150)
          else expect(pixel[2]! - pixel[0]!).toBeGreaterThan(150)
        } finally {
          factory.destroy(target)
        }
      }
    } finally {
      try { await loading?.destroy() } finally {
        bridge?.destroy()
        await thread.terminate()
      }
    }
  })
})
