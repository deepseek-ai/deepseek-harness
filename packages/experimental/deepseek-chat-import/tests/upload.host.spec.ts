import { strToU8 } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { ExportSourceError } from '../src/archive.ts'
import type { DeepseekChatImportWorkspace } from '../src/importer.ts'
import { UPLOAD_PATH } from '../src/protocol.ts'
import { createUploadRoute } from '../src/upload.ts'
import type { UploadRouteHandler } from '../src/upload.ts'
import type { DeepseekChatImportLine, DeepseekChatImportResult } from '../src/types.ts'

const WORKSPACE: DeepseekChatImportWorkspace = { id: 'w1', path: '/work', attachSession: () => Promise.resolve() }
const RESULT: DeepseekChatImportResult = {
  workspaceId: 'w1', workspacePath: '/work', sessionIds: ['s1'], conversationCount: 1, omittedByLimit: 0, skipped: [],
}
const SUCCESS: DeepseekChatImportLine = { type: 'outcome', outcome: { ok: true, value: RESULT } }

/** A route over a stand-in for the service's single import slot. */
function route(overrides: Partial<UploadRouteHandler> = {}) {
  const imported: Uint8Array[] = []
  const failures: unknown[] = []
  let held: AbortController | undefined
  const handler: UploadRouteHandler = {
    maxUploadBytes: 64,
    claim: () => {
      if (held !== undefined) return undefined
      const controller = new AbortController()
      held = controller
      return { signal: controller.signal, release: () => { held = undefined } }
    },
    workspace: id => id === 'w1' ? WORKSPACE : undefined,
    import: (archive, _workspace, onProgress) => {
      imported.push(archive)
      onProgress(0, 1)
      onProgress(1, 1)
      return Promise.resolve(RESULT)
    },
    failed: (error) => { failures.push(error) },
    ...overrides,
  }
  return {
    fetch: createUploadRoute(handler), imported, failures,
    unload: () => { held?.abort(new Error('unloaded')) },
    busy: () => held !== undefined,
  }
}

interface UploadOptions {
  workspaceId?: string
  type?: string
  headers?: Record<string, string>
  signal?: AbortSignal
}

function upload(body: BodyInit | null, options: UploadOptions = {}): Request {
  const query = options.workspaceId === undefined ? '' : `?workspaceId=${options.workspaceId}`
  return new Request(`http://127.0.0.1${UPLOAD_PATH}${query}`, {
    method: 'POST', body,
    headers: { 'content-type': options.type ?? 'application/octet-stream', ...options.headers },
    ...body instanceof ReadableStream ? { duplex: 'half' } : {},
    ...options.signal === undefined ? {} : { signal: options.signal },
  })
}

/** A body that streams `chunks`; it ends unless `open` is set. */
function stream(chunks: Uint8Array[], open = false): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      if (!open) controller.close()
    },
  })
}

const lines = async (response: Response): Promise<DeepseekChatImportLine[]> =>
  (await response.text()).split('\n').filter(line => line !== '').map(line => JSON.parse(line) as DeepseekChatImportLine)

const failure = (reason: string, message: string) => [{ type: 'outcome', outcome: { ok: false, error: { reason, message } } }]
const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes)

