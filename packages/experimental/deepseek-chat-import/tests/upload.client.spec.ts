// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { uploadArchive } from '../src/client/upload.ts'
import type { UploadProgress } from '../src/client/upload.ts'
import type { DeepseekChatImportResult } from '../src/types.ts'

/** Minimal XMLHttpRequest double driven by each test. */
class FakeXhr {
  static last: FakeXhr | undefined
  method = ''
  url = ''
  headers: Record<string, string> = {}
  body: unknown
  status = 0
  responseText = ''
  aborted = false
  upload: { onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void; onload?: () => void } = {}
  onload?: () => void
  onprogress?: () => void
  onerror?: () => void
  onabort?: () => void
  constructor() { FakeXhr.last = this }
  open(method: string, url: string) { this.method = method; this.url = url }
  setRequestHeader(name: string, value: string) { this.headers[name] = value }
  send(body: unknown) { this.body = body }
  abort() { this.aborted = true; this.onabort?.() }
  respond(status: number, text: string) { this.status = status; this.responseText = text; this.onload?.() }
  /** Deliver part of the answer body. */
  receive(status: number, text: string) { this.status = status; this.responseText += text; this.onprogress?.() }
}

function current(): FakeXhr {
  if (FakeXhr.last === undefined) throw new Error('no request sent')
  return FakeXhr.last
}

/** Page global carrying the shell transport the carrier path reads. */
type TransportGlobal = { __DSH_TRANSPORT__?: { fetch?: (input: string | URL, init: RequestInit) => Promise<Response> } }

function installCarrier(fetch: (input: string | URL, init: RequestInit) => Promise<Response>): void {
  (globalThis as TransportGlobal).__DSH_TRANSPORT__ = { fetch }
}

const RESULT: DeepseekChatImportResult = {
  workspaceId: 'w1', workspacePath: '/w', sessionIds: ['s1'], conversationCount: 1, omittedByLimit: 0, skipped: [],
}
const OUTCOME_LINE = `${JSON.stringify({ type: 'outcome', outcome: { ok: true, value: RESULT } })}\n`
const PROGRESS_LINE = `${JSON.stringify({ type: 'progress', done: 0, total: 2 })}\n`
const SKIP = { conversationId: 'c4', title: null, reason: 'conversation has no messages' }

/** One `outcome` answer line carrying `value`. */
function outcome(value: unknown): string {
  return `${JSON.stringify({ type: 'outcome', outcome: value })}\n`
}

/** Answer lines that are not valid protocol values, one per rejected field. */
const INVALID_LINES: ReadonlyArray<readonly [string, string]> = [
  ['a null line', 'null\n'],
  ['an array line', '[]\n'],
  ['a string line', '"line"\n'],
  ['an unknown line type', '{"type":"other"}\n'],
  ['progress without done', '{"type":"progress"}\n'],
  ['progress with a non-numeric total', '{"type":"progress","done":0,"total":"2"}\n'],
  ['an outcome without a value', '{"type":"outcome"}\n'],
  ['an outcome whose ok is not boolean', outcome({ ok: 'yes' })],
  ['an ok outcome whose value is not an object', outcome({ ok: true, value: [] })],
  ['an ok outcome without a workspace id', outcome({ ok: true, value: { ...RESULT, workspaceId: 1 } })],
  ['an ok outcome without a workspace path', outcome({ ok: true, value: { ...RESULT, workspacePath: null } })],
  ['an ok outcome whose session ids are not a list', outcome({ ok: true, value: { ...RESULT, sessionIds: 's1' } })],
  ['an ok outcome whose session id is not text', outcome({ ok: true, value: { ...RESULT, sessionIds: [1] } })],
  ['an ok outcome without a conversation count', outcome({ ok: true, value: { ...RESULT, conversationCount: '1' } })],
  ['an ok outcome without an omitted count', outcome({ ok: true, value: { ...RESULT, omittedByLimit: null } })],
  ['an ok outcome whose skipped list is not a list', outcome({ ok: true, value: { ...RESULT, skipped: {} } })],
  ['an ok outcome with a skipped item that is not an object', outcome({ ok: true, value: { ...RESULT, skipped: [null] } })],
  ['an ok outcome with a skipped item without an id', outcome({ ok: true, value: { ...RESULT, skipped: [{ ...SKIP, conversationId: 1 }] } })],
  ['an ok outcome with a skipped item whose title is not text', outcome({ ok: true, value: { ...RESULT, skipped: [{ ...SKIP, title: 1 }] } })],
  ['an ok outcome with a skipped item without a reason', outcome({ ok: true, value: { ...RESULT, skipped: [{ ...SKIP, reason: null }] } })],
  ['an error outcome whose error is not an object', outcome({ ok: false, error: 'x' })],
  ['an error outcome with an unknown reason', outcome({ ok: false, error: { reason: 'nope', message: 'm' } })],
  ['an error outcome without a message', outcome({ ok: false, error: { reason: 'busy', message: 1 } })],
]

