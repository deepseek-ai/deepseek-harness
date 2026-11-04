/** Skill activation and request-header retention through real AgentLoop and Session lifecycles. */
import { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as ToolOffice from '../src/index.ts'

const NAMES = ['office_convert', 'office_recalculate', 'office_render']
const SKILLS = ['office', 'office-docx', 'office-xlsx', 'office-pptx']
const signal = new AbortController().signal

function response(name?: string, args: object = {}): StreamChunk[] {
  if (name === undefined) return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Done' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Done' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const block = { type: 'tool-call' as const, id: ToolCallId('load'), name, arguments: JSON.stringify(args) }
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
    return { logs: [], value: await request.bindings[0]!.functions.skill!({ name: this.skill }) }
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
  for (const name of [...SKILLS, 'other', 'custom-office']) ctx.skills.register({ name, source: 'runtime', description: name, content: `${name} instructions` })
  if (!options.officeFirst) await ctx.plugin(ToolSkill)
  const fiber = await ctx.plugin(ToolOffice, options.skills === undefined ? {} : { activationSkills: options.skills })
  if (options.officeFirst) await ctx.plugin(ToolSkill)
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['fixture'], adapter)
  const agent = await loop.create(SessionId(`office-${randomUUID()}`), { provider: 'fixture', model: 'fixture' }, { cwd })
  return { ctx, agent, adapter, fiber }
}

async function turn(agent: Agent, text = 'Continue'): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

function names(request: GenerateOptions | undefined): string[] {
  return request?.tools?.map(tool => tool.name).filter(name => NAMES.includes(name)) ?? []
}

