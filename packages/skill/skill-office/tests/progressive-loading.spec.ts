/** Model request contents before and after the model loads the Office skill. */
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as PtcToolExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { PtcInspectableValue, PtcRuntime, type PtcRunRequest, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ToolSkill from '../../tool-skill/src/index.ts'
import * as SkillOffice from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { expectNoRenderContext } from './fixtures/real-office.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

const contexts: Context[] = []
/** The `office` skill's advertised resource directory. */
const resourceBase = fileURLToPath(new URL('../assets/office/', import.meta.url)).replace(/[\\/]$/u, '').split(sep).join('/')
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

class SkillProgram extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'
  resolve(request: PtcRunRequest): PtcRunSpec { return { ...request, cwd: process.cwd(), timeoutMs: 120_000 } }
  async run(request: PtcRunSpec) {
    const resolved = await request.bindings[0]!.functions.skill!({ name: request.program })
    const value = resolved instanceof PtcInspectableValue ? resolved.value : resolved
    return { output: [{ type: 'text' as const, text: JSON.stringify(value) }] }
  }
}

async function setup(mode: 'native' | 'ptc', skills: string[]) {
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
    ...skills.map((name, index) => mode === 'native'
      ? toolCallResponse(`call-${index}`, 'skill', { name })
      : toolCallResponse(`call-${index}`, 'run_code', { code: name, description: 'Load task instructions' })),
    textResponse('Done.'), textResponse('Continued.'), textResponse('Fork continued.'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  const { agent } = await ctx.agents.create({ sessionId: brandString<SessionId>('progressive-office'), agentOptions: { provider: 'mock', model: 'model' } })
  return { ctx, agent, adapter }
}

async function send(agent: Agent, text = 'Continue the task'): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

it.each(['native', 'ptc'] as const)('loads the office skill in %s; resume and fork retain its instructions', async (mode) => {
  const { ctx, agent, adapter } = await setup(mode, ['office'])
  await send(agent, 'Edit the Word document text.')
  expect(adapter.requests).toHaveLength(2)
  const requests = adapter.requests.map(request => JSON.stringify(request))
  expect(requests[0]).toContain('Create, read, edit, and validate Word, PowerPoint, and Excel files;')
  expect(requests[0]).not.toMatch(/office-(?:docx|pptx|xlsx)|# Office tasks|python-docx/u)
  expect(requests[1]).toContain('# Office tasks')
  expect(requests[1]).toContain(resourceBase)
  if (mode === 'native') expect(requests[1]).toContain('Base directory for this skill:')
  expect(requests[1]).toContain('python-docx')
  expect(requests[1]).toContain('`office_render`')
  if (mode === 'ptc') {
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'skill-invocation')).toEqual([])
  }
  for (const request of requests) expect(request).not.toMatch(/dsoffice|fragment rectangles/u)
  const seed = agent.session.snapshotEvents()
  const { agent: resumed } = await ctx.agents.create({ sessionId: brandString<SessionId>('resumed-office'), agentOptions: { provider: 'mock', model: 'model' }, seed })
  await send(resumed)
  const { agent: forked } = await ctx.agents.create({ sessionId: brandString<SessionId>('forked-office'), agentOptions: { provider: 'mock', model: 'model' }, seed, meta: { parentSession: agent.id } })
  await send(forked)
  for (const request of adapter.requests.slice(2)) {
    const text = JSON.stringify(request)
    expect(text).toContain('python-docx')
    expect(text).toContain('`office_render`')
    expect(text).not.toMatch(/dsoffice|fragment rectangles/u)
  }
  expect(agent.session.snapshotEvents()).toEqual(seed)
})

it('routes standalone operations to dedicated Office tools', async () => {
  const { agent, adapter } = await setup('native', ['office'])
  await send(agent)
  const loaded = JSON.stringify(adapter.requests.at(-1))
  expect(loaded).toContain('# Office tasks')
  for (const name of ['office_render', 'office_recalculate', 'office_convert']) expect(loaded).toContain(`\`${name}\``)
  expect(loaded).not.toContain('operation:')
})

it('injects an explicitly invoked office skill into the first request', async () => {
  const { agent, adapter } = await setup('native', [])
  await send(agent, '/office Change A1 to 42.')
  expect(adapter.requests).toHaveLength(1)
  const invoked = JSON.stringify(adapter.requests[0])
  expect(invoked).toContain('# Office tasks')
  expect(invoked).toContain('openpyxl writes formulas without calculated values')
  expect(invoked).not.toContain('dsoffice')
})

it.each(['native', 'ptc'] as const)('accepts loaded instructions without a render call as a non-rendering context in %s', async (mode) => {
  const { agent } = await setup(mode, ['office'])
  await send(agent, 'Edit the Office files without visual inspection.')
  const events = agent.session.snapshotEvents()
  expect(JSON.stringify(events)).toContain('# Office tasks')
  expectNoRenderContext(events)
})
