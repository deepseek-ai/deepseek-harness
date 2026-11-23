/**
 * Outbound sender: the grants check, durable receipts (confirmed / failed / uncertain / partial, never an automatic
 * resend), own-message attribution, quote/thread targets, streams and the receipt bounds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  Bot, createRenderReport, h, normalize, PartialSendError, PlatformError, StreamAbortError, StreamLimitError,
  type Fragment, type MessageHandle, type MessageStream, type SendOptions, type SendResult, type Target,
} from '@deepseek-ai/cordis-plugin-im-core'
import { createTextMode, mountFakeAdapter, type FakeAdapter } from '@deepseek-ai/cordis-plugin-im-core/src/testing.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import {
  ImChatKey, ImMessageKey, ImSourceId, splitKey, type ImBinding, type ImConfig, type ImMessage, type ImSessionRecord,
} from '../src/api.ts'
import { Config } from '../src/config.ts'
import { ImError } from '../src/error.ts'
import { grantChain, ImSender, operationId, type StoredReceipt } from '../src/send.ts'
import { ImStore, type ImMessageDraft } from '../src/store.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

const CHAT = ImChatKey('fake:bot', 'chat')
const STUB_CHAT = ImChatKey('stub:bot', 'chat')
const COMPOSITION = { agentPreset: 'im', cwd: process.cwd(), provider: 'mock', model: 'mock' }

/** The session lookups of `ImSenderDeps.sessions` (the grants check and the placement). */
class FakeSessions {
  private readonly records = new Map<string, ImSessionRecord>()
  /** Last message each session answered (`ImSessions.trigger`). */
  private readonly triggers = new Map<string, ImMessage>()

  add(session: string, bindings: ImBinding[], parent?: string): ImSessionRecord {
    const record: ImSessionRecord = {
      key: session, owner: 'test', composition: COMPOSITION, bindings, sessionId: SessionId(session), generation: 0,
      createdAt: 0, lastActiveAt: 0, ...parent === undefined ? {} : { parent: SessionId(parent) },
    }
    this.records.set(session, record)
    return record
  }

  of(sessionId: SessionId): ImSessionRecord | undefined {
    return this.records.get(sessionId)
  }

  get(keyOrId: string): ImSessionRecord | undefined {
    return this.records.get(keyOrId)
  }

  trigger(sessionId: SessionId): ImMessage | undefined {
    return this.triggers.get(sessionId)
  }

  /** Record the message a session answered last. */
  answered(session: ImSessionRecord, message: ImMessage): void {
    this.triggers.set(session.sessionId, message)
  }
}

/**
 * A platform that answers however one scenario needs (timeouts, partial sends, empty handles). It is a real
 * {@link Bot}, so the send funnel's registry lookup finds it; every publication answer is scripted by the test.
 */
class StubBot extends Bot {
  readonly sends: { target: Target; content: Fragment; options: SendOptions }[] = []
  answer: (call: { target: Target; content: Fragment; options: SendOptions }) => Promise<SendResult> = async call =>
    stubResult(call.target, call.content, ['stub-1'])

  constructor(ctx: Context) {
    super(ctx, undefined, { id: 'stub:bot', platform: 'stub' })
  }

  override send(target: Target, content: Fragment, options: SendOptions): Promise<SendResult> {
    this.sends.push({ target, content, options })
    return this.answer({ target, content, options })
  }

  override stream(): MessageStream {
    throw new Error('the stub bot does not stream')
  }
}

/** One `SendResult` of the stub bot. */
function stubResult(target: Target, content: Fragment, parts: readonly string[]): SendResult {
  return { handle: handleOf('stub:bot', target, content, parts), report: createRenderReport() }
}

/** A handle the core could have produced for one logical message. */
function handleOf(bot: string, target: Target, content: Fragment, parts: readonly string[]): MessageHandle {
  return {
    bot, target, mode: 'text', parts: parts.map(id => ({ id, kind: 'text', time: 1 })), createdAt: 1, edits: 0,
    content: normalize(content),
  }
}

interface Harness {
  ctx: Context
  bot: FakeAdapter
  stub: StubBot
  store: ImStore
  sender: ImSender
  sessions: FakeSessions
  pool: MemoryMediaPool
}

