import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId, HarnessError , createMessage } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS, TimeoutReason } from '@deepseek-ai/dsh-timeout'
import * as TimeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  SessionId,
  type Session,
  type SessionEvent,
  type SessionHeader,
  type SessionId as SessionIdValue,
} from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import SessionQueryEngine, {
  SessionQueryError,
  SessionSearchCursor,
  type SessionEventSearchHit,
  type SessionEventSearchPage,
  type SessionEventSearchRequest,
  type SessionLineageNode,
  type SessionSearchExecContext,
  type SessionSearchHit,
  type SessionSearchPage,
  type SessionSearchRequest,
  type SessionTitleObservationResult,
} from '@deepseek-ai/dsh-session-query'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as ToolSessionQuery from '@deepseek-ai/dsh-tool-session-query'

const activeContexts: Context[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const ctx of activeContexts.splice(0)) await ctx.fiber.dispose()
  FakeQuery.reset()
})

function header(id: string, cwd: string | undefined, createdAt = 1, parentSession?: SessionIdValue): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt,
    ...cwd === undefined ? {} : { cwd },
    ...parentSession === undefined ? {} : { parentSession },
  }
}

function createSession(
  ctx: Context,
  id: string,
  cwd: string | undefined,
  createdAt = 1,
  parentSession?: SessionIdValue,
): Session {
  return ctx.sessions.create(SessionId(id), {
    meta: {
      createdAt,
      ...cwd === undefined ? {} : { cwd },
      ...parentSession === undefined ? {} : { parentSession },
    },
  })
}

function openStep(session: Session, text = 'prior needle'): void {
  session.append('turn/start', { turn: 1 })
  session.append(
    'user/message',
    createUserMessage({
      content: [{ type: 'text', text }], source: { kind: 'user' },
    }),
    { surfaceOp: 'append' },
  )
  session.append('step/start', { turn: 1, step: 1 })
}

function fakeAgent(session: Session): Agent {
  return { id: session.id, session } as unknown as Agent
}

function sessionHit(
  id: string,
  cwd: string | undefined,
  text = 'needle excerpt',
  parentSession?: SessionIdValue,
): SessionSearchHit {
  return {
    header: header(id, cwd, 100, parentSession),
    live: true,
    persisted: false,
    bestMatch: {
      sessionId: SessionId(id),
      seq: 4,
      type: 'assistant/message',
      time: 200,
      surface: 'current',
      snippet: text,
    },
  }
}

function eventHit(sessionId: SessionIdValue, seq: number, text = 'needle excerpt'): SessionEventSearchHit {
  return {
    sessionId,
    seq,
    type: 'user/message',
    time: 200 + seq,
    surface: 'current',
    snippet: text,
  }
}

class FakeQuery extends SessionQueryEngine {
  static sessionSearch: (
    request: SessionSearchRequest,
    exec?: SessionSearchExecContext,
  ) => Promise<SessionSearchPage<SessionSearchHit>> = () => Promise.resolve({ items: [] })

  static eventSearch: (
    request: SessionEventSearchRequest,
    exec?: SessionSearchExecContext,
  ) => Promise<SessionEventSearchPage> = request => Promise.resolve({
    session: header(request.sessionId, '/work'),
    items: [],
  })

  static sessionRequests: SessionSearchRequest[] = []
  static eventRequests: SessionEventSearchRequest[] = []
  static searchSignals: Array<AbortSignal | undefined> = []
  static titles = new Map<SessionIdValue, string | Error>()

  static reset(): void {
    this.sessionSearch = () => Promise.resolve({ items: [] })
    this.eventSearch = request => Promise.resolve({
      session: header(request.sessionId, '/work'),
      items: [],
    })
    this.sessionRequests = []
    this.eventRequests = []
    this.searchSignals = []
    this.titles = new Map()
  }

  override searchSessions(
    request: SessionSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    FakeQuery.sessionRequests.push(request)
    FakeQuery.searchSignals.push(exec?.signal)
    return FakeQuery.sessionSearch(request, exec)
  }

  override searchEvents(
    request: SessionEventSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    FakeQuery.eventRequests.push(request)
    FakeQuery.searchSignals.push(exec?.signal)
    return FakeQuery.eventSearch(request, exec)
  }

  override async readTitleSnapshots(
    sessionIds: readonly SessionIdValue[],
    signal?: AbortSignal,
  ): Promise<SessionTitleObservationResult[]> {
    const observations = await super.readTitleSnapshots(sessionIds, signal)
    return observations.map((observation): SessionTitleObservationResult => {
      const value = FakeQuery.titles.get(observation.sessionId)
      if (value instanceof Error) {
        return { sessionId: observation.sessionId, status: 'rejected', reason: value }
      }
      if (value === undefined || observation.status === 'rejected') return observation
      return {
        ...observation,
        value: {
          ...observation.value,
          title: {
            title: value,
            messageSeqs: [],
            source: { kind: 'fallback' },
            eventSeq: 0,
            updatedAt: 1,
          },
        },
      }
    })
  }
}

interface Mounted {
  readonly ctx: Context
  readonly fiber: Fiber
  readonly caller: Session
  call(name: string, args: unknown, options?: { agent?: Agent; signal?: AbortSignal }): Promise<ToolExecutionResult>
}

function registerTurnBoundary(ctx: Context): void {
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
}

