import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import { fileUploadWorker, FileUploadRuntime } from '../src/client/runtime.ts'
import type { FileUploadBody } from '../src/client/contract.ts'
import type { ClientFileUploadHooks } from '../src/types.ts'

interface UploadGlobal {
  __DSH_FILE_UPLOAD__?: ClientFileUploadHooks
}

afterEach(() => {
  delete (globalThis as UploadGlobal).__DSH_FILE_UPLOAD__
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('file upload worker body', () => {
  it('sends a Blob with credentials and reports progress, completion, and failure', () => {
    const posted: unknown[] = []
    const scope: {
      onmessage: ((event: MessageEvent<{
        url: string
        body: FileUploadBody
        headers: Readonly<Record<string, string>>
      }>) => void) | null
      postMessage(message: unknown): void
    } = { onmessage: null, postMessage: (message: unknown) => { posted.push(message) } }
    const xhr = {
      upload: { onprogress: null as ((event: ProgressEvent) => void) | null },
      status: 201,
      responseText: '{"ok":true}',
      withCredentials: false,
      onload: null as ((event: ProgressEvent) => void) | null,
      onerror: null as ((event: ProgressEvent) => void) | null,
      open: vi.fn(),
      setRequestHeader: vi.fn(),
      send: vi.fn(),
    }
    fileUploadWorker(scope, () => xhr)
    const body = new Blob(['large'])
    scope.onmessage?.({
      data: { url: 'https://harness.test/upload', body, headers: { 'content-type': 'application/octet-stream' } },
    } as never)
    expect(xhr.open).toHaveBeenCalledWith('POST', 'https://harness.test/upload')
    expect(xhr.withCredentials).toBe(true)
    expect(xhr.setRequestHeader).toHaveBeenCalledWith('content-type', 'application/octet-stream')
    expect(xhr.send).toHaveBeenCalledWith(body)

    xhr.upload.onprogress?.({ loaded: 2, total: 4, lengthComputable: true } as ProgressEvent)
    xhr.upload.onprogress?.({ loaded: 3, total: 0, lengthComputable: false } as ProgressEvent)
    xhr.onload?.({} as ProgressEvent)
    xhr.onerror?.({} as ProgressEvent)
    expect(posted).toEqual([
      { kind: 'progress', loaded: 2, total: 4 },
      { kind: 'progress', loaded: 3 },
      { kind: 'complete', status: 201, body: '{"ok":true}' },
      { kind: 'error', message: 'background upload transport failed' },
    ])
  })

  it('streams Uint8Array chunks through fetch and reports consumed bytes', async () => {
    const posted: unknown[] = []
    const scope = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: (message: unknown) => { posted.push(message) },
    }
    const fetch = vi.fn(async (_url: string, init: RequestInit & { readonly duplex: 'half' }) => {
      const chunks: number[][] = []
      for await (const chunk of init.body as ReadableStream<Uint8Array>) chunks.push([...chunk])
      expect(chunks).toEqual([[1, 2], [3]])
      expect(init).toMatchObject({
        method: 'POST',
        headers: { 'x-test': 'yes' },
        credentials: 'include',
        duplex: 'half',
      })
      return new Response('stored', { status: 202 })
    })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1, 2))
        controller.enqueue(Uint8Array.of(3))
        controller.close()
      },
    })
    fileUploadWorker(scope, () => { throw new Error('XHR must not handle streams') }, fetch)
    scope.onmessage?.({ data: { url: 'https://harness.test/upload', body, headers: { 'x-test': 'yes' } } } as never)
    await vi.waitFor(() => {
      expect(posted).toEqual([
        { kind: 'progress', loaded: 2 },
        { kind: 'progress', loaded: 3 },
        { kind: 'complete', status: 202, body: 'stored' },
      ])
    })
  })

  it('propagates cancellation from the fetch body to the source stream', async () => {
    const posted: unknown[] = []
    const scope = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: (message: unknown) => { posted.push(message) },
    }
    const cancel = vi.fn()
    const source = new ReadableStream<Uint8Array>({ cancel })
    fileUploadWorker(
      scope,
      () => { throw new Error('unused') },
      async (_url, init) => {
        await (init.body as ReadableStream<Uint8Array>).cancel('fetch stopped')
        return new Response('cancelled')
      },
    )
    scope.onmessage?.({ data: { url: '/upload', body: source, headers: {} } } as never)
    await vi.waitFor(() => {
      expect(cancel).toHaveBeenCalledWith('fetch stopped')
      expect(posted.at(-1)).toEqual({ kind: 'complete', status: 200, body: 'cancelled' })
    })
  })

  it('reports invalid bodies, stream chunks, and fetch failures', async () => {
    const posted: unknown[] = []
    const scope = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: (message: unknown) => { posted.push(message) },
    }
    fileUploadWorker(scope, () => { throw new Error('unused') })
    scope.onmessage?.({ data: { url: '/upload', body: 'bad', headers: {} } } as never)
    expect(posted).toEqual([{ kind: 'error', message: 'background upload worker received an invalid body' }])

    const badChunk = new ReadableStream({ start(controller) { controller.enqueue('bad'); controller.close() } })
    fileUploadWorker(
      scope,
      () => { throw new Error('unused') },
      async (_url, init) => {
        await new Response(init.body).arrayBuffer()
        return new Response()
      },
    )
    scope.onmessage?.({ data: { url: '/upload', body: badChunk, headers: {} } } as never)
    await vi.waitFor(() => {
      expect(posted.at(-1)).toEqual({
        kind: 'error', message: 'background upload stream produced a non-Uint8Array chunk',
      })
    })

    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
    fileUploadWorker(
      scope,
      () => { throw new Error('unused') },
      () => Promise.reject(new Error('offline')),
    )
    scope.onmessage?.({ data: { url: '/upload', body, headers: {} } } as never)
    await vi.waitFor(() => {
      expect(posted.at(-1)).toEqual({ kind: 'error', message: 'offline' })
    })

    const failedSource = new ReadableStream<Uint8Array>({
      start(controller) { controller.error('source failed') },
    })
    fileUploadWorker(
      scope,
      () => { throw new Error('unused') },
      async (_url, init) => {
        await (init.body as ReadableStream<Uint8Array>).getReader().read()
        return new Response()
      },
    )
    scope.onmessage?.({ data: { url: '/upload', body: failedSource, headers: {} } } as never)
    await vi.waitFor(() => {
      expect(posted.at(-1)).toEqual({ kind: 'error', message: 'source failed' })
    })
  })

  it('uses Worker globals when the emitted body supplies no test seams', async () => {
    const posted: unknown[] = []
    const scope = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: (message: unknown) => { posted.push(message) },
    }
    const xhr = {
      upload: { onprogress: null },
      status: 204,
      responseText: '',
      withCredentials: false,
      onload: null,
      onerror: null,
      open: vi.fn(),
      setRequestHeader: vi.fn(),
      send: vi.fn(),
    }
    vi.stubGlobal('self', scope)
    vi.stubGlobal('XMLHttpRequest', vi.fn(function () { return xhr }))
    fileUploadWorker()
    scope.onmessage?.({ data: { url: '/upload', body: new Blob(), headers: {} } } as MessageEvent)
    expect(xhr.send).toHaveBeenCalledOnce()

    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      await new Response(init.body).arrayBuffer()
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetch)
    fileUploadWorker()
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
    scope.onmessage?.({ data: { url: '/stream', body: stream, headers: {} } } as MessageEvent)
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledOnce()
      expect(posted.at(-1)).toEqual({ kind: 'complete', status: 204, body: '' })
    })
  })
})

