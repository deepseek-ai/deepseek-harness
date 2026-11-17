/** Fixed fork prefixes, concurrent write ownership, and durable continuation. @module */
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistenceCreateOptions } from '@deepseek-ai/dsh-session-persistence'
import { SqliteStore } from '../src/sqlite.ts'
import type { SqliteStoreOptions } from '../src/sqlite.ts'
import { sqliteLogs, storedEvents, tailSegment } from './fixtures/store.ts'
import { SessionWriteLease } from '../src/lease.ts'
import { sessionDir } from '../src/paths.ts'

const header = (id: string, isSeeded = false): SessionHeader => ({
  version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 0, isSeeded,
})
const event = (seq: number, text = `parent ${seq}`): SessionEvent<'session/title'> => ({
  type: 'session/title', seq: SessionSeq(seq), time: seq,
  data: { title: text, messageSeqs: [], source: { kind: 'user' } },
})
const seedFor = (prefix: readonly SessionEvent[]): SessionEvent[] => [...prefix, {
  type: 'session/end-seed', seq: SessionSeq(prefix.length), time: 0, data: { inherited: true },
}]
const forkOptions = (source: SessionId, prefix: readonly SessionEvent[]): SessionPersistenceCreateOptions => ({
  inheritedEventCount: SessionLogOffset(prefix.length), parentSource: {
    sessionId: source, endSeq: SessionLogOffset(prefix.length), events: seedFor(prefix),
  },
})

async function fixture(overrides: Partial<SqliteStoreOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-normal-fork-concurrency-'))
  const path = join(root, 'sessions.sqlite')
  const stores: SqliteStore[] = []
  const store = (ownOverrides: Partial<SqliteStoreOptions> = {}) => {
    const logs = sqliteLogs(path, root, { ...overrides, ...ownOverrides })
    stores.push(logs)
    return logs
  }
  onTestFinished(async () => {
    try {
      for (const logs of stores) await logs.close()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  return { root, path, logs: store(), store }
}

async function closingParent(failure?: Error) {
  const { logs } = await fixture()
  const history = Array.from({ length: 4 }, (_, seq) => event(seq))
  const parent = await logs.create(header('parent'))
  await parent.append(history.slice(0, 2))
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const append = logs.append.bind(logs)
  const appending = vi.spyOn(logs, 'append').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined)
    await release.promise
    if (failure !== undefined) throw failure
    await append(...args)
  })
  for (const record of history.slice(2)) await parent.receive(record)
  const closing = parent.close()
  const closed = closing.then(() => undefined, (error: unknown) => error)
  onTestFinished(async () => {
    release.resolve(undefined)
    await closed
    appending.mockRestore()
  })
  await entered.promise
  return { logs, parent, history, release, closed }
}

it('waits for the closing parent batch before cold reads and child creation', async () => {
  const { logs, parent, history, release, closed } = await closingParent()
  let readSettled = false, forkSettled = false
  const reading = logs.open(parent.id, 'read').then(async (reader) => {
    try { return (await reader.read(0, history.length)).events } finally { await reader.close() }
  })
  const readOutcome = reading.then((value) => { readSettled = true; return { value } }, (error: unknown) => {
    readSettled = true; return { error }
  })
  const creating = logs.create(header('child', true), forkOptions(parent.id, history))
  const forkOutcome = creating.then((value) => { forkSettled = true; return { value } }, (error: unknown) => {
    forkSettled = true; return { error }
  })
  try {
    await setImmediate()
    expect(readSettled).toBe(false)
    expect(forkSettled).toBe(false)
    expect((await logs.stat(parent.id))?.eventCount).toBe(2)
    expect(await logs.stat(SessionId('child'))).toBeUndefined()
    release.resolve(undefined)
    expect(await closed).toBeUndefined()
    expect(await readOutcome).toEqual({ value: history })
    const fork = await forkOutcome
    if (!('value' in fork)) throw fork.error
    expect((await fork.value.read()).events).toEqual(seedFor(history))
  } finally {
    release.resolve(undefined)
    const fork = await forkOutcome
    if ('value' in fork) await fork.value.close()
    await Promise.all([readOutcome, closed])
  }
})

