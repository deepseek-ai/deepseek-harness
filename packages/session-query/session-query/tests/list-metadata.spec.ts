/** Session-list metadata is registered and read through the query service lifecycle. */

import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, onTestFinished } from 'vitest'
import { TestSessionQueryEngine } from './test-service.ts'

async function setup() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  return ctx
}

function prompt(session: Session) {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Continue the task.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

describe('Session-list metadata', () => {
  it('tracks human prompts and turns while preserving unchanged state references', async () => {
    const ctx = await setup()
    await ctx.plugin(TestSessionQueryEngine)
    const read = (session: Session) => ctx.sessionQuery.getListMetadata(session)
    const session = ctx.sessions.create()
    const initial = read(session)
    expect(initial).toEqual({ blank: true, lastPromptAt: null })

    session.append('session/title', { title: 'Task', messageSeqs: [], source: { kind: 'user' } })
    expect(read(session)).toBe(initial)
    const first = prompt(session)
    expect(read(session)).toEqual({ blank: true, lastPromptAt: first.time })
    session.append('turn/start', { turn: 1 })
    const active = read(session)
    expect(active).toEqual({ blank: false, lastPromptAt: first.time })
    session.append('turn/start', { turn: 2 })
    expect(read(session)).toBe(active)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Context refresh.' }],
      source: { kind: 'system-prompt' },
    }), { surfaceOp: 'append' })
    expect(read(session)).toBe(active)
    const latest = prompt(session)
    expect(read(session)).toEqual({ blank: false, lastPromptAt: latest.time })
    expect(ctx.sessionProjections.snapshot(session).values.sessionListMetadata).toEqual(read(session))
    expect(ctx.sessionProjections.checkpoint(session).sessionListMetadata?.ver).toBe(1)
  })

  it('releases the projection registration when the query service is disposed', async () => {
    const ctx = await setup()
    const fiber = await ctx.plugin(TestSessionQueryEngine)
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    expect(ctx.sessionProjections.snapshot(session).values.sessionListMetadata)
      .toEqual({ blank: false, lastPromptAt: null })

    await fiber.dispose()
    expect(ctx.sessionProjections.snapshot(session).values).not.toHaveProperty('sessionListMetadata')
  })

  it('folds existing live history when the query service starts', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    const event = prompt(session)
    await ctx.plugin(TestSessionQueryEngine)
    expect(ctx.sessionQuery.getListMetadata(session)).toEqual({ blank: false, lastPromptAt: event.time })
  })
})