/** A FakeAdapter plus a stub bot, a real store over an in-memory domain and a sender over both. */
async function boot(
  options: {
    config?: Partial<ImConfig>
    pool?: MemoryMediaPool
    /** The announcement the receipt waits for, standing in for the `send` listener that stores the own message. */
    announced?: (key: ImMessageKey) => Promise<ImMessage | undefined>
  } = {},
): Promise<Harness> {
  const pool = options.pool ?? new MemoryMediaPool()
  const { ctx, bot } = await mountFakeAdapter({ modes: { text: createTextMode() }, selfId: 'bot-user' })
  contexts.push(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const stub = new StubBot(ctx)
  ctx.bots.push(stub)
  const config = Config({
    sources: [
      { id: 'team', bot: 'fake:bot', writable: true, store: 'all' },
      { id: 'stub-team', bot: 'stub:bot', writable: true, store: 'all' },
      { id: 'qq-team', bot: 'qq:404', writable: true, store: 'all' },
    ],
    retryIntervalMs: 60_000,
    ...options.config,
  })
  const store = new ImStore(ctx, config)
  await store.start()
  await store.touchChat({ key: CHAT, bot: 'fake:bot', ref: { id: 'chat', type: 'group' }, source: ImSourceId('team') })
  await store.touchChat({
    key: STUB_CHAT, bot: 'stub:bot', ref: { id: 'chat', type: 'group' }, source: ImSourceId('stub-team'),
  })
  const sessions = new FakeSessions()
  const sender = new ImSender(ctx, config, {
    store, sessions, ...options.announced === undefined ? {} : { announced: options.announced },
  })
  await sender.start()
  return { ctx, bot, stub, store, sender, sessions, pool }
}

/** The receipts table as it sits on the (shared) medium — every boot of one pool sees it. */
function receiptsOf(pool: MemoryMediaPool): Map<string, StoredReceipt> {
  const table = pool.media.get('im_receipts')?.tables.get('receipts')
  if (table === undefined) throw new Error('no receipts were persisted')
  return table as Map<string, StoredReceipt>
}

/** Rewrite one stored receipt the way a crash or a hand-edited state leaves it. */
function tamper(pool: MemoryMediaPool, id: string, edit: (receipt: StoredReceipt) => StoredReceipt): void {
  const table = receiptsOf(pool)
  const receipt = table.get(id)
  if (receipt === undefined) throw new Error(`no receipt ${id}`)
  table.set(id, edit(receipt))
}

/** An own message draft, as the intake listener stores one after a publication. */
function ownDraft(key: ImMessageKey, chat: ImChatKey = CHAT): ImMessageDraft {
  return {
    key,
    chat: {
      key: chat,
      bot: splitKey(chat).bot,
      ref: { id: splitKey(chat).id, type: 'group' },
      source: ImSourceId(chat === STUB_CHAT ? 'stub-team' : 'team'),
    },
    sender: { id: 'bot-user', isBot: true, self: true },
    content: normalize(h.text('hello')),
    text: 'hello',
    mentions: { self: false, all: false, users: [] },
    addressed: false,
    time: 10,
    via: 'self',
  }
}

/** An inbound draft that carries the referrer its adapter decoded (QQ passive key / Lark thread placement). */
function inboundDraft(key: ImMessageKey, referrer: unknown, chat: ImChatKey = CHAT): ImMessageDraft {
  return { ...ownDraft(key, chat), sender: { id: 'user-1', self: false }, addressed: true, via: 'platform', referrer }
}

describe('ImSender.send', () => {
  it('sends without an operation id and records no receipt', async () => {
    const { bot, sender, pool } = await boot()
    const result = await sender.send(CHAT, h.text('hello'))
    expect(result.status).toBe('confirmed')
    expect(result.handle?.parts[0]?.id).toBeTruthy()
    expect(bot.operations.filter(operation => operation.op === 'send')).toHaveLength(1)
    expect(pool.media.get('im_receipts')?.tables.get('receipts')?.size ?? 0).toBe(0)
    // No receipt ⇒ nothing deduplicates the call: the same content goes out again.
    await sender.send(CHAT, h.text('hello'))
    expect(bot.operations.filter(operation => operation.op === 'send')).toHaveLength(2)
  })

  it('records a receipt, attributes the own message and replays it without sending again', async () => {
    const { bot, sender, store, sessions, pool } = await boot()
    const session = sessions.add('im-session', [{ chat: CHAT, writable: true, home: true }])
    const first = await sender.send(CHAT, h.text('hello'), { operationId: 'op-1', session: session.sessionId })
    expect(first.status).toBe('confirmed')
    expect(first.message).toBeUndefined()
    const partId = bot.operations[0]?.part?.id ?? ''
    expect(sender.sessionOf(ImMessageKey('fake:bot', partId))).toBe(session.sessionId)
    expect(sender.sessionOf(ImMessageKey('fake:bot', 'unknown'))).toBeUndefined()
    expect(receiptsOf(pool).get('op-1')).toMatchObject({
      chat: CHAT, session: session.sessionId, status: 'confirmed', message: ImMessageKey('fake:bot', partId),
    })

    // The intake listener stores the own message; a replay then names it.
    await store.put(ownDraft(ImMessageKey('fake:bot', partId)), 'none')
    const replay = await sender.send(CHAT, h.text('hello'), { operationId: 'op-1', session: session.sessionId })
    expect(replay.status).toBe('confirmed')
    expect(replay.message?.key).toBe(ImMessageKey('fake:bot', partId))
    expect(replay.handle).toBeUndefined()
    expect(bot.operations.filter(operation => operation.op === 'send')).toHaveLength(1)
  })

  it('refuses a reused operation id with different content', async () => {
    const { sender } = await boot()
    await sender.send(CHAT, h.text('hello'), { operationId: 'op-1' })
    await expect(sender.send(CHAT, h.text('other'), { operationId: 'op-1' }))
      .rejects.toThrow(/already used for a different publication/)
  })

  it('reads a crash-pending receipt as uncertain and never resends it', async () => {
    const first = await boot()
    await first.sender.send(CHAT, h.text('hello'), { operationId: 'op-pending' })
    await first.sender.send(CHAT, h.text('again'), { operationId: 'op-bare' })
    await first.sender.dispose()
    tamper(first.pool, 'op-pending', receipt => ({ ...receipt, status: 'pending' }))
    tamper(first.pool, 'op-bare', receipt => ({ ...receipt, status: 'pending' }))

    const second = await boot({ pool: first.pool })
    const pendingMessage = receiptsOf(first.pool).get('op-pending')?.message as ImMessageKey
    await second.store.put(ownDraft(pendingMessage), 'none')
    const replay = await second.sender.send(CHAT, h.text('hello'), { operationId: 'op-pending' })
    expect(replay.status).toBe('uncertain')
    expect(replay.error).toMatch(/no durable receipt/)
    expect(replay.message?.key).toBe(pendingMessage)
    // A pending operation whose message is not in this process's store still reads as uncertain.
    const bare = await second.sender.send(CHAT, h.text('again'), { operationId: 'op-bare' })
    expect(bare.status).toBe('uncertain')
    expect(bare.message).toBeUndefined()
    expect(second.bot.operations.filter(operation => operation.op === 'send')).toHaveLength(0)
  })

  it('applies the quote envelope and the thread wish', async () => {
    const { bot, sender, store } = await boot()
    await store.put(inboundDraft(ImMessageKey('fake:bot', 'm9'), undefined), 'none')
    await sender.send(CHAT, h.text('hello'), { quote: ImMessageKey('fake:bot', 'm9') })
    expect(bot.operations[0]?.payload).toMatchObject({ quote: 'm9' })
    expect(bot.operations[0]?.target?.thread).toBeUndefined()
    await sender.send(CHAT, h.text('hello'), { thread: 't1' })
    expect(bot.operations[1]?.target?.thread).toBe('t1')
  })

  it('lets im/before-send rewrite the content inside the reply envelope', async () => {
    const { ctx, stub, sender, store } = await boot()
    await store.put(inboundDraft(ImMessageKey('stub:bot', 'm9'), undefined, STUB_CHAT), 'none')
    const seen: { original: unknown; options: unknown }[] = []
    ctx.on('im/before-send', async (outgoing, next) => {
      seen.push({ original: outgoing.original, options: outgoing.options })
      outgoing.content = h.text('polished')
      await next()
    })
    const result = await sender.send(STUB_CHAT, h.text('raw'), { quote: ImMessageKey('stub:bot', 'm9') })
    expect(result.status).toBe('confirmed')
    expect(seen).toEqual([{ original: h.text('raw'), options: { quote: ImMessageKey('stub:bot', 'm9') } }])
    expect(JSON.stringify(stub.sends[0]?.content)).toContain('polished')
    expect(JSON.stringify(stub.sends[0]?.content)).not.toContain('raw')
    expect(JSON.stringify(stub.sends[0]?.content)).toContain('"quote"')
  })

  it('publishes nothing when im/before-send drops the message, and records the drop', async () => {
    const { ctx, stub, sender, pool } = await boot()
    ctx.on('im/before-send', async (outgoing, next) => {
      outgoing.drop = 'too similar'
      await next()
    })
    const result = await sender.send(STUB_CHAT, h.text('again'), { operationId: 'op-drop' })
    expect(result).toMatchObject({ status: 'failed', dropped: true })
    expect(result.error).toMatch(/too similar/)
    expect(stub.sends).toHaveLength(0)
    expect(receiptsOf(pool).get('op-drop')).toMatchObject({ status: 'failed' })
    // Without an operation id the drop is reported the same way and leaves no receipt.
    const unreceipted = await sender.send(STUB_CHAT, h.text('again'))
    expect(unreceipted).toMatchObject({ status: 'failed', dropped: true })
    expect(stub.sends).toHaveLength(0)
    expect(receiptsOf(pool).size).toBe(1)
  })

  it('does not rewrite a replayed operation and keeps the caller digest', async () => {
    const { ctx, stub, sender } = await boot()
    let calls = 0
    ctx.on('im/before-send', async (outgoing, next) => {
      calls += 1
      outgoing.content = h.text(`variant ${calls}`)
      await next()
    })
    await sender.send(STUB_CHAT, h.text('hello'), { operationId: 'op-rw' })
    const replay = await sender.send(STUB_CHAT, h.text('hello'), { operationId: 'op-rw' })
    expect(replay.status).toBe('confirmed')
    expect(calls).toBe(1)
    expect(stub.sends).toHaveLength(1)
  })

  it('sends the original content when an im/before-send listener throws', async () => {
    const { ctx, stub, sender } = await boot()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.on('im/before-send', async (outgoing) => {
      outgoing.content = h.text('half done')
      throw new Error('rewriter offline')
    })
    const result = await sender.send(STUB_CHAT, h.text('hello'))
    expect(result.status).toBe('confirmed')
    expect(JSON.stringify(stub.sends[0]?.content)).toContain('hello')
    expect(warn.mock.calls.some(([fmt]) => String(fmt).includes('before-send'))).toBe(true)
    warn.mockRestore()
  })

  it('keeps a publication in the thread the session answered in', async () => {
    const { bot, sender, sessions, store } = await boot()
    const task = sessions.add('task', [{ chat: CHAT, writable: true, home: true }])
    // A task placed on the whole chat answers a request posted inside one thread: its work happens there and its
    // output renderers quote that message, so a publication that names no thread belongs in the same thread.
    const request = await store.put({
      ...inboundDraft(ImMessageKey('fake:bot', 'm-request'), { threadId: 'th-7' }), thread: { id: 'th-7' },
    }, 'none')
    sessions.answered(task, request)
    await sender.send(CHAT, h.text('in the topic'), { session: task.sessionId })
    expect(bot.operations.at(-1)?.target?.thread).toBe('th-7')
    // A stored message of that thread supplies the adapter referrer, which is what places a Lark reply inside it.
    expect(bot.operations.at(-1)?.target?.referrer).toMatchObject({ threadId: 'th-7' })

    // A named thread wins, and a quoted message keeps its own placement.
    await sender.send(CHAT, h.text('elsewhere'), { session: task.sessionId, thread: 'th-8' })
    expect(bot.operations.at(-1)?.target?.thread).toBe('th-8')
    const plain = await store.put(inboundDraft(ImMessageKey('fake:bot', 'm-plain'), undefined), 'none')
    await sender.send(CHAT, h.text('answer'), { session: task.sessionId, quote: plain.key })
    expect(bot.operations.at(-1)?.target?.thread).toBeUndefined()

    // A message of another chat says nothing about this one.
    const foreign = await store.put(inboundDraft(ImMessageKey('stub:bot', 'm-foreign'), undefined, STUB_CHAT), 'none')
    sessions.answered(task, { ...foreign, thread: { id: 'th-9' } })
    await sender.send(CHAT, h.text('back in the chat'), { session: task.sessionId })
    expect(bot.operations.at(-1)?.target?.thread).toBeUndefined()
  })

  it('marks a platform refusal as failed and replays that verdict', async () => {
    const { bot, sender } = await boot()
    bot.failNext('send', new PlatformError('permission', 'the bot may not post here', { published: 'no' }))
    const result = await sender.send(CHAT, h.text('hello'), { operationId: 'op-failed' })
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/refused the publication: the bot may not post here/)
    expect(bot.operations.filter(operation => operation.op === 'send')).toHaveLength(1)
    const replay = await sender.send(CHAT, h.text('hello'), { operationId: 'op-failed' })
    expect(replay.status).toBe('failed')
    expect(replay.error).toBe(result.error)
    expect(bot.operations.filter(operation => operation.op === 'send')).toHaveLength(1)
  })

  it('marks a transport failure as uncertain', async () => {
    const { bot, sender } = await boot()
    bot.failNext('send', new Error('connection reset'), { times: 3 })
    const result = await sender.send(CHAT, h.text('hello'))
    expect(result.status).toBe('uncertain')
    expect(result.error).toMatch(/connection reset/)
    expect(bot.operations.filter(operation => operation.op === 'send' && operation.error === undefined))
      .toHaveLength(0)
  })

  it('keeps a confirmed publication when storing its own message fails', async () => {
    // The platform answered; only this host's copy of the message could not be written.
    const { sender } = await boot({ announced: async () => { throw new Error('im_messages is full') } })
    const result = await sender.send(CHAT, h.text('hello'))
    expect(result.status).toBe('confirmed')
    expect(result.handle?.parts[0]?.id).toBeDefined()
    expect(result.message).toBeUndefined()
  })

  it('marks a partial publication as partial', async () => {
    const { sender, stub, sessions } = await boot()
    const session = sessions.add('im-session', [{ chat: STUB_CHAT, writable: true, home: true }])
    stub.answer = async ({ target, content }) => {
      throw new PartialSendError(
        handleOf('stub:bot', target, content, ['part-0']), new Error('second part failed'), createRenderReport(),
      )
    }
    const result = await sender.send(STUB_CHAT, h.text('hello'), { session: session.sessionId })
    expect(result.status).toBe('partial')
    expect(result.handle?.parts.map(part => part.id)).toEqual(['part-0'])
    expect(result.report).toBeDefined()
    expect(result.error).toBe('second part failed')
    expect(sender.sessionOf(ImMessageKey('stub:bot', 'part-0'))).toBe(session.sessionId)
  })

  it('marks a partial publication without a render report as partial', async () => {
    const { sender, stub } = await boot()
    stub.answer = async ({ target, content }) => {
      throw new PartialSendError(handleOf('stub:bot', target, content, ['part-1']), new Error('mid part failed'))
    }
    const result = await sender.send(STUB_CHAT, h.text('hello'))
    expect(result.status).toBe('partial')
    expect(result.report).toBeUndefined()
    expect(result.error).toBe('mid part failed')
  })

  it('marks a publication whose platform answer carried no message id as confirmed without a message', async () => {
    const { sender, stub } = await boot()
    stub.answer = async ({ target, content }) => stubResult(target, content, [])
    const result = await sender.send(STUB_CHAT, h.text('hello'), { operationId: 'op-empty' })
    expect(result.status).toBe('confirmed')
    expect(result.message).toBeUndefined()
  })

  it('names the stored own message of a live publication', async () => {
    const { sender, stub, store } = await boot()
    stub.answer = async ({ target, content }) => stubResult(target, content, ['known-1'])
    await store.put(ownDraft(ImMessageKey('stub:bot', 'known-1'), STUB_CHAT), 'none')
    const result = await sender.send(STUB_CHAT, h.text('hello'))
    expect(result.message?.key).toBe(ImMessageKey('stub:bot', 'known-1'))
  })

  it('waits for the announcement that stores the own message', async () => {
    let announced: Promise<ImMessage | undefined> = Promise.resolve(undefined)
    const { sender, stub, store } = await boot({ announced: () => announced })
    stub.answer = async ({ target, content }) => stubResult(target, content, ['late-1'])
    // The `send` listener writes the record after the platform has answered, which is exactly what the receipt races.
    announced = (async () => {
      await new Promise((resolve) => { setTimeout(resolve, 5) })
      return await store.put(ownDraft(ImMessageKey('stub:bot', 'late-1'), STUB_CHAT), 'none')
    })()

    const result = await sender.send(STUB_CHAT, h.text('hello'))
    expect(result.status).toBe('confirmed')
    expect(result.message?.key).toBe(ImMessageKey('stub:bot', 'late-1'))
    expect(result.message?.seq).toBe(1)
  })

  it('reports a rejection that is not an Error as its text', async () => {
    const { sender, stub } = await boot()
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the scenario.
    stub.answer = () => Promise.reject('platform vanished')
    const result = await sender.send(STUB_CHAT, h.text('hello'))
    expect(result.status).toBe('uncertain')
    expect(result.error).toBe('platform vanished')
  })

  it('reports an outcome that could not be saved as uncertain', async () => {
    const { ctx, sender, stub, pool } = await boot()
    const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    stub.answer = async ({ target, content }) => {
      pool.failNextWrites = 1
      return stubResult(target, content, ['part-0'])
    }
    const result = await sender.send(STUB_CHAT, h.text('hello'), { operationId: 'op-unsaved' })
    expect(result.status).toBe('uncertain')
    expect(result.error).toMatch(/no durable receipt/)
    expect(receiptsOf(pool).get('op-unsaved')?.status).toBe('pending')
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })

  it('serializes two publications of one operation id', async () => {
    const { bot, sender } = await boot()
    const [first, second] = await Promise.all([
      sender.send(CHAT, h.text('hello'), { operationId: 'op-race' }),
      sender.send(CHAT, h.text('hello'), { operationId: 'op-race' }),
    ])
    expect(first.status).toBe('confirmed')
    expect(second.status).toBe('confirmed')
    expect(bot.operations.filter(operation => operation.op === 'send')).toHaveLength(1)
  })

  it('marks a strict render rejection as failed', async () => {
    const { bot, sender } = await boot()
    const result = await sender.send(CHAT, h('p', h('b', 'bold')), { strict: true, operationId: 'op-strict' })
    expect(result.status).toBe('failed')
    expect(result.report?.degraded.length).toBeGreaterThan(0)
    expect(bot.operations.filter(operation => operation.op === 'send')).toHaveLength(0)
  })

  it('marks a timed-out publication as uncertain', async () => {
    const { sender, stub } = await boot({ config: { send: { maxMediaBytes: 1024, operationTimeoutMs: 10 } } })
    stub.answer = ({ options }) => new Promise((_resolve, reject) => {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the exact abort reason is the rejection.
      options.signal?.addEventListener('abort', () => { reject(options.signal?.reason) }, { once: true })
    })
    const result = await sender.send(STUB_CHAT, h.text('hello'), { signal: new AbortController().signal })
    expect(result.status).toBe('uncertain')
    expect(result.error).toMatch(/did not finish in time/)
  })

  it('marks a cancelled publication as failed before dispatch', async () => {
    const { sender, stub } = await boot()
    const result = await sender.send(STUB_CHAT, h.text('hello'), { signal: AbortSignal.abort(new Error('gone')) })
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/cancelled before dispatch/)
    expect(stub.sends).toHaveLength(0)
  })

  it('forwards full operationIds as distinct idempotency keys even when they share a long prefix', async () => {
    const { sender, stub } = await boot()
    const opFirst = 'session-commands:reply:lark:cli_example|om_first'
    const opSecond = 'session-commands:reply:lark:cli_example|om_second'
    expect(opFirst.slice(0, 32)).toBe(opSecond.slice(0, 32))

    await sender.send(STUB_CHAT, h.text('stopped 1'), { operationId: opFirst })
    await sender.send(STUB_CHAT, h.text('nothing running'), { operationId: opSecond })
    await sender.send(STUB_CHAT, h.text('explicit'), { operationId: 'op-explicit', idempotencyKey: 'caller-key' })

    expect(stub.sends.map(call => call.options.idempotencyKey)).toEqual([opFirst, opSecond, 'caller-key'])
  })

  it('refuses a chat that was never admitted', async () => {
    const { sender } = await boot()
    await expect(sender.send(ImChatKey('fake:bot', 'elsewhere'), h.text('hello')))
      .rejects.toThrow(ImError)
  })

  it('refuses a chat whose bot is not mounted', async () => {
    const { sender, store } = await boot()
    const chat = ImChatKey('qq:404', 'chat')
    await store.touchChat({ key: chat, bot: 'qq:404', ref: { id: 'chat', type: 'group' }, source: ImSourceId('qq-team') })
    await expect(sender.send(chat, h.text('hello'))).rejects.toThrow(/No bot qq:404 is mounted/)
  })
})

