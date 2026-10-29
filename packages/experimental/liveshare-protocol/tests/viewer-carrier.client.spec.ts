// @vitest-environment jsdom
/**
 * The viewer page carrier: where it posts each read, how it numbers streams, and how it classifies what
 * went wrong as a retryable carrier loss or the peer's terminal refusal.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { installViewerCarrier, viewerCarrierScript, type ViewerCarrierOptions } from '../src/viewer-carrier.ts'

/** Page globals the carrier installs. */
interface CarrierGlobals {
  __DSH_LIVESHARE_VIEWER__?: { readonly basePath: string; readonly shareId: string; readonly sessionId: string }
  __DSH_TRANSPORT__?: {
    fetch(input: RequestInfo | URL, init: RequestInit): Promise<Response>
    openStream(endpoint: string, payload: unknown, signal: AbortSignal): AsyncIterable<unknown>
  }
}

interface MarkedFailure {
  readonly dshRemoteStreamFailure?: { readonly kind: 'carrier' | 'remote'; readonly code?: string; readonly details?: object }
}

/** One request the carrier posted. */
interface Posted {
  readonly url: string
  readonly op: string
  readonly id?: number
  readonly endpoint?: string
  readonly payload?: unknown
  readonly path?: string
  readonly body?: unknown
}

const OPTIONS: ViewerCarrierOptions = { basePath: '', shareId: 'share-1', sessionId: 'fx-alpha', readTimeoutMs: 30_000 }
const page = globalThis as CarrierGlobals
const pristineFetch = globalThis.fetch

afterEach(() => {
  vi.unstubAllGlobals()
  // The carrier replaces `globalThis.fetch` directly, so a test that installed it without a stub
  // would otherwise leave its wrapper on every later test.
  globalThis.fetch = pristineFetch
  delete page.__DSH_LIVESHARE_VIEWER__
  delete page.__DSH_TRANSPORT__
})

/**
 * Install the carrier over a stubbed Relay.
 * @param answer - Answers one posted request; a rejection is a read the browser could not send.
 * @param options - Carrier options.
 * @returns The installed transport and every posted request.
 */
function carrier(
  answer: (request: Posted, index: number, init: RequestInit) => Promise<Response> | Response,
  options: ViewerCarrierOptions = OPTIONS,
) {
  const posted: Posted[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    if (typeof init?.body !== 'string') throw new Error('carrier posted a non-string body')
    const request = { url: String(input), ...JSON.parse(init.body) as Omit<Posted, 'url'> }
    posted.push(request)
    return await answer(request, posted.length - 1, init)
  }))
  installViewerCarrier(options)
  const transport = page.__DSH_TRANSPORT__
  if (transport === undefined) throw new Error('carrier installed no transport')
  return { transport, posted }
}

/** A JSON Relay answer. */
function json(body: unknown, status = 200): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })
}

/**
 * Open one stream against Relay answers given in order; the last one repeats.
 * @param answers - Answers, in order.
 * @returns Values the consumer saw, the error it saw, and every posted request.
 */
async function readStream(answers: readonly { readonly status: number; readonly body: unknown }[]) {
  const { transport, posted } = carrier((_request, index) => {
    const answer = answers[Math.min(index, answers.length - 1)] ?? { status: 200, body: { end: true } }
    return json(answer.body, answer.status)
  })
  const values: unknown[] = []
  try {
    for await (const value of transport.openStream('session/follow', { address: 'x' }, new AbortController().signal)) {
      values.push(value)
    }
    return { values, error: undefined, posted }
  } catch (error) {
    return { values, error, posted }
  }
}

function markerOf(error: unknown): MarkedFailure['dshRemoteStreamFailure'] {
  return (error as MarkedFailure | undefined)?.dshRemoteStreamFailure
}

const OPENED = { status: 200, body: { opened: true } }

