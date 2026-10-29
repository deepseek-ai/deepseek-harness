/** A real Agent reads Schedule change notices at its next model step, so a notice never opens a turn of its own. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import ScheduleService from '../src/index.ts'

/** A rule whose only occurrence lies beyond every test run, so no delivery competes with the notices. */
const distant = 'DTSTART:20990101T000000Z\nRRULE:FREQ=DAILY;COUNT=1'
const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** Records each request and answers it with one text reply after the current gate opens. */
class ReplyAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  gate: Promise<unknown> = Promise.resolve()

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await this.gate
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Schedule service beside a production AgentLoop with one idle Agent that answers through {@link ReplyAdapter}. */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-notice-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'schedule-storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(ScheduleService)
  const adapter = new ReplyAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('notified'), { provider: 'mock', model: 'mock' })
  return { service: ctx.schedule, adapter, agent }
}

/** Text of each human and Schedule message in one model request, in request order. */
function inputs(request: GenerateOptions | undefined): string[] {
  return (request?.messages ?? []).flatMap(message => message.source?.kind === 'user' || message.source?.kind === 'schedule'
    ? [message.content.map(block => block.type === 'text' ? block.text : '').join('')]
    : [])
}

/** Number of turns the Session log records. */
function turns(session: Session): number {
  return session.snapshotEvents().filter(event => event.type === 'turn/start').length
}

it('adds notices queued while the Agent is idle to the first step of its next turn', async () => {
  const { service, adapter, agent } = await setup()
  const created = await service.create({
    title: 'Standup', prompt: 'Prompt', timing: { kind: 'rrule', rrule: distant }, target: { kind: 'session', sessionId: agent.session.id },
  }, SessionId('actor'))
  await service.edit({ id: created.id, action: 'update', patch: { active: false } })
  await vi.waitFor(() => { expect(agent.inbox.nextStep).toHaveLength(2) })
  expect(agent.inbox.nextTurn).toEqual([])
  expect(turns(agent.session)).toBe(0)

  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(turns(agent.session)).toBe(1)
  expect(adapter.requests).toHaveLength(1)
  expect(inputs(adapter.requests[0])).toEqual([
    expect.stringContaining('change: created'), expect.stringContaining('change: updated'), 'Hello',
  ])
})

it('adds one step to a turn whose last step was running when a notice arrived', async () => {
  const { service, adapter, agent } = await setup()
  // The Agent created the task itself, so only the later edit notifies it.
  const created = await service.create({
    title: 'Standup', prompt: 'Prompt', timing: { kind: 'rrule', rrule: distant }, target: { kind: 'session', sessionId: agent.session.id },
  }, agent.session.id)
  const release = Promise.withResolvers<undefined>()
  adapter.gate = release.promise
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } }))
  await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
  await service.edit({ id: created.id, action: 'update', patch: { title: 'Renamed' } })
  await vi.waitFor(() => { expect(agent.inbox.nextStep).toHaveLength(1) })

  release.resolve(undefined)
  await agent.whenIdle()
  expect(turns(agent.session)).toBe(1)
  expect(adapter.requests).toHaveLength(2)
  expect(inputs(adapter.requests[1])).toEqual(['Hello', expect.stringContaining('change: updated')])
})
