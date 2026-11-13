import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Typert from '@deepseek-ai/dsh-typert-registry'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { afterEach, expect, it, vi } from 'vitest'
import { remoteMethods, type RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import SessionStatusService from '../src/index.ts'
import { SessionReadFollower } from '../src/feed.ts'
import type { SessionReadState, SessionReadFrame } from '../src/types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'reading-test': { readonly kind: 'reading-test' }
  }
}

const roots: Context[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(before?: (ctx: Context) => void) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Projections)
  await ctx.plugin(Typert)
  await ctx.plugin(RemoteAccess)
  const stat = vi.fn(async (_id: SessionId): Promise<object | undefined> => undefined)
  ctx.provide('sessionPersistence', { stat } as never)
  const allows = vi.spyOn(ctx.remoteAccess, 'allows').mockReturnValue(true)
  before?.(ctx)
  const fiber = ctx.plugin(SessionStatusService)
  await fiber
  return { ctx, service: ctx.sessionStatus, allows, stat, fiber }
}

function end(session: Session, turn: number): readonly SessionEvent[] {
  return [session.append('turn/start', { turn }),
    session.append('turn/end', { turn, reason: { kind: 'completed' } })]
}

async function nextFrame(iterator: AsyncIterator<SessionReadFrame>): Promise<SessionReadFrame> {
  const result = await iterator.next()
  if (result.done) throw new Error('reading stream ended')
  return result.value
}

async function baseline(service: SessionStatusService): Promise<readonly SessionReadState[]> {
  const abort = new AbortController()
  const iterator = service.follow(abort.signal)[Symbol.asyncIterator]()
  try {
    const frame = await nextFrame(iterator)
    if (frame?.type !== 'baseline') throw new Error('missing reading baseline')
    return frame.items
  } finally {
    abort.abort()
    await iterator.return?.()
  }
}

it('raises no reminder for history recorded before the service started', async () => {
  const { ctx, service } = await harness((context) => {
    end(context.sessions.create(SessionId('history')), 7)
  })
  expect(await baseline(service)).toEqual([])
  end(ctx.sessions.get(SessionId('history'))!, 8)
  expect(await baseline(service)).toEqual([expect.objectContaining({ completedTurn: 8, readTurn: 0 })])
})

it('raises no reminder for a Session restored from stored history', async () => {
  const { ctx, service } = await harness()
  ctx.sessions.create(SessionId('restored'), { seed: end(Session.create(SessionId('seed')), 7) })
  expect(await baseline(service)).toEqual([])
})

it('records whether the completing turn failed', async () => {
  const { ctx, service } = await harness()
  const session = ctx.sessions.create(SessionId('failed'))
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } } })
  expect(await baseline(service)).toEqual([expect.objectContaining({ completedTurn: 1, failed: true })])
  session.append('turn/start', { turn: 2 })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  expect(await baseline(service)).toEqual([expect.objectContaining({ completedTurn: 2, failed: false })])
})

it('broadcasts explicit marks to both frontends and keeps later completions unread', async () => {
  const { ctx, service } = await harness()
  const session = ctx.sessions.create(SessionId('shared'))
  end(session, 1)
  const abort = new AbortController()
  const left = service.follow(abort.signal)[Symbol.asyncIterator]()
  const right = service.follow(abort.signal)[Symbol.asyncIterator]()
  try {
    const opening = await nextFrame(left)
    await right.next()
    if (opening?.type !== 'baseline') throw new Error('missing baseline')
    await service.mark(session.id, { type: 'read', throughTurn: opening.items[0]!.completedTurn })
    const read = { sessionId: session.id, completedTurn: 1, failed: false, readTurn: 1, manualUnread: false }
    expect(await left.next()).toMatchObject({ value: { type: 'changed', state: read } })
    expect(await right.next()).toMatchObject({ value: { type: 'changed', state: read } })
    await service.mark(session.id, { type: 'unread' })
    end(session, 2)
    await service.mark(session.id, { type: 'acknowledge', throughTurn: 1 })
    expect(await baseline(service)).toEqual([{ ...read, completedTurn: 2, manualUnread: true }])
    await service.mark(session.id, { type: 'read', throughTurn: 1 })
    expect(await baseline(service)).toEqual([{ ...read, completedTurn: 2 }])
    await service.mark(session.id, { type: 'acknowledge', throughTurn: 9 })
    await service.mark(session.id, { type: 'acknowledge', throughTurn: 0 })
    expect(await baseline(service)).toEqual([{ ...read, completedTurn: 2, readTurn: 2 }])
  } finally {
    abort.abort()
    await Promise.all([left.return?.(), right.return?.()])
  }
})