describe('file upload service', () => {
  it('uses a page-owned Host fetch for Blob and ReadableStream bodies', async () => {
    vi.stubGlobal('location', { origin: 'https://preview.test' })
    const fetch = vi.fn((_url: URL, _init?: RequestInit) =>
      Promise.resolve(new Response('accepted', { status: 202 })))
    ;(globalThis as UploadGlobal).__DSH_FILE_UPLOAD__ = { fetch }
    const ctx = new Context()
    const fiber = ctx.plugin(FileUploadRuntime)
    await fiber
    const blob = new Blob(['opaque'])
    const signal = new AbortController().signal
    await expect((ctx.fileUpload as FileUploadRuntime).post({
      path: '/api/upload', body: blob, headers: { 'x-test': 'yes' }, signal,
    })).resolves.toEqual({ status: 202, body: 'accepted' })
    expect(fetch).toHaveBeenLastCalledWith(new URL('https://preview.test/api/upload'), {
      method: 'POST', headers: { 'x-test': 'yes' }, body: blob, signal,
    })

    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
    await (ctx.fileUpload as FileUploadRuntime).post({ path: '/stream', body: stream })
    expect(fetch).toHaveBeenLastCalledWith(new URL('https://preview.test/stream'), {
      method: 'POST', body: stream, duplex: 'half',
    })
    await fiber.dispose()
  })

  it('mounts through the plugin entry and resolves non-browser URLs', async () => {
    vi.stubGlobal('location', { origin: 'null' })
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })))
    ;(globalThis as UploadGlobal).__DSH_FILE_UPLOAD__ = { fetch }
    const ctx = new Context()
    const fiber = ctx.plugin({ apply })
    await fiber
    const body = new Blob()
    await (ctx.fileUpload as FileUploadRuntime).post({ path: '/fallback', body })
    expect(fetch).toHaveBeenCalledWith(new URL('http://dsh.internal/fallback'), {
      method: 'POST', body,
    })
    await fiber.dispose()
  })

  it('leaves the fixture on its generated Remote fallback', async () => {
    vi.stubGlobal('location', { origin: 'https://fixture.test', search: '?fixture' })
    const ctx = new Context()
    const fiber = ctx.plugin(FileUploadRuntime)
    await fiber
    expect(ctx.fileUpload.available).toBe(false)
    await expect((ctx.fileUpload as FileUploadRuntime).post({ path: '/upload', body: new Blob() }))
      .rejects.toThrow('background upload is unavailable in fixture mode')
    await fiber.dispose()
  })

  it('fails loud when a served browser has no Worker implementation', async () => {
    vi.stubGlobal('Worker', undefined)
    const ctx = new Context()
    const fiber = ctx.plugin(FileUploadRuntime)
    await fiber
    await expect((ctx.fileUpload as FileUploadRuntime).post({ path: '/upload', body: new Blob() }))
      .rejects.toThrow('background upload requires Web Worker support')
    await fiber.dispose()
  })

  it('forwards progress and completion from a dedicated Worker and then terminates it', async () => {
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:worker')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    class FakeWorker {
      static last: FakeWorker | undefined
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      readonly postMessage = vi.fn()
      readonly terminate = vi.fn()
      constructor(readonly url: string, readonly options: WorkerOptions) { FakeWorker.last = this }
    }
    vi.stubGlobal('Worker', FakeWorker)
    vi.stubGlobal('location', { origin: 'https://harness.test' })
    const ctx = new Context()
    const fiber = ctx.plugin(FileUploadRuntime)
    await fiber
    const progress = vi.fn()
    const blob = new Blob(['bytes'])
    const pending = (ctx.fileUpload as FileUploadRuntime).post({ path: '/api/upload', body: blob, onProgress: progress })
    const worker = FakeWorker.last
    if (worker === undefined) throw new Error('worker missing')
    expect(created).toHaveBeenCalledOnce()
    expect(revoked).toHaveBeenCalledWith('blob:worker')
    expect(worker.postMessage).toHaveBeenCalledWith({
      url: 'https://harness.test/api/upload', body: blob, headers: {},
    })
    worker.onmessage?.({ data: { kind: 'progress', loaded: 4, total: 5 } } as MessageEvent)
    worker.onmessage?.({ data: { kind: 'progress', loaded: 6 } } as MessageEvent)
    worker.onmessage?.({ data: { kind: 'complete', status: 200, body: 'done' } } as MessageEvent)
    worker.onmessage?.({ data: { kind: 'complete', status: 500, body: 'late' } } as MessageEvent)
    await expect(pending).resolves.toEqual({ status: 200, body: 'done' })
    expect(progress.mock.calls).toEqual([
      [{ loaded: 4, total: 5 }],
      [{ loaded: 6 }],
    ])
    expect(worker.terminate).toHaveBeenCalledOnce()
    await fiber.dispose()
  })

  it('transfers stream ownership to the dedicated Worker', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:worker')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    class FakeWorker {
      static last: FakeWorker | undefined
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      readonly postMessage = vi.fn()
      readonly terminate = vi.fn()
      constructor() { FakeWorker.last = this }
    }
    vi.stubGlobal('Worker', FakeWorker)
    const ctx = new Context()
    const fiber = ctx.plugin(FileUploadRuntime)
    await fiber
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
    const pending = (ctx.fileUpload as FileUploadRuntime).post({ path: '/stream', body: stream })
    const worker = FakeWorker.last
    if (worker === undefined) throw new Error('worker missing')
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ body: stream }), [stream])
    worker.onmessage?.({ data: { kind: 'complete', status: 200, body: 'done' } } as MessageEvent)
    await expect(pending).resolves.toEqual({ status: 200, body: 'done' })
    await fiber.dispose()
  })

  it('rejects worker messages, worker errors, and caller cancellation', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:worker')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    class FakeWorker {
      static all: FakeWorker[] = []
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      readonly postMessage = vi.fn()
      readonly terminate = vi.fn()
      constructor() { FakeWorker.all.push(this) }
    }
    vi.stubGlobal('Worker', FakeWorker)
    const ctx = new Context()
    const fiber = ctx.plugin(FileUploadRuntime)
    await fiber

    const reported = (ctx.fileUpload as FileUploadRuntime).post({ path: '/upload', body: new Blob() })
    FakeWorker.all[0]?.onmessage?.({ data: { kind: 'error', message: 'network failed' } } as MessageEvent)
    await expect(reported).rejects.toThrow('network failed')

    const errored = (ctx.fileUpload as FileUploadRuntime).post({ path: '/upload', body: new Blob() })
    FakeWorker.all[1]?.onerror?.({ message: 'worker crashed' } as ErrorEvent)
    await expect(errored).rejects.toThrow('worker crashed')

    const unnamed = (ctx.fileUpload as FileUploadRuntime).post({ path: '/upload', body: new Blob() })
    FakeWorker.all[2]?.onerror?.({ message: '' } as ErrorEvent)
    await expect(unnamed).rejects.toThrow('background upload worker failed')

    const controller = new AbortController()
    const aborted = (ctx.fileUpload as FileUploadRuntime).post({ path: '/upload', body: new Blob(), signal: controller.signal })
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.all[3]?.terminate).toHaveBeenCalledOnce()

    const already = new AbortController()
    already.abort()
    await expect((ctx.fileUpload as FileUploadRuntime).post({ path: '/upload', body: new Blob(), signal: already.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.all[4]?.postMessage).not.toHaveBeenCalled()
    await fiber.dispose()
  })
})

