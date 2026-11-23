/** Message store: per-chat seq, redelivery idempotency, retention, and history queries. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { h } from '@deepseek-ai/cordis-plugin-im-core'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import {
  ImChatKey, ImMessageKey, ImSourceId, type ImChat, type ImConfig,
} from '../src/api.ts'
import type { ImMessageDraft } from '../src/store.ts'
import { Config } from '../src/config.ts'
import { ImError } from '../src/error.ts'
import { imDomain } from '../src/state.ts'
import { ImStore } from '../src/store.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

const CHAT: ImChat = {
  key: ImChatKey('fake:bot', 'chat'), bot: 'fake:bot', ref: { id: 'chat', type: 'group' }, source: ImSourceId('team'),
}
const OTHER: ImChat = {
  key: ImChatKey('fake:bot', 'other'), bot: 'fake:bot', ref: { id: 'other', type: 'direct' }, source: ImSourceId('team'),
}
const RETENTION = 3_600_000

/** Open a store over a memory domain backend; the same pool reopens the same media (restart). */
async function boot(pool = new MemoryMediaPool(), overrides: Partial<ImConfig> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const store = new ImStore(ctx, Config({ sources: [], ...overrides }))
  await store.start()
  const stored: string[] = []
  ctx.on('im/stored', message => stored.push(message.key))
  return { ctx, store, pool, stored, facility }
}

function draft(id: string, chat: ImChat = CHAT, text = id): ImMessageDraft {
  return {
    key: ImMessageKey('fake:bot', id),
    chat,
    sender: { id: 'user-1', name: 'User', self: false },
    content: h('message', h.text(text)),
    text,
    mentions: { self: false, all: false, users: [] },
    addressed: false,
    time: 1000,
    via: 'platform',
  }
}

describe('ImStore history', () => {
  it('assigns a per-chat seq and answers every history query', async () => {
    const { store, stored } = await boot()
    expect(store.chat(CHAT.key)).toBeUndefined()
    await store.touchChat(CHAT)
    expect(store.chat(CHAT.key)).toEqual(CHAT)

    const first = await store.put(draft('m1'), 'pending')
    const second = await store.put(draft('m2', CHAT, 'two'), 'none')
    const other = await store.put(draft('m3', OTHER), 'none')

    expect([first.seq, second.seq, other.seq]).toEqual([1, 2, 1])
    expect(stored).toEqual([first.key, second.key, other.key])
    expect(store.get(first.key)).toBe(first)
    expect(store.get(ImMessageKey('fake:bot', 'nope'))).toBeUndefined()
    expect(store.latest(CHAT.key)?.key).toBe(second.key)
    expect(store.latest(ImChatKey('fake:bot', 'nope'))).toBeUndefined()

    expect(store.after(CHAT.key, 0, 10).map(message => message.seq)).toEqual([1, 2])
    expect(store.after(CHAT.key, 0, 10, message => message.text === 'two').map(message => message.seq)).toEqual([2])
    expect(store.after(CHAT.key, 0, 1, message => message.seq >= 1).map(message => message.seq)).toEqual([1])
    expect(store.after(CHAT.key, 1, 10).map(message => message.seq)).toEqual([2])
    expect(store.after(CHAT.key, 2, 10)).toEqual([])
    expect(store.before(CHAT.key, 3, 10).map(message => message.seq)).toEqual([1, 2])
    expect(store.before(CHAT.key, 2, 10).map(message => message.seq)).toEqual([1])
    expect(store.before(CHAT.key, 3, 1).map(message => message.seq)).toEqual([2])
    expect(store.before(CHAT.key, 1, 10)).toEqual([])

    const unknown = ImChatKey('fake:bot', 'nope')
    expect(store.after(unknown, 0, 10)).toEqual([])
    expect(store.before(unknown, 1, 10)).toEqual([])
    expect(store.after(CHAT.key, 0, 0)).toEqual([])
    expect(store.before(CHAT.key, 2, 0)).toEqual([])
  })

  it('keeps one record (and one seq) per message key on redelivery', async () => {
    const { store, stored } = await boot()
    const first = await store.put(draft('m1'), 'pending')
    const again = await store.put(draft('m1'), 'pending')
    expect(again).toBe(first)
    expect(store.after(CHAT.key, 0, 10)).toHaveLength(1)
    expect(stored).toHaveLength(1)
    expect((await store.put(draft('m2'), 'pending')).seq).toBe(2)
  })

  it('continues the seq counter and the receipts across a restart', async () => {
    const pool = new MemoryMediaPool()
    const first = await boot(pool)
    await first.store.put(draft('m1'), 'none')
    await first.store.put(draft('m2', CHAT, 'two'), 'pending')
    await first.store.remember('fake:bot|evt-1', {
      digest: 'digest-1', message: ImMessageKey('fake:bot', 'm1'), receivedAt: 5,
    })
    await first.store.dispose()

    const second = await boot(pool)
    expect(second.store.chat(CHAT.key)?.key).toBe(CHAT.key)
    expect(second.store.get(ImMessageKey('fake:bot', 'm1'))?.seq).toBe(1)
    expect(second.store.after(CHAT.key, 0, 10).map(message => message.seq)).toEqual([1, 2])
    expect(second.store.pending().map(state => state.message.seq)).toEqual([2])
    expect(second.store.event('fake:bot|evt-1')).toEqual({
      digest: 'digest-1', message: ImMessageKey('fake:bot', 'm1'), receivedAt: 5,
    })
    expect((await second.store.put(draft('m3'), 'none')).seq).toBe(3)
  })

  it('persists the adapter referrer of an inbound message across a restart', async () => {
    const pool = new MemoryMediaPool()
    const referrer = { msg_id: 'ROBOT.1.abc', receivedAt: 1000, chatType: 'group', chatId: 'chat' }
    const first = await boot(pool)
    const stored = await first.store.put({ ...draft('m1'), referrer }, 'none')
    await first.store.put(draft('m2', CHAT, 'two'), 'none')
    expect(stored.referrer).toBe(referrer)
    expect(first.store.get(stored.key)?.referrer).toBe(referrer)
    await first.store.dispose()

    const second = await boot(pool)
    expect(second.store.get(ImMessageKey('fake:bot', 'm1'))?.referrer).toEqual(referrer)
    // A message without a referrer stays without one (no `referrer: undefined` key leaks into a record).
    expect('referrer' in (second.store.get(ImMessageKey('fake:bot', 'm2')) ?? {})).toBe(false)
  })
})

