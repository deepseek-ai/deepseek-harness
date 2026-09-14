/** One real module Worker and PDF.js loading task per mounted binary document. */
import { getDocument, PDFWorker } from 'pdfjs-dist'
import { createPdfBinaryDataFactory, workerSource } from './assets.ts'
import type { PdfSession } from './document.ts'
import { PdfWorkerFailure } from './errors.ts'

const WORKER_READY = 'dsh-pdf-worker-ready'

/**
 * Open complete PDF bytes with an explicitly owned Worker. Startup failure
 * never falls back to main-thread PDF parsing. Disposal keeps the Worker alive
 * for PDF.js teardown, except after a fatal worker error, then terminates the
 * native Worker and revokes its source URL.
 * @param data - complete PDF bytes retained by the preview; the worker receives a copy.
 * @param signal - document/body lifetime.
 * @param reportFailure - reports a fatal Worker failure, including failures after document loading.
 * @returns the pending document and idempotent asynchronous cleanup.
 */
export function openPdf(data: Uint8Array<ArrayBuffer>, signal: AbortSignal, reportFailure: (error: PdfWorkerFailure) => void): PdfSession {
  const lifetime = new AbortController()
  const stopped = AbortSignal.any([signal, lifetime.signal])
  const failed = Promise.withResolvers<never>()
  const broken = Promise.withResolvers<undefined>()
  let url: string | undefined
  let worker: Worker | undefined
  let bridge: PDFWorker | undefined
  let loading: ReturnType<typeof getDocument> | undefined
  let closing: Promise<void> | undefined
  let removeReady: (() => void) | undefined

  const workerFailed = (event: Event): void => {
    const error = new PdfWorkerFailure(event)
    failed.reject(error)
    broken.resolve(undefined)
    try {
      if (!stopped.aborted) reportFailure(error)
    } catch (failure) {
      console.error('[pdf] failure callback threw', failure)
    } finally {
      void dispose()
    }
  }
  const aborted = (): void => {
    failed.reject(stopped.reason)
    void dispose()
  }
  stopped.addEventListener('abort', aborted, { once: true })

  const dispose = (): Promise<void> => {
    if (closing !== undefined) return closing
    closing = Promise.resolve().then(async () => {
      try {
        if (loading !== undefined) await Promise.race([loading.destroy(), broken.promise])
      } finally {
        removeReady?.()
        stopped.removeEventListener('abort', aborted)
        bridge?.destroy()
        worker?.removeEventListener('error', workerFailed)
        worker?.removeEventListener('messageerror', workerFailed)
        worker?.terminate()
        if (url !== undefined) URL.revokeObjectURL(url)
      }
    }).catch((error: unknown) => { console.error('[pdf] cleanup failed', error) })
    lifetime.abort()
    return closing
  }

  const initialize = async () => {
    stopped.throwIfAborted()
    const BinaryDataFactory = createPdfBinaryDataFactory()
    const bytes = data.slice()
    url = URL.createObjectURL(new Blob([
      workerSource,
      `\nself.postMessage({type:${JSON.stringify(WORKER_READY)}});\n`,
    ], { type: 'text/javascript' }))
    worker = new Worker(url, { type: 'module', name: 'dsh-pdf' })
    worker.addEventListener('error', workerFailed)
    worker.addEventListener('messageerror', workerFailed)
    const started = Promise.withResolvers<undefined>()
    const ready = (event: MessageEvent<unknown>): void => {
      if (typeof event.data !== 'object' || event.data === null || !('type' in event.data)
        || event.data.type !== WORKER_READY) return
      started.resolve(undefined)
    }
    worker.addEventListener('message', ready)
    const port = worker
    removeReady = () => { port.removeEventListener('message', ready) }
    await Promise.race([started.promise, failed.promise])
    removeReady()
    stopped.throwIfAborted()
    bridge = PDFWorker.create({ port })
    const options = {
      data: bytes,
      worker: bridge,
      BinaryDataFactory,
      cMapPacked: true,
      useWorkerFetch: false,
      enableXfa: false,
      stopAtErrors: true,
      // Compatibility field; PDF.js 6 does not expose or read this option.
      isEvalSupported: false,
    }
    loading = getDocument(options)
    return loading.promise
  }

  const document = Promise.race([initialize(), failed.promise]).catch(async (error: unknown) => {
    await dispose()
    throw error
  })
  return { document, dispose }
}