async function mount(
  config: ToolSessionQuery.Config = {},
  callerCwd: string | null = '/work',
  enforceTimeout = false,
): Promise<Mounted> {
  const ctx = new Context()
  activeContexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  registerTurnBoundary(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (enforceTimeout) await ctx.plugin(TimeoutPolicy)
  await ctx.plugin(FakeQuery)
  const fiber = await ctx.plugin(ToolSessionQuery, config)
  const caller = createSession(ctx, 'caller', callerCwd ?? undefined, 10)
  openStep(caller)
  let calls = 0
  return {
    ctx,
    fiber,
    caller,
    call: (toolName, args, options = {}) => ctx.tools.execute({
      name: toolName,
      arguments: args,
      callId: ToolCallId(`call-${++calls}`),
      signal: options.signal ?? new AbortController().signal,
      ...options.agent === undefined ? { agent: fakeAgent(caller) } : { agent: options.agent },
    }),
  }
}

function text(result: ToolExecutionResult): string {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
}

function errorCode(result: ToolExecutionResult): string | undefined {
  return result.isError ? result.error.info?.code : undefined
}

describe('registration and schemas', () => {
  it('registers the five cursor-free tools, prompt, timeouts, and pure generic presenters, then disposes them', async () => {
    const mounted = await mount({ maxSearchResults: 7, searchTimeoutMs: 1234 })
    const names = mounted.ctx.tools.schemas().map(schema => schema.name)
    expect(names).toEqual([
      'session_search',
      'session_event_search',
      'session_trace',
      'session_event_trace',
      'session_event_read',
    ])
    const sessionSchema = mounted.ctx.tools.schemas().find(schema => schema.name === 'session_search')
    expect(sessionSchema?.parameters).not.toHaveProperty('properties.cursor')
    expect(sessionSchema?.parameters).not.toHaveProperty('properties.limit')
    expect(sessionSchema?.parameters).not.toHaveProperty('properties.cwd')
    expect(mounted.ctx.tools.get('session_search')?.timeoutMs).toBe(1234)
    expect(mounted.ctx.tools.get('session_trace')?.timeoutMs).toBeUndefined()
    const parallelArgs: Record<string, unknown> = {
      session_trace: {},
      session_event_trace: { seq: 0 },
      session_event_read: { seq: 0 },
    }
    for (const [name, args] of Object.entries(parallelArgs)) {
      expect(mounted.ctx.tools.get(name)?.isConcurrencySafe?.(args)).toBe(true)
    }
    expect(mounted.ctx.tools.get('session_search')?.output.render({}, 'rendered'))
      .toEqual([{ type: 'text', text: 'rendered' }])
    expect(mounted.ctx.tools.get('session_search')?.presentCall?.({ query: 'needle' }))
      .toEqual({ card: 'generic', kind: 'search', title: 'Search prior sessions', rawInput: 'needle' })
    expect(mounted.ctx.tools.get('session_event_search')?.presentCall?.({ query: 'needle' }))
      .toEqual({ card: 'generic', kind: 'search', title: 'Search session events', rawInput: 'needle' })
    expect(mounted.ctx.tools.get('session_trace')?.presentCall?.({}))
      .toEqual({ card: 'generic', kind: 'read', title: 'Trace current session' })
    expect(mounted.ctx.tools.get('session_trace')?.presentCall?.({ session_id: 'other' }))
      .toEqual({ card: 'generic', kind: 'read', title: 'Trace session other', rawInput: 'other' })
    expect(mounted.ctx.tools.get('session_event_trace')?.presentCall?.({ session_id: 'other', seq: 3 }))
      .toEqual({
        card: 'generic',
        kind: 'read',
        title: 'Trace event 3',
        rawInput: { session_id: 'other', seq: 3 },
      })
    expect(mounted.ctx.tools.get('session_event_read')?.presentCall?.({ seq: 4 }))
      .toEqual({ card: 'generic', kind: 'read', title: 'Read event 4', rawInput: { seq: 4 } })
    const assembly = await mounted.ctx.systemPrompt.assemble()
    expect(assembly.sections.find(section => section.name === 'tool:session-query')?.text)
      .toContain('prior sessions')

    await mounted.fiber.dispose()
    expect(mounted.ctx.tools.schemas().map(schema => schema.name)).toEqual([])
    expect((await mounted.ctx.systemPrompt.assemble()).sections.map(section => section.name))
      .not.toContain('tool:session-query')
  })

  it('keeps generation-bound searches exclusive while exact observations remain parallel', async () => {
    const mounted = await mount()
    const classifications = [
      ['session_search', { query: 'q' }, 'exclusive'],
      ['session_event_search', { query: 'q' }, 'exclusive'],
      ['session_trace', {}, 'parallel'],
      ['session_event_trace', { seq: 0 }, 'parallel'],
      ['session_event_read', { seq: 0 }, 'parallel'],
    ] as const

    for (const [name, args, kind] of classifications) {
      expect(mounted.ctx.tools.executionMode({
        name,
        arguments: args,
        callId: ToolCallId(`mode-${name}`),
        signal: new AbortController().signal,
        agent: fakeAgent(mounted.caller),
      })).toEqual({ kind })
    }
  })

  it('fails invalid direct config before registering anything', async () => {
    const mounted = await mount()
    for (const maxSearchResults of [0, 1.5, Number.NaN]) {
      expect(() => { ToolSessionQuery.apply(mounted.ctx, { maxSearchResults }) })
        .toThrow('maxSearchResults')
    }
    for (const searchTimeoutMs of [0, 1.5, Number.POSITIVE_INFINITY, MAX_TIMER_DELAY_MS + 1]) {
      expect(() => { ToolSessionQuery.apply(mounted.ctx, { searchTimeoutMs }) })
        .toThrow(`no greater than ${MAX_TIMER_DELAY_MS}`)
    }
    expect(() => { ToolSessionQuery.apply(new Context(), {}) }).toThrow()
  })

  it('expresses the complete Node timer range in the Loader config schema', () => {
    expect(new ToolSessionQuery.Config({ searchTimeoutMs: MAX_TIMER_DELAY_MS }))
      .toEqual({ maxSearchResults: 100, searchTimeoutMs: MAX_TIMER_DELAY_MS })
    expect(() => new ToolSessionQuery.Config({ searchTimeoutMs: 1.5 })).toThrow()
    expect(() => new ToolSessionQuery.Config({ searchTimeoutMs: MAX_TIMER_DELAY_MS + 1 })).toThrow()
  })
})

describe('input validation and translation', () => {
  it.each([
    [{ query: '   ' }, 'SESSION_QUERY_INVALID_QUERY'],
    [{ query: 'bad\0query' }, 'SESSION_QUERY_INVALID_QUERY'],
    [{ query: 'q', session_ids: [] }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', parent_session_ids: [] }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', availability: [] }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', availability: ['archived'] }, 'INVALID_ARGS'],
    [{ query: 'q', event_types: [] }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', event_surfaces: [] }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', event_surfaces: ['hidden'] }, 'INVALID_ARGS'],
    [{ query: 'q', event_seq_from: -1 }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', event_seq_to: Number.MAX_SAFE_INTEGER + 1 }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', event_seq_from: 2, event_seq_to: 1 }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', created_at_from: '2026-07-24T10:00:00' }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', created_at_from: '2026-02-30T10:00:00Z' }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', created_at_from: '2100-02-29T10:00:00Z' }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', created_at_from: '2026-04-31T10:00:00Z' }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', created_at_from: '2026-01-01T24:00:00Z' }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', created_at_from: '2026-01-01T00:60:00Z' }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', created_at_from: '2026-01-01T00:00:60Z' }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', created_at_from: '2026-01-01T00:00:00+24:00' }, 'SESSION_QUERY_INVALID_FILTER'],
    [{ query: 'q', created_at_from: '2026-01-01T00:00:00+00:60' }, 'SESSION_QUERY_INVALID_FILTER'],
    [{
      query: 'q',
      created_at_from: '2026-07-25T00:00:00Z',
      created_at_to: '2026-07-24T00:00:00Z',
    }, 'SESSION_QUERY_INVALID_FILTER'],
  ])('rejects invalid search arguments %#', async (args, code) => {
    const mounted = await mount()
    const result = await mounted.call('session_search', args)
    expect(errorCode(result)).toBe(code)
  })

  it('normalizes the query and compiles inclusive session/event filters with one parent OR clause', async () => {
    const mounted = await mount()
    createSession(mounted.ctx, 'parent', '/work')
    await mounted.call('session_search', {
      query: '  alpha   beta ',
      session_ids: ['a', 'b'],
      created_at_from: '2026-07-24T00:00:00+08:00',
      created_at_to: '2026-07-24T01:00:00+08:00',
      parent_session_ids: ['parent'],
      include_root_sessions: true,
      availability: ['live'],
      event_seq_from: 2,
      event_seq_to: 9,
      event_time_from: '2026-07-24T00:00:00Z',
      event_time_to: '2026-07-24T01:00:00Z',
      event_types: ['plugin/open-event'],
      event_surfaces: ['shadowed'],
    })
    expect(FakeQuery.sessionRequests).toHaveLength(1)
    expect(FakeQuery.sessionRequests[0]).toEqual({
      query: 'alpha beta',
      sessionFilters: [
        { kind: 'id', values: ['a', 'b'] },
        {
          kind: 'created-at',
          from: Date.parse('2026-07-24T00:00:00+08:00'),
          to: Date.parse('2026-07-24T01:00:00+08:00'),
        },
        { kind: 'availability', values: ['live'] },
        { kind: 'parent', values: ['parent', null] },
        { kind: 'cwd', values: ['/work'] },
      ],
      eventFilters: [
        { kind: 'seq', from: 2, to: 9 },
        {
          kind: 'time',
          from: Date.parse('2026-07-24T00:00:00Z'),
          to: Date.parse('2026-07-24T01:00:00Z'),
        },
        { kind: 'type', values: ['plugin/open-event'] },
        { kind: 'surface', values: ['shadowed'] },
      ],
    })
  })

  it.each([
    ['one fractional digit', '2026-07-24T00:00:00.1Z', 100],
    ['two fractional digits', '2026-07-24T00:00:00.12Z', 120],
    ['three fractional digits', '2026-07-24T00:00:00.123Z', 123],
  ])('normalizes %s into an exact integer epoch-millisecond filter', async (_case, value, offset) => {
    const mounted = await mount()
    await mounted.call('session_search', {
      query: 'q',
      created_at_from: value,
    })
    const expected = Date.parse('2026-07-24T00:00:00.000Z') + offset
    expect(Number.isFinite(expected)).toBe(true)
    expect(FakeQuery.sessionRequests[0]?.sessionFilters).toContainEqual({
      kind: 'created-at',
      from: expected,
    })
  })

  it('maps exact same-millisecond decimal bounds to adjacent numeric values without collapsing the interval', async () => {
    const mounted = await mount()
    const base = Date.parse('2026-07-24T00:00:00.000Z')
    const result = await mounted.call('session_search', {
      query: 'q',
      created_at_from: '2026-07-24T00:00:00.12300001Z',
      created_at_to: '2026-07-24T08:00:00.1239999+08:00',
    })

    expect(result.isError).toBe(false)
    expect(text(result)).toContain('No prior session matches found.')
    const range = FakeQuery.sessionRequests[0]?.sessionFilters
      ?.find(filter => filter.kind === 'created-at')
    expect(range).toBeDefined()
    if (range?.kind !== 'created-at' || range.from === undefined || range.to === undefined) {
      throw new Error('expected complete created-at range')
    }
    expect(Number.isFinite(range.from)).toBe(true)
    expect(Number.isFinite(range.to)).toBe(true)
    expect(range.from).toBeGreaterThan(base + 123)
    expect(range.from).toBeLessThan(base + 124)
    expect(range.to).toBeGreaterThan(base + 123)
    expect(range.to).toBeLessThan(base + 124)
    expect(range.from).toBeLessThan(range.to)
  })

  it('rejects exact bounds reversed only below one millisecond before calling the provider', async () => {
    const mounted = await mount()
    const result = await mounted.call('session_search', {
      query: 'q',
      created_at_from: '2026-07-24T00:00:00.12300002Z',
      created_at_to: '2026-07-24T00:00:00.12300001Z',
    })

    expect(errorCode(result)).toBe('SESSION_QUERY_INVALID_FILTER')
    expect(FakeQuery.sessionRequests).toEqual([])
  })

  it('compares unequal-length exact remainders with implicit trailing decimal zeroes', async () => {
    const mounted = await mount()
    const ordered = await mounted.call('session_search', {
      query: 'q',
      created_at_from: '2026-07-24T00:00:00.1231Z',
      created_at_to: '2026-07-24T00:00:00.12311Z',
    })
    expect(ordered.isError).toBe(false)

    const reversed = await mounted.call('session_search', {
      query: 'q',
      created_at_from: '2026-07-24T00:00:00.12311Z',
      created_at_to: '2026-07-24T00:00:00.1231Z',
    })
    expect(errorCode(reversed)).toBe('SESSION_QUERY_INVALID_FILTER')
  })

  it('treats trailing-zero fractional spellings as the same exact instant', async () => {
    const mounted = await mount()
    const result = await mounted.call('session_search', {
      query: 'q',
      created_at_from: '2026-07-24T00:00:00.1230000100Z',
      created_at_to: '2026-07-24T00:00:00.12300001Z',
    })

    expect(result.isError).toBe(false)
    expect(FakeQuery.sessionRequests).toHaveLength(1)
  })

  it('maps fractional bounds correctly across zero and for negative pre-epoch milliseconds', async () => {
    const mounted = await mount()
    await mounted.call('session_search', {
      query: 'q',
      created_at_from: '1970-01-01T00:00:00.0000001Z',
      event_time_to: '1969-12-31T23:59:59.9999999Z',
    })
    expect(FakeQuery.sessionRequests[0]?.sessionFilters).toContainEqual({
      kind: 'created-at',
      from: Number.MIN_VALUE,
    })
    expect(FakeQuery.sessionRequests[0]?.eventFilters).toContainEqual({
      kind: 'time',
      to: -Number.MIN_VALUE,
    })

    await mounted.call('session_event_search', {
      query: 'q',
      time_from: '1969-12-31T23:59:59.87600001Z',
      time_to: '1969-12-31T19:59:59.8769999-04:00',
    })
    const range = FakeQuery.eventRequests[0]?.filters?.find(filter => filter.kind === 'time')
    expect(range).toBeDefined()
    if (range?.kind !== 'time' || range.from === undefined || range.to === undefined) {
      throw new Error('expected complete event time range')
    }
    expect(range.from).toBeGreaterThan(-124)
    expect(range.from).toBeLessThan(-123)
    expect(range.to).toBeGreaterThan(-124)
    expect(range.to).toBeLessThan(-123)
    expect(range.from).toBeLessThan(range.to)
  })

  it('rejects a normalized timestamp when the platform parser cannot produce a finite value', async () => {
    const mounted = await mount()
    vi.spyOn(Date, 'parse').mockReturnValueOnce(Number.NaN)

    const result = await mounted.call('session_search', {
      query: 'q',
      created_at_from: '2026-07-24T00:00:00.123456Z',
    })

    expect(errorCode(result)).toBe('SESSION_QUERY_INVALID_FILTER')
    expect(FakeQuery.sessionRequests).toEqual([])
  })

  it('compiles one-sided timestamps and independent root/parent clauses', async () => {
    const mounted = await mount()
    createSession(mounted.ctx, 'parent', '/work')
    await mounted.call('session_search', {
      query: 'q',
      created_at_from: '2024-02-29T00:00Z',
      include_root_sessions: true,
      event_time_to: '2000-02-29T00:00Z',
    })
    expect(FakeQuery.sessionRequests[0]?.sessionFilters).toContainEqual({
      kind: 'created-at',
      from: Date.parse('2024-02-29T00:00Z'),
    })
    expect(FakeQuery.sessionRequests[0]?.sessionFilters).toContainEqual({
      kind: 'parent',
      values: [null],
    })
    expect(FakeQuery.sessionRequests[0]?.eventFilters).toContainEqual({
      kind: 'time',
      to: Date.parse('2000-02-29T00:00Z'),
    })

    await mounted.call('session_search', {
      query: 'q',
      parent_session_ids: ['parent'],
    })
    expect(FakeQuery.sessionRequests[1]?.sessionFilters).toContainEqual({
      kind: 'parent',
      values: ['parent'],
    })
  })
})