describe('viewer carrier installation', () => {
  it('names the share the page presents and posts every read to that share', async () => {
    const { posted } = carrier(() => json({ end: true }), { ...OPTIONS, basePath: '/relay', shareId: 'share 1/x' })
    expect(page.__DSH_LIVESHARE_VIEWER__).toEqual({ basePath: '/relay', shareId: 'share 1/x', sessionId: 'fx-alpha' })
    for await (const value of page.__DSH_TRANSPORT__!.openStream('session/follow', {}, new AbortController().signal)) void value
    expect(posted[0]?.url).toBe('/relay/__share/rpc?shareId=share%201%2Fx')
  })

  it('posts to the bare read channel when the page names no share', async () => {
    const { transport, posted } = carrier(() => json({ end: true }), { ...OPTIONS, shareId: '' })
    for await (const value of transport.openStream('session/follow', {}, new AbortController().signal)) void value
    expect(posted[0]?.url).toBe('/__share/rpc')
  })

  it('installs both globals from its own script text and escapes markup in option values', () => {
    const script = viewerCarrierScript({ ...OPTIONS, shareId: '</script><b>' })
    expect(script).not.toContain('</script>')
    expect(script).toContain('\\u003c/script>')
    ;(0, eval)(script)
    expect(page.__DSH_LIVESHARE_VIEWER__).toEqual({ basePath: '', shareId: '</script><b>', sessionId: 'fx-alpha' })
    expect(typeof page.__DSH_TRANSPORT__?.fetch).toBe('function')
    expect(typeof page.__DSH_TRANSPORT__?.openStream).toBe('function')
  })
})

describe('viewer carrier stream ids', () => {
  /**
   * Open `count` streams on one page and report the ids they opened under.
   * @param random - What the page's id seed draw writes, or undefined for the environment's own.
   * @param count - Streams to open.
   * @returns The `stream-open` ids in order.
   */
  async function pageStreamIds(random: ((array: Uint32Array) => unknown) | undefined, count: number): Promise<number[]> {
    if (random !== undefined) vi.stubGlobal('crypto', { getRandomValues: random })
    const { transport, posted } = carrier(() => json({ end: true }))
    for (let index = 0; index < count; index += 1) {
      for await (const value of transport.openStream('session/follow', {}, new AbortController().signal)) void value
    }
    return posted.filter(request => request.op === 'stream-open').map(request => request.id ?? -1)
  }
  const seeded = (seed: number) => (array: Uint32Array): Uint32Array => {
    array[0] = seed
    return array
  }

  it('numbers a page from its own seeded id, not from one', async () => {
    expect(await pageStreamIds(seeded(0x1000_0000), 2)).toEqual([0x1000_0001, 0x1000_0002])
  })

  it('gives two pages of one share disjoint id windows', async () => {
    const first = await pageStreamIds(seeded(0x1000_0000), 3)
    const second = await pageStreamIds(seeded(0x2000_0000), 3)
    expect(second.filter(id => first.includes(id))).toEqual([])
  })

  it('keeps every id inside the positive window', async () => {
    expect(await pageStreamIds(seeded(0xffff_ffff), 1)).toEqual([0xffff_ffff % 0x7fff_ff00 + 1])
    expect(await pageStreamIds(() => [], 1)).toEqual([1])
  })

  it('seeds the id space from the page environment', async () => {
    const ids = await pageStreamIds(undefined, 2)
    expect(ids[0]).toBeGreaterThanOrEqual(1)
    expect(ids[1]).toBe((ids[0] ?? 0) + 1)
  })
})

