/** Model request contents for the Office router and independent authoring skills. */
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as PtcToolExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { PtcRuntime, type PtcRunRequest, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ToolSkill from '../../tool-skill/src/index.ts'
import * as SkillOffice from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { expectNoRenderContext } from './fixtures/real-office.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

class SkillProgram extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'
  resolve(request: PtcRunRequest): PtcRunSpec { return { ...request, cwd: process.cwd(), timeoutMs: 120_000 } }
  async run(request: PtcRunSpec) {
    return { output: [{ type: 'text' as const, text: JSON.stringify(await request.bindings[0]!.functions.skill!({ name: request.program })) }] }
  }
}

async function setup(mode: 'native' | 'ptc', names: string[]) {
  const ctx = new Context()
  contexts.push(ctx)
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(mode === 'ptc' ? PtcToolExecutor : NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(ToolSkill)
  await ctx.plugin(SkillOffice)
  if (mode === 'ptc') await ctx.plugin(SkillProgram)
  const adapter = new MockAdapter([
    ...names.map((name, index) => mode === 'native'
      ? toolCallResponse(`skill-${index}`, 'skill', { name })
      : toolCallResponse(`skill-${index}`, 'run_code', { code: name, description: 'Load task instructions' })),
    textResponse('Done.'), textResponse('Continued.'), textResponse('Fork continued.'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  const { agent } = await ctx.agents.create({ sessionId: SessionId('progressive-office'), agentOptions: { provider: 'mock', model: 'model' } })
  return { ctx, agent, adapter }
}

async function send(agent: Agent, text = 'Continue the task'): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

it.each(['native', 'ptc'] as const)('loads the router and authoring body in %s; resume and fork retain those instructions', async (mode) => {
  const { ctx, agent, adapter } = await setup(mode, ['office', 'office-docx'])
  await send(agent, 'Edit the Word document text.')
  expect(adapter.requests).toHaveLength(3)
  const requests = adapter.requests.map(request => JSON.stringify(request))
  expect(requests[0]).toContain('Create or edit Office files; inspect Office files and PDFs.')
  expect(requests[0]).toContain('office-docx')
  expect(requests[1]).toContain('Office task routing')
  expect(requests[1]).not.toContain('python-docx')
  expect(requests[2]).toContain('python-docx')
  if (mode === 'ptc') {
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'skill-invocation')).toEqual([])
  }
  expect(requests[2]).toContain('`office_render`')
  expect(requests[2]).not.toContain('dsoffice')
  expect(requests[0]).not.toContain('dsoffice')
  expect(requests[1]).not.toContain('dsoffice')
  for (const request of requests) {
    expect(request).not.toMatch(/fragment rectangles/)
  }
  const seed = agent.session.snapshotEvents()
  const { agent: resumed } = await ctx.agents.create({ sessionId: SessionId('resumed-office'), agentOptions: { provider: 'mock', model: 'model' }, seed })
  await send(resumed)
  const { agent: forked } = await ctx.agents.create({ sessionId: SessionId('forked-office'), agentOptions: { provider: 'mock', model: 'model' }, seed, meta: { parentSession: agent.id } })
  await send(forked)
  for (const request of adapter.requests.slice(3)) {
    const text = JSON.stringify(request)
    expect(text).toContain('python-docx')
    expect(text).toContain('`office_render`')
    expect(text).not.toContain('dsoffice')
    expect(text).not.toMatch(/fragment rectangles/)
  }
  expect(agent.session.snapshotEvents()).toEqual(seed)
})

it('routes standalone operations to dedicated Office tools without authoring bodies', async () => {
  const { agent, adapter } = await setup('native', ['office'])
  await send(agent)
  const loaded = JSON.stringify(adapter.requests.at(-1))
  expect(loaded).toContain('Office task routing')
  for (const name of ['office_render', 'office_recalculate', 'office_convert']) expect(loaded).toContain(`\`${name}\``)
  expect(loaded).not.toContain('operation:')
  expect(loaded).not.toMatch(/# Word documents|# Excel workbooks|python-docx/)
})

it('loads an explicitly invoked authoring skill without the router', async () => {
  const { agent, adapter } = await setup('native', [])
  await send(agent, '/office-xlsx Change A1 to 42.')
  expect(adapter.requests).toHaveLength(1)
  const text = JSON.stringify(adapter.requests[0])
  expect(text).toContain('# Excel workbooks')
  expect(text).not.toMatch(/Office task routing|dsoffice/)
})

it.each(['native', 'ptc'] as const)('accepts loaded format skills without a render call as a non-rendering context in %s', async (mode) => {
  const { agent } = await setup(mode, ['office', 'office-docx', 'office-pptx', 'office-xlsx'])
  await send(agent, 'Edit the Office files without visual inspection.')
  const events = agent.session.snapshotEvents()
  expect(JSON.stringify(events)).toContain('uniformly blank')
  expectNoRenderContext(events)
})