describe('workspace authority and lineage redaction', () => {
  it('fails closed without an agent and for direct cross-workspace targets', async () => {
    const mounted = await mount()
    createSession(mounted.ctx, 'outside', '/outside')
    const missing = await mounted.ctx.tools.execute({
      name: 'session_trace',
      arguments: {},
      callId: ToolCallId('missing-agent'),
      signal: new AbortController().signal,
    })
    expect(errorCode(missing)).toBe('SESSION_QUERY_TOOL_MISSING_AGENT')
    const denied = await mounted.call('session_event_read', { session_id: 'outside', seq: 0 })
    expect(errorCode(denied)).toBe('SESSION_QUERY_TOOL_UNAUTHORIZED')
    expect(text(denied)).not.toContain('session "outside"')
  })

  it('allows only self for a null-cwd caller and denies cross-session search', async () => {
    const mounted = await mount({}, null)
    const own = await mounted.call('session_trace', {})
    expect(own.isError).toBe(false)
    expect(text(own)).toContain('Session caller')
    expect(errorCode(await mounted.call('session_search', { query: 'q' })))
      .toBe('SESSION_QUERY_TOOL_UNAUTHORIZED')
    createSession(mounted.ctx, 'other', undefined)
    expect(errorCode(await mounted.call('session_trace', { session_id: 'other' })))
      .toBe('SESSION_QUERY_TOOL_UNAUTHORIZED')
  })

  it('makes hidden and nonexistent parent guesses indistinguishable without calling search', async () => {
    const mounted = await mount()
    const hiddenParent = createSession(mounted.ctx, 'guessed-hidden-parent-secret', '/outside')
    const visibleChild = createSession(
      mounted.ctx,
      'visible-child-of-hidden-parent',
      '/work',
      20,
      hiddenParent.id,
    )
    FakeQuery.sessionSearch = () => Promise.resolve({
      items: [sessionHit(visibleChild.id, '/work', 'must not be discoverable', hiddenParent.id)],
    })

    const hidden = await mounted.call('session_search', {
      query: 'needle',
      parent_session_ids: [hiddenParent.id],
    })
    const missing = await mounted.call('session_search', {
      query: 'needle',
      parent_session_ids: ['guessed-missing-parent'],
    })

    expect(hidden).toEqual(missing)
    expect(text(hidden)).toBe('No prior session matches found.')
    expect(JSON.stringify(hidden)).not.toContain(visibleChild.id)
    expect(FakeQuery.sessionRequests).toEqual([])
  })

  it('deduplicates parent guesses and sends only authorized parents plus the root marker', async () => {
    const mounted = await mount()
    const visible = createSession(mounted.ctx, 'visible-parent', '/work')
    const hidden = createSession(mounted.ctx, 'hidden-parent-filter-secret', '/outside')

    await mounted.call('session_search', {
      query: 'needle',
      parent_session_ids: [visible.id, hidden.id, visible.id, 'missing-parent'],
      include_root_sessions: true,
    })
    await mounted.call('session_search', {
      query: 'needle',
      parent_session_ids: [hidden.id],
      include_root_sessions: true,
    })
    await mounted.call('session_search', {
      query: 'needle',
      parent_session_ids: ['missing-parent'],
      include_root_sessions: true,
    })

    const parentValues = FakeQuery.sessionRequests.map(request =>
      request.sessionFilters?.find(filter => filter.kind === 'parent'))
    expect(parentValues).toEqual([
      { kind: 'parent', values: [visible.id, null] },
      { kind: 'parent', values: [null] },
      { kind: 'parent', values: [null] },
    ])
  })

  it('rejects unrequested or unauthorized records returned during parent preauthorization', async () => {
    const mounted = await mount()
    const requested = SessionId('requested-parent')
    vi.spyOn(mounted.ctx.sessionQuery, 'filterSessions').mockResolvedValueOnce([
      { header: header('unrequested-parent', '/work'), live: true, persisted: false },
      { header: header(requested, '/outside'), live: true, persisted: false },
    ])

    const result = await mounted.call('session_search', {
      query: 'needle',
      parent_session_ids: [requested],
    })

    expect(text(result)).toBe('No prior session matches found.')
    expect(FakeQuery.sessionRequests).toEqual([])
  })

  it('validates every other search filter before parent preauthorization', async () => {
    const mounted = await mount()
    const filterSessions = vi.spyOn(mounted.ctx.sessionQuery, 'filterSessions')

    const result = await mounted.call('session_search', {
      query: 'needle',
      parent_session_ids: ['guessed-parent'],
      event_seq_from: -1,
    })

    expect(errorCode(result)).toBe('SESSION_QUERY_INVALID_FILTER')
    expect(filterSessions).not.toHaveBeenCalled()
    expect(FakeQuery.sessionRequests).toEqual([])
  })

  it('sanitizes parent preauthorization failures without calling search', async () => {
    const mounted = await mount()
    const secret = 'conflict at hidden-parent-preauthorization-secret'
    vi.spyOn(mounted.ctx.sessionQuery, 'filterSessions').mockRejectedValueOnce(
      new SessionQueryError(secret, 'SESSION_QUERY_SOURCE_CONFLICT'),
    )
    const warn = vi.spyOn(mounted.ctx.logger, 'warn').mockImplementation(() => undefined)

    const result = await mounted.call('session_search', {
      query: 'needle',
      parent_session_ids: ['guessed-parent'],
    })

    expect(errorCode(result)).toBe('SESSION_QUERY_TOOL_FAILED')
    expect(text(result)).toBe('Error: session query operation failed')
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(secret))
    expect(FakeQuery.sessionRequests).toEqual([])
  })

  it('sanitizes direct-target authorization failures before event search', async () => {
    const mounted = await mount()
    const target = createSession(mounted.ctx, 'authorization-failure-target', '/work')
    const secret = 'conflict with hidden-authorization-session-secret'
    vi.spyOn(mounted.ctx.sessionQuery, 'filterSessions').mockRejectedValueOnce(
      new SessionQueryError(secret, 'SESSION_QUERY_SOURCE_CONFLICT'),
    )
    const warn = vi.spyOn(mounted.ctx.logger, 'warn').mockImplementation(() => undefined)

    const result = await mounted.call('session_event_search', {
      session_id: target.id,
      query: 'needle',
    })

    expect(errorCode(result)).toBe('SESSION_QUERY_TOOL_FAILED')
    expect(text(result)).toBe('Error: session query operation failed')
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(secret))
    expect(FakeQuery.eventRequests).toEqual([])
  })

  it('preserves parent-preauthorization cancellation and waits for cleanup without logging it', async () => {
    const mounted = await mount()
    const controller = new AbortController()
    const cancellation = new SessionQueryError(
      'parent preauthorization cancelled',
      'SESSION_QUERY_ABORTED',
    )
    const started = Promise.withResolvers<undefined>()
    const abortObserved = Promise.withResolvers<undefined>()
    const cleanup = Promise.withResolvers<undefined>()
    let active = false
    vi.spyOn(mounted.ctx.sessionQuery, 'filterSessions')
      .mockImplementation(async (_filters, signal) => {
        if (signal === undefined) throw new Error('expected parent-authorization signal')
        active = true
        const aborted = new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        started.resolve(undefined)
        await aborted
        abortObserved.resolve(undefined)
        await cleanup.promise
        active = false
        signal.throwIfAborted()
        return []
      })
    const warn = vi.spyOn(mounted.ctx.logger, 'warn').mockImplementation(() => undefined)

    const pending = mounted.call('session_search', {
      query: 'needle',
      parent_session_ids: ['guessed-parent'],
    }, { signal: controller.signal })
    let settled = false
    void pending.then(
      () => { settled = true },
      () => { settled = true },
    )
    await started.promise
    controller.abort(cancellation)
    await abortObserved.promise

    expect(settled).toBe(false)
    expect(active).toBe(true)
    expect(FakeQuery.sessionRequests).toEqual([])

    cleanup.resolve(undefined)
    const result = await pending
    expect(active).toBe(false)
    expect(errorCode(result)).toBe('SESSION_QUERY_ABORTED')
    expect(text(result)).toBe('Error: parent preauthorization cancelled')
    expect(warn).not.toHaveBeenCalled()
  })

  it('redacts an unauthorized ancestor and prunes unauthorized descendant subtrees without hidden ids', async () => {
    const mounted = await mount()
    const hiddenParent = createSession(mounted.ctx, 'hidden-parent-secret', '/outside')
    const target = createSession(mounted.ctx, 'target', '/work', 20, hiddenParent.id)
    const visible = createSession(mounted.ctx, 'visible-child', '/work', 30, target.id)
    const hidden = createSession(mounted.ctx, 'hidden-child-secret', '/outside', 40, target.id)
    createSession(mounted.ctx, 'hidden-grandchild-secret', '/work', 50, hidden.id)
    FakeQuery.titles.set(target.id, 'Target title')
    FakeQuery.titles.set(visible.id, 'Visible title')

    const result = await mounted.call('session_trace', { session_id: target.id })
    const output = text(result)
    expect(output).toContain('Target title')
    expect(output).toContain('visible-child')
    expect(output).toContain('[outside workspace boundary]')
    expect(output).toContain('[outside workspace subtree]')
    expect(output).not.toContain('hidden-parent-secret')
    expect(output).not.toContain('hidden-child-secret')
    expect(output).not.toContain('hidden-grandchild-secret')
  })

  it('sanitizes a real outside-workspace ancestor cycle before the lineage error reaches the model', async () => {
    const mounted = await mount()
    const hiddenA = SessionId('hidden-cycle-a-secret')
    const hiddenB = SessionId('hidden-cycle-b-secret')
    createSession(mounted.ctx, hiddenA, '/outside', 2, hiddenB)
    createSession(mounted.ctx, hiddenB, '/outside', 3, hiddenA)
    const target = createSession(mounted.ctx, 'visible-cycle-target', '/work', 4, hiddenA)

    const result = await mounted.call('session_trace', { session_id: target.id })

    expect(errorCode(result)).toBe('SESSION_QUERY_INVALID_LINEAGE')
    expect(text(result)).toBe('Error: session lineage is invalid')
    const presentation = JSON.stringify(result)
    expect(presentation).not.toContain(hiddenA)
    expect(presentation).not.toContain(hiddenB)
  })

  it.each([
    {
      name: 'sensitive source conflict',
      makeError: () => new SessionQueryError(
        'conflict with hidden-lineage-session-secret',
        'SESSION_QUERY_SOURCE_CONFLICT',
      ),
      code: 'SESSION_QUERY_TOOL_FAILED',
      message: 'session query operation failed',
      secret: 'hidden-lineage-session-secret',
    },
    {
      name: 'typed query error',
      makeError: () => new SessionQueryError(
        'unrelated persistence failure',
        'SESSION_QUERY_PERSISTENCE_FAILED',
      ),
      code: 'SESSION_QUERY_PERSISTENCE_FAILED',
      message: 'session history storage is unavailable',
      secret: 'unrelated persistence failure',
    },
    {
      name: 'plain error',
      makeError: () => new Error('unrelated plain trace failure'),
      code: 'SESSION_QUERY_TOOL_FAILED',
      message: 'session query operation failed',
      secret: 'unrelated plain trace failure',
    },
  ])('sanitizes an unrelated $name from lineage tracing', async ({ makeError, code, message, secret }) => {
    const mounted = await mount()
    const target = createSession(mounted.ctx, 'trace-failure-target', '/work')
    const warn = vi.spyOn(mounted.ctx.logger, 'warn').mockImplementation(() => undefined)
    vi.spyOn(mounted.ctx.sessionQuery, 'traceSession').mockRejectedValueOnce(makeError())

    const result = await mounted.call('session_trace', { session_id: target.id })

    expect(errorCode(result)).toBe(code)
    expect(text(result)).toBe(`Error: ${message}`)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(secret))
  })

  it.each([
    'session_event_trace',
    'session_event_read',
  ] as const)('sanitizes typed service diagnostics from %s', async (toolName) => {
    const mounted = await mount()
    const target = createSession(mounted.ctx, `${toolName}-failure-target`, '/work')
    target.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'event' }], source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )
    const secret = `event missing beside hidden-${toolName}-secret`
    const failure = new SessionQueryError(secret, 'SESSION_QUERY_EVENT_NOT_FOUND')
    if (toolName === 'session_event_trace') {
      vi.spyOn(mounted.ctx.sessionQuery, 'traceEvent').mockRejectedValueOnce(failure)
    } else {
      vi.spyOn(mounted.ctx.sessionQuery, 'readEvent').mockRejectedValueOnce(failure)
    }
    const warn = vi.spyOn(mounted.ctx.logger, 'warn').mockImplementation(() => undefined)

    const result = await mounted.call(toolName, { session_id: target.id, seq: 0 })

    expect(errorCode(result)).toBe('SESSION_QUERY_EVENT_NOT_FOUND')
    expect(text(result)).toBe('Error: session event was not found')
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(secret))
  })

  it.each([
    'session_trace',
    'session_event_trace',
    'session_event_read',
  ] as const)('forwards the exact signal to %s and waits for service cleanup', async (toolName) => {
    const mounted = await mount()
    const target = createSession(mounted.ctx, `cancelled-${toolName}`, '/work')
    target.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'pending exact read' }], source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )
    const controller = new AbortController()
    const cancellation = new SessionQueryError(
      `${toolName} cancelled`,
      'SESSION_QUERY_ABORTED',
    )
    const started = Promise.withResolvers<undefined>()
    const abortObserved = Promise.withResolvers<undefined>()
    const cleanup = Promise.withResolvers<undefined>()
    const warn = vi.spyOn(mounted.ctx.logger, 'warn').mockImplementation(() => undefined)
    let observedSignal: AbortSignal | undefined
    let active = false
    const holdExactRead = async (signal?: AbortSignal): Promise<never> => {
      if (signal === undefined) throw new Error('expected exact tool execution signal')
      observedSignal = signal
      active = true
      const aborted = new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      started.resolve(undefined)
      await aborted
      abortObserved.resolve(undefined)
      await cleanup.promise
      active = false
      signal.throwIfAborted()
      throw new Error('unreachable after exact tool cancellation')
    }
    if (toolName === 'session_trace') {
      vi.spyOn(mounted.ctx.sessionQuery, 'traceSession')
        .mockImplementation((_sessionId, signal) => holdExactRead(signal))
    } else if (toolName === 'session_event_trace') {
      vi.spyOn(mounted.ctx.sessionQuery, 'traceEvent')
        .mockImplementation((_request, signal) => holdExactRead(signal))
    } else {
      vi.spyOn(mounted.ctx.sessionQuery, 'readEvent')
        .mockImplementation((_request, signal) => holdExactRead(signal))
    }
    const args = toolName === 'session_trace'
      ? { session_id: target.id }
      : { session_id: target.id, seq: 0 }

    const pending = mounted.call(toolName, args, { signal: controller.signal })
    let settled = false
    void pending.then(
      () => { settled = true },
      () => { settled = true },
    )
    await started.promise
    controller.abort(cancellation)
    await abortObserved.promise

    expect(settled).toBe(false)
    expect(active).toBe(true)
    expect(observedSignal).toBe(controller.signal)

    cleanup.resolve(undefined)
    const result = await pending
    expect(active).toBe(false)
    expect(errorCode(result)).toBe('SESSION_QUERY_ABORTED')
    expect(text(result)).toBe(`Error: ${toolName} cancelled`)
    expect(warn).not.toHaveBeenCalled()
  })

  it('preserves caller cancellation while a lineage trace is pending', async () => {
    const mounted = await mount()
    const target = createSession(mounted.ctx, 'cancelled-trace-target', '/work')
    const trace = await mounted.ctx.sessionQuery.traceSession(target.id)
    let started!: () => void
    const traceStarted = new Promise<void>((resolve) => { started = resolve })
    let finish!: (value: typeof trace) => void
    vi.spyOn(mounted.ctx.sessionQuery, 'traceSession').mockImplementation(() => {
      started()
      return new Promise<typeof trace>((resolve) => { finish = resolve })
    })
    const controller = new AbortController()
    const cancellation = new SessionQueryError('lineage trace cancelled', 'SESSION_QUERY_ABORTED')

    const pending = mounted.call(
      'session_trace',
      { session_id: target.id },
      { signal: controller.signal },
    )
    await traceStarted
    controller.abort(cancellation)
    finish(trace)
    const result = await pending

    expect(errorCode(result)).toBe('SESSION_QUERY_ABORTED')
    expect(text(result)).toBe('Error: lineage trace cancelled')
  })

  it('gives caller cancellation precedence when a pending trace rejects with invalid lineage', async () => {
    const mounted = await mount()
    const target = createSession(mounted.ctx, 'cancelled-invalid-lineage-target', '/work')
    let started!: () => void
    const traceStarted = new Promise<void>((resolve) => { started = resolve })
    let fail!: (error: SessionQueryError) => void
    vi.spyOn(mounted.ctx.sessionQuery, 'traceSession').mockImplementation(() => {
      started()
      return new Promise((_resolve, reject) => { fail = reject })
    })
    const controller = new AbortController()
    const cancellation = new SessionQueryError('lineage trace cancelled first', 'SESSION_QUERY_ABORTED')

    const pending = mounted.call(
      'session_trace',
      { session_id: target.id },
      { signal: controller.signal },
    )
    await traceStarted
    controller.abort(cancellation)
    fail(new SessionQueryError(
      'session lineage contains a cycle at "hidden-race-secret"',
      'SESSION_QUERY_INVALID_LINEAGE',
    ))
    const result = await pending

    expect(errorCode(result)).toBe('SESSION_QUERY_ABORTED')
    expect(text(result)).toBe('Error: lineage trace cancelled first')
    expect(JSON.stringify(result)).not.toContain('hidden-race-secret')
  })

  it('renders branching descendants in source preorder with one indented marker per pruned subtree', async () => {
    const mounted = await mount()
    const target = createSession(mounted.ctx, 'branch-target', '/work', 20)
    const [targetRecord] = await mounted.ctx.sessionQuery.filterSessions([{
      kind: 'id',
      values: [target.id],
    }])
    if (targetRecord === undefined) throw new Error('expected target record')
    const firstId = SessionId('branch-first')
    const nestedId = SessionId('branch-nested')
    const hiddenId = SessionId('branch-hidden-secret')
    const hiddenDescendantId = SessionId('branch-hidden-descendant-secret')
    const lastId = SessionId('branch-last')
    const descendants: SessionLineageNode[] = [
      {
        session: { ...targetRecord, header: header(firstId, '/work', 30) },
        descendants: [
          {
            session: { ...targetRecord, header: header(nestedId, '/work', 40) },
            descendants: [],
          },
          {
            session: { ...targetRecord, header: header(hiddenId, '/outside', 50) },
            descendants: [{
              session: { ...targetRecord, header: header(hiddenDescendantId, '/work', 60) },
              descendants: [],
            }],
          },
        ],
      },
      {
        session: { ...targetRecord, header: header(lastId, '/work', 70) },
        descendants: [],
      },
    ]
    vi.spyOn(mounted.ctx.sessionQuery, 'traceSession').mockResolvedValue({
      target: targetRecord,
      ancestors: [],
      descendants,
      complete: true,
      root: targetRecord,
    })
    const titleReads: SessionIdValue[] = []
    vi.spyOn(mounted.ctx.sessionQuery, 'readTitleSnapshots').mockImplementation((sessionIds) => {
      titleReads.push(...sessionIds)
      return Promise.resolve([...new Set(sessionIds)].map(sessionId => ({
        sessionId,
        status: 'fulfilled' as const,
        value: { session: header(sessionId, '/work') },
      })))
    })

    const output = text(await mounted.call('session_trace', { session_id: target.id }))
    expect(output.slice(output.indexOf('Descendants:'))).toBe([
      'Descendants:',
      '- branch-first — untitled | 1970-01-01T00:00:00.030Z | live',
      '  - branch-nested — untitled | 1970-01-01T00:00:00.040Z | live',
      '  - [outside workspace subtree]',
      '- branch-last — untitled | 1970-01-01T00:00:00.070Z | live',
    ].join('\n'))
    expect(titleReads).toEqual([target.id, firstId, nestedId, lastId])
  })

  it('renders authorized ancestors and an unresolved lineage boundary without leaking it', async () => {
    const mounted = await mount()
    const root = createSession(mounted.ctx, 'visible-root', '/work', 5)
    const target = createSession(mounted.ctx, 'visible-target', '/work', 6, root.id)
    const complete = text(await mounted.call('session_trace', { session_id: target.id }))
    expect(complete).toContain('visible-root')

    const missingParent = SessionId('missing-parent-secret')
    const incomplete = createSession(mounted.ctx, 'incomplete-target', '/work', 7, missingParent)
    const redacted = text(await mounted.call('session_trace', { session_id: incomplete.id }))
    expect(redacted).toContain('[outside workspace boundary]')
    expect(redacted).not.toContain(missingParent)
  })

  it('renders unavailable trace records and keeps a self-id descendant authorized', async () => {
    const mounted = await mount()
    const target = createSession(mounted.ctx, 'trace-unavailable', '/work')
    const [record] = await mounted.ctx.sessionQuery.filterSessions([{ kind: 'id', values: [target.id] }])
    const [callerRecord] = await mounted.ctx.sessionQuery.filterSessions([{
      kind: 'id',
      values: [mounted.caller.id],
    }])
    if (record === undefined || callerRecord === undefined) throw new Error('expected live records')
    const unavailable = { ...record, live: false, persisted: false }
    const persisted = { ...callerRecord, live: false, persisted: true }
    vi.spyOn(mounted.ctx.sessionQuery, 'traceSession').mockResolvedValue({
      target: unavailable,
      ancestors: [],
      descendants: [{ session: persisted, descendants: [] }],
      complete: true,
      root: unavailable,
    })
    const output = text(await mounted.call('session_trace', { session_id: target.id }))
    expect(output).toContain('Availability: unavailable')
    expect(output).toContain(mounted.caller.id)
    expect(output).toContain('persisted')
  })

  it('rejects every payload observation whose target moved after pre-authorization', async () => {
    const mounted = await mount()
    const target = createSession(mounted.ctx, 'moving-target', '/work')
    target.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'authorized payload' }], source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )
    const movedHeader = header(target.id, '/outside')

    FakeQuery.eventSearch = () => Promise.resolve({
      session: movedHeader,
      items: [eventHit(target.id, 0, 'secret event hit')],
    })
    const search = await mounted.call('session_event_search', {
      session_id: target.id,
      query: 'secret',
    })
    expect(errorCode(search)).toBe('SESSION_QUERY_TOOL_UNAUTHORIZED')
    expect(text(search)).not.toContain('secret event hit')

    const lineage = await mounted.ctx.sessionQuery.traceSession(target.id)
    vi.spyOn(mounted.ctx.sessionQuery, 'traceSession').mockResolvedValueOnce({
      ...lineage,
      target: { ...lineage.target, header: movedHeader },
    })
    expect(errorCode(await mounted.call('session_trace', { session_id: target.id })))
      .toBe('SESSION_QUERY_TOOL_UNAUTHORIZED')

    const eventTrace = await mounted.ctx.sessionQuery.traceEvent({ sessionId: target.id, seq: 0 })
    vi.spyOn(mounted.ctx.sessionQuery, 'traceEvent').mockResolvedValueOnce({
      ...eventTrace,
      session: movedHeader,
    })
    expect(errorCode(await mounted.call('session_event_trace', { session_id: target.id, seq: 0 })))
      .toBe('SESSION_QUERY_TOOL_UNAUTHORIZED')

    const eventWindow = await mounted.ctx.sessionQuery.readEvent({ sessionId: target.id, seq: 0 })
    vi.spyOn(mounted.ctx.sessionQuery, 'readEvent').mockResolvedValueOnce({
      ...eventWindow,
      session: movedHeader,
    })
    expect(errorCode(await mounted.call('session_event_read', { session_id: target.id, seq: 0 })))
      .toBe('SESSION_QUERY_TOOL_UNAUTHORIZED')

    FakeQuery.sessionSearch = () => Promise.resolve({
      items: [sessionHit(target.id, '/work', 'safe hit')],
    })
    vi.spyOn(mounted.ctx.sessionQuery, 'readTitleSnapshots').mockResolvedValueOnce([{
      sessionId: target.id,
      status: 'fulfilled',
      value: {
        session: movedHeader,
        title: {
          title: 'secret moved title',
          messageSeqs: [],
          source: { kind: 'fallback' },
          eventSeq: 0,
          updatedAt: 1,
        },
      },
    }])
    const titled = await mounted.call('session_search', { query: 'safe' })
    expect(errorCode(titled)).toBe('SESSION_QUERY_TOOL_UNAUTHORIZED')
    expect(text(titled)).not.toContain('secret moved title')
  })

  it('rejects a default self read when its same-id observation moved after caller capture', async () => {
    const mounted = await mount()
    const appendLegacy = mounted.caller.append.bind(mounted.caller) as unknown as (
      type: string,
      data: unknown,
    ) => SessionEvent
    const secret = appendLegacy(
      'context/message',
      {
        content: [{ type: 'text', text: 'same-id moved secret' }],
        source: { kind: 'plugin', plugin: 'test' },
      },
    )
    const window = await mounted.ctx.sessionQuery.readEvent({
      sessionId: mounted.caller.id,
      seq: secret.seq,
    })
    vi.spyOn(mounted.ctx.sessionQuery, 'readEvent').mockResolvedValueOnce({
      ...window,
      session: header(mounted.caller.id, '/outside'),
    })

    const denied = await mounted.call('session_event_read', { seq: secret.seq })
    expect(errorCode(denied)).toBe('SESSION_QUERY_TOOL_UNAUTHORIZED')
    expect(text(denied)).not.toContain('same-id moved secret')
  })
})

