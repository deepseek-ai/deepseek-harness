/**
 * The viewer keeps the normal session navigation, so the list it reads must already be scoped to the
 * shared Session: another Session listed there would expose a private conversation the share does
 * not cover. The Owner's Session controller lists, and its Gateway admits, only what the reader's own
 * Peer may see, so every read reaches the Owner as that reader.
 */

import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createViewerReadService } from '../src/host/viewer-read.ts'
import { READER, readerConnection } from './viewer-read-peers.ts'

/** The Gateway's refusal of a call the reader's Peer may not make. */
const denied = {
  ok: false,
  error: { code: 'remote-access/denied', message: 'remote access: session/page: access denied (liveshare/read-only)',
    details: { action: 'session/page', reason: 'liveshare/read-only' } },
}

/** An Owner that lists only the shared Session and refuses a page of any other. */
function ownerFixture() {
  const seen: { readonly path: string; readonly peer: PeerScope }[] = []
  const readers = readerConnection(async (request, peer) => {
    const path = new URL(request.url).pathname
    seen.push({ path, peer })
    const result = path === '/api/session/list'
      ? { ok: true, value: { items: [{ sessionId: 'shared-session', updatedAt: 1, running: true, blank: false }], hasMore: false } }
      : denied
    return Response.json({ type: 'server-response', rpcId: 'rpc', result })
  })
  const read = createViewerReadService({ connection: readers.connection, sharedSessionId: () => 'shared-session' })
  onTestFinished(async () => {
    read.close()
    await readers.dispose()
  })
  return { read, seen }
}

describe('Liveshare viewer session list', () => {
  it('[P0] reads the session list as the reader and relays the rows the Owner listed for it', async () => {
    const { read, seen } = ownerFixture()

    const answer = await read.answer('share-1', { op: 'call', path: '/api/session/list', body: { _request: {} } }, READER)

    expect(answer.status).toBe(200)
    const items = (answer.body as {
      result: { value: { items: Array<{ sessionId: string }> } }
    }).result.value.items
    expect(items.map(item => item.sessionId)).toEqual(['shared-session'])
    expect(seen.map(({ path, peer }) => ({ path, principal: peer.principal }))).toEqual([{
      path: '/api/session/list',
      principal: { kind: 'share-viewer', shareId: 'share-1', actor: READER },
    }])
  })

  it('[P1] relays the Owner\u2019s refusal of a read that names another Session', async () => {
    const { read, seen } = ownerFixture()

    const answer = await read.answer('share-1', {
      op: 'call',
      path: '/api/session/page',
      body: { type: 'client-request', rpcId: 'private-page', method: 'session/page',
        payload: { args: { request: { address: { kind: 'session', sessionId: 'private-session' }, throughSeq: 0 } } } },
    }, READER)

    // The read speaks for the reader's Peer, so the Owner's Gateway decides it as that reader.
    expect(seen.map(({ peer }) => peer.principal)).toEqual([{ kind: 'share-viewer', shareId: 'share-1', actor: READER }])
    expect(answer).toEqual({ status: 200, body: { type: 'server-response', rpcId: 'rpc', result: denied } })
  })
})
