/** Model request contents for the Office skill and the format files the model reads beside it. */
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
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { PtcInspectableValue, PtcRuntime, type PtcRunRequest, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ToolSkill from '../../tool-skill/src/index.ts'
import * as SkillOffice from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { expectNoRenderContext } from './fixtures/real-office.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

interface ToolCall { tool: string; args: Record<string, unknown> }

const contexts: Context[] = []
/** The `office` skill's advertised resource directory; format reads resolve their relative paths against it. */
const resourceBase = fileURLToPath(new URL('../assets/office/', import.meta.url)).replace(/[\\/]$/u, '').split(sep).join('/')
const office: ToolCall = { tool: 'skill', args: { name: 'office' } }
const readFormat = (format: string): ToolCall => ({ tool: 'read', args: { file_path: `${resourceBase}/${format}.md` } })
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

class SkillProgram extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'
  resolve(request: PtcRunRequest): PtcRunSpec { return { ...request, cwd: process.cwd(), timeoutMs: 120_000 } }
  async run(request: PtcRunSpec) {
    const { tool, args } = JSON.parse(request.program) as ToolCall
    const resolved = await request.bindings[0]!.functions[tool]!(args)
    const value = resolved instanceof PtcInspectableValue ? resolved.value : resolved
    return { output: [{ type: 'text' as const, text: JSON.stringify(value) }] }
  }
}

async function setup(mode: 'native' | 'ptc', calls: ToolCall[]) {
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
  await ctx.plugin(LocalFileSystem, { cwd: '/' })
  await ctx.plugin(ToolFs)
  await ctx.plugin(SkillOffice)
  if (mode === 'ptc') await ctx.plugin(SkillProgram)
  const adapter = new MockAdapter([
    ...calls.map((call, index) => mode === 'native'
      ? toolCallResponse(`call-${index}`, call.tool, call.args)
      : toolCallResponse(`call-${index}`, 'run_code', { code: JSON.stringify(call), description: 'Load task instructions' })),
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

it.each(['native', 'ptc'] as const)('loads the office skill and reads one format file in %s; resume and fork retain both', async (mode) => {
  const { ctx, agent, adapter } = await setup(mode, [office, readFormat('docx')])
  await send(agent, 'Edit the Word document text.')
  expect(adapter.requests).toHaveLength(3)
  const requests = adapter.requests.map(request => JSON.stringify(request))
  expect(requests[0]).toContain('Create, read, edit, and validate Word, PowerPoint, and Excel files;')
  expect(requests[0]).not.toMatch(/office-(?:docx|pptx|xlsx)/u)
  expect(requests[1]).toContain('# Office tasks')
  expect(requests[1]).toContain(resourceBase)
  if (mode === 'native') expect(requests[1]).toContain('Base directory for this skill:')
  expect(requests[1]).toContain('`docx.md` for Word')
  expect(requests[1]).not.toContain('python-docx')
  expect(requests[2]).toContain('python-docx')
  expect(requests[2]).toContain('Python environment section of the `office` skill')
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
  const { agent: resumed } = await ctx.agents.create({ sessionId: brandString<SessionId>('resumed-office'), agentOptions: { provider: 'mock', model: 'model' }, seed })
  await send(resumed)
  const { agent: forked } = await ctx.agents.create({ sessionId: brandString<SessionId>('forked-office'), agentOptions: { provider: 'mock', model: 'model' }, seed, meta: { parentSession: agent.id } })
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

it('routes standalone operations to dedicated Office tools without format files', async () => {
  const { agent, adapter } = await setup('native', [office])
  await send(agent)
  const loaded = JSON.stringify(adapter.requests.at(-1))
  expect(loaded).toContain('# Office tasks')
  for (const name of ['office_render', 'office_recalculate', 'office_convert']) expect(loaded).toContain(`\`${name}\``)
  expect(loaded).not.toContain('operation:')
  expect(loaded).not.toMatch(/# Word documents|# Excel workbooks|python-docx/)
})

it('injects an explicitly invoked office skill, which then directs the model to the format file', async () => {
  const { agent, adapter } = await setup('native', [readFormat('xlsx')])
  await send(agent, '/office Change A1 to 42.')
  expect(adapter.requests).toHaveLength(2)
  const invoked = JSON.stringify(adapter.requests[0])
  expect(invoked).toContain('# Office tasks')
  expect(invoked).toContain('`xlsx.md` for Excel')
  expect(invoked).not.toMatch(/# Excel workbooks|dsoffice/)
  expect(JSON.stringify(adapter.requests[1])).toContain('# Excel workbooks')
})

it.each(['native', 'ptc'] as const)('accepts read format files without a render call as a non-rendering context in %s', async (mode) => {
  const { agent } = await setup(mode, [office, readFormat('docx'), readFormat('pptx'), readFormat('xlsx')])
  await send(agent, 'Edit the Office files without visual inspection.')
  const events = agent.session.snapshotEvents()
  expect(JSON.stringify(events)).toContain('uniformly blank')
  expectNoRenderContext(events)
})
