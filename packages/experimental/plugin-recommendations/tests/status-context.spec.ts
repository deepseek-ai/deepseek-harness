import { expect, it, vi } from 'vitest'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import * as PluginRecommendations from '../src/index.ts'
import { callId, fixture } from './fixture.ts'

async function prepare(f: Awaited<ReturnType<typeof fixture>>, agent: Agent = f.agent) {
  const decision = await agentEvents(f.ctx, agent).waterfall('agent/pre-step', { messages: [], turn: 2, step: 1,
    signal: new AbortController().signal, modelSelection: { provider: 'mock', model: 'mock' } },
  async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] }))
  return decision.kind === 'reject' ? decision : {
    ...decision, messages: decision.messages.filter(message => message.source.kind === 'action-cards'),
  }
}

function text(decision: PreStepDecision): string {
  if (decision.kind !== 'enter') throw new Error('request was rejected')
  return decision.messages.flatMap(message => message.content.flatMap(part => part.type === 'text' ? [part.text] : [])).join('\n')
}

it('reports the card outcome with the plugin guidance on the next request without waking the conversation', async () => {
  const f = await fixture()
  const followup = vi.spyOn(f.agent, 'followup')
  const steer = vi.spyOn(f.agent, 'steer')
  f.propose()
  expect(await prepare(f)).toEqual({ kind: 'enter', messages: [] })
  f.manager.setBundleEnabled.mockResolvedValueOnce({ application: 'restart-required', changed: true, stage: 'enable', target: 'official-search' })
  await f.ctx.actionCards.act(f.agent, callId, 'enable')
  expect(f.agent.status).toBe('idle')
  const decision = await prepare(f)
  if (decision.kind !== 'enter') throw new Error('request was rejected')
  expect(decision.messages).toHaveLength(1)
  expect(decision.messages[0]!.content).toMatchSnapshot('restart-required plugin status')
  for (const message of decision.messages) f.agent.session.append('user/message', message, { surfaceOp: 'append' })
  expect(await prepare(f)).toEqual({ kind: 'enter', messages: [] })
  expect(followup).not.toHaveBeenCalled()
  expect(steer).not.toHaveBeenCalled()
})

it('reports a recorded decision after this plugin reloads', async () => {
  const f = await fixture()
  f.propose()
  await f.ctx.actionCards.act(f.agent, callId, 'dismiss')
  await f.fiber.dispose()
  expect(text(await prepare(f))).toContain('"phase":"dismissed"')
  await f.ctx.plugin(PluginRecommendations)
  expect(text(await prepare(f))).toContain('dismissed means the user declined it')
})