it('stops cold reads and child creation when the closing parent batch fails', async () => {
  const failure = new Error('parent batch write failed')
  const { logs, parent, history, release, closed } = await closingParent(failure)
  const reading = logs.open(parent.id, 'read').then(() => undefined, (error: unknown) => error)
  const creating = logs.create(header('child', true), forkOptions(parent.id, history))
    .then(() => undefined, (error: unknown) => error)
  try {
    await setImmediate()
    release.resolve(undefined)
    expect(await closed).toBe(failure)
    expect(await reading).toBe(failure)
    expect(await creating).toBe(failure)
    expect(await logs.stat(SessionId('child'))).toBeUndefined()
    expect((await logs.stat(parent.id))?.eventCount).toBe(2)
  } finally {
    release.resolve(undefined)
    await Promise.all([reading, creating, closed])
  }
})

it('cancels child creation while the closing parent batch is pending', async () => {
  const { logs, parent, history, release, closed } = await closingParent()
  const abort = new AbortController(), reason = new Error('cancel fork while parent closes')
  const creating = logs.create(header('child', true), { ...forkOptions(parent.id, history), signal: abort.signal })
    .then(() => undefined, (error: unknown) => error)
  try {
    await setImmediate()
    abort.abort(reason)
    expect(await logs.stat(SessionId('child'))).toBeUndefined()
    release.resolve(undefined)
    expect(await closed).toBeUndefined()
    expect(await creating).toBe(reason)
    expect(await logs.stat(SessionId('child'))).toBeUndefined()
    expect((await logs.stat(parent.id))?.eventCount).toBe(4)
  } finally {
    release.resolve(undefined)
    await Promise.all([creating, closed])
  }
})

const prefixCases = [0, 1, 4, 8].flatMap(cut => [...new Set([0, 2, 4, 8].map(persisted => Math.min(persisted, cut)))]
  .map(persisted => ({ persisted, cut })))
it.each(prefixCases)('flushes the selected cut $cut after initially persisting up to $persisted events', async ({ persisted, cut }) => {
  const { logs, path, store } = await fixture()
  const history = Array.from({ length: 8 }, (_, seq) => event(seq))
  const parent = await logs.create(header('parent'))
  if (persisted > 0) await parent.append(history.slice(0, persisted))
  for (const record of history.slice(persisted, cut)) await parent.receive(record)
  await parent.flush()
  const prefix = history.slice(0, cut)
  const expectedSeed = seedFor(prefix)
  const child = await logs.create(header('child', true), forkOptions(parent.id, prefix))
  expect((await child.read()).events).toEqual(expectedSeed)
  const shared = cut
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    expect(db.prepare('SELECT base_seq, parent_end_seq FROM segments WHERE segment_uuid = (SELECT tail_segment_uuid FROM traces WHERE trace_uuid = ?)').get(child.id))
      .toEqual({ base_seq: shared, parent_end_seq: shared === 0 ? null : shared })
    expect(storedEvents(db, tailSegment(db, child.id))).toEqual(expectedSeed.slice(shared))
  } finally { db.close() }
  await parent.append(history.slice(cut))
  const childOwn = event(cut + 1, 'child continues')
  await child.append([childOwn])
  expect((await parent.read()).events).toEqual(history)
  expect((await child.read()).events).toEqual([...expectedSeed, childOwn])
  await child.close(); await parent.close(); await logs.close()
  const restarted = store()
  const restored = await restarted.open(child.id, 'write')
  const before = (await restored.read()).events
  expect(before).toEqual([...expectedSeed, childOwn])
  const next = event(before.length, 'child after restart')
  await restored.append([next]); await restored.close()
  const reader = await restarted.open(child.id, 'read')
  try { expect((await reader.read()).events).toEqual([...before, next]) } finally { await reader.close() }
})

it('keeps a cold-history repair before the inherited marker in the child segment across reopen', async () => {
  const { logs, path, store } = await fixture()
  const first: SessionEvent<'turn/start'> = { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } }
  const interrupted: SessionEvent<'turn/end'> = { type: 'turn/end', seq: SessionSeq(1), time: 0,
    data: { turn: 1, reason: { kind: 'interrupted' } } }
  const marker: SessionEvent<'session/end-seed'> = { type: 'session/end-seed', seq: SessionSeq(2), time: 0,
    data: { inherited: true } }
  const parent = await logs.create(header('parent'))
  await parent.append([first]); await parent.close()
  const child = await logs.create(header('child', true), {
    inheritedEventCount: SessionLogOffset(2), parentSource: {
      sessionId: parent.id, endSeq: SessionLogOffset(1), events: [first, interrupted, marker],
    },
  })
  expect(child.inheritedEventCount).toBe(2)
  expect((await child.read()).events).toEqual([first, interrupted, marker])
  await child.close(); await logs.close()
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    expect(db.prepare('SELECT base_seq, parent_end_seq FROM segments WHERE segment_uuid = (SELECT tail_segment_uuid FROM traces WHERE trace_uuid = ?)').get(child.id))
      .toEqual({ base_seq: 1, parent_end_seq: 1 })
    expect(storedEvents(db, tailSegment(db, child.id))).toEqual([interrupted, marker])
  } finally { db.close() }
  const restarted = store()
  const reader = await restarted.open(child.id, 'read')
  try {
    expect(reader.inheritedEventCount).toBe(2)
    expect((await reader.read()).events).toEqual([first, interrupted, marker])
  } finally { await reader.close() }
  const parentReader = await restarted.open(parent.id, 'read')
  try { expect((await parentReader.read()).events).toEqual([first]) } finally { await parentReader.close() }
})

