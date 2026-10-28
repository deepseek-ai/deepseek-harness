/**
 * Stand-in Relay for the assembled viewer page tests: the page's read channel answered from a scripted owner.
 *
 * The assembled page reads its share the way a served page does — one request per read posted to the
 * Relay's read channel, which forwards it unread and writes the owner's answer back. This module
 * answers that channel in the test process, so the page under test keeps its real carrier, its
 * real envelopes, and its real polling, while the owner behind it stays the scripted mock.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/tests/viewer-relay
 */

import { vi } from 'vitest'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { ViewerRequest, ViewerStreamValue } from '../src/viewer-channel.ts'

/** Path the viewer page posts every read to. */
const READ_CHANNEL = '/__share/rpc'

/** One client request envelope as the page's HTTP caller writes it. */
interface ClientRequestBody {
  readonly rpcId?: unknown
  readonly method?: unknown
  readonly payload?: unknown
}

/** One open read, kept until its consumer releases it or the scripted owner ends it. */
interface OpenRead {
  readonly controller: AbortController
  readonly iterator: AsyncIterator<unknown>
}

/** Abort and await the Owner generator's finally block before releasing its subscription. */
async function closeRead(stream: OpenRead): Promise<void> {
  stream.controller.abort()
  await stream.iterator.return?.()
}

/** Owner the page's reads are answered from, and the answers for the page's requests outside the read channel. */
export interface ViewerRelayOptions {
  /** In-memory carrier answering every read; a case that reads a share supplies one. */
  readonly owner?: ClientConnectionRpc
  /** Answers for the page's requests outside the read channel: the share context and the health probe. */
  readonly other?: (url: string) => Promise<Response>
}

/**
 * Answer one read the way the owner behind the Relay would.
 * @param owner - Scripted owner transport.
 * @param streams - Open reads this page holds, keyed by the id the page minted.
 * @param request - One validated request the page posted.
 * @returns The Relay's HTTP answer, whose body is the owner's own answer.
 */
async function answerRead(
  owner: ClientConnectionRpc,
  streams: Map<number, OpenRead>,
  request: ViewerRequest,
): Promise<Response> {
  switch (request.op) {
    case 'call': {
      const body = request.body as ClientRequestBody | undefined
      const endpoint = typeof body?.method === 'string'
        ? body.method
        : request.path.replace(/^\/api\//u, '')
      const result = await owner.call('/api', endpoint, body?.payload)
      return Response.json({
        type: 'server-response',
        rpcId: typeof body?.rpcId === 'string' ? body.rpcId : '',
        result,
      })
    }
    case 'stream-open': {
      const open = owner.open
      if (open === undefined) throw new Error('viewer relay: the scripted owner opens no stream')
      const controller = new AbortController()
      // Yield before running the script: RemoteMock runs it synchronously, and a script that pushes
      // its opening frame recurses into the page's own consumer, so it must start from a fresh stack.
      await Promise.resolve()
      const iterable = open('/api', request.endpoint, request.payload, controller.signal)
      streams.set(request.id, { controller, iterator: iterable[Symbol.asyncIterator]() })
      return Response.json({})
    }
    case 'stream-next': {
      const stream = streams.get(request.id)
      if (stream === undefined) throw new Error(`viewer relay: no open read ${String(request.id)}`)
      const step = await stream.iterator.next()
      if (step.done === true) {
        streams.delete(request.id)
        return Response.json({ end: true } satisfies ViewerStreamValue)
      }
      return Response.json({ value: step.value } satisfies ViewerStreamValue)
    }
    case 'stream-cancel': {
      const stream = streams.get(request.id)
      streams.delete(request.id)
      if (stream !== undefined) await closeRead(stream)
      return Response.json({})
    }
    case 'asset':
      // The assembled page boots in-process; it reads no served-page resource through the channel.
      throw new Error(`viewer relay: unexpected page asset read ${request.path}`)
    default: {
      const unreachable: never = request
      throw new Error(`viewer relay: unknown read ${JSON.stringify(unreachable)}`)
    }
  }
}

/**
 * Install the stand-in Relay as the page's \`fetch\`, so the assembled viewer page reads a scripted
 * share through its own carrier instead of a fixture carried inside the page.
 *
 * @param options - Scripted owner and the answers for the page's other requests.
 * @returns Async disposer closing Owner streams and restoring this fixture's fetch and font globals.
 */
export function installViewerRelay(options: ViewerRelayOptions = {}): () => Promise<void> {
  const { owner } = options
  const streams = new Map<number, OpenRead>()
  const pending = new Set<Promise<Response>>()
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  const fontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts')
  const ownsFonts = document.fonts === undefined
  if (ownsFonts) Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() })
  let disposed = false
  const fetch = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (!url.includes(READ_CHANNEL)) {
      if (options.other === undefined) throw new Error(`viewer relay: unexpected request ${url}`)
      return await options.other(url)
    }
    if (owner === undefined) throw new Error(`viewer relay: no scripted owner for ${url}`)
    const request = JSON.parse(typeof init?.body === 'string' ? init.body : '') as ViewerRequest
    if (disposed) throw new Error('viewer relay: request after disposal')
    const answer = answerRead(owner, streams, request)
    pending.add(answer)
    try { return await answer } finally { pending.delete(answer) }
  })
  vi.stubGlobal('fetch', fetch)
  return async () => {
    disposed = true
    await Promise.all([...streams.values()].map(closeRead))
    await Promise.all([...pending])
    streams.clear()
    if (fetchDescriptor === undefined) Reflect.deleteProperty(globalThis, 'fetch')
    else Object.defineProperty(globalThis, 'fetch', fetchDescriptor)
    if (ownsFonts) {
      if (fontsDescriptor === undefined) Reflect.deleteProperty(document, 'fonts')
      else Object.defineProperty(document, 'fonts', fontsDescriptor)
    }
  }
}
