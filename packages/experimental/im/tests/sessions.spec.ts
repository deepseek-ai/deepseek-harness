/** `ctx.im.sessions`: records, durable delivery, reset/stop/bind/of, ephemeral disposal and restart recovery. */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { h } from '@deepseek-ai/cordis-plugin-im-core'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  ImChatKey, ImMessageKey, ImSourceId, type ImChat, type ImMessage, type ImSessionSpec,
} from '../src/api.ts'
import { ImError } from '../src/error.ts'
import { sessionIdOf } from '../src/hosting.ts'
import { deliveryMessageId } from '../src/sessions.ts'
import {
  boot, cleanRoots, COMPOSITION, delivery, insertions, messagesDelivery, recovered, storedDeliveryIds,
  tamperDeliveries, type SessionsHarness,
} from './support/sessions-harness.ts'

const open: SessionsHarness[] = []

afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close()
})

afterAll(async () => {
  await cleanRoots()
})

const CHAT: ImChat = {
  key: ImChatKey('fake:bot', 'chat'), bot: 'fake:bot', ref: { id: 'chat', type: 'group' }, source: ImSourceId('team'),
}

/** One stored inbound message of the test chat. */
function message(text: string, seq = 1): ImMessage {
  return {
    key: ImMessageKey('fake:bot', `m${seq}`),
    seq,
    chat: CHAT,
    sender: { id: 'user-1', name: 'User', self: false },
    content: h('message', h.text(text)),
    text,
    mentions: { self: false, all: false, users: [] },
    addressed: true,
    time: 1000,
    via: 'platform',
  }
}

/** A session spec owned by the conversation plugin for the test chat. */
function spec(patch: Partial<ImSessionSpec> = {}): ImSessionSpec {
  return {
    key: `conv:${CHAT.key}`,
    owner: 'conversation',
    composition: COMPOSITION,
    bindings: [{ chat: CHAT.key, writable: true, home: true }],
    ...patch,
  }
}

/** Boot a host and remember it for teardown. */
async function booted(options: Parameters<typeof boot>[0] = {}): Promise<SessionsHarness> {
  const harness = await boot(options)
  open.push(harness)
  return harness
}

describe('ImSessions records', () => {
  it('creates a session once per key and reports it through im/session/created', async () => {
    const harness = await booted()
    const record = await harness.host.ensure(spec())

    expect(record.sessionId).toBe(harness.host.get(record.key)?.sessionId)
    expect(record.generation).toBe(0)
    expect(record.key).toBe(`conv:${CHAT.key}`)
    expect(record.owner).toBe('conversation')
    expect(record.bindings).toEqual([{ chat: CHAT.key, writable: true, home: true }])
    expect(harness.created).toEqual([record])
    expect(harness.host.get(record.sessionId)).toBe(record)

    const again = await harness.host.ensure(spec({ composition: { ...COMPOSITION, model: 'other' }, output: 'summary' }))
    expect(again.sessionId).toBe(record.sessionId)
    expect(again.generation).toBe(0)
    expect(again.composition.model).toBe('other')
    expect(again.output).toBe('summary')
    expect(harness.created).toEqual([record])
    expect(harness.host.get('nope')).toBeUndefined()
  })

  it('rejects a foreign owner, a blank key and an occupied session id', async () => {
    const harness = await booted()
    await harness.host.ensure(spec())
    await expect(harness.host.ensure(spec({ owner: 'tasks' }))).rejects.toThrow(ImError)
    await expect(harness.host.ensure(spec({ owner: 'tasks' }))).rejects.toThrow(/belongs to conversation/)
    await expect(harness.host.ensure(spec({ key: ' ' }))).rejects.toThrow(/nonempty key and owner/)

    const taken = await harness.host.ensure(spec({ key: 'task:taken' }))
    // A session with the derived id already exists outside the IM store.
    await harness.ctx.agents.create({ sessionId: taken.sessionId })
    await expect(harness.host.reset(taken.key, 'test')).resolves.toBe(taken.sessionId)
    const fresh = harness.host.get(taken.key)!
    expect(fresh.sessionId).not.toBe(taken.sessionId)
  })

  it('lists sessions by owner, chat and parent and answers forChat', async () => {
    const harness = await booted()
    const conversation = await harness.host.ensure(spec())
    const task = await harness.host.ensure(spec({
      key: 'task:1', owner: 'tasks', parent: conversation.sessionId, bindings: [{ chat: CHAT.key, writable: false }],
    }))
    const other = await harness.host.ensure(spec({ key: 'oneshot:1', owner: 'oneshot', bindings: [] }))

    expect(harness.host.list().map(record => record.key)).toEqual([conversation.key, task.key, other.key])
    expect(harness.host.list({ owner: 'tasks' })).toEqual([task])
    expect(harness.host.list({ parent: conversation.sessionId })).toEqual([task])
    expect(harness.host.forChat(CHAT.key).map(record => record.key)).toEqual([conversation.key, task.key])
    expect(harness.host.list({ chat: ImChatKey('fake:bot', 'elsewhere') })).toEqual([])
  })

  it('rewrites bindings through bind', async () => {
    const harness = await booted()
    const record = await harness.host.ensure(spec())
    expect(harness.host.forChat(ImChatKey('fake:bot', 'other'))).toEqual([])

    await harness.host.bind(record.sessionId, [{ chat: ImChatKey('fake:bot', 'other'), writable: true, home: true }])
    expect(harness.host.forChat(CHAT.key)).toEqual([])
    expect(harness.host.forChat(ImChatKey('fake:bot', 'other'))).toEqual([harness.host.get(record.key)])
    expect(harness.host.get(record.key)?.bindings).toEqual([{ chat: ImChatKey('fake:bot', 'other'), writable: true, home: true }])

    await expect(harness.host.bind('missing', [])).rejects.toThrow(/No IM session missing is hosted/)
  })

  it('refuses a session id that exists outside the IM store', async () => {
    const harness = await booted()
    await harness.ctx.agents.create({ sessionId: sessionIdOf('task:occupied', 0) })
    await expect(harness.host.ensure(spec({ key: 'task:occupied', owner: 'tasks' })))
      .rejects.toThrow(/already exists outside the IM store/)
    expect(harness.host.get('task:occupied')).toBeUndefined()
  })

  it('refuses a session id a durable log already owns', async () => {
    const first = await booted()
    const record = await first.host.ensure(spec())
    await first.host.deliver(record.key, delivery('followup', 'persisted'))
    await (await first.host.agent(record.sessionId)).whenIdle()
    await first.close()
    open.splice(open.indexOf(first), 1)

    // The session record is lost but its log survives (storage reset, restored backup).
    first.pool.media.get('im_sessions')!.tables.get('sessions')!.clear()
    const second = await booted({ pool: first.pool, root: first.root })
    await expect(second.host.ensure(spec())).rejects.toThrow(/already exists outside the IM store/)
  })

  it('resolves the hosted session of a calling agent through its parents', async () => {
    const harness = await booted()
    const record = await harness.host.ensure(spec())
    expect(harness.host.of(record.sessionId)).toBe(harness.host.get(record.key))

    const child = await harness.ctx.agents.create({
      sessionId: SessionId('child-1'), meta: { parentSession: record.sessionId, origin: 'subagent' },
    })
    expect(harness.host.of(child.agent.session.id)).toBe(harness.host.get(record.key))
    expect(harness.host.of(SessionId('unknown'))).toBeUndefined()

    // An ordinary fork that retained its source id was never delegated the source's chat.
    const fork = await harness.ctx.agents.create({
      sessionId: SessionId('fork-1'), meta: { parentSession: record.sessionId },
    })
    expect(harness.host.of(fork.agent.session.id)).toBeUndefined()

    // A side conversation of a hosted session, and its own subagents, take no chat from the source.
    const side = await harness.ctx.agents.create({
      sessionId: SessionId('side-1'), meta: { parentSession: record.sessionId, origin: 'side' },
    })
    const sideChild = await harness.ctx.agents.create({
      sessionId: SessionId('side-child-1'), meta: { parentSession: side.agent.session.id, origin: 'subagent' },
    })
    expect(harness.host.of(side.agent.session.id)).toBeUndefined()
    expect(harness.host.of(sideChild.agent.session.id)).toBeUndefined()

    // A parent cycle terminates instead of looping forever.
    await harness.ctx.agents.create({ sessionId: SessionId('loop-a'), meta: { parentSession: SessionId('loop-b'), origin: 'subagent' } })
    await harness.ctx.agents.create({ sessionId: SessionId('loop-b'), meta: { parentSession: SessionId('loop-a'), origin: 'subagent' } })
    expect(harness.host.of(SessionId('loop-a'))).toBeUndefined()
  })
})

