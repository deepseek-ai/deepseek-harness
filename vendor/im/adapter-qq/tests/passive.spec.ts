/**
 * Passive-reply bookkeeping : the window and the budget of one inbound event, `msg_seq`
 * accounting and retry idempotency. Pure unit tests — no bot, no network.
 */
import { describe, expect, it } from 'vitest'
import {
  PassiveConfig,
  PassiveManager,
  referrerOf,
  WINDOW_MARGIN_MS,
  type QQReferrer,
} from '@deepseek-ai/cordis-plugin-im-adapter-qq'

const GROUP = 'group:FBB1D91204242AAB8B61A0179A6245B0'
const DIRECT = 'user:DD8246C68EC19CAF8D2AA76941180EA4'

/** A clock the tests move by hand. */
interface Clock {
  now: number
}

/** Manager over a normalized passive config. */
function createManager(passive: Partial<PassiveConfig> = {}, options: { max?: number } = {}) {
  const clock: Clock = { now: 1_700_000_000_000 }
  const config = PassiveConfig(passive as PassiveConfig)
  const manager = new PassiveManager({
    config,
    now: () => clock.now,
    ...options.max === undefined ? {} : { max: options.max },
  })
  return { manager, clock, config }
}

/** A referrer of one inbound group message. */
function groupReferrer(clock: Clock, input: Partial<QQReferrer> = {}): QQReferrer {
  return { msg_id: 'ROBOT1.0_in', receivedAt: clock.now, chatType: 'group', chatId: GROUP, ...input }
}

/** A referrer of one button click (no `msg_id`). */
function clickReferrer(clock: Clock, input: Partial<QQReferrer> = {}): QQReferrer {
  return { event_id: 'INTERACTION_CREATE:abc', receivedAt: clock.now, chatType: 'group', chatId: GROUP, ...input }
}

describe('PassiveManager windows', () => {
  it('grants the 5 replies of a group message', () => {
    const { manager, clock } = createManager()
    expect(manager.remaining(groupReferrer(clock))).toBe(5)
  })

  it('grants the 4 replies of a C2C message', () => {
    const { manager, clock } = createManager()
    expect(manager.remaining(groupReferrer(clock, { chatType: 'direct', chatId: DIRECT, msg_id: 'ROBOT1.0_dm' }))).toBe(4)
  })

  it('reads the window and the budget from config', () => {
    const { manager, clock } = createManager({
      groupWindowMs: 30_000,
      groupReplies: 2,
      c2cWindowMs: 90_000,
      c2cReplies: 1,
    })
    const message = groupReferrer(clock)
    const direct = groupReferrer(clock, { chatType: 'direct', chatId: DIRECT })
    expect(manager.remaining(message)).toBe(2)
    expect(manager.remaining(direct)).toBe(1)
    // Each chat type counts its own window: the group's 30 s has passed, the C2C 90 s has not.
    clock.now = message.receivedAt + 30_000
    expect(manager.remaining(message)).toBe(0)
    expect(manager.remaining(direct)).toBe(1)
  })

  it('answers nothing without a referrer or without a passive id', () => {
    const { manager, clock } = createManager()
    expect(manager.remaining(undefined)).toBe(0)
    // No passive id at all: the window bookkeeping cannot name the reply it would book.
    const noMessageId: QQReferrer = { receivedAt: clock.now, chatType: 'group', chatId: GROUP }
    expect(manager.remaining(noMessageId)).toBe(0)
  })

  it('closes the window one safety margin before the platform does', () => {
    const { manager, clock } = createManager({ groupWindowMs: 60_000 })
    const referrer = groupReferrer(clock)
    const until = referrer.receivedAt + 60_000 - WINDOW_MARGIN_MS
    clock.now = until - 1
    expect(manager.remaining(referrer)).toBe(5)
    clock.now = until
    // The window is gone: the adapter answers actively instead of passively.
    expect(manager.remaining(referrer)).toBe(0)
  })
})