describe('viewer carrier streams', () => {
  it('opens, polls through pending answers, yields batches and single values, and stops at the end', async () => {
    const { values, error, posted } = await readStream([
      OPENED,
      { status: 200, body: { pending: true } },
      { status: 200, body: { values: [1, 2] } },
      { status: 200, body: { value: 3 } },
      { status: 200, body: { end: true } },
    ])
    expect(error).toBeUndefined()
    expect(values).toEqual([1, 2, 3])
    expect(posted.map(request => request.op)).toEqual([
      'stream-open', 'stream-next', 'stream-next', 'stream-next', 'stream-next', 'stream-cancel',
    ])
    expect(posted[0]).toMatchObject({ endpoint: 'session/follow', payload: { address: 'x' } })
  })

  it('reports a released stream as re-openable and stops asking for its id', async () => {
    const { error, posted } = await readStream([OPENED, { status: 404, body: { error: 'stream-not-found' } }])
    expect(markerOf(error)).toEqual({ kind: 'carrier' })
    expect(posted.map(request => request.op)).toEqual(['stream-open', 'stream-next', 'stream-cancel'])
  })

  it('reports a stream the shared vocabulary cancelled as re-openable', async () => {
    const { error } = await readStream([
      OPENED, { status: 200, body: { failure: { code: 'gateway/cancelled', message: 'owner gateway replaced' } } },
    ])
    expect(markerOf(error)).toEqual({ kind: 'carrier' })
    expect((error as Error).message).toBe('owner gateway replaced')
  })

  it('reports a Relay that cannot answer or is failing as re-openable', async () => {
    for (const status of [408, 429, 502, 503, 504]) {
      const answer = await readStream([{ status, body: { error: 'gateway unavailable' } }])
      expect([status, markerOf(answer.error)]).toEqual([status, { kind: 'carrier' }])
    }
    const silent = await readStream([OPENED, { status: 503, body: undefined }])
    expect(markerOf(silent.error)).toEqual({ kind: 'carrier' })
  })

  it('does not assume a plain server error is transient', async () => {
    const failed = await readStream([{ status: 500, body: { error: 'gateway/internal' } }])
    expect(markerOf(failed.error)).toEqual({ kind: 'remote', code: 'gateway/internal', details: { status: 500 } })
    const unshaped = await readStream([{ status: 500, body: { error: 'Internal failure.' } }])
    expect(markerOf(unshaped.error)).toEqual({ kind: 'remote', code: 'liveshare/read-refused', details: { status: 500 } })
    expect((unshaped.error as Error).message).toBe('session/follow refused (HTTP 500)')
  })

  it('never yields an event a peer never answered', async () => {
    const { transport, posted } = carrier((_request, index) => new Response(index === 0 ? '{"opened":true}' : 'not json'))
    const values: unknown[] = []
    let error: unknown
    try {
      for await (const value of transport.openStream('session/follow', {}, new AbortController().signal)) values.push(value)
    } catch (caught) {
      error = caught
    }
    expect(values).toEqual([])
    expect(markerOf(error)).toEqual({ kind: 'carrier' })
    expect(posted.map(request => request.op)).toEqual(['stream-open', 'stream-next', 'stream-cancel'])
    const empty = await readStream([{ status: 200, body: [] }])
    expect(markerOf(empty.error)).toEqual({ kind: 'carrier' })
    // The 200 open reached the owner, so a body the page cannot read still releases the stream id.
    expect(empty.posted.map(request => request.op)).toEqual(['stream-open', 'stream-cancel'])
  })

  it('keeps an authentication refusal terminal whatever code its body carries', async () => {
    for (const status of [401, 403]) {
      for (const code of ['stream-not-found', 'gateway/cancelled']) {
        const refused = await readStream([{ status, body: { error: code } }])
        expect([status, code, markerOf(refused.error)]).toEqual([status, code, { kind: 'remote', code, details: { status } }])
      }
    }
  })

  it('states a refusal as terminal, in either body shape, so the page cannot reconnect around it', async () => {
    const denied = await readStream([{ status: 403, body: { error: 'share-not-found' } }])
    expect(markerOf(denied.error)).toEqual({ kind: 'remote', code: 'share-not-found', details: { status: 403 } })
    expect((denied.error as Error).name).toBe('share-not-found')
    const nested = await readStream([{ status: 403, body: { error: { code: 'share-stopped', message: 'stopped' } } }])
    expect(markerOf(nested.error)).toEqual({ kind: 'remote', code: 'share-stopped', details: { status: 403 } })
    expect((nested.error as Error).message).toBe('stopped')
    const unauthorized = await readStream([{ status: 401, body: { error: 'authentication required' } }])
    expect(markerOf(unauthorized.error)).toEqual({ kind: 'remote', code: 'liveshare/read-refused', details: { status: 401 } })
    const bare = await readStream([{ status: 401, body: 'denied' }])
    expect(markerOf(bare.error)).toEqual({ kind: 'remote', code: 'liveshare/read-refused', details: { status: 401 } })
  })

  it('keeps the code and details a refused stream frame names, and names a refusal that names none', async () => {
    const refused = await readStream([
      OPENED, { status: 200, body: { failure: { code: 'gateway/forbidden', message: 'not authorized', details: { a: 1 } } } },
    ])
    expect(markerOf(refused.error)).toEqual({ kind: 'remote', code: 'gateway/forbidden', details: { a: 1 } })
    expect((refused.error as Error).name).toBe('gateway/forbidden')
    const unnamed = await readStream([OPENED, { status: 200, body: { failure: {} } }])
    expect(markerOf(unnamed.error)).toEqual({ kind: 'remote', code: 'liveshare/read-refused', details: {} })
    expect((unnamed.error as Error).message).toBe('session/follow')
  })

  it('reports a refused stream open once, classified by the owner code rather than as a lost stream', async () => {
    // The owner answers a refused open as a 200 failure frame and registers no stream for that id, so the
    // carrier must surface the refusal instead of polling an id that would read `stream-not-found`.
    const refused = () => json({ failure: {
      code: 'remote-access/denied',
      message: 'remote access: job/list: access denied (liveshare/read-only)',
      details: { action: 'job/list', reason: 'liveshare/read-only' },
    } })
    const { transport, posted } = carrier(refused)
    let error: unknown
    try {
      for await (const value of transport.openStream('job/list', {}, new AbortController().signal)) void value
    } catch (caught) {
      error = caught
    }
    expect(markerOf(error)).toEqual({
      kind: 'remote',
      code: 'remote-access/denied',
      details: { action: 'job/list', reason: 'liveshare/read-only' },
    })
    // One attempt: no `stream-next` poll, and no re-open a supervisor could drive from a carrier marker.
    expect(posted.map(request => request.op)).toEqual(['stream-open'])
  })

  it('classifies an open-time failure frame by its exact owner code', async () => {
    /**
     * Open one stream whose open is refused with one code.
     * @param code - owner code the failure frame carries.
     * @returns the failure marker the consumer saw and the ops the carrier posted.
     */
    const refusedWith = async (code: string) => {
      const { transport, posted } = carrier(() => json({ failure: { code, message: code } }))
      try {
        for await (const value of transport.openStream('job/list', {}, new AbortController().signal)) void value
        return { marker: undefined, ops: posted.map(request => request.op) }
      } catch (error) {
        return { marker: markerOf(error), ops: posted.map(request => request.op) }
      }
    }
    // Lost-stream codes keep the supervisor's reopen rule; every other code is an owner refusal, so the
    // carrier posts nothing after the open and the failure is reported once.
    expect((await refusedWith('stream-not-found')).marker).toEqual({ kind: 'carrier' })
    expect((await refusedWith('gateway/cancelled')).marker).toEqual({ kind: 'carrier' })
    expect(await refusedWith('remote-access/denied')).toEqual({
      marker: { kind: 'remote', code: 'remote-access/denied', details: {} },
      ops: ['stream-open'],
    })
    expect(await refusedWith('liveshare/read-only')).toEqual({
      marker: { kind: 'remote', code: 'liveshare/read-only', details: {} },
      ops: ['stream-open'],
    })
  })

  it('keeps a refused, revoked, or expired read terminal', async () => {
    for (const [status, code] of [
      [401, 'viewer-not-authorized'], [403, 'share-stopped'], [403, 'share-revoked'], [403, 'share-expired'],
    ] as const) {
      const refused = await readStream([{ status, body: { error: code } }])
      expect([status, code, markerOf(refused.error)]).toEqual([status, code, { kind: 'remote', code, details: { status } }])
    }
  })
})

