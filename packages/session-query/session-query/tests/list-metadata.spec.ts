/** Shared list metadata keeps its values and lifetime across independent consumers. */

import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { registerSessionListMetadata } from '../src/list-metadata.ts'

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

describe('shared Session-list metadata', () => {
  it('tracks human prompts and turns while preserving unchanged state references', async () => {
    const ctx = await setup()
    const read = await registerSessionListMetadata(ctx)
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

  it('shares one cell and notification across owners until the last owner unloads', async () => {
    const ctx = await setup()
    const first = await ctx.plugin(Object.assign(function firstOwner() {}, { inject: ['sessionProjections'] }))
    const second = await ctx.plugin(Object.assign(function secondOwner() {}, { inject: ['sessionProjections'] }))
    const firstRead = await registerSessionListMetadata(first.ctx)
    const secondRead = await registerSessionListMetadata(second.ctx)
    const session = ctx.sessions.create()
    expect(firstRead(session)).toBe(secondRead(session))
    const changed = vi.fn()
    ctx.sessionProjections.onChanged(changed)
    session.append('turn/start', { turn: 1 })
    expect(changed).toHaveBeenCalledOnce()
    expect(firstRead(session)).toBe(secondRead(session))

    await first.dispose()
    const event = prompt(session)
    expect(secondRead(session)).toEqual({ blank: false, lastPromptAt: event.time })
    expect(ctx.sessionProjections.snapshot(session).values.sessionListMetadata).toEqual(secondRead(session))
    await second.dispose()
    expect(ctx.sessionProjections.snapshot(session).values).not.toHaveProperty('sessionListMetadata')
  })

  it('folds existing live history when the first consumer registers', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    const event = prompt(session)
    const read = await registerSessionListMetadata(ctx)
    expect(read(session)).toEqual({ blank: false, lastPromptAt: event.time })
  })
})
