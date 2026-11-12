/** The reading stream follows the current Peer's access to `sessionStatus/follow`. */
import { Context } from '@deepseek-ai/cordis'
import type { AccessEffect, RemoteEndpoint } from '@deepseek-ai/dsh-api-remote-access/client'
import { whenAllowed } from '@deepseek-ai/dsh-api-remote-access/src/client/when-allowed.ts'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionPendingInteraction } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import type { UiSessionStatus } from '../src/client/status.ts'
import type { SessionReadFrame, SessionReadState } from '../src/types.ts'

const roots: Context[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
})

/** A stream whose frames the test hands to the consumer; disposal does not withdraw a frame already handed over. */
function drivenStream() {
  const queue: (SessionReadFrame | undefined)[] = []
  let wake: (() => void) | undefined
  const state = { finished: false }
  let generation = 1
  const signal = new AbortController().signal
  const stream = {
    signal,
    restart: () => {},
    dispose: async () => {},
    async* [Symbol.asyncIterator]() {
      try {
        for (;;) {
          while (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve })
          const value = queue.shift()
          if (value === undefined) return
          yield { generation, value, signal, accept: () => {} }
        }
      } finally {
        state.finished = true
      }
    },
  }
  const push = (value: SessionReadFrame | undefined) => {
    queue.push(value)
    wake?.()
  }
  return { stream, push, end: () => { push(undefined) }, reconnect: () => { generation++ }, state }
}

const record = (id: string): SessionReadState => ({
  sessionId: id as SessionId, completedTurn: 1, failed: false, readTurn: 0, manualUnread: false,
})

async function harness(initiallyAllowed: boolean, driven = false) {
  const ctx = new Context()
  roots.push(ctx)
  const opened: AbortSignal[] = []
  const follow = (signal: AbortSignal): AsyncIterable<SessionReadFrame> => {
    opened.push(signal)
    return (async function* () {
      yield { type: 'baseline', items: [] }
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    })()
  }
  const remote = new TestRemote(ctx, { sessionStatus: { follow, mark: vi.fn() } })
  const streams: ReturnType<typeof drivenStream>[] = []
  if (driven) {
    Object.assign(remote, { $stream: () => {
      const next = drivenStream()
      streams.push(next)
      return next.stream
    } })
  }
  const allowed = createSnapshotStore(initiallyAllowed, { flush: 'sync' })
  const requested: RemoteEndpoint[] = []
  ctx.provide('remoteAccess', {
    whenAccess: (action: RemoteEndpoint, callback: () => AccessEffect) => {
      requested.push(action)
      return whenAllowed(ctx, allowed, callback, 'test access')
    },
  } as never)
  ctx.provide('sessions', {
    list: createSnapshotStore<SessionListState>({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }),
    binding: () => undefined,
  } as never)
  ctx.provide('slots', { provideRoot: () => () => {} } as never)
  ctx.provide('uiSession', {
    pendingInteractions: createSnapshotStore<ReadonlyMap<SessionId, SessionPendingInteraction>>(new Map()),
  } as never)
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  await ctx.plugin({ inject, apply }).await()
  const status = ctx.get('uiSession.sessionStatus') as UiSessionStatus
  const ready = () => status.readingReady.getSnapshot()
  return { ctx, opened, allowed, requested, report, ready, status, streams }
}

it('opens no reading stream and reports nothing while the Peer may not follow reading records', async () => {
  const b = await harness(false)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(b.requested).toEqual(['sessionStatus/follow'])
  expect(b.opened).toEqual([])
  expect(b.ready()).toBe(false)
  await expect(b.status.mark('s1' as SessionId, true)).rejects.toThrow('Reading state is unavailable')
  expect(b.report).not.toHaveBeenCalled()
})

it('starts the stream when access is granted and stops it when access is revoked', async () => {
  const b = await harness(false)
  b.allowed.set(true)
  await vi.waitFor(() => { expect(b.ready()).toBe(true) })
  expect(b.opened).toHaveLength(1)
  b.allowed.set(false)
  expect(b.ready()).toBe(false)
  await vi.waitFor(() => { expect(b.opened[0]!.aborted).toBe(true) })
  b.allowed.set(true)
  await vi.waitFor(() => { expect(b.ready()).toBe(true) })
  expect(b.opened).toHaveLength(2)
  expect(b.report).not.toHaveBeenCalled()
})

it('discards frames a revoked stream still delivers and leaves reading unavailable', async () => {
  const b = await harness(true, true)
  const first = b.streams[0]!
  first.push({ type: 'baseline', items: [] })
  await vi.waitFor(() => { expect(b.ready()).toBe(true) })
  b.allowed.set(false)
  expect(b.ready()).toBe(false)
  first.reconnect()
  first.push({ type: 'baseline', items: [record('late')] })
  first.push({ type: 'changed', state: record('later') })
  first.end()
  await vi.waitFor(() => { expect(first.state.finished).toBe(true) })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(b.ready()).toBe(false)
  expect(b.status.getSnapshot().size).toBe(0)
})

it('keeps a quick re-grant\'s records and readiness while the revoked stream drains', async () => {
  const b = await harness(true, true)
  const first = b.streams[0]!
  first.push({ type: 'baseline', items: [] })
  await vi.waitFor(() => { expect(b.ready()).toBe(true) })
  b.allowed.set(false)
  b.allowed.set(true)
  const second = b.streams[1]!
  second.push({ type: 'baseline', items: [record('granted')] })
  await vi.waitFor(() => { expect(b.status.getSnapshot().get('granted' as SessionId)?.completionUnread).toBe(true) })
  first.push({ type: 'changed', state: record('revoked') })
  first.end()
  await vi.waitFor(() => { expect(first.state.finished).toBe(true) })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(b.ready()).toBe(true)
  expect([...b.status.getSnapshot().keys()]).toEqual(['granted'])
  second.end()
})