describe('delivery', () => {
  it('delivers a follow-up into the real agent loop and records the trigger', async () => {
    const harness = await booted()
    const record = await harness.host.ensure(spec())
    const trigger = message('hello there')

    await harness.host.deliver(record.key, { id: 'evt-1', mode: 'followup', content: [trigger], trigger, media: true })
    const agent = await harness.host.agent(record.sessionId)
    await agent.whenIdle()

    expect(harness.model.requests).toHaveLength(1)
    expect(harness.model.promptText(0)).toContain('hello there')
    expect(harness.formats).toEqual([{ messages: [trigger], options: { media: true } }])
    expect(harness.host.trigger(record.sessionId)).toBe(trigger)
    const inserted = await insertions(harness, record.sessionId)
    expect(inserted.map(item => item.id)).toEqual([deliveryMessageId(record.sessionId, 'evt-1')])
    expect(inserted[0]?.source).toEqual({ kind: 'im', form: 'relay' })
    expect(harness.host.pendingDeliveries()).toBe(0)
    expect((harness.host.get(record.key)?.lastActiveAt ?? 0) >= record.createdAt).toBe(true)
  })

  it('steers a running turn and injects context without waking the agent', async () => {
    const harness = await booted()
    const record = await harness.host.ensure(spec())
    const trigger = message('first turn')

    // A turn that stays open: the follow-up wakes the driver, the steering joins the next step.
    const release = harness.model.gate()
    await harness.host.deliver(record.key, { id: 'evt-a', mode: 'followup', content: [trigger], trigger })
    const agent = await harness.host.agent(record.sessionId)
    await harness.model.hold?.entered.promise
    await harness.host.deliver(record.key, delivery('steer', 'steered'))
    expect(agent.inbox.nextStep.map(item => item.content)).toEqual([[{ type: 'text', text: 'steered' }]])
    release()
    await agent.whenIdle()
    expect(harness.model.requests).toHaveLength(2)
    expect(harness.model.promptText(1)).toContain('steered')

    // Inject alone never wakes an idle agent; the next follow-up carries it to the model.
    await harness.host.deliver(record.key, delivery('inject', 'background'))
    await Promise.resolve()
    expect(harness.model.requests).toHaveLength(2)
    expect(agent.inbox.nextStep.map(item => item.content)).toEqual([[{ type: 'text', text: 'background' }]])
    expect(harness.host.trigger(record.sessionId)).toBe(trigger)

    await harness.host.deliver(record.key, delivery('followup', 'second'))
    await agent.whenIdle()
    expect(harness.model.requests).toHaveLength(3)
    expect(harness.model.promptText(2)).toContain('background')
  })

  it('formats message content through the formatter and rejects unknown targets', async () => {
    const harness = await booted()
    const record = await harness.host.ensure(spec())
    const trigger = message('from the chat')
    await harness.host.deliver(record.sessionId, messagesDelivery('followup', [trigger]))
    const agent = await harness.host.agent(record.sessionId)
    await agent.whenIdle()

    expect(harness.formats).toHaveLength(1)
    expect(harness.model.promptText(0)).toContain('from the chat')
    // No explicit trigger: the delivery quotes the message it delivered last, so nothing is stored twice.
    expect(harness.host.trigger(record.sessionId)).toBe(trigger)
    await expect(harness.host.deliver('missing', delivery('followup', 'x'))).rejects.toThrow(/No IM session missing is hosted/)
  })

  it('caps one delivery by the configured byte limit', async () => {
    const harness = await booted({ config: { maxInputBytes: 200 } })
    const record = await harness.host.ensure(spec())
    await expect(harness.host.deliver(record.key, delivery('followup', 'x'.repeat(400)))).rejects.toThrow(
      /exceeds the configured byte limit/,
    )
    expect(harness.host.pendingDeliveries()).toBe(0)
  })

  it('delivers one message once when the same delivery id arrives twice', async () => {
    const harness = await booted()
    const record = await harness.host.ensure(spec())

    await harness.host.deliver(record.key, delivery('followup', 'once', 'evt-dup'))
    await harness.host.deliver(record.key, delivery('followup', 'once', 'evt-dup'))
    const agent = await harness.host.agent(record.sessionId)
    await agent.whenIdle()

    expect(harness.model.requests).toHaveLength(1)
    expect(await insertions(harness, record.sessionId)).toHaveLength(1)
  })

  it('collapses concurrent deliveries of one intent', async () => {
    const harness = await booted()
    const record = await harness.host.ensure(spec())
    const racing = delivery('followup', 'racing', 'evt-race')

    await Promise.all([harness.host.deliver(record.key, racing), harness.host.deliver(record.key, racing)])
    const agent = await harness.host.agent(record.sessionId)
    await agent.whenIdle()

    expect(harness.host.pendingDeliveries()).toBe(0)
    expect(harness.model.requests).toHaveLength(1)
    expect(await insertions(harness, record.sessionId)).toHaveLength(1)
  })

  it('keeps a binding committed while an admission awaits the formatter', async () => {
    const harness = await booted()
    const other = ImChatKey('fake:bot', 'other')
    await harness.host.ensure(spec())

    const hold = harness.holdFormat()
    const admitting = harness.host.deliver(`conv:${CHAT.key}`, messagesDelivery('steer', [message('first')]))
    await hold.entered

    // A second chat's message binds its chat while the first admission is still inside the formatter.
    await harness.host.ensure(spec({
      bindings: [{ chat: CHAT.key, writable: true, home: true }, { chat: other, writable: true }],
    }))
    hold.release()
    await admitting

    // The admission's own write must keep the binding that landed while it awaited.
    expect(harness.host.get(`conv:${CHAT.key}`)?.bindings.map(binding => binding.chat)).toEqual([CHAT.key, other])
  })

  it('retries a recorded intent whose first admission failed', async () => {
    const harness = await booted()
    const record = await harness.host.ensure(spec())
    const stuck = messagesDelivery('followup', [message('retry me')])
    harness.failFormat()
    await expect(harness.host.deliver(record.key, stuck)).rejects.toThrow(/format offline/)
    await expect(harness.host.deliver(record.key, stuck)).rejects.toThrow(/format offline/)
    expect(harness.host.pendingDeliveries()).toBe(1)

    harness.healFormat()
    await harness.host.deliver(record.key, stuck)
    const agent = await harness.host.agent(record.sessionId)
    await agent.whenIdle()
    expect(harness.host.pendingDeliveries()).toBe(0)
    expect(await insertions(harness, record.sessionId)).toHaveLength(1)
  })

  it('ignores an admission whose delivery record is already gone', async () => {
    const harness = await booted()
    const record = await harness.host.ensure(spec())
    // A reset discards pending intents while one of their admissions is still queued.
    await expect(harness.host.admit(record.sessionId, `${record.sessionId}|gone`)).resolves.toBeUndefined()
    expect(harness.model.requests).toEqual([])
  })
})