async function admitted(ctx: Context, agent: Agent): Promise<string[]> {
  const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'fixture', model: 'fixture' }, signal })
  try { return ctx.tools.schemas(agent, toolSet).map(tool => tool.name).filter(name => NAMES.includes(name)).sort() }
  finally { toolSet.dispose() }
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
    expect(adapter.requests[0]?.messages.some(message => JSON.stringify(message.content).includes('office_render'))).toBe(false)
    expect(adapter.requests[1]?.messages.some(message => JSON.stringify(message.content).includes('office_render'))).toBe(true)
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
      expect(await admitted(ctx, agent)).toEqual([])
    }
  })

  it.each([false, true])('marks committed user skill injections independently of plugin order (officeFirst=%s)', async (officeFirst) => {
    const { agent, adapter } = await harness([response('skill', { name: 'office' }), response()], { officeFirst })
    await turn(agent, '/office-docx')
    expect(names(adapter.requests[0])).toEqual([])
    expect(names(adapter.requests[1])).toEqual(NAMES)
    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'skill-invocation')).toBe(true)
  })

  it('activates on direct invocation without requiring a model skill call', async () => {
    const { ctx, agent, adapter } = await harness([response(), response()])
    await turn(agent, '/office')
    expect(names(adapter.requests[0])).toEqual([])
    expect(await admitted(ctx, agent)).toEqual(NAMES)
    await turn(agent, '/other')
    expect(names(adapter.requests[1])).toEqual(NAMES)
  })

  it('ignores a skill invocation on a Session that the registered Agent no longer owns', async () => {
    const { ctx, agent } = await harness()
    const other = (await ctx.agents.create({ sessionId: SessionId(`office-other-${randomUUID()}`) })).agent
    const get = vi.spyOn(ctx.agents, 'get').mockReturnValue(other)
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'office instructions' }], source: { kind: 'skill-invocation', name: 'office', form: 'instructions' },
    }), { surfaceOp: 'append' })
    expect(get).toHaveBeenCalledWith(agent.session.id)
    get.mockRestore()
    expect(await admitted(ctx, agent)).toEqual([])
    expect(await admitted(ctx, other)).toEqual([])
  })

  it('does not activate for user invocation of a non-Office skill', async () => {
    const { ctx, agent } = await harness([response()])
    await turn(agent, '/other')
    expect(await admitted(ctx, agent)).toEqual([])
  })

  it('returns UNKNOWN_TOOL before activation or without a step admission set', async () => {
    const { ctx, agent } = await harness()
    const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'fixture', model: 'fixture' }, signal })
    onTestFinished(() => { toolSet.dispose() })
    for (const name of NAMES) {
      for (const admission of [undefined, toolSet]) {
        const result = await executeToolFixture(ctx, { name, arguments: { input: 'a.xlsx', format: 'xlsx' }, agent,
          callId: ToolCallId(name), signal, ...admission === undefined ? {} : { toolSet: admission } })
        expect(result).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
      }
    }
  })

  it.each(NAMES)('retains the whole group when the request header contains only %s', async (name) => {
    const { ctx, agent } = await harness()
    agent.session.append('request/header', { reason: 'initial', header: {
      config: { provider: 'fixture', model: 'fixture' }, tools: ctx.tools.schemas().filter(tool => tool.name === name),
    } })
    expect(await admitted(ctx, agent)).toEqual(NAMES)
  })

  it('validates the configured skill set and activates only its names', async () => {
    for (const activationSkills of [[], [''], ['Office'], ['has space'], [1]]) expect(() => ToolOffice.Config({ activationSkills } as never)).toThrow()
    const { ctx, agent } = await harness([response(), response()], { skills: ['custom-office'] })
    await turn(agent, '/office')
    expect(await admitted(ctx, agent)).toEqual([])
    await turn(agent, '/custom-office')
    expect(await admitted(ctx, agent)).toEqual(NAMES)
  })

  it.each([false, true])('uses only recorded native declarations after persisted resume and fork (PTC=%s)', async (ptc) => {
    const root = await mkdtemp(join(tmpdir(), 'office-resume-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const first = await harness([response(), response()], { root, ptc })
    await turn(first.agent, '/office')
    await turn(first.agent)
    const sessionId = first.agent.session.id
    const seed = first.agent.session.snapshotEvents()
    expect(await admitted(first.ctx, first.agent)).toEqual(NAMES)
    await first.ctx.fiber.dispose()

    const next = await harness([response(), response()], { root, ptc })
    const resumed = (await next.ctx.agents.resume({ resumeSessionId: sessionId })).agent
    expect(await admitted(next.ctx, resumed)).toEqual(ptc ? [] : NAMES)
    await turn(resumed)
    const forked = await next.ctx.agents.create({ sessionId: SessionId('office-fork'), seed,
      inheritedEventCount: SessionLogOffset(seed.length), meta: { isSeeded: true, parentSession: sessionId } })
    expect(forked.agent.session.requestHeader()?.tools).toEqual(first.agent.session.requestHeader()?.tools)
    expect(await admitted(next.ctx, forked.agent)).toEqual(ptc ? [] : NAMES)
    await turn(forked.agent)
    expect(next.adapter.requests.map(names)).toEqual(ptc ? [[], []] : [NAMES, NAMES])
  })

  it('keeps the header after replacing conversation history with a summary', async () => {
    const { ctx, agent } = await harness([response(), response()])
    await turn(agent, '/office')
    await turn(agent)
    const header = agent.session.requestHeader()
    const users = agent.session.snapshotEvents().filter(event => event.type === 'user/message')
    const start = users[0]!
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Summary' }], source: { kind: 'user' } }), {
      surfaceOp: { op: 'replace', startSeq: start.seq, endSeq: start.seq },
      sourceEventSeqs: [start.seq],
    })
    ctx.emit('agent/disposed', { agent })
    expect(agent.session.requestHeader()).toBe(header)
    expect(await admitted(ctx, agent)).toEqual(NAMES)
  })

  it('clears transient marks on disposal and can reload after losing a pre-header mark', async () => {
    const { ctx, agent, fiber } = await harness([response()])
    await turn(agent, '/office')
    expect(await admitted(ctx, agent)).toEqual(NAMES)
    ctx.emit('agent/disposed', { agent })
    expect(await admitted(ctx, agent)).toEqual([])
    await executeToolFixture(ctx, { name: 'skill', arguments: { name: 'office' }, agent, callId: ToolCallId('reload'), signal })
    expect(await admitted(ctx, agent)).toEqual(NAMES)
    await fiber.dispose()
    expect(await admitted(ctx, agent)).toEqual([])
    await ctx.plugin(ToolOffice)
    expect(await admitted(ctx, agent)).toEqual([])
  })
})