it('filters the baseline and increments by Session access and rejects missing Sessions', async () => {
  const { ctx, service, allows } = await harness()
  const visible = ctx.sessions.create(SessionId('visible'))
  const hidden = ctx.sessions.create(SessionId('hidden'))
  end(visible, 1)
  end(hidden, 1)
  await baseline(service)
  allows.mockImplementation(resource => resource.kind !== 'session' || resource.id !== hidden.id)
  expect(await baseline(service)).toEqual([expect.objectContaining({ sessionId: visible.id })])
  const marker = remoteMethods(service).find(method => method.method === 'mark')
  expect(marker?.resources).toBeUndefined()
  const abort = new AbortController()
  const iterator = service.follow(abort.signal)[Symbol.asyncIterator]()
  try {
    await nextFrame(iterator)
    const next = nextFrame(iterator)
    end(hidden, 2)
    end(visible, 2)
    expect(await next).toMatchObject({ type: 'changed', state: { sessionId: visible.id, completedTurn: 2 } })
  } finally {
    abort.abort()
    await iterator.return?.()
  }
  await expect(service.mark(SessionId('missing'), { type: 'unread' }))
    .rejects.toMatchObject({ code: 'session-status/not-found' })
})

it('marks cold history without opening it', async () => {
  const { ctx, service, stat } = await harness()
  const id = SessionId('cold')
  stat.mockResolvedValue({})
  await service.mark(id, { type: 'unread' })
  expect(ctx.sessions.get(id)).toBeUndefined()
  expect(await baseline(service)).toEqual([
    { sessionId: id, completedTurn: 0, failed: false, readTurn: 0, manualUnread: true },
  ])
})

it('closes an idle follower when its Host owner is disposed', async () => {
  const { ctx, service } = await harness()
  const iterator = service.follow(new AbortController().signal)[Symbol.asyncIterator]()
  await nextFrame(iterator)
  const pending = iterator.next()
  await ctx.fiber.dispose()
  expect(await pending).toMatchObject({ done: true })
})

it('cancels its access watcher even when a consumer pauses after the baseline', async () => {
  const { ctx, service, fiber } = await harness()
  const follow = ctx.remoteAccess.follow.bind(ctx.remoteAccess)
  let stopped = false
  vi.spyOn(ctx.remoteAccess, 'follow').mockImplementation(async function* (signal) {
    try { yield* follow(signal) } finally { stopped = true }
  })
  const iterator = service.follow(new AbortController().signal)[Symbol.asyncIterator]()
  await nextFrame(iterator)
  await fiber.dispose()
  await vi.waitFor(() => { expect(stopped).toBe(true) })
  await iterator.return?.()
})

it('ignores late updates after a follower closes and wakes a cancelled reader', async () => {
  const follower = new SessionReadFollower()
  const abort = new AbortController()
  const iterator = follower.read(abort.signal)[Symbol.asyncIterator]()
  const pending = iterator.next()
  abort.abort()
  follower.push({ type: 'changed', state: {
    sessionId: SessionId('closed'), completedTurn: 1, failed: false, readTurn: 0, manualUnread: false,
  } })
  expect(await pending).toMatchObject({ done: true })
})

it('preserves the first follower failure even when cancellation follows immediately', async () => {
  const follower = new SessionReadFollower()
  const abort = new AbortController()
  const iterator = follower.read(abort.signal)[Symbol.asyncIterator]()
  const pending = iterator.next()
  const error = new Error('failed')
  follower.close(error)
  abort.abort()
  follower.close()
  await expect(pending).rejects.toBe(error)
})

it('keeps the first completion unread after a live zero-turn Session is marked unread then read', async () => {
  const { ctx, service } = await harness()
  const session = ctx.sessions.create(SessionId('first-turn'))
  await service.mark(session.id, { type: 'unread' })
  await service.mark(session.id, { type: 'read', throughTurn: 0 })
  end(session, 1)
  expect(await baseline(service)).toEqual([expect.objectContaining({ completedTurn: 1, readTurn: 0 })])
})

it('restarts filtered followers on access changes so new grants receive a baseline', async () => {
  const { ctx, allows } = await harness()
  allows.mockRestore()
  const session = ctx.sessions.create(SessionId('new-grant'))
  end(session, 1)
  const principal = { kind: 'reading-test' } as const
  let granted = false
  ctx.remoteAccess.registerPolicy('reading-test', { bindings: () => granted ? [{
    role: { name: 'reader', resource: 'session', actions: ['sessionStatus/follow'] },
    resource: { kind: 'session', id: session.id },
  }] : [] })
  const abort = new AbortController()
  const invocation: RemoteInvocation = {
    request: { namespace: 'sessionStatus', method: 'follow', args: {} }, service: 'sessionStatus',
    peer: new Peer(ctx, { principal }), signal: abort.signal,
    uplink: <In>(): AsyncIterable<In> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
  }
  const scoped = ctx.extend({ invocation }).sessionStatus
  const iterator = scoped.follow(abort.signal)[Symbol.asyncIterator]()
  try {
    expect(await nextFrame(iterator)).toEqual({ type: 'baseline', items: [] })
    const ended = iterator.next()
    granted = true
    ctx.remoteAccess.invalidate(principal)
    expect(await ended).toMatchObject({ done: true })
    expect(await baseline(scoped)).toEqual([expect.objectContaining({ sessionId: session.id, completedTurn: 1 })])
  } finally {
    abort.abort()
    await iterator.return?.()
  }
})

