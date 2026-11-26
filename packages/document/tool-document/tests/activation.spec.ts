/** Skill activation and request-header retention through real AgentLoop and Session lifecycles. */
import { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, LlmAdapter, type ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { PtcInspectableValue, PtcRuntime, type PtcRunRequest, type PtcRunResult, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { type EpochHeader, type SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { projectToolSchema } from '@deepseek-ai/dsh-tools'
import { ToolStep } from '@deepseek-ai/dsh-tools/pipeline'
import * as ToolDocument from '../src/index.ts'

const NAMES = ['document_convert', 'document_recalculate', 'document_render']
const SKILLS = ['office']
const signal = new AbortController().signal

function response(name?: string, args: object = {}): StreamChunk[] {
  if (name === undefined) return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Done' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Done' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const block = { type: 'tool-call' as const, id: brandString<ToolCallId>('load'), name, arguments: JSON.stringify(args) }
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: block.id, name, argumentsDelta: block.arguments },
    { type: 'block-end', index: 0, block },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly script: StreamChunk[][]) { super() }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const next = this.script.shift()
    if (next === undefined) throw new Error('Office test script exhausted')
    yield* next
  }
}

class SkillRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'
  skill = 'office'
  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120_000 }
  }
  async run(request: PtcRunRequest): Promise<PtcRunResult> {
    const resolved = await request.bindings[0]!.functions.skill!({ name: this.skill })
    return { output: [], value: resolved instanceof PtcInspectableValue ? resolved.value : resolved }
  }
}

async function harness(script: StreamChunk[][] = [], options: {
  ptc?: boolean
  root?: string
  skills?: string[]
  officeFirst?: boolean
} = {}) {
  const ctx = new Context()
  const cwd = await mkdtemp(join(tmpdir(), 'office-activation-'))
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(cwd, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, tools: { mode: options.ptc ? 'ptc' : 'native' } })
  if (options.ptc) await ctx.plugin(SkillRuntime)
  if (options.root !== undefined) await ctx.plugin(JsonlPersistence, { root: options.root, compression: 'none' })
  const loop = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(SkillRegistry)
  for (const name of [...SKILLS, 'office-docx', 'other', 'custom-office']) ctx.skills.register({ name, source: 'runtime', description: name, content: `${name} instructions` })
  if (!options.officeFirst) await ctx.plugin(ToolSkill)
  const fiber = await ctx.plugin(ToolDocument, options.skills === undefined ? {} : { activationSkills: options.skills })
  if (options.officeFirst) await ctx.plugin(ToolSkill)
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['fixture'], adapter)
  const agent = await loop.create(brandString<SessionId>(`office-${randomUUID()}`), { provider: 'fixture', model: 'fixture' }, { cwd })
  return { ctx, agent, adapter, fiber }
}

async function turn(agent: Agent, text = 'Continue'): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

function names(request: GenerateOptions | undefined): string[] {
  return request?.tools?.map(tool => tool.name).filter(name => NAMES.includes(name)) ?? []
}

/** Office tools the Agent currently sees, as native declarations or PTC bindings. */
function admitted(ctx: Context, agent: Agent): string[] {
  return ctx.tools.getAll(agent).map(tool => tool.name).filter(name => NAMES.includes(name)).sort()
}

/** Office tools an Agent's next step can call: its native entries, or the bindings a PTC step declares in its SDK. */
async function callable(ctx: Context, agent: Agent): Promise<string[]> {
  const assembly = await ctx.systemPrompt.assemble({ scope: agent, agent, toolStep: ToolStep.capture(ctx.tools, agent) })
  const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
  return NAMES.filter(name => assembly.tools.some(tool => tool.name === name) || new RegExp(`^ {2}${name}: `, 'mu').test(sdk)).sort()
}

