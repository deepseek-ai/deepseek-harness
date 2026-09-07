import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId, SessionLogOffset, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import MessageFeedbackService from '../src/index.ts'
import type {
  MessageFeedbackItem,
  MessageFeedbackVersion,
} from '../src/index.ts'
import {
  appendMessageFixture,
  messageFixture,
  setupHarness,
  type TestHarness,
} from './helpers.ts'

const harnesses: TestHarness[] = []

async function harness(maxNoteBytes = 64): Promise<TestHarness> {
  const value = await setupHarness(maxNoteBytes)
  harnesses.push(value)
  return value
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(harnesses.splice(0).map(value => value.dispose()))
})

function staleVersion(): MessageFeedbackVersion {
  return randomUUID() as MessageFeedbackVersion
}

function expectItem(
  result: Awaited<ReturnType<TestHarness['ctx']['messageFeedback']['put']>>,
): MessageFeedbackItem {
  if (!result.ok) throw new Error(`expected feedback item, got ${result.error.code}`)
  return result.value
}

describe('MessageFeedbackService public contract', () => {
  it('publishes the exact Gateway namespace and Remote method names', async () => {
    const { ctx } = await harness()
    const binding = ctx.messageFeedback.typertRemote
    expect(binding.serviceKey).toBe('messageFeedback')
    expect(binding.namespace).toBe('messageFeedback')
    expect(remoteMethods(ctx.messageFeedback)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
      { method: 'put', invocation: { kind: 'direct' } },
      { method: 'delete', invocation: { kind: 'direct' } },
    ])
  })

  it('returns session-not-found only for a definite persistence miss', async () => {
    const { ctx, persistence } = await harness()
    const missing = SessionId('missing-session')
    await expect(ctx.messageFeedback.list({ sessionId: missing })).resolves.toEqual({
      ok: false,
      error: { code: 'session-not-found', sessionId: missing },
    })

    const fixture = messageFixture('corrupt-session')
    persistence.setDurable({ meta: fixture.session.header, events: fixture.session.snapshotEvents() })
    const corruption = new Error('stored log checksum mismatch')
    persistence.readFailure = corruption
    await expect(ctx.messageFeedback.list({ sessionId: fixture.session.id })).rejects.toBe(corruption)
  })

  it('rechecks live ownership before returning a cold catalog miss', async () => {
    const { ctx, persistence } = await harness()
    const sessionId = SessionId('catalog-live-race')
    const listed = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    persistence.onStat = async () => {
      listed.resolve(undefined)
      await release.promise
    }

    const pending = ctx.messageFeedback.list({ sessionId })
    await listed.promise
    ctx.sessions.create(sessionId, { meta: { createdAt: 1_700_000_000_001 } })
    release.resolve(undefined)

    await expect(pending).resolves.toEqual({ ok: true, value: { items: [] } })
    expect(persistence.statCalls).toBe(1)
    expect(persistence.readCalls).toBe(0)
  })

  it('returns session-not-found from mutations and conflicts on an observed version for an absent item', async () => {
    const { ctx, persistence } = await harness()
    const missing = SessionId('missing-mutations')
    const missingMessage = 'missing-message' as MessageId
    await expect(ctx.messageFeedback.put({
      sessionId: missing,
      messageId: missingMessage,
      rating: 'positive',
      ifVersion: null,
    })).resolves.toEqual({
      ok: false,
      error: { code: 'session-not-found', sessionId: missing },
    })
    await expect(ctx.messageFeedback.delete({
      sessionId: missing,
      messageId: missingMessage,
      ifVersion: staleVersion(),
    })).resolves.toEqual({
      ok: false,
      error: { code: 'session-not-found', sessionId: missing },
    })

    const fixture = messageFixture('absent-version-conflict')
    persistence.persist(fixture.session)
    const expected = staleVersion()
    await expect(ctx.messageFeedback.put({
      sessionId: fixture.session.id,
      messageId: fixture.assistantMessageIds[0],
      rating: 'positive',
      ifVersion: expected,
    })).resolves.toEqual({
      ok: false,
      error: { code: 'version-conflict', current: null },
    })
  })

  it('creates, updates, and retry-reads immutable items with monotonic Host times', async () => {
    const { ctx, persistence } = await harness()
    const fixture = messageFixture('timestamps')
    persistence.persist(fixture.session)
    const messageId = fixture.assistantMessageIds[0]

    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_001_000)
    const created = expectItem(await ctx.messageFeedback.put({
      sessionId: fixture.session.id,
      messageId,
      rating: 'positive',
      note: '  exact prose  ',
      ifVersion: null,
    }))
    expect(created).toMatchObject({
      messageId,
      rating: 'positive',
      note: '  exact prose  ',
      createdAt: 1_700_000_001_000,
      updatedAt: 1_700_000_001_000,
    })
    expect(created.version).toMatch(/^[0-9a-f-]{36}$/u)
    expect(Object.isFrozen(created)).toBe(true)

    vi.setSystemTime(1_700_000_000_000)
    const updated = expectItem(await ctx.messageFeedback.put({
      sessionId: fixture.session.id,
      messageId,
      rating: 'negative',
      ifVersion: created.version,
    }))
    expect(updated).toMatchObject({
      messageId,
      rating: 'negative',
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    })
    expect(updated.version).not.toBe(created.version)

    const retry = expectItem(await ctx.messageFeedback.put({
      sessionId: fixture.session.id,
      messageId,
      rating: 'negative',
      ifVersion: updated.version,
    }))
    expect(retry).toEqual(updated)

    const listed = await ctx.messageFeedback.list({ sessionId: fixture.session.id })
    if (!listed.ok) throw new Error(`expected list success, got ${listed.error.code}`)
    expect(listed.value.items).toEqual([updated])
    expect(listed.value.items[0]).not.toBe(updated)
    expect(Object.isFrozen(listed.value)).toBe(true)
    expect(Object.isFrozen(listed.value.items)).toBe(true)
    expect(Object.isFrozen(listed.value.items[0])).toBe(true)
  })

  it('reports non-blank and complete UTF-8 byte limits without touching persistence', async () => {
    const { ctx, persistence } = await harness(4)
    const fixture = messageFixture('note-limits')
    persistence.persist(fixture.session)
    const messageId = fixture.assistantMessageIds[0]
    const before = persistence.statCalls + persistence.readCalls

    await expect(ctx.messageFeedback.put({
      sessionId: fixture.session.id,
      messageId,
      rating: 'positive',
      note: ' \n\t ',
      ifVersion: null,
    })).resolves.toEqual({ ok: false, error: { code: 'note-blank' } })
    await expect(ctx.messageFeedback.put({
      sessionId: fixture.session.id,
      messageId,
      rating: 'positive',
      note: 'ééé',
      ifVersion: null,
    })).resolves.toEqual({
      ok: false,
      error: { code: 'note-too-large', maxBytes: 4, actualBytes: 6 },
    })
    expect(persistence.statCalls + persistence.readCalls).toBe(before)

    expectItem(await ctx.messageFeedback.put({
      sessionId: fixture.session.id,
      messageId,
      rating: 'positive',
      note: '😀',
      ifVersion: null,
    }))
  })

  it('accepts only non-empty assistant projections as targets', async () => {
    const { ctx, persistence } = await harness()
    const fixture = messageFixture('targets')
    persistence.persist(fixture.session)
    const rejectedTargets: MessageId[] = [
      fixture.userMessageId,
      fixture.emptyAssistantMessageId,
    ]
    for (const messageId of rejectedTargets) {
      await expect(ctx.messageFeedback.put({
        sessionId: fixture.session.id,
        messageId,
        rating: 'positive',
        ifVersion: null,
      })).resolves.toEqual({
        ok: false,
        error: {
          code: 'target-not-found',
          sessionId: fixture.session.id,
          messageId,
        },
      })
    }
    expectItem(await ctx.messageFeedback.put({
      sessionId: fixture.session.id,
      messageId: fixture.assistantMessageIds[0],
      rating: 'positive',
      ifVersion: null,
    }))
  })

  it('rejects invalid configuration', async () => {
    const ctx = new Context()
    try {
      expect(() => new MessageFeedbackService(ctx, { maxNoteBytes: 0 })).toThrow(/positive safe integer/u)
    } finally {
      await ctx.fiber.dispose()
    }
  })

})