describe('stop', () => {
  it('cancels a running turn and reports nothing to stop otherwise', async () => {
    const harness = await booted()
    const record = await harness.host.ensure(spec())
    expect(await harness.host.stop(record.key)).toBe(false)

    const release = harness.model.gate()
    await harness.host.deliver(record.key, delivery('followup', 'long'))
    const agent = await harness.host.agent(record.sessionId)
    await harness.model.hold?.entered.promise
    expect(await harness.host.stop(record.sessionId)).toBe(true)
    release()
    await agent.whenIdle()
    expect(agent.status).toBe('idle')
    expect(await harness.host.stop(record.key)).toBe(false)
    await expect(harness.host.stop('missing')).rejects.toThrow(/No IM session missing is hosted/)
  })
})

describe('reset', () => {
  it('bumps the generation, reports im/session/reset and disposes the live agent', async () => {
    const harness = await booted()
    const record = await harness.host.ensure(spec())
    await harness.host.deliver(record.key, delivery('followup', 'hi'))
    const agent = await harness.host.agent(record.sessionId)
    await agent.whenIdle()

    await harness.host.reset(record.key, 'user asked')

    const after = harness.host.get(record.key)!
    expect(after.sessionId).not.toBe(record.sessionId)
    expect(after.generation).toBe(1)
    expect(harness.resets.map(entry => [entry.record.sessionId, entry.record.generation, entry.reason]))
      .toEqual([[record.sessionId, 0, 'user asked']])
    expect(harness.created.map(entry => entry.sessionId)).toEqual([record.sessionId, after.sessionId])
    expect(harness.host.get(record.sessionId)).toBeUndefined()
    expect(harness.agents.live(record.sessionId)).toBeUndefined()
    expect(harness.ctx.agents.get(record.sessionId)).toBeUndefined()

    // The next ensure() keeps the fresh generation and its agent is a brand-new session.
    const ensured = await harness.host.ensure(spec())
    expect(ensured.sessionId).toBe(after.sessionId)
    const fresh = await harness.host.agent(ensured.sessionId)
    expect(fresh.session.id).toBe(after.sessionId)
    expect(fresh.session.snapshotEvents()).toEqual([])

    await harness.host.reset('unknown', 'nothing')
    expect(harness.resets).toHaveLength(1)
  })

  it('drops undelivered intents of the old generation', async () => {
    const harness = await booted()
    const record = await harness.host.ensure(spec())
    harness.failFormat()
    await expect(harness.host.deliver(record.key, messagesDelivery('followup', [message('stuck')])))
      .rejects.toThrow(/format offline/)
    expect(harness.host.pendingDeliveries()).toBe(1)

    await harness.host.reset(record.key, 'restart')
    expect(harness.host.pendingDeliveries()).toBe(0)
  })

  it('never lets a delivery that races the reset write the replaced generation back', async () => {
    const harness = await booted()
    const record = await harness.host.ensure(spec())
    // Hold the dispose: the reset owns the session's serial chain while a delivery arrives from another chat.
    const dispose = harness.agents.dispose.bind(harness.agents)
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const slow = vi.spyOn(harness.agents, 'dispose').mockImplementation(async (sessionId) => {
      await held
      await dispose(sessionId)
    })

    const resetting = harness.host.reset(record.key, '/clear')
    await vi.waitFor(() => { expect(slow).toHaveBeenCalled() })
    const racing = harness.host.deliver(record.key, delivery('followup', 'from the other chat'))
    release()

    // The intent belongs to a generation that is gone: it is refused (the caller re-delivers) and forgotten.
    await expect(racing).rejects.toThrow(/discarded by a session reset|no longer hosted/)
    await resetting
    expect(harness.host.get(record.key)!.generation).toBe(1)
    expect(harness.host.get(record.sessionId)).toBeUndefined()
    expect(harness.host.pendingDeliveries()).toBe(0)
    slow.mockRestore()
  })

  it('deduplicates resets by operationId across races and restarts, honours expectedGeneration, and prunes aged receipts', async () => {
    const first = await booted()
    const record = await first.host.ensure(spec())

    // Concurrent calls carrying the same operationId collapse on the serial chain: one reset runs, both see the
    // replaced session id, and a later retry returns the stored receipt from memory.
    const [firstResult, racingResult] = await Promise.all([
      first.host.reset(record.key, 'cmd', { operationId: 'op-clear-1', expectedGeneration: 0 }),
      first.host.reset(record.key, 'cmd', { operationId: 'op-clear-1', expectedGeneration: 0 }),
    ])
    expect(firstResult).toBe(record.sessionId)
    expect(racingResult).toBe(record.sessionId)
    expect(first.host.get(record.key)?.generation).toBe(1)
    expect(first.resets).toHaveLength(1)
    await expect(first.host.reset(record.key, 'cmd', { operationId: 'op-clear-1', expectedGeneration: 0 }))
      .resolves.toBe(record.sessionId)
    expect(first.host.get(record.key)?.generation).toBe(1)

    // A stale caller naming generation 0 under a fresh operationId leaves generation 1 untouched.
    await expect(first.host.reset(record.key, 'stale', { operationId: 'op-stale', expectedGeneration: 0 }))
      .resolves.toBeUndefined()
    await expect(first.host.reset('unknown', 'stale', { operationId: 'op-missing' }))
      .resolves.toBeUndefined()
    expect(first.host.get(record.key)?.generation).toBe(1)
    expect(first.resets).toHaveLength(1)

    await first.close()
    open.splice(open.indexOf(first), 1)

    // Across a restart, the persisted reset receipt still answers with the replaced session id without resetting again.
    const second = await booted({
      pool: first.pool, root: first.root, config: { retentionMs: 3_600_000 },
    })
    await recovered(second)
    await expect(second.host.reset(record.key, 'cmd', { operationId: 'op-clear-1' }))
      .resolves.toBe(record.sessionId)
    expect(second.host.get(record.key)?.generation).toBe(1)
    await second.close()
    open.splice(open.indexOf(second), 1)

    // Even if the session record is later removed, an unexpired reset receipt still answers with its replaced id.
    first.pool.media.get('im_sessions')?.tables.get('sessions')?.delete(record.key)
    const orphaned = await booted({
      pool: first.pool, root: first.root, config: { retentionMs: 3_600_000 },
    })
    await recovered(orphaned)
    await expect(orphaned.host.reset(record.key, 'cmd', { operationId: 'op-clear-1' }))
      .resolves.toBe(record.sessionId)
    await orphaned.close()
    open.splice(open.indexOf(orphaned), 1)

    // Aged reset receipts are pruned on recovery alongside aged delivery receipts.
    const resetsTable = first.pool.media.get('im_sessions')?.tables.get('resets')
    expect(resetsTable?.size).toBe(1)
    for (const [id, stored] of resetsTable ?? []) {
      resetsTable?.set(id, { ...(stored as Record<string, unknown>), createdAt: 0 })
    }
    const third = await booted({
      pool: first.pool, root: first.root, config: { retentionMs: 3_600_000 },
    })
    await recovered(third)
    expect(third.pool.media.get('im_sessions')?.tables.get('resets')?.size).toBe(0)
  })

  it('finishes an interrupted reset on replay without advancing a second time', async () => {
    const harness = await booted()
    const record = await harness.host.ensure(spec())

    // Fail `save(next)` once right after the `resets` receipt commits, leaving generation 0 in `sessions`.
    let failSessionWrite = true
    harness.ctx.on('domain/changed', (change) => {
      if (failSessionWrite && change.domain === 'im_sessions' && change.table === 'resets') {
        failSessionWrite = false
        harness.pool.failNextWrites = 1
      }
    })

    await expect(harness.host.reset(record.key, 'cmd', { operationId: 'op-two-phase', expectedGeneration: 0 }))
      .rejects.toThrow()
    expect(harness.host.get(record.key)?.generation).toBe(0)
    expect(harness.resets).toEqual([])
    expect(harness.created).toHaveLength(1)

    // Replaying the same operationId completes the unfinished 0 -> 1 advance once and emits its lifecycle events.
    await expect(harness.host.reset(record.key, 'cmd', { operationId: 'op-two-phase', expectedGeneration: 0 }))
      .resolves.toBe(record.sessionId)
    expect(harness.host.get(record.key)?.generation).toBe(1)
    expect(harness.resets).toHaveLength(1)
    expect(harness.created).toHaveLength(2)

    // Any further replay sees generation 1 > fromGeneration 0 and returns the replaced id without resetting again.
    await expect(harness.host.reset(record.key, 'cmd', { operationId: 'op-two-phase', expectedGeneration: 1 }))
      .resolves.toBe(record.sessionId)
    expect(harness.host.get(record.key)?.generation).toBe(1)
    expect(harness.resets).toHaveLength(1)
  })

  it('completes uncommitted reset receipts during recover() before admitting pending deliveries', async () => {
    const first = await booted()
    const record = await first.host.ensure(spec())

    // Record an unadmitted delivery for generation 0 directly in the deliveries table (simulating a crash mid-deliver).
    const deliveryId = `${record.sessionId}|pending-1`
    first.pool.media.get('im_sessions')?.tables.get('deliveries')?.set(deliveryId, {
      session: record.sessionId,
      delivery: { id: 'pending-1', mode: 'steer', content: [{ type: 'text', text: 'stale' }] },
      createdAt: Date.now(),
      admitted: false,
    })

    // Write the reset receipt but fail the subsequent `save(next)` so generation 0 remains on disk.
    let failSessionWrite = true
    first.ctx.on('domain/changed', (change) => {
      if (failSessionWrite && change.domain === 'im_sessions' && change.table === 'resets') {
        failSessionWrite = false
        first.pool.failNextWrites = 1
      }
    })
    await expect(first.host.reset(record.key, 'cmd', { operationId: 'op-crash', expectedGeneration: 0 }))
      .rejects.toThrow()
    await first.host.dispose()

    const second = await booted({ pool: first.pool })
    await second.host.whenRecovered()
    expect(second.host.get(record.key)?.generation).toBe(1)
    expect(second.host.pendingDeliveries()).toBe(0)
    expect(second.resets).toHaveLength(1)
    expect(second.ctx.agents.get(record.sessionId)).toBeUndefined()
  })

  it('stops a recovery pass held while it finishes a pending reset, before admitting other deliveries', async () => {
    const first = await booted()
    const record = await first.host.ensure(spec())
    const other = await first.host.ensure(spec({ key: 'conv:other' }))
    // A delivery to another session that cannot be formatted yet stays pending across the restart.
    first.failFormat()
    await expect(first.host.deliver(other.key, messagesDelivery('followup', [message('later', 1)])))
      .rejects.toThrow(/format offline/)
    expect(first.host.pendingDeliveries()).toBe(1)
    let failSessionWrite = true
    first.ctx.on('domain/changed', (change) => {
      if (failSessionWrite && change.domain === 'im_sessions' && change.table === 'resets') {
        failSessionWrite = false
        first.pool.failNextWrites = 1
      }
    })
    await expect(first.host.reset(record.key, 'cmd', { operationId: 'op-held', expectedGeneration: 0 }))
      .rejects.toThrow()
    await first.close()
    open.splice(open.indexOf(first), 1)

    const second = await booted({ pool: first.pool, root: first.root, withoutStart: true })
    // A hold that arrives while recovery finishes the reset ends the pass before the delivery loop.
    second.ctx.on('im/session/reset', () => { second.host.hold() })
    await second.host.start()
    await recovered(second)
    expect(second.host.get(record.key)?.generation).toBe(1)
    expect(second.host.pendingDeliveries()).toBe(1)

    second.host.release()
    await recovered(second)
    expect(second.host.pendingDeliveries()).toBe(0)
  })

  it('serializes recover() behind an in-flight reset() without duplicating events or dropping concurrent bindings', async () => {
    const harness = await booted({ withoutStart: true })
    const origOpen = harness.ctx.storageDomain.open.bind(harness.ctx.storageDomain)
    let blockNextSessionPut = false
    let onSessionPutBlocked: (() => void) | undefined
    const sessionPutBlocked = new Promise<void>((resolve) => { onSessionPutBlocked = resolve })
    let releaseSessionPut: (() => void) | undefined
    const sessionPutGate = new Promise<void>((resolve) => { releaseSessionPut = resolve })
    vi.spyOn(harness.ctx.storageDomain, 'open').mockImplementation(async (schema) => {
      const domain = await origOpen(schema)
      const sessionsTable = domain.table('sessions' as never) as { put: (k: unknown, v: unknown) => Promise<void> }
      const origPut = sessionsTable.put.bind(sessionsTable)
      sessionsTable.put = async (k, v) => {
        if (blockNextSessionPut) {
          blockNextSessionPut = false
          onSessionPutBlocked?.()
          await sessionPutGate
        }
        return origPut(k, v)
      }
      return domain
    })
    await harness.host.start()

    const record = await harness.host.ensure(spec())
    blockNextSessionPut = true
    const resetPromise = harness.host.reset(record.key, 'cmd', { operationId: 'op-concurrent', expectedGeneration: 0 })
    await sessionPutBlocked

    // `this.resets` now holds the receipt while `save(next)` is paused inside `reset()`'s write/serial lock.
    harness.host.retry()
    const bindPromise = harness.host.bind(record.key, [
      { chat: CHAT.key, writable: true, home: true },
      { chat: ImChatKey('fake:bot', 'other'), writable: false },
    ])
    await Promise.resolve()
    await Promise.resolve()
    releaseSessionPut?.()

    await resetPromise
    await bindPromise
    await harness.host.whenRecovered()

    expect(harness.host.get(record.key)?.generation).toBe(1)
    expect(harness.host.get(record.key)?.bindings).toEqual([
      { chat: CHAT.key, writable: true, home: true },
      { chat: ImChatKey('fake:bot', 'other'), writable: false },
    ])
    expect(harness.resets).toHaveLength(1)
    expect(harness.created).toHaveLength(2)
  })

  it('isolates a failing reset replay in recover() so other sessions still receive their pending deliveries', async () => {
    const first = await booted()
    const a = await first.host.ensure(spec({ key: 'conv:a' }))
    const b = await first.host.ensure(spec({ key: 'conv:b' }))

    first.failFormat()
    await expect(first.host.deliver(b.key, messagesDelivery('followup', [message('d-b', 1)]))).rejects.toThrow(/format offline/)

    let failSessionWrite = true
    first.ctx.on('domain/changed', (change) => {
      if (failSessionWrite && change.domain === 'im_sessions' && change.table === 'resets') {
        failSessionWrite = false
        first.pool.failNextWrites = 1
      }
    })
    await expect(first.host.reset(a.key, 'cmd', { operationId: 'op-stuck', expectedGeneration: 0 }))
      .rejects.toThrow()
    await expect(first.host.deliver(a.key, messagesDelivery('followup', [message('d-a', 1)]))).rejects.toThrow(/uncommitted reset/)
    await first.host.dispose()

    const second = await booted({ pool: first.pool, withoutStart: true })
    const warn = vi.spyOn(second.host.ctx.logger, 'warn')
    const origReset = second.host.reset.bind(second.host)
    vi.spyOn(second.host, 'reset').mockImplementation(async (key, reason, opts) => {
      if (key === a.key) throw new Error('agent dispose stuck')
      return origReset(key, reason, opts)
    })
    await second.host.start()
    await second.host.whenRecovered()

    expect(warn.mock.calls.some(([fmt]) => String(fmt).includes('IM reset %s remains pending'))).toBe(true)
    expect(second.host.get(a.key)?.generation).toBe(0)
    expect(second.ctx.agents.get(a.sessionId)).toBeUndefined()
    expect(second.host.pendingDeliveries()).toBe(1)
    expect(second.ctx.agents.get(b.sessionId)).toBeDefined()
  })

  it('never prunes an uncommitted reset receipt past retentionMs so stale deliveries stay blocked', async () => {
    const first = await booted()
    const record = await first.host.ensure(spec())
    first.failFormat()

    let failSessionWrite = true
    first.ctx.on('domain/changed', (change) => {
      if (failSessionWrite && change.domain === 'im_sessions' && change.table === 'resets') {
        failSessionWrite = false
        first.pool.failNextWrites = 1
      }
    })
    await expect(first.host.reset(record.key, 'cmd', { operationId: 'op-aged', expectedGeneration: 0 })).rejects.toThrow()
    await expect(first.host.deliver(record.key, messagesDelivery('followup', [message('d-stale', 2)]))).rejects.toThrow(/uncommitted reset/)

    const resetsTable = first.pool.media.get('im_sessions')?.tables.get('resets')
    for (const [id, stored] of resetsTable ?? []) {
      resetsTable?.set(id, { ...(stored as Record<string, unknown>), createdAt: 0 })
    }
    await first.host.dispose()

    const second = await booted({ pool: first.pool, withoutStart: true })
    vi.spyOn(second.host, 'reset').mockRejectedValue(new Error('still failing'))
    await second.host.start()
    await second.host.whenRecovered()

    // A second recovery pass must still see the aged uncommitted receipt and keep the old generation's delivery blocked.
    second.host.retry()
    await second.host.whenRecovered()
    expect(second.pool.media.get('im_sessions')?.tables.get('resets')?.size).toBe(1)
    expect(second.ctx.agents.get(record.sessionId)).toBeUndefined()
    expect(second.host.pendingDeliveries()).toBe(1)
  })

  it('refuses direct deliver() / admit() to a session with an uncommitted reset receipt', async () => {
    const harness = await booted()
    const a = await harness.host.ensure(spec({ key: 'conv:a' }))
    const b = await harness.host.ensure(spec({ key: 'conv:b' }))
    await harness.host.reset(b.key, 'clear', { operationId: 'op-b-done', expectedGeneration: 0 })

    let failSessionWrite = true
    harness.ctx.on('domain/changed', (change) => {
      if (failSessionWrite && change.domain === 'im_sessions' && change.table === 'resets') {
        failSessionWrite = false
        harness.pool.failNextWrites = 1
      }
    })
    await expect(harness.host.reset(a.key, 'clear', { operationId: 'op-a-stuck', expectedGeneration: 0 })).rejects.toThrow()

    await expect(harness.host.deliver(a.key, messagesDelivery('followup', [message('d-blocked', 1)])))
      .rejects.toMatchObject({ code: 'unavailable' })
    await expect(harness.host.agent(a.key)).rejects.toMatchObject({ code: 'unavailable' })
    expect(harness.ctx.agents.get(a.sessionId)).toBeUndefined()
    await expect(harness.host.deliver(b.key, messagesDelivery('followup', [message('d-ok', 1)]))).resolves.toBeUndefined()
  })

  it('rebuilds retired generation set on start() so stale deliveries are discarded after restart, and refuses stale writes inside deliver()', async () => {
    const first = await booted()
    const record = await first.host.ensure(spec())
    first.failFormat()
    await expect(first.host.deliver(record.key, messagesDelivery('followup', [message('d-seed', 1)]))).rejects.toThrow(/format offline/)

    // Reset to generation 1, then inject an unadmitted generation-0 delivery on disk (simulating a crash between
    // `deliver()` write and `admit()` discard) and restart into a fresh host.
    await first.host.reset(record.key, 'clear')
    first.pool.media.get('im_sessions')?.tables.get('deliveries')?.set(`${record.sessionId}|d-orphan`, {
      session: record.sessionId,
      delivery: { id: 'd-orphan', mode: 'followup', content: [{ type: 'text', text: 'orphan' }] },
      createdAt: Date.now(),
      admitted: false,
    })
    await first.host.dispose()

    const second = await booted({ pool: first.pool })
    await second.host.whenRecovered()
    expect(second.host.pendingDeliveries()).toBe(0)
    expect(second.pool.media.get('im_sessions')?.tables.get('deliveries')?.has(`${record.sessionId}|d-orphan`)).toBe(false)

    // Also verify deliver() refuses to write an intent once its resolved generation has been retired concurrently.
    const gen1 = second.host.get(record.key)!.sessionId
    const resetPromise = second.host.reset(record.key, 'clear-2')
    const deliverPromise = second.host.deliver(gen1, messagesDelivery('followup', [message('d-race', 2)]))
    await resetPromise
    await expect(deliverPromise).rejects.toMatchObject({ code: 'unavailable' })
  })
})

