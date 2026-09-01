import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import * as TodoInvariant from '@deepseek-ai/dsh-tool-todo/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(TodoInvariant)
  return ctx
}

describe('todo snapshot invariants', () => {
  it('accepts historical and live parallel snapshots under the single-active tool policy', async () => {
    const todos = [
      { content: 'Inspect state', status: 'completed' },
      { content: 'Apply fix', status: 'in_progress' },
      { content: 'Watch background build', status: 'in_progress' },
      { content: 'Run checks', status: 'pending' },
    ] as const
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ToolTodo, { allowParallelInProgress: false })
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('todo/write', { todos: [...todos] })
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(TodoInvariant).then(() => undefined)).resolves.toBeUndefined()
    expect(() => { session.append('todo/write', { todos: [...todos] }) }).not.toThrow()
  })

  it.each([
    ['not-an-array', /must be an array/],
    [[null], /entries must be objects/],
    [[42], /entries must be objects/],
    [[{ content: 42, status: 'pending' }], /content must be non-empty/],
    [[{ content: '', status: 'pending' }], /content must be non-empty/],
    [[{ content: ' padded ', status: 'pending' }], /already trimmed/],
    [[{ content: 'same', status: 'pending' }, { content: 'same', status: 'completed' }], /repeats content/],
    [[{ content: 'task', status: 42 }], /unknown status/],
    [[{ content: 'task', status: 'paused' }], /unknown status/],
  ])('rejects an incoherent durable todo snapshot', async (todos, message) => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    expect(() => { session.append('todo/write', { todos } as never) }).toThrow(message)
  })

  it('ignores unrelated dispatches and session events', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    expect(() => {
      ctx.emit('tools/change')
      session.append('turn/start', { turn: 1 })
    }).not.toThrow()
  })

  it('rejects a live snapshot outside an open turn before it enters the log', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const before = session.snapshotEvents()

    expect(() => session.append('todo/write', { todos: [] })).toThrow(/outside any open turn/)
    expect(session.snapshotEvents()).toEqual(before)
  })

  it('rejects an existing snapshot outside an open turn on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create().append('todo/write', { todos: [] })
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(TodoInvariant).then(() => undefined)).rejects.toThrow(/outside any open turn/)
  })

  it('rejects an invalid existing snapshot on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('todo/write', {
      todos: [
        { content: 'duplicate', status: 'pending' },
        { content: 'duplicate', status: 'completed' },
      ],
    })
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(TodoInvariant).then(() => undefined)).rejects.toThrow(/repeats content "duplicate"/)
  })

  it('validates seeded sessions announced after companion installation', async () => {
    const ctx = await setup()
    const valid = ctx.sessions.create(SessionId('todo-seeded-valid'), { seed: [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'todo/write', seq: 1, time: 2, data: { todos: [] } },
    ] })
    expect(() => valid.append('todo/write', { todos: [] })).not.toThrow()

    expect(() => ctx.sessions.create(SessionId('todo-seeded-invalid'), { seed: [
      { type: 'todo/write', seq: 0, time: 1, data: { todos: [] } },
    ] })).toThrow(/outside any open turn/)
  })

  it('tracks events committed before a prepared session is announced', async () => {
    const ctx = await setup()
    const session = ctx.sessions.prepare(SessionId('todo-prepared'))
    const detach = ctx.sessions.enter(session)
    try {
      session.append('turn/start', { turn: 1 })
      expect(() => session.append('todo/write', { todos: [] })).not.toThrow()
      ctx.sessions.announce(session)
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      expect(() => session.append('todo/write', { todos: [] })).toThrow(/outside any open turn/)
    } finally {
      detach()
    }
  })
})