/** Failure a carrier channel reports about itself rather than as an Error instance. */
class ChannelClosure {
  toString(): string { return 'the channel closed without a message' }
}

/** Answer a carrier reports without a readable body, as a detached or empty answer arrives. */
class BodylessResponse extends Response {
  readonly #answer: string

  constructor(answer: string) {
    super(null)
    this.#answer = answer
  }

  override get body(): null { return null }

  override text(): Promise<string> { return Promise.resolve(this.#answer) }
}

/** Answer whose body arrives as the given pieces, so the reader sees a stream rather than one string. */
function streamed(pieces: readonly string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece))
      controller.close()
    },
  })
  return new Response(body)
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as TransportGlobal).__DSH_TRANSPORT__
  FakeXhr.last = undefined
})

describe('uploadArchive over XMLHttpRequest', () => {
  it('posts the file to the document-relative route and reports progress', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const progress: UploadProgress[] = []
    const file = new Blob(['zip'])
    const answer = uploadArchive(file, 'w 1', (item) => { progress.push(item) }, new AbortController().signal)
    const xhr = current()
    expect([xhr.method, xhr.url, xhr.headers, xhr.body]).toEqual([
      'POST', new URL('api/deepseek-chat-import/archive?workspaceId=w+1', document.baseURI).href,
      { 'content-type': 'application/octet-stream' }, file,
    ])
    xhr.upload.onprogress?.({ lengthComputable: false, loaded: 1, total: 0 })
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 0 })
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 4 })
    xhr.upload.onload?.()
    // Lines arrive in pieces; only complete lines are read.
    xhr.receive(200, '{"type":"progress","done":0,"total":2}\n{"type":"progr')
    xhr.receive(200, 'ess","done":1,"total":2}\n')
    xhr.respond(200, `${xhr.responseText}${OUTCOME_LINE}`)
    expect(await answer).toEqual({ ok: true, value: RESULT })
    expect(progress).toEqual([
      { phase: 'uploading', fraction: 0.25 }, { phase: 'reading' },
      { phase: 'importing', done: 0, total: 2 }, { phase: 'importing', done: 1, total: 2 },
    ])
  })

  it('reads an answer that a proxy delivers in one piece', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const progress: UploadProgress[] = []
    const answer = uploadArchive(new Blob([]), 'w1', (item) => { progress.push(item) }, new AbortController().signal)
    const busy = { ok: false, error: { reason: 'busy', message: 'another import is running' } }
    current().respond(200, `${PROGRESS_LINE}${JSON.stringify({ type: 'outcome', outcome: busy })}\n`)
    expect(await answer).toEqual(busy)
    expect(progress).toEqual([{ phase: 'importing', done: 0, total: 2 }])
  })

  it('reports transport failures', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const run = () => uploadArchive(new Blob([]), 'w1', () => {}, new AbortController().signal)
    let answer = run()
    current().receive(403, 'forbid')
    current().respond(403, 'forbidden')
    expect(await answer).toEqual({ ok: false, transport: 'HTTP 403: forbidden' })
    answer = run()
    current().respond(200, '<html>\n')
    expect(await answer).toEqual({ ok: false, transport: 'the server answered with invalid JSON' })
    answer = run()
    current().respond(200, PROGRESS_LINE)
    expect(await answer).toEqual({ ok: false, transport: 'the server ended the answer without a result' })
    answer = run()
    current().onerror?.()
    expect(await answer).toEqual({ ok: false, transport: 'the upload connection failed' })
    const controller = new AbortController()
    answer = uploadArchive(new Blob([]), 'w1', () => {}, controller.signal)
    controller.abort()
    expect(current().aborted).toBe(true)
    expect(await answer).toEqual({ ok: false, transport: 'the upload was cancelled' })
  })

  it('settles with an invalid-answer failure for a JSON line that is not a protocol value', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const run = () => uploadArchive(new Blob([]), 'w1', () => {}, new AbortController().signal)
    // The response collectors run inside onprogress/onload, so a throw here would leave the promise pending.
    for (const body of ['null\n', '{"type":"progress"}\n', '{"type":"outcome","outcome":{"ok":1}}\n']) {
      const answer = run()
      current().respond(200, body)
      await expect(answer).resolves.toEqual({ ok: false, transport: 'the server answered with invalid JSON' })
    }
  })

  it('settles the first invalid line and ignores a later outcome', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const answer = uploadArchive(new Blob([]), 'w1', () => {}, new AbortController().signal)
    // The invalid line arrives while the answer is still open; the request is
    // aborted and the promise settles without waiting for it to end.
    current().receive(200, 'null\n')
    await expect(answer).resolves.toEqual({ ok: false, transport: 'the server answered with invalid JSON' })
    expect(current().aborted).toBe(true)
    // Neither a later outcome nor the answer completing replaces the failure.
    current().receive(200, OUTCOME_LINE)
    current().respond(200, current().responseText)
    await expect(answer).resolves.toEqual({ ok: false, transport: 'the server answered with invalid JSON' })
  })
})