describe('ImSender grants', () => {
  it('accepts a writable binding of a hosted ancestor', async () => {
    const { sender, sessions } = await boot()
    const parent = sessions.add('parent', [{ chat: CHAT, writable: true, home: true }])
    const child = sessions.add('child', [], parent.sessionId)
    const result = await sender.send(CHAT, h.text('hello'), { session: child.sessionId })
    expect(result.status).toBe('confirmed')
  })

  it('refuses a read-only binding and a session the host does not serve', async () => {
    const { sender, sessions } = await boot()
    const readOnly = sessions.add('read-only', [{ chat: CHAT, writable: false, home: true }])
    await expect(sender.send(CHAT, h.text('hello'), { session: readOnly.sessionId }))
      .rejects.toThrow(/not writable for session read-only/)
    await expect(sender.send(CHAT, h.text('hello'), { session: SessionId('stranger') }))
      .rejects.toThrow(/not writable for session stranger/)
  })

  it('enforces binding.thread on send and stream when all writable bindings for the chat are thread-confined', async () => {
    const { sender, sessions, store, bot } = await boot()
    const confined = sessions.add('confined', [{ chat: CHAT, writable: true, home: true, thread: 't1' }])
    const inThread = await store.put(inboundDraft(ImMessageKey('fake:bot', 'm-t1'), undefined), 'none')
    await store.put({ ...inboundDraft(ImMessageKey('fake:bot', 'm-t2'), undefined), thread: { id: 't2' } }, 'none')
    await store.put({ ...inThread, key: ImMessageKey('fake:bot', 'm-t1-msg'), thread: { id: 't1', root: 'r1' } }, 'none')

    await expect(sender.send(CHAT, h.text('main'), { session: confined.sessionId }))
      .rejects.toMatchObject({ code: 'access' })
    await expect(sender.send(CHAT, h.text('other'), { session: confined.sessionId, thread: 't2' }))
      .rejects.toMatchObject({ code: 'access' })
    await expect(sender.stream(CHAT, { session: confined.sessionId, thread: 't2' }))
      .rejects.toMatchObject({ code: 'access' })

    const okSend = await sender.send(CHAT, h.text('ok'), { session: confined.sessionId, thread: 't1' })
    expect(okSend.status).toBe('confirmed')
    const okQuote = await sender.send(CHAT, h.text('reply'), {
      session: confined.sessionId,
      quote: ImMessageKey('fake:bot', 'm-t1-msg'),
    })
    expect(okQuote.status).toBe('confirmed')
    // Quoting a message of another thread does not move a confined session there.
    await expect(sender.send(CHAT, h.text('quote-other'), {
      session: confined.sessionId,
      quote: ImMessageKey('fake:bot', 'm-t2'),
    })).rejects.toMatchObject({ code: 'access' })

    const rootConfined = sessions.add('root-confined', [{ chat: CHAT, writable: true, home: true, thread: 'r1' }])
    const okRootQuote = await sender.send(CHAT, h.text('reply-root'), {
      session: rootConfined.sessionId,
      quote: ImMessageKey('fake:bot', 'm-t1-msg'),
    })
    expect(okRootQuote.status).toBe('confirmed')

    await store.put({ ...inThread, key: ImMessageKey('fake:bot', 'r1') }, 'none')
    const okRootSelfQuote = await sender.send(CHAT, h.text('reply-root-self'), {
      session: rootConfined.sessionId,
      quote: ImMessageKey('fake:bot', 'r1'),
    })
    expect(okRootSelfQuote.status).toBe('confirmed')
    expect(bot.operations.at(-1)?.target?.thread).toBe('r1')

    const okRootStream = await sender.stream(CHAT, {
      session: rootConfined.sessionId,
      quote: ImMessageKey('fake:bot', 'r1'),
    })
    await okRootStream.close(h.text('stream-reply'))
    expect(bot.operations.at(-1)?.target?.thread).toBe('r1')

    // An explicit thread must not be overwritten by a quoted unthreaded root message from the same chat.
    const otherRoot = await store.put({ ...inThread, key: ImMessageKey('fake:bot', 'm-other-root') }, 'none')
    const keepExplicit = await sender.send(CHAT, h.text('keep-t1'), {
      session: confined.sessionId,
      thread: 't1',
      quote: otherRoot.key,
    })
    expect(keepExplicit.status).toBe('confirmed')
    expect(bot.operations.at(-1)?.target?.thread).toBe('t1')

    // Bare sends for a root-confined session follow `messageInThreads` on its trigger (both nested thread and root).
    const nestedTrigger = await store.put({
      ...inboundDraft(ImMessageKey('fake:bot', 'm-nested'), undefined),
      thread: { id: 'omt_x', root: 'r1' },
    }, 'none')
    sessions.answered(rootConfined, nestedTrigger)
    const okNested = await sender.send(CHAT, h.text('bare-nested'), { session: rootConfined.sessionId })
    expect(okNested.status).toBe('confirmed')
    expect(bot.operations.at(-1)?.target?.thread).toBe('omt_x')

    const rootTrigger = store.get(ImMessageKey('fake:bot', 'r1'))!
    sessions.answered(rootConfined, rootTrigger)
    const okRootBare = await sender.send(CHAT, h.text('bare-root'), { session: rootConfined.sessionId })
    expect(okRootBare.status).toBe('confirmed')
    expect(bot.operations.at(-1)?.target?.thread).toBe('r1')
  })

  it('accepts the thread a confined session answered in, and refuses any other', async () => {
    const { sender, sessions, store, bot } = await boot()
    const confined = sessions.add('confined', [{ chat: CHAT, writable: true, home: true, thread: 't1' }])
    const request = await store.put({
      ...inboundDraft(ImMessageKey('fake:bot', 'm-t1-request'), { threadId: 't1' }), thread: { id: 't1' },
    }, 'none')
    sessions.answered(confined, request)
    const result = await sender.send(CHAT, h.text('in its topic'), { session: confined.sessionId })
    expect(result.status).toBe('confirmed')
    expect(bot.operations.at(-1)?.target?.thread).toBe('t1')

    // An answered message of another thread still needs an explicit allowed thread.
    sessions.answered(confined, { ...request, thread: { id: 't2' } })
    await expect(sender.send(CHAT, h.text('elsewhere'), { session: confined.sessionId }))
      .rejects.toMatchObject({ code: 'access' })
  })

  it('bounds a grants chain whose parent points back into it', () => {
    const sessions = new FakeSessions()
    const cycle = sessions.add('cycle', [], 'cycle')
    expect(grantChain(sessions, cycle.sessionId).map(record => record.key))
      .toEqual(['cycle'])
    const lone = sessions.add('lone', [])
    expect(grantChain(sessions, lone.sessionId).map(record => record.key)).toEqual(['lone'])
  })
})

