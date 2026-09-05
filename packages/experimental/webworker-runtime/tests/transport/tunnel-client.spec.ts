/**
 * Check the page half of the tunnel against hand-fed frames: a stub worker replaces
 * the real one, so every reply shape — unary, streamed, refused, aborted — can be
 * delivered on demand and the client's reaction observed directly.
 *
 * The refusal warnings are the reason this suite exists. They are the only signal
 * that separates "the tunnel refused" from "the host tree answered with an error"
 * in an acceptance run's console log, and a diagnostic nothing exercises is a
 * diagnostic that silently stops working.
 *
 * The refusal text is matched verbatim on purpose: the worker composes it from the
 * expanded cause chain, so both sides hold each other to it. Do not relax these
 * expectations to make a change pass — agree the new text with the worker host first.
 */
import { expect, test } from 'vitest'
import { WorkerTunnel } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/client/client.ts'

// Both sides are serialized here, at call time, rather than inside the case: the
// blocks below reuse and clear the `warnings` array, so a captured reference
// would read a later block's state by the time the case executes.
const check = (label: string, actual: unknown, expected: unknown): void => {
  const [seen, wanted] = [JSON.stringify(actual), JSON.stringify(expected)]
  test(label, () => { expect(seen).toBe(wanted) })
}

const warnings: string[] = []
console.warn = (message: string) => { warnings.push(message) }
;(globalThis as { location?: unknown }).location = { origin: 'http://localhost:4173' }

type StubListener = (event: { data?: unknown; message?: string }) => void

/** A worker stand-in: collects what the page sent, replays what the test delivers. */
function stubWorker(): {
  worker: Worker
  sent: { t: string; id: number }[]
  transfers: Transferable[][]
  deliver: (frame: unknown) => void
  fail: (message: string) => void
} {
  const listeners: StubListener[] = []
  const errorListeners: StubListener[] = []
  const sent: { t: string; id: number }[] = []
  const transfers: Transferable[][] = []
  const worker = {
    addEventListener: (type: string, listener: StubListener) => {
      if (type === 'message') listeners.push(listener)
      if (type === 'error') errorListeners.push(listener)
    },
    postMessage: (frame: unknown, transfer?: Transferable[]) => {
      sent.push(frame as { t: string; id: number })
      transfers.push(transfer ?? [])
    },
  } as unknown as Worker
  return {
    worker,
    sent,
    transfers,
    deliver: (frame) => { for (const listener of listeners) listener({ data: frame }) },
    fail: (message) => { for (const listener of errorListeners) listener({ message }) },
  }
}

// ReadableStream request bodies transfer ownership instead of copying chunks on the page.
{
  const { worker, sent, transfers } = stubWorker()
  const tunnel = new WorkerTunnel(worker)
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
  void tunnel.fetch('/upload', { method: 'POST', body, duplex: 'half' } as RequestInit)
  check('a stream request body stays intact', (sent[0] as unknown as { body: unknown }).body, body)
  check('a stream request body is transferred', transfers[0], [body])
}

// The opening frame preserves overlay order for deterministic pre-boot mounts.
{
  const { worker, sent } = stubWorker()
  const tunnel = new WorkerTunnel(worker)
  tunnel.init('https://preview.test/base.tar.gz', [
    'https://preview.test/first.tar.gz',
    'https://preview.test/second.tar.gz',
  ])
  check('the init frame carries ordered overlays', sent[0], {
    t: 'init',
    image: 'https://preview.test/base.tar.gz',
    overlays: ['https://preview.test/first.tar.gz', 'https://preview.test/second.tar.gz'],
  })

  const direct = stubWorker()
  new WorkerTunnel(direct.worker).init('https://preview.test/base.tar.gz')
  check('the direct init path defaults to no overlays', direct.sent[0], {
    t: 'init', image: 'https://preview.test/base.tar.gz', overlays: [],
  })
}