describe('ephemeral sessions', () => {
  it('disposes the agent after the first idle and keeps the record', async () => {
    const harness = await booted()
    const record = await harness.host.ensure(spec({ key: 'oneshot:m1', owner: 'oneshot', ephemeral: true }))
    const agent = await harness.host.agent(record.sessionId)
    await harness.host.deliver(record.key, delivery('followup', 'one shot'))
    await agent.whenIdle()
    await vi.waitFor(() => { expect(harness.ctx.agents.get(record.sessionId) === undefined).toBe(true) })

    expect(harness.agents.live(record.sessionId) === undefined).toBe(true)
    expect(harness.host.get(record.key)).toBeDefined()
    expect(harness.host.get(record.key)?.ephemeral).toBe(true)
  })
})

describe('recovery', () => {
  it('admits a delivery that could not be admitted before a restart, exactly once', async () => {
    const first = await booted()
    const record = await first.host.ensure(spec())
    first.failFormat()
    await expect(first.host.deliver(record.key, messagesDelivery('followup', [message('lost then found')])))
      .rejects.toThrow(/format offline/)
    expect(first.host.pendingDeliveries()).toBe(1)
    await first.close()
    open.splice(open.indexOf(first), 1)

    const second = await booted({ pool: first.pool, root: first.root })
    await recovered(second)
    expect(second.host.pendingDeliveries()).toBe(0)
    expect(second.host.get(record.key)?.sessionId).toBe(record.sessionId)
    const agent = await second.host.agent(record.sessionId)
    await agent.whenIdle()
    expect(second.model.requests).toHaveLength(1)
    expect(second.model.promptText(0)).toContain('lost then found')
    expect(await insertions(second, record.sessionId)).toHaveLength(1)
  })

  it('does not deliver again when the log already holds the insertion', async () => {
    const first = await booted()
    const record = await first.host.ensure(spec())
    await first.host.deliver(record.key, delivery('followup', 'delivered once', 'evt-restart'))
    const agent = await first.host.agent(record.sessionId)
    await agent.whenIdle()
    expect(await insertions(first, record.sessionId)).toHaveLength(1)
    await first.close()
    open.splice(open.indexOf(first), 1)

    // A crash after the inbox insertion but before the intent was marked admitted.
    tamperDeliveries(first.pool, stored => ({ ...stored, admitted: false }))

    const second = await booted({ pool: first.pool, root: first.root })
    await recovered(second)
    expect(second.host.pendingDeliveries()).toBe(0)
    expect(second.model.requests).toEqual([])
    expect(await insertions(second, record.sessionId)).toHaveLength(1)
  })

  it('keeps a delivery whose session is gone pending instead of failing the whole pass', async () => {
    const first = await booted()
    const record = await first.host.ensure(spec())
    first.failFormat()
    await expect(first.host.deliver(record.key, messagesDelivery('followup', [message('orphaned')])))
      .rejects.toThrow(/format offline/)
    await first.close()
    open.splice(open.indexOf(first), 1)

    const second = await booted({ pool: first.pool, root: first.root, withoutStart: true })
    tamperDeliveries(second.pool, stored => ({ ...stored, session: SessionId('im-gone') }))
    const warn = vi.spyOn(second.ctx.logger, 'warn')
    await second.host.start()
    await recovered(second)

    expect(second.host.pendingDeliveries()).toBe(1)
    expect(warn.mock.calls.some(([format]) => String(format).includes('remains pending'))).toBe(true)

    // The next pass still cannot admit it: nothing is lost, nothing is duplicated.
    second.host.retry()
    await recovered(second)
    expect(second.host.pendingDeliveries()).toBe(1)
  })

  it('prunes only aged settled receipts', async () => {
    const first = await booted()
    const record = await first.host.ensure(spec())
    await first.host.deliver(record.key, delivery('followup', 'old', 'evt-old'))
    await first.host.deliver(record.key, delivery('followup', 'new', 'evt-new'))
    await (await first.host.agent(record.sessionId)).whenIdle()
    await first.close()
    open.splice(open.indexOf(first), 1)

    const second = await booted({
      pool: first.pool, root: first.root, withoutStart: true, config: { retentionMs: 3_600_000 },
    })
    tamperDeliveries(second.pool, stored => (stored.delivery.id === 'evt-old' ? { ...stored, createdAt: 0 } : stored))
    await second.host.start()
    await recovered(second)

    expect(storedDeliveryIds(second.pool)).toEqual([`${record.sessionId}|evt-new`])
    expect(second.host.pendingDeliveries()).toBe(0)
  })

  it('logs a recovery pass that cannot prune and prunes on the next one', async () => {
    const first = await booted()
    const record = await first.host.ensure(spec())
    await first.host.deliver(record.key, delivery('followup', 'aged', 'evt-aged'))
    await (await first.host.agent(record.sessionId)).whenIdle()
    await first.close()
    open.splice(open.indexOf(first), 1)

    const second = await booted({
      pool: first.pool, root: first.root, withoutStart: true, config: { retentionMs: 3_600_000 },
    })
    tamperDeliveries(second.pool, stored => ({ ...stored, createdAt: 0 }))
    const error = vi.spyOn(second.ctx.logger, 'error')
    second.pool.failNextWrites = 1
    await second.host.start()
    await recovered(second)

    expect(error.mock.calls.some(([format]) => String(format).includes('remain pending'))).toBe(true)
    expect(storedDeliveryIds(second.pool)).toEqual([`${record.sessionId}|evt-aged`])

    second.host.retry()
    await recovered(second)
    expect(storedDeliveryIds(second.pool)).toEqual([])
  })
})

