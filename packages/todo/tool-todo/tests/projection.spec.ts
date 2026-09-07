/**
 * The `todos` projection provider (session-projection RFC knife 4 — the "a
 * fourth domain is just its own registrations" acceptance probe): mounting
 * tool-todo beside the registry serves the whole current list with a
 * consistent asOfSeq (= last event seq); before any write the value is null; a
 * composition without tool-todo has no `todos` key; unmounting tool-todo
 * removes it (HMR safety). The carrier and framework are exercised unmodified.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'

interface Bench {
  ctx: Context
  session: Session
  tailProjections(): Promise<{ asOfSeq: number; values: Record<string, unknown> } | undefined>
}

async function harness(withTodoTool: boolean): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  if (withTodoTool) await ctx.plugin(ToolTodo, { allowParallelInProgress: true })
  const session = ctx.sessions.create()
  ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
  return {
    ctx,
    session,
    async tailProjections() {
      return ctx.sessionProjections.snapshot(session)
    },
  }
}

/** One paginable message so the tail page is non-degenerate. */
function seedMessage(session: Session): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

describe('todos projection provider', () => {
  it('serves null before the first todo/write', async () => {
    const bench = await harness(true)
    seedMessage(bench.session)
    const projections = await bench.tailProjections()
    expect(projections?.values.todos).toBeNull()
    expect(projections?.asOfSeq).toBe(bench.session.seq - 1)
  })

  it('serves the latest whole list after writes, asOfSeq = last event seq', async () => {
    const bench = await harness(true)
    const session = bench.session
    seedMessage(session)
    const first: TodoItem[] = [{ content: 'a', status: 'pending' }]
    const second: TodoItem[] = [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
    ]
    session.append('turn/start', { turn: 1 })
    session.append('todo/write', { todos: first })
    session.append('todo/write', { todos: second })
    const projections = await bench.tailProjections()
    // Last-wins: the latest snapshot, whole.
    expect(projections?.values.todos).toEqual(second)
    expect(projections?.asOfSeq).toBe(session.seq - 1)
  })

  it('clears the standing plan on the next turn/start (turn/end keeps it)', async () => {
    const bench = await harness(true)
    const session = bench.session
    seedMessage(session)
    const list: TodoItem[] = [{ content: 'done', status: 'completed' }]
    session.append('turn/start', { turn: 1 })
    session.append('todo/write', { todos: list })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect((await bench.tailProjections())?.values.todos).toEqual(list)
    session.append('turn/start', { turn: 2 })
    const cleared = await bench.tailProjections()
    expect(cleared?.values.todos).toBeNull()
    expect(cleared?.asOfSeq).toBe(session.seq - 1)
  })

  it('has no todos key when tool-todo is not composed', async () => {
    const bench = await harness(false)
    seedMessage(bench.session)
    const projections = await bench.tailProjections()
    expect(projections).toBeDefined()
    expect('todos' in (projections?.values ?? {})).toBe(false)
  })

  it('drops the key when the tool-todo fiber unloads (HMR safety)', async () => {
    const bench = await harness(false)
    seedMessage(bench.session)
    const fiber = await bench.ctx.plugin(ToolTodo, { allowParallelInProgress: true })
    expect((await bench.tailProjections())?.values.todos).toBeNull()
    await fiber.dispose()
    expect('todos' in ((await bench.tailProjections())?.values ?? {})).toBe(false)
  })
})
