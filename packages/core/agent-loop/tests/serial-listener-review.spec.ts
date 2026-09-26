import { setImmediate } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import LocalFileReference from '@deepseek-ai/dsh-file-reference-local'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as SubagentTool from '@deepseek-ai/dsh-tool-subagent'
import Selection from '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'due-work': { kind: 'due-work'; plugin: string } & ContextFormed
  }
}

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function core(persistenceRoot?: string) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  if (persistenceRoot !== undefined) await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

/** Host Session lookup a due-work producer performs; the Schedule plugin resolves its Session through the same service. */
interface DueWorkSessionController {
  /** Resolve the Agent bound to one Session, waiting while that Session is still being created. */
  resolveAgent(id: SessionId): Promise<{ readonly agent: Agent }>
}

/**
 * Build the producer whose due work this file orders against Agent creation.
 *
 * Delivery ordering is an Agent-loop property, so its producer is a local
 * fixture; the Schedule plugin's own delivery is covered beside the record
 * schema it reads.
 * @param sessionId - Session the producer delivers to.
 * @param plugin - plugin name recorded as the delivered message's source.
 * @returns the plugin to mount and the promise of its single delivery attempt.
 */
function dueWorkProducer(sessionId: SessionId, plugin: string) {
  const delivery = Promise.withResolvers<undefined>()
  const producer = {
    name: plugin,
    inject: ['sessions', 'sessionController'],
    apply(ctx: Context): void {
      const attempt = async (): Promise<void> => {
        const controller = ctx.get('sessionController') as DueWorkSessionController
        const { agent } = await controller.resolveAgent(sessionId)
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: 'Due plugin follow-up' }],
          source: { kind: 'due-work', plugin },
        }))
        await ctx.sessions.flush(agent.session)
      }
      void attempt().then(() => { delivery.resolve(undefined) }, (error: unknown) => { delivery.reject(error) })
    },
  }
  return { producer, delivery: delivery.promise }
}

describe('serial creation listener integrations', () => {
  it('rolls back creation when file-reference prompt installation fails', async () => {
    const ctx = await core()
    const errors: string[] = []
    ctx.logger.error = ((error: unknown) => { errors.push(String(error)) }) as typeof ctx.logger.error
    await ctx.plugin(LocalFileReference)
    try {
      await expect(ctx.agents.create({
        sessionId: SessionId('review-file-reference'),
        setup(agentCtx) {
          agentCtx.systemPrompt.section({ name: 'context:file-reference', order: 0, text: 'occupied' })
        },
      })).rejects.toThrow('context:file-reference')
      expect(errors.some(error => error.includes('context:file-reference'))).toBe(true)
      expect(ctx.agents.list()).toEqual([])
      expect(ctx.sessions.list()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rolls back creation when a shared preset tool installation fails', async () => {
    const ctx = await core()
    const errors: string[] = []
    ctx.logger.error = ((error: unknown) => { errors.push(String(error)) }) as typeof ctx.logger.error
    await ctx.plugin(Selection)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    const preset = createScope(ctx, { preset: 'review' })
    await preset.ctx.plugin(SubagentTool, { provider: 'spawn', modelSelectionSettings: true, backgroundMode: 'continuable' })
    try {
      await expect(ctx.agents.create({
        sessionId: SessionId('review-tool'),
        setup(agentCtx) {
          bindScopeParent(scopeOf(agentCtx)!, scopeOf(preset.ctx)!)
          agentCtx.tools.register(defineContentToolFixture({ name: 'subagent', description: 'occupied', parameters: {}, execute: () => Promise.resolve([]) }))
        },
      })).rejects.toThrow('subagent')
      expect(errors.some(error => error.includes('subagent'))).toBe(true)
      expect(ctx.agents.list()).toEqual([])
      expect(ctx.sessions.list()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('starts due plugin work only after every creation listener finishes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-serial-due-'))
    roots.push(root)
    const ctx = await core(root)
    const sessionId = SessionId('review-due-work')
    const plugin = 'review-due-reminder'
    const available = Promise.withResolvers<Agent>()
    // The resolver returns the Agent while its serial publication listeners are blocked.
    ctx.provide('sessionController', {
      resolveAgent: async (id: SessionId) => {
        expect(id).toBe(sessionId)
        return { agent: await available.promise }
      },
    } as never)
    const { producer, delivery } = dueWorkProducer(sessionId, plugin)
    await ctx.plugin(producer)
    const inserted: unknown[] = []
    ctx.on('agent/inbox/inserted', ({ message }) => { inserted.push(message.source) })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const turn = Promise.withResolvers<undefined>()
    let turns = 0
    let created = false
    let laterCreated = false
    ctx.on('agent/created', async ({ agent }) => {
      available.resolve(agent)
      entered.resolve(undefined)
      await release.promise
      created = true
    })
    ctx.on('agent/created', () => { laterCreated = true })
    ctx.on('session/event', (_session, event) => { if (event.type === 'turn/start') { turns += 1; turn.resolve(undefined) } })
    const creating = ctx.agents.create({ sessionId })
    try {
      await entered.promise
      await delivery
      // A full event-loop turn lets due work run if it starts during creation.
      await setImmediate()
      expect(inserted).toHaveLength(1)
      expect(inserted[0]).toMatchObject({ kind: 'due-work', plugin })
      expect(turns).toBe(0)
      expect(laterCreated).toBe(false)
      release.resolve(undefined)
      await creating
      await turn.promise
      expect(created).toBe(true)
      expect(laterCreated).toBe(true)
    } finally {
      release.resolve(undefined)
      await creating
      await ctx.fiber.dispose()
    }
  })
})