describe('viewer carrier read losses and cancellation', () => {
  it('reports a read the browser could not send, or its own expired budget, as re-openable', async () => {
    for (const failure of [
      new TypeError('Failed to fetch'),
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    ]) {
      const { transport, posted } = carrier(() => Promise.reject(failure))
      let error: unknown
      try {
        for await (const value of transport.openStream('session/follow', {}, new AbortController().signal)) void value
      } catch (caught) {
        error = caught
      }
      expect(markerOf(error)).toEqual({ kind: 'carrier' })
      expect(posted.map(request => request.op)).toEqual(['stream-open'])
    }
  })

  it('reports a read the network dropped after the stream opened as re-openable, and swallows its cancel', async () => {
    const { transport, posted } = carrier((_request, index) => index === 0
      ? json({ opened: true })
      : Promise.reject(new TypeError('NetworkError when attempting to fetch resource.')))
    let error: unknown
    try {
      for await (const value of transport.openStream('session/follow', {}, new AbortController().signal)) void value
    } catch (caught) {
      error = caught
    }
    expect(markerOf(error)).toEqual({ kind: 'carrier' })
    await vi.waitFor(() => {
      expect(posted.map(request => request.op)).toEqual(['stream-open', 'stream-next', 'stream-cancel'])
    })
  })

  it('refuses to open a stream whose consumer already left', async () => {
    const { transport, posted } = carrier(() => json({ opened: true }))
    const left = new AbortController()
    left.abort(new Error('left'))
    await expect(transport.openStream('session/follow', {}, left.signal)[Symbol.asyncIterator]().next())
      .rejects.toThrow('left')
    expect(posted).toEqual([])
  })

  it.each(['stream-open', 'stream-next'] as const)('ignores a late %s answer after cancellation and cancels once', async (pendingOp) => {
    const requested = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<Response>()
    const { transport, posted } = carrier((request) => {
      if (request.op === pendingOp) {
        requested.resolve(undefined)
        return answer.promise
      }
      return json({ opened: true })
    })
    const leaving = new AbortController()
    const reading = transport.openStream('session/control', {}, leaving.signal)[Symbol.asyncIterator]().next()
    await requested.promise
    const failure = new Error('viewer left the page')
    leaving.abort(failure)
    answer.resolve(json(pendingOp === 'stream-open' ? { opened: true } : { value: 'late' }))
    await expect(reading).rejects.toBe(failure)
    await vi.waitFor(() => { expect(posted.filter(request => request.op === 'stream-cancel')).toHaveLength(1) })
  })

  it('stops a received batch at the consumer\u2019s cancellation', async () => {
    const { transport } = carrier(request => json(request.op === 'stream-next' ? { values: ['a', 'b'] } : { opened: true }))
    const leaving = new AbortController()
    const iterator = transport.openStream('session/control', {}, leaving.signal)[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ done: false, value: 'a' })
    const failure = new Error('viewer switched Session')
    leaving.abort(failure)
    await expect(iterator.next()).rejects.toBe(failure)
  })

  it('cancels the stream when its consumer stops reading early', async () => {
    const { transport, posted } = carrier(request => json(request.op === 'stream-next' ? { value: 'a' } : { opened: true }))
    for await (const value of transport.openStream('session/control', {}, new AbortController().signal)) {
      expect(value).toBe('a')
      break
    }
    expect(posted.map(request => request.op)).toEqual(['stream-open', 'stream-next', 'stream-cancel'])
  })

  it('keeps the caller\u2019s own cancellation out of the reconnect path and releases the abandoned open', async () => {
    const { transport, posted } = carrier((_request, _index, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new Error('aborted by the caller')) }, { once: true })
    }))
    const leaving = new AbortController()
    const reading = (async (): Promise<unknown> => {
      try {
        for await (const value of transport.openStream('session/follow', {}, leaving.signal)) void value
        return undefined
      } catch (error) {
        return error
      }
    })()
    await Promise.resolve()
    leaving.abort(new Error('viewer left the page'))
    const error = await reading
    expect(error).toBeInstanceOf(Error)
    expect(markerOf(error)).toBeUndefined()
    // The open may already have reached the owner, so the page releases that stream id.
    expect(posted.map(request => request.op)).toEqual(['stream-open', 'stream-cancel'])
    expect(posted[1]?.id).toBe(posted[0]?.id)
  })
})

