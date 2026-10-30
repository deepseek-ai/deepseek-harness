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
    await expect(harness.host.reset(taken.key, 'test')).resolves.toBeUndefined()
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
      sessionId: SessionId('child-1'), meta: { parentSession: record.sessionId },
    })
    expect(harness.host.of(child.agent.session.id)).toBe(harness.host.get(record.key))
    expect(harness.host.of(SessionId('unknown'))).toBeUndefined()

    // A parent cycle terminates instead of looping forever.
    await harness.ctx.agents.create({ sessionId: SessionId('loop-a'), meta: { parentSession: SessionId('loop-b') } })
    await harness.ctx.agents.create({ sessionId: SessionId('loop-b'), meta: { parentSession: SessionId('loop-a') } })
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
})
