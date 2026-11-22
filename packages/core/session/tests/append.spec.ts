import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, type SessionId, SessionSeq, type SessionEventInput } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'

function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('multiple Session appends', () => {
  it('rejects sparse arrays before changing the log or surface', () => {
    const session = Session.create(brandString<SessionId>('sparse-append'))
    const inputs = new Array<SessionEventInput>(3)
    inputs[0] = ['turn/start', { turn: 1 }]
    inputs[2] = ['user/message', message('last'), { surfaceOp: 'append' }]
    expect(() => session.append(inputs)).toThrow(/empty member at index 1/)
    expect(session.seq).toBe(0)
    expect(session.surface.nodes).toEqual([])
  })

  it('reads only surface metadata from event options', () => {
    const session = Session.create(brandString<SessionId>('options-append'))
    const old = session.append('user/message', message('old'), { surfaceOp: 'append' })
    const next = message('new')
    const events = session.append([['user/message', next, old]])
    expect(events[0]?.data).toEqual(next)
    expect(session.deriveMessages()).toEqual([old.data, next])
  })

  it('leaves the log unchanged for empty input and accepts a single array member', () => {
    const session = Session.create(brandString<SessionId>('empty-append'))
    expect(session.append([])).toEqual([])
    expect(session.seq).toBe(0)
    const events = session.append([['turn/start', { turn: 1 }]])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'turn/start', seq: 0, data: { turn: 1 } })
  })

  it('accepts both call forms through an append wrapper', () => {
    const session = Session.create(brandString<SessionId>('wrapped-append'))
    const append = new Proxy(session.append.bind(session), {
      apply: (target, receiver, args): unknown => Reflect.apply(target, receiver, args),
    })
    session.append = append
    expect(session.append('turn/start', { turn: 1 }).seq).toBe(0)
    expect(session.append([['step/start', { turn: 1, step: 1 }]])).toHaveLength(1)
  })

  it('publishes each member after the complete log and surface are committed', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(brandString<SessionId>('observed-append'))
    const observed: number[] = []
    ctx.on('session/event', (current, event) => {
      if (current !== session) return
      expect(current.currentBatchPublication).toBe(event)
      expect(current.seq).toBe(2)
      expect(current.surface.nodes).toEqual([1])
      expect(current.deriveMessages()).toEqual([messageValue])
      observed.push(event.seq)
    })
    const messageValue = message('visible')
    session.append([
      ['turn/start', { turn: 1 }],
      ['user/message', messageValue, { surfaceOp: 'append' }],
    ])
    expect(observed).toEqual([0, 1])
    expect(session.currentBatchPublication).toBeUndefined()
  })

  it('replaces an earlier member in the same append', () => {
    const session = Session.create(brandString<SessionId>('replace-append'))
    const nodes = session.surface.nodes
    const replacement = message('replacement')
    session.append([
      ['user/message', message('original'), { surfaceOp: 'append' }],
      ['user/message', replacement, { surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(0) }, sourceEventSeqs: [SessionSeq(0)] }],
    ])
    expect(nodes).toEqual([1])
    expect(session.deriveMessages()).toEqual([replacement])
  })

  it('rejects non-JSON data before publishing any member', () => {
    const session = Session.create(brandString<SessionId>('non-json-append'))
    expect(() => session.append([
      ['turn/start', { turn: 1 }],
      ['turn/start', { turn: Number.NaN }],
    ])).toThrow('session batch member 1 ("turn/start") carries non-JSON-serializable data')
    expect(session.seq).toBe(0)
  })

  it('assigns consecutive sequences after a candidate getter appends an event', () => {
    const session = Session.create(brandString<SessionId>('getter-append'))
    const events = session.append([
      ['turn/start', {
        get turn() {
          session.append('request/context', { provider: 'mock', model: 'mock' })
          return 1
        },
      }],
      ['step/start', { turn: 1, step: 1 }],
    ])
    expect(events.map(event => event.seq)).toEqual([1, 2])
    expect(session.snapshotEvents().map(event => event.type)).toEqual(['request/context', 'turn/start', 'step/start'])
  })

  it('contains a reentrant append while publishing the remaining members', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(brandString<SessionId>('reentrant-batch'))
    const observed: number[] = []
    const warnings: string[] = []
    ctx.logger.warn = (warning: unknown) => { warnings.push(String(warning)) }
    ctx.on('session/event', (current, event) => {
      if (current === session && event.seq === 0) {
        session.append('request/context', { provider: 'mock', model: 'mock' })
      }
    })
    ctx.on('session/event', (current, event) => {
      if (current === session) observed.push(event.seq)
    })
    session.append([
      ['turn/start', { turn: 1 }],
      ['step/start', { turn: 1, step: 1 }],
    ])
    expect(session.seq).toBe(2)
    expect(observed).toEqual([0, 1])
    expect(warnings).toEqual([expect.stringContaining('session append cannot reenter')])
  })

  it('detaches only after every member has been observed', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.prepare(brandString<SessionId>('detached-append'))
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    const observed: number[] = []
    ctx.on('session/event', (current, event) => {
      expect(ctx.sessions.get(current.id)).toBe(current)
      detach()
      observed.push(event.seq)
    })
    session.append([
      ['turn/start', { turn: 1 }],
      ['step/start', { turn: 1, step: 1 }],
    ])
    expect(observed).toEqual([0, 1])
    expect(ctx.sessions.get(session.id)).toBeUndefined()
  })

  it('folds preceding single appends before admitting an array', () => {
    const session = Session.create(brandString<SessionId>('mixed-append'))
    session.append('user/message', message('before'), { surfaceOp: 'append' })
    expect(session.surface.contentGeneration).toBe(0)
    session.append([['user/message', message('after'), { surfaceOp: 'append' }]])
    expect(session.surface.nodes).toEqual([0, 1])
    expect(session.surface.replaceGeneration).toBe(0)
  })

  it('publishes a complete group with its final surface', () => {
    const session = Session.create(brandString<SessionId>('batch'))
    const events = session.append([
      ['turn/start', { turn: 1 }],
      ['user/message', message('hello'), { surfaceOp: 'append' }],
    ])
    expect(events.map(event => event.seq)).toEqual([0, 1])
    expect(session.surface.nodes).toEqual([1])
    expect(session.deriveMessages()).toEqual([events[1]?.data])
  })

  it('retains the committed log and surface when a later candidate is invalid', () => {
    const session = Session.create(brandString<SessionId>('rejected-batch'))
    session.append('user/message', message('before'), { surfaceOp: 'append' })
    const before = session.deriveMessages()
    expect(() => session.append([
      ['user/message', message('candidate'), { surfaceOp: 'append' }],
      ['user/message', message('invalid'), { surfaceOp: { op: 'replace', startSeq: SessionSeq(40), endSeq: SessionSeq(41) } }],
    ])).toThrow()
    expect(session.seq).toBe(1)
    expect(session.deriveMessages()).toEqual(before)
    expect(session.surface.nodes).toEqual([0])
  })

  it('rejects the entire group when dispatch validation vetoes its last event', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(brandString<SessionId>('veto-batch'))
    const observed: number[] = []
    ctx.on('session/event', (current, event) => {
      if (current === session) observed.push(event.seq)
    })
    const stop = ctx.on('internal/dispatch', (_mode, name, args) => {
      if (name !== 'session/event') return
      const [current, event] = args as [Session, { seq: number }]
      if (current === session && event.seq === 1) throw new Error('veto final event')
    })
    expect(() => session.append([
      ['turn/start', { turn: 1 }],
      ['user/message', message('candidate'), { surfaceOp: 'append' }],
    ])).toThrow('veto final event')
    expect(session.seq).toBe(0)
    expect(session.surface.nodes).toEqual([])
    expect(observed).toEqual([])
    stop()
    session.append('turn/start', { turn: 1 })
    expect(observed).toEqual([0])
  })

})