describe('createUploadRoute', () => {
  it('imports the buffered body and streams progress lines before the outcome', async () => {
    const { fetch, imported } = route()
    const response = await fetch(upload(stream([strToU8('abc'), strToU8('def')]), { workspaceId: 'w1' }))
    expect([response.headers.get('content-type'), response.headers.get('cache-control')])
      .toEqual(['application/x-ndjson; charset=utf-8', 'no-store, no-transform'])
    expect(await lines(response)).toEqual([{ type: 'progress', done: 0, total: 1 }, { type: 'progress', done: 1, total: 1 }, SUCCESS])
    expect(text(imported[0])).toBe('abcdef')
    await (await fetch(upload(null, { workspaceId: 'w1' }))).text()
    expect(imported[1]).toEqual(new Uint8Array())
  })

  it('validates the request before reading the body', async () => {
    const { fetch, busy } = route()
    expect((await fetch(upload('x', { workspaceId: 'w1', type: 'text/plain' }))).status).toBe(415)
    expect((await fetch(upload('x'))).status).toBe(400)
    expect((await fetch(upload('x', { workspaceId: '' }))).status).toBe(400)
    expect(await lines(await fetch(upload('x', { workspaceId: 'missing' })))).toEqual(failure('workspace-not-found', 'workspace missing does not exist'))
    expect(busy()).toBe(false)
  })

  it('rejects archives above the limit by declared length or by streamed bytes', async () => {
    const { fetch, imported } = route({ maxUploadBytes: 4 })
    const tooLarge = failure('too-large', 'the archive exceeds 4 bytes')
    expect(await lines(await fetch(upload('12345', { workspaceId: 'w1', headers: { 'content-length': '5' } })))).toEqual(tooLarge)
    expect(await lines(await fetch(upload('12345', { workspaceId: 'w1' })))).toEqual(tooLarge)
    expect(await lines(await fetch(upload(stream([strToU8('123'), strToU8('45')]), { workspaceId: 'w1' })))).toEqual(tooLarge)
    expect((await lines(await fetch(upload(stream([strToU8('1234')]), { workspaceId: 'w1' })))).at(-1)).toEqual(SUCCESS)
    expect(imported).toHaveLength(1)
  })

  it('fills one buffer sized from the declared length and grows it when the body is longer', async () => {
    const { fetch, imported } = route()
    for (const [declared, chunks] of [['2', ['abc', 'defgh']], ['20', ['abc']], ['6', ['abc', 'def']], ['bogus', ['xy']]] as const) {
      await (await fetch(upload(stream(chunks.map(chunk => strToU8(chunk))), { workspaceId: 'w1', headers: { 'content-length': declared } }))).text()
    }
    expect(imported.map(text)).toEqual(['abcdefgh', 'abc', 'abcdef', 'xy'])
  })

  it('runs one import at a time', async () => {
    const pending = Promise.withResolvers<DeepseekChatImportResult>()
    const { fetch, busy } = route({ import: () => pending.promise })
    const first = await fetch(upload('a', { workspaceId: 'w1' }))
    expect(await lines(await fetch(upload('b', { workspaceId: 'w1' })))).toEqual(failure('busy', 'another import is running'))
    pending.resolve(RESULT)
    expect(await lines(first)).toEqual([SUCCESS])
    await vi.waitFor(() => { expect(busy()).toBe(false) })
    expect(await lines(await fetch(upload('c', { workspaceId: 'w1' })))).toEqual([SUCCESS])
  })

  it('answers archive failures with their reason and ends the body with any other error', async () => {
    const failing = route({ import: () => Promise.reject(new ExportSourceError('missing-manifest', 'the archive has no manifest.json')) })
    expect(await lines(await failing.fetch(upload('x', { workspaceId: 'w1' })))).toEqual(failure('missing-manifest', 'the archive has no manifest.json'))
    const broken = route({ import: () => Promise.reject(new Error('disk gone')) })
    await expect((await broken.fetch(upload('x', { workspaceId: 'w1' }))).text()).rejects.toThrow('disk gone')
    expect(broken.failures).toEqual([new Error('disk gone')])
    await vi.waitFor(() => { expect(broken.busy()).toBe(false) })
  })

  it('aborts the import when the answer is cancelled, the request ends, or the service unloads', async () => {
    const seen: AbortSignal[] = []
    const stopped = Promise.withResolvers<undefined>()
    let late: (() => void) | undefined
    const { fetch, unload, busy } = route({
      import: (_archive, _workspace, onProgress, signal) => {
        seen.push(signal)
        late = () => { onProgress(1, 1) }
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            stopped.resolve(undefined)
            // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the import rejects with the caller's cancellation reason
            reject(seen.length === 2 ? new ExportSourceError('busy', 'late reason') : signal.reason)
          }, { once: true })
        })
      },
    })
    const cancelled = await fetch(upload('a', { workspaceId: 'w1' }))
    await cancelled.body?.cancel()
    await stopped.promise
    // Progress reported after cancellation is dropped.
    late?.()
    await vi.waitFor(() => { expect(busy()).toBe(false) })
    const unloaded = await fetch(upload('b', { workspaceId: 'w1' }))
    unload()
    expect(await lines(unloaded)).toEqual([])
    await vi.waitFor(() => { expect(busy()).toBe(false) })
    const controller = new AbortController()
    const ended = await fetch(upload('c', { workspaceId: 'w1', signal: controller.signal }))
    controller.abort()
    await expect(ended.text()).resolves.toBe('')
    expect(seen.map(signal => signal.aborted)).toEqual([true, true, true])
  })

  it('stops reading the body when the service unloads', async () => {
    const refusing = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(strToU8('ab')) },
      cancel() { throw new Error('the source cannot cancel') },
    })
    for (const body of [stream([strToU8('ab')], true), refusing]) {
      const { fetch, unload, busy, imported } = route()
      const pending = fetch(upload(body, { workspaceId: 'w1' }))
      await vi.waitFor(() => { expect(busy()).toBe(true) })
      unload()
      await expect(pending).rejects.toThrow('unloaded')
      expect([busy(), imported]).toEqual([false, []])
    }
  })
})
