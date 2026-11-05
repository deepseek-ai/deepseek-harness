/** Empty prompt admission over the real AgentLoop and the Session Remote owner. */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import type { SessionPromptRequest, SessionRequestId } from '../src/types.ts'
import { createSessionTestRemote } from './test-remote.ts'

async function setup() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const fail = (): never => { throw new LlmError('busy', 'SERVER') }
  const adapter = new MockAdapter([fail, fail, textResponse('done')])
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  const remote = await createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }), cwd: '/workspace' })
  const agent = await ctx.agentLoop.create(SessionId('empty-prompt'), { provider: 'mock', model: 'mock' })
  const request = (id: string, mode: SessionPromptRequest['mode'] = 'queue'): SessionPromptRequest => ({
    sessionId: agent.id, requestId: id as SessionRequestId, content: [], mode,
  })
  return { ctx, remote, agent, adapter, request }
}

it('records empty retry user messages without duplicate requests', async () => {
  const { remote, agent, adapter, request } = await setup()
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'original task' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const first = request('continue-1')
  expect((await remote.prompt(first)).ok).toBe(true)
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(2)
  expect((await remote.prompt(first)).ok).toBe(true)
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(2)
  expect((await remote.prompt(request('continue-2'))).ok).toBe(true)
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(3)
  const events = agent.session.snapshotEvents()
  const messages = events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user' ? [event.data] : [])
  expect(messages).toHaveLength(1)
  const retries = events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'retry' ? [event.data] : [])
  expect(retries).toHaveLength(2)
  expect(retries).toMatchObject([
    { content: [], source: { kind: 'retry', rpcId: 'continue-1' } },
    { content: [], source: { kind: 'retry', rpcId: 'continue-2' } },
  ])
  const controls = events.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : [])
    .filter(message => message.source.kind === 'retry')
  expect(retries.map(retry => retry.id)).toEqual(controls.map(control => control.id))
  expect(adapter.requests[1]!.messages.filter(message => message.role === 'user').map(message => message.content))
    .toEqual([[{ type: 'text', text: 'original task' }], []])
  expect(adapter.requests[2]!.messages.filter(message => message.role === 'user').map(message => message.content))
    .toEqual([[{ type: 'text', text: 'original task' }], [], []])
  expect(events.flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : [])).toEqual(['error', 'error', 'completed'])
  expect(events.filter(event => event.type === 'turn/start')).toHaveLength(3)
  expect((await remote.prompt(request('after-completion'))).ok).toBe(false)
})

it('refuses empty fresh sessions, steering, queued human input and maintenance without waking work', async () => {
  const { remote, agent, adapter, request } = await setup()
  expect((await remote.prompt(request('empty-fresh'))).ok).toBe(false)
  expect(adapter.requests).toHaveLength(0)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'original task' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect((await remote.prompt(request('empty-steer', 'steer'))).ok).toBe(false)
  const pending = createUserMessage({ content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' } })
  agent.inbox.append('next-turn', pending)
  expect((await remote.prompt(request('empty-queued'))).ok).toBe(false)
  agent.inbox.clear()
  agent.inject(pending)
  expect((await remote.prompt(request('empty-steering'))).ok).toBe(false)
  agent.inbox.clear()
  await agent.runMaintenance(async () => {
    expect((await remote.prompt(request('empty-maintenance'))).ok).toBe(false)
  })
  expect(adapter.requests).toHaveLength(1)
})

it('consumes injected context with the empty prompt', async () => {
  const { ctx, remote, agent, adapter, request } = await setup()
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'original task' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  agent.inject(createUserMessage({ content: [{ type: 'text', text: 'approval context' }], source: { kind: 'user-approval' } }))
  agent.model.select({ provider: 'mock', model: 'changed' })
  expect((await remote.prompt(request('empty-context'))).ok).toBe(true)
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(2)
  expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('approval context')
  expect(adapter.requests[1]!.model).toBe('changed')
  expect(agent.inbox.nextStep).toHaveLength(0)
  expect(ctx.sessionProjections.snapshot(agent.session).values.conversationContinuation).not.toBeNull()
})

it('deduplicates empty continuation after claim and before user-message admission', async () => {
  const { ctx, remote, agent, adapter, request } = await setup()
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'original task' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const claimed = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  ctx.on('agent/pre-step', async ({ messages }, next) => {
    if (messages.some(message => message.source.kind === 'retry')) {
      claimed.resolve(undefined)
      await release.promise
    }
    return next()
  })
  const continuation = request('continue-once')
  expect((await remote.prompt(continuation)).ok).toBe(true)
  await claimed.promise
  expect(agent.inbox.nextTurn).toEqual([])
  expect(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'retry')).toBe(false)
  expect((await remote.prompt(continuation)).ok).toBe(true)
  release.resolve(undefined)
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(2)
  expect(agent.session.snapshotEvents().flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : [])
    .filter(message => message.source.kind === 'retry')).toHaveLength(1)
})
