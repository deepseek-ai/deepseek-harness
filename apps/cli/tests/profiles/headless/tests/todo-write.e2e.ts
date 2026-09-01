import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { codingHarness, TODO_SYSTEM_PROMPT, waitForIdle } from './harness.ts'
import { SessionId } from '@deepseek-ai/dsh-session'

/**
 * A REAL model drives the REAL todo_write tool: verify the WORLD (the session
 * log gains a todo/write event whose snapshot the model actually produced), not
 * the agent's self-report. Key-gated (see vitest.e2e.config.ts).
 */

let ctx: Context | undefined
let workdir: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('todo_write: real model records a plan', () => {
  it('appends a todo/write event with the model-produced task list', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'dsh-todo-write-e2e-'))
    ctx = await codingHarness(workdir, { persona: TODO_SYSTEM_PROMPT })
    const agent = ctx.agentLoop.create(SessionId('e2e-todo'), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text:
      'Use the todo_write tool to record a plan of exactly three steps for work '
      + 'running in parallel: "inspect the failing test" (in_progress), '
      + '"watch the background build" (in_progress), then "apply the fix" (pending). '
      + 'Send all three in one todo_write call, then reply with the single word DONE.' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const events = agent.session.snapshotEvents()

    // The model actually called the tool.
    const calls = events.filter(event => event.type === 'tool/call')
    expect(calls.some(event => event.data.name === 'todo_write')).toBe(true)

    // And the tool wrote a todo/write event to the log — verify the WORLD,
    // including two simultaneously in_progress tasks (the parallel contract).
    const todoEvents = events.filter(event => event.type === 'todo/write')
    expect(todoEvents.length).toBeGreaterThan(0)

    const todos = (todoEvents.at(-1)!).data.todos
    expect(todos).toEqual([
      { content: 'inspect the failing test', status: 'in_progress' },
      { content: 'watch the background build', status: 'in_progress' },
      { content: 'apply the fix', status: 'pending' },
    ])
  }, 120_000)
})