describe('service lifecycle', () => {
  it('opens its store lazily, retries pending passes and closes once', async () => {
    const harness = await booted({ withoutStart: true })
    harness.host.retry()
    await expect(harness.host.ensure(spec())).rejects.toThrow(/store is not open/)

    await harness.host.start()
    const record = await harness.host.ensure(spec())
    expect(harness.host.get(record.key)).toBeDefined()
    harness.host.retry()
    harness.host.retry()
    await recovered(harness)

    await harness.host.dispose()
    harness.host.retry()
    await harness.host.dispose()
    await expect(harness.host.ensure(spec({ key: 'late' }))).rejects.toThrow(/store is not open/)
  })

  it('holds recovery passes until release, pauses in-flight recovery on hold, and ignores release after dispose', async () => {
    const first = await booted()
    first.host.release()
    const record = await first.host.ensure(spec())
    first.failFormat()
    await expect(first.host.deliver(record.key, messagesDelivery('followup', [message('wait-1', 1)])))
      .rejects.toThrow(/format offline/)
    await expect(first.host.deliver(record.key, messagesDelivery('followup', [message('wait-2', 2)])))
      .rejects.toThrow(/format offline/)
    expect(first.host.pendingDeliveries()).toBe(2)
    await first.close()
    open.splice(open.indexOf(first), 1)

    const second = await booted({ pool: first.pool, root: first.root, withoutStart: true })
    second.host.hold()
    await second.host.start()
    second.host.retry()
    expect(second.host.pendingDeliveries()).toBe(2)
    expect(second.model.requests).toEqual([])

    // Pause inside the first recovered delivery and re-arm `hold()` mid-pass so the second stays pending.
    const gate = second.holdFormat()
    second.host.release()
    await gate.entered
    second.host.hold()
    gate.release()
    await recovered(second)
    expect(second.host.pendingDeliveries()).toBe(1)

    // Releasing again admits the remaining delivery, and releasing after `dispose()` is a no-op.
    second.host.release()
    await recovered(second)
    expect(second.host.pendingDeliveries()).toBe(0)
    const agent = await second.host.agent(record.sessionId)
    await agent.whenIdle()
    expect(second.model.requests.length).toBeGreaterThanOrEqual(1)

    second.host.hold()
    await second.host.dispose()
    second.host.release()
  })
})