describe('ImSender receipts', () => {
  it('evicts the oldest settled receipts to stay within maxRecords', async () => {
    const { bot, sender, sessions, pool } = await boot({ config: { maxRecords: 2 } })
    const session = sessions.add('im-session', [{ chat: CHAT, writable: true, home: true }])
    const clock = vi.spyOn(Date, 'now')
    try {
      clock.mockReturnValue(1000)
      await sender.send(CHAT, h.text('one'), { operationId: 'op-a', session: session.sessionId })
      clock.mockReturnValue(2000)
      bot.failNext('send', new PlatformError('permission', 'nope', { published: 'no' }))
      await sender.send(CHAT, h.text('two'), { operationId: 'op-b' })
      const attributed = receiptsOf(pool).get('op-a')?.message
      expect(attributed).toBeTruthy()
      expect(sender.sessionOf(attributed as ImMessageKey)).toBe(session.sessionId)
      expect(receiptsOf(pool).get('op-b')?.message).toBeUndefined()

      clock.mockReturnValue(3000)
      await sender.send(CHAT, h.text('three'), { operationId: 'op-c' })
      expect([...receiptsOf(pool).keys()].sort()).toEqual(['op-b', 'op-c'])
      // The evicted receipt took its own-message attribution with it.
      expect(sender.sessionOf(attributed as ImMessageKey)).toBeUndefined()

      clock.mockReturnValue(4000)
      await sender.send(CHAT, h.text('four'), { operationId: 'op-d' })
      expect([...receiptsOf(pool).keys()].sort()).toEqual(['op-c', 'op-d'])
    } finally {
      clock.mockRestore()
    }
  })

  it('fails with capacity when every receipt is still pending', async () => {
    const { sender, pool } = await boot({ config: { maxRecords: 1 } })
    const stream = await sender.stream(CHAT, { operationId: 'op-open' })
    await expect(sender.send(CHAT, h.text('hello'), { operationId: 'op-next' }))
      .rejects.toThrow(/receipts are full of unresolved operations/)
    await stream.close(h.text('final'))
    await vi.waitFor(() => { expect(receiptsOf(pool).get('op-open')?.status).toBe('confirmed') })
  })

  it('refuses a publication after the sender was disposed', async () => {
    const { sender } = await boot()
    await sender.dispose()
    await expect(sender.send(CHAT, h.text('hello'), { operationId: 'op-late' }))
      .rejects.toThrow(/receipt store is not open/)
  })
})