describe('search paging, prior-history bounds, titles, and cancellation', () => {
  it('drains hidden internal pages to the authorized non-self cap and masks an unauthorized parent id', async () => {
    const mounted = await mount({ maxSearchResults: 2 })
    const outside = createSession(mounted.ctx, 'outside-parent-secret', '/outside')
    const a = createSession(mounted.ctx, 'a', '/work')
    const b = createSession(mounted.ctx, 'b', '/work')
    FakeQuery.titles.set(a.id, 'Alpha')
    FakeQuery.titles.set(b.id, 'Beta')
    const c1 = SessionSearchCursor('c1')
    const c2 = SessionSearchCursor('c2')
    FakeQuery.sessionSearch = (request) => {
      if (request.cursor === undefined) {
        return Promise.resolve({
          items: [
            sessionHit('caller', '/work'),
            sessionHit('unauthorized', '/outside'),
          ],
          nextCursor: c1,
        })
      }
      if (request.cursor === c1) {
        return Promise.resolve({
          items: [sessionHit('a', '/work', 'first', outside.id)],
          nextCursor: c2,
        })
      }
      return Promise.resolve({
        items: [
          sessionHit('b', '/work', 'second'),
          sessionHit('additional-authorized', '/work', 'third'),
        ],
      })
    }

    const result = await mounted.call('session_search', { query: 'needle' })
    const output = text(result)
    expect(FakeQuery.sessionRequests).toHaveLength(3)
    expect(FakeQuery.sessionRequests.every(request => request.limit === undefined)).toBe(true)
    expect(FakeQuery.sessionRequests.map(request => request.cursor)).toEqual([undefined, c1, c2])
    expect(output).toContain('Session a — Alpha')
    expect(output).toContain('Session b — Beta')
    expect(output).toContain('Parent: [outside workspace]')
    expect(output).not.toContain('outside-parent-secret')
    expect(output).toContain('Result cap reached')
  })

  it('does not report a cap when only rejected hits remain after the authorized limit', async () => {
    const mounted = await mount({ maxSearchResults: 1 })
    const cursor = SessionSearchCursor('rejected-tail')
    FakeQuery.sessionSearch = request => request.cursor === undefined
      ? Promise.resolve({
        items: [sessionHit('authorized', '/work')],
        nextCursor: cursor,
      })
      : Promise.resolve({
        items: [
          sessionHit(mounted.caller.id, '/work'),
          sessionHit('outside', '/outside'),
        ],
      })

    const output = text(await mounted.call('session_search', { query: 'needle' }))
    expect(FakeQuery.sessionRequests.map(request => request.cursor)).toEqual([undefined, cursor])
    expect(output).toContain('Session authorized')
    expect(output).not.toContain('Result cap reached')
  })

  it.each([
    {
      toolName: 'session_search',
      args: { query: 'needle' },
      secrets: [
        'session source conflict at hidden-search-session-secret',
        'hidden-search-cause-secret',
      ],
      failure: () => new SessionQueryError(
        'session source conflict at hidden-search-session-secret',
        'SESSION_QUERY_SOURCE_CONFLICT',
        { cause: new Error('hidden-search-cause-secret') },
      ),
    },
    {
      toolName: 'session_event_search',
      args: { query: 'needle' },
      secrets: [
        'plain event provider failure at hidden-event-session-secret',
        'hidden-event-cause-secret',
      ],
      failure: () => new Error(
        'plain event provider failure at hidden-event-session-secret',
        { cause: 'hidden-event-cause-secret' },
      ),
    },
  ] as const)('sanitizes $toolName provider diagnostics', async ({ toolName, args, secrets, failure }) => {
    const mounted = await mount()
    if (toolName === 'session_search') {
      FakeQuery.sessionSearch = () => Promise.reject(failure())
    } else {
      FakeQuery.eventSearch = () => Promise.reject(failure())
    }
    const warn = vi.spyOn(mounted.ctx.logger, 'warn').mockImplementation(() => undefined)

    const result = await mounted.call(toolName, args)

    expect(errorCode(result)).toBe('SESSION_QUERY_TOOL_FAILED')
    expect(text(result)).toBe('Error: session query operation failed')
    for (const secret of secrets) {
      expect(JSON.stringify(result)).not.toContain(secret)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(secret))
    }
  })

  it.each([
    {
      name: 'a hostile prototype trap',
      secrets: ['proxy payload secret', 'getPrototypeOf secondary secret'],
      diagnostic: '[unprintable session query failure]',
      failure: (): unknown => new Proxy(
        { payload: 'proxy payload secret' },
        {
          getPrototypeOf() {
            throw new Error('getPrototypeOf secondary secret')
          },
        },
      ),
    },
    {
      name: 'a throwing stack getter',
      secrets: ['stack primary secret', 'stack getter secondary secret'],
      diagnostic: '[unprintable session query failure]',
      failure: (): unknown => {
        const error = new Error('stack primary secret')
        Object.defineProperty(error, 'stack', {
          get() {
            throw new Error('stack getter secondary secret')
          },
        })
        return error
      },
    },
    {
      name: 'a throwing cause getter',
      secrets: ['cause primary secret', 'cause getter secondary secret'],
      diagnostic: '[unprintable session query failure]',
      failure: (): unknown => {
        const error = new Error('cause primary secret')
        Object.defineProperty(error, 'cause', {
          get() {
            throw new Error('cause getter secondary secret')
          },
        })
        return error
      },
    },
    {
      name: 'throwing string coercion',
      secrets: ['string payload secret', 'string coercion secondary secret'],
      diagnostic: '[unprintable session query failure]',
      failure: (): unknown => ({
        payload: 'string payload secret',
        [Symbol.toPrimitive]() {
          throw new Error('string coercion secondary secret')
        },
      }),
    },
    {
      name: 'a throwing code getter',
      secrets: ['code primary secret', 'code getter secondary secret'],
      diagnostic: 'code primary secret',
      failure: (): unknown => {
        const error = new SessionQueryError(
          'code primary secret',
          'SESSION_QUERY_PERSISTENCE_FAILED',
        )
        Object.defineProperty(error, 'code', {
          get() {
            throw new Error('code getter secondary secret')
          },
        })
        return error
      },
    },
    {
      name: 'an unknown string code',
      secrets: ['unknown code primary secret', '__proto__'],
      diagnostic: 'unknown code primary secret',
      failure: (): unknown => {
        const error = new SessionQueryError(
          'unknown code primary secret',
          'SESSION_QUERY_PERSISTENCE_FAILED',
        )
        Object.defineProperty(error, 'code', { value: '__proto__' })
        return error
      },
    },
    {
      name: 'a non-string code',
      secrets: ['non-string code primary secret', 'non-string code secondary secret'],
      diagnostic: 'non-string code primary secret',
      failure: (): unknown => {
        const error = new SessionQueryError(
          'non-string code primary secret',
          'SESSION_QUERY_PERSISTENCE_FAILED',
        )
        Object.defineProperty(error, 'code', {
          value: {
            toString() {
              throw new Error('non-string code secondary secret')
            },
          },
        })
        return error
      },
    },
  ])('fails generic when inspecting $name is unsafe', async ({ secrets, diagnostic, failure }) => {
    const mounted = await mount()
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- hostile unknown rejection is the scenario
    FakeQuery.sessionSearch = () => Promise.reject(failure())
    const warn = vi.spyOn(mounted.ctx.logger, 'warn').mockImplementation(() => undefined)

    const result = await mounted.call('session_search', { query: 'needle' })

    expect(errorCode(result)).toBe('SESSION_QUERY_TOOL_FAILED')
    expect(text(result)).toBe('Error: session query operation failed')
    for (const secret of secrets) expect(JSON.stringify(result)).not.toContain(secret)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(diagnostic))
  })

  it('retains a fixed safe typed failure when only its nested diagnostic is unprintable', async () => {
    const mounted = await mount()
    const primary = 'typed outer diagnostic secret'
    const nested = 'nested prototype secondary secret'
    const cause = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error(nested)
        },
      },
    )
    FakeQuery.sessionSearch = () => Promise.reject(
      new SessionQueryError(
        primary,
        'SESSION_QUERY_PERSISTENCE_FAILED',
        { cause },
      ),
    )
    const warn = vi.spyOn(mounted.ctx.logger, 'warn').mockImplementation(() => undefined)

    const result = await mounted.call('session_search', { query: 'needle' })

    expect(errorCode(result)).toBe('SESSION_QUERY_PERSISTENCE_FAILED')
    expect(text(result)).toBe('Error: session history storage is unavailable')
    expect(JSON.stringify(result)).not.toContain(primary)
    expect(JSON.stringify(result)).not.toContain(nested)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[unprintable session query failure]'))
  })

  it('logs an inspectable cyclic cause chain without exposing it', async () => {
    const mounted = await mount()
    const outer = new Error('cyclic outer secret')
    const inner = new Error('cyclic inner secret')
    Object.defineProperty(outer, 'cause', { value: inner })
    Object.defineProperty(inner, 'cause', { value: outer })
    FakeQuery.sessionSearch = () => Promise.reject(outer)
    const warn = vi.spyOn(mounted.ctx.logger, 'warn').mockImplementation(() => undefined)

    const result = await mounted.call('session_search', { query: 'needle' })

    expect(errorCode(result)).toBe('SESSION_QUERY_TOOL_FAILED')
    expect(text(result)).toBe('Error: session query operation failed')
    expect(JSON.stringify(result)).not.toContain('cyclic outer secret')
    expect(JSON.stringify(result)).not.toContain('cyclic inner secret')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cyclic outer secret'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cyclic inner secret'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[circular error cause]'))
  })

  it('fails generic when internal warning logging throws', async () => {
    const mounted = await mount()
    const primary = 'typed persistence primary secret'
    const secondary = 'logger warning secondary secret'
    FakeQuery.sessionSearch = () => Promise.reject(
      new SessionQueryError(primary, 'SESSION_QUERY_PERSISTENCE_FAILED'),
    )
    const warn = vi.spyOn(mounted.ctx.logger, 'warn')
      .mockImplementation(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error(secondary)
      })

    const result = await mounted.call('session_search', { query: 'needle' })

    expect(errorCode(result)).toBe('SESSION_QUERY_TOOL_FAILED')
    expect(text(result)).toBe('Error: session query operation failed')
    expect(JSON.stringify(result)).not.toContain(primary)
    expect(JSON.stringify(result)).not.toContain(secondary)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('preserves stale-cursor diagnostics without transparently restarting', async () => {
    const mounted = await mount({ maxSearchResults: 2 })
    const cursor = SessionSearchCursor('stale-next')
    FakeQuery.sessionSearch = request => request.cursor === undefined
      ? Promise.resolve({ items: [], nextCursor: cursor })
      : Promise.reject(new SessionQueryError('stale provider generation', 'SESSION_QUERY_STALE_CURSOR'))
    const result = await mounted.call('session_search', { query: 'needle' })
    expect(errorCode(result)).toBe('SESSION_QUERY_STALE_CURSOR')
    expect(text(result)).toContain('retry the complete search call')
    expect(FakeQuery.sessionRequests).toHaveLength(2)
  })

  it('rejects a repeated internal cursor instead of looping', async () => {
    const mounted = await mount()
    const cursor = SessionSearchCursor('repeat')
    FakeQuery.sessionSearch = () => Promise.resolve({ items: [], nextCursor: cursor })
    const result = await mounted.call('session_search', { query: 'needle' })
    expect(errorCode(result)).toBe('SESSION_QUERY_INVALID_CURSOR')
    expect(text(result)).toBe('Error: session-search provider repeated a continuation cursor')
    expect(FakeQuery.sessionRequests).toHaveLength(2)
  })

  it('renders authorized parent ids and all availability states', async () => {
    const mounted = await mount({ maxSearchResults: 3 })
    const parent = createSession(mounted.ctx, 'parent', '/work')
    const child = createSession(mounted.ctx, 'child', '/work', 2, parent.id)
    const callerChild = createSession(mounted.ctx, 'caller-child', '/work', 3, mounted.caller.id)
    FakeQuery.sessionSearch = () => Promise.resolve({
      items: [
        { ...sessionHit(child.id, '/work', 'both', parent.id), live: true, persisted: true },
        { ...sessionHit(callerChild.id, '/work', 'persisted', mounted.caller.id), live: false, persisted: true },
        { ...sessionHit('unavailable', '/work', 'neither'), live: false, persisted: false },
      ],
    })
    const output = text(await mounted.call('session_search', { query: 'needle' }))
    expect(output).toContain('Parent: parent')
    expect(output).toContain(`Parent: ${mounted.caller.id}`)
    expect(output).toContain('Availability: live, persisted')
    expect(output).toContain('Availability: persisted')
    expect(output).toContain('Availability: unavailable')
  })

  it('intersects current-session search with the event before the latest step and leaves other targets unchanged', async () => {
    const mounted = await mount()
    FakeQuery.eventSearch = request => Promise.resolve({
      session: header(request.sessionId, '/work'),
      items: [eventHit(request.sessionId, 1)],
    })
    await mounted.call('session_event_search', {
      query: 'prior',
      seq_from: 0,
      seq_to: 99,
    })
    expect(FakeQuery.eventRequests[0]?.filters).toContainEqual({ kind: 'seq', from: 0, to: 1 })

    const other = createSession(mounted.ctx, 'other', '/work')
    await mounted.call('session_event_search', {
      session_id: other.id,
      query: 'prior',
      seq_from: 0,
      seq_to: 99,
    })
    expect(FakeQuery.eventRequests[1]?.filters).toContainEqual({ kind: 'seq', from: 0, to: 99 })
  })

  it('returns no current-session hits without calling FTS when the user range starts in the active step', async () => {
    const mounted = await mount()
    const result = await mounted.call('session_event_search', {
      query: 'prior',
      seq_from: 2,
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('No prior event matches found.')
    expect(FakeQuery.eventRequests).toEqual([])
  })

  it('requires a current step boundary and drains event pages to a capped result', async () => {
    const mounted = await mount({ maxSearchResults: 2 })
    const noStep = createSession(mounted.ctx, 'no-step', '/work')
    const missing = await mounted.call(
      'session_event_search',
      { query: 'q' },
      { agent: fakeAgent(noStep) },
    )
    expect(errorCode(missing)).toBe('SESSION_QUERY_INVALID_FILTER')

    const other = createSession(mounted.ctx, 'paged-events', '/work')
    const cursor = SessionSearchCursor('events-next')
    FakeQuery.eventSearch = request => request.cursor === undefined
      ? Promise.resolve({
        session: header(other.id, '/work'),
        items: [eventHit(other.id, 1)],
        nextCursor: cursor,
      })
      : Promise.resolve({
        session: header(other.id, '/work'),
        items: [eventHit(other.id, 2), eventHit(other.id, 3)],
      })
    const result = await mounted.call('session_event_search', {
      session_id: other.id,
      query: 'q',
    })
    expect(FakeQuery.eventRequests.map(request => request.cursor)).toEqual([undefined, cursor])
    expect(text(result)).toContain('Result cap reached')
  })

  it('rejects current-session search without the turnBoundary fold', async () => {
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(FakeQuery)
    await ctx.plugin(ToolSessionQuery)
    const session = createSession(ctx, 'no-boundary-caller', '/work')
    const result = await ctx.tools.execute({
      name: 'session_event_search',
      arguments: { query: 'q' },
      callId: ToolCallId('call-no-boundary'),
      signal: new AbortController().signal,
      agent: fakeAgent(session),
    })
    expect(errorCode(result)).toBe('SESSION_QUERY_TOOL_NO_CURRENT_STEP')
  })

  it('preserves base results when a title read fails, annotates the code, and logs the full error', async () => {
    const mounted = await mount()
    const hit = createSession(mounted.ctx, 'hit', '/work')
    const failure = new HarnessError('title backend failed', 'TITLE_BACKEND')
    FakeQuery.titles.set(hit.id, failure)
    FakeQuery.sessionSearch = () => Promise.resolve({ items: [sessionHit(hit.id, '/work')] })
    const warn = vi.spyOn(mounted.ctx.logger, 'warn').mockImplementation(() => undefined)
    const result = await mounted.call('session_search', { query: 'needle' })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('untitled (title unavailable: SESSION_QUERY_TOOL_FAILED)')
    expect(JSON.stringify(result)).not.toContain('title backend failed')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('title backend failed'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HarnessError'))
  })

  it('reports unknown title failures and preserves an Error without a stack', async () => {
    const mounted = await mount()
    const first = createSession(mounted.ctx, 'unknown-title', '/work')
    const second = createSession(mounted.ctx, 'second-title-failure', '/work')
    const stackless = new Error('stackless')
    Object.defineProperty(stackless, 'stack', { value: undefined })
    const readTitles = vi.spyOn(mounted.ctx.sessionQuery, 'readTitleSnapshots')
      .mockResolvedValueOnce([
        { sessionId: first.id, status: 'rejected', reason: 'string failure' },
        { sessionId: second.id, status: 'rejected', reason: stackless },
      ])
    FakeQuery.sessionSearch = () => Promise.resolve({
      items: [
        sessionHit(first.id, '/work'),
        sessionHit(second.id, '/work'),
      ],
    })
    const warn = vi.spyOn(mounted.ctx.logger, 'warn').mockImplementation(() => undefined)
    const result = await mounted.call('session_search', { query: 'needle' })
    expect(text(result)).toContain('title unavailable: SESSION_QUERY_TOOL_FAILED')
    expect(JSON.stringify(result)).not.toContain('string failure')
    expect(JSON.stringify(result)).not.toContain('stackless')
    expect(readTitles).toHaveBeenCalledTimes(1)
    expect(readTitles.mock.calls[0]?.[0]).toEqual([first.id, second.id])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('string failure'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Error: stackless'))
  })

  it('isolates an unprintable per-title failure behind the generic unavailable marker', async () => {
    const mounted = await mount()
    const hit = createSession(mounted.ctx, 'hostile-title-failure', '/work')
    const primary = 'per-title proxy payload secret'
    const secondary = 'per-title prototype secondary secret'
    const reason = new Proxy(
      { payload: primary },
      {
        getPrototypeOf() {
          throw new Error(secondary)
        },
      },
    )
    FakeQuery.sessionSearch = () => Promise.resolve({ items: [sessionHit(hit.id, '/work')] })
    vi.spyOn(mounted.ctx.sessionQuery, 'readTitleSnapshots').mockResolvedValueOnce([{
      sessionId: hit.id,
      status: 'rejected',
      reason,
    }])
    const warn = vi.spyOn(mounted.ctx.logger, 'warn').mockImplementation(() => undefined)

    const result = await mounted.call('session_search', { query: 'needle' })

    expect(result.isError).toBe(false)
    expect(text(result)).toContain('untitled (title unavailable: SESSION_QUERY_TOOL_FAILED)')
    expect(JSON.stringify(result)).not.toContain(primary)
    expect(JSON.stringify(result)).not.toContain(secondary)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[unprintable session query failure]'))
  })

  it('sanitizes a thrown batch-title service failure instead of rendering its diagnostic', async () => {
    const mounted = await mount()
    const hit = createSession(mounted.ctx, 'thrown-title-failure', '/work')
    const secret = 'title batch failed beside hidden-title-session-secret'
    FakeQuery.sessionSearch = () => Promise.resolve({ items: [sessionHit(hit.id, '/work')] })
    vi.spyOn(mounted.ctx.sessionQuery, 'readTitleSnapshots')
      .mockRejectedValueOnce(new Error(secret))
    const warn = vi.spyOn(mounted.ctx.logger, 'warn').mockImplementation(() => undefined)

    const result = await mounted.call('session_search', { query: 'needle' })

    expect(errorCode(result)).toBe('SESSION_QUERY_TOOL_FAILED')
    expect(text(result)).toBe('Error: session query operation failed')
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(secret))
  })

  it('does not downgrade cancellation during title enrichment', async () => {
    const mounted = await mount()
    const hit = createSession(mounted.ctx, 'abort-title', '/work')
    const controller = new AbortController()
    const cancellation = new Error('cancelled title batch')
    FakeQuery.sessionSearch = () => Promise.resolve({ items: [sessionHit(hit.id, '/work')] })
    let started!: () => void
    const batchStarted = new Promise<void>((resolve) => { started = resolve })
    const readTitles = vi.spyOn(mounted.ctx.sessionQuery, 'readTitleSnapshots').mockImplementation((_ids, signal) => {
      started()
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(cancellation) }, { once: true })
      })
    })
    const pending = mounted.call('session_search', { query: 'needle' }, { signal: controller.signal })
    await batchStarted
    controller.abort(cancellation)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(text(result)).not.toContain('title unavailable')
    expect(readTitles.mock.calls[0]?.[1]).toBe(controller.signal)
  })

  it('does not downgrade an authorization failure returned by title observation', async () => {
    const mounted = await mount()
    const hit = createSession(mounted.ctx, 'unauthorized-title-error', '/work')
    const failure = new HarnessError(
      'title observation became unauthorized',
      'SESSION_QUERY_TOOL_UNAUTHORIZED',
    )
    FakeQuery.sessionSearch = () => Promise.resolve({ items: [sessionHit(hit.id, '/work')] })
    vi.spyOn(mounted.ctx.sessionQuery, 'readTitleSnapshots').mockResolvedValueOnce([{
      sessionId: hit.id,
      status: 'rejected',
      reason: failure,
    }])

    const result = await mounted.call('session_search', { query: 'needle' })

    expect(errorCode(result)).toBe('SESSION_QUERY_TOOL_UNAUTHORIZED')
    expect(text(result)).toBe('Error: session target is outside the caller workspace')
    expect(JSON.stringify(result)).not.toContain('title observation became unauthorized')
    expect(text(result)).not.toContain('title unavailable')
  })

  it('forwards caller cancellation into direct-target authorization and waits for cleanup', async () => {
    const mounted = await mount()
    const target = createSession(mounted.ctx, 'stalled-direct-authorization', '/work')
    const controller = new AbortController()
    const cancellation = new SessionQueryError(
      'direct-target authorization cancelled',
      'SESSION_QUERY_ABORTED',
    )
    const started = Promise.withResolvers<undefined>()
    const abortObserved = Promise.withResolvers<undefined>()
    const cleanup = Promise.withResolvers<undefined>()
    let active = false
    const filterSessions = vi.spyOn(mounted.ctx.sessionQuery, 'filterSessions')
      .mockImplementation(async (_filters, signal) => {
        if (signal === undefined) throw new Error('expected authorization signal')
        active = true
        const aborted = new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        started.resolve(undefined)
        await aborted
        abortObserved.resolve(undefined)
        await cleanup.promise
        active = false
        signal.throwIfAborted()
        return []
      })

    const pending = mounted.call(
      'session_event_search',
      { session_id: target.id, query: 'needle' },
      { signal: controller.signal },
    )
    let settled = false
    void pending.then(
      () => { settled = true },
      () => { settled = true },
    )
    await started.promise
    controller.abort(cancellation)
    await abortObserved.promise

    expect(settled).toBe(false)
    expect(active).toBe(true)
    expect(filterSessions.mock.calls[0]?.[1]).toBe(controller.signal)
    expect(controller.signal.reason).toBe(cancellation)
    expect(FakeQuery.eventRequests).toEqual([])

    cleanup.resolve(undefined)
    const result = await pending
    expect(active).toBe(false)
    expect(errorCode(result)).toBe('SESSION_QUERY_ABORTED')
    expect(text(result)).toBe('Error: direct-target authorization cancelled')
    expect(FakeQuery.eventRequests).toEqual([])
  })

  it('forwards the search deadline into parent authorization and times out only after cleanup', async () => {
    vi.useFakeTimers()
    const timeoutMs = 1_234
    const mounted = await mount({ searchTimeoutMs: timeoutMs }, '/work', true)
    const parent = createSession(mounted.ctx, 'stalled-parent-authorization', '/work')
    FakeQuery.sessionSearch = () => Promise.resolve({
      items: [sessionHit('authorized-child', '/work', 'needle', parent.id)],
    })
    const upstream = new AbortController()
    const started = Promise.withResolvers<undefined>()
    const abortObserved = Promise.withResolvers<undefined>()
    const cleanup = Promise.withResolvers<undefined>()
    let active = false
    let deadlineSignal: AbortSignal | undefined
    const filterSessions = vi.spyOn(mounted.ctx.sessionQuery, 'filterSessions')
      .mockImplementation(async (_filters, signal) => {
        if (signal === undefined) throw new Error('expected authorization signal')
        deadlineSignal = signal
        active = true
        const aborted = new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        started.resolve(undefined)
        await aborted
        abortObserved.resolve(undefined)
        await cleanup.promise
        active = false
        signal.throwIfAborted()
        return []
      })

    const pending = mounted.call(
      'session_search',
      { query: 'needle' },
      { signal: upstream.signal },
    )
    let settled = false
    void pending.then(
      () => { settled = true },
      () => { settled = true },
    )
    await started.promise
    await vi.advanceTimersByTimeAsync(timeoutMs)
    await abortObserved.promise

    expect(settled).toBe(false)
    expect(active).toBe(true)
    expect(deadlineSignal).toBeDefined()
    expect(deadlineSignal).not.toBe(upstream.signal)
    expect(filterSessions.mock.calls[0]?.[1]).toBe(deadlineSignal)
    expect(FakeQuery.searchSignals).toEqual([deadlineSignal])
    expect(deadlineSignal?.reason).toBeInstanceOf(TimeoutReason)
    expect(deadlineSignal?.reason).toMatchObject({ code: 'TOOL_TIMEOUT', timeoutMs })

    cleanup.resolve(undefined)
    const result = await pending
    expect(active).toBe(false)
    expect(errorCode(result)).toBe('TOOL_TIMEOUT')
    expect(text(result)).toBe(`Error: tool call timed out after ${timeoutMs}ms`)
  })

  it('passes the exact execution signal to every FTS page and stops on cancellation', async () => {
    const mounted = await mount()
    const controller = new AbortController()
    const warn = vi.spyOn(mounted.ctx.logger, 'warn').mockImplementation(() => undefined)
    let started!: () => void
    const bodyStarted = new Promise<void>((resolve) => { started = resolve })
    FakeQuery.sessionSearch = (_request, exec) => new Promise((_resolve, reject) => {
      started()
      exec?.signal?.addEventListener('abort', () => {
        reject(new SessionQueryError('aborted', 'SESSION_QUERY_ABORTED'))
      }, { once: true })
    })
    const cancellation = new SessionQueryError('aborted', 'SESSION_QUERY_ABORTED')
    const pending = mounted.call('session_search', { query: 'needle' }, { signal: controller.signal })
    await bodyStarted
    controller.abort(cancellation)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(errorCode(result)).toBe('SESSION_QUERY_ABORTED')
    expect(FakeQuery.searchSignals).toEqual([controller.signal])
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('trace and exact read rendering', () => {
  it('renders a deeply nested lineage without recursive consumer traversal', async () => {
    const mounted = await mount()
    const target = createSession(mounted.ctx, 'deep-target', '/work')
    const [targetRecord] = await mounted.ctx.sessionQuery.filterSessions([{
      kind: 'id',
      values: [target.id],
    }])
    if (targetRecord === undefined) throw new Error('expected target record')
    const depth = 3_000
    let descendants: SessionLineageNode[] = []
    for (let index = depth; index >= 1; index -= 1) {
      descendants = [{
        session: {
          ...targetRecord,
          header: header(`deep-${index}`, '/work', index),
        },
        descendants,
      }]
    }
    vi.spyOn(mounted.ctx.sessionQuery, 'traceSession').mockResolvedValue({
      target: targetRecord,
      ancestors: [],
      descendants,
      complete: true,
      root: targetRecord,
    })
    vi.spyOn(mounted.ctx.sessionQuery, 'readTitleSnapshots').mockImplementation(sessionIds => Promise.resolve(
      [...new Set(sessionIds)].map(sessionId => ({
        sessionId,
        status: 'fulfilled' as const,
        value: { session: header(sessionId, '/work') },
      })),
    ))

    const output = text(await mounted.call('session_trace', { session_id: target.id }))
    expect(output).toContain('Descendants:\n- deep-1 —')
    expect(output).toContain(`${'  '.repeat(depth - 1)}- deep-${depth} —`)
  })

  it('renders every event relationship sequence and a UTC target timestamp', async () => {
    const mounted = await mount()
    const session = createSession(mounted.ctx, 'relationships', '/work')
    session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'source' }], source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )
    session.append(
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'replacement' }],
          source: {
            kind: 'model',
            ...{ provider: 'test', model: 'test' },
          },
        }),
      },
      { surfaceOp: { op: 'replace', start: 0, end: 0 }, sourceEventSeqs: [0] },
    )
    const result = await mounted.call('session_event_trace', { session_id: session.id, seq: 0 })
    expect(text(result)).toContain('Replacement chain: 1')
    expect(text(result)).toContain('Events cited directly as sources: none')
    expect(text(result)).toContain('Direct derived events: 1')
    expect(text(result)).toContain(new Date(session.snapshotEvents()[0]?.time ?? 0).toISOString())
  })

  it('renders unabridged fenced target JSON and readable semantic or log-only neighbor summaries', async () => {
    const mounted = await mount()
    const session = createSession(mounted.ctx, 'read', '/work')
    session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'before semantic text' }], source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )
    session.append(
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'target full text' }],
          source: {
            kind: 'model',
            ...{ provider: 'test', model: 'test' },
          },
        }),
      },
      { surfaceOp: 'append' },
    )
    const appendLegacy = session.append.bind(session) as unknown as (
      type: string,
      data: unknown,
    ) => SessionEvent
    appendLegacy(
      'context/message',
      { content: [{ type: 'text', text: 'after semantic text' }], source: { kind: 'plugin', plugin: 'test' } },
    )
    const result = await mounted.call('session_event_read', {
      session_id: session.id,
      seq: 1,
      before: 1,
      after: 1,
    })
    const output = text(result)
    expect(output).toContain('```json')
    expect(output).toContain('"text": "target full text"')
    expect(output).toContain('before semantic text')
    expect(output).toContain('seq 2 | context/message')
    expect(output).toContain('(no semantic text)')
    expect(output).not.toContain('after semantic text')
    expect(output).not.toContain('truncated')
  })

  it('renders empty event relationships and neighbors without semantic text', async () => {
    const mounted = await mount()
    const session = createSession(mounted.ctx, 'empty-relations', '/work')
    session.append('step/start', { turn: 1, step: 1 })
    session.append('step/end', { turn: 1, step: 1 })

    const trace = text(await mounted.call('session_event_trace', {
      session_id: session.id,
      seq: 0,
    }))
    expect(trace).toContain('Replaced by: none')
    expect(trace).toContain('Replacement chain: none')

    const onlyAfter = text(await mounted.call('session_event_read', {
      session_id: session.id,
      seq: 0,
      after: 1,
    }))
    expect(onlyAfter).not.toContain('Before:')
    expect(onlyAfter).toContain('(no semantic text)')

    const onlyBefore = text(await mounted.call('session_event_read', {
      session_id: session.id,
      seq: 1,
      before: 1,
    }))
    expect(onlyBefore).toContain('Before:')
    expect(onlyBefore).not.toContain('After:')
  })

  it.each([
    ['session_event_trace', { seq: -1 }],
    ['session_event_read', { seq: Number.MAX_SAFE_INTEGER + 1 }],
    ['session_event_read', { seq: 0, before: -1 }],
    ['session_event_read', { seq: 0, after: 1.5 }, 'INVALID_ARGS'],
  ])('rejects invalid exact-read integers for %s', async (name, args, expected = 'SESSION_QUERY_INVALID_FILTER') => {
    const mounted = await mount()
    expect(errorCode(await mounted.call(name, args))).toBe(expected)
  })
})