describe('agent hosting', () => {
  it('shares an agent that another client already opened', async () => {
    const harness = await booted()
    const record = await harness.host.ensure(spec())
    const external = await harness.ctx.agents.create({ sessionId: record.sessionId })
    const warn = vi.spyOn(harness.ctx.logger, 'warn')

    const agent = await harness.host.agent(record.sessionId)
    expect(agent).toBe(external.agent)
    expect(warn.mock.calls.some(([, id]) => id === record.sessionId)).toBe(true)
    // Reopening returns the same live agent.
    expect(await harness.host.agent(record.key)).toBe(external.agent)

    // The IM host never disposes an agent it does not own ...
    await harness.agents.dispose(record.sessionId)
    expect(harness.ctx.agents.get(record.sessionId)).toBe(external.agent)

    // ... and drops a shared handle once its owner disposes the agent.
    await harness.host.agent(record.sessionId)
    await external.dispose()
    expect(harness.agents.live(record.sessionId) === undefined).toBe(true)
  })

  it('applies the composition tool restriction', async () => {
    const harness = await booted()
    const record = await harness.host.ensure(spec({ composition: { ...COMPOSITION, restrict: { deny: [] } } }))
    const agent = await harness.host.agent(record.sessionId)
    expect(agent.session.id).toBe(record.sessionId)
  })

  it('requires an active persistence listener to admit a delivery', async () => {
    const harness = await booted()
    const record = await harness.host.ensure(spec())
    await harness.host.agent(record.sessionId)
    await harness.dropPersistence()
    await expect(harness.host.deliver(record.key, delivery('followup', 'no log')))
      .rejects.toThrow(/active session persistence listener/)
    expect(harness.host.pendingDeliveries()).toBe(1)
  })

  it('reports an ephemeral agent that could not be disposed', async () => {
    const harness = await booted()
    const record = await harness.host.ensure(spec({ key: 'oneshot:m2', owner: 'oneshot', ephemeral: true }))
    const agent = await harness.host.agent(record.sessionId)
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    vi.spyOn(harness.agents, 'dispose').mockRejectedValueOnce(new Error('busy'))

    await harness.host.deliver(record.key, delivery('followup', 'one shot'))
    await agent.whenIdle()
    await vi.waitFor(() => {
      expect(warn.mock.calls.some(([format]) => String(format).includes('could not be disposed'))).toBe(true)
    })
  })

  it('discards an unadmitted delivery queued against a generation that reset retired concurrently', async () => {
    const harness = await booted()
    const record = await harness.host.ensure(spec())
    let delivering: Promise<void> | undefined
    vi.spyOn(harness.pool, 'consumeInjectedFailure').mockImplementationOnce(() => {
      delivering = harness.host.deliver(record.key, delivery('followup', 'late', 'evt-late'))
    })

    const replaced = await harness.host.reset(record.key, 'clear')
    expect(replaced).toBe(record.sessionId)
    await expect(delivering).rejects.toThrow(/discarded by a session reset/)
    expect(harness.host.pendingDeliveries()).toBe(0)
    expect(storedDeliveryIds(harness.pool)).toEqual([])
  })
})