describe('Session-addressed file upload', () => {
  const SESSION_ID = 's1' as SessionId

  async function scopedService(options: {
    readonly remote?: ReturnType<typeof vi.fn>
  } = {}) {
    const ctx = new Context()
    const remote = options.remote ?? vi.fn(() => Promise.resolve({
      ok: true,
      value: {
        receiptId: 'remote-receipt',
        file: { attachmentId: 'remote-file', name: 'file', bytes: 3 },
      },
    }))
    ctx.provide('remote', { fileUploads: { upload: remote } } as never)
    const fiber = ctx.plugin(FileUploadRuntime)
    await fiber
    return { ctx, fiber, remote, service: ctx.fileUpload }
  }

  it('assembles the scoped streaming request and parses progress and receipt fields', async () => {
    vi.stubGlobal('location', { origin: 'https://preview.test' })
    const progress = vi.fn()
    const fetch = vi.fn((_url: URL, init: RequestInit) => {
      expect(init.body).toBeInstanceOf(Blob)
      progress({ loaded: 2, total: 4 })
      return Promise.resolve(new Response(JSON.stringify({
        ok: true,
        value: {
          receiptId: 'receipt-1',
          file: { attachmentId: 'file-1', name: 'notes & refs.pdf', bytes: 4 },
        },
      }), { status: 200 }))
    })
    ;(globalThis as UploadGlobal).__DSH_FILE_UPLOAD__ = { fetch }
    const { fiber, service } = await scopedService()
    const signal = new AbortController().signal
    const file = new Blob(['data'])

    await expect(service.upload(SESSION_ID, file, 'notes & refs.pdf', signal, progress)).resolves.toEqual({
      ok: true,
      value: {
        receiptId: 'receipt-1',
        file: { attachmentId: 'file-1', name: 'notes & refs.pdf', bytes: 4 },
      },
    })
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://preview.test/api/session/uploadFileBinary?sessionId=s1&name=notes+%26+refs.pdf'),
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
        signal,
      }),
    )
    await fiber.dispose()
  })

  it('uses the direct Remote fallback for exact bytes and fixture Blob bodies', async () => {
    vi.stubGlobal('location', { origin: 'https://fixture.test', search: '?fixture' })
    const remote = vi.fn(() => Promise.resolve({
      ok: true,
      value: {
        receiptId: 'remote-receipt',
        file: { attachmentId: 'remote-file', name: 'bytes.bin', bytes: 3 },
      },
    }))
    const { fiber, service } = await scopedService({ remote })
    await expect(service.upload(SESSION_ID, Uint8Array.of(0, 0, 0), 'bytes.bin'))
      .resolves.toMatchObject({ ok: true })
    await expect(service.upload(SESSION_ID, new Blob([Uint8Array.of(1)])))
      .resolves.toMatchObject({ ok: true })
    expect(remote.mock.calls).toEqual([
      [SESSION_ID, { data: 'AAAA', name: 'bytes.bin' }, undefined],
      [SESSION_ID, { data: 'AQ==' }, undefined],
    ])
    await fiber.dispose()
  })

  it('rejects an unavailable stream and malformed background results', async () => {
    vi.stubGlobal('location', { origin: 'https://fixture.test', search: '?fixture' })
    const fixture = await scopedService()
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
    await expect(fixture.service.upload(SESSION_ID, stream))
      .rejects.toThrow('stream file upload requires a background carrier')
    await fixture.fiber.dispose()

    vi.stubGlobal('location', { origin: 'https://preview.test' })
    ;(globalThis as UploadGlobal).__DSH_FILE_UPLOAD__ = {
      fetch: () => Promise.resolve(new Response(null, { status: 413 })),
    }
    const rejected = await scopedService()
    await expect(rejected.service.upload(SESSION_ID, new Blob()))
      .rejects.toThrow('file upload transport failed with HTTP 413')
    await rejected.fiber.dispose()

    const bodies: unknown[] = [
      null,
      { ok: 'yes' },
      { ok: false, error: null },
      { ok: false, error: { code: 1, message: 'denied', details: {} } },
      { ok: false, error: { code: 'denied', message: 1, details: {} } },
      { ok: false, error: { code: 'denied', message: 'denied', details: null } },
      { ok: true, value: null },
      { ok: true, value: { receiptId: 'r', file: { attachmentId: 'a', name: 'x', bytes: -1 } } },
    ]
    for (const body of bodies) {
      ;(globalThis as UploadGlobal).__DSH_FILE_UPLOAD__ = {
        fetch: () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
      }
      const malformed = await scopedService()
      await expect(malformed.service.upload(SESSION_ID, new Blob()))
        .rejects.toThrow(/file upload transport returned an invalid/)
      await malformed.fiber.dispose()
    }

    ;(globalThis as UploadGlobal).__DSH_FILE_UPLOAD__ = {
      fetch: () => Promise.resolve(new Response(JSON.stringify({
        ok: false,
        error: { code: 'session/attachment-invalid', message: 'denied', details: { reason: 'NOPE' } },
      }), { status: 200 })),
    }
    const failed = await scopedService()
    await expect(failed.service.upload(SESSION_ID, new Blob())).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'session/attachment-invalid',
        message: 'denied',
        details: { reason: 'NOPE' },
      },
    })
    await failed.fiber.dispose()
  })
})
