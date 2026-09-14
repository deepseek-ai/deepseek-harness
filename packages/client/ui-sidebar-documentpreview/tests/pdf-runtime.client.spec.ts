// @vitest-environment jsdom
/** Browser Worker ownership, handshake, and PDF.js teardown under controlled completions. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PdfDocument, PdfSession } from '../src/client/pdf/document.ts'

const api = vi.hoisted(() => ({ getDocument: vi.fn(), createWorker: vi.fn(), destroyBridge: vi.fn() }))
vi.mock('pdfjs-dist', () => ({ getDocument: api.getDocument, PDFWorker: { create: api.createWorker } }))
vi.mock('../src/client/pdf/assets.ts', () => ({
  workerSource: 'export const WorkerMessageHandler = {}',
  createPdfBinaryDataFactory: () => class { fetch() { return Promise.resolve(new Uint8Array()) } },
}))
import { openPdf } from '../src/client/pdf/runtime.ts'
import { PdfWorkerFailure } from '../src/client/pdf/errors.ts'

const NativeURL = URL
const workers: ControlledWorker[] = []
const sessions: PdfSession[] = []
const releases: Array<() => void> = []
const createURL = vi.fn(() => 'blob:pdf-worker')
const revokeURL = vi.fn()

class ControlledWorker extends EventTarget {
  readonly terminate = vi.fn()
  constructor(readonly url: string, readonly options: WorkerOptions) {
    super()
    workers.push(this)
  }
  ready(): void { this.dispatchEvent(new MessageEvent('message', { data: { type: 'dsh-pdf-worker-ready' } })) }
}

beforeEach(() => {
  workers.length = 0
  sessions.length = 0
  releases.length = 0
  vi.clearAllMocks()
  api.createWorker.mockReturnValue({ destroy: api.destroyBridge })
  vi.stubGlobal('Worker', ControlledWorker)
  vi.stubGlobal('URL', class extends NativeURL {
    static override createObjectURL = createURL
    static override revokeObjectURL = revokeURL
  })
})

afterEach(async () => {
  try {
    for (const release of releases) release()
    await Promise.allSettled(sessions.map(session => session.dispose()))
  } finally {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  }
})

function setup(controller = new AbortController(), failed = vi.fn()) {
  const loading = Promise.withResolvers<PdfDocument>()
  const entered = Promise.withResolvers<unknown>()
  const destroy = vi.fn(async () => {})
  api.getDocument.mockImplementation((options: unknown) => {
    entered.resolve(options)
    return { promise: loading.promise, destroy }
  })
  const data = new TextEncoder().encode('%PDF-test')
  const session = openPdf(data, controller.signal, failed)
  sessions.push(session)
  void session.document.catch(() => {})
  return { loading, entered, destroy, controller, failed, session, data }
}

describe('PDF Worker lifecycle', () => {
  it('starts a real module-worker port before calling getDocument with complete bytes and local assets', async () => {
    const h = setup()
    expect(workers[0]!.options).toEqual({ type: 'module', name: 'dsh-pdf' })
    expect(api.getDocument).not.toHaveBeenCalled()
    workers[0]!.ready()
    const options = await h.entered.promise as { data: Uint8Array<ArrayBuffer>; BinaryDataFactory: unknown }
    expect(api.createWorker).toHaveBeenCalledWith({ port: workers[0] })
    expect(options).toMatchObject({
      useWorkerFetch: false, enableXfa: false, cMapPacked: true, isEvalSupported: false,
    })
    expect(typeof options.BinaryDataFactory).toBe('function')
    expect(Array.from(options.data)).toEqual([37, 80, 68, 70, 45, 116, 101, 115, 116])
    expect(options.data).not.toBe(h.data)
    expect(options.data.buffer).not.toBe(h.data.buffer)
    const transferred = structuredClone(options.data, { transfer: [options.data.buffer] })
    expect(options.data.byteLength).toBe(0)
    expect(Array.from(h.data)).toEqual(Array.from(transferred))
    expect(new TextDecoder().decode(h.data)).toBe('%PDF-test')
    const document = { numPages: 2, getPage: vi.fn() }
    h.loading.resolve(document)
    await expect(h.session.document).resolves.toBe(document)
    await h.session.dispose()
    await h.session.dispose()
    expect(h.destroy).toHaveBeenCalledOnce()
    expect(api.destroyBridge).toHaveBeenCalledOnce()
    expect(workers[0]!.terminate).toHaveBeenCalledOnce()
    expect(revokeURL).toHaveBeenCalledExactlyOnceWith('blob:pdf-worker')
  })

  it('cancels startup before the worker handshake without invoking PDF.js', async () => {
    const h = setup()
    h.controller.abort()
    await expect(h.session.document).rejects.toMatchObject({ name: 'AbortError' })
    await h.session.dispose()
    workers[0]!.ready()
    expect(api.getDocument).not.toHaveBeenCalled()
    expect(workers[0]!.terminate).toHaveBeenCalledOnce()
    expect(revokeURL).toHaveBeenCalledOnce()
  })

  it('awaits document destruction before terminating a healthy worker and rejects a late load', async () => {
    const h = setup()
    workers[0]!.ready()
    await h.entered.promise
    const destruction = Promise.withResolvers<undefined>()
    const destroying = Promise.withResolvers<undefined>()
    releases.push(() => { destruction.resolve(undefined) })
    h.destroy.mockImplementation(async () => { destroying.resolve(undefined); await destruction.promise })
    h.controller.abort()
    await destroying.promise
    expect(workers[0]!.terminate).not.toHaveBeenCalled()
    h.loading.resolve({ numPages: 99, getPage: vi.fn() })
    destruction.resolve(undefined)
    await expect(h.session.document).rejects.toMatchObject({ name: 'AbortError' })
    await h.session.dispose()
    expect(workers[0]!.terminate).toHaveBeenCalledOnce()
  })

  it('reports worker startup failure and releases its Blob without a fake-worker fallback', async () => {
    const h = setup()
    const error = new ErrorEvent('error', { message: 'worker blocked' })
    workers[0]!.dispatchEvent(error)
    await expect(h.session.document).rejects.toMatchObject({ kind: 'worker', cause: error })
    expect(h.failed).toHaveBeenCalledOnce()
    expect(api.getDocument).not.toHaveBeenCalled()
    expect(workers[0]!.terminate).toHaveBeenCalledOnce()
    expect(revokeURL).toHaveBeenCalledOnce()
  })

  it('reports a worker crash after loading and releases the document and worker', async () => {
    const h = setup()
    workers[0]!.ready()
    await h.entered.promise
    h.loading.resolve({ numPages: 1, getPage: vi.fn() })
    await h.session.document
    const error = new ErrorEvent('error', { message: 'worker crashed' })
    workers[0]!.dispatchEvent(error)
    await h.session.dispose()
    expect(h.failed).toHaveBeenCalledWith(expect.objectContaining({ kind: 'worker', cause: error }))
    expect(h.destroy).toHaveBeenCalledOnce()
    expect(api.destroyBridge).toHaveBeenCalledOnce()
    expect(workers[0]!.terminate).toHaveBeenCalledOnce()
  })

  it('allocates nothing for an already-ended document lifetime', async () => {
    const controller = new AbortController()
    controller.abort()
    const h = setup(controller)
    await expect(h.session.document).rejects.toMatchObject({ name: 'AbortError' })
    await h.session.dispose()
    expect(workers).toEqual([])
    expect(createURL).not.toHaveBeenCalled()
    expect(api.getDocument).not.toHaveBeenCalled()
  })

  it('ignores unrelated Worker wire messages until its own startup acknowledgement', async () => {
    const h = setup()
    for (const data of [null, 'noise', { action: 'ready', sourceName: 'worker' }, { type: 'other-worker' }]) {
      workers[0]!.dispatchEvent(new MessageEvent('message', { data }))
    }
    expect(api.getDocument).not.toHaveBeenCalled()
    workers[0]!.ready()
    await h.entered.promise
    h.loading.resolve({ numPages: 1, getPage: vi.fn() })
    await h.session.document
  })

  it('terminates after messageerror even when the failure callback throws', async () => {
    const callbackError = new Error('listener failed')
    const failed = vi.fn(() => { throw callbackError })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = setup(new AbortController(), failed)
    workers[0]!.dispatchEvent(new MessageEvent('messageerror'))
    await expect(h.session.document).rejects.toBeInstanceOf(PdfWorkerFailure)
    await h.session.dispose()
    expect(log).toHaveBeenCalledExactlyOnceWith('[pdf] failure callback threw', callbackError)
    expect(workers[0]!.terminate).toHaveBeenCalledOnce()
    expect(revokeURL).toHaveBeenCalledOnce()
  })

  it('suppresses late failure reports and finishes abort cleanup when the worker crashes', async () => {
    const h = setup()
    workers[0]!.ready()
    await h.entered.promise
    h.loading.resolve({ numPages: 1, getPage: vi.fn() })
    await h.session.document
    const destruction = Promise.withResolvers<undefined>()
    const destroying = Promise.withResolvers<undefined>()
    releases.push(() => { destruction.resolve(undefined) })
    h.destroy.mockImplementation(async () => { destroying.resolve(undefined); await destruction.promise })
    h.controller.abort()
    await destroying.promise
    workers[0]!.dispatchEvent(new MessageEvent('messageerror'))
    await h.session.dispose()
    expect(h.failed).not.toHaveBeenCalled()
    expect(workers[0]!.terminate).toHaveBeenCalledOnce()
    destruction.resolve(undefined)
  })

  it('logs a library teardown rejection after releasing the bridge, Worker, and Blob', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = setup()
    workers[0]!.ready()
    await h.entered.promise
    h.loading.resolve({ numPages: 1, getPage: vi.fn() })
    await h.session.document
    const failure = new Error('terminate RPC rejected')
    h.destroy.mockRejectedValueOnce(failure)
    await expect(h.session.dispose()).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledExactlyOnceWith('[pdf] cleanup failed', failure)
    expect(api.destroyBridge).toHaveBeenCalledOnce()
    expect(workers[0]!.terminate).toHaveBeenCalledOnce()
    expect(revokeURL).toHaveBeenCalledOnce()
  })

  it('revokes its source URL when browser policy refuses Worker construction', async () => {
    vi.stubGlobal('Worker', vi.fn(function blockedWorker() {
      throw new DOMException('Worker blocked by policy', 'SecurityError')
    }))
    const h = setup()
    await expect(h.session.document).rejects.toMatchObject({ name: 'SecurityError' })
    expect(revokeURL).toHaveBeenCalledOnce()
    expect(api.getDocument).not.toHaveBeenCalled()
  })
})