describe('Office skill admission', () => {
  it.each(SKILLS)('admits all tools on the step after the model loads %s', async (name) => {
    const { agent, adapter } = await harness([response('skill', { name }), response()])
    await turn(agent)
    expect(adapter.requests).toHaveLength(2)
    expect(names(adapter.requests[0])).toEqual([])
    expect(names(adapter.requests[1])).toEqual(NAMES)
  })

  it('observes successful nested PTC results and admits the next step bindings', async () => {
    const { ctx, agent, adapter } = await harness([
      response('run_code', { code: 'return tools.skill({name: "office"})', description: 'Load Office' }), response(),
    ], { ptc: true })
    const nested: boolean[] = []
    ctx.on('tools/result', (exec, result) => { if (exec.name === 'skill') nested.push(exec.parent !== undefined && !result.isError) })
    await turn(agent)
    expect(nested).toEqual([true])
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[0]?.messages.some(message => JSON.stringify(message.content).includes('document_render'))).toBe(false)
    expect(adapter.requests[1]?.messages.some(message => JSON.stringify(message.content).includes('document_render'))).toBe(true)
    expect(agent.session.requestHeader()?.tools?.map(tool => tool.name)).toEqual(['run_code'])
  })

  it.each([false, true])('ignores failed Office loads and other skills (PTC=%s)', async (ptc) => {
    for (const name of ['office', 'other']) {
      const { ctx, agent } = await harness([
        ptc ? response('run_code', { code: 'return tools.skill({name: "fixture"})', description: 'Load skill' }) : response('skill', { name }), response(),
      ], { ptc })
      if (ptc) (ctx.ptcRuntime as SkillRuntime).skill = name
      if (name === 'office') vi.spyOn(ctx.skills, 'get').mockRejectedValueOnce(new Error('Skill file is unreadable'))
      const errors: boolean[] = []
      ctx.on('tools/result', (exec, result) => { if (exec.name === 'skill') errors.push(result.isError) })
      await turn(agent)
      expect(errors).toEqual([name === 'office'])
      expect(admitted(ctx, agent)).toEqual([])
    }
  })

  it.each([false, true])('marks committed user skill injections independently of plugin order (officeFirst=%s)', async (officeFirst) => {
    const { agent, adapter } = await harness([response('skill', { name: 'other' }), response()], { officeFirst })
    await turn(agent, '/office')
    expect(names(adapter.requests[0])).toEqual([])
    expect(names(adapter.requests[1])).toEqual(NAMES)
    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'skill-invocation')).toBe(true)
  })

  it('activates on direct invocation without requiring a model skill call', async () => {
    const { ctx, agent, adapter } = await harness([response(), response()])
    const other = (await ctx.agents.create({ sessionId: brandString<SessionId>(`office-unrelated-${randomUUID()}`) })).agent
    await turn(agent, '/office')
    expect(names(adapter.requests[0])).toEqual([])
    expect(admitted(ctx, agent)).toEqual(NAMES)
    expect(admitted(ctx, other)).toEqual([])
    await turn(agent, '/other')
    expect(names(adapter.requests[1])).toEqual(NAMES)
  })

  it('ignores a skill invocation on a Session that the registered Agent no longer owns', async () => {
    const { ctx, agent } = await harness()
    const other = (await ctx.agents.create({ sessionId: brandString<SessionId>(`office-other-${randomUUID()}`) })).agent
    const get = vi.spyOn(ctx.agents, 'get').mockReturnValue(other)
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'office instructions' }], source: { kind: 'skill-invocation', name: 'office', form: 'instructions' },
    }), { surfaceOp: 'append' })
    expect(get).toHaveBeenCalledWith(agent.session.id)
    get.mockRestore()
    expect(admitted(ctx, agent)).toEqual([])
    expect(admitted(ctx, other)).toEqual([])
  })

  it.each(['other', 'office-docx'])('does not activate for user invocation of the unlisted skill %s', async (name) => {
    const { ctx, agent } = await harness([response()])
    await turn(agent, `/${name}`)
    expect(admitted(ctx, agent)).toEqual([])
  })

  it('returns UNKNOWN_TOOL before activation with or without a model step', async () => {
    const { ctx, agent } = await harness()
    const toolStep = ToolStep.capture(ctx.tools, agent)
    for (const name of NAMES) {
      for (const step of [undefined, toolStep]) {
        const result = await executeToolFixture(ctx, { name, arguments: { input: 'a.xlsx', format: 'xlsx' }, agent,
          callId: brandString<ToolCallId>(name), signal, ...step === undefined ? {} : { toolStep: step } })
        expect(result).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
      }
    }
  })

  it.each(NAMES)('retains the whole group when the request header contains only %s', async (name) => {
    const { ctx, agent } = await harness()
    agent.session.append('request/header', { reason: 'initial', header: {
      config: { provider: 'fixture', model: 'fixture' },
      tools: ctx.tools.getAll().filter(tool => tool.name === name).map(tool => projectToolSchema(tool, true)),
    } })
    expect(admitted(ctx, agent)).toEqual([])
    await agentEvents(ctx, agent).serial('agent/created', { source: 'resume' })
    expect(admitted(ctx, agent)).toEqual(NAMES)
  })

  it.each([false, true])('restores header-declared tools for Agents that exist when the plugin loads (PTC=%s)', async (ptc) => {
    const load = ptc
      ? response('run_code', { code: 'return tools.skill({name: "office"})', description: 'Load Office' })
      : response('skill', { name: 'office' })
    const { ctx, agent, fiber } = await harness([load, response()], { ptc })
    const unrelated = (await ctx.agents.create({ sessionId: brandString<SessionId>(`office-loaded-${randomUUID()}`) })).agent
    await turn(agent)
    expect(await callable(ctx, agent)).toEqual(NAMES)
    await fiber.dispose()
    expect(await callable(ctx, agent)).toEqual([])
    await ctx.plugin(ToolDocument)
    // A PTC header records only run_code, so the reloaded plugin cannot restore the earlier skill load.
    expect(await callable(ctx, agent)).toEqual(ptc ? [] : NAMES)
    expect(await callable(ctx, unrelated)).toEqual([])
  })

  it.each(['office_convert', 'office_recalculate', 'office_render'])('activates the renamed tools for an earlier Session whose header declares only %s', async (name) => {
    const { ctx, agent } = await harness()
    const [definition] = ctx.tools.getAll().filter(tool => tool.name === name.replace('office_', 'document_'))
    agent.session.append('request/header', { reason: 'initial', header: {
      config: { provider: 'fixture', model: 'fixture' }, tools: [{ ...projectToolSchema(definition!, true), name }],
    } })
    expect(admitted(ctx, agent)).toEqual([])
    await agentEvents(ctx, agent).serial('agent/created', { source: 'resume' })
    expect(admitted(ctx, agent)).toEqual(NAMES)
  })

  it.each(['"{{tools}}"', '[null, "document_render", {"name": 7}]'])('resumes an Agent whose recorded header tools are %s without adding the tools', async (tools) => {
    const { ctx, agent } = await harness()
    // A seeded fixture keeps the {{tools}} placeholder, and a log can carry entries that are not schemas.
    const header = JSON.parse(`{"config": {"provider": "fixture", "model": "fixture"}, "tools": ${tools}}`) as EpochHeader
    agent.session.append('request/header', { reason: 'initial', header })
    await agentEvents(ctx, agent).serial('agent/created', { source: 'resume' })
    expect(admitted(ctx, agent)).toEqual([])
  })

  it('validates the configured skill set and activates only its names', async () => {
    for (const activationSkills of [[], [''], ['Office'], ['has space'], [1]]) expect(() => ToolDocument.Config({ activationSkills } as never)).toThrow()
    const { ctx, agent } = await harness([response(), response()], { skills: ['custom-office'] })
    await turn(agent, '/office')
    expect(admitted(ctx, agent)).toEqual([])
    await turn(agent, '/custom-office')
    expect(admitted(ctx, agent)).toEqual(NAMES)
  })

  it.each([false, true])('uses only recorded native declarations after persisted resume and fork (PTC=%s)', async (ptc) => {
    const root = await mkdtemp(join(tmpdir(), 'office-resume-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const first = await harness([response(), response()], { root, ptc })
    await turn(first.agent, '/office')
    await turn(first.agent)
    const sessionId = first.agent.session.id
    const seed = first.agent.session.snapshotEvents()
    expect(await callable(first.ctx, first.agent)).toEqual(NAMES)
    await first.ctx.fiber.dispose()

    const next = await harness([response(), response()], { root, ptc })
    const resumed = (await next.ctx.agents.resume({ resumeSessionId: sessionId })).agent
    expect(await callable(next.ctx, resumed)).toEqual(ptc ? [] : NAMES)
    await turn(resumed)
    const forked = await next.ctx.agents.create({ sessionId: brandString<SessionId>('office-fork'), seed,
      inheritedEventCount: SessionLogOffset(seed.length), meta: { isSeeded: true, parentSession: sessionId } })
    expect(forked.agent.session.requestHeader()?.tools).toEqual(first.agent.session.requestHeader()?.tools)
    expect(await callable(next.ctx, forked.agent)).toEqual(ptc ? [] : NAMES)
    await turn(forked.agent)
    expect(next.adapter.requests.map(names)).toEqual(ptc ? [[], []] : [NAMES, NAMES])
  })

  it('keeps the header after replacing conversation history with a summary', async () => {
    const { ctx, agent, fiber } = await harness([response(), response()])
    await turn(agent, '/office')
    await turn(agent)
    const header = agent.session.requestHeader()
    const users = agent.session.snapshotEvents().filter(event => event.type === 'user/message')
    const start = users[0]!
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Summary' }], source: { kind: 'user' } }), {
      surfaceOp: { op: 'replace', startSeq: start.seq, endSeq: start.seq },
      sourceEventSeqs: [start.seq],
    })
    expect(agent.session.requestHeader()).toBe(header)
    // Reload the plugin so that only the retained header can restore the tools.
    await fiber.dispose()
    await ctx.plugin(ToolDocument)
    expect(admitted(ctx, agent)).toEqual(NAMES)
  })

  it('loses a pre-header activation when the plugin reloads and activates again on the next skill load', async () => {
    const { ctx, agent, fiber } = await harness([response()])
    await turn(agent, '/office')
    expect(admitted(ctx, agent)).toEqual(NAMES)
    expect(agent.session.requestHeader()?.tools?.map(tool => tool.name).filter(name => NAMES.includes(name))).toEqual([])
    await fiber.dispose()
    expect(admitted(ctx, agent)).toEqual([])
    await ctx.plugin(ToolDocument)
    expect(admitted(ctx, agent)).toEqual([])
    await executeToolFixture(ctx, { name: 'skill', arguments: { name: 'office' }, agent, callId: brandString<ToolCallId>('reload'), signal })
    expect(admitted(ctx, agent)).toEqual(NAMES)
  })
})