describe('MessageFeedbackService item concurrency', () => {
  it('allows only one of two concurrent creates for the same message', async () => {
    const { ctx, persistence } = await harness()
    const fixture = messageFixture('same-item-race')
    persistence.persist(fixture.session)
    const request = {
      sessionId: fixture.session.id, messageId: fixture.assistantMessageIds[0], rating: 'positive' as const, ifVersion: null,
    }
    const [first, second] = await Promise.all([ctx.messageFeedback.put(request), ctx.messageFeedback.put(request)])
    const item = expectItem(first)
    expect(second).toEqual({ ok: false, error: { code: 'version-conflict', current: item } })
    expect(persistence.appendCalls).toBe(1)
  })

  it('serializes canonical event writes while keeping versions independent per message', async () => {
    const { ctx, persistence } = await harness()
    const fixture = messageFixture('concurrent-items')
    persistence.persist(fixture.session)
    const [firstId, secondId] = fixture.assistantMessageIds

    const [firstResult, secondResult] = await Promise.all([
      ctx.messageFeedback.put({
        sessionId: fixture.session.id,
        messageId: firstId,
        rating: 'positive',
        ifVersion: null,
      }),
      ctx.messageFeedback.put({
        sessionId: fixture.session.id,
        messageId: secondId,
        rating: 'negative',
        ifVersion: null,
      }),
    ])
    const first = expectItem(firstResult)
    const second = expectItem(secondResult)
    const updated = expectItem(await ctx.messageFeedback.put({
      sessionId: fixture.session.id,
      messageId: firstId,
      rating: 'negative',
      note: 'changed',
      ifVersion: first.version,
    }))

    await expect(ctx.messageFeedback.put({
      sessionId: fixture.session.id,
      messageId: firstId,
      rating: 'positive',
      note: 'stale change',
      ifVersion: first.version,
    })).resolves.toEqual({
      ok: false,
      error: { code: 'version-conflict', current: updated },
    })

    const listed = await ctx.messageFeedback.list({ sessionId: fixture.session.id })
    if (!listed.ok) throw new Error(`expected list success, got ${listed.error.code}`)
    expect(listed.value.items).toEqual([updated, second])
    expect(listed.value.items[1]?.version).toBe(second.version)
  })

  it('rejects a stale put even when the current value has returned to the same state', async () => {
    const { ctx, persistence } = await harness()
    const fixture = messageFixture('put-aba')
    persistence.persist(fixture.session)
    const messageId = fixture.assistantMessageIds[0]
    const first = expectItem(await ctx.messageFeedback.put({
      sessionId: fixture.session.id,
      messageId,
      rating: 'positive',
      ifVersion: null,
    }))
    const second = expectItem(await ctx.messageFeedback.put({
      sessionId: fixture.session.id,
      messageId,
      rating: 'negative',
      ifVersion: first.version,
    }))
    const current = expectItem(await ctx.messageFeedback.put({
      sessionId: fixture.session.id,
      messageId,
      rating: 'positive',
      ifVersion: second.version,
    }))

    await expect(ctx.messageFeedback.put({
      sessionId: fixture.session.id,
      messageId,
      rating: 'positive',
      ifVersion: first.version,
    })).resolves.toEqual({
      ok: false,
      error: { code: 'version-conflict', current },
    })
  })

  it('makes delete retries stable and prevents delete/recreate ABA', async () => {
    const { ctx, persistence } = await harness()
    const fixture = messageFixture('delete-aba')
    persistence.persist(fixture.session)
    const messageId = fixture.assistantMessageIds[0]
    const created = expectItem(await ctx.messageFeedback.put({
      sessionId: fixture.session.id,
      messageId,
      rating: 'positive',
      ifVersion: null,
    }))

    await expect(ctx.messageFeedback.delete({
      sessionId: fixture.session.id,
      messageId,
      ifVersion: staleVersion(),
    })).resolves.toEqual({
      ok: false,
      error: { code: 'version-conflict', current: created },
    })
    const request = {
      sessionId: fixture.session.id,
      messageId,
      ifVersion: created.version,
    }
    await expect(ctx.messageFeedback.delete(request)).resolves.toEqual({
      ok: true,
      value: { absent: true },
    })
    await expect(ctx.messageFeedback.delete(request)).resolves.toEqual({
      ok: true,
      value: { absent: true },
    })

    const recreated = expectItem(await ctx.messageFeedback.put({
      sessionId: fixture.session.id,
      messageId,
      rating: 'negative',
      ifVersion: null,
    }))
    expect(recreated.version).not.toBe(created.version)
    await expect(ctx.messageFeedback.delete(request)).resolves.toEqual({
      ok: false,
      error: { code: 'version-conflict', current: recreated },
    })
  })

  it('starts clean when a stored log is replaced without feedback events', async () => {
    const { ctx, persistence } = await harness()
    const old = messageFixture('reused-session', { createdAt: 10, cwd: '/old' })
    persistence.persist(old.session)
    const oldItem = expectItem(await ctx.messageFeedback.put({
      sessionId: old.session.id,
      messageId: old.assistantMessageIds[0],
      rating: 'positive',
      ifVersion: null,
    }))

    const replacement = Session.create(
      old.session.id,
      old.session.snapshotEvents(),
      { ...old.session.header, createdAt: 20, cwd: '/new' },
    )
    persistence.persist(replacement)
    await expect(ctx.messageFeedback.list({ sessionId: replacement.id })).resolves.toEqual({
      ok: true,
      value: { items: [] },
    })
    await expect(ctx.messageFeedback.delete({
      sessionId: replacement.id,
      messageId: old.assistantMessageIds[0],
      ifVersion: oldItem.version,
    })).resolves.toEqual({ ok: true, value: { absent: true } })

    const newItem = expectItem(await ctx.messageFeedback.put({
      sessionId: replacement.id,
      messageId: old.assistantMessageIds[0],
      rating: 'negative',
      ifVersion: null,
    }))
    expect(newItem.version).not.toBe(oldItem.version)
  })

  it('drains admitted mutations before disposal and rejects later admission', async () => {
    const current = await harness()
    const { ctx, persistence } = current
    const fixture = messageFixture('dispose-quiescence')
    persistence.persist(fixture.session)
    const service = ctx.messageFeedback
    const lifecycle = service as unknown as { readonly mutationAdmissionOpen: boolean }
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let physicalReads = 0
    persistence.onRead = async () => {
      physicalReads += 1
      if (physicalReads !== 1) return
      started.resolve(undefined)
      await release.promise
    }

    const first = service.put({
      sessionId: fixture.session.id,
      messageId: fixture.assistantMessageIds[0],
      rating: 'positive',
      ifVersion: null,
    })
    await started.promise
    const second = service.put({
      sessionId: fixture.session.id,
      messageId: fixture.assistantMessageIds[1],
      rating: 'negative',
      ifVersion: null,
    })
    const disposal = current.disposeFeedback()
    await vi.waitFor(() => { expect(lifecycle.mutationAdmissionOpen).toBe(false) })

    await expect(service.delete({
      sessionId: fixture.session.id,
      messageId: fixture.assistantMessageIds[0],
      ifVersion: staleVersion(),
    })).rejects.toThrow('message-feedback: service is disposing')
    release.resolve(undefined)

    expectItem(await first)
    expectItem(await second)
    await disposal
    expect(physicalReads).toBe(2)
    expect(persistence.appendCalls).toBe(2)
    expect(persistence.closeCalls).toBe(2)
  })
})