describe('ImSender.stream', () => {
  it('applies the quote to every published state', async () => {
    const { bot, sender, sessions, store } = await boot()
    await store.put(inboundDraft(ImMessageKey('fake:bot', 'm9'), undefined), 'none')
    const session = sessions.add('im-session', [{ chat: CHAT, writable: true, home: true }])
    const stream = await sender.stream(CHAT, {
      quote: ImMessageKey('fake:bot', 'm9'), operationId: 'op-quoted', session: session.sessionId,
    })
    expect(stream.strategy).toBe('final')
    expect(stream.state).toBe('idle')
    stream.update(h.text('partial'))
    const result = await stream.close(h.text('final'))
    expect(result.handle.parts).toHaveLength(1)
    expect(stream.handle).toBe(result.handle)
    expect(stream.state).toBe('closed')
    expect(await stream.done).toBe(result)
    expect(bot.operations.at(-1)?.payload).toMatchObject({ quote: 'm9', text: 'final' })
  })

  it('attributes an un-receipted stream to its publishing session on completion', async () => {
    const { sender, sessions } = await boot()
    const session = sessions.add('im-stream-no-op', [{ chat: CHAT, writable: true, home: true }])
    const stream = await sender.stream(CHAT, { session: session.sessionId })
    stream.update(h.text('streaming'))
    const result = await stream.close(h.text('done'))
    const partId = result.handle.parts[0]!.id
    expect(sender.sessionOf(ImMessageKey('fake:bot', partId))).toBe(session.sessionId)
  })

  it('closes a quoted stream without a final state and aborts another one', async () => {
    const { sender, store } = await boot()
    const quote = ImMessageKey('fake:bot', 'm9')
    await store.put(inboundDraft(quote, undefined), 'none')
    const closed = await sender.stream(CHAT, { quote })
    closed.update(h.text('last'))
    expect((await closed.close()).handle.parts).toHaveLength(1)
    const aborted = await sender.stream(CHAT, { quote })
    aborted.update(h.text('some'))
    await aborted.abort({ reason: 'changed my mind' })
    await expect(aborted.done).rejects.toThrow(/aborted/)
  })

  it('closes a stream without a quote or a final state', async () => {
    const { sender } = await boot()
    const stream = await sender.stream(CHAT)
    stream.update(h.text('last'))
    const result = await stream.close()
    expect(result.handle.parts).toHaveLength(1)
  })

  it('records the outcome of a streamed publication and refuses a replayed operation id', async () => {
    const { bot, sender, pool } = await boot()
    const streamSpy = vi.spyOn(bot, 'stream')
    const opStream = 'stream:reply:lark:cli_example|om_first'
    const stream = await sender.stream(CHAT, { operationId: opStream })
    expect(streamSpy.mock.calls[0]?.[1]?.idempotencyKey).toBe(opStream)
    expect(receiptsOf(pool).get(opStream)?.status).toBe('pending')
    await stream.close(h.text('final'))
    await vi.waitFor(() => { expect(receiptsOf(pool).get(opStream)?.status).toBe('confirmed') })
    await expect(sender.stream(CHAT, { operationId: opStream }))
      .rejects.toThrow(/already opened a stream/)

    const explicit = await sender.stream(CHAT, { operationId: 'op-stream-explicit', idempotencyKey: 'custom-stream-key' })
    expect(streamSpy.mock.calls[1]?.[1]?.idempotencyKey).toBe('custom-stream-key')
    await explicit.close(h.text('done'))
    streamSpy.mockRestore()
  })

  it('records an aborted stream as uncertain', async () => {
    const { sender, pool } = await boot()
    const stream = await sender.stream(CHAT, { operationId: 'op-aborted' })
    await stream.abort({ reason: 'changed my mind' })
    await expect(stream.done).rejects.toThrow(/aborted/)
    await vi.waitFor(() => { expect(receiptsOf(pool).get('op-aborted')?.status).toBe('uncertain') })
  })

  it('records a stream whose initial frame opened and whose final edit was refused as partial with attribution', async () => {
    const { bot, sender, pool, sessions } = await boot()
    const sessionId = sessions.add('im-partial-stream', [{ chat: CHAT, writable: true, home: true }]).sessionId
    const handle: MessageHandle = {
      bot: 'fake:bot',
      target: { channel: 'c1', platform: 'fake' } as never,
      mode: 'card',
      parts: [{ id: 'm_stream_1', kind: 'card', time: 1 }],
      createdAt: 1,
      edits: 0,
      content: h('message', h.text('first')),
    }
    let rejectClose!: (reason: unknown) => void
    let streamHandle: MessageHandle | undefined
    const done = new Promise<never>((_resolve, reject) => { rejectClose = reject })
    done.catch(() => {})
    const fakeStream: MessageStream = {
      update: () => { streamHandle = handle },
      close: async () => await done,
      abort: async () => false,
      get state() { return 'open' as const },
      get handle() { return streamHandle },
      strategy: 'edit',
      done,
    }
    const streamSpy = vi.spyOn(bot, 'stream').mockReturnValue(fakeStream)
    const stream = await sender.stream(CHAT, { operationId: 'op-partial-stream', session: sessionId })
    stream.update(h.text('first'))
    rejectClose(new PlatformError('permission', 'final edit refused', { published: 'no' }))
    await expect(stream.done).rejects.toThrow('final edit refused')
    await vi.waitFor(() => { expect(receiptsOf(pool).get('op-partial-stream')?.status).toBe('partial') })
    expect(receiptsOf(pool).get('op-partial-stream')?.message).toBe('fake:bot|m_stream_1')
    expect(sender.sessionOf(ImMessageKey('fake:bot', 'm_stream_1'))).toBe(sessionId)
    streamSpy.mockRestore()
  })

  it('settles a recalled stream abort or limit recall as failed without message attribution', async () => {
    const { bot, sender, pool } = await boot()
    const makeStream = (handleAfterFail?: MessageHandle): { stream: MessageStream; reject: (e: unknown) => void } => {
      let rejectDone!: (reason: unknown) => void
      const done = new Promise<never>((_resolve, reject) => { rejectDone = reject })
      done.catch(() => {})
      let handle: MessageHandle | undefined = {
        bot: 'fake:bot',
        target: { channel: 'c1', platform: 'fake' } as never,
        mode: 'card',
        parts: [{ id: 'm_recalled', kind: 'card', time: 1 }],
        createdAt: 1,
        edits: 0,
        content: h('message', h.text('first')),
      }
      return {
        stream: {
          update: () => {},
          close: async () => await done,
          abort: async () => true,
          get state() { return 'closed' as const },
          get handle() { return handle },
          strategy: 'edit',
          done,
        },
        reject: (e: unknown) => {
          handle = handleAfterFail
          rejectDone(e)
        },
      }
    }

    const abortRecalled = makeStream()
    const spy1 = vi.spyOn(bot, 'stream').mockReturnValueOnce(abortRecalled.stream)
    const s1 = await sender.stream(CHAT, { operationId: 'op-abort-recalled' })
    abortRecalled.reject(new StreamAbortError('empty', true))
    await expect(s1.done).rejects.toThrow(/aborted/)
    await vi.waitFor(() => { expect(receiptsOf(pool).get('op-abort-recalled')?.status).toBe('failed') })
    expect(receiptsOf(pool).get('op-abort-recalled')?.message).toBeUndefined()
    spy1.mockRestore()

    const limitRecalled = makeStream()
    const spy2 = vi.spyOn(bot, 'stream').mockReturnValueOnce(limitRecalled.stream)
    const s2 = await sender.stream(CHAT, { operationId: 'op-limit-recalled' })
    limitRecalled.reject(new StreamLimitError({ kind: 'size', message: 'too big' }))
    await expect(s2.done).rejects.toThrow(/too big/)
    await vi.waitFor(() => { expect(receiptsOf(pool).get('op-limit-recalled')?.status).toBe('failed') })
    expect(receiptsOf(pool).get('op-limit-recalled')?.message).toBeUndefined()
    spy2.mockRestore()
  })

  it('keeps a stream receipt pending when its outcome cannot be saved', async () => {
    const { ctx, sender, pool } = await boot()
    const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    ctx.on('send', () => { pool.failNextWrites = 1 })
    const stream = await sender.stream(CHAT, { operationId: 'op-unsaved-stream' })
    await stream.close(h.text('final'))
    await vi.waitFor(() => { expect(logged).toHaveBeenCalled() })
    expect(receiptsOf(pool).get('op-unsaved-stream')?.status).toBe('pending')
    logged.mockRestore()
  })
})