describe('ImStore write rules', () => {
  it('records outcomes, keeps pending records dispatchable, and forgets nothing else', async () => {
    const { store } = await boot()
    const pending = await store.put(draft('m1'), 'pending')
    const outbound = await store.put(draft('m2'), 'none')
    expect(store.pending().map(state => state.message.key)).toEqual([pending.key])
    expect(store.state(outbound.key)?.dispatch).toBe('none')
    expect(store.state(outbound.key)?.outcome).toBeUndefined()

    const outcome = { kind: 'handled', by: 'test' } as const
    await store.settle(pending.key, outcome)
    expect(store.pending()).toEqual([])
    expect(store.state(pending.key)?.dispatch).toBe('done')
    expect(store.state(pending.key)?.outcome).toEqual(outcome)
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- expect.any() is typed `any`.
    expect(store.recent(5)).toEqual([{ key: pending.key, outcome, at: expect.any(Number) }])
    expect(store.recent(0)).toEqual([])

    // A platform-read record (`dispatch: 'none'`, `via: 'platform'`) is promoted to `pending` when its inbound event
    // arrives, keeping its seq; an own outbound record (`via: 'self'`) stays `none`.
    const prefetched = await store.put({ ...draft('m-prefetch'), via: 'platform' }, 'none')
    const promoted = await store.put(draft('m-prefetch'), 'pending')
    expect(promoted.seq).toBe(prefetched.seq)
    expect(store.state(prefetched.key)?.dispatch).toBe('pending')

    const own = await store.put({ ...draft('m-own'), via: 'self' }, 'none')
    await store.put(draft('m-own'), 'pending')
    expect(store.state(own.key)?.dispatch).toBe('none')
    expect(store.state(ImMessageKey('fake:bot', 'nope'))).toBeUndefined()
    await expect(store.settle(ImMessageKey('fake:bot', 'nope'), outcome)).rejects.toThrow(ImError)
  })

  it('keeps only the latest outcomes for status()', async () => {
    const { store } = await boot()
    for (let index = 0; index < 101; index += 1) {
      const message = await store.put(draft(`m${index}`), 'pending')
      await store.settle(message.key, { kind: 'ignored' })
    }
    expect(store.recent(1000)).toHaveLength(100)
    expect(store.recent(2).map(entry => entry.key)).toEqual([
      ImMessageKey('fake:bot', 'm99'), ImMessageKey('fake:bot', 'm100'),
    ])
  })

  it('evicts the oldest settled message over maxRecords but never a pending one', async () => {
    const { store } = await boot(new MemoryMediaPool(), { maxRecords: 2 })
    const evicted = await store.put(draft('m1'), 'none')
    const pending = await store.put(draft('m2'), 'pending')
    const last = await store.put(draft('m3'), 'none')
    expect(store.get(evicted.key)).toBeUndefined()
    expect(store.after(CHAT.key, 0, 10).map(message => message.key)).toEqual([pending.key, last.key])
  })

  it('refuses to evict when every retained message still awaits dispatch', async () => {
    const { store } = await boot(new MemoryMediaPool(), { maxRecords: 1 })
    await store.put(draft('m1'), 'pending')
    await expect(store.put(draft('m2'), 'pending')).rejects.toThrow(ImError)
    await expect(store.put(draft('m3'), 'pending')).rejects.toThrow(/awaiting dispatch/)
  })

  it('sweeps expired settled records and receipts but keeps pending messages', async () => {
    const { store } = await boot(new MemoryMediaPool(), { retentionMs: RETENTION })
    const pending = await store.put(draft('m1'), 'pending')
    const settled = await store.put(draft('m2'), 'none')
    // Another chat whose only message is pending keeps its history untouched by the sweep.
    const otherPending = await store.put(draft('m3', OTHER), 'pending')
    await store.remember('fake:bot|evt-1', { digest: 'd', receivedAt: Date.now() })

    await store.sweep(Date.now())
    expect(store.get(settled.key)).toBeDefined()

    await store.sweep(Date.now() + RETENTION + 1000)
    expect(store.get(pending.key)).toBeDefined()
    expect(store.get(settled.key)).toBeUndefined()
    expect(store.event('fake:bot|evt-1')).toBeUndefined()
    expect(store.latest(OTHER.key)?.key).toBe(otherPending.key)

    await store.settle(pending.key, { kind: 'ignored' })
    await store.sweep(Date.now() + RETENTION + 1000)
    expect(store.latest(CHAT.key)).toBeUndefined()
  })

  it('refreshes a chat identity only when it changed', async () => {
    const { store } = await boot()
    await Promise.all([store.touchChat(CHAT), store.touchChat(CHAT)])
    await store.touchChat(CHAT)
    expect(store.chat(CHAT.key)).toEqual(CHAT)
    await store.touchChat({ ...CHAT, ref: { id: 'chat', type: 'topic' } })
    expect(store.chat(CHAT.key)?.ref.type).toBe('topic')
    await store.touchChat({ ...CHAT, source: ImSourceId('other') })
    expect(store.chat(CHAT.key)?.source).toBe('other')
  })

  it('keeps the seq counter when a chat identity is refreshed while a message is queued', async () => {
    const { store } = await boot()
    await store.touchChat(CHAT)
    // The put is still queued when the identity change starts, so the write must re-read the counter.
    const queued = store.put(draft('m1'), 'none')
    await store.touchChat({ ...CHAT, source: ImSourceId('other') })
    expect((await queued).seq).toBe(1)
    // A counter rolled back to 0 here would hand out seq 1 a second time.
    expect((await store.put(draft('m2'), 'none')).seq).toBe(2)
  })

  it('fails writes before start and after dispose', async () => {
    const closed = new ImStore(new Context(), Config({ sources: [] }))
    await expect(closed.put(draft('m1'), 'none')).rejects.toThrow(/not open/)
    await expect(closed.remember('k', { digest: 'd', receivedAt: 0 })).rejects.toThrow(ImError)
    await expect(closed.sweep(0)).rejects.toThrow(ImError)

    const { store } = await boot()
    await store.put(draft('m1'), 'none')
    await store.dispose()
    await expect(store.put(draft('m2'), 'none')).rejects.toThrow(ImError)
    // A second dispose finds no open domain and stays a no-op.
    await store.dispose()
  })
})

