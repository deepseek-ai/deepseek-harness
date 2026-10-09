import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
/**
 * A preset-mounted Schedule tool reaches a delegated child, and the Host
 * Schedule service refuses the child's own Session because the Session
 * controller can never deliver a reminder there.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '../../../session/session-persistence-jsonl/src/index.ts'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import Storage from '../../../storage/storage/src/index.ts'
import { DomainFacility } from '../../../storage/storage-domain/src/index.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import ScheduleService from '../../../schedule/schedule/src/index.ts'
import * as ToolSchedule from '../../../schedule/tool-schedule/src/index.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** One host carrying the real Schedule service and a preset that mounts the real tools. */
async function setupScheduleHost(): Promise<{ ctx: Context; parent: Agent; dispatched: ReturnType<typeof vi.fn> }> {
  const ctx = new Context()
  contexts.push(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-schedule-tools-'))
  roots.push(root)
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(Storage)
  const pool = new MemoryMediaPool()
  const backend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
  // The fake is unreachable while the service refuses a subagent Session; a
  // call means the refusal let a reminder reach delivery.
  const dispatched = vi.fn(async () => { throw new Error('a subagent Session must never be dispatched') })
  ctx.provide('sessionController', { resolveAgent: dispatched } as never)
  await ctx.plugin(ScheduleService)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(AgentPresets, { default: 'coding' })
  ctx.loader.builtins['tool-schedule'] = ToolSchedule
  await ctx.agentPresets.register({ id: 'coding', plugins: [{ name: 'cordis:tool-schedule' }] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([
    toolCallResponse('schedule-call', 'schedule_create', { prompt: 'Check', title: 'Check', after_seconds: 60 }),
    textResponse('child done'),
  ]))
  const handle = await ctx.agents.create({
    sessionId: SessionId('parent'),
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'coding'),
  })
  return { ctx, parent: handle.agent, dispatched }
}

function toolResultTexts(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result')
    .map(event => event.data.message.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

describe('a delegated child under a preset that mounts the Schedule tools', () => {
  it('sees schedule_create and is refused with subagent_session without storing a task', async () => {
    const { ctx, parent, dispatched } = await setupScheduleHost()
    const run = await ctx.subagents.startActivation({
      provider: 'spawn',
      label: 'child task',
      delivery: 'caller',
      signal: new AbortController().signal,
      request: { parent, prompt: [{ type: 'text', text: 'child task' }] },
    })

    const child = ctx.agents.get(run.childId)
    if (child === undefined) throw new Error('the child run published no agent')
    expect(child.session.header.origin).toBe('subagent')
    expect(ctx.tools.schemas(child).map(schema => schema.name)).toContain('schedule_create')
    await run.result
    expect(toolResultTexts(child).join('')).toContain('"code":"subagent_session"')
    expect(await ctx.schedule.list({ sessionId: child.session.id })).toEqual([])
    expect(await ctx.schedule.catalog()).toEqual([])
    expect(dispatched).not.toHaveBeenCalled()
    await run.dispose()
  })
})