describe('canonical message feedback history', () => {
  it('appends only material cold mutations and leaves lifecycle and model history alone', async () => {
    const { ctx, persistence } = await harness()
    const fixture = messageFixture('cold-log')
    const sessionId = fixture.session.id
    const messageId = fixture.assistantMessageIds[0]
    persistence.persist(fixture.session)
    const prefix = fixture.session.snapshotEvents()
    const lifecycle: string[] = []
    ctx.on('session/created', () => { lifecycle.push('created') })
    ctx.on('session/event', () => { lifecycle.push('event') })
    const created = expectItem(await ctx.messageFeedback.put({ sessionId, messageId, rating: 'positive', note: '  exact\ntext  ', ifVersion: null }))
    const edited = expectItem(await ctx.messageFeedback.put({ sessionId, messageId, rating: 'negative', ifVersion: created.version }))
    expectItem(await ctx.messageFeedback.put({ sessionId, messageId, rating: 'negative', ifVersion: edited.version }))
    await ctx.messageFeedback.delete({ sessionId, messageId, ifVersion: edited.version })
    await ctx.messageFeedback.delete({ sessionId, messageId, ifVersion: edited.version })
    const events = persistence.durable.get(sessionId)!.events
    expect(events.slice(0, prefix.length)).toEqual(prefix)
    expect(events.slice(prefix.length).map(({ type, data }) => ({ type, data }))).toEqual([
      { type: 'feedback/message-put', data: { sessionId, item: created } },
      { type: 'feedback/message-put', data: { sessionId, item: edited } },
      { type: 'feedback/message-delete', data: { sessionId, messageId } },
    ])
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index))
    expect(lifecycle).toEqual([])
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    expect(persistence.openCalls).toEqual(['write', 'write', 'write', 'write', 'write'])
    expect(persistence.closeCalls).toBe(5)
  })

  it('starts a fork without inherited feedback and keeps parent mutations independent', async () => {
    const { ctx, persistence } = await harness()
    const parent = messageFixture('feedback-parent')
    persistence.persist(parent.session)
    const messageId = parent.assistantMessageIds[0]
    const parentItem = expectItem(await ctx.messageFeedback.put({ sessionId: parent.session.id, messageId, rating: 'positive', ifVersion: null }))
    const seed = persistence.durable.get(parent.session.id)!.events
    const childId = SessionId('feedback-child')
    const child = Session.create(childId, seed, {
      ...parent.session.header, id: childId, isSeeded: true, parentSession: parent.session.id,
    }, SessionLogOffset(seed.length))
    persistence.persist(child)
    await expect(ctx.messageFeedback.list({ sessionId: childId })).resolves.toEqual({ ok: true, value: { items: [] } })
    const childItem = expectItem(await ctx.messageFeedback.put({ sessionId: childId, messageId, rating: 'negative', ifVersion: null }))
    await ctx.messageFeedback.delete({ sessionId: parent.session.id, messageId, ifVersion: parentItem.version })
    await expect(ctx.messageFeedback.list({ sessionId: childId })).resolves.toEqual({ ok: true, value: { items: [childItem] } })
  })

  it('flushes live feedback with the target and retries durability without a duplicate event', async () => {
    const { ctx, persistence } = await harness()
    const session = ctx.sessions.create(SessionId('live-log'))
    const fixture = appendMessageFixture(session)
    const before = session.snapshotEvents().length
    const failure = new Error('disk unavailable')
    let fail = true
    ctx.on('session/flush', (current) => {
      if (fail) throw failure
      persistence.persist(current)
    })
    const request = { sessionId: session.id, messageId: fixture.assistantMessageIds[0], rating: 'positive' as const, ifVersion: null }
    await expect(ctx.messageFeedback.put(request)).rejects.toBe(failure)
    const listed = await ctx.messageFeedback.list({ sessionId: session.id })
    if (!listed.ok) throw new Error('missing live session')
    const item = listed.value.items[0]!
    fail = false
    expectItem(await ctx.messageFeedback.put({ ...request, ifVersion: item.version }))
    expect(session.snapshotEvents()).toHaveLength(before + 1)
    expect(persistence.durable.get(session.id)?.events).toEqual(session.snapshotEvents())
    expect(persistence.openCalls).toEqual(['read'])
  })

  it.each(['missing-tail', 'different-tail', 'different-lifecycle'] as const)(
    'rejects a live checkpoint with %s and closes its verification handle', async (kind) => {
      const { ctx, persistence } = await harness()
      const session = ctx.sessions.create(SessionId('mismatched-checkpoint'))
      const fixture = appendMessageFixture(session)
      ctx.on('session/flush', () => {
        const events = [...session.snapshotEvents()]
        if (kind === 'missing-tail') events.pop()
        if (kind === 'different-tail') events[events.length - 1] = { ...events.at(-1)!, time: 0 }
        const meta = kind === 'different-lifecycle' ? { ...session.header, createdAt: 0 } : session.header
        persistence.setDurable({ meta, events })
      })
      await expect(ctx.messageFeedback.put({
        sessionId: session.id, messageId: fixture.assistantMessageIds[0], rating: 'positive', ifVersion: null,
      })).rejects.toThrow(/feedback prefix is not durable/u)
      expect(persistence.closeCalls).toBe(1)
    },
  )

  it('verifies an empty live no-op and captures its checkpoint before concurrent appends', async () => {
    const { ctx, persistence } = await harness()
    const session = ctx.sessions.create(SessionId('checkpoint-prefix'))
    ctx.on('session/flush', () => { persistence.persist(session) })
    await expect(ctx.messageFeedback.delete({ sessionId: session.id, messageId: 'absent' as MessageId, ifVersion: staleVersion() }))
      .resolves.toEqual({ ok: true, value: { absent: true } })
    const fixture = appendMessageFixture(session)
    persistence.onRead = () => { session.append('turn/start', { turn: 2 }) }
    expectItem(await ctx.messageFeedback.put({
      sessionId: session.id, messageId: fixture.assistantMessageIds[0], rating: 'positive', ifVersion: null,
    }))
    expect(persistence.durable.get(session.id)!.events.length).toBe(session.snapshotEvents().length - 1)
  })

  it('rejects an unowned durability checkpoint and closes cold handles on failures', async () => {
    const { ctx, persistence } = await harness()
    const live = ctx.sessions.create(SessionId('no-flush-owner'))
    const fixture = appendMessageFixture(live)
    await expect(ctx.messageFeedback.put({ sessionId: live.id, messageId: fixture.assistantMessageIds[0], rating: 'positive', ifVersion: null }))
      .rejects.toThrow(/no durability listener participated/u)
    const cold = messageFixture('cold-failures')
    persistence.persist(cold.session)
    const request = { sessionId: cold.session.id, messageId: cold.assistantMessageIds[0], rating: 'positive' as const, ifVersion: null }
    const appendFailure = new Error('append failed')
    persistence.appendFailure = appendFailure
    await expect(ctx.messageFeedback.put(request)).rejects.toBe(appendFailure)
    expect(persistence.closeCalls).toBe(1)
    persistence.appendFailure = undefined
    const flushFailure = new Error('flush failed')
    persistence.flushFailure = flushFailure
    await expect(ctx.messageFeedback.put(request)).rejects.toBe(flushFailure)
    expect(persistence.closeCalls).toBe(2)
  })

  it.each([
    { type: 'feedback/message-put', data: null },
    { type: 'feedback/message-put', data: { sessionId: 'x', item: {} } },
    ...[
      { messageId: '' }, { rating: 'neutral' }, { version: 'bad-token' }, { note: ' 	' },
      { createdAt: -1 }, { updatedAt: 0 }, { updatedAt: 1.5 },
    ].map(patch => ({ type: 'feedback/message-put', data: { sessionId: 'x', item: {
      messageId: 'message', rating: 'positive', version: randomUUID(), createdAt: 1, updatedAt: 1, ...patch,
    } } })),
    { type: 'feedback/message-delete', data: { sessionId: 'x', messageId: '' } },
    { type: 'feedback/message-delete', data: { sessionId: 12, messageId: 'message' } },
  ])('rejects malformed durable feedback payload %#', async (record) => {
    const { ctx, persistence } = await harness()
    const fixture = messageFixture('invalid-feedback')
    const events = fixture.session.snapshotEvents()
    persistence.setDurable({ meta: fixture.session.header, events: [...events, {
      ...record, seq: SessionSeq(events.length), time: 1,
    } as SessionEvent] })
    await expect(ctx.messageFeedback.list({ sessionId: fixture.session.id })).rejects.toThrow()
    expect(persistence.closeCalls).toBe(1)
  })
})
