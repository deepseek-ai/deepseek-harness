import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import { type Agent } from '@deepseek-ai/dsh-agent'

import * as tool from '../src/index.ts'

const testToolSignal = new AbortController().signal

/**
 * Drives the REAL plugin body: mounts `dsh-tool-todo` on a real `ToolRuntime`
 * and invokes the registered `todo_write` tool through `ctx.tools.execute`,
 * with a fake parent Agent carrying a real `Session` — so the append the tool
 * makes is observable on a genuine session log (only the agent wrapper is a
 * stand-in; the session and the tool are the shipping code).
 */

/** A parent Agent backed by a real Session — the tool reads `agent.session`. */
function agentWithSession(id = 'parent-1'): Agent & { session: Session } {
  const session = Session.create(SessionId(id))
  return { id: SessionId(id), session } as unknown as Agent & { session: Session }
}

async function setup(allowParallelInProgress: boolean): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(tool, { allowParallelInProgress })
  return ctx
}

let callCounter = 0
function callTodo(ctx: Context, args: unknown, over: { agent?: Agent | undefined } = {}) {
  const agent = 'agent' in over ? over.agent : agentWithSession()
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${++callCounter}`),
    name: 'todo_write',
    arguments: args,
    ...agent ? { agent } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('dsh-tool-todo', () => {
  it('registers a `todo_write` tool whose schema is an array of {content,status}', async () => {
    const ctx = await setup(true)
    const schema = ctx.tools.schemas().find(s => s.name === 'todo_write')
    expect(schema).toBeDefined()
    const props = (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props)).toEqual(['todos'])
    const todos = props.todos as { type: string; items?: { properties?: Record<string, { type: string; enum?: string[] }> } }
    expect(todos.type).toBe('array')
    const itemProps = todos.items?.properties ?? {}
    expect(Object.keys(itemProps).sort()).toEqual(['content', 'status'])
    expect(itemProps.status?.enum).toEqual(['pending', 'in_progress', 'completed'])
  })

  it('appends a todo/write event carrying the whole list to the calling session', async () => {
    const ctx = await setup(true)
    const agent = agentWithSession('writer')
    const todos: TodoItem[] = [
      { content: 'plan', status: 'in_progress' },
      { content: 'build', status: 'pending' },
    ]
    const result = await callTodo(ctx, { todos }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected todo_write success')
    expect(result.value).toEqual({
      todos,
      counts: { pending: 1, inProgress: 1, completed: 0 },
    })
    expect(text(result)).toContain('1 pending, 1 in progress, 0 completed')

    const event = agent.session.snapshotEvents().findLast(e => e.type === 'todo/write')!
    expect(event.data.todos).toEqual(todos)
  })

  it('stores the trimmed content (the dedupe/length key), not the raw input', async () => {
    const ctx = await setup(true)
    const agent = agentWithSession('trim')
    const result = await callTodo(ctx, { todos: [{ content: '  plan the work  ', status: 'pending' }] }, { agent })
    expect(result.isError).toBe(false)

    const event = agent.session.snapshotEvents().findLast(e => e.type === 'todo/write')!
    expect(event.data.todos).toEqual([{ content: 'plan the work', status: 'pending' }])
  })

  it('replaces the list on a second call (last-write-wins on the log)', async () => {
    const ctx = await setup(true)
    const agent = agentWithSession('writer-2')
    await callTodo(ctx, { todos: [{ content: 'a', status: 'pending' }] }, { agent })
    await callTodo(ctx, { todos: [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
    ] }, { agent })

    const current = agent.session.snapshotEvents().findLast(e => e.type === 'todo/write')!.data.todos
    expect(current).toEqual([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
    ])
  })

  it('rejects a malformed status before execute runs (registry arg-validation)', async () => {
    const ctx = await setup(true)
    const result = await callTodo(ctx, { todos: [{ content: 'x', status: 'doing' }] })
    expect(result.isError).toBe(true)
  })

  it('rejects a non-array todos argument', async () => {
    const ctx = await setup(true)
    const result = await callTodo(ctx, { todos: 'nope' })
    expect(result.isError).toBe(true)
  })

  it('accepts several in_progress items at once (parallel work)', async () => {
    const ctx = await setup(true)
    const agent = agentWithSession('parallel')
    const todos: TodoItem[] = [
      { content: 'run subagent a', status: 'in_progress' },
      { content: 'run subagent b', status: 'in_progress' },
      { content: 'merge results', status: 'pending' },
    ]
    const result = await callTodo(ctx, { todos }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected todo_write success')
    expect(result.value).toEqual({
      todos,
      counts: { pending: 1, inProgress: 2, completed: 0 },
    })
    expect(agent.session.snapshotEvents().findLast(e => e.type === 'todo/write')!.data.todos).toEqual(todos)
  })

  describe('allowParallelInProgress', () => {
    const parallel = [
      { content: 'run subagent a', status: 'in_progress' },
      { content: 'run subagent b', status: 'in_progress' },
    ]

    it('false rejects a call marking several items in_progress', async () => {
      const ctx = await setup(false)
      const agent = agentWithSession('single-active')
      const result = await callTodo(ctx, { todos: parallel }, { agent })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('at most one task may be in_progress')
      // A rejected call must not reach the durable log.
      expect(agent.session.snapshotEvents().some(e => e.type === 'todo/write')).toBe(false)
    })

    it('false still accepts one active item', async () => {
      const ctx = await setup(false)
      const todos: TodoItem[] = [
        { content: 'run subagent a', status: 'in_progress' },
        { content: 'run subagent b', status: 'pending' },
      ]
      const result = await callTodo(ctx, { todos })
      expect(result.isError).toBe(false)
    })

    it('true accepts the very list false rejects', async () => {
      const ctx = await setup(true)
      const result = await callTodo(ctx, { todos: parallel })
      expect(result.isError).toBe(false)
    })

    it('instructs the model to keep at most one active, while true instructs parallel', async () => {
      const single = await setup(false)
      const singleDesc = single.tools.schemas().find(s => s.name === 'todo_write')!.description
      expect(singleDesc).toContain('Keep AT MOST ONE todo `in_progress`')
      expect(singleDesc).not.toContain('several at once')

      const parallelDesc = (await setup(true)).tools.schemas().find(s => s.name === 'todo_write')!.description
      expect(parallelDesc).toContain('several at once when work genuinely runs in parallel')
      expect(parallelDesc).not.toContain('AT MOST ONE')
    })
  })

  it.each([
    { label: 'empty content', todos: [{ content: '   ', status: 'pending' }], fragment: 'non-empty' },
    { label: 'duplicate content', todos: [{ content: 'dup', status: 'pending' }, { content: 'dup', status: 'completed' }], fragment: 'duplicate' },
    { label: 'unknown item keys', todos: [{ content: 'a', status: 'pending', children: [] }], fragment: 'not a declared property' },
  ])('rejects $label as an isError result', async ({ todos, fragment }) => {
    const ctx = await setup(true)
    const result = await callTodo(ctx, { todos })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(fragment)
  })

  it('rejects a non-agent caller (the list has no owning session)', async () => {
    const ctx = await setup(true)
    const result = await callTodo(ctx, { todos: [{ content: 'a', status: 'pending' }] }, { agent: undefined })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('owning agent session')
  })

  it('presents the call with a stable title and the list as raw input', async () => {
    const ctx = await setup(true)
    const def = ctx.tools.get('todo_write')!
    const todos = [{ content: 'a', status: 'pending' }]
    expect(def.presentCall?.({ todos })).toEqual({ card: 'generic', title: 'Update todo list', kind: 'other', rawInput: todos })
  })

  it('unregisters the tool when its contributing fiber is disposed (HMR-safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    const fiber = await ctx.plugin(tool, { allowParallelInProgress: true })
    expect(ctx.tools.schemas().some(s => s.name === 'todo_write')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'todo_write')).toBe(false)
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    // A default export would make Loader unwrap only apply and drop `inject`.
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-todo')
    expect(tool.inject).toEqual(['tools', 'sessionProjections'])

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(tool) as Record<string, unknown>
    expect(unwrapped).toBe(tool)
    expect(unwrapped.name).toBe('tool-todo')
    expect(unwrapped.inject).toEqual(['tools', 'sessionProjections'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})

describe('todo/write event', () => {
  it('appends the whole-list snapshot and isolates the log from later mutation', () => {
    const session = Session.create(SessionId('t1'))
    session.append('turn/start', { turn: 1 })
    const todos: TodoItem[] = [
      { content: 'plan the work', status: 'in_progress' },
      { content: 'write the code', status: 'pending' },
    ]
    session.append('todo/write', { todos })

    const event = session.snapshotEvents().findLast(e => e.type === 'todo/write')!
    expect(event.type).toBe('todo/write')
    expect(event.data.todos).toEqual(todos)

    todos.push({ content: 'sneak in', status: 'pending' })
    todos[0]!.status = 'completed'
    expect(event.data.todos).toEqual([
      { content: 'plan the work', status: 'in_progress' },
      { content: 'write the code', status: 'pending' },
    ])
  })

  it('is last-write-wins: the current list is the most recent todo/write', () => {
    const session = Session.create(SessionId('t2'))
    session.append('turn/start', { turn: 1 })
    session.append('todo/write', { todos: [{ content: 'first', status: 'pending' }] })
    session.append('todo/write', { todos: [
      { content: 'first', status: 'completed' },
      { content: 'second', status: 'in_progress' },
    ] })

    const current = session.snapshotEvents().findLast(e => e.type === 'todo/write')!.data.todos
    expect(current).toEqual([
      { content: 'first', status: 'completed' },
      { content: 'second', status: 'in_progress' },
    ])
  })

  it('does not add a derived message or surface node', () => {
    const session = Session.create(SessionId('t3'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'q' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const before = session.deriveMessages().length
    session.append('todo/write', { todos: [{ content: 'a task', status: 'pending' }] })

    expect(session.deriveMessages()).toHaveLength(before)
    expect(session.surface.nodes).not.toContain(session.seq - 1)
  })

  it('round-trips through a seeded replay identically without surface metadata', () => {
    const original = Session.create(SessionId('t4'))
    original.append('turn/start', { turn: 1 })
    original.append('todo/write', { todos: [{ content: 'only', status: 'completed' }] })
    original.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const replayed = Session.create(SessionId('t4-replay'), original.snapshotEvents())

    expect(replayed.snapshotEvents().findLast(e => e.type === 'todo/write')!.data.todos)
      .toEqual([{ content: 'only', status: 'completed' }])
    expect(replayed.snapshotEvents(SessionLogOffset(0), original.seq)).toEqual(original.snapshotEvents())
    expect(replayed.firstLiveSeq).toBe(original.seq)
  })
})
