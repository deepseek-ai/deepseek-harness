import { expect, it, vi } from 'vitest'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { executeModelToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { z } from 'zod'
import type { ActionCardKind, ActionCardResult } from '../src/index.ts'
import { ACTION, fixture, INVITATION, proposal, SKILL, type TestDetails } from './fixture.ts'

type Fixture = Awaited<ReturnType<typeof fixture>>
const signal = new AbortController().signal
const modelSelection = { provider: 'mock', model: 'mock' }

/** Run one call through the executor with the step admission the loop would resolve. */
async function call(f: Fixture, name: string, args: object, id: string, agent: Agent = f.agent, parent?: ToolExecutionToken) {
  const toolSet = await f.ctx.tools.resolve({ agent, modelSelection, signal })
  try {
    return parent === undefined
      ? await executeModelToolFixture(f.ctx, { callId: ToolCallId(id), name, arguments: args, agent, signal, toolSet })
      : await executeToolFixture(f.ctx, { callId: ToolCallId(id), name, arguments: args, agent, signal, toolSet, parent })
  } finally { toolSet.dispose() }
}

async function declared(f: Fixture, agent: Agent = f.agent): Promise<boolean> {
  const toolSet = await f.ctx.tools.resolve({ agent, modelSelection, signal })
  const visible = toolSet.view(agent).has('propose_action')
  toolSet.dispose()
  return visible
}

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map(block => block.text ?? '').join('')
}

it('declares propose_action from the step after a card skill loads, and logs the addition', async () => {
  const f = await fixture()
  const adapter = new MockAdapter([
    toolCallResponse('call-skill', 'skill', { name: SKILL }),
    toolCallResponse('call-card-1', 'propose_action', proposal),
    textResponse('The card is below.'),
  ])
  f.ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await f.harness.create(SessionId('loop'), modelSelection)
  expect(await declared(f, agent)).toBe(false)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'I want a counter.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(adapter.requests.map(request => (request.tools ?? []).some(tool => tool.name === 'propose_action'))).toEqual([false, true, true])
  const tool = adapter.requests[1]!.tools!.find(candidate => candidate.name === 'propose_action')
  expect(tool).toMatchSnapshot('tool declaration')
  expect(agent.session.snapshotEvents().flatMap(event => event.type === 'developer/message' ? event.data.message.content : []))
    .toEqual([{ type: 'tool-addition', toolName: 'propose_action' }])
  expect(await declared(f, agent)).toBe(true)
  const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'call-card-1')
  expect(result?.type === 'tool/result' && result.data.message.content).toEqual([
    { type: 'text', text: `Card shown below your answer. Do not restate it. ${INVITATION}` },
  ])
  expect(f.view(agent).proposals['call-card-1']).toEqual({ callId: 'call-card-1', turn: 1, ...proposal })
})

it('declares nothing for other skills and stops declaring when the kind unregisters', async () => {
  const f = await fixture()
  f.agent.session.append('turn/start', { turn: 1 })
  expect((await call(f, 'skill', { name: 'other-skill' }, 'other')).isError).toBe(false)
  expect((await call(f, 'skill', { name: 'missing-skill' }, 'missing')).isError).toBe(true)
  expect(await declared(f)).toBe(false)
  expect((await call(f, 'propose_action', proposal, 'early')).isError).toBe(true)
  expect((await call(f, 'skill', { name: SKILL }, 'load')).isError).toBe(false)
  expect((await call(f, 'skill', { name: SKILL }, 'reload')).isError).toBe(false)
  expect((await executeToolFixture(f.ctx, { callId: ToolCallId('detached'), name: 'skill', arguments: { name: SKILL }, signal })).isError).toBe(false)
  expect(await declared(f)).toBe(true)
  await f.kindFiber.dispose()
  expect(await declared(f)).toBe(false)
  await f.cards.dispose()
  expect(f.ctx.tools.get('propose_action')).toBeUndefined()
})

it('refuses unknown actions, a skill not loaded in this turn, blank fields, invalid details and nested calls', async () => {
  const f = await fixture()
  f.agent.session.append('turn/start', { turn: 1 })
  await call(f, 'skill', { name: SKILL }, 'load')
  expect(text(await call(f, 'propose_action', { ...proposal, action: 'nope' }, 'unknown'))).toBe('Error: Unknown action "nope". Registered actions: test_action.')
  expect(text(await call(f, 'propose_action', { ...proposal, title: ' ' }, 'blank'))).toBe('Error: Write a title and a brief.')
  expect(text(await call(f, 'propose_action', { ...proposal, brief: '' }, 'blank-brief'))).toBe('Error: Write a title and a brief.')
  expect(text(await call(f, 'propose_action', { ...proposal, details: { value: 1 } }, 'invalid')))
    .toBe('Error: Invalid details: details.value: Invalid input: expected string, received number')
  expect(text(await call(f, 'propose_action', proposal, 'nested', f.agent, Symbol('outer') as ToolExecutionToken)))
    .toBe('Error: Call propose_action directly, not from code.')
  f.agent.session.append('turn/start', { turn: 2 })
  expect(text(await call(f, 'propose_action', proposal, 'stale'))).toBe('Error: Load skill test-skill first, then call propose_action.')
  await f.kindFiber.dispose()
  await call(f, 'skill', { name: SKILL }, 'load-again')
  expect(await declared(f)).toBe(false)
  expect(Object.keys(f.view().proposals)).toEqual([])
})