it.each([0, 1, 3, 4, 5, 6, 8])('forks a grandchild at %s across the ancestor and child segments', async (cut) => {
  const { logs, store } = await fixture()
  const history = Array.from({ length: 6 }, (_, seq) => event(seq))
  const parent = await logs.create(header('parent'))
  await parent.append(history)
  const child = await logs.create(header('child', true), forkOptions(parent.id, history.slice(0, 4)))
  await child.append([event(5, 'child 5'), event(6, 'child 6'), event(7, 'child 7')])
  const childHistory = (await child.read()).events
  const prefix = childHistory.slice(0, cut)
  const grandchild = await logs.create(header('grandchild', true), forkOptions(child.id, prefix))
  await Promise.all([
    parent.append([event(6, 'parent after fork')]),
    child.append([event(8, 'child after fork')]),
    grandchild.append([event(cut + 1, 'grandchild own')]),
  ])
  const expected = [...seedFor(prefix), event(cut + 1, 'grandchild own')]
  expect((await grandchild.read()).events).toEqual(expected)
  await grandchild.close(); await child.close(); await parent.close(); await logs.close()
  const restarted = store()
  const reader = await restarted.open(grandchild.id, 'read')
  try { expect((await reader.read()).events).toEqual(expected) } finally { await reader.close() }
})

it('creates siblings at independent cuts while the parent and every child continue', async () => {
  const { logs, store } = await fixture()
  const history = Array.from({ length: 8 }, (_, seq) => event(seq))
  const parent = await logs.create(header('parent'))
  await parent.append(history)
  const cuts = [0, 1, 4, 8]
  const children = await Promise.all(cuts.map(cut => logs.create(header(`child-${cut}`, true), forkOptions(parent.id, history.slice(0, cut)))))
  await Promise.all([parent.append([event(8, 'parent after forks')]), ...children.map((child, index) => child.append([event(cuts[index]! + 1, `child-${index} own`)]))])
  for (const [index, child] of children.entries()) {
    const expected = [...seedFor(history.slice(0, cuts[index])), event(cuts[index]! + 1, `child-${index} own`)]
    expect((await child.read()).events).toEqual(expected)
    await child.close()
  }
  await parent.close(); await logs.close()
  const restarted = store()
  for (const [index, child] of children.entries()) {
    const reader = await restarted.open(child.id, 'read')
    try {
      expect((await reader.read()).events).toEqual([...seedFor(history.slice(0, cuts[index])), event(cuts[index]! + 1, `child-${index} own`)])
    } finally { await reader.close() }
  }
})

it('keeps a captured parent cut while its creator waits for ownership and the parent continues', async () => {
  const { logs, root, store } = await fixture()
  const atLease = Promise.withResolvers<undefined>()
  const continueCreation = Promise.withResolvers<undefined>()
  const other = store({ acquireCreationLease: async (metadata) => {
    const lease = await SessionWriteLease.acquire(sessionDir(root, metadata.cwd, metadata.id), metadata.id)
    atLease.resolve(undefined)
    await continueCreation.promise
    return lease
  } })
  const history = Array.from({ length: 4 }, (_, seq) => event(seq))
  const parent = await logs.create(header('parent'))
  await parent.append(history)
  const options = forkOptions(parent.id, history)
  const creationTail = event(5, 'creation tail')
  const creating = other.create(header('child', true), {
    ...options, parentSource: { ...options.parentSource!, events: [...seedFor(history), creationTail] },
  })
  try {
    await atLease.promise
    await parent.append([event(4, 'parent after captured cut'), event(5, 'parent continues')])
    continueCreation.resolve(undefined)
    const child = await creating
    expect((await child.read()).events).toEqual([...seedFor(history), creationTail])
    await child.append([event(6, 'child continues')])
    expect((await parent.read()).events).toEqual([...history, event(4, 'parent after captured cut'), event(5, 'parent continues')])
    expect((await child.read()).events).toEqual([...seedFor(history), creationTail, event(6, 'child continues')])
  } finally {
    continueCreation.resolve(undefined)
    const result = await Promise.allSettled([creating])
    for (const settled of result) if (settled.status === 'fulfilled') await settled.value.close()
  }
})