it('reports a failed access stream without leaving its reading follower open', async () => {
  const { ctx, service } = await harness()
  vi.spyOn(ctx.remoteAccess, 'follow').mockImplementation(async function* () {
    yield { type: 'baseline', owner: true }
    throw new Error('access stream failed')
  })
  const iterator = service.follow(new AbortController().signal)[Symbol.asyncIterator]()
  await nextFrame(iterator)
  await expect(iterator.next()).rejects.toMatchObject({ code: 'session-status/unavailable' })
})

it('discards every record when the service reloads', async () => {
  const { ctx, service, fiber } = await harness()
  const session = ctx.sessions.create(SessionId('restart'))
  end(session, 1)
  await service.mark(session.id, { type: 'unread' })
  await fiber.dispose()
  await ctx.plugin(SessionStatusService)
  expect(await baseline(ctx.sessionStatus)).toEqual([])
})

it('records completions without waiting for or triggering a Session flush', async () => {
  const { ctx, service } = await harness()
  const flush = vi.fn(() => { throw new Error('unavailable disk') })
  ctx.on('session/flush', flush)
  const session = ctx.sessions.create(SessionId('memory-only'))
  end(session, 1)
  expect(await baseline(service)).toEqual([expect.objectContaining({ completedTurn: 1, readTurn: 0 })])
  expect(flush).not.toHaveBeenCalled()
})

it('rechecks a Session opened while its metadata lookup is pending', async () => {
  const { ctx, service, stat } = await harness()
  const pending = Promise.withResolvers<object>()
  stat.mockReturnValueOnce(pending.promise)
  const id = SessionId('opening')
  const mark = service.mark(id, { type: 'read', throughTurn: 0 })
  const session = ctx.sessions.create(id)
  pending.resolve({})
  await expect(mark).resolves.toBeUndefined()
  end(session, 1)
  expect(await baseline(service)).toEqual([expect.objectContaining({ completedTurn: 1, readTurn: 0 })])
})

it('keeps a completion unread when an earlier read position arrives after metadata lookup', async () => {
  const { ctx, service, stat } = await harness()
  const pending = Promise.withResolvers<object>()
  stat.mockReturnValueOnce(pending.promise)
  const id = SessionId('opening-completed')
  const mark = service.mark(id, { type: 'read', throughTurn: 0 })
  end(ctx.sessions.create(id), 1)
  pending.resolve({})
  await expect(mark).resolves.toBeUndefined()
  expect(await baseline(service)).toEqual([expect.objectContaining({ completedTurn: 1, readTurn: 0 })])
})

it.each(['service', 'Host'] as const)('discards pending marks without waiting for metadata during %s teardown', async (owner) => {
  const { ctx, service, stat, fiber } = await harness()
  const pending = Promise.withResolvers<object>()
  stat.mockReturnValueOnce(pending.promise)
  const id = SessionId('closing')
  const iterator = service.follow(new AbortController().signal)[Symbol.asyncIterator]()
  await nextFrame(iterator)
  const closed = iterator.next()
  const mark = service.mark(id, { type: 'unread' })
  const rejected = expect(mark).rejects.toMatchObject({ code: 'session-status/unavailable' })
  let disposed = false
  const disposal = (owner === 'Host' ? ctx.fiber.dispose() : fiber.dispose()).then(() => { disposed = true })
  try {
    expect(await closed).toMatchObject({ done: true })
    await vi.waitFor(() => { expect(disposed).toBe(true) })
    await expect(service.mark(id, { type: 'read', throughTurn: 0 }))
      .rejects.toMatchObject({ code: 'session-status/unavailable' })
    await expect(service.follow(new AbortController().signal)[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ code: 'session-status/unavailable' })
  } finally {
    pending.resolve({})
    await Promise.allSettled([rejected, disposal])
    await iterator.return?.()
  }
  await rejected
  expect(disposed).toBe(true)
})

it('keeps other readers available after a metadata failure', async () => {
  const { ctx, service, stat } = await harness()
  stat.mockRejectedValueOnce(new Error('metadata unavailable'))
  await expect(service.mark(SessionId('failed'), { type: 'unread' }))
    .rejects.toMatchObject({ code: 'session-status/unavailable' })
  const session = ctx.sessions.create(SessionId('healthy'))
  end(session, 1)
  expect(await baseline(service)).toEqual([expect.objectContaining({ sessionId: session.id, completedTurn: 1 })])
})

it('keeps arbitrary Session ids distinct without filesystem restrictions', async () => {
  const { ctx, service } = await harness()
  const ids = ['thread.42', 'user/1', '..', 'a'.repeat(200), '\ud800', '\ufffd'].map(SessionId)
  for (const id of ids) end(ctx.sessions.create(id), 1)
  expect((await baseline(service)).map(record => record.sessionId).sort()).toEqual([...ids].sort())
})
