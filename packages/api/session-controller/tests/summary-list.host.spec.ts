/**
 * Session-list summary payloads: a `session.list` row carries every registered
 * wire projection except the units that declare `summary: false`
 * (`turnOutline`, `sessionStats`, `todos`, `imageLimits`), while an opened Session's
 * `session/follow` opening snapshot keeps serving them.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import {
  apply as sessionStatsApply, inject as sessionStatsInject, name as sessionStatsName,
} from '@deepseek-ai/dsh-session-stats'
import {
  apply as turnOutlineApply, inject as turnOutlineInject, name as turnOutlineName,
} from '@deepseek-ai/dsh-session-turn-outline'
import {
  apply as toolTodoApply, Config as toolTodoConfig, inject as toolTodoInject, name as toolTodoName,
} from '@deepseek-ai/dsh-tool-todo'
import { createSessionTestRemote } from './test-remote.ts'

const SUMMARY_EXCLUDED_KEYS = ['turnOutline', 'sessionStats', 'todos', 'imageLimits'] as const

const ownedContexts = new Set<Context>()
afterEach(async () => {
  await Promise.all([...ownedContexts].map(ctx => ctx.fiber.dispose()))
  ownedContexts.clear()
})

const remote = (ctx: Context) => createSessionTestRemote(ctx, {
  defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
  cwd: '/tmp',
})

/** Read and close one snapshot-first follow generation. */
async function opening(
  ctx: Context,
  sessionId: SessionId,
): Promise<Extract<SessionFollowFrame, { type: 'snapshot' }>> {
  const abort = new AbortController()
  const iterator = (await remote(ctx)).follow({ address: { kind: 'session', sessionId } }, abort.signal)[Symbol.asyncIterator]()
  const first = await iterator.next()
  abort.abort()
  await iterator.return?.()
  if (first.done || first.value.type !== 'snapshot') throw new Error('follow did not open with a snapshot')
  return first.value
}

/**
 * Mount the registry plus the four summary-excluded units and one ordinary
 * wire unit. The tool plugin needs a tool registry; the list path never
 * executes a tool, so a registration sink is enough.
 */
async function harness(): Promise<{ ctx: Context; sessionContext: Context }> {
  const ctx = new Context()
  ownedContexts.add(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.provide('tools', { register: () => () => {} } as never)
  await ctx.sessionProjections.register(agentPresetProjectionDefinition)
  await ctx.plugin({ name: turnOutlineName, inject: turnOutlineInject, apply: turnOutlineApply })
  await ctx.plugin({ name: sessionStatsName, inject: sessionStatsInject, apply: sessionStatsApply })
  await ctx.plugin({
    name: toolTodoName,
    inject: toolTodoInject,
    Config: toolTodoConfig,
    apply: toolTodoApply,
  }, { allowParallelInProgress: false })
  // Build the remote (and with it the list owner that registers
  // `sessionListMetadata`) before any Session exists, so every registered unit
  // seeds a cell at `session/created`.
  await remote(ctx)
  return { ctx, sessionContext: ctx }
}

/** One Session with a closed turn, a tool-free todo write, and a preset. */
function seedSession(ctx: Context): { id: SessionId } {
  const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace', agentPreset: 'standard' } })
  session.append('turn/start', { turn: 1 })
  session.append('todo/write', { todos: [{ content: 'ship it', status: 'in_progress' }] })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return { id: session.id }
}

describe('session.list summary payload', () => {
  it('carries every registered wire key except the summary-excluded units', async () => {
    const { ctx } = await harness()
    const { id } = seedSession(ctx)
    const session = ctx.sessions.get(id)
    if (session === undefined) throw new Error('session was not created')
    const everyWireKey = Object.keys(ctx.sessionProjections.snapshot(session).values)
    // The fixture must actually exercise the excluded units.
    for (const key of SUMMARY_EXCLUDED_KEYS) expect(everyWireKey).toContain(key)

    expect([...ctx.sessionProjections.summaryKeys()]).not.toContain('turnOutline')

    const response = await (await remote(ctx)).list({})
    if (!response.ok) throw new Error('unreachable')
    const row = response.value.items.find(item => item.sessionId === id)
    const served = Object.keys(row?.projections?.values ?? {})
    expect(served.sort()).toEqual(everyWireKey.filter(key => !SUMMARY_EXCLUDED_KEYS.includes(
      key as (typeof SUMMARY_EXCLUDED_KEYS)[number],
    )).sort())
    for (const key of SUMMARY_EXCLUDED_KEYS) expect(served).not.toContain(key)
    // An ordinary wire unit is still there with its value.
    expect(row?.projections?.values.sessionListMetadata).toMatchObject({ blank: false })
  })

  it('keeps the excluded units on an opened Session\'s follow snapshot', async () => {
    const { ctx } = await harness()
    const { id } = seedSession(ctx)
    const session = ctx.sessions.get(id)
    if (session === undefined) throw new Error('session was not created')
    const everyValue = ctx.sessionProjections.snapshot(session).values

    const snapshot = await opening(ctx, id)
    for (const key of SUMMARY_EXCLUDED_KEYS) {
      expect(snapshot.projections.values).toHaveProperty(key)
      expect(snapshot.projections.values[key as keyof typeof snapshot.projections.values])
        .toEqual(everyValue[key as keyof typeof everyValue])
    }
    expect(snapshot.projections.values.todos).toEqual([{ content: 'ship it', status: 'in_progress' }])
    expect(snapshot.projections.values.imageLimits).toEqual(ctx.attachments.imageLimits)
  })

  it('drops the excluded units from the list while a Session is still attached', async () => {
    const { ctx } = await harness()
    const { id } = seedSession(ctx)
    // Two consecutive pulls: a refresh must not reintroduce a dropped unit.
    for (const attempt of [0, 1]) {
      const response = await (await remote(ctx)).list({})
      if (!response.ok) throw new Error('unreachable')
      const row = response.value.items.find(item => item.sessionId === id)
      expect(row?.projections?.values, `attempt ${String(attempt)}`).not.toHaveProperty('turnOutline')
      expect(row?.projections?.values, `attempt ${String(attempt)}`).not.toHaveProperty('sessionStats')
      expect(row?.projections?.values, `attempt ${String(attempt)}`).not.toHaveProperty('todos')
      expect(row?.projections?.values, `attempt ${String(attempt)}`).not.toHaveProperty('imageLimits')
    }
  })
})