describe('uploadArchive through the page transport carrier', () => {
  it('sends the archive through the carrier and follows its answer stream', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    installCarrier((url, init) => {
      calls.push({ url: String(url), init })
      return Promise.resolve(streamed([PROGRESS_LINE, '{"type":"outc', `ome","outcome":{"ok":true,"value":${JSON.stringify(RESULT)}}}\n`]))
    })
    const progress: UploadProgress[] = []
    const file = new Blob(['zip'])
    const answer = await uploadArchive(file, 'w 1', (item) => { progress.push(item) }, new AbortController().signal)
    expect(answer).toEqual({ ok: true, value: RESULT })
    expect(calls.map(call => [call.url, call.init.method, call.init.body, call.init.headers])).toEqual([[
      new URL('api/deepseek-chat-import/archive?workspaceId=w+1', document.baseURI).href,
      'POST', file, { 'content-type': 'application/octet-stream' },
    ]])
    expect(progress).toEqual([{ phase: 'reading' }, { phase: 'importing', done: 0, total: 2 }])
  })

  it('reads a carrier answer that carries no body stream', async () => {
    installCarrier(() => Promise.resolve(new BodylessResponse(OUTCOME_LINE)))
    expect(await uploadArchive(new Blob([]), 'w1', () => {}, new AbortController().signal)).toEqual({ ok: true, value: RESULT })
  })

  it('settles the first invalid line while the answer stream stays open', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('null\n'))
        // Never closed: without settling on the invalid line the dialog waits forever.
      },
    })
    installCarrier(() => Promise.resolve(new Response(body)))
    await expect(uploadArchive(new Blob([]), 'w1', () => {}, new AbortController().signal))
      .resolves.toEqual({ ok: false, transport: 'the server answered with invalid JSON' })
  })

  it('cannot let a later valid outcome override an invalid line', async () => {
    const run = () => uploadArchive(new Blob([]), 'w1', () => {}, new AbortController().signal)
    installCarrier(() => Promise.resolve(new Response(`null\n${OUTCOME_LINE}`)))
    await expect(run()).resolves.toEqual({ ok: false, transport: 'the server answered with invalid JSON' })
    // An outcome that arrives before the invalid line does not survive it either.
    installCarrier(() => Promise.resolve(new Response(`${OUTCOME_LINE}null\n`)))
    await expect(run()).resolves.toEqual({ ok: false, transport: 'the server answered with invalid JSON' })
    installCarrier(() => Promise.resolve(new BodylessResponse('null\n')))
    await expect(run()).resolves.toEqual({ ok: false, transport: 'the server answered with invalid JSON' })
  })

  it('settles an invalid line even when cancelling the rest of the stream fails', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('null\n')) },
      cancel: () => Promise.reject(new Error('the carrier cannot cancel')),
    })
    installCarrier(() => Promise.resolve(new Response(body)))
    await expect(uploadArchive(new Blob([]), 'w1', () => {}, new AbortController().signal))
      .resolves.toEqual({ ok: false, transport: 'the server answered with invalid JSON' })
  })

  it('reports carrier failures', async () => {
    const run = () => uploadArchive(new Blob([]), 'w1', () => {}, new AbortController().signal)
    installCarrier(() => Promise.resolve(new Response('nope', { status: 500 })))
    expect(await run()).toEqual({ ok: false, transport: 'HTTP 500: nope' })
    installCarrier(() => Promise.resolve(new Response('<html>\n')))
    expect(await run()).toEqual({ ok: false, transport: 'the server answered with invalid JSON' })
    installCarrier(() => Promise.resolve(new Response(PROGRESS_LINE)))
    expect(await run()).toEqual({ ok: false, transport: 'the server ended the answer without a result' })
    installCarrier(() => Promise.reject(new Error('channel closed')))
    expect(await run()).toEqual({ ok: false, transport: 'channel closed' })
    // The page transport is not required to reject with an Error; the client must still name the failure.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a carrier may reject with its own reason value.
    installCarrier(() => Promise.reject(new ChannelClosure()))
    expect(await run()).toEqual({ ok: false, transport: 'the channel closed without a message' })
    // A body that fails mid-stream is a transport failure too, whatever it throws.
    installCarrier(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error('stream reset')) },
    }))))
    expect(await run()).toEqual({ ok: false, transport: 'stream reset' })
    installCarrier(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error('stream aborted') },
    }))))
    expect(await run()).toEqual({ ok: false, transport: 'stream aborted' })
  })

  it('reports cancellation before and during the request', async () => {
    const controller = new AbortController()
    controller.abort()
    installCarrier(() => Promise.reject(new Error('aborted')))
    expect(await uploadArchive(new Blob([]), 'w1', () => {}, controller.signal))
      .toEqual({ ok: false, transport: 'the upload was cancelled' })
    const midStream = new AbortController()
    installCarrier(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(streamController) {
        midStream.abort()
        streamController.error(new Error('aborted'))
      },
    }))))
    expect(await uploadArchive(new Blob([]), 'w1', () => {}, midStream.signal))
      .toEqual({ ok: false, transport: 'the upload was cancelled' })
  })

  it.each(INVALID_LINES)('fails the answer on %s', async (_case, body) => {
    installCarrier(() => Promise.resolve(new Response(body)))
    await expect(uploadArchive(new Blob([]), 'w1', () => {}, new AbortController().signal))
      .resolves.toEqual({ ok: false, transport: 'the server answered with invalid JSON' })
  })

  it('accepts a progress line and an outcome whose result carries skipped conversations', async () => {
    const skipped = [{ ...SKIP, title: null }, { ...SKIP, conversationId: 'c5', title: 'Older chat' }]
    installCarrier(() => Promise.resolve(new Response(`${PROGRESS_LINE}${outcome({ ok: true, value: { ...RESULT, skipped } })}`)))
    const progress: UploadProgress[] = []
    expect(await uploadArchive(new Blob([]), 'w1', (item) => { progress.push(item) }, new AbortController().signal))
      .toEqual({ ok: true, value: { ...RESULT, skipped } })
    expect(progress).toEqual([{ phase: 'reading' }, { phase: 'importing', done: 0, total: 2 }])
  })
})
