import { describe, expect, it, vi } from 'vitest'
import { apply as hostApply } from '../src/index.ts'
import type { SessionEventEntry } from '@deepseek-ai/dsh-api-session-controller/types'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { summaryAddress, parseSummaryAddress, summaryDocument } from '../src/client/summary.ts'
import { summaryResourceProvider } from '../src/client/resource.ts'

const address = 'dsh-resource://compaction/session/4'
const entry: SessionEventEntry = { type: 'event', event: {
  type: 'compaction/summary', seq: 4, time: 100,
  data: { summary: [{ type: 'text', text: '# Saved summary\n\nKeep **this**.' }] },
} }
type Remote = Parameters<typeof summaryResourceProvider>[0]
function setup(records: readonly SessionEventEntry[] = [entry]) {
  const events = vi.fn<Remote['events']>(async () => ({ ok: true, value: { cursor: 4, records, hasMore: true } }))
  return { events, provider: summaryResourceProvider({ events }) }
}
async function read(provider: ReturnType<typeof summaryResourceProvider>, url = address, signal = new AbortController().signal) {
  const frames = []
  for await (const frame of provider.open(url, { signal })) frames.push(frame)
  return frames
}

describe('compaction summary resource', () => {
  it('recovers the exact historical event on a fresh provider without opening the chat window', async () => {
    for (let refresh = 0; refresh < 2; refresh++) {
      const b = setup()
      expect(await read(b.provider)).toEqual([{ ok: true, value: { markdown: '# Saved summary\n\nKeep **this**.' } }])
      expect(b.events).toHaveBeenCalledExactlyOnceWith({
        address: { kind: 'session', sessionId: 'session' }, throughSeq: 4, maxMessages: 1,
      }, expect.any(AbortSignal))
    }
  })
  it.each(['one-shot', 'continuable', 'unknown'] as const)('retains parent authorization for %s children', async (mode) => {
    const b = setup()
    await read(b.provider, `dsh-resource://compaction/subagent/parent/child/${mode}/4`)
    expect(b.events).toHaveBeenCalledWith({
      address: { kind: 'subagent', parentSessionId: 'parent', childSessionId: 'child', mode }, throughSeq: 4, maxMessages: 1,
    }, expect.any(AbortSignal))
  })
  it('round-trips encoded identities and distinguishes multiple summaries and Sessions', () => {
    const target = { session: { kind: 'session' as const, sessionId: 's / 中文' as SessionId }, seq: SessionSeq(4) }
    expect(parseSummaryAddress(summaryAddress(target))).toEqual(target)
    expect(summaryAddress({ ...target, seq: SessionSeq(5) })).not.toBe(summaryAddress(target))
    expect(summaryAddress({ ...target, session: { kind: 'session', sessionId: 'other' as SessionId } })).not.toBe(summaryAddress(target))
  })
  it.each(['', 'dsh-resource://compaction/s/%', 'dsh-resource://compaction/s/-1', 'dsh-resource://compaction/s/1.2',
    'dsh-resource://compaction/s/01', 'dsh-resource://compaction/s/9007199254740992', 'dsh-resource://compaction//4',
    'dsh-resource://compaction/s/4?text=x', 'dsh-resource://compaction/subagent/p/c/bad/4'])('rejects invalid saved address %s', async (url) => {
    const b = setup()
    expect(await read(b.provider, url)).toMatchObject([{ ok: false, error: { code: 'compaction-summary/invalid-address' } }])
    expect(b.events).not.toHaveBeenCalled()
  })
  it('does not replace a missing summary with a different event', async () => {
    expect(await read(setup([{ ...entry, event: { ...entry.event, seq: 3 } }]).provider))
      .toMatchObject([{ ok: false, error: { code: 'compaction-summary/not-found' } }])
  })
  it.each([null, {}, { summary: [] }, { summary: [{ type: 'text', text: 3 }] }, { summary: [null] }, { summary: [{ type: 'text', text: ' ' }] }])('rejects malformed summary data %j', (data) => {
    expect(summaryDocument({ type: 'compaction/summary', data })).toBeUndefined()
  })
  it('preserves remote failures and contains transport errors', async () => {
    const b = setup()
    const error = new RemoteError('compaction-summary/read-failed', 'offline', {})
    b.events.mockResolvedValueOnce({ ok: false, error })
    expect(await read(b.provider)).toEqual([{ ok: false, error }])
    b.events.mockRejectedValueOnce(new Error('network'))
    expect(await read(b.provider)).toMatchObject([{ ok: false, error: { code: 'compaction-summary/read-failed' } }])
  })
  it('does not publish when closed before or during the history read', async () => {
    const b = setup()
    const controller = new AbortController()
    b.events.mockImplementationOnce(async () => {
      controller.abort()
      return { ok: true, value: { cursor: 4, records: [entry], hasMore: false } }
    })
    expect(await read(b.provider, address, controller.signal)).toEqual([])
    b.events.mockClear()
    expect(await read(b.provider, address, controller.signal)).toEqual([])
    expect(b.events).not.toHaveBeenCalled()
  })
})

it('extracts text around non-text blocks and rejects unrelated events', () => {
  expect(summaryDocument({ type: 'other', data: {} })).toBeUndefined()
  expect(summaryDocument({ type: 'compaction/summary', data: { summary: [{ type: 'image' }, { type: 'text', text: 'kept' }] } }))
    .toEqual({ markdown: 'kept' })
  expect(summaryDocument({ type: 'compaction/summary', data: { summary: [{}] } })).toBeUndefined()
  expect(parseSummaryAddress('dsh-resource://compaction/wrong/a/b/continuable/4')).toBeUndefined()
  expect(parseSummaryAddress('dsh-resource://compaction/subagent/p/c/continuable/0')?.seq).toBe(0)
  const child = { session: { kind: 'subagent' as const, parentSessionId: 'p' as SessionId, childSessionId: 'c' as SessionId, mode: 'continuable' as const }, seq: SessionSeq(4) }
  expect(parseSummaryAddress(summaryAddress(child))).toEqual(child)
})

it('preserves thrown remote failures and ignores errors after cancellation', async () => {
  const b = setup()
  const error = new RemoteError('compaction-summary/read-failed', 'offline', {})
  b.events.mockRejectedValueOnce(error)
  expect(await read(b.provider)).toEqual([{ ok: false, error }])
  const controller = new AbortController()
  b.events.mockImplementationOnce(async () => { controller.abort(); throw new Error('cancelled') })
  expect(await read(b.provider, address, controller.signal)).toEqual([])
})

it('loads the browser-only plugin host entry without requiring client services', () => {
  expect(() => { hostApply() }).not.toThrow()
})
