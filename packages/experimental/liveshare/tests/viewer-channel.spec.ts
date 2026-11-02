/** The viewer channel's own decoding: which forwarded bodies name a request, and which do not. */

import { describe, expect, it } from 'vitest'
import { parseViewerRequest, viewerRequestTarget } from '../src/viewer-channel.ts'

describe('viewer request decoding', () => {
  it('refuses every body that is not one request record', () => {
    for (const refused of [undefined, null, 'call', 7, [], ['call']]) {
      expect(parseViewerRequest(refused), String(refused)).toBeUndefined()
    }
  })

  it('reads one unary call only when it names an absolute path and carries a body', () => {
    expect(parseViewerRequest({ op: 'call', path: '/api/session/list', body: { args: {} } }))
      .toEqual({ op: 'call', path: '/api/session/list', body: { args: {} } })
    expect(parseViewerRequest({ op: 'call', path: 'api/session/list', body: {} })).toBeUndefined()
    expect(parseViewerRequest({ op: 'call', path: '/api/session/list' })).toBeUndefined()
    expect(parseViewerRequest({ op: 'call', path: 3, body: {} })).toBeUndefined()
  })

  it('reads a stream open only with a positive safe-integer id, an endpoint, and a payload', () => {
    expect(parseViewerRequest({ op: 'stream-open', id: 4, endpoint: 'session/events', payload: { args: {} } }))
      .toEqual({ op: 'stream-open', id: 4, endpoint: 'session/events', payload: { args: {} } })
    expect(parseViewerRequest({ op: 'stream-open', id: 0, endpoint: 'session/events', payload: {} })).toBeUndefined()
    expect(parseViewerRequest({ op: 'stream-open', id: 4, endpoint: '', payload: {} })).toBeUndefined()
    expect(parseViewerRequest({ op: 'stream-open', id: 4, endpoint: 'session/events' })).toBeUndefined()
  })

  it('reads the next poll and the cancel only with a stream id it minted', () => {
    expect(parseViewerRequest({ op: 'stream-next', id: 4 })).toEqual({ op: 'stream-next', id: 4 })
    expect(parseViewerRequest({ op: 'stream-next', id: -1 })).toBeUndefined()
    expect(parseViewerRequest({ op: 'stream-cancel', id: 4 })).toEqual({ op: 'stream-cancel', id: 4 })
    expect(parseViewerRequest({ op: 'stream-cancel', id: 1.5 })).toBeUndefined()
  })

  it('reads an asset read from its path alone, and refuses a path that is not text', () => {
    expect(parseViewerRequest({ op: 'asset', path: 'assets/a.js' })).toEqual({ op: 'asset', path: 'assets/a.js' })
    expect(parseViewerRequest({ op: 'asset', path: '' })).toEqual({ op: 'asset', path: '' })
    expect(parseViewerRequest({ op: 'asset' })).toBeUndefined()
  })

  it('refuses an operation this build does not serve', () => {
    expect(parseViewerRequest({ op: 'subscribe', path: '/api/session/list', body: {} })).toBeUndefined()
    expect(parseViewerRequest({ path: '/api/session/list', body: {} })).toBeUndefined()
  })
})

describe('viewer request target', () => {
  it('unwraps a stream payload that carries its request beside the envelope args', () => {
    expect(viewerRequestTarget({ payload: { args: { request: { sessionId: 'source' } } } }))
      .toEqual({ sessionId: 'source' })
    expect(viewerRequestTarget({ args: { request: { sessionId: 'source' } } })).toEqual({ sessionId: 'source' })
  })

  it('answers the request record itself when there is no nested request to unwrap', () => {
    // Neither a unary envelope nor a stream payload may state `args` at all.
    expect(viewerRequestTarget({ op: 'call', path: '/api/session/list' }))
      .toEqual({ op: 'call', path: '/api/session/list' })
    expect(viewerRequestTarget({ args: {} })).toEqual({ args: {} })
    // `args.request` that is not a record names no request, so the payload is the request.
    expect(viewerRequestTarget({ payload: { args: { request: 'session/events' } } }))
      .toEqual({ args: { request: 'session/events' } })
  })

  it('reads nothing from a value that is not a record', () => {
    for (const refused of [undefined, null, 'session/events', 0, []]) {
      expect(viewerRequestTarget(refused), String(refused)).toBeUndefined()
    }
  })
})