describe('PassiveManager claim', () => {
  it('numbers replies from seqBase, rising by one per reply', () => {
    const { manager, clock, config } = createManager()
    expect(config.seqBase).toBe(2)
    const referrer = groupReferrer(clock)
    expect(manager.claim(referrer)?.seq).toBe(2)
    expect(manager.claim(referrer)?.seq).toBe(3)
    expect(manager.claim(referrer)?.seq).toBe(4)
    expect(manager.claim(referrer)).toMatchObject({ key: 'ROBOT1.0_in', field: 'msg_id', chatId: GROUP, reused: false })
  })

  it('honours a configured seqBase', () => {
    const { manager, clock } = createManager({ seqBase: 7 })
    const referrer = groupReferrer(clock)
    expect(manager.claim(referrer)?.seq).toBe(7)
    expect(manager.claim(referrer)?.seq).toBe(8)
  })

  it('stops at the group budget of 5 replies and reports no budget afterwards', () => {
    const { manager, clock } = createManager()
    const referrer = groupReferrer(clock)
    for (let index = 0; index < 5; index++) manager.claim(referrer)
    expect(manager.claim(referrer)).toBeUndefined()
    expect(manager.remaining(referrer)).toBe(0)
  })

  it('stops at the C2C budget of 4 replies', () => {
    const { manager, clock } = createManager()
    const referrer = groupReferrer(clock, { chatType: 'direct', chatId: DIRECT, msg_id: 'ROBOT1.0_dm' })
    for (let index = 0; index < 4; index++) expect(manager.claim(referrer)).toBeDefined()
    expect(manager.claim(referrer)).toBeUndefined()
  })

  it('refuses to book once the window is closed', () => {
    const { manager, clock } = createManager({ groupWindowMs: 10_000 })
    const referrer = groupReferrer(clock)
    clock.now = referrer.receivedAt + 10_000
    expect(manager.claim(referrer)).toBeUndefined()
  })

  it('does not consume budget when remaining() is read many times', () => {
    const { manager, clock } = createManager()
    const referrer = groupReferrer(clock)
    for (let index = 0; index < 20; index++) manager.remaining(referrer)
    expect(manager.claim(referrer)?.seq).toBe(2)
    expect(manager.remaining(referrer)).toBe(4)
  })

  it('books every passive id on its own', () => {
    const { manager, clock } = createManager()
    expect(manager.claim(groupReferrer(clock))?.seq).toBe(2)
    expect(manager.claim(groupReferrer(clock))?.seq).toBe(3)
    expect(manager.claim(groupReferrer(clock, { msg_id: 'ROBOT1.0_other' }))?.seq).toBe(2)
    expect(manager.claim(groupReferrer(clock, { chatId: DIRECT, chatType: 'direct', msg_id: 'ROBOT1.0_dm' }))?.seq).toBe(2)
    expect(manager.size).toBe(3)
  })

  it('answers a click with event_id and never claims a missing id', () => {
    const { manager, clock } = createManager()
    const click = manager.claim(clickReferrer(clock))
    expect(click).toMatchObject({ field: 'event_id', key: 'INTERACTION_CREATE:abc', seq: 2 })
    // A click without an event id names no passive reply, so the manager refuses to claim a sequence.
    expect(manager.claim({ receivedAt: clock.now, chatType: 'group', chatId: GROUP })).toBeUndefined()
  })

  it('reuses the sequence of the same idempotency key (a retried part must not send twice)', () => {
    const { manager, clock } = createManager()
    const referrer = groupReferrer(clock)
    const first = manager.claim(referrer, { idempotencyKey: 'op-1:0' })
    const retried = manager.claim(referrer, { idempotencyKey: 'op-1:0' })
    expect(first?.seq).toBe(2)
    expect(retried).toMatchObject({ seq: 2, reused: true })
    // The budget was spent once: the next *different* part takes the next sequence.
    expect(manager.claim(referrer, { idempotencyKey: 'op-1:1' })).toMatchObject({ seq: 3, reused: false })
    expect(manager.remaining(referrer)).toBe(3)
  })

  it('bumps to the next sequence on a fresh claim and keeps that sequence for the retry', () => {
    const { manager, clock } = createManager()
    const referrer = groupReferrer(clock)
    expect(manager.claim(referrer, { idempotencyKey: 'op-2:0' })?.seq).toBe(2)
    expect(manager.claim(referrer, { idempotencyKey: 'op-2:0', fresh: true })).toMatchObject({ seq: 3, reused: false })
    expect(manager.claim(referrer, { idempotencyKey: 'op-2:0' })).toMatchObject({ seq: 3, reused: true })
  })

  it('forgets everything on reset', () => {
    const { manager, clock } = createManager()
    const referrer = groupReferrer(clock)
    manager.claim(referrer)
    manager.claim(referrer)
    manager.reset()
    expect(manager.size).toBe(0)
    expect(manager.claim(referrer)?.seq).toBe(2)
  })

  it('drops the oldest window beyond the bound', () => {
    const { manager, clock } = createManager({}, { max: 2 })
    const first = groupReferrer(clock, { msg_id: 'ROBOT1.0_1' })
    manager.claim(first)
    manager.claim(groupReferrer(clock, { msg_id: 'ROBOT1.0_2' }))
    manager.claim(groupReferrer(clock, { msg_id: 'ROBOT1.0_3' }))
    expect(manager.size).toBe(2)
    // The first window was evicted, so its bookkeeping starts over at seqBase.
    expect(manager.claim(first)?.seq).toBe(2)
  })

  it('keeps the window just booked when the bound is tight', () => {
    const { manager, clock } = createManager({}, { max: 1 })
    const first = groupReferrer(clock, { msg_id: 'ROBOT1.0_1' })
    expect(manager.claim(first)?.seq).toBe(2)
    const second = groupReferrer(clock, { msg_id: 'ROBOT1.0_2' })
    expect(manager.claim(second)?.seq).toBe(2)
    expect(manager.size).toBe(1)
    // The newest window is the one that survived.
    expect(manager.claim(second)?.seq).toBe(3)
  })

  it('retains live windows with idempotency tickets across LRU eviction until they expire', () => {
    const { manager, clock, config } = createManager({}, { max: 2 })
    const first = groupReferrer(clock, { msg_id: 'ROBOT1.0_1' })
    expect(manager.claim(first, { idempotencyKey: 'op-1' })).toMatchObject({ seq: 2, reused: false })
    expect(manager.claim(groupReferrer(clock, { msg_id: 'ROBOT1.0_2' }))?.seq).toBe(2)
    expect(manager.claim(groupReferrer(clock, { msg_id: 'ROBOT1.0_3' }))?.seq).toBe(2)
    // Entry 2 (un-ticketed) was evicted; entry 1 kept its ticket so a retry still reuses seq 2.
    expect(manager.claim(first, { idempotencyKey: 'op-1' })).toMatchObject({ seq: 2, reused: true })

    clock.now += config.groupWindowMs
    expect(manager.claim(groupReferrer(clock, { msg_id: 'ROBOT1.0_4' }))?.seq).toBe(2)
    expect(manager.size).toBe(1)
  })
})

describe('referrerOf', () => {
  const target = { chat: { id: GROUP, type: 'group' as const } }

  it('accepts a referrer of the same chat and nothing else', () => {
    const referrer: QQReferrer = { msg_id: 'ROBOT1.0_in', receivedAt: 1, chatType: 'group', chatId: GROUP }
    expect(referrerOf({ ...target, referrer })).toEqual(referrer)
    // A passive id is scoped to the chat it was received in: answering another chat with it cannot work.
    expect(referrerOf({ ...target, referrer: { ...referrer, chatId: DIRECT } })).toBeUndefined()
    expect(referrerOf(target)).toBeUndefined()
    expect(referrerOf({ ...target, referrer: 'nope' })).toBeUndefined()
  })
})