describe('ImStore stored-record validation', () => {
  it('validates the outcomes a restart reads back', async () => {
    const pool = new MemoryMediaPool()
    const first = await boot(pool)
    const bare = await first.store.put(draft('m1'), 'pending')
    const reasoned = await first.store.put(draft('m2', CHAT, 'two'), 'pending')
    await first.store.settle(bare.key, { kind: 'ignored' })
    await first.store.settle(reasoned.key, { kind: 'ignored', reason: 'no listener claimed it' })
    await first.store.dispose()

    // The reopened store validates every stored row through the domain schema, outcomes included.
    const second = await boot(pool)
    expect(second.store.state(bare.key)?.outcome).toEqual({ kind: 'ignored' })
    expect(second.store.state(reasoned.key)?.outcome).toEqual({ kind: 'ignored', reason: 'no listener claimed it' })
  })

  it('indexes message aliases across reopen and removes them on sweep', async () => {
    const pool = new MemoryMediaPool()
    const first = await boot(pool)
    const stored = await first.store.put({ ...draft('m-canon', CHAT, 'hello'), aliases: ['REFIDX_1'] }, 'none')
    expect(first.store.get(ImMessageKey('fake:bot', 'REFIDX_1'))?.key).toBe(stored.key)
    await first.store.dispose()

    const second = await boot(pool)
    expect(second.store.get(ImMessageKey('fake:bot', 'REFIDX_1'))?.key).toBe(stored.key)
    await second.store.sweep(Date.now() + 2 * second.store.config.retentionMs)
    expect(second.store.get(ImMessageKey('fake:bot', 'REFIDX_1'))).toBeUndefined()
  })

  it('refuses a stored row that is not an IM message', async () => {
    const pool = new MemoryMediaPool()
    const first = await boot(pool)
    const stored = await first.store.put(draft('m1'), 'none')
    await first.store.dispose()
    // The row keeps its keys but loses the IM message shape, which the domain schema must reject on reopen.
    pool.media.get(imDomain.name)?.tables.get('messages')?.set(stored.key, { message: 'not a record', dispatch: 'none' })

    await expect(boot(pool)).rejects.toThrow(/stored record|stored message/)
  })
})