it('accepts one card per turn, admits a retry after a failed result and names the registered actions', async () => {
  const f = await fixture()
  f.agent.session.append('turn/start', { turn: 1 })
  await call(f, 'skill', { name: SKILL }, 'load')
  const blocked = f.ctx.on('tools/post-execute', async (exec, _result, next) => exec.callId === 'blocked'
    ? { kind: 'block', feedback: [{ type: 'text', text: 'blocked' }] } : await next())
  expect((await call(f, 'propose_action', proposal, 'blocked')).isError).toBe(true)
  blocked()
  const accepted = await call(f, 'propose_action', { ...proposal, title: ' Counter ' }, 'accepted')
  expect(accepted).toMatchObject({ isError: false, value: { action: ACTION, title: 'Counter', invitation: INVITATION } })
  expect(text(accepted)).toBe(`Card shown below your answer. Do not restate it. ${INVITATION}`)
  const second = text(await call(f, 'propose_action', proposal, 'second'))
  // Only an accepted call tells the model how to invite the user to its card.
  expect(second).toBe('Error: One card per turn; the earlier card stands.')
  expect(second).not.toContain(INVITATION)
  f.agent.session.append('turn/start', { turn: 2 })
  await call(f, 'skill', { name: SKILL }, 'load-2')
  f.propose(ToolCallId('logged'), proposal, f.agent, 2)
  expect(text(await call(f, 'propose_action', proposal, 'after-log'))).toBe('Error: One card per turn; the earlier card stands.')
  // Disposing the agent releases its activation.
  expect(await declared(f)).toBe(true)
  await f.agentHandle.dispose()
  expect(await declared(f)).toBe(false)
})

it('activates nothing for a skill load dispatched from code, so a PTC preset never declares the tool', async () => {
  const f = await fixture()
  f.agent.session.append('turn/start', { turn: 1 })
  const outer = Symbol('outer') as ToolExecutionToken
  expect((await call(f, 'skill', { name: SKILL }, 'nested-load', f.agent, outer)).isError).toBe(false)
  expect(await declared(f)).toBe(false)
  expect((await call(f, 'propose_action', proposal, 'unadmitted')).isError).toBe(true)
  expect((await call(f, 'skill', { name: SKILL }, 'direct-load')).isError).toBe(false)
  expect(await declared(f)).toBe(true)
})

it('offers cards in the main conversation only: subagent skill loads activate nothing and non-root calls are refused', async () => {
  const f = await fixture()
  const child = (await f.ctx.agents.create({ sessionId: SessionId('cards-child'), parentAgent: f.agent,
    meta: { parentSession: f.agent.id, origin: 'subagent' } })).agent
  child.session.append('turn/start', { turn: 1 })
  expect((await call(f, 'skill', { name: SKILL }, 'child-load', child)).isError).toBe(false)
  expect(await declared(f, child)).toBe(false)
  expect((await call(f, 'propose_action', proposal, 'child-card', child)).isError).toBe(true)
  f.agent.session.append('turn/start', { turn: 1 })
  await call(f, 'skill', { name: SKILL }, 'load')
  // Admission is fixed when the step starts; the call still checks that its agent is a live root.
  const toolSet = await f.ctx.tools.resolve({ agent: f.agent, modelSelection, signal })
  vi.spyOn(f.ctx.agents, 'roots').mockReturnValue([])
  const refused = await executeModelToolFixture(f.ctx, { callId: ToolCallId('detached-root'), name: 'propose_action', arguments: proposal,
    agent: f.agent, signal, toolSet })
  toolSet.dispose()
  expect(text(refused)).toBe('Error: Cards are offered in the main conversation only.')
})

it('names no actions when the last kind unregisters after the step admitted the tool', async () => {
  const f = await fixture()
  f.agent.session.append('turn/start', { turn: 1 })
  await call(f, 'skill', { name: SKILL }, 'load')
  const toolSet = await f.ctx.tools.resolve({ agent: f.agent, modelSelection, signal })
  await f.kindFiber.dispose()
  const result = await executeModelToolFixture(f.ctx, { callId: ToolCallId('late'), name: 'propose_action', arguments: proposal,
    agent: f.agent, signal, toolSet })
  toolSet.dispose()
  expect(text(result)).toBe('Error: Unknown action "test_action". Registered actions: none.')
})

it('refuses a card while the user has queued messages for later turns, so the log holds no card', async () => {
  const f = await fixture()
  const queued = () => createUserMessage({ content: [{ type: 'text', text: 'Next question.' }], source: { kind: 'user' } })
  const live: { agent?: Agent } = {}
  const adapter = new MockAdapter([
    toolCallResponse('call-skill', 'skill', { name: SKILL }),
    () => {
      // The user queues two more messages while the model writes its answer.
      live.agent!.inbox.append('next-turn', queued())
      live.agent!.inbox.append('next-turn', queued())
      return toolCallResponse('call-card-1', 'propose_action', proposal)
    },
    textResponse('Short answer.'),
    textResponse('Next answer.'),
    textResponse('Last answer.'),
  ])
  f.ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await f.harness.create(SessionId('queued'), modelSelection)
  live.agent = agent
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'I want a counter.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'call-card-1')
  expect(result?.type === 'tool/result' && result.data.message).toMatchObject({ isError: true,
    content: [{ type: 'text', text: 'Error: The user has queued more messages; show no card and answer briefly.' }] })
  expect(f.view(agent)).toEqual({ proposals: {}, decisions: {} })
})

it('requires every kind to give the invitation its accepted calls return', () => {
  const kind = { action: 'other_action', skill: 'other-skill', details: z.object({ value: z.string() }), verbs: {},
    act: () => Promise.resolve<ActionCardResult>({ status: 'accepted' }) }
  // @ts-expect-error: a kind without its invitation does not compile.
  const incomplete: ActionCardKind<TestDetails> = kind
  expect(incomplete).toBe(kind)
})