// A normal reply resolves and says nothing on the console.
{
  const { worker, sent, deliver } = stubWorker()
  const tunnel = new WorkerTunnel(worker)
  const response = tunnel.fetch('/api/session.list', { method: 'POST', body: '{"a":1}' })
  const request = sent[0] as unknown as { t: string; id: number; method: string; url: string; body: ArrayBuffer }
  check('the request frame carries method and absolute url', [request.t, request.id, request.method, request.url],
    ['req', 1, 'POST', 'http://localhost:4173/api/session.list'])
  check('the request body travels as bytes', new TextDecoder().decode(request.body), '{"a":1}')
  deliver({ t: 'res', id: 1, status: 200, headers: {}, message: '{"ok":true}' })
  const resolved = await response
  check('a normal reply resolves', resolved.status, 200)
  check('a normal reply carries its body', await resolved.text(), '{"ok":true}')
  check('a normal reply warns about nothing', warnings.length, 0)
}

// A null-body status resolves without a body rather than throwing.
{
  const { worker, deliver } = stubWorker()
  const tunnel = new WorkerTunnel(worker)
  const response = tunnel.fetch('/api/session.delete', { method: 'POST' })
  deliver({ t: 'res', id: 1, status: 204, headers: {} })
  check('204 resolves with a null body', (await response).body, null)
}

// Blob bodies remain Blob-backed across the page-to-Host Worker handoff.
{
  const { worker, sent } = stubWorker()
  const tunnel = new WorkerTunnel(worker)
  const body = new Blob(['large'])
  void tunnel.fetch('/upload', { method: 'POST', body })
  check('a Blob request body stays opaque', (sent[0] as unknown as { body: unknown }).body, body)
}

// A streamed reply reassembles in order and closes.
{
  const { worker, deliver } = stubWorker()
  const tunnel = new WorkerTunnel(worker)
  const response = tunnel.fetch('/api/session.events', { method: 'POST' })
  deliver({ t: 'res-head', id: 1, status: 200, headers: { 'content-type': 'text/event-stream' } })
  const resolved = await response
  const encoder = new TextEncoder()
  deliver({ t: 'res-chunk', id: 1, chunk: encoder.encode('one ').buffer })
  deliver({ t: 'res-chunk', id: 1, chunk: encoder.encode('two').buffer })
  deliver({ t: 'res-end', id: 1 })
  check('a streamed reply reassembles in order', await resolved.text(), 'one two')
}

// A refusal names the request, so a console log alone tells tunnel from tree.
{
  warnings.length = 0
  const { worker, deliver } = stubWorker()
  const tunnel = new WorkerTunnel(worker)
  const refused = tunnel.fetch('/api/session.create', { method: 'POST' })
  deliver({ t: 'res', id: 1, status: 503, headers: {}, message: 'host is not serving yet' })
  check('a 5xx reply still resolves', (await refused).status, 503)
  check('a 5xx reply is reported once', warnings, [
    'web-preview tunnel: request 1 POST http://localhost:4173/api/session.create → HTTP 503: host is not serving yet',
  ])
}

// An error frame rejects the caller and reports the same request.
{
  warnings.length = 0
  const { worker, deliver } = stubWorker()
  const tunnel = new WorkerTunnel(worker)
  const errored = tunnel.fetch('/api/session.history', { method: 'POST' })
  deliver({ t: 'res-err', id: 1, message: 'boom: nested cause' })
  check('an error frame rejects', await errored.then(() => 'resolved', (error: unknown) => (error as Error).message),
    'web-preview tunnel: boom: nested cause')
  check('an error frame is reported once', warnings, [
    'web-preview tunnel: request 1 POST http://localhost:4173/api/session.history → res-err: boom: nested cause',
  ])
}

// A 4xx is the host tree answering, not the tunnel refusing: no warning.
{
  warnings.length = 0
  const { worker, deliver } = stubWorker()
  const tunnel = new WorkerTunnel(worker)
  const denied = tunnel.fetch('/api/plugin.mount', { method: 'POST' })
  deliver({ t: 'res', id: 1, status: 403, headers: {}, message: 'privileged' })
  check('4xx resolves', (await denied).status, 403)
  check('4xx stays silent', warnings, [])
}

