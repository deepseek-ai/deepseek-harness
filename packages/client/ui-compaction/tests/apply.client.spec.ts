import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionEventEntry } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'

const sessionId = brandString<SessionId>('session/1')
const address = { kind: 'session' as const, sessionId }
const signal = new AbortController().signal
function history(data: SessionEventEntry['event']['data'], type = 'compaction/summary', seq = 7) {
  const records: SessionEventEntry[] = [{ type: 'event', event: { type, seq, time: 100, data } }]
  return { ok: true as const, value: { cursor: seq, records, hasMore: true } }
}

async function boot() {
  const ctx = new Context()
  const events = vi.fn<Context['remote']['session']['events']>(async () => history({
    summary: [{ type: 'text', text: '# A' }, { type: 'image' }, { type: 'text', text: ' summary' }],
  }))
  const openContent = vi.fn<Context['sidebarRight']['openContent']>(() => true)
  ctx.provide('locale', { bind: () => (key: string) => key, register: () => () => {} } as never)
  ctx.provide('remote', { session: { events } } as never)
  ctx.provide('remote.session', { events } as never)
  ctx.provide('sidebarRight', { openContent } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  onTestFinished(async () => { await fiber.dispose() })
  await fiber.await()
  expect(ctx.get('compactionPreviews')).toBeUndefined()
  const withdraw = ctx.provide('documentPreviews', {} as never)
  await vi.waitFor(() => { expect(ctx.get('compactionPreviews')).toBeDefined() })
  return { ctx, preview: ctx.compactionPreviews, events, openContent, withdraw }
}

it('opens the exact event with a repeatable key scoped to its Session', async () => {
  const { preview, events, openContent } = await boot()
  const child = { kind: 'subagent' as const, parentSessionId: sessionId, childSessionId: sessionId, mode: 'continuable' as const }
  for (const target of [address, address, child]) {
    expect(await preview.open(target, 7, signal)).toBeNull()
    expect(events).toHaveBeenLastCalledWith({ address: target, throughSeq: 7, maxMessages: 1 }, expect.any(AbortSignal))
    expect(openContent).toHaveBeenLastCalledWith({ mediaType: 'text/markdown', text: '# A summary' },
      expect.objectContaining({ title: 'preview.title' }))
  }
  const keys = openContent.mock.calls.map(([, options]) => options.key)
  expect(keys[0]).toEqual(expect.any(String))
  expect(keys[0]).toBe(keys[1])
  expect(keys[1]).not.toBe(keys[2])
})

it('reports missing or malformed history and failed reads on the requesting row', async () => {
  const { preview, events, openContent } = await boot()
  for (const result of [history({}, 'other'), history({}, undefined, 8), history(null), history({}),
    history({ summary: [null] }), history({ summary: [{}] }), history({ summary: [{ type: 'text', text: 5 }] }),
    history({ summary: [{ type: 'text', text: ' ' }] })]) {
    events.mockResolvedValueOnce(result)
    expect(await preview.open(address, 7, signal)).toBe('preview.notFound')
  }
  events.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
  expect(await preview.open(address, 7, signal)).toBe('preview.readFailed')
  events.mockRejectedValueOnce(new Error('offline'))
  expect(await preview.open(address, 7, signal)).toBe('preview.readFailed')
  expect(openContent).not.toHaveBeenCalled()
  openContent.mockReturnValueOnce(false)
  expect(await preview.open(address, 7, signal)).toBe('preview.notFound')
})

it('suppresses navigation and read errors after row cancellation or plugin disposal', async () => {
  const { preview, events, openContent, ctx, withdraw } = await boot()
  expect(await preview.open(address, 7, AbortSignal.abort())).toBeNull()
  expect(events).not.toHaveBeenCalled()
  const row = new AbortController()
  events.mockImplementationOnce(async () => { row.abort(); throw new Error('cancelled') })
  expect(await preview.open(address, 7, row.signal)).toBeNull()
  events.mockImplementationOnce(async () => {
    withdraw()
    await vi.waitFor(() => { expect(ctx.get('compactionPreviews')).toBeUndefined() })
    return history({})
  })
  expect(await preview.open(address, 7, signal)).toBeNull()
  expect(openContent).not.toHaveBeenCalled()
})

it('loads the host entry without browser services', () => { expect(() => { hostApply() }).not.toThrow() })
