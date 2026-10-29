import { Context } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HistoryController } from '../src/history/controller.ts'
import { WebController } from '../src/web/controller.ts'
import { installSessionReadTestServices } from './test-remote.ts'

const roots: Context[] = []
const aborters: AbortController[] = []
afterEach(async () => {
  for (const abort of aborters.splice(0)) abort.abort()
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
})
async function fixture() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  installSessionReadTestServices(ctx)
  const history = new HistoryController(ctx)
  const web = new WebController(ctx, history, (observation) => { observation[Symbol.dispose]() })
  const session = ctx.sessions.create(SessionId('history-target'), { meta: { cwd: '/history-test' } })
  const abort = new AbortController()
  aborters.push(abort)
  const address = { kind: 'session' as const, sessionId: session.id }
  return { ctx, history, web, session, abort, address }
}

describe('HistoryController passive reads', () => {
  it('subscribes without reading an Observation and emits later durable events', async () => {
    const f = await fixture()
    const observe = vi.spyOn(f.ctx.sessionQuery, 'observeSession')
    const stream = f.history.observeEvent({ address: f.address }, f.abort.signal)[Symbol.asyncIterator]()
    expect(await stream.next()).toEqual({ done: false, value: { type: 'ready' } })
    expect(observe).not.toHaveBeenCalled()
    f.session.append('turn/start', { turn: 1 })
    expect(await stream.next()).toMatchObject({ value: { type: 'event', event: { seq: 0 } } })
    f.abort.abort()
    expect(await stream.next()).toMatchObject({ done: true })
  })

  it('subscribes to sparse projection changes without an Observation', async () => {
    const f = await fixture()
    const observe = vi.spyOn(f.ctx.sessionQuery, 'observeSession')
    let receive: Parameters<typeof f.ctx.sessionProjections.onChanged>[0] | undefined
    const dispose = vi.fn()
    vi.spyOn(f.ctx.sessionProjections, 'onChanged').mockImplementation((callback) => {
      receive = callback
      return dispose
    })
    const stream = f.history.observeProjections({ sessionId: f.session.id }, f.abort.signal)[Symbol.asyncIterator]()
    expect(await stream.next()).toMatchObject({ value: { type: 'ready' } })
    receive?.(f.session, 'title', 'new title', SessionSeq(0))
    expect(await stream.next()).toMatchObject({ value: { type: 'projection', key: 'title', value: 'new title', seq: 0 } })
    expect(observe).not.toHaveBeenCalled()
    f.abort.abort()
    expect(await stream.next()).toMatchObject({ done: true })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('reads newest assistant messages within the exclusive/inclusive interval and detects actual truncation', async () => {
    const f = await fixture()
    f.session.append('turn/start', { turn: 1 })
    const first = f.session.append('assistant/message', {
      turn: 1, step: 1,
      message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'first' }], source: { kind: 'model', provider: 'p', model: 'm' } }),
      stream: [],
    }, { surfaceOp: 'append' })
    const second = f.session.append('assistant/message', {
      turn: 1, step: 2,
      message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'second' }], source: { kind: 'model', provider: 'p', model: 'm' } }),
      stream: [],
    }, { surfaceOp: 'append' })
    f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const observe = vi.spyOn(f.ctx.sessionQuery, 'observeSession')
    const all = await f.history.assistantOutput(f.session.id, -1, 3, 2, f.abort.signal)
    expect(all.records.map(record => record.event.seq)).toEqual([second.seq, first.seq])
    expect(all.truncated).toBe(false)
    const limited = await f.history.assistantOutput(f.session.id, -1, 3, 1, f.abort.signal)
    expect(limited.records.map(record => record.event.seq)).toEqual([second.seq])
    expect(limited.truncated).toBe(true)
    const interval = await f.history.assistantOutput(f.session.id, first.seq, second.seq, 2, f.abort.signal)
    expect(interval.records.map(record => record.event.seq)).toEqual([second.seq])
    expect(observe).toHaveBeenCalledWith(f.session.id, { signal: f.abort.signal, projectionMode: 'none' })
    await expect(f.history.assistantOutput(f.session.id, -1, 9, 2, f.abort.signal)).rejects.toMatchObject({ code: 'gateway/internal' })
  })

  it('reads at the observed log end when throughSeq is omitted', async () => {
    const f = await fixture()
    f.session.append('turn/start', { turn: 1 })
    f.session.append('assistant/message', {
      turn: 1, step: 1,
      message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'latest' }], source: { kind: 'model', provider: 'p', model: 'm' } }),
      stream: [],
    }, { surfaceOp: 'append' })
    const page = await f.history.events({ address: f.address }, f.abort.signal)
    expect(page.cursor).toBe(f.session.seq - 1)
    expect(page.records.at(-1)?.event.seq).toBe(f.session.seq - 1)
  })

  it('keeps the append copy a model-facing replacement shadowed', async () => {
    const f = await fixture()
    f.session.append('turn/start', { turn: 1 })
    const replaced = f.session.append('assistant/message', {
      turn: 1, step: 1,
      message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'visible' }], source: { kind: 'model', provider: 'p', model: 'm' } }),
      stream: [],
    }, { surfaceOp: 'append' })
    // Compaction rewrites the model-facing surface with a replacement that shadows the original;
    // the human-readable transcript keeps the shadowed append copy.
    const replacement = f.session.append('user/message', createMessage({
      role: 'user', content: [{ type: 'text', text: 'compacted' }], source: { kind: 'user' },
    }), { surfaceOp: { op: 'replace', startSeq: replaced.seq, endSeq: replaced.seq }, sourceEventSeqs: [replaced.seq] })
    const output = await f.history.assistantOutput(f.session.id, -1, replacement.seq, 5, f.abort.signal)
    expect(output.records.map(record => record.event.seq)).toEqual([replaced.seq])
  })

  it('releases the opening Observation when activation has nothing to promote', async () => {
    const f = await fixture()
    const source = await f.ctx.sessionQuery.observeSession(f.session.id)
    const dispose = vi.fn(() => { source[Symbol.dispose]() })
    vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockResolvedValue({ ...source, [Symbol.dispose]: dispose })
    const stream = f.web.follow({ address: f.address, activate: true }, f.abort.signal)[Symbol.asyncIterator]()
    await stream.next()
    f.abort.abort()
    await stream.next()
    expect(dispose).toHaveBeenCalled()
  })

  it('releases an acquired Observation when caller cancellation wins its return', async () => {
    const f = await fixture()
    const source = await f.ctx.sessionQuery.observeSession(f.session.id)
    const dispose = vi.fn(() => { source[Symbol.dispose]() })
    vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockImplementation(async () => {
      f.abort.abort()
      return { ...source, [Symbol.dispose]: dispose }
    })
    await expect(f.history.usingObservation({ sessionId: f.session.id, projection: false }, f.abort.signal)).rejects.toBeDefined()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('maps a non-Error query cancellation to a cancelled Remote error', async () => {
    const f = await fixture()
    // A cross-realm or opaque source may reject with the code alone; the message falls back.
    vi.spyOn(f.ctx.sessionQuery, 'observeSession').mockRejectedValue({ code: 'SESSION_QUERY_ABORTED' })
    await expect(f.history.events({ address: f.address }, f.abort.signal)).rejects.toMatchObject({
      code: 'gateway/cancelled', message: 'Session read was cancelled',
    })
  })

  it('maps missing subagent Follow reads through the Address error', async () => {
    const f = await fixture()
    const stream = f.web.follow({ address: {
      kind: 'subagent', parentSessionId: f.session.id, childSessionId: SessionId('missing-child'), mode: 'continuable',
    } }, f.abort.signal)[Symbol.asyncIterator]()
    await expect(stream.next()).rejects.toMatchObject({ code: 'subagent/not-found' })
  })

  it('does not promote a live Session when activation was requested', async () => {
    const f = await fixture()
    const promote = vi.fn()
    const web = new WebController(f.ctx, f.history, promote)
    const stream = web.follow({ address: f.address, activate: true }, f.abort.signal)[Symbol.asyncIterator]()
    expect(await stream.next()).toMatchObject({ value: { type: 'snapshot' } })
    const pending = stream.next()
    f.abort.abort()
    expect(await pending).toMatchObject({ done: true })
    expect(promote).not.toHaveBeenCalled()
  })
})
