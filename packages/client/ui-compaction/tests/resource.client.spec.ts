/**
 * The `compaction` provider over a recorded Session Remote face: address
 * decoding, the single bounded history read, checkpoint recognition, failure
 * frames, cancellation, and the block-to-Markdown conversion.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionAddress, SessionEventEntry, SessionEventsPage } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { checkpointMarkdown, readCheckpoint, type PlaceholderKind } from '../src/client/resource.ts'

type SessionRemote = Parameters<typeof readCheckpoint>[0]

const label = (kind: PlaceholderKind): string => `label:${kind}`
const source = { kind: 'compact-checkpoint', compactionId: 'compaction-1' }

function event(seq: number, type: string, data: SessionEventEntry['event']['data']): SessionEventEntry {
  return { type: 'event', event: { type, seq, time: 1, data } }
}

const checkpoint = event(42, 'user/message', {
  id: 'message-1', role: 'user', source,
  content: [
    { type: 'text', text: 'Preamble\n\n<compacted-summary>' },
    { type: 'text', text: '# Summary' },
    { type: 'text', text: '</compacted-summary>' },
  ],
})
const previous = event(40, 'assistant/message', { id: 'message-0', role: 'assistant', content: [] })
const markdown = 'Preamble\n\n<compacted-summary># Summary</compacted-summary>'

function setup(records: SessionEventsPage['records']) {
  const events = vi.fn<SessionRemote['events']>(async () => ({ ok: true, value: { cursor: 42, records, hasMore: true } }))
  return { provider: (session: SessionAddress, signal: AbortSignal) => readCheckpoint({ events }, session, 42, label, signal), events }
}

async function read(provider: ReturnType<typeof setup>['provider'], session: SessionAddress, signal = new AbortController().signal) {
  const result = await provider(session, signal)
  return result === undefined ? [] : [result]
}

const session: SessionAddress = { kind: 'session', sessionId: brandString<SessionId>('session-1') }

describe('compaction checkpoint resource', () => {
  it('reads an ordinary Session checkpoint through one events page cut at its seq', async () => {
    const { provider, events } = setup([previous, checkpoint])
    expect(await read(provider, session)).toEqual([
      { ok: true, value: { mediaType: 'text/markdown', text: markdown } },
    ])
    expect(events).toHaveBeenCalledOnce()
    expect(events).toHaveBeenCalledWith(
      { address: { kind: 'session', sessionId: 'session-1' }, throughSeq: 42, maxMessages: 1 },
      expect.any(AbortSignal),
    )
  })

  it('passes the decoded subagent address to the Remote face', async () => {
    const { provider, events } = setup([checkpoint])
    const url: SessionAddress = { kind: 'subagent', parentSessionId: brandString<SessionId>('parent/1'), childSessionId: brandString<SessionId>('child'), mode: 'continuable' }
    expect(await read(provider, url)).toMatchObject([{ ok: true }])
    expect(events).toHaveBeenCalledWith(
      {
        address: { kind: 'subagent', parentSessionId: 'parent/1', childSessionId: 'child', mode: 'continuable' },
        throughSeq: 42,
        maxMessages: 1,
      },
      expect.any(AbortSignal),
    )
  })

  it('reports a seq absent from the page as not found', async () => {
    const { provider } = setup([previous])
    expect(await read(provider, session)).toMatchObject([
      { ok: false, error: { code: 'compaction/not-found' } },
    ])
  })

  it.each([
    ['another event type', event(42, 'compaction/summary', { summary: [] })],
    ['an ordinary user message', event(42, 'user/message', { source: { kind: 'user' }, content: [] })],
    ['message data that is not an object', event(42, 'user/message', 'text')],
    ['a message without a source object', event(42, 'user/message', { source: 'compact-checkpoint', content: [] })],
    ['a source without a string kind', event(42, 'user/message', { source: { kind: 1 }, content: [] })],
    ['checkpoint content that is not an array', event(42, 'user/message', { source, content: 'text' })],
  ])('reports %s at the seq as not found', async (_name, entry) => {
    const { provider } = setup([entry])
    expect(await read(provider, session)).toMatchObject([
      { ok: false, error: { code: 'compaction/not-found' } },
    ])
  })

  it('forwards a Remote failure frame unchanged', async () => {
    const { provider, events } = setup([])
    const error = new RemoteError('gateway/bad-request', 'history cut exceeds the log', {})
    events.mockResolvedValueOnce({ ok: false, error })
    expect(await read(provider, session)).toEqual([{ ok: false, error }])
  })

  it('reports a thrown RemoteError with its own code', async () => {
    const { provider, events } = setup([])
    const error = new RemoteError('gateway/internal', 'connection lost', {})
    events.mockRejectedValueOnce(error)
    expect(await read(provider, session)).toMatchObject([
      { ok: false, error: { code: 'gateway/internal' } },
    ])
  })

  it.each([
    ['an Error', new Error('connection lost'), 'connection lost'],
    ['a non-Error value', 'socket closed', 'socket closed'],
  ])('reports a thrown %s as a read failure', async (_name, thrown, message) => {
    const { provider, events } = setup([])
    events.mockRejectedValueOnce(thrown)
    expect(await read(provider, session)).toMatchObject([
      { ok: false, error: { code: 'compaction/read-failed', message } },
    ])
  })

  it('publishes nothing when the signal is already aborted', async () => {
    const { provider, events } = setup([checkpoint])
    const controller = new AbortController()
    controller.abort()
    expect(await read(provider, session, controller.signal)).toEqual([])
    expect(events).not.toHaveBeenCalled()
  })

  it.each([
    ['resolves', (events: ReturnType<typeof setup>['events'], controller: AbortController) => {
      events.mockImplementationOnce(async () => {
        controller.abort()
        return { ok: true, value: { cursor: 42, records: [checkpoint], hasMore: false } }
      })
    }],
    ['throws', (events: ReturnType<typeof setup>['events'], controller: AbortController) => {
      events.mockImplementationOnce(async () => {
        controller.abort()
        throw new Error('aborted')
      })
    }],
  ])('publishes nothing when the read is aborted before it %s', async (_name, arrange) => {
    const { provider, events } = setup([])
    const controller = new AbortController()
    arrange(events, controller)
    expect(await read(provider, session, controller.signal)).toEqual([])
  })
})

describe('checkpoint Markdown', () => {
  it('concatenates text blocks with no separator', () => {
    expect(checkpointMarkdown([{ type: 'text', text: 'a\n' }, { type: 'text', text: 'b' }, { type: 'text', text: '' }], label)).toBe('a\nb')
  })

  it('puts each non-text block in its own paragraph as an emphasized localized label', () => {
    expect(checkpointMarkdown([
      { type: 'text', text: 'before' },
      { type: 'image', attachment: { attachmentId: 'sha256:0' } },
      { type: 'file', attachment: { attachmentId: 'sha256:1' } },
      { type: 'tool-call', id: 'call', name: 'read', arguments: '{}' },
      { type: 'text', text: 7 },
      'stray',
      { type: 'text', text: 'after' },
    ], label)).toBe('before\n\n*[label:image]*\n\n*[label:file]*\n\n*[label:other]*\n\n*[label:other]*\n\n*[label:other]*\n\nafter')
  })

  it('starts with a label when the first block is not text', () => {
    expect(checkpointMarkdown([{ type: 'image' }, { type: 'text', text: 'caption' }], label)).toBe('*[label:image]*\n\ncaption')
  })
})
