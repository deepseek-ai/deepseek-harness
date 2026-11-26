/** Derived tables: built-in rows, transactional writes, fork visibility, failure reports, and rebuilding from events. @module */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { DerivedTables } from '../src/derive.ts'
import type { DerivableEvent, Derivation, DerivationFailure } from '../src/derive.ts'
import { SqliteSessionPersistence } from '../src/persistence.ts'
import type { SqliteStoreOptions } from '../src/sqlite.ts'
import { SqlFiles } from '../src/sql.ts'
import { DERIVATIONS, headSegment, sqliteLogs } from './fixtures/store.ts'

const id = SessionId('derived')
const header = (session: SessionId = id): SessionHeader => ({ version: SESSION_FORMAT_VERSION, id: session, createdAt: 0, isSeeded: false })
const callId = (seq: number): ToolCallId => brandString<ToolCallId>(`call-${seq}`)
const call = (seq: number, name: string): SessionEvent<'tool/call'> => ({ type: 'tool/call', seq: SessionSeq(seq), time: 100 + seq,
  data: { turn: 1, step: 0, callId: callId(seq), name, arguments: '{}' } })
const result = (seq: number, of: number, code?: string): SessionEvent<'tool/result'> => ({ type: 'tool/result', surfaceOp: 'append',
  sourceEventSeqs: [SessionSeq(of)], seq: SessionSeq(seq), time: 100 + seq,
  data: { turn: 1, step: 0, message: createToolResultMessage({ callId: callId(of), content: [{ type: 'text', text: 'done' }], isError: code !== undefined }),
    ...code === undefined ? {} : { error: { name: 'ToolError', code } } } })
const assistant = (seq: number): SessionEvent<'assistant/message'> => ({ type: 'assistant/message', surfaceOp: 'append', seq: SessionSeq(seq), time: 100 + seq,
  data: { turn: 1, step: 2, stream: [], usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 },
    message: createAssistantMessage({ content: [{ type: 'text', text: 'answer' }], source: { provider: 'deepseek', model: 'deepseek-chat' } }) } })
const title = (seq: number, text = `title ${seq}`): SessionEvent<'session/title'> => ({ type: 'session/title', seq: SessionSeq(seq), time: seq,
  data: { title: text, messageSeqs: [], source: { kind: 'user' } } })

/** A derivation over Session titles, versioned by the test. */
const titles = (version: number, derive: Derivation['derive'], columns: Derivation['columns'] = { title: 'TEXT NOT NULL' }): Derivation => ({
  name: 'titles', version, types: ['session/title'], columns, derive })
const titleOf = (event: DerivableEvent): string => {
  const data = event.data
  if (typeof data !== 'object' || data === null || !('title' in data) || typeof data.title !== 'string') throw new TypeError('title event without a title')
  return data.title
}

