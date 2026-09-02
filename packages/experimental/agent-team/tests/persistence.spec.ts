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
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService, { seedDescriptorTurn, snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
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
  members: TeamMemberSnapshot[]
  tasks: TeamTaskSnapshot[]
  pendingMessages: TeamMessageSnapshot[]
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
    return await handle.read()
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
  await ctx.plugin(SessionProjectionRegistry)
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
  const seed = seedDescriptorTurn(childId, undefined, snapshotSubagentDescriptor({
    mode: 'continuable',
    provider: 'spawn',
    label: 'persisted child fixture',
    agentProvider: 'mock',
    agentModel: 'mock',
  }))
  const child = ctx.sessions.create(childId, {
    seed,
    meta: { parentSession: rootId, origin: 'subagent' },
  })
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
        version: 1,
        teamId: TeamId(activeRoot.id),
        member: provisioning(childId, 'recoverable'),
      })
      failedRoot.session.append('team/member', {
        version: 1,
        teamId: TeamId(failedRoot.id),
        member: provisioning(SessionId(`${backend.name}-missing`), 'missing'),
      })
      await Promise.all([
        first.ctx.sessions.flush(activeRoot.session),
        first.ctx.sessions.flush(failedRoot.session),
      ])
      await first.ctx.subagents.startContinuable({
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
        delivery: 'wakeup',
        signal: SIGNAL,
      })
      expect(receipt.status).toBe('accepted')
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
        version: 1,
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

    it('replays queued-minus-delivered mail in FIFO order without waking for quiet mail', {
      timeout: PERSISTENCE_TEST_TIMEOUT_MS,
    }, async () => {
      const storageRoot = mkdtempSync(join(tmpdir(), `dsh-team-mail-${backend.name.toLowerCase()}-`))
      roots.push(storageRoot)
      const rootId = SessionId(`${backend.name.toLowerCase()}-mail-root`)

      const first = await stack(backend, storageRoot, [textResponse('initial teammate answer')])
      const firstLead = await first.ctx.agentLoop.create(rootId, { provider: 'mock', model: 'mock' })
      const started = await first.ctx.agentTeams.spawnTeammate(firstLead, {
        name: 'mail-worker',
        description: 'mail recovery worker',
        prompt: [{ type: 'text', text: 'finish before restart' }],
        context: 'fresh',
        provider: 'spawn',
        signal: SIGNAL,
      })
      await vi.waitFor(() => { expect(first.ctx.agents.get(started.member.id)).toBeUndefined() }, { timeout: 5_000 })
      const quiet = await first.ctx.agentTeams.sendMessage(firstLead, {
        target: 'mail-worker',
        content: [{ type: 'text', text: 'durable quiet context' }],
        delivery: 'quiet',
        signal: SIGNAL,
      })
      expect(quiet.status).toBe('queued')
      expect(durable(firstLead).pendingMessages.map(message => message.id)).toEqual([quiet.messageId])
      await first.dispose()

      const second = await stack(backend, storageRoot, [textResponse('resumed teammate answer')])
      const rootHandle = await second.ctx.agents.resume({
        resumeSessionId: rootId,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      await vi.waitFor(() => {
        expect(durable(rootHandle.agent).pendingMessages.map(message => message.id))
          .toEqual([quiet.messageId])
      })
      expect(second.ctx.agents.get(started.member.id)).toBeUndefined()

      const waking = await second.ctx.agentTeams.sendMessage(rootHandle.agent, {
        target: 'mail-worker',
        content: [{ type: 'text', text: 'resume after restart' }],
        delivery: 'wakeup',
        signal: SIGNAL,
      })
      expect(waking.status).toBe('accepted')
      await vi.waitFor(() => { expect(second.ctx.agents.get(started.member.id)).toBeUndefined() }, { timeout: 5_000 })
      await vi.waitFor(() => { expect(durable(rootHandle.agent).pendingMessages).toEqual([]) })

      const child = await storedEvents(second.ctx, started.member.id)
      const peerIds = child.flatMap(event => event.type === 'user/message'
        && event.data.source.kind === 'team-message'
        ? [event.data.source.messageId]
        : [])
      expect(peerIds).toEqual([quiet.messageId, waking.messageId])

      await rootHandle.dispose()
      await second.dispose()
    })

    it('acknowledges target-recorded mail after restart without delivering it twice', {
      timeout: PERSISTENCE_TEST_TIMEOUT_MS,
    }, async () => {
      const storageRoot = mkdtempSync(join(tmpdir(), `dsh-team-dedup-${backend.name.toLowerCase()}-`))
      roots.push(storageRoot)
      const rootId = SessionId(`${backend.name.toLowerCase()}-dedup-root`)
      const messageId = TeamMessageId(`${backend.name.toLowerCase()}-recorded-message`)

      const first = await stack(backend, storageRoot, [textResponse('initial teammate answer')])
      const firstLead = await first.ctx.agentLoop.create(rootId, { provider: 'mock', model: 'mock' })
      const started = await first.ctx.agentTeams.spawnTeammate(firstLead, {
        name: 'dedup-worker',
        description: 'mail deduplication worker',
        prompt: [{ type: 'text', text: 'finish before the crash window' }],
        context: 'fresh',
        provider: 'spawn',
        signal: SIGNAL,
      })
      await vi.waitFor(() => { expect(first.ctx.agents.get(started.member.id)).toBeUndefined() }, { timeout: 5_000 })

      const targetHandle = await first.ctx.agents.resume({
        resumeSessionId: started.member.id,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      targetHandle.agent.session.append('user/message', createUserMessage({
        content: [
          { type: 'text', text: `Team message ${messageId} from lead:` },
          { type: 'text', text: 'already recorded before acknowledgement' },
        ],
        source: {
          kind: 'team-message',
          teamId: TeamId(rootId),
          messageId,
          senderId: rootId,
          senderName: 'lead',
        },
      }), { surfaceOp: 'append' })
      await first.ctx.sessions.flush(targetHandle.agent.session)
      // Let the pre-queue acknowledgement observer prove there is no mailbox
      // row yet before authoring the simulated crash prefix below.
      await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
      await targetHandle.dispose()

      const queued: TeamMessageSnapshot = {
        id: messageId,
        senderId: rootId,
        senderName: 'lead',
        targetId: started.member.id,
        delivery: 'wakeup',
        content: [{ type: 'text', text: 'already recorded before acknowledgement' }],
      }
      firstLead.session.append('team/message/queued', {
        version: 1,
        teamId: TeamId(rootId),
        message: queued,
      })
      await first.ctx.sessions.flush(firstLead.session)
      expect(durable(firstLead).pendingMessages.map(message => message.id)).toEqual([messageId])
      await first.dispose()

      const second = await stack(backend, storageRoot, [])
      const rootHandle = await second.ctx.agents.resume({
        resumeSessionId: rootId,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      await vi.waitFor(() => { expect(durable(rootHandle.agent).pendingMessages).toEqual([]) })
      expect(second.ctx.agents.get(started.member.id)).toBeUndefined()
      expect(second.adapter.requests).toEqual([])

      const child = await storedEvents(second.ctx, started.member.id)
      const occurrences = child.filter(event => event.type === 'user/message'
        && event.data.source.kind === 'team-message'
        && event.data.source.messageId === messageId)
      expect(occurrences).toHaveLength(1)

      await rootHandle.dispose()
      await second.dispose()
    })

    it('acknowledges durably pending target mail without cold-resume duplication', {
      timeout: PERSISTENCE_TEST_TIMEOUT_MS,
    }, async () => {
      const storageRoot = mkdtempSync(join(tmpdir(), `dsh-team-inbox-${backend.name.toLowerCase()}-`))
      roots.push(storageRoot)
      const rootId = SessionId(`${backend.name.toLowerCase()}-inbox-root`)
      const childId = SessionId(`${backend.name.toLowerCase()}-inbox-child`)
      const messageId = TeamMessageId(`${backend.name.toLowerCase()}-pending-team-message`)
      const first = await stack(backend, storageRoot, [])
      const root = await first.ctx.agentLoop.create(rootId, { provider: 'mock', model: 'mock' })
      await Promise.resolve()
      await Promise.resolve()
      const provisioned = provisioning(childId, 'pending-mail-worker')
      const active: TeamMemberSnapshot = {
        ...provisioned,
        phase: 'active',
      }
      const queued: TeamMessageSnapshot = {
        id: messageId,
        senderId: rootId,
        senderName: 'lead',
        targetId: childId,
        delivery: 'wakeup',
        content: [{ type: 'text', text: 'already durable in target inbox' }],
      }
      root.session.append('team/member', {
        version: 1,
        teamId: TeamId(root.id),
        member: provisioned,
      })
      root.session.append('team/member', {
        version: 1,
        teamId: TeamId(root.id),
        member: active,
      })
      root.session.append('team/message/queued', {
        version: 1,
        teamId: TeamId(root.id),
        message: queued,
      })
      const pending = createUserMessage({
        content: [{ type: 'text', text: 'already durable in target inbox' }],
        source: {
          kind: 'team-message',
          teamId: TeamId(rootId),
          messageId,
          senderId: rootId,
          senderName: 'lead',
        },
      })
      await persistedChild(first.ctx, rootId, childId, pending)
      await first.ctx.sessions.flush(root.session)
      await first.dispose()

      const second = await stack(backend, storageRoot, [])
      const rootHandle = await second.ctx.agents.resume({
        resumeSessionId: rootId,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      await vi.waitFor(() => {
        expect(durable(rootHandle.agent).pendingMessages).toEqual([])
      })
      expect(second.adapter.requests).toEqual([])
      expect(second.ctx.agents.get(childId)).toBeUndefined()
      const stored = await storedEvents(second.ctx, childId)
      const pendingCopies = stored.flatMap(event => event.type === 'agent/inbox/spliced'
        ? event.data.inserted.filter(message => message.source.kind === 'team-message'
          && message.source.messageId === messageId)
        : [])
      expect(pendingCopies).toHaveLength(1)

      await rootHandle.dispose()
      await second.dispose()
    })
  })
}
