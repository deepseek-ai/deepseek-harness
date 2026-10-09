import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService, { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import TeamService, { TeamId, TeamMessageId } from '../src/index.ts'
import { readPersistedSession } from '../src/persisted.ts'
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
  let projected = teamProjectionDefinition.init(agent.session.header)
  for (const event of agent.session.snapshotEvents()) projected = teamProjectionDefinition.apply(projected, event)
  if (projected.failure !== undefined) throw new Error(projected.failure)
  const state = projected
  return {
    members: state.members,
    tasks: state.tasks,
    pendingMessages: state.messages.filter(message => !state.delivered.includes(message.id)),
  }
}

/** Read one stored session's full event log through a short-lived read handle. */
async function storedEvents(ctx: Context, id: SessionId): Promise<readonly SessionEvent[]> {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    return (await handle.read()).events
  } finally {
    await handle.close()
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

function provisioning(childId: SessionId, name: string): TeamMemberSnapshot {
  return {
    id: childId,
    name,
    description: `${name} recovery`,
    provider: 'spawn',
    context: 'fresh',
    phase: 'provisioning',
  }
}

async function persistedChild(
  ctx: Context,
  rootId: SessionId,
  childId: SessionId,
  message: ReturnType<typeof createUserMessage>,
) {
  const descriptor = snapshotSubagentDescriptor({
    mode: 'continuable',
    provider: 'spawn',
    label: 'persisted child fixture',
    agentProvider: 'mock',
    agentModel: 'mock',
  })
  const child = ctx.sessions.create(childId, {
    meta: { parentSession: rootId, origin: 'subagent' },
  })
  child.append('subagent/descriptor', descriptor)
  child.append('agent/inbox/spliced', {
    target: 'next-turn',
    start: 0,
    inserted: [message],
  })
  // Live sessions persist only through an attached agent-loop writer; this
  // bare fixture session seeds its durable log directly for the cold restart.
  const handle = await ctx.sessionPersistence.create(child.header)
  await handle.append(child.snapshotEvents())
  await handle.close()
  return child
}

for (const backend of backends) {
  describe(`${backend.name} Agent Teams recovery`, () => {
    it('restores a directly accepted target inbox from its flushed crash prefix without Team intent', async () => {
      const liveRoot = mkdtempSync(join(tmpdir(), 'dsh-team-live-'))
      const crashRoot = mkdtempSync(join(tmpdir(), 'dsh-team-crash-'))
      roots.push(liveRoot, crashRoot)
      const first = await stack(backend, liveRoot, ['hang'])
      const lead = await first.ctx.agentLoop.create(SessionId('direct-root'), { provider: 'mock', model: 'mock' })
      const target = await first.ctx.agentTeams.spawnTeammate(lead, {
        name: 'worker', description: 'pending inbox recovery', prompt: [{ type: 'text', text: 'initial' }],
        context: 'fresh', provider: 'spawn', signal: SIGNAL,
      })
      const child = first.ctx.agents.get(target.member.id)!
      const receipt = await first.ctx.agentTeams.sendMessage(lead, {
        target: 'worker', content: [{ type: 'text', text: 'accepted before crash' }], signal: SIGNAL,
      })
      await first.ctx.sessions.flush(child.session)
      const prefix = await readPersistedSession(first.ctx.sessionPersistence, child.id, SIGNAL)
      expect(prefix.events.some(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.id === receipt.messageId))).toBe(true)
      expect(lead.session.snapshotEvents().some(event => event.type.startsWith('team/message/'))).toBe(false)
      await first.dispose()
      const second = await stack(backend, crashRoot, [textResponse('recovered')])
      const writer = await second.ctx.sessionPersistence.create(prefix.header)
      try { await writer.append(prefix.events) } finally { await writer.close() }
      const resumed = await second.ctx.agents.resume({
        resumeSessionId: child.id, agentOptions: { provider: 'mock', model: 'mock' },
      })
      expect(resumed.agent.inbox.nextStep.find(message => message.id === receipt.messageId)).toMatchObject({
        source: { kind: 'agent-message', form: 'relay', senderSessionId: lead.id },
        content: [{ type: 'text', text: 'Team message from lead:' }, { type: 'text', text: 'accepted before crash' }],
      })
      await resumed.dispose()
      await second.dispose()
    })

    it('reconciles a persisted child to active and a missing child to durable failed', {
      timeout: PERSISTENCE_TEST_TIMEOUT_MS,
    }, async () => {
      const storageRoot = mkdtempSync(join(tmpdir(), `dsh-team-${backend.name.toLowerCase()}-`))
      roots.push(storageRoot)
      const first = await stack(backend, storageRoot, [textResponse('initial child answer')])
      const activeRootId = SessionId(`${backend.name.toLowerCase()}-active-root`)
      const failedRootId = SessionId(`${backend.name.toLowerCase()}-failed-root`)
      const childId = SessionId(`${backend.name.toLowerCase()}-child`)
      const activeRoot = await first.ctx.agentLoop.create(activeRootId, { provider: 'mock', model: 'mock' })
      const failedRoot = await first.ctx.agentLoop.create(failedRootId, { provider: 'mock', model: 'mock' })
      // Let each root's startup recovery observe the empty initial log before
      // simulating the crash-only provisioning prefix.
      await Promise.resolve()
      await Promise.resolve()

      activeRoot.session.append('team/member', {
        version: 2,
        teamId: TeamId(activeRoot.id),
        member: provisioning(childId, 'recoverable'),
      })
      failedRoot.session.append('team/member', {
        version: 2,
        teamId: TeamId(failedRoot.id),
        member: provisioning(SessionId(`${backend.name}-missing`), 'missing'),
      })
      await Promise.all([
        first.ctx.sessions.flush(activeRoot.session),
        first.ctx.sessions.flush(failedRoot.session),
      ])
      await first.ctx.subagents.startActivation({
        delivery: 'parent',
        childId,
        provider: 'spawn',
        label: 'recoverable recovery',
        request: {
          prompt: [{ type: 'text', text: 'persist before active edge' }],
          parent: activeRoot,
        },
        signal: SIGNAL,
      })
      await vi.waitFor(() => { expect(first.ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
      expect((await storedEvents(first.ctx, childId))
        .some(event => event.type === 'user/message')).toBe(true)
      await first.dispose()

      const second = await stack(backend, storageRoot, [textResponse('cold resumed answer')])
      const activeHandle = await second.ctx.agents.resume({
        resumeSessionId: activeRootId,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      const failedHandle = await second.ctx.agents.resume({
        resumeSessionId: failedRootId,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      await vi.waitFor(() => {
        expect(durable(activeHandle.agent).members[0]?.phase).toBe('active')
        const failedMember = durable(failedHandle.agent).members[0]
        expect(failedMember?.phase).toBe('failed')
        expect(failedMember?.error).toContain('child Session recovery failed')
      }, { timeout: 5_000 })

      const receipt = await second.ctx.agentTeams.sendMessage(activeHandle.agent, {
        target: 'recoverable',
        content: [{ type: 'text', text: 'resume after reconciliation' }],
        signal: SIGNAL,
      })
      expect(receipt.messageId).toEqual(expect.any(String))
      await vi.waitFor(() => { expect(second.ctx.agents.get(childId)).toBeUndefined() }, { timeout: 5_000 })
      await vi.waitFor(() => { expect(durable(activeHandle.agent).pendingMessages).toEqual([]) })

      await activeHandle.dispose()
      await failedHandle.dispose()
      await second.dispose()
    })

    it('reconciles a provisioning child whose initial prompt is durably pending', {
      timeout: PERSISTENCE_TEST_TIMEOUT_MS,
    }, async () => {
      const storageRoot = mkdtempSync(join(tmpdir(), `dsh-team-pending-${backend.name.toLowerCase()}-`))
      roots.push(storageRoot)
      const rootId = SessionId(`${backend.name.toLowerCase()}-pending-root`)
      const childId = SessionId(`${backend.name.toLowerCase()}-pending-child`)
      const first = await stack(backend, storageRoot, [])
      const root = await first.ctx.agentLoop.create(rootId, { provider: 'mock', model: 'mock' })
      await Promise.resolve()
      await Promise.resolve()
      root.session.append('team/member', {
        version: 2,
        teamId: TeamId(root.id),
        member: provisioning(childId, 'pending-worker'),
      })
      const initial = createUserMessage({
        content: [{ type: 'text', text: 'durably pending initial task' }],
        source: { kind: 'user' },
      })
      await persistedChild(first.ctx, rootId, childId, initial)
      await first.ctx.sessions.flush(root.session)
      await first.dispose()

      const second = await stack(backend, storageRoot, [])
      const rootHandle = await second.ctx.agents.resume({
        resumeSessionId: rootId,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      await vi.waitFor(() => {
        expect(durable(rootHandle.agent).members[0]?.phase).toBe('active')
      })
      expect(second.adapter.requests).toEqual([])
      const stored = await storedEvents(second.ctx, childId)
      expect(stored.some(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.id === initial.id))).toBe(true)

      await rootHandle.dispose()
      await second.dispose()
    })

    it('keeps historical queued mail readable without delivering it after restart', {
      timeout: PERSISTENCE_TEST_TIMEOUT_MS,
    }, async () => {
      const storageRoot = mkdtempSync(join(tmpdir(), `dsh-team-mail-${backend.name.toLowerCase()}-`))
      roots.push(storageRoot)
      const rootId = SessionId(`${backend.name.toLowerCase()}-mail-root`)

      const first = await stack(backend, storageRoot, [textResponse('initial teammate answer')])
      const firstLead = await first.ctx.agentLoop.create(rootId, { provider: 'mock', model: 'mock' })
      const started = await first.ctx.agentTeams.spawnTeammate(firstLead, {
        name: 'mail-worker',
        description: 'historical mailbox target',
        prompt: [{ type: 'text', text: 'finish before restart' }],
        context: 'fresh',
        provider: 'spawn',
        signal: SIGNAL,
      })
      await vi.waitFor(() => { expect(first.ctx.agents.get(started.member.id)).toBeUndefined() }, { timeout: 5_000 })
      const message = {
        id: TeamMessageId('legacy-pending'), senderId: rootId, senderName: 'lead', targetId: started.member.id,
        content: [{ type: 'text' as const, text: 'historical pending context' }],
      }
      firstLead.session.append('team/message/queued', { version: 2, teamId: TeamId(rootId), message })
      await first.ctx.sessions.flush(firstLead.session)
      await first.dispose()

      const second = await stack(backend, storageRoot, [])
      const rootHandle = await second.ctx.agents.resume({
        resumeSessionId: rootId,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      expect(durable(rootHandle.agent).pendingMessages).toEqual([message])
      expect(second.ctx.agents.get(started.member.id)).toBeUndefined()
      const child = await storedEvents(second.ctx, started.member.id)
      expect(child.some(event => event.type === 'user/message'
        && event.data.source.kind === 'team-message')).toBe(false)
      expect(second.adapter.requests).toEqual([])

      await rootHandle.dispose()
      await second.dispose()
    })
  })
}