async function fixture(overrides: Partial<SqliteStoreOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-derive-')), path = join(root, 'sessions.sqlite')
  const stores = [sqliteLogs(path, root, overrides)]
  const inspect = new DatabaseSync(path)
  onTestFinished(async () => {
    inspect.close()
    try { for (const store of stores) await store.close() } finally { await rm(root, { recursive: true, force: true }) }
  })
  /** Close the current store and open the same database under other options. */
  const reopen = async (next: Partial<SqliteStoreOptions>, unmaintained: readonly string[] = []) => {
    await stores.at(-1)?.close()
    const store = sqliteLogs(path, root, next)
    stores.push(store)
    await store.start()
    await rebuilt(unmaintained)
    return store
  }
  /** Wait until every derived table except the named ones, which the open store does not maintain, has caught up. */
  const rebuilt = (unmaintained: readonly string[] = []) => vi.waitFor(() => {
    expect(inspect.prepare('SELECT count(*) AS behind FROM derivations WHERE cursor IS NOT NULL AND name NOT IN (SELECT value FROM json_each(?))')
      .get(JSON.stringify(unmaintained))).toEqual({ behind: 0 })
  }, { timeout: 10_000 })
  const rows = (sql: string) => inspect.prepare(sql).all().map(row => ({ ...row }))
  const names = (type: 'table' | 'view' | 'index') => rows(`SELECT name FROM sqlite_schema WHERE type = '${type}' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map(row => row.name)
  return { root, path, logs: stores[0] ?? sqliteLogs(path, root), inspect, reopen, rebuilt, rows, names }
}

/**
 * Record each rebuild run: whether it left a table behind, and the stored cursors after it in table-name order,
 * read inside its transaction.
 */
function observeRebuilds(): { behind: boolean; cursors: unknown[] }[] {
  const runs: { behind: boolean; cursors: unknown[] }[] = []
  // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted tables as receiver below.
  const rebuild = DerivedTables.prototype.rebuild
  const spy = vi.spyOn(DerivedTables.prototype, 'rebuild').mockImplementation(function (this: DerivedTables, db) {
    const behind = rebuild.call(this, db)
    runs.push({ behind, cursors: db.prepare('SELECT cursor FROM derivations ORDER BY name').all().map(row => row.cursor) })
    return behind
  })
  onTestFinished(() => { spy.mockRestore() })
  return runs
}

describe('built-in derivations', () => {
  const derive = (name: string, event: DerivableEvent) => {
    const derivation = DERIVATIONS.find(entry => entry.name === name)
    if (derivation === undefined) throw new Error(`Missing derivation ${name}`)
    expect(derivation.types).toContain(event.type)
    return derivation.derive(event)
  }
  const summary = { provider: 'deepseek', model: 'deepseek-reasoner', usage: { inputTokens: 40, outputTokens: 8, cacheWriteTokens: 2, reasoningTokens: 6 },
    shadowedTokenCount: 900, shadowedRange: { start: 2, end: 9 }, shadowedSeqs: [2, 9] }

  it('reads a model call and its token usage from an assistant message and a compaction summary', () => {
    expect(derive('llm_calls', assistant(4))).toEqual([104, 'deepseek', 'deepseek-chat', 1, 2, 10, 5, 3, null, null])
    expect(derive('llm_calls', { type: 'compaction/summary', seq: 7, time: 70, data: summary }))
      .toEqual([70, 'deepseek', 'deepseek-reasoner', null, null, 40, 8, null, 2, 6])
  })

  it('yields no model call for a message without usage or a summary without its route', () => {
    const { usage: _usage, ...unmetered } = assistant(4).data
    expect(derive('llm_calls', { ...assistant(4), data: unmetered })).toBeUndefined()
    expect(derive('llm_calls', { ...assistant(4), data: { ...assistant(4).data, turn: 'first' } })).toBeUndefined()
    expect(derive('llm_calls', { type: 'compaction/summary', seq: 7, time: 70, data: { ...summary, provider: undefined } })).toBeUndefined()
    expect(derive('llm_calls', { type: 'compaction/summary', seq: 7, time: 70, data: null })).toBeUndefined()
  })

  it('reads a tool call and yields none for a call without a name', () => {
    expect(derive('tool_calls', call(3, 'read_file'))).toEqual([103, 'read_file', 1, 0])
    expect(derive('tool_calls', { type: 'tool/call', seq: 3, time: 0, data: { turn: 1, step: 0 } })).toBeUndefined()
  })

  it('reads a tool result with its call sequence, error flag and error code', () => {
    expect(derive('tool_results', result(5, 3))).toEqual([105, 3, 0, null])
    expect(derive('tool_results', result(5, 3, 'ENOENT'))).toEqual([105, 3, 1, 'ENOENT'])
    const { sourceEventSeqs: _source, ...unsourced } = result(5, 3)
    expect(derive('tool_results', unsourced)).toEqual([105, null, 0, null])
    expect(derive('tool_results', { type: 'tool/result', seq: 5, time: 0, data: { message: 'done' } })).toBeUndefined()
  })

  it('reads a prune and a summary as compactions and yields none without a shadowed range', () => {
    const prune = { shadowedTokenCount: 120, shadowedRange: { start: 1, end: 4 }, shadowedSeqs: [1, 4] }
    expect(derive('compactions', { type: 'compaction/prune', seq: 6, time: 60, data: prune })).toEqual([60, 'prune', 120, 1, 4])
    expect(derive('compactions', { type: 'compaction/summary', seq: 7, time: 70, data: summary })).toEqual([70, 'summary', 900, 2, 9])
    expect(derive('compactions', { type: 'compaction/prune', seq: 6, time: 60, data: { shadowedTokenCount: 120 } })).toBeUndefined()
  })
})

describe('derived rows', () => {
  it('stores the rows of each built-in table beside their events', async () => {
    const { logs, rows } = await fixture()
    const writer = await logs.create(header())
    await writer.append([call(0, 'read_file'), result(1, 0), assistant(2), title(3)]); await writer.close()
    expect(rows('SELECT seq, time, tool, turn, step FROM tool_calls')).toEqual([{ seq: 0, time: 100, tool: 'read_file', turn: 1, step: 0 }])
    expect(rows('SELECT seq, time, call_seq, is_error, error_code FROM tool_results')).toEqual([{ seq: 1, time: 101, call_seq: 0, is_error: 0, error_code: null }])
    expect(rows('SELECT seq, provider, model, turn, step, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens FROM llm_calls'))
      .toEqual([{ seq: 2, provider: 'deepseek', model: 'deepseek-chat', turn: 1, step: 2, input_tokens: 10, output_tokens: 5,
        cache_read_tokens: 3, cache_write_tokens: null, reasoning_tokens: null }])
    expect(rows('SELECT count(*) AS count FROM compactions')).toEqual([{ count: 0 }])
    expect(rows('SELECT name, version, cursor FROM derivations ORDER BY name')).toEqual(
      ['compactions', 'llm_calls', 'tool_calls', 'tool_results'].map(name => ({ name, version: 1, cursor: null })))
  })

  it('commits derived rows in the transaction of their events and rolls them back with it', async () => {
    const { logs, inspect, rows } = await fixture()
    const writer = await logs.create(header()); await writer.flush()
    const db = await logs['database']()
    const sql = vi.spyOn(db, 'exec')
    onTestFinished(() => { sql.mockRestore() })
    await writer.append([call(0, 'read_file'), result(1, 0)])
    expect(sql.mock.calls.filter(([statement]) => statement === 'COMMIT')).toHaveLength(1)
    sql.mockRestore()
    expect(rows('SELECT seq FROM tool_calls UNION ALL SELECT seq FROM tool_results')).toEqual([{ seq: 0 }, { seq: 1 }])
    inspect.exec("CREATE TRIGGER refuse_event BEFORE INSERT ON events WHEN NEW.seq = 4 BEGIN SELECT RAISE(ABORT, 'event refused'); END")
    await expect(writer.append([call(2, 'write_file'), result(3, 2), assistant(4)])).rejects.toThrow('event refused')
    expect(rows('SELECT seq FROM tool_calls UNION ALL SELECT seq FROM tool_results')).toEqual([{ seq: 0 }, { seq: 1 }])
    inspect.exec('DROP TRIGGER refuse_event')
    await writer.append([call(2, 'write_file'), result(3, 2), assistant(4)]); await writer.close()
    expect(rows('SELECT seq FROM tool_calls')).toEqual([{ seq: 0 }, { seq: 2 }])
    expect(rows('SELECT seq FROM llm_calls')).toEqual([{ seq: 4 }])
  })

  it('shows a fork its inherited rows and its own, and none the parent stored after the cut', async () => {
    const { logs, rows } = await fixture()
    const child = SessionId('child')
    const parent = await logs.create(header())
    const prefix = [call(0, 'read_file'), result(1, 0), assistant(2), call(3, 'grep')]
    await parent.append([...prefix, assistant(4)])
    const marker: SessionEvent<'session/end-seed'> = { type: 'session/end-seed', seq: SessionSeq(4), time: 0, data: { inherited: true } }
    const fork = await logs.create({ ...header(child), isSeeded: true }, { inheritedEventCount: SessionLogOffset(4),
      parentSource: { sessionId: id, endSeq: SessionLogOffset(4), events: [...prefix, marker, result(5, 3), assistant(6), call(7, 'write_file')] } })
    await fork.close()
    await parent.append([result(5, 3, 'ETIMEDOUT'), call(6, 'list_dir')]); await parent.close()
    const calls = (session: SessionId) => rows(`SELECT seq FROM session_llm_calls WHERE session_id = '${session}' ORDER BY seq`).map(row => row.seq)
    expect(calls(child)).toEqual([2, 6])
    expect(calls(id)).toEqual([2, 4])
    const tools = (session: SessionId) => rows(`SELECT seq, tool, result_seq, is_error, error_code, duration_ms FROM session_tools
      WHERE session_id = '${session}' ORDER BY seq`)
    expect(tools(child)).toEqual([
      { seq: 0, tool: 'read_file', result_seq: 1, is_error: 0, error_code: null, duration_ms: 1 },
      { seq: 3, tool: 'grep', result_seq: 5, is_error: 0, error_code: null, duration_ms: 2 },
      { seq: 7, tool: 'write_file', result_seq: null, is_error: null, error_code: null, duration_ms: null },
    ])
    expect(tools(id)).toEqual([
      { seq: 0, tool: 'read_file', result_seq: 1, is_error: 0, error_code: null, duration_ms: 1 },
      { seq: 3, tool: 'grep', result_seq: 5, is_error: 1, error_code: 'ETIMEDOUT', duration_ms: 2 },
      { seq: 6, tool: 'list_dir', result_seq: null, is_error: null, error_code: null, duration_ms: null },
    ])
    expect(rows(`SELECT seq FROM session_tool_results WHERE session_id = '${child}'`).map(row => row.seq)).toEqual([1, 5])
  })

  it('reports the first event a derivation throws on, stores every event, and keeps the other tables current', async () => {
    const reportDerivation = vi.fn<(failure: DerivationFailure) => void>()
    const failure = new Error('derivation refused')
    const { logs, rows } = await fixture({ reportDerivation, derivations: [...DERIVATIONS,
      titles(1, () => { throw failure }), { ...titles(1, event => [titleOf(event)]), name: 'kept_titles' }] })
    const writer = await logs.create(header())
    await writer.append([call(0, 'read_file'), title(1), title(2)]); await writer.close()
    // The event is not stored yet when its derivation runs, so the report names no Segment.
    expect(reportDerivation.mock.calls).toStrictEqual([[{ kind: 'row', derivation: 'titles', seq: 1, segment: undefined, error: failure }]])
    expect((await logs.stat(id))?.eventCount).toBe(3)
    expect(rows('SELECT count(*) AS count FROM titles')).toEqual([{ count: 0 }])
    expect(rows('SELECT seq, title FROM kept_titles')).toEqual([{ seq: 1, title: 'title 1' }, { seq: 2, title: 'title 2' }])
    expect(rows('SELECT seq FROM tool_calls')).toEqual([{ seq: 0 }])
  })

  it('reports the first row its table refuses with the Segment that holds the event, and stores every event', async () => {
    const reportDerivation = vi.fn<(failure: DerivationFailure) => void>()
    const alternate = titles(1, event => [event.seq % 2 === 1 ? null : titleOf(event)])
    const { logs, inspect, rows } = await fixture({ reportDerivation, derivations: [alternate] })
    const writer = await logs.create(header())
    await writer.append([title(0), title(1), title(2), title(3)]); await writer.close()
    expect(reportDerivation).toHaveBeenCalledOnce()
    const failure = reportDerivation.mock.calls[0]?.[0]
    if (failure?.kind !== 'row' || !(failure.error instanceof Error)) throw new Error('expected a refused row')
    expect(failure).toStrictEqual({ kind: 'row', derivation: 'titles', seq: 1, segment: headSegment(inspect, id), error: failure.error })
    expect(failure.error.message).toContain('NOT NULL constraint failed: titles.title')
    expect(rows('SELECT seq FROM titles')).toEqual([{ seq: 0 }, { seq: 2 }])
    expect(rows('SELECT count(*) AS count FROM events')).toEqual([{ count: 4 }])
  })

  it('reports the first failure of each table separately', async () => {
    const reportDerivation = vi.fn<(failure: DerivationFailure) => void>()
    const refused = (name: string): Derivation => ({ ...titles(1, () => { throw new Error(`${name} refused`) }), name })
    const { logs } = await fixture({ reportDerivation, derivations: [refused('first_titles'), refused('second_titles')] })
    const writer = await logs.create(header())
    await writer.append([title(0), title(1)]); await writer.close()
    expect(reportDerivation.mock.calls.map(([failure]) => failure)).toStrictEqual([
      { kind: 'row', derivation: 'first_titles', seq: 0, segment: undefined, error: new Error('first_titles refused') },
      { kind: 'row', derivation: 'second_titles', seq: 0, segment: undefined, error: new Error('second_titles refused') },
    ])
  })

  it('recreates and refills a derived table that is recorded as current but missing', async () => {
    const { logs, inspect, reopen, rows } = await fixture()
    const writer = await logs.create(header())
    await writer.append([call(0, 'read_file')]); await writer.close()
    await logs.close()
    inspect.exec('DROP TABLE tool_calls')
    const restarted = await reopen({})
    expect(rows('SELECT seq, tool FROM tool_calls')).toEqual([{ seq: 0, tool: 'read_file' }])
    const later = await restarted.create(header(SessionId('later')))
    await later.append([call(0, 'write_file')]); await later.close()
    expect(rows("SELECT tool FROM session_tools WHERE session_id = 'later'")).toEqual([{ tool: 'write_file' }])
  })

  it('stores the events and skips the rows of a derived table that vanished under the running store', async () => {
    const reportDerivation = vi.fn<(failure: DerivationFailure) => void>()
    const { logs, inspect, rows } = await fixture({ reportDerivation })
    await logs.start()
    inspect.exec('DROP TABLE tool_calls')
    const writer = await logs.create(header())
    await writer.append([call(0, 'read_file'), result(1, 0)]); await writer.close()
    expect(reportDerivation.mock.calls.map(([failure]) => failure)).toMatchObject([{ kind: 'row', derivation: 'tool_calls', seq: 0 }])
    expect(rows('SELECT count(*) AS events, (SELECT count(*) FROM tool_results) AS results FROM events')).toEqual([{ events: 2, results: 1 }])
  })

  it('leaves the call of a result that replaces an earlier result unnamed', async () => {
    const { logs, rows } = await fixture()
    const replacement: SessionEvent<'tool/result'> = { ...result(2, 1), surfaceOp: { op: 'replace', startSeq: SessionSeq(1), endSeq: SessionSeq(1) } }
    const writer = await logs.create(header())
    await writer.append([call(0, 'read_file'), result(1, 0), replacement]); await writer.close()
    expect(rows('SELECT seq, call_seq FROM tool_results ORDER BY seq')).toEqual([{ seq: 1, call_seq: 0 }, { seq: 2, call_seq: null }])
    expect(rows(`SELECT seq, result_seq FROM session_tools WHERE session_id = '${id}'`)).toEqual([{ seq: 0, result_seq: 1 }])
  })

  it('tries a rebuild again after another writer held the database past the busy timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    onTestFinished(() => { vi.useRealTimers() })
    const reportDerivation = vi.fn<(failure: DerivationFailure) => void>()
    const { logs, reopen, rows } = await fixture({ derivations: [] })
    const writer = await logs.create(header())
    await writer.append([call(0, 'read_file')]); await writer.close()
    const busy = Object.assign(new Error('database is locked'), { errcode: 5 })
    const locked = vi.spyOn(DerivedTables.prototype, 'rebuild').mockImplementationOnce(() => { throw busy })
    onTestFinished(() => { locked.mockRestore() })
    const reopening = reopen({ reportDerivation })
    await vi.waitFor(() => { expect(locked).toHaveBeenCalledOnce() })
    expect(rows('SELECT count(*) AS count FROM tool_calls')).toEqual([{ count: 0 }])
    await vi.advanceTimersByTimeAsync(1000)
    await reopening
    expect(rows('SELECT seq, tool FROM tool_calls')).toEqual([{ seq: 0, tool: 'read_file' }])
    expect(reportDerivation).not.toHaveBeenCalled()
  })

  it('rejects the append and stores nothing when a derived write ends the transaction', async () => {
    const reportDerivation = vi.fn<(failure: DerivationFailure) => void>()
    const { logs, inspect, rows } = await fixture({ reportDerivation })
    await logs.start()
    inspect.exec("CREATE TRIGGER end_transaction BEFORE INSERT ON tool_calls BEGIN SELECT RAISE(ROLLBACK, 'transaction ended'); END")
    const writer = await logs.create(header())
    await expect(writer.append([call(0, 'read_file')])).rejects.toThrow('transaction ended')
    expect(reportDerivation).not.toHaveBeenCalled()
    expect(rows('SELECT count(*) AS events, (SELECT count(*) FROM tool_calls) AS derived FROM events')).toEqual([{ events: 0, derived: 0 }])
    inspect.exec('DROP TRIGGER end_transaction')
    await writer.append([call(0, 'read_file')]); await writer.close()
    expect(rows('SELECT seq, tool FROM tool_calls')).toEqual([{ seq: 0, tool: 'read_file' }])
  })

})

describe('derived schema', () => {
  it('creates the table, indexes and views of an extra derivation', async () => {
    const extra: Derivation = { name: 'title_lengths', version: 3, types: ['session/title'],
      columns: { time: 'INTEGER NOT NULL', length: 'INTEGER NOT NULL' }, indexes: [['length'], ['time', 'length']],
      views: { longest_titles: 'SELECT session_id, max(length) AS length FROM session_title_lengths GROUP BY session_id' },
      derive: event => [event.time, titleOf(event).length] }
    const { logs, names, rows } = await fixture({ derivations: [...DERIVATIONS, extra] })
    const writer = await logs.create(header())
    await writer.append([title(0, 'ab'), title(1, 'abcd')]); await writer.close()
    expect(names('table')).toContain('title_lengths')
    expect(names('index')).toEqual(expect.arrayContaining(['title_lengths_by_length', 'title_lengths_by_time_length', 'tool_results_by_segment_id_call_seq']))
    expect(names('view')).toEqual(['longest_titles', 'segment_extents', 'session_compactions', 'session_events', 'session_heads', 'session_llm_calls',
      'session_segments', 'session_summary',
      'session_title_lengths', 'session_tool_calls', 'session_tool_results', 'session_tools'])
    expect(rows('SELECT session_id, seq, time, length FROM session_title_lengths ORDER BY seq'))
      .toEqual([{ session_id: id, seq: 0, time: 0, length: 2 }, { session_id: id, seq: 1, time: 1, length: 4 }])
    expect(rows('SELECT * FROM longest_titles')).toEqual([{ session_id: id, length: 4 }])
    expect(rows("SELECT version, cursor FROM derivations WHERE name = 'title_lengths'")).toEqual([{ version: 3, cursor: null }])
  })

  it.each([
    ['table', { name: 'Title-Lengths' }],
    ['column', { columns: { 'length INTEGER); DROP TABLE events; --': 'INTEGER' } }],
    ['index column', { indexes: [['length desc']] }],
    ['view', { views: { 'longest titles': 'SELECT 1' } }],
  ] as const)('rejects a %s identifier that is not lowercase snake case at construction', (_kind, invalid) => {
    const derivation: Derivation = { ...titles(1, event => [titleOf(event)]), ...invalid }
    expect(() => new DerivedTables([derivation], () => {}, new SqlFiles())).toThrow(TypeError)
    expect(() => sqliteLogs('/unused/sessions.sqlite', '/unused', { derivations: [derivation] })).toThrow('must be lowercase snake case')
  })
})

describe('rebuilding', () => {
  it('drops a table of another version and refills it from stored events', async () => {
    const { logs, reopen, rows } = await fixture({ derivations: [titles(1, event => [titleOf(event)])] })
    const writer = await logs.create(header())
    // The long title is stored compressed, so the rebuild decodes both codecs.
    await writer.append([title(0), title(1, 'long '.repeat(400))]); await writer.close()
    expect(rows('SELECT seq, title FROM titles')).toEqual([{ seq: 0, title: 'title 0' }, { seq: 1, title: 'long '.repeat(400) }])
    const next = await reopen({ derivations: [titles(2, event => [titleOf(event).length, event.time], { length: 'INTEGER NOT NULL', time: 'INTEGER NOT NULL' })] })
    expect(rows('SELECT seq, length, time FROM titles')).toEqual([{ seq: 0, length: 7, time: 0 }, { seq: 1, length: 2000, time: 1 }])
    expect(rows('SELECT name, version, cursor FROM derivations')).toEqual([{ name: 'titles', version: 2, cursor: null }])
    const reopened = await next.open(id, 'write')
    await reopened.append([title(2, 'after')]); await reopened.close()
    expect(rows('SELECT seq, length FROM titles WHERE seq = 2')).toEqual([{ seq: 2, length: 5 }])
  })

  it('fills a table added to a database that already holds events and resumes a table whose derivation was absent', async () => {
    const withTitles = titles(1, event => [titleOf(event)])
    const { logs, reopen, rows } = await fixture({ derivations: [withTitles] })
    const writer = await logs.create(header())
    await writer.append([title(0), call(1, 'read_file'), result(2, 1)]); await writer.close()
    const without = await reopen({ derivations: DERIVATIONS }, ['titles'])
    expect(rows('SELECT seq, tool FROM tool_calls')).toEqual([{ seq: 1, tool: 'read_file' }])
    expect(rows('SELECT seq, call_seq FROM tool_results')).toEqual([{ seq: 2, call_seq: 1 }])
    expect(rows("SELECT version, cursor FROM derivations WHERE name = 'titles'")).toEqual([{ version: 1, cursor: 3 }])
    const later = await without.create(header(SessionId('later')))
    await later.append([title(0, 'unseen')]); await later.close()
    expect(rows('SELECT title FROM titles')).toEqual([{ title: 'title 0' }])
    await reopen({ derivations: [withTitles, ...DERIVATIONS] })
    expect(rows('SELECT title FROM titles ORDER BY title')).toEqual([{ title: 'title 0' }, { title: 'unseen' }])
    expect(rows('SELECT count(*) AS behind FROM derivations WHERE cursor IS NOT NULL')).toEqual([{ behind: 0 }])
  })

  it.each([
    [999, [[true, 500], [false, null]]],
    [1000, [[true, 500], [true, 1000], [false, null]]],
    [1001, [[true, 500], [true, 1000], [false, null]]],
  ] as const)('rebuilds %i events in runs of 500, each leaving the cursor where it stopped', async (count, expected) => {
    const { logs, reopen, rows } = await fixture({ derivations: [titles(1, event => [titleOf(event)])] })
    const writer = await logs.create(header())
    await writer.append(Array.from({ length: count }, (_, seq) => title(seq))); await writer.close()
    const runs = observeRebuilds()
    const next = await reopen({ derivations: [titles(2, event => [titleOf(event)])] })
    await next['rebuilding']
    expect(runs).toEqual(expected.map(([behind, cursor]) => ({ behind, cursors: [cursor] })))
    expect(rows('SELECT count(*) AS count, min(seq) AS first, max(seq) AS last FROM titles')).toEqual([{ count, first: 0, last: count - 1 }])
    expect((await next['database']()).isTransaction).toBe(false)
  })

  it('never moves the cursor of a table that is further ahead back to where a run stopped', async () => {
    const lengths: Derivation = { ...titles(1, event => [titleOf(event).length], { length: 'INTEGER NOT NULL' }), name: 'title_lengths' }
    const derivations = [titles(1, event => [titleOf(event)]), lengths]
    const { logs, inspect, reopen, rows } = await fixture({ derivations })
    const writer = await logs.create(header())
    await writer.append(Array.from({ length: 1200 }, (_, seq) => title(seq))); await writer.close(); await logs.close()
    // The state of an interrupted rebuild: lengths derived through event 800, titles not at all.
    inspect.exec("DELETE FROM titles; DELETE FROM title_lengths WHERE seq >= 800; UPDATE derivations SET cursor = 0 WHERE name = 'titles'; UPDATE derivations SET cursor = 800 WHERE name = 'title_lengths'")
    const runs = observeRebuilds()
    const next = await reopen({ derivations })
    await next['rebuilding']
    expect(runs).toEqual([
      { behind: true, cursors: [800, 500] }, { behind: true, cursors: [1000, 1000] }, { behind: false, cursors: [null, null] },
    ])
    expect(rows('SELECT (SELECT count(*) FROM titles) AS titles, (SELECT count(*) FROM title_lengths) AS lengths')).toEqual([{ titles: 1200, lengths: 1200 }])
  })

  it('reports the first stored event it cannot decode and derives the rest', async () => {
    const reportDerivation = vi.fn<(failure: DerivationFailure) => void>()
    const { logs, inspect, reopen, rows } = await fixture({ derivations: [titles(1, event => [titleOf(event)])] })
    const writer = await logs.create(header())
    await writer.append([title(0), title(1), title(2), title(3)]); await writer.close()
    inspect.exec('DROP TRIGGER events_no_update')
    inspect.exec("UPDATE events SET data = '{' WHERE seq IN (1, 2)")
    const eventNo = rows('SELECT event_no FROM events WHERE seq = 1')[0]?.event_no
    await reopen({ reportDerivation, derivations: [titles(2, event => [titleOf(event)])] })
    expect(reportDerivation).toHaveBeenCalledOnce()
    const failure = reportDerivation.mock.calls[0]?.[0]
    expect(failure).toStrictEqual({ kind: 'event', eventNo, error: failure?.error })
    expect(failure?.error).toBeInstanceOf(SyntaxError)
    expect(rows('SELECT seq FROM titles')).toEqual([{ seq: 0 }, { seq: 3 }])
    expect(rows('SELECT cursor FROM derivations')).toEqual([{ cursor: null }])
  })

  it('reports a derivation that throws during a rebuild with the Segment of the stored event', async () => {
    const reportDerivation = vi.fn<(failure: DerivationFailure) => void>()
    const { logs, inspect, reopen, rows } = await fixture({ derivations: [titles(1, event => [titleOf(event)])] })
    const writer = await logs.create(header())
    await writer.append([title(0), title(1)]); await writer.close()
    const failure = new Error('derivation refused')
    await reopen({ reportDerivation, derivations: [titles(2, (event) => { if (event.seq === 1) throw failure; return [titleOf(event)] })] })
    expect(reportDerivation.mock.calls).toStrictEqual([[{ kind: 'row', derivation: 'titles', seq: 1, segment: headSegment(inspect, id), error: failure }]])
    expect(rows('SELECT seq FROM titles')).toEqual([{ seq: 0 }])
  })

  it('reports a rebuild that stops and resumes it at the next start', async () => {
    const reportDerivation = vi.fn<(failure: DerivationFailure) => void>()
    const { logs, path, root, inspect, reopen, rows } = await fixture({ derivations: [titles(1, event => [titleOf(event)])] })
    const writer = await logs.create(header())
    await writer.append([title(0), title(1)]); await writer.close(); await logs.close()
    const failure = new Error('rebuild refused')
    const fault = vi.spyOn(DerivedTables.prototype, 'rebuild').mockImplementationOnce(() => { throw failure })
    onTestFinished(() => { fault.mockRestore() })
    const stopped = sqliteLogs(path, root, { reportDerivation, derivations: [titles(2, event => [titleOf(event)])] })
    await stopped.start()
    await stopped['rebuilding']
    expect(reportDerivation.mock.calls).toStrictEqual([[{ kind: 'rebuild', error: failure }]])
    await stopped.close()
    fault.mockRestore()
    expect(inspect.prepare("SELECT cursor FROM derivations WHERE name = 'titles'").get()).toEqual({ cursor: 0 })
    expect(rows('SELECT count(*) AS count FROM titles')).toEqual([{ count: 0 }])
    await reopen({ derivations: [titles(2, event => [titleOf(event)])] })
    expect(rows('SELECT seq FROM titles')).toEqual([{ seq: 0 }, { seq: 1 }])
  })

  it('fills only the table that is behind when two tables read the same events', async () => {
    const kept = titles(1, event => [titleOf(event)])
    const { logs, inspect, reopen, rows } = await fixture({ derivations: [kept] })
    const writer = await logs.create(header())
    await writer.append([title(0), title(1)]); await writer.close(); await logs.close()
    // A current table is not rewritten: a row removed from it stays absent.
    inspect.exec('DELETE FROM titles WHERE seq = 0')
    await reopen({ derivations: [kept, { ...titles(1, event => [titleOf(event).length], { length: 'INTEGER NOT NULL' }), name: 'title_lengths' }] })
    expect(rows('SELECT seq, length FROM title_lengths')).toEqual([{ seq: 0, length: 7 }, { seq: 1, length: 7 }])
    expect(rows('SELECT seq FROM titles')).toEqual([{ seq: 1 }])
  })

  it('resumes each table from its own stored cursor', async () => {
    const derivations = [...DERIVATIONS, titles(1, event => [titleOf(event)])]
    const { logs, inspect, reopen, rows } = await fixture({ derivations })
    const writer = await logs.create(header())
    await writer.append([title(0), title(1), call(2, 'read_file'), title(3)]); await writer.close(); await logs.close()
    // The state of an interrupted rebuild: titles derived through the second event, tool calls not at all.
    inspect.exec("DELETE FROM titles; DELETE FROM tool_calls; UPDATE derivations SET cursor = 2 WHERE name = 'titles'; UPDATE derivations SET cursor = 0 WHERE name = 'tool_calls'")
    await reopen({ derivations })
    expect(rows('SELECT seq FROM titles')).toEqual([{ seq: 3 }])
    expect(rows('SELECT seq, tool FROM tool_calls')).toEqual([{ seq: 2, tool: 'read_file' }])
  })

  it('leaves a table that is behind as it is when its derivation is not registered', async () => {
    const { logs, path, root, inspect, rows } = await fixture({ derivations: [titles(1, event => [titleOf(event)])] })
    const writer = await logs.create(header())
    await writer.append([title(0), title(1)]); await writer.close(); await logs.close()
    inspect.exec("UPDATE derivations SET cursor = 1 WHERE name = 'titles'")
    const other = sqliteLogs(path, root, { derivations: DERIVATIONS })
    onTestFinished(() => other.close())
    await other.start()
    // The rebuild this open scheduled has ended, so what follows is its whole effect.
    await other['rebuilding']
    expect(rows('SELECT name FROM derivations WHERE cursor IS NOT NULL')).toEqual([{ name: 'titles' }])
    await other.close()
    expect(rows("SELECT cursor FROM derivations WHERE name = 'titles'")).toEqual([{ cursor: 1 }])
    expect(rows('SELECT seq FROM titles')).toEqual([{ seq: 0 }, { seq: 1 }])
  })

  it('does not rebuild once the store is closing and resumes at the next start', async () => {
    const { logs, path, root, inspect, reopen, rows } = await fixture({ derivations: [titles(1, event => [titleOf(event)])] })
    const writer = await logs.create(header())
    await writer.append([title(0), title(1)]); await writer.close(); await logs.close()
    const runs = observeRebuilds()
    const interrupted = sqliteLogs(path, root, { derivations: [titles(2, event => [titleOf(event)])] })
    // Closing begins before the open finishes, so it precedes the first rebuild turn whatever the scheduling.
    const starting = interrupted.start(), closing = interrupted.close()
    await starting
    await closing
    await interrupted['rebuilding']
    expect(runs).toEqual([])
    expect(inspect.prepare("SELECT cursor FROM derivations WHERE name = 'titles'").get()).toEqual({ cursor: 0 })
    expect(rows('SELECT count(*) AS count FROM titles')).toEqual([{ count: 0 }])
    await reopen({ derivations: [titles(2, event => [titleOf(event)])] })
    expect(rows('SELECT seq FROM titles')).toEqual([{ seq: 0 }, { seq: 1 }])
  })
})

describe('provider reports', () => {
  async function provider(root?: string) {
    const directory = root ?? await mkdtemp(join(tmpdir(), 'dsh-sqlite-derive-provider-'))
    const ctx = new Context()
    if (root === undefined) onTestFinished(() => rm(directory, { recursive: true, force: true }))
    onTestFinished(() => ctx.fiber.dispose())
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    onTestFinished(() => { warn.mockRestore() })
    const persistence = new SqliteSessionPersistence(ctx, ctx, { root: directory }, {
      hasStoredJsonl: async () => false, list: async () => [], stat: async () => undefined,
      prepare: async () => { throw new Error('no legacy history') },
    })
    const warnings = () => warn.mock.calls.map(([message]) => String(message))
    return { root: directory, ctx, persistence, warnings }
  }

  it('warns once with the table, event and Segment when a table refuses rows, and stores the events', async () => {
    const { root, persistence, warnings } = await provider()
    await persistence.start()
    const db = new DatabaseSync(join(root, '.segments', 'sessions.sqlite'))
    onTestFinished(() => { db.close() })
    db.exec("CREATE TRIGGER refuse_row BEFORE INSERT ON tool_calls BEGIN SELECT RAISE(ABORT, 'row refused'); END")
    const writer = await persistence.create(header())
    await writer.append([call(0, 'read_file'), call(1, 'write_file')]); await writer.close()
    expect(warnings()).toEqual([`Derived table tool_calls skipped the row of event 0 in Segment ${headSegment(db, id)}; `
      + 'its later skipped rows are not logged until restart: Error: row refused'])
    expect(db.prepare('SELECT count(*) AS events, (SELECT count(*) FROM tool_calls) AS derived FROM events').get()).toEqual({ events: 2, derived: 0 })
  })

  it('warns once without a Segment when a derivation throws before its event is stored, and stores the events', async () => {
    const { persistence, warnings } = await provider()
    // The provider builds its own built-in derivations, so the fault is placed on the list its store holds.
    const held: readonly Derivation[] = persistence['sqlite']['derived']['derivations']
    const toolCalls = held.find(derivation => derivation.name === 'tool_calls')
    if (toolCalls === undefined) throw new Error('Missing derivation tool_calls')
    vi.spyOn(toolCalls, 'derive').mockImplementation(() => { throw new Error('derivation refused') })
    const writer = await persistence.create(header())
    await writer.append([result(0, 0), call(1, 'read_file'), call(2, 'write_file')]); await writer.close()
    expect(warnings()).toEqual(['Derived table tool_calls skipped the row of event 1; its later skipped rows are not logged until restart: Error: derivation refused'])
    expect((await persistence.stat(id))?.eventCount).toBe(3)
  })

  it('warns once with the event number when a rebuild passes over stored events it cannot decode', async () => {
    const first = await provider()
    const writer = await first.persistence.create(header())
    await writer.append([call(0, 'read_file'), call(1, 'write_file'), call(2, 'grep')]); await writer.close()
    await first.ctx.fiber.dispose()
    const db = new DatabaseSync(join(first.root, '.segments', 'sessions.sqlite'))
    onTestFinished(() => { db.close() })
    // Two damaged events, and a table that has to be read out of them again.
    db.exec(`DROP TRIGGER events_no_update; UPDATE events SET data = '{' WHERE seq < 2;
      DELETE FROM tool_calls; UPDATE derivations SET cursor = 0 WHERE name = 'tool_calls'`)
    const eventNo = db.prepare('SELECT event_no FROM events WHERE seq = 0').get()?.event_no
    const second = await provider(first.root)
    await second.persistence.start()
    await vi.waitFor(() => { expect(db.prepare('SELECT count(*) AS behind FROM derivations WHERE cursor IS NOT NULL').get()).toEqual({ behind: 0 }) })
    expect(second.warnings()).toEqual([expect.stringMatching(new RegExp(`^Derived tables passed over stored event ${String(eventNo)}, which cannot be decoded; `
      + 'later undecodable events are not logged until restart: SyntaxError: .+'))])
    expect(db.prepare('SELECT seq, tool FROM tool_calls').all()).toEqual([{ seq: 2, tool: 'grep' }])
  })

  it('warns that rebuilding stopped when a rebuild fails', async () => {
    const fault = vi.spyOn(DerivedTables.prototype, 'rebuild').mockImplementationOnce(() => { throw new Error('rebuild refused') })
    onTestFinished(() => { fault.mockRestore() })
    const { persistence, warnings } = await provider()
    await persistence.start()
    await vi.waitFor(() => {
      expect(warnings()).toEqual(['Derived tables stopped rebuilding and resume at the next start: Error: rebuild refused'])
    })
  })
})