describe('ImSender referrers', () => {
  const REFERRER = { msg_id: 'ROBOT.1.abc', event_id: 'evt-1', receivedAt: 1000, chatType: 'group', chatId: 'chat' }

  it('carries the referrer of a quoted inbound message onto the target', async () => {
    const { bot, sender, store } = await boot()
    const quoted = await store.put(inboundDraft(ImMessageKey('fake:bot', 'm9'), REFERRER), 'none')
    const result = await sender.send(CHAT, h.text('hello'), { quote: quoted.key })
    expect(result.status).toBe('confirmed')
    expect(bot.operations[0]?.target?.referrer).toEqual(REFERRER)
    // The quote envelope is still applied to the content.
    expect(bot.operations[0]?.payload).toMatchObject({ quote: 'm9' })
  })

  it('uses a same-chat alias as the outbound quote id while preserving the original referrer', async () => {
    const { bot, sender, store } = await boot()
    const quoted = await store.put({ ...inboundDraft(ImMessageKey('fake:bot', 'ROBOT1.0_m9'), REFERRER), aliases: ['REFIDX_9'] }, 'none')
    const result = await sender.send(CHAT, h.text('hello'), { quote: quoted.key })
    expect(result.status).toBe('confirmed')
    expect(bot.operations[0]?.target?.referrer).toEqual(REFERRER)
    expect(bot.operations[0]?.payload).toMatchObject({ quote: 'REFIDX_9' })
  })

  it('refuses to publish into a previously admitted chat after its source rule is removed or narrowed', async () => {
    const { bot, sender, sessions } = await boot()
    const session = sessions.add('s-revoked', [{ chat: CHAT, writable: true }])
    await expect(sender.send(CHAT, h.text('still admitted'), { session: session.sessionId })).resolves.toMatchObject({ status: 'confirmed' })

    // Narrow the source rule so CHAT is no longer admitted, then remove the source entirely.
    sender.config.sources = Config({
      sources: [{ id: 'team', bot: 'fake:bot', chats: ['other'], writable: true, store: 'all' }],
    }).sources
    await expect(sender.send(CHAT, h.text('narrowed out'), { session: session.sessionId }))
      .rejects.toMatchObject({ code: 'access' })

    sender.config.sources = []
    await expect(sender.send(CHAT, h.text('source gone'), { session: session.sessionId }))
      .rejects.toMatchObject({ code: 'access' })
    expect(bot.operations).toHaveLength(1)
  })

  it('an explicit referrer reaches the target unquoted, and replaces the one a quote supplies', async () => {
    const { bot, sender, store } = await boot()
    const CLICK = { event_id: 'evt-click', receivedAt: 2000, chatType: 'group', chatId: 'chat' }
    await sender.send(CHAT, h.text('answer to a click'), { referrer: CLICK })
    expect(bot.operations.at(-1)?.target?.referrer).toEqual(CLICK)

    // With a quote the envelope stays, but the click is what the publication answers.
    const quoted = await store.put(inboundDraft(ImMessageKey('fake:bot', 'm7'), REFERRER), 'none')
    await sender.send(CHAT, h.text('quoted answer'), { quote: quoted.key, referrer: CLICK })
    expect(bot.operations.at(-1)?.target?.referrer).toEqual(CLICK)
    expect(bot.operations.at(-1)?.payload).toMatchObject({ quote: 'm7' })

    // The referrer is not part of the request's identity: a replay with another one returns the recorded outcome.
    const first = await sender.send(CHAT, h.text('once'), { operationId: 'op-ref', referrer: CLICK })
    const sent = bot.operations.length
    const again = await sender.send(CHAT, h.text('once'), { operationId: 'op-ref', referrer: { event_id: 'evt-2' } })
    expect(again.status).toBe(first.status)
    expect(bot.operations).toHaveLength(sent)
  })

  it('leaves the target without a referrer when unquoted or quoting a message without one', async () => {
    const { bot, sender, store } = await boot()
    await sender.send(CHAT, h.text('unquoted'))
    expect(bot.operations.at(-1)?.target).not.toHaveProperty('referrer')

    // A stored message that arrived without a referrer contributes none.
    const plain = await store.put(ownDraft(ImMessageKey('fake:bot', 'm8')), 'none')
    await sender.send(CHAT, h.text('plain'), { quote: plain.key })
    expect(bot.operations.at(-1)?.target).not.toHaveProperty('referrer')
  })

  it('rejects quoting a message from another bot, another stored chat, or unstored/expired keys on send and stream', async () => {
    const { bot, sender, store } = await boot()
    const otherBotMsg = ImMessageKey('stub:bot', 'm-other-bot')
    await expect(sender.send(CHAT, h.text('cross-bot'), { quote: otherBotMsg })).rejects.toMatchObject({ code: 'access' })
    await expect(sender.stream(CHAT, { quote: otherBotMsg })).rejects.toMatchObject({ code: 'access' })

    const otherChat = ImChatKey('fake:bot', 'other-chat')
    const otherChatMsg = await store.put(inboundDraft(ImMessageKey('fake:bot', 'm-other-chat'), REFERRER, otherChat), 'none')
    await expect(sender.send(CHAT, h.text('cross-chat'), { quote: otherChatMsg.key })).rejects.toMatchObject({ code: 'access' })
    await expect(sender.stream(CHAT, { quote: otherChatMsg.key })).rejects.toMatchObject({ code: 'access' })

    // Unstored or expired message keys (e.g. from a store: 'none' readonly chat) are also rejected.
    const unstored = ImMessageKey('fake:bot', 'nope')
    await expect(sender.send(CHAT, h.text('unstored'), { quote: unstored })).rejects.toMatchObject({ code: 'access' })
    await expect(sender.stream(CHAT, { quote: unstored })).rejects.toMatchObject({ code: 'access' })
    expect(bot.operations).toHaveLength(0)
  })

  it('carries the referrer into a quoted stream', async () => {
    const { bot, sender, store } = await boot()
    const quoted = await store.put(inboundDraft(ImMessageKey('fake:bot', 'm9'), REFERRER), 'none')
    const stream = await sender.stream(CHAT, { quote: quoted.key })
    stream.update(h.text('partial'))
    const result = await stream.close(h.text('final'))
    expect(result.handle.target.referrer).toEqual(REFERRER)
    expect(bot.operations.at(-1)?.target?.referrer).toEqual(REFERRER)
    expect(result.handle.parts).toHaveLength(1)
  })

  it('attaches a stored thread message referrer when thread is a string and quote is omitted', async () => {
    const threadReferrer = {
      event_id: 'evt-thread', receivedAt: 1000, chatType: 'topic', chatId: 'chat', messageId: 'm-thread-1',
      threadId: 'omt_1', rootId: 'om_root_1',
    }
    const { bot, sender, store } = await boot()
    await store.put({
      ...inboundDraft(ImMessageKey('fake:bot', 'm-no-ref'), undefined),
      thread: { id: 'omt_1', root: 'om_root_1' },
    }, 'none')
    await store.put({
      ...inboundDraft(ImMessageKey('fake:bot', 'm-thread-1'), threadReferrer),
      thread: { id: 'omt_1', root: 'om_root_1' },
    }, 'none')

    await sender.send(CHAT, h.text('by thread id'), { thread: 'omt_1' })
    expect(bot.operations.at(-1)?.target).toEqual({
      chat: { id: 'chat', type: 'group' },
      thread: 'omt_1',
      referrer: threadReferrer,
    })

    await sender.send(CHAT, h.text('by root id'), { thread: 'om_root_1' })
    expect(bot.operations.at(-1)?.target?.referrer).toEqual(threadReferrer)

    // Blank or unmatched thread ids carry no referrer from other messages.
    expect(sender.target(CHAT, { thread: '   ' })).not.toHaveProperty('referrer')
    expect(sender.target(CHAT, { thread: 'omt_unknown' })).not.toHaveProperty('referrer')
  })
})