it('drains a queued parent prefix owned by this store before sharing it', async () => {
  const { logs } = await fixture()
  const history = [event(0), event(1)]
  const parent = await logs.create(header('parent'))
  await parent.append(history.slice(0, 1))
  await parent.receive(history[1]!)
  const child = await logs.create(header('child', true), forkOptions(parent.id, history))
  expect((await logs.stat(parent.id))?.eventCount).toBe(2)
  expect((await child.read()).events).toEqual(seedFor(history))
  await child.close()
  await parent.close()
})

it('releases child creation ownership when another store owns the unflushed parent prefix', async () => {
  const { logs, store } = await fixture()
  const history = [event(0), event(1)]
  const parent = await logs.create(header('parent'))
  await parent.append(history.slice(0, 1))
  await parent.receive(history[1]!)
  const other = store()
  const options = forkOptions(parent.id, history)
  await expect(other.create(header('child', true), options)).rejects.toMatchObject({ code: 'SESSION_FORK_PREFIX_NOT_PERSISTED' })
  expect(await other.stat(SessionId('child'))).toBeUndefined()
  await parent.flush()
  const child = await other.create(header('child', true), options)
  expect((await child.read()).events).toEqual(seedFor(history))
  await child.close()
  await parent.close()
})

it('allows read handles during writes and transfers exclusive ownership between store instances', async () => {
  const { logs, store } = await fixture()
  const writer = await logs.create(header('shared'))
  await writer.append([event(0)])
  const other = store()
  const reader = await other.open(writer.id, 'read')
  try {
    expect((await reader.read()).events).toEqual([event(0)])
    await expect(other.open(writer.id, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await writer.append([event(1)])
    expect((await reader.read()).events).toEqual([event(0), event(1)])
    await writer.close()
    const nextOwner = await other.open(writer.id, 'write')
    try {
      expect((await nextOwner.read()).events).toEqual([event(0), event(1)])
      await nextOwner.append([event(2)])
      expect((await reader.read()).events).toEqual([event(0), event(1), event(2)])
    } finally { await nextOwner.close() }
  } finally { await reader.close() }
})

it('admits exactly one overlapping fork creation and releases write ownership after close', async () => {
  const { logs, store } = await fixture()
  const history = [event(0), event(1)]
  const parent = await logs.create(header('parent'))
  await parent.append(history); await parent.close()
  const other = store()
  const options = forkOptions(parent.id, history)
  const attempts = await Promise.allSettled([
    logs.create(header('same-child', true), options), other.create(header('same-child', true), options),
  ])
  const winners = attempts.filter(result => result.status === 'fulfilled')
  const failures = attempts.filter(result => result.status === 'rejected')
  expect(winners).toHaveLength(1)
  expect(failures).toHaveLength(1)
  for (const winner of winners) if (winner.status === 'fulfilled') await winner.value.close()
  const reopened = await other.open(SessionId('same-child'), 'write')
  try { expect((await reopened.read()).events).toEqual(seedFor(history)) } finally { await reopened.close() }
})

it('recovers a live child batch after an ordinary SQLite busy failure', async () => {
  const reported = Promise.withResolvers<unknown>()
  const { logs, path } = await fixture({ report: (_id, failure) => { reported.resolve(failure) } })
  const parent = await logs.create(header('parent'))
  const history = [event(0)]
  await parent.append(history); await parent.close()
  const child = await logs.create(header('child', true), forkOptions(parent.id, history))
  const database = await logs['database']()
  database.exec('PRAGMA busy_timeout = 1')
  const own = event(2, 'after busy')
  const blocker = new DatabaseSync(path)
  try {
    blocker.exec('BEGIN IMMEDIATE')
    await child.receive(own)
    expect(await reported.promise).toMatchObject({ errcode: 5 })
    blocker.exec('ROLLBACK')
    await child.flush()
    expect((await child.read()).events).toEqual([...seedFor(history), own])
  } finally { blocker.close(); await child.close() }
})