describe('ImStore over a pre-v4 home', () => {
  /** One v3 medium of the `im` unit: version 1, the pre-v4 layout (sessions/tasks/intake/output). */
  function v3ImUnit(): { global: unknown; tables: Map<string, Map<string, unknown>> } {
    return {
      global: null,
      tables: new Map<string, Map<string, unknown>>([
        ['sessions', new Map([['im-v3-session', {
          role: 'owner', strategy: 'conversation', agentPreset: 'im', cwd: '/work', createdAt: 1,
        }]])],
        ['tasks', new Map()],
        ['intake', new Map([['intake-1', { appId: 'app', botId: 'fake:bot', tenantId: 'tenant', eventId: 'evt-1', receivedAt: 1 }]])],
        ['output', new Map()],
      ]),
    }
  }

  it('boots beside the abandoned v3 `im` unit instead of reinterpreting it', async () => {
    const pool = new MemoryMediaPool()
    const legacy = v3ImUnit()
    pool.versions.set('im', 1)
    pool.media.set('im', legacy)

    const { store } = await boot(pool)

    // v4 reads its own unit only: no v3 session, task, or receipt becomes a v4 record.
    expect(store.chat(CHAT.key)).toBeUndefined()
    expect(store.pending()).toEqual([])
    const stored = await store.put(draft('m1'), 'none')

    // v4 owns its own unit under its own name, and the v3 one keeps its bytes.
    expect(imDomain.name).toBe('im_messages')
    expect(pool.versions.get('im_messages')).toBe(1)
    expect(pool.media.get('im_messages')?.tables.get('messages')?.has(stored.key)).toBe(true)
    expect(pool.versions.get('im')).toBe(1)
    expect(pool.media.get('im')).toBe(legacy)
    expect([...(legacy.tables.get('sessions')?.keys() ?? [])]).toEqual(['im-v3-session'])
  })

  it('is what the old unit identity would refuse, so the name had to move', async () => {
    const pool = new MemoryMediaPool()
    pool.versions.set('im', 1)
    pool.media.set('im', v3ImUnit())
    const { facility } = await boot(pool)

    // The same name at the v4 layout version: a `single`-layout unit is exact-version only, and the domain layer has no
    // migration or reset primitive, so this is the boot failure the rename removes.
    await expect(facility.open({ ...imDomain, name: 'im', version: 2 }))
      .rejects.toMatchObject({ code: 'version-mismatch' })
  })
})