describe('viewer carrier unary calls', () => {
  /**
   * Post one Connection call through the carrier.
   * @param answer - The Relay's answer.
   * @param input - Route the Connection caller posts.
   * @param body - Request body; `null` posts none.
   * @returns The envelope the caller parses, and the request the carrier posted.
   */
  async function call(answer: Response, input: string | URL | Request = 'api/session/prompt', body: unknown = {
    type: 'client-request', rpcId: 'rpc-1', method: 'session/prompt', payload: { args: {} },
  }) {
    const { transport, posted } = carrier(() => answer)
    const response = await transport.fetch(input, {
      method: 'POST', ...(body === null ? {} : { body: JSON.stringify(body) }),
    })
    return { envelope: await response.json() as Record<string, unknown>, posted }
  }

  it('posts the owner\u2019s /api path and returns the owner\u2019s answer unchanged', async () => {
    const { envelope, posted } = await call(json({ type: 'server-response', rpcId: 'rpc-1', result: { ok: true } }),
      'https://relay.example/share/x/api/session/list')
    expect(envelope).toEqual({ type: 'server-response', rpcId: 'rpc-1', result: { ok: true } })
    expect(posted[0]).toMatchObject({ op: 'call', path: '/api/session/list', body: { rpcId: 'rpc-1' } })
    const relative = await call(json({ ok: true }))
    expect(relative.posted[0]?.path).toBe('/api/session/prompt')
    const request = await call(json({ ok: true }), new Request('https://relay.example/share/x/api/session/page'))
    expect(request.posted[0]?.path).toBe('/api/session/page')
    const unmarked = await call(json({ ok: true }), 'https://relay.example/health', null)
    expect(unmarked.posted[0]).toEqual({ url: '/__share/rpc?shareId=share-1', op: 'call', path: '/health' })
  })

  it('rebuilds a refused call as the Connection failure the peer\u2019s code names', async () => {
    for (const code of ['share-not-writable', 'source-write-unavailable']) {
      for (const body of [{ error: code, message: 'refused by the host' }, { error: { code, message: 'refused by the host' } }]) {
        const { envelope } = await call(json(body, 403))
        expect(envelope).toEqual({
          type: 'server-response',
          rpcId: 'rpc-1',
          result: { ok: false, error: { code, message: 'refused by the host', details: { status: 403 } } },
        })
      }
    }
    const unnamed = await call(json({ message: 'refused' }, 403))
    expect(unnamed.envelope.result).toEqual({
      ok: false, error: { code: 'liveshare/relay-error', message: 'refused', details: { status: 403 } },
    })
    const sentence = await call(json({ error: 'the owner said no', message: 'refused' }, 403))
    expect(sentence.envelope.result).toMatchObject({ error: { code: 'liveshare/relay-error', message: 'refused' } })
    const silent = await call(json(undefined, 502), 'api/session/list', [])
    expect(silent.envelope).toEqual({
      type: 'server-response',
      rpcId: '',
      result: { ok: false, error: { code: 'liveshare/relay-error', message: 'Relay answered HTTP 502', details: { status: 502 } } },
    })
    const unreadable = await call(json(['not', 'a', 'record']))
    expect(unreadable.envelope.result).toMatchObject({ ok: false, error: { details: { status: 200 } } })
  })

  it('reports a call the browser could not send as re-openable, and the caller\u2019s cancellation as itself', async () => {
    const { transport } = carrier(() => Promise.reject(new TypeError('Failed to fetch')))
    await expect(transport.fetch('api/session/list', { method: 'POST', body: '{}' })).rejects.toSatisfy(
      (error: unknown) => markerOf(error)?.kind === 'carrier',
    )
    const aborted = new AbortController()
    aborted.abort()
    const reason = new Error('caller left')
    const cancelled = carrier(() => Promise.reject(reason))
    await expect(cancelled.transport.fetch('api/session/list', { method: 'POST', body: '{}', signal: aborted.signal }))
      .rejects.toBe(reason)
  })
})