// Aborting sends an abort frame and rejects with AbortError.
{
  const { worker, sent, deliver } = stubWorker()
  const tunnel = new WorkerTunnel(worker)
  const controller = new AbortController()
  const aborted = tunnel.fetch('/api/session.events', { method: 'POST', signal: controller.signal })
  controller.abort()
  check('abort rejects with AbortError', await aborted.then(() => 'resolved', (error: unknown) => (error as Error).name), 'AbortError')
  check('abort reaches the worker', sent.at(-1), { t: 'abort', id: 1 })
  // A late reply to an aborted request must not resurrect it.
  deliver({ t: 'res', id: 1, status: 200, headers: {}, message: 'late' })
}

// A logical Gateway stream carries decoded values and one terminal frame.
{
  const { worker, sent, deliver } = stubWorker()
  const tunnel = new WorkerTunnel(worker)
  const signal = new AbortController()
  const stream = tunnel.open('session/follow', { args: { sessionId: 'session-1' } }, signal.signal)
    [Symbol.asyncIterator]()
  const first = stream.next()
  check('a logical stream opens on the worker-local carrier', sent[0], {
    t: 'stream-open', id: 1, endpoint: 'session/follow', payload: { args: { sessionId: 'session-1' } },
  })
  deliver({ t: 'stream-item', id: 1, value: { type: 'baseline' } })
  check('a logical stream yields decoded values', await first, { value: { type: 'baseline' }, done: false })
  const ended = stream.next()
  deliver({ t: 'stream-end', id: 1 })
  check('a logical stream closes normally', await ended, { done: true, value: undefined })
  check('normal stream completion sends no cancellation', sent, [
    { t: 'stream-open', id: 1, endpoint: 'session/follow', payload: { args: { sessionId: 'session-1' } } },
  ])
}

// Host failures retain their code and details for the Gateway Client bundle to normalize.
{
  const { worker, deliver } = stubWorker()
  const tunnel = new WorkerTunnel(worker)
  const pending = tunnel.open('session/follow', {}, new AbortController().signal).next()
  deliver({
    t: 'stream-error',
    id: 1,
    failure: {
      kind: 'remote',
      code: 'session/not-found',
      message: 'fixture Session is absent',
      details: { sessionId: 'session-1' },
    },
  })
  const failure = await pending.then(() => undefined, (error: unknown) => error as {
    message: string
    dshRemoteStreamFailure: unknown
  })
  check('a logical Host failure retains its structural marker', {
    message: failure?.message,
    dshRemoteStreamFailure: failure?.dshRemoteStreamFailure,
  }, {
    message: 'fixture Session is absent',
    dshRemoteStreamFailure: {
      kind: 'remote', code: 'session/not-found', details: { sessionId: 'session-1' },
    },
  })
}

// Caller cancellation keeps the caller's exact reason and reaches the worker once.
{
  const { worker, sent, deliver } = stubWorker()
  const tunnel = new WorkerTunnel(worker)
  const abort = new AbortController()
  const pending = tunnel.open('workspace/follow', {}, abort.signal).next()
  const reason = new Error('caller stopped the Workspace feed')
  abort.abort(reason)
  deliver({ t: 'stream-item', id: 1, value: 'late' })
  check('logical stream cancellation preserves the caller reason', await pending.then(
    () => 'resolved',
    (error: unknown) => error === reason ? 'same reason' : 'different reason',
  ), 'same reason')
  check('logical stream cancellation reaches the worker', sent.at(-1), { t: 'abort', id: 1 })
}

// A failed worker is a carrier failure, not a fabricated Host Remote error.
{
  warnings.length = 0
  const { worker, fail } = stubWorker()
  const tunnel = new WorkerTunnel(worker)
  const pending = tunnel.open('$events', { args: {} }, new AbortController().signal).next()
  fail('worker crashed')
  const failure = await pending.then(() => undefined, (error: unknown) => error as {
    message: string
    dshRemoteStreamFailure: unknown
  })
  check('worker failure carries the carrier marker', {
    message: failure?.message,
    dshRemoteStreamFailure: failure?.dshRemoteStreamFailure,
  }, {
    message: 'web-preview tunnel: worker failed: worker crashed',
    dshRemoteStreamFailure: { kind: 'carrier' },
  })
}
