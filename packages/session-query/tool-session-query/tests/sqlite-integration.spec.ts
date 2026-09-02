import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId  } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionSeq,
  type Session,
} from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolSessionQuery from '@deepseek-ai/dsh-tool-session-query'

const temporaryDirectories: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

function fakeAgent(session: Session): Agent {
  return { id: session.id, session } as unknown as Agent
}

function registerTurnBoundary(ctx: Context): void {
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
}

describe('tool-session-query with the real SQLite provider', () => {
  it('searches live prior-step history and a persisted same-workspace log', { timeout: 20_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tool-session-query-'))
    temporaryDirectories.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    registerTurnBoundary(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await ctx.plugin(SqliteSessionQueryEngine, { path: join(root, 'session-query.db') })
    await ctx.plugin(ToolSessionQuery)

    const persisted = SessionId('persisted')
    const writer = await ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION,
      id: persisted,
      createdAt: 1,
      cwd: '/work',
      isSeeded: false,
    })
    await writer.append([{
      type: 'user/message',
      seq: SessionSeq(0),
      time: 2,
      data: createUserMessage({
        content: [{ type: 'text', text: 'persisted integration needle' }],
        source: { kind: 'user' },
      }),
      surfaceOp: 'append',
    }])
    await writer.close()

    const caller = ctx.sessions.create(SessionId('caller'), {
      meta: { createdAt: 10, cwd: '/work' },
    })
    caller.append('turn/start', { turn: 1 })
    caller.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'live integration needle' }], source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )
    caller.append('step/start', { turn: 1, step: 1 })

    let call = 0
    const execute = (name: string, args: unknown) => ctx.tools.execute({
      name,
      arguments: args,
      callId: ToolCallId(`integration-${++call}`),
      signal: new AbortController().signal,
      agent: fakeAgent(caller),
    })

    const sessions = await execute('session_search', { query: 'persisted integration needle' })
    expect(sessions.isError).toBe(false)
    expect(sessions.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
      .toContain('Session persisted')
    const persistedEvents = await execute('session_event_search', {
      session_id: persisted,
      query: 'persisted integration needle',
    })
    expect(persistedEvents.isError).toBe(false)
    expect(persistedEvents.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
      .toContain('seq 0')
    const liveEvents = await execute('session_event_search', { query: 'live integration needle' })
    expect(liveEvents.isError).toBe(false)
    expect(liveEvents.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
      .toContain('seq 1')
  })

  it('passes finite fractional epoch-millisecond bounds through SQLite comparisons', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tool-session-query-fractional-'))
    temporaryDirectories.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    registerTurnBoundary(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await ctx.plugin(SqliteSessionQueryEngine, { path: join(root, 'session-query.db') })
    await ctx.plugin(ToolSessionQuery)

    const base = Date.parse('2026-07-24T00:00:00.000Z')
    const persisted = SessionId('fractional-persisted')
    const writer = await ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION,
      id: persisted,
      createdAt: base,
      cwd: '/work',
      isSeeded: false,
    })
    await writer.append([
      {
        type: 'user/message',
        seq: SessionSeq(0),
        time: base + 123,
        data: createUserMessage({
          content: [{ type: 'text', text: 'fractional integration needle' }],
          source: { kind: 'user' },
        }),
        surfaceOp: 'append',
      },
      {
        type: 'user/message',
        seq: SessionSeq(1),
        time: base + 124,
        data: createUserMessage({
          content: [{ type: 'text', text: 'fractional integration needle' }],
          source: { kind: 'user' },
        }),
        surfaceOp: 'append',
      },
      {
        type: 'user/message',
        seq: SessionSeq(2),
        time: -124,
        data: createUserMessage({
          content: [{ type: 'text', text: 'pre-epoch fractional needle' }],
          source: { kind: 'user' },
        }),
        surfaceOp: 'append',
      },
      {
        type: 'user/message',
        seq: SessionSeq(3),
        time: -123,
        data: createUserMessage({
          content: [{ type: 'text', text: 'pre-epoch fractional needle' }],
          source: { kind: 'user' },
        }),
        surfaceOp: 'append',
      },
    ])
    await writer.close()

    const caller = ctx.sessions.create(SessionId('fractional-caller'), {
      meta: { createdAt: base + 1_000, cwd: '/work' },
    })
    let call = 0
    const execute = (args: unknown) => ctx.tools.execute({
      name: 'session_event_search',
      arguments: args,
      callId: ToolCallId(`fractional-integration-${++call}`),
      signal: new AbortController().signal,
      agent: fakeAgent(caller),
    })

    const lowerBound = await execute({
      session_id: persisted,
      query: 'fractional integration needle',
      time_from: '2026-07-24T00:00:00.12300001Z',
    })
    expect(lowerBound.isError).toBe(false)
    const lowerText = lowerBound.content.map(block => block.type === 'text' ? block.text : '').join('\n')
    expect(lowerText).toContain('seq 1')
    expect(lowerText).not.toContain('seq 0')

    const upperBound = await execute({
      session_id: persisted,
      query: 'fractional integration needle',
      time_to: '2026-07-24T08:00:00.1239999+08:00',
    })
    expect(upperBound.isError).toBe(false)
    const upperText = upperBound.content.map(block => block.type === 'text' ? block.text : '').join('\n')
    expect(upperText).toContain('seq 0')
    expect(upperText).not.toContain('seq 1')

    const emptySameMillisecond = await execute({
      session_id: persisted,
      query: 'fractional integration needle',
      time_from: '2026-07-24T00:00:00.12300001Z',
      time_to: '2026-07-24T08:00:00.1239999+08:00',
    })
    expect(emptySameMillisecond.isError).toBe(false)
    expect(emptySameMillisecond.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
      .toContain('No prior event matches found.')

    const preEpochLower = await execute({
      session_id: persisted,
      query: 'pre-epoch fractional needle',
      time_from: '1969-12-31T23:59:59.87600001Z',
    })
    expect(preEpochLower.isError).toBe(false)
    const preEpochLowerText = preEpochLower.content
      .map(block => block.type === 'text' ? block.text : '').join('\n')
    expect(preEpochLowerText).toContain('seq 3')
    expect(preEpochLowerText).not.toContain('seq 2')

    const preEpochUpper = await execute({
      session_id: persisted,
      query: 'pre-epoch fractional needle',
      time_to: '1969-12-31T19:59:59.8769999-04:00',
    })
    expect(preEpochUpper.isError).toBe(false)
    const preEpochUpperText = preEpochUpper.content
      .map(block => block.type === 'text' ? block.text : '').join('\n')
    expect(preEpochUpperText).toContain('seq 2')
    expect(preEpochUpperText).not.toContain('seq 3')
  })
})