describe('viewer carrier forwarded page routes', () => {
  /**
   * Install the carrier over a page fetch that answers everything itself.
   * @returns The Fetch replacement the carrier captured, and every request it received.
   */
  function directFetch() {
    const direct = vi.fn(async (input: unknown) => new Response(`direct:${String(input)}`))
    vi.stubGlobal('fetch', direct)
    installViewerCarrier(OPTIONS)
    return direct
  }

  it('forwards a page-origin owner route the Relay serves no answer for', async () => {
    const { posted } = carrier(() => json({ apps: ['finder'] }))
    const response = await globalThis.fetch('open-in-app/apps')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ apps: ['finder'] })
    expect(posted[0]).toMatchObject({ op: 'call', path: '/open-in-app/apps', body: {} })
  })

  it('forwards the /api owner route a direct fetch never sends through the Connection transport', async () => {
    const { posted } = carrier(() => json({ name: 'owner-host', available: true, fileManager: 'finder' }))
    expect(await (await globalThis.fetch('/api/present.host')).json()).toMatchObject({ name: 'owner-host' })
    expect(posted[0]).toMatchObject({ op: 'call', path: '/api/present.host' })
  })

  it('reads the owner path under the Relay\u2019s own base path and keeps the owner\u2019s refusal status', async () => {
    const { posted } = carrier(() => json({ error: 'route-unavailable' }, 403))
    const response = await globalThis.fetch('/relay/s/abc/open-in-app/apps')
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'route-unavailable' })
    expect(posted[0]).toMatchObject({ op: 'call', path: '/open-in-app/apps' })
  })

  it('forwards a route only when it starts a path segment', async () => {
    const below = carrier(() => json({ apps: ['finder'] }))
    expect(await (await globalThis.fetch('/relay/s/abc/open-in-app/apps/foo')).json()).toEqual({ apps: ['finder'] })
    expect(below.posted[0]).toMatchObject({ op: 'call', path: '/open-in-app/apps/foo' })
    const exact = carrier(() => json({ name: 'owner-host' }))
    expect(await (await globalThis.fetch('/relay/s/abc/api/present.host')).json()).toEqual({ name: 'owner-host' })
    expect(exact.posted[0]).toMatchObject({ op: 'call', path: '/api/present.host' })
  })

  it('does not forward a prefix neighbour of a forwarded route', async () => {
    const direct = directFetch()
    expect(await (await globalThis.fetch('/api/present.hostile')).text()).toBe('direct:/api/present.hostile')
    expect(await (await globalThis.fetch('/x/open-in-app/apps-foo')).text()).toBe('direct:/x/open-in-app/apps-foo')
    expect(await (await globalThis.fetch('/api/present.hostile?x=1')).text()).toBe('direct:/api/present.hostile?x=1')
    expect(direct).toHaveBeenCalledTimes(3)
  })

  it('leaves a cross-origin request that names a forwarded route to the page fetch', async () => {
    const direct = directFetch()
    expect(await (await globalThis.fetch('https://cdn.example/api/present.host')).text())
      .toBe('direct:https://cdn.example/api/present.host')
    expect(await (await globalThis.fetch('https://cdn.example/x/open-in-app/apps')).text())
      .toBe('direct:https://cdn.example/x/open-in-app/apps')
    expect(direct).toHaveBeenCalledTimes(2)
  })

  it('forwards an absolute request the page makes to its own origin', async () => {
    const { posted } = carrier(() => json({ name: 'owner-host' }))
    const origin = new URL(document.baseURI).origin
    expect(await (await globalThis.fetch(`${origin}/relay/s/abc/api/present.host`)).json())
      .toMatchObject({ name: 'owner-host' })
    expect(posted[0]).toMatchObject({ op: 'call', path: '/api/present.host' })
  })

  it('leaves a relative route to the page fetch once the page base names another origin', async () => {
    const direct = directFetch()
    const base = document.createElement('base')
    base.href = 'https://cdn.example/'
    document.head.append(base)
    try {
      expect(await (await globalThis.fetch('api/present.host')).text()).toBe('direct:api/present.host')
      expect(direct).toHaveBeenCalledTimes(1)
    } finally {
      base.remove()
    }
  })

  it('forwards a hit whose page URL carries a query without passing it to the owner', async () => {
    const { posted } = carrier(() => json({ name: 'owner-host', available: true, fileManager: 'finder' }))
    expect(await (await globalThis.fetch('/relay/s/abc/api/present.host?x=1#frag')).json()).toMatchObject({ name: 'owner-host' })
    expect(posted[0]).toMatchObject({ op: 'call', path: '/api/present.host' })
  })

  it('leaves every other request to the page\u2019s own fetch', async () => {
    const direct = directFetch()
    expect(await (await globalThis.fetch('health')).text()).toBe('direct:health')
    expect(direct).toHaveBeenCalledExactlyOnceWith('health', undefined)
  })

  it('keeps the receiver of the page fetch it replaced', async () => {
    const receivers: unknown[] = []
    const direct = vi.fn(function (this: unknown, input: unknown) {
      receivers.push(this)
      return Promise.resolve(new Response(`direct:${String(input)}`))
    })
    vi.stubGlobal('fetch', direct)
    installViewerCarrier(OPTIONS)
    await globalThis.fetch('health')
    expect(receivers).toEqual([globalThis])
  })

  it('does not forward a route that acts on the owner\u2019s machine', async () => {
    const direct = directFetch()
    expect(await (await globalThis.fetch('open-in-app/open', { method: 'POST', body: '{"app":"finder"}' })).text())
      .toBe('direct:open-in-app/open')
    expect(direct).toHaveBeenCalledTimes(1)
  })

  it('carries a forwarded request body and its abort signal to the owner', async () => {
    const { posted } = carrier(() => json({ name: 'owner-host' }))
    const controller = new AbortController()
    const response = await globalThis.fetch('/api/present.host', {
      body: '{"app":"finder"}',
      signal: controller.signal,
    })
    expect(await response.json()).toEqual({ name: 'owner-host' })
    expect(posted[0]).toMatchObject({ op: 'call', path: '/api/present.host', body: { app: 'finder' } })
  })

  it('forwards a GET whose init states no body or signal', async () => {
    const { posted } = carrier(() => json({ name: 'owner-host' }))
    expect(await (await globalThis.fetch('/api/present.host', { method: 'GET' })).json())
      .toEqual({ name: 'owner-host' })
    expect(posted[0]).toMatchObject({ op: 'call', path: '/api/present.host', body: {} })
  })

  it('treats a null page signal as no signal', async () => {
    const { posted } = carrier(() => json({ name: 'owner-host' }))
    // A page handler may pass `signal: null`; the carrier states it as no signal rather than as one.
    expect(await (await globalThis.fetch('/api/present.host', { signal: null })).json())
      .toEqual({ name: 'owner-host' })
    expect(posted[0]).toMatchObject({ op: 'call', path: '/api/present.host' })
  })

  it('answers a forwarded route whose owner reply carries no body', async () => {
    const { posted } = carrier(() => new Response('', { status: 200 }))
    const response = await globalThis.fetch('/api/present.host')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('null')
    expect(posted).toHaveLength(1)
  })

  it('reads the target and method from a Request object', async () => {
    const { posted } = carrier(() => json({ apps: ['finder'] }))
    const response = await globalThis.fetch(new Request(new URL('open-in-app/apps', document.baseURI)))
    expect(await response.json()).toEqual({ apps: ['finder'] })
    expect(posted[0]).toMatchObject({ op: 'call', path: '/open-in-app/apps' })
  })

  it('leaves a target the page base cannot resolve to the page fetch', async () => {
    const direct = directFetch()
    // `new URL` rejects this target, so it cannot name a forwarded route.
    expect(await (await globalThis.fetch('http://[invalid')).text()).toBe('direct:http://[invalid')
    expect(direct).toHaveBeenCalledTimes(1)
  })
})
