import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionSearchCursor, SessionQueryErrorCode } from '@deepseek-ai/dsh-session-query'
import {
  buildEventWhere,
  buildSessionWhere,
  FTS_HIGHLIGHT_END,
  FTS_HIGHLIGHT_START,
  makeSnippet,
  normalizeEventRequest,
  normalizeSessionRequest,
  quoteFtsData,
  requestFingerprint,
  SQLITE_FTS5_OUTER_PREDICATE_LIMIT,
  SQLITE_MAX_PAGE_LIMIT,
  type NormalizedEventRequest,
  type NormalizedSessionRequest,
} from '../src/query.ts'

const limits = { defaultLimit: 2, maxLimit: 3 }

function expectCode(code: SessionQueryErrorCode): Error {
  return expect.objectContaining({ code }) as Error
}

describe('SQLite search request normalization', () => {
  it('normalizes both scopes, defaults arrays and limits, and preserves cursors', () => {
    expect(normalizeSessionRequest({ query: '  alpha\n beta  ' }, limits)).toEqual({
      query: 'alpha beta',
      sessionFilters: [],
      eventFilters: [],
      limit: 2,
    })
    expect(normalizeSessionRequest({
      query: 'needle',
      sessionFilters: [{ kind: 'availability', values: ['live'] }],
      eventFilters: [{ kind: 'surface', values: ['current'] }],
      limit: 3,
      cursor: brandString<SessionSearchCursor>('next'),
    }, limits)).toEqual({
      query: 'needle',
      sessionFilters: [{ kind: 'availability', values: ['live'] }],
      eventFilters: [{ kind: 'surface', values: ['current'] }],
      limit: 3,
      cursor: brandString<SessionSearchCursor>('next'),
    })
    expect(normalizeEventRequest({ sessionId: brandString<SessionId>('s'), query: 'needle' }, limits)).toEqual({
      sessionId: brandString<SessionId>('s'),
      query: 'needle',
      filters: [],
      limit: 2,
    })
    expect(normalizeEventRequest({
      sessionId: brandString<SessionId>('s'),
      query: 'needle',
      filters: [{ kind: 'seq', from: 1 }],
      cursor: brandString<SessionSearchCursor>('next'),
    }, limits)).toEqual({
      sessionId: brandString<SessionId>('s'),
      query: 'needle',
      filters: [{ kind: 'seq', from: 1 }],
      limit: 2,
      cursor: brandString<SessionSearchCursor>('next'),
    })
  })

  it('rejects non-text, blank, non-integer, non-positive, and oversized requests', () => {
    expect(() => normalizeSessionRequest({ query: 1 as never }, limits))
      .toThrow(expectCode('SESSION_QUERY_INVALID_QUERY'))
    expect(() => normalizeSessionRequest({ query: ' \n ' }, limits))
      .toThrow(expectCode('SESSION_QUERY_INVALID_QUERY'))
    expect(() => normalizeSessionRequest({ query: 'bad\0query' }, limits))
      .toThrow(expectCode('SESSION_QUERY_INVALID_QUERY'))
    expect(() => normalizeEventRequest({ sessionId: 1 as never, query: 'x' }, limits))
      .toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    expect(() => normalizeEventRequest({
      sessionId: brandString<SessionId>('s'),
      query: 'x',
      cursor: 1 as never,
    }, limits)).toThrow(expectCode('SESSION_QUERY_INVALID_CURSOR'))
    expect(() => normalizeSessionRequest({
      query: 'x',
      eventFilters: [{ kind: 'text', text: 'x' } as never],
    }, limits)).toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    expect(() => normalizeSessionRequest({
      query: 'x',
      eventFilters: [{} as never],
    }, limits)).toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    for (const limit of [1.5, 0, 4]) {
      expect(() => normalizeEventRequest({ sessionId: brandString<SessionId>('s'), query: 'x', limit }, limits))
        .toThrow(expectCode('SESSION_QUERY_INVALID_LIMIT'))
    }
    expect(() => normalizeEventRequest({
      sessionId: brandString<SessionId>('s'),
      query: 'x',
      limit: SQLITE_MAX_PAGE_LIMIT + 1,
    }, { defaultLimit: 1, maxLimit: SQLITE_MAX_PAGE_LIMIT + 1 }))
      .toThrow(expectCode('SESSION_QUERY_INVALID_LIMIT'))
  })

  it('materializes owned filter values during normalization', () => {
    const values = ['live'] as Array<'live' | 'persisted'>
    const filter = { kind: 'availability' as const, values }
    const request = { query: 'needle', sessionFilters: [filter] }
    const normalized = normalizeSessionRequest(request, limits)

    values[0] = 'persisted'
    request.sessionFilters.push({ kind: 'availability', values: ['persisted'] })
    expect(normalized.sessionFilters).toEqual([{ kind: 'availability', values: ['live'] }])
  })
})

