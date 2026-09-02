import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import MessageFeedbackService, { messageFeedbackRowSchema } from '../src/index.ts'
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

  it('accepts only non-empty append-origin assistant projections as targets', async () => {
    const { ctx, persistence } = await harness()
    const fixture = messageFixture('targets')
    persistence.persist(fixture.session)
    const rejectedTargets: MessageId[] = [
      fixture.userMessageId,
      fixture.emptyAssistantMessageId,
      fixture.replacementAssistantMessageId,
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

  it('fails invalid direct configuration and a read before domain initialization', async () => {
    const invalidCtx = new Context()
    expect(() => new MessageFeedbackService(invalidCtx, { maxNoteBytes: 0 }))
      .toThrow(/positive safe integer/u)
    await invalidCtx.fiber.dispose()

    const fixture = messageFixture('uninitialized-domain')
    const rawCtx = new Context()
    rawCtx.provide('sessions', { get: () => undefined } as never)
    rawCtx.provide('sessionPersistence', {
      stat: () => Promise.resolve({ header: fixture.session.header, revision: 'test' }),
      open: () => Promise.resolve({
        header: fixture.session.header,
        read: () => Promise.resolve(fixture.session.snapshotEvents()),
        close: () => Promise.resolve(),
      }),
    } as never)
    const raw = new MessageFeedbackService(rawCtx, { maxNoteBytes: 1 })
    await expect(raw.list({ sessionId: fixture.session.id }))
      .rejects.toThrow(/durable domain is not initialized/u)
    await rawCtx.fiber.dispose()
  })

  it('rejects durable rows with duplicate message ids or reused item versions', () => {
    const version = staleVersion()
    const duplicate = messageFeedbackRowSchema.safeParse({
      session: { createdAt: 1 },
      items: [
        {
          messageId: 'same-message',
          rating: 'positive',
          version,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          messageId: 'same-message',
          rating: 'negative',
          version,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
    expect(duplicate.success).toBe(false)
    if (duplicate.success) throw new Error('expected duplicate row rejection')
    expect(duplicate.error.issues.map(issue => issue.path.join('.')))
      .toEqual(['items.1.messageId', 'items.1.version'])
  })
})

describe('MessageFeedbackService item concurrency', () => {
  it('serializes whole-row writes while keeping versions independent per message', async () => {
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

  it('fences a reused Session id and lets the new lifecycle start cleanly', async () => {
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

  it('drains admitted mutations before domain close and rejects later admission', async () => {
    const current = await harness()
    const { ctx, persistence } = current
    const fixture = messageFixture('dispose-quiescence')
    persistence.persist(fixture.session)
    const service = ctx.messageFeedback
    const lifecycle = service as unknown as { readonly mutationAdmissionOpen: boolean }
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let physicalReads = 0
    let committed = 0
    persistence.onRead = async () => {
      physicalReads += 1
      if (physicalReads !== 1) return
      started.resolve(undefined)
      await release.promise
    }
    ctx.on('domain/changed', (change) => {
      if (change.domain === 'message_feedback') committed += 1
    })

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
    expect(physicalReads).toBe(4)
    expect(committed).toBe(2)
  })
})

describe('MessageFeedbackService durability ordering', () => {
  it('rejects a live target missing from the re-read physical durable prefix', async () => {
    const { ctx, persistence } = await harness()
    const session = ctx.sessions.create(SessionId('live-prefix'), {
      meta: { createdAt: 50, cwd: '/prefix' },
    })
    const fixture = appendMessageFixture(session)
    ctx.on('session/flush', () => {
      persistence.setDurable({ meta: session.header, events: [] })
    })

    await expect(ctx.messageFeedback.put({
      sessionId: session.id,
      messageId: fixture.assistantMessageIds[0],
      rating: 'positive',
      ifVersion: null,
    })).resolves.toEqual({
      ok: false,
      error: {
        code: 'target-not-found',
        sessionId: session.id,
        messageId: fixture.assistantMessageIds[0],
      },
    })
    expect(persistence.readCalls).toBe(1)
    await expect(ctx.messageFeedback.list({ sessionId: session.id })).resolves.toEqual({
      ok: true,
      value: { items: [] },
    })
  })

  it('commits and physically verifies a live target checkpoint before the sidecar write', async () => {
    const { ctx, persistence } = await harness()
    const session = ctx.sessions.create(SessionId('live-checkpoint'), {
      meta: { createdAt: 30, cwd: '/live' },
    })
    const fixture = appendMessageFixture(session)
    const order: string[] = []
    ctx.on('session/flush', (current) => {
      order.push('session:durable')
      persistence.persist(current)
    })
    ctx.on('domain/changed', (change) => {
      if (change.domain === 'message_feedback') order.push('sidecar:durable')
    })
    persistence.onRead = () => { order.push('session:verified') }

    expectItem(await ctx.messageFeedback.put({
      sessionId: session.id,
      messageId: fixture.assistantMessageIds[0],
      rating: 'positive',
      ifVersion: null,
    }))
    expect(order).toEqual(['session:durable', 'session:verified', 'sidecar:durable'])
    expect(persistence.readCalls).toBe(1)
    expect(persistence.durable.get(session.id)?.events).toContainEqual(
      expect.objectContaining({ type: 'assistant/message' }),
    )
  })

  it('fails closed when a live checkpoint fails, has no participant, or is not physically durable', async () => {
    const failed = await harness()
    const failedSession = failed.ctx.sessions.create(SessionId('live-flush-failure'))
    const failedFixture = appendMessageFixture(failedSession)
    const diskFailure = new Error('disk unavailable')
    failed.ctx.on('session/flush', () => { throw diskFailure })
    await expect(failed.ctx.messageFeedback.put({
      sessionId: failedSession.id,
      messageId: failedFixture.assistantMessageIds[0],
      rating: 'positive',
      ifVersion: null,
    })).rejects.toBe(diskFailure)
    await expect(failed.ctx.messageFeedback.list({ sessionId: failedSession.id })).resolves.toEqual({
      ok: true,
      value: { items: [] },
    })

    const absent = await harness()
    const absentSession = absent.ctx.sessions.create(SessionId('live-no-flush'))
    const absentFixture = appendMessageFixture(absentSession)
    await expect(absent.ctx.messageFeedback.put({
      sessionId: absentSession.id,
      messageId: absentFixture.assistantMessageIds[0],
      rating: 'positive',
      ifVersion: null,
    })).rejects.toThrow(/no durability listener participated/u)
    await expect(absent.ctx.messageFeedback.list({ sessionId: absentSession.id })).resolves.toEqual({
      ok: true,
      value: { items: [] },
    })

    const noDurability = await harness()
    const unpersistedSession = noDurability.ctx.sessions.create(SessionId('live-unpersisted'))
    const unpersistedFixture = appendMessageFixture(unpersistedSession)
    noDurability.ctx.on('session/flush', () => {})
    await expect(noDurability.ctx.messageFeedback.put({
      sessionId: unpersistedSession.id,
      messageId: unpersistedFixture.assistantMessageIds[0],
      rating: 'positive',
      ifVersion: null,
    })).rejects.toThrow(/not found/u)
    expect(noDurability.persistence.durable.has(unpersistedSession.id)).toBe(false)
    await expect(noDurability.ctx.messageFeedback.list({ sessionId: unpersistedSession.id })).resolves.toEqual({
      ok: true,
      value: { items: [] },
    })
  })

  it('finishes the captured live checkpoint when the Session detaches mid-flush', async () => {
    const { ctx, persistence } = await harness()
    const session = ctx.sessions.prepare(SessionId('detach-during-flush'), {
      meta: { createdAt: 40, cwd: '/detach' },
    })
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    const fixture = appendMessageFixture(session)
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    ctx.on('session/flush', async (current) => {
      started.resolve(undefined)
      await release.promise
      persistence.persist(current)
    })

    const pending = ctx.messageFeedback.put({
      sessionId: session.id,
      messageId: fixture.assistantMessageIds[0],
      rating: 'positive',
      ifVersion: null,
    })
    await started.promise
    detach()
    expect(ctx.sessions.get(session.id)).toBeUndefined()
    release.resolve(undefined)
    expectItem(await pending)
    expect(persistence.readCalls).toBe(1)
    await expect(ctx.messageFeedback.list({ sessionId: session.id })).resolves.toMatchObject({
      ok: true,
      value: { items: [{ messageId: fixture.assistantMessageIds[0] }] },
    })
  })
})