describe('service wiring', () => {
  it('refuses to open an agent without the preset registry', async () => {
    const harness = await booted({ withoutPresets: true })
    const record = await harness.host.ensure(spec())
    await expect(harness.host.agent(record.sessionId)).rejects.toThrow(/requires the agent preset registry/)
  })
})

describe('stored delivery validation', () => {
  /** A harness whose one durable delivery intent is on disk, closed so the next boot re-reads it. */
  async function persisted(trigger?: ImMessage): Promise<SessionsHarness> {
    const first = await booted()
    const record = await first.host.ensure(spec())
    await first.host.deliver(record.key, {
      ...delivery('followup', 'held', 'evt-corrupt'),
      ...trigger === undefined ? {} : { trigger },
    })
    await (await first.host.agent(record.sessionId)).whenIdle()
    await first.close()
    open.splice(open.indexOf(first), 1)
    return first
  }

  /** Rewrite every persisted delivery intent with a payload the recovery schema must reject. */
  function corrupt(harness: SessionsHarness, edit: (stored: Record<string, unknown>) => unknown): void {
    const table = harness.pool.media.get('im_sessions')?.tables.get('deliveries')
    if (table === undefined) throw new Error('no delivery records were persisted')
    for (const [id, stored] of table) table.set(id, edit(stored as Record<string, unknown>))
  }

  it('refuses a delivery intent that is not a record', async () => {
    const first = await persisted()
    corrupt(first, stored => ({ ...stored, delivery: 'not a delivery record' }))
    await expect(booted({ pool: first.pool, root: first.root })).rejects.toThrow(/stored record|delivery/)
  })

  it('refuses a delivery intent with an unknown mode', async () => {
    const first = await persisted()
    corrupt(first, stored => ({
      ...stored, delivery: { id: 'evt-corrupt', mode: 'bogus', content: [] },
    }))
    await expect(booted({ pool: first.pool, root: first.root })).rejects.toThrow(/stored record|delivery/)
  })

  it('refuses a delivery intent whose media flag is not a boolean', async () => {
    const first = await persisted()
    corrupt(first, stored => ({
      ...stored, delivery: { id: 'evt-corrupt', mode: 'inject', content: [], media: 'yes' },
    }))
    await expect(booted({ pool: first.pool, root: first.root })).rejects.toThrow(/stored record|delivery/)
  })

  it('refuses a delivery intent whose header is not text', async () => {
    const first = await persisted()
    corrupt(first, stored => ({
      ...stored, delivery: { id: 'evt-corrupt', mode: 'inject', content: [], header: 42 },
    }))
    await expect(booted({ pool: first.pool, root: first.root })).rejects.toThrow(/stored record|delivery/)
  })

  it('accepts the stored trigger of a recovered delivery intent', async () => {
    const first = await persisted(message('held'))
    const second = await booted({ pool: first.pool, root: first.root })
    await recovered(second)
    // The intent survived the schema as admitted, so the restart neither re-sends nor re-inserts it.
    expect(second.host.pendingDeliveries()).toBe(0)
    expect(second.model.requests).toEqual([])
  })

  it('serializes concurrent reset(key) calls without operationId/expectedGeneration and concurrent admit()', async () => {
    const harness = await booted()
    const initial = await harness.host.ensure(spec())
    const reset1 = harness.host.reset(initial.key, 'first')
    const replaced1 = await reset1
    expect(replaced1).toBe(initial.sessionId)
    const afterFirst = harness.host.get(initial.key)!
    expect(afterFirst.sessionId).not.toBe(initial.sessionId)

    // Record a real unadmitted delivery for `afterFirst.sessionId`, then race `admit()` (via retry) with `reset2`:
    // both serialize on the stable `key` so `reset2` discards the intent and nothing is inserted into `afterFirst`.
    const stuck = messagesDelivery('followup', [message('race-after-first')])
    harness.failFormat()
    await expect(harness.host.deliver(initial.key, stuck)).rejects.toThrow(/format offline/)
    expect(harness.host.pendingDeliveries()).toBe(1)
    harness.healFormat()

    const reset2 = harness.host.reset(initial.key, 'second')
    const retry = harness.host.deliver(initial.key, stuck)
    const [reset2Result, retryResult] = await Promise.allSettled([reset2, retry])
    expect(reset2Result).toEqual({ status: 'fulfilled', value: afterFirst.sessionId })
    expect(retryResult.status).toBe('rejected')
    expect((retryResult as PromiseRejectedResult).reason).toMatchObject({ code: 'unavailable' })
    expect(await insertions(harness, afterFirst.sessionId)).toEqual([])
    const finalRecord = harness.host.get(initial.key)
    expect(finalRecord?.generation).toBe(2)
    expect(finalRecord?.sessionId).not.toBe(afterFirst.sessionId)
  })

  it('serializes agent() behind reset() so a retired sessionId rejects and a key opens the new generation', async () => {
    const harness = await booted()
    const initial = await harness.host.ensure(spec())
    const resetting = harness.host.reset(initial.key, 'clear')
    const byId = harness.host.agent(initial.sessionId)
    const byKey = harness.host.agent(initial.key)
    const [replaced, idResult, keyResult] = await Promise.allSettled([resetting, byId, byKey])

    expect(replaced).toEqual({ status: 'fulfilled', value: initial.sessionId })
    expect(idResult.status).toBe('rejected')
    expect((idResult as PromiseRejectedResult).reason).toMatchObject({ code: 'unavailable' })
    expect(keyResult.status).toBe('fulfilled')
    const opened = (keyResult as PromiseFulfilledResult<Awaited<ReturnType<typeof harness.host.agent>>>).value
    expect(opened.session.id).toBe(harness.host.get(initial.key)?.sessionId)
    expect(opened.session.id).not.toBe(initial.sessionId)
    expect(harness.ctx.agents.get(initial.sessionId)).toBeUndefined()
    // Calling `agent()` with an already-retired `SessionId` after `reset()` commits also rejects with `unavailable`.
    await expect(harness.host.agent(initial.sessionId)).rejects.toMatchObject({ code: 'unavailable' })
  })
})