describe('concurrent receipt capacity reservation', () => {
  it('enforces maxRecords atomically across concurrent distinct operationIds for both send and stream', async () => {
    const { bot, stub, sender, pool } = await boot({ config: { maxRecords: 1 } })
    let releaseStubSend!: () => void
    const stubGate = new Promise<void>((resolve) => { releaseStubSend = resolve })
    stub.answer = async (call) => {
      await stubGate
      return stubResult(call.target, call.content, ['stub-1'])
    }

    const first = sender.send(STUB_CHAT, h.text('first'), { operationId: 'op-cap-1' })
    const second = sender.send(STUB_CHAT, h.text('second'), { operationId: 'op-cap-2' })
    const streamAttempt = sender.stream(CHAT, { operationId: 'op-cap-stream' })

    await expect(second).rejects.toMatchObject({ code: 'capacity' })
    await expect(streamAttempt).rejects.toMatchObject({ code: 'capacity' })
    expect(stub.sends).toHaveLength(1)
    expect(bot.operations).toHaveLength(0)
    expect(receiptsOf(pool).size).toBe(1)

    releaseStubSend()
    await expect(first).resolves.toMatchObject({ status: 'confirmed' })
    expect(receiptsOf(pool).size).toBe(1)
  })

  it('settles the reserved receipt as failed when opening a platform stream throws synchronously', async () => {
    const { sender, pool } = await boot({ config: { maxRecords: 1 } })
    await expect(sender.stream(STUB_CHAT, { operationId: 'op-sync-throw' }))
      .rejects.toThrow(/does not stream/)
    expect(receiptsOf(pool).get('op-sync-throw')).toMatchObject({
      status: 'failed',
      error: 'the stub bot does not stream',
    })
  })

  it('awaits in-flight stream receipt settlement before closing the domain on dispose', async () => {
    const { sender, store, pool } = await boot()
    let releasePut!: () => void
    const putGate = new Promise<void>((resolve) => { releasePut = resolve })
    const originalPut = store.put.bind(store)
    vi.spyOn(store, 'put').mockImplementationOnce(async (...args) => {
      await putGate
      return await originalPut(...args)
    })

    const stream = await sender.stream(CHAT, { operationId: 'op-stream-dispose' })
    await stream.close(h.text('hello'))

    const disposing = sender.dispose()
    releasePut()
    await disposing

    expect(receiptsOf(pool).get('op-stream-dispose')).toMatchObject({ status: 'confirmed' })
  })

  it('aborts an unclosed stream during dispose instead of hanging forever', async () => {
    const { sender, pool } = await boot()
    await sender.stream(CHAT, { operationId: 'op-stream-unclosed' })

    await sender.dispose()
    expect(receiptsOf(pool).get('op-stream-unclosed')).toMatchObject({ status: 'uncertain' })
  })

  it('drains in-flight un-receipted send() and aborts/drains un-receipted stream() on dispose', async () => {
    const { sender, stub } = await boot()
    let releaseSend!: () => void
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve })
    let sendFinished = false
    stub.answer = async ({ target, content }) => {
      await sendGate
      sendFinished = true
      return stubResult(target, content, ['m-unreceipted'])
    }

    const pendingSend = sender.send(STUB_CHAT, h.text('in flight'))
    const openStream = await sender.stream(CHAT)
    let disposingResolved = false
    const disposing = sender.dispose().then(() => { disposingResolved = true })

    await Promise.resolve()
    expect(disposingResolved).toBe(false)

    releaseSend()
    await disposing
    expect(sendFinished).toBe(true)
    await expect(pendingSend).resolves.toMatchObject({ status: 'confirmed' })
    await expect(openStream.done).rejects.toThrow()
  })
})

describe('operationId', () => {
  it('derives a stable key from the session and the tool call', () => {
    const session = SessionId('s-1')
    expect(operationId(session, 'call-1')).toMatch(/^[0-9a-f]{64}$/)
    expect(operationId(session, 'call-1')).toBe(operationId(session, 'call-1'))
    expect(operationId(session, 'call-2')).not.toBe(operationId(session, 'call-1'))
    expect(operationId(SessionId('s-2'), 'call-1')).not.toBe(operationId(session, 'call-1'))
  })
})