describe('SQLite search predicate compilation', () => {
  it('compiles all logical-session clauses including empty and nullable values', () => {
    expect(buildSessionWhere([])).toEqual({ sql: '', params: [], predicateCount: 0 })
    expect(buildSessionWhere([{ kind: 'id', values: [] }])).toEqual({
      sql: '0',
      params: [],
      predicateCount: 1,
    })
    expect(buildSessionWhere([{ kind: 'id', values: [brandString<SessionId>('a'), brandString<SessionId>('b')] }])).toEqual({
      sql: 'session_id IN (?, ?)',
      params: [brandString<SessionId>('a'), brandString<SessionId>('b')],
      predicateCount: 1,
    })
    expect(buildSessionWhere([{ kind: 'cwd', values: [] }])).toEqual({
      sql: '0',
      params: [],
      predicateCount: 1,
    })
    expect(buildSessionWhere([{ kind: 'cwd', values: [null] }])).toEqual({
      sql: '(cwd IS NULL)',
      params: [],
      predicateCount: 1,
    })
    expect(buildSessionWhere([{ kind: 'cwd', values: ['/a'] }])).toEqual({
      sql: '(cwd IN (?))',
      params: ['/a'],
      predicateCount: 1,
    })
    expect(buildSessionWhere([{ kind: 'parent', values: [brandString<SessionId>('p'), null] }])).toEqual({
      sql: '(parent_session IN (?) OR parent_session IS NULL)',
      params: [brandString<SessionId>('p')],
      predicateCount: 1,
    })
    expect(buildSessionWhere([
      { kind: 'created-at', from: 1, to: 2 },
      { kind: 'availability', values: [] },
      { kind: 'availability', values: ['live', 'live'] },
      { kind: 'availability', values: ['live', 'persisted'] },
    ])).toEqual({
      sql: 'CAST(created_at AS INTEGER) >= ? AND CAST(created_at AS INTEGER) <= ? AND 0 AND live = 1',
      params: [1, 2],
      predicateCount: 4,
    })
    expect(buildSessionWhere([{ kind: 'created-at' }])).toEqual({
      sql: '',
      params: [],
      predicateCount: 0,
    })
  })

  it('compiles every event clause and empty lists', () => {
    expect(buildEventWhere([
      { kind: 'seq', from: 1 },
      { kind: 'time', to: 9 },
      { kind: 'type', values: ['user/message'] },
      { kind: 'surface', values: ['current', 'log-only'] },
    ])).toEqual({
      sql: 'CAST(seq AS INTEGER) >= ? AND CAST(time AS INTEGER) <= ? AND type IN (?) AND surface IN (?, ?)',
      params: [1, 9, 'user/message', 'current', 'log-only'],
      predicateCount: 4,
    })
    expect(buildEventWhere([
      { kind: 'type', values: [] },
      { kind: 'surface', values: [] },
    ])).toEqual({ sql: '0 AND 0', params: [], predicateCount: 2 })
  })

  it('rejects predicate builders above the supported FTS5 outer budget', () => {
    const filters = Array.from(
      { length: SQLITE_FTS5_OUTER_PREDICATE_LIMIT },
      () => ({ kind: 'id' as const, values: [brandString<SessionId>('safe')] }),
    )

    expect(buildSessionWhere(filters).predicateCount).toBe(SQLITE_FTS5_OUTER_PREDICATE_LIMIT)
    expect(() => buildSessionWhere([
      ...filters,
      { kind: 'id', values: [brandString<SessionId>('over')] },
    ])).toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
  })

  it('rejects runtime-unknown filter discriminants in both SQL builders', () => {
    expect(() => buildSessionWhere([{ kind: 'future' } as never]))
      .toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    expect(() => buildEventWhere([{ kind: 'future' } as never]))
      .toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    expect(() => buildSessionWhere([{ kind: 'availability', values: ['future'] } as never]))
      .toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    expect(() => buildSessionWhere([{} as never]))
      .toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
  })
})

