import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import TeamService, { TeamId, TeamMessageId } from '../src/index.ts'
import { teamProjectionDefinition } from '../src/projection.ts'
import type { TeamMemberSnapshot, TeamMessageSnapshot, TeamTaskSnapshot } from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

const SIGNAL = new AbortController().signal
const PERSISTENCE_TEST_TIMEOUT_MS = 15_000
const roots: string[] = []
const contexts = new Set<Context>()

/** Detached durable Team read through the same projection definition as the service. */
function durable(agent: Agent): {
  members: readonly TeamMemberSnapshot[]
  tasks: readonly TeamTaskSnapshot[]
  pendingMessages: readonly TeamMessageSnapshot[]
} {
  let projected = teamProjectionDefinition.init(agent.session.header, agent.session.inheritedEventCount)
  for (const event of agent.session.snapshotEvents()) projected = teamProjectionDefinition.apply(projected, event)
  if (projected.failure !== undefined) throw new Error(projected.failure)
  const state = projected
  return {
    members: state.members,
    tasks: state.tasks,
    pendingMessages: state.messages.filter(message => !state.delivered.includes(message.id)),
  }
}

async function disposeContext(ctx: Context): Promise<void> {
  try {
    await ctx.fiber.dispose()
  } finally {
    contexts.delete(ctx)
  }
}

afterEach(async () => {
  const failures: unknown[] = []
  for (const ctx of [...contexts].reverse()) {
    try {
      await disposeContext(ctx)
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  for (const root of roots.splice(0)) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Agent Teams persistence test cleanup failed')
})

interface PersistenceMount {
  readonly name: string
  mount(ctx: Context, root: string): Promise<{ dispose(): Promise<void> }>
}

const backends: PersistenceMount[] = [
  {
    name: 'JSONL',
    mount: async (ctx, root) => await ctx.plugin(JsonlSessionPersistence, {
      root: join(root, 'jsonl'),
      compression: 'none',
    }),
  },
]

async function stack(
  backend: PersistenceMount,
  root: string,
  script: ConstructorParameters<typeof MockAdapter>[0],
) {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  await backend.mount(ctx, root)
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(TeamService)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  return {
    ctx,
    adapter,
    dispose: async () => { await disposeContext(ctx) },
  }
}

for (const backend of backends) {
  describe(`${backend.name} Agent Teams recovery`, () => {
    it('restores continuable teammates and tasks from the Lead log after restart', {
      timeout: PERSISTENCE_TEST_TIMEOUT_MS,
    }, async () => {
      const storageRoot = mkdtempSync(join(tmpdir(), `dsh-team-restart-${backend.name.toLowerCase()}-`))
      roots.push(storageRoot)
      const rootId = SessionId(`${backend.name.toLowerCase()}-restart-root`)

      const first = await stack(backend, storageRoot, [textResponse('initial teammate answer')])
      const firstLead = await first.ctx.agentLoop.create(rootId, { provider: 'mock', model: 'mock' })
      const started = await first.ctx.subagents.startActivation({ name: `child-${randomUUID()}`,
        provider: 'spawn',
        label: 'restart worker',
        request: { prompt: [{ type: 'text', text: 'finish before restart' }], parent: firstLead },
        signal: SIGNAL,
        delivery: 'caller',
      })
      await vi.waitFor(() => { expect(first.ctx.agents.get(started.childId)).toBeUndefined() }, { timeout: 5_000 })
      const created = await first.ctx.agentTeams.createTask(firstLead, { subject: 'carry over', description: 'survives restart' })
      await first.ctx.sessions.flush(firstLead.session)
      await first.dispose()

      const second = await stack(backend, storageRoot, [])
      const rootHandle = await second.ctx.agents.resume({
        resumeSessionId: rootId,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      const projections = second.ctx.sessionProjections.snapshot(rootHandle.agent.session).values
      expect(projections.agentTeam).toMatchObject({
        tasks: [{ id: created.id, subject: 'carry over' }],
      })
      expect(projections.subagentCatalog).toMatchObject([
        { id: started.childId, mode: 'continuable', label: 'restart worker' },
      ])
      await expect(second.ctx.agentTeams.updateTask(rootHandle.agent, {
        taskId: created.id, expectedRevision: 1, action: 'reassign', owner: started.childId,
      })).resolves.toMatchObject({ ownerId: started.childId })
      expect(second.adapter.requests).toEqual([])
      await rootHandle.dispose()
      await second.dispose()
    })

    it('keeps historical roster records and queued mail readable without delivering them after restart', {
      timeout: PERSISTENCE_TEST_TIMEOUT_MS,
    }, async () => {
      const storageRoot = mkdtempSync(join(tmpdir(), `dsh-team-mail-${backend.name.toLowerCase()}-`))
      roots.push(storageRoot)
      const rootId = SessionId(`${backend.name.toLowerCase()}-mail-root`)
      const childId = SessionId('historical-worker')

      const first = await stack(backend, storageRoot, [])
      const firstLead = await first.ctx.agentLoop.create(rootId, { provider: 'mock', model: 'mock' })
      const historical: TeamMemberSnapshot = {
        id: childId,
        name: 'mail-worker',
        description: 'historical mailbox target',
        provider: 'spawn',
        context: 'fresh',
        phase: 'provisioning',
      }
      const message = {
        id: TeamMessageId('legacy-pending'), senderId: rootId, senderName: 'lead', targetId: childId,
        content: [{ type: 'text' as const, text: 'historical pending context' }],
      }
      firstLead.session.append('team/member', { version: 2, teamId: TeamId(rootId), member: historical })
      firstLead.session.append('team/member', { version: 2, teamId: TeamId(rootId), member: { ...historical, phase: 'active' } })
      firstLead.session.append('team/message/queued', { version: 2, teamId: TeamId(rootId), message })
      await first.ctx.sessions.flush(firstLead.session)
      await first.dispose()

      const second = await stack(backend, storageRoot, [])
      const rootHandle = await second.ctx.agents.resume({
        resumeSessionId: rootId,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      expect(durable(rootHandle.agent)).toMatchObject({
        members: [{ ...historical, phase: 'active' }],
        pendingMessages: [message],
      })
      const projections = second.ctx.sessionProjections.snapshot(rootHandle.agent.session).values
      expect(projections.agentTeam).toEqual({ tasks: [] })
      expect(second.ctx.agents.get(childId)).toBeUndefined()
      expect(second.adapter.requests).toEqual([])

      await rootHandle.dispose()
      await second.dispose()
    })
  })
}
