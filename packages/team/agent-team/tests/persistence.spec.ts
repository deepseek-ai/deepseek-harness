import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import TeamService from '../src/index.ts'
import type { TeamId, TeamMessageId, TeamTaskId } from '../src/types.ts'
import { teamProjectionDefinition } from '../src/projection.ts'
import type { TeamMemberSnapshot } from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

const SIGNAL = new AbortController().signal
const PERSISTENCE_TEST_TIMEOUT_MS = 15_000
const roots: string[] = []
const contexts = new Set<Context>()

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
  config: ConstructorParameters<typeof TeamService>[1] = {},
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
  await ctx.plugin(TeamService, config)
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
    it.each([undefined, false, true])('preserves saved mode %s when resumed with the opposite default', async (enabled) => {
      const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-default-'))
      roots.push(storageRoot)
      const id = brandString<SessionId>('configured-resume')
      const first = await stack(backend, storageRoot, [], { defaultEnabled: enabled === true })
      const lead = await first.ctx.agentLoop.create(id, { provider: 'mock', model: 'mock' })
      lead.session.append('session/title', { title: 'Saved session', messageSeqs: [], source: { kind: 'user' } })
      await first.ctx.sessions.flush(lead.session)
      if (enabled === false) {
        await first.ctx.agentTeams.setEnabled(lead, true)
        await first.ctx.agentTeams.setEnabled(lead, enabled)
      }
      const before = lead.session.ownEvents().filter(event => event.type === 'team/mode').map(event => event.data)
      await first.dispose()
      const second = await stack(backend, storageRoot, [], { defaultEnabled: enabled !== true })
      const resumed = await second.ctx.agents.resume({ resumeSessionId: id })
      expect(second.ctx.agentTeams.isEnabled(resumed.agent)).toBe(enabled === true)
      expect(resumed.agent.session.ownEvents().filter(event => event.type === 'team/mode').map(event => event.data)).toEqual(before)
      await resumed.dispose()
    })

    it('restores the saved mode and retains tasks while disabled', async () => {
      const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-mode-'))
      roots.push(storageRoot)
      const id = brandString<SessionId>('saved-mode')
      const first = await stack(backend, storageRoot, [])
      const lead = await first.ctx.agentLoop.create(id, { provider: 'mock', model: 'mock' })
      expect(first.ctx.agentTeams.isEnabled(lead)).toBe(false)
      await first.ctx.agentTeams.setEnabled(lead, true)
      const task = await first.ctx.agentTeams.createTask(lead, { subject: 'saved', description: 'retained while off' })
      const claimed = await first.ctx.agentTeams.updateTask(lead, { taskId: task.id, expectedRevision: task.revision, action: 'claim' })
      expect(claimed.ownerName).toBe('lead')
      await first.ctx.agentTeams.setEnabled(lead, false)
      await first.dispose()
      const second = await stack(backend, storageRoot, [])
      const resumed = await second.ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
      expect(second.ctx.agentTeams.isEnabled(resumed.agent)).toBe(false)
      expect(second.ctx.sessionProjections.snapshot(resumed.agent.session).values.agentTeam)
        .toMatchObject({ enabled: false, tasks: [claimed] })
      await second.ctx.agentTeams.setEnabled(resumed.agent, true)
      expect(second.ctx.agentTeams.listTasks(resumed.agent)).toEqual([claimed])
    })

    it('restores continuable teammates and tasks from the Lead log after restart', {
      timeout: PERSISTENCE_TEST_TIMEOUT_MS,
    }, async () => {
      const storageRoot = mkdtempSync(join(tmpdir(), `dsh-team-restart-${backend.name.toLowerCase()}-`))
      roots.push(storageRoot)
      const rootId = brandString<SessionId>(`${backend.name.toLowerCase()}-restart-root`)

      const first = await stack(backend, storageRoot, [textResponse('initial teammate answer')])
      const firstLead = await first.ctx.agentLoop.create(rootId, { provider: 'mock', model: 'mock' })
      const started = await first.ctx.subagents.startActivation({
        provider: 'spawn',
        label: 'restart worker',
        prompt: [{ type: 'text', text: 'finish before restart' }], parent: firstLead,
        signal: SIGNAL,
        delivery: 'caller',
      })
      await vi.waitFor(() => { expect(first.ctx.agents.get(started.childId)).toBeUndefined() }, { timeout: 5_000 })
      const created = { id: brandString<TeamTaskId>('task-1'), revision: 1, subject: 'carry over', description: 'survives restart', status: 'pending' as const, blockedBy: [], writeScopes: [] }
      firstLead.session.append('team/task', { version: 2, teamId: brandString<TeamId>(rootId), task: created })
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
      })).resolves.toMatchObject({ ownerId: started.childId, ownerName: 'agent-1' })
      expect(second.adapter.requests).toEqual([])
      await rootHandle.dispose()
      await second.dispose()
    })

    it('restores tasks after historical roster and mailbox records without recovering teammates or mail', {
      timeout: PERSISTENCE_TEST_TIMEOUT_MS,
    }, async () => {
      const storageRoot = mkdtempSync(join(tmpdir(), `dsh-team-mail-${backend.name.toLowerCase()}-`))
      roots.push(storageRoot)
      const rootId = brandString<SessionId>(`${backend.name.toLowerCase()}-mail-root`)
      const childId = brandString<SessionId>('historical-worker')

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
        id: brandString<TeamMessageId>('legacy-pending'), senderId: rootId, senderName: 'lead', targetId: childId,
        content: [{ type: 'text' as const, text: 'historical pending context' }],
      }
      firstLead.session.append('team/member', { version: 2, teamId: brandString<TeamId>(rootId), member: { ...historical, phase: 'active' } })
      firstLead.session.append('team/message/delivered', { version: 2, teamId: brandString<TeamId>(rootId), messageId: message.id, targetId: childId })
      firstLead.session.append('team/message/queued', { version: 2, teamId: brandString<TeamId>(rootId), message })
      await first.ctx.agentTeams.setEnabled(firstLead, true)
      const task = await first.ctx.agentTeams.createTask(firstLead, { subject: 'saved board', description: 'survives retired records' })
      await first.ctx.sessions.flush(firstLead.session)
      await first.dispose()

      const second = await stack(backend, storageRoot, [])
      const rootHandle = await second.ctx.agents.resume({
        resumeSessionId: rootId,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      expect(second.ctx.agentTeams.listTasks(rootHandle.agent)).toEqual([task])
      const history = rootHandle.agent.session.snapshotEvents()
      expect(history.filter(event => event.type === 'team/member')).toHaveLength(1)
      expect(history.find(event => event.type === 'team/message/queued')).toMatchObject({ data: { message } })
      const checkpoint = second.ctx.sessionProjections.checkpoint(rootHandle.agent.session)
      const state = teamProjectionDefinition.stateSchema.parse(checkpoint['agentTeam']!.val)
      expect(Object.keys(state).sort()).toEqual(['enabled', 'id', 'inheritedEventCount', 'nextTaskNumber', 'tasks'])
      await expect(second.ctx.agentTeams.updateTask(rootHandle.agent, {
        taskId: task.id, expectedRevision: 1, action: 'claim',
      })).resolves.toMatchObject({ revision: 2, status: 'in_progress' })
      const projections = second.ctx.sessionProjections.snapshot(rootHandle.agent.session).values
      expect(projections.agentTeam).toMatchObject({ enabled: true, tasks: [{ id: task.id, revision: 2 }] })
      expect(second.ctx.agents.get(childId)).toBeUndefined()
      expect(second.adapter.requests).toEqual([])

      await rootHandle.dispose()
      await second.dispose()
    })
  })
}