describe('SQLite query identity and presentation', () => {
  it('quotes all caller MATCH syntax as data', () => {
    expect(quoteFtsData('say "needle" OR *')).toBe('"say ""needle"" OR *"')
  })

  it('canonicalizes request and filter ordering in both scopes', () => {
    const sessionA: NormalizedSessionRequest = {
      query: 'needle',
      limit: 2,
      sessionFilters: [
        { kind: 'cwd', values: ['/b', '/a'] },
        { kind: 'parent', values: [null, brandString<SessionId>('p')] },
        { kind: 'id', values: [brandString<SessionId>('same'), brandString<SessionId>('same')] },
        { kind: 'created-at', from: 1 },
      ],
      eventFilters: [{ kind: 'time', to: 9 }],
    }
    const sessionB: NormalizedSessionRequest = {
      query: 'needle',
      limit: 2,
      sessionFilters: [
        { kind: 'created-at', from: 1 },
        { kind: 'id', values: [brandString<SessionId>('same'), brandString<SessionId>('same')] },
        { kind: 'parent', values: [brandString<SessionId>('p'), null] },
        { kind: 'cwd', values: ['/a', '/b'] },
      ],
      eventFilters: [{ kind: 'time', to: 9 }],
    }
    expect(requestFingerprint(sessionA)).toBe(requestFingerprint(sessionB))

    const eventA: NormalizedEventRequest = {
      sessionId: brandString<SessionId>('s'),
      query: 'needle',
      limit: 2,
      filters: [{ kind: 'seq' }, { kind: 'surface', values: ['shadowed', 'current'] }],
    }
    const eventB: NormalizedEventRequest = {
      sessionId: brandString<SessionId>('s'),
      query: 'needle',
      limit: 2,
      filters: [{ kind: 'surface', values: ['current', 'shadowed'] }, { kind: 'seq' }],
    }
    expect(requestFingerprint(eventA)).toBe(requestFingerprint(eventB))
    expect(requestFingerprint(eventA)).not.toBe(requestFingerprint({ ...eventB, sessionId: brandString<SessionId>('other') }))
  })

  it('normalizes, bounds, and positions snippets by Unicode code point', () => {
    expect(makeSnippet('  short\ntext  ', 20)).toBe('short text')
    expect(makeSnippet(`abcde${FTS_HIGHLIGHT_START}f${FTS_HIGHLIGHT_END}`, 1)).toBe('…')
    expect(makeSnippet('abcdefghij', 5)).toBe('abcd…')
    expect(makeSnippet(`ab${FTS_HIGHLIGHT_START}c${FTS_HIGHLIGHT_END}defghij`, 5)).toBe('…bcd…')
    expect(makeSnippet(`ab${FTS_HIGHLIGHT_START}c${FTS_HIGHLIGHT_END}defghij`, 3)).toBe('…c…')
    expect(makeSnippet(`abcde${FTS_HIGHLIGHT_START}f${FTS_HIGHLIGHT_END}`, 2)).toBe('…f')
    expect(makeSnippet(`abcde${FTS_HIGHLIGHT_START}f${FTS_HIGHLIGHT_END}`, 5)).toBe('…cdef')
    expect(makeSnippet(`  x—${FTS_HIGHLIGHT_START}café${FTS_HIGHLIGHT_END}\n y  `, 20))
      .toBe('x—café y')
  })
})
