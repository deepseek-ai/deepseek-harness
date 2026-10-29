import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage, LlmError, ReasoningEffortId, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { toPiContext } from '@deepseek-ai/dsh-llm-pi-ai/src/context.ts'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { MockAdapter, textResponse } from './mock-adapter.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'test-compaction': { kind: 'test-compaction' } & import('@deepseek-ai/dsh-llm').ContextFormed
  }
}

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function harness(capable = new MockAdapter(Array.from({ length: 8 }, () => textResponse('ok')))) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  capable.systemPromptUpdate = 'in-history'
  const plain = new MockAdapter(Array.from({ length: 8 }, () => textResponse('ok')))
  ctx.llm.registerAdapter(['capable'], capable)
  ctx.llm.registerAdapter(['plain'], plain)
  let prompt = 'prompt one'
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => ({
    ...await next(), sections: [{ name: 'test', text: prompt, order: 0 }],
  }))
  const agent = await ctx.agentLoop.create(SessionId('admission'), { provider: 'capable', model: 'model' })
  installModelSelection(agent.ctx)
  ctx.on('llm/stream', (request, next) => {
    // Rebuild from copied source events, not the live projection's cached state.
    const subject = ctx.agents.get(request.sessionId!)!
    const replay = Session.create(subject.id, subject.session.snapshotEvents())
    expect(request.messages).toEqual(replay.deriveMessages())
    expect(request.system).toBeUndefined()
    return next()
  })
  return { ctx, agent, capable, plain, setPrompt: (text: string) => { prompt = text } }
}

async function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

function registerTool(ctx: Context, name: string, description = `${name} tool`) {
  return ctx.tools.register(defineContentToolFixture({
    name, description, parameters: {}, execute: async () => [{ type: 'text', text: 'done' }],
  }))
}

function systemTexts(request: GenerateOptions) {
  return request.messages.filter(message => message.role === 'system').map(message => message.content)
}

function expectPlain(request: GenerateOptions, prompt: string) {
  expect(systemTexts(request)).toEqual([[{ type: 'text', text: prompt }]])
  const converted = toPiContext(request)
  expect(converted.systemPrompt).toBe(prompt)
  expect(converted.messages.filter(message => message.role === 'user').map(message => message.content))
    .not.toContain('prompt one')
  expect(converted.messages.filter(message => message.role === 'user').map(message => message.content))
    .not.toContain('prompt two')
}

describe('prepared-route prompt admission', () => {
  describe.each(['addition-only', 'in-history'] as const)('prompt/tool admission with %s updates', (toolUpdate) => {
    it.each(['simultaneous', 'after-prompt-update'] as const)('preserves earlier input and defers additions: %s', async (timing) => {
      const h = await harness()
      h.capable.toolUpdate = toolUpdate
      registerTool(h.ctx, 'search')
      await send(h.agent, 'first')
      h.setPrompt('prompt two')
      if (timing === 'after-prompt-update') await send(h.agent, 'second')
      const previous = h.capable.requests.at(-1)!

      registerTool(h.ctx, 'fetch')
      await send(h.agent, 'add fetch')
      const request = h.capable.requests.at(-1)!
      expect(request.messages.slice(0, previous.messages.length)).toEqual(previous.messages)
      expect(systemTexts(request)).toEqual([
        [{ type: 'text', text: 'prompt one' }], [{ type: 'text', text: 'prompt two' }],
      ])
      expect(request.tools?.find(tool => tool.name === 'fetch')?.deferLoading).toBe(true)
      expect(request.messages.filter(message => message.role === 'developer').map(message => message.content))
        .toEqual([[{ type: 'tool-addition', toolName: 'fetch' }]])
      const header = h.agent.session.snapshotEvents().filter(event => event.type === 'request/header').at(-1)
      expect(header?.data.reason).toBe('change')
      expect(header?.data.startsSeries).not.toBe(true)
    })

    it('consolidates when the prepared route cannot append prompts', async () => {
      const h = await harness()
      h.capable.toolUpdate = toolUpdate
      await send(h.agent, 'first')
      h.setPrompt('prompt two')
      await send(h.agent, 'second')
      delete h.capable.systemPromptUpdate
      registerTool(h.ctx, 'fetch')
      await send(h.agent, 'add fetch')

      const request = h.capable.requests.at(-1)!
      expectPlain(request, 'prompt two')
      expect(request.tools?.find(tool => tool.name === 'fetch')?.deferLoading).not.toBe(true)
      expect(request.messages.filter(message => message.role === 'developer')).toEqual([])
    })

    it.each(['explicit', 'replacement'] as const)('rebuilds declarations without re-baselining an unchanged prompt at a %s series start', async (reason) => {
      const h = await harness()
      h.capable.toolUpdate = toolUpdate
      await send(h.agent, 'first')
      h.setPrompt('prompt two')
      await send(h.agent, 'second')
      if (reason === 'explicit') {
        h.ctx.on('agent/pre-step', async (_payload, next) => {
          const decision = await next()
          return decision.kind === 'enter' ? { ...decision, startsRequestSeries: true } : decision
        })
      } else {
        const seq = h.agent.session.surface.nodes.find(seq => h.agent.session.eventAt(seq)?.type === 'user/message')!
        h.agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'compacted history' }], source: { kind: 'test-compaction' },
        }), { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
      }
      registerTool(h.ctx, 'fetch')
      await send(h.agent, 'add fetch')

      const request = h.capable.requests.at(-1)!
      const previous = h.capable.requests.at(-2)!
      // The rendering is unchanged: the surviving prompt node keeps its place and the new series
      // only rebuilds declarations. Rewriting node 0 would invalidate the provider prefix.
      expect(systemTexts(request)).toEqual([
        [{ type: 'text', text: 'prompt one' }], [{ type: 'text', text: 'prompt two' }],
      ])
      expect(request.messages[0]).toEqual(previous.messages[0])
      expect(request.tools?.find(tool => tool.name === 'fetch')?.deferLoading).not.toBe(true)
      expect(request.messages.filter(message => message.role === 'developer')).toEqual([])
      const header = h.agent.session.snapshotEvents().filter(event => event.type === 'request/header').at(-1)
      expect(header?.data).toMatchObject({ reason: 'change', startsSeries: true })
    })

    it('rebuilds retained declarations after a same-name definition changes', async () => {
      const h = await harness()
      h.capable.toolUpdate = toolUpdate
      const disposeSearch = registerTool(h.ctx, 'search')
      await send(h.agent, 'first')
      h.setPrompt('prompt two')
      registerTool(h.ctx, 'fetch')
      await send(h.agent, 'add fetch')
      expect(h.capable.requests.at(-1)?.tools?.find(tool => tool.name === 'fetch')?.deferLoading).toBe(true)

      disposeSearch()
      registerTool(h.ctx, 'search', 'updated search tool')
      await send(h.agent, 'use updated search')
      const request = h.capable.requests.at(-1)!
      expect(request.tools?.map(({ name, description, deferLoading }) => ({ name, description, deferLoading })))
        .toEqual([
          { name: 'fetch', description: 'fetch tool', deferLoading: undefined },
          { name: 'search', description: 'updated search tool', deferLoading: undefined },
        ])
      expect(request.toolHistory?.updates).toEqual([])
      expect(request.messages.filter(message => message.role === 'developer')).toEqual([])
      expect(systemTexts(request)).toEqual([
        [{ type: 'text', text: 'prompt one' }], [{ type: 'text', text: 'prompt two' }],
      ])
    })
  })

  it.each(['capable', 'plain'] as const)('clears every active prompt version on %s routes across repeated requests and resume', async (provider) => {
    const h = await harness()
    await send(h.agent, 'first')
    h.setPrompt('prompt two')
    await send(h.agent, 'second')
    h.setPrompt('prompt three')
    await send(h.agent, 'third')
    expect(systemTexts(h.capable.requests[2]!)).toHaveLength(3)
    h.agent.model.select({ provider, model: 'model' })
    h.setPrompt('')
    await send(h.agent, 'clear')
    const adapter = provider === 'capable' ? h.capable : h.plain
    const cleared = adapter.requests.at(-1)!
    expect(systemTexts(cleared)).toEqual([])
    expect(toPiContext(cleared).systemPrompt).toBeUndefined()
    expect(JSON.stringify(toPiContext(cleared))).not.toContain('prompt ')
    const clearEvents = h.agent.session.snapshotEvents().filter(event => event.type === 'system/message').filter(event => event.data.turn === 4)
    expect(clearEvents).toHaveLength(3)
    for (const event of clearEvents) {
      expect(event.data.message.content).toEqual([])
      expect(event.surfaceOp).toEqual({ op: 'replace', startSeq: event.sourceEventSeqs?.[0], endSeq: event.sourceEventSeqs?.[0] })
    }
    const count = h.agent.session.snapshotEvents().filter(event => event.type === 'system/message').length
    await send(h.agent, 'still clear')
    expect(h.agent.session.snapshotEvents().filter(event => event.type === 'system/message')).toHaveLength(count)
    expect(systemTexts(adapter.requests.at(-1)!)).toEqual([])
    const { agent: resumed } = await h.ctx.agents.create({
      sessionId: SessionId('cleared-resume'), agentOptions: { provider, model: 'model' },
      seed: [...h.agent.session.snapshotEvents()],
    })
    await send(resumed, 'resume clear')
    expect(resumed.session.snapshotEvents().filter(event => event.type === 'system/message')).toHaveLength(count)
    expect(systemTexts(adapter.requests.at(-1)!)).toEqual([])
    h.setPrompt('restored instruction')
    await send(resumed, 'restore')
    expect(systemTexts(adapter.requests.at(-1)!)).toEqual([[{ type: 'text', text: 'restored instruction' }]])
    expect(JSON.stringify(adapter.requests.at(-1)!)).not.toContain('prompt ')
  })

  it.each(['explicit', 'tools'] as const)('keeps surviving prompt versions with unchanged text at a %s series start', async (reason) => {
    const h = await harness()
    await send(h.agent, 'first')
    h.setPrompt('prompt two')
    await send(h.agent, 'second')
    if (reason === 'explicit') {
      h.ctx.on('agent/pre-step', async (_payload, next) => {
        const decision = await next()
        return decision.kind === 'enter' ? { ...decision, startsRequestSeries: true } : decision
      })
    } else {
      h.ctx.tools.register(defineContentToolFixture({
        name: 'extra', description: 'extra tool', parameters: {},
        execute: async () => [{ type: 'text', text: 'done' }],
      }))
    }
    await send(h.agent, 'third')
    const previous = h.capable.requests[1]!
    const request = h.capable.requests[2]!
    // The rendering is unchanged, so the new series keeps the surviving prompt node: the whole
    // previous request stays a wire prefix instead of moving the prompt into message 0.
    expect(systemTexts(request)).toEqual([
      [{ type: 'text', text: 'prompt one' }], [{ type: 'text', text: 'prompt two' }],
    ])
    expect(request.messages.slice(0, previous.messages.length)).toEqual(previous.messages)
    const header = h.agent.session.snapshotEvents().filter(event => event.type === 'request/header').at(-1)
    expect(header?.data.reason).toBe(reason === 'explicit' ? 'series' : 'change')
    if (reason === 'tools') {
      // A tool-schema change starts the prompt series without a system event. The header records
      // the declaration change without `startsSeries`; the unsupported-route projection supplies
      // the complete active set, while tool history keeps its incremental baseline.
      expect(header?.data.startsSeries).toBeUndefined()
      expect(request.tools?.map(tool => tool.name)).toEqual(['extra'])
    }
  })

  it('keeps the cached prefix at a compaction series start when the prompt text is unchanged', async () => {
    const h = await harness()
    await send(h.agent, 'first')
    h.setPrompt('prompt two')
    await send(h.agent, 'second')
    const previous = h.capable.requests[1]!

    // A prune/compaction replaces the last admitted user message: the surface changes, so the
    // next step starts a new request series while the appended prompt node still holds the
    // rendered text.
    const seq = h.agent.session.surface.nodes.findLast(node => h.agent.session.eventAt(node)?.type === 'user/message')!
    h.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compacted history' }], source: { kind: 'test-compaction' },
    }), { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
    await send(h.agent, 'third')

    // Folding the prompt back into node 0 would move the system segment to wire message 0 and
    // miss the provider prefix cache from the first token, although no prompt text changed.
    const request = h.capable.requests[2]!
    expect(systemTexts(request)).toEqual([
      [{ type: 'text', text: 'prompt one' }], [{ type: 'text', text: 'prompt two' }],
    ])
    // The replacement shadows the previous request's last admitted message, so the shared wire
    // prefix is everything before it.
    expect(request.messages.slice(0, previous.messages.length - 1)).toEqual(previous.messages.slice(0, -1))
  })

  it.each([false, true])('reconciles compaction retries without replaying admission, older tail survives=%s', async (retainOlder) => {
    const overflow = () => { throw new LlmError('context window exceeded', 'CONTEXT_LENGTH') }
    const adapter = new MockAdapter([textResponse('one'), textResponse('two'), overflow, overflow, textResponse('done')])
    const h = await harness(adapter)
    const resolve = vi.spyOn(adapter, 'resolveModel')
    await send(h.agent, 'first')
    h.setPrompt('prompt two')
    await send(h.agent, 'second')
    h.setPrompt('prompt three')
    let assemblies = 0
    let preSteps = 0
    let attempts = 0
    h.ctx.on('system-prompt/assemble', (_assembly, _context, next) => { assemblies++; return next() })
    h.ctx.on('agent/pre-step', (_payload, next) => { preSteps++; return next() })
    h.ctx.on('agent/request-error', ({ failure }) => {
      expect(failure.code).toBe('CONTEXT_LENGTH')
      if (attempts++ === 0) {
        const nodes = h.agent.session.surface.nodes
        const latest = nodes.findLast(seq => h.agent.session.eventAt(seq)?.type === 'system/message')!
        const start = retainOlder ? latest : nodes[1]!
        const replaced = nodes.slice(nodes.indexOf(start), nodes.indexOf(latest) + 1)
        h.agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'compacted history' }], source: { kind: 'test-compaction' },
        }), { surfaceOp: { op: 'replace', startSeq: start, endSeq: latest }, sourceEventSeqs: replaced })
        // A retry must retain the assembly accepted for this step, not pick up new sections.
        h.setPrompt('not admitted until next step')
      }
      return Promise.resolve({ kind: 'retry' as const })
    })
    await send(h.agent, 'third')
    expect(adapter.requests).toHaveLength(5)
    expect(assemblies).toBe(1)
    expect(preSteps).toBe(1)
    expect(resolve).toHaveBeenCalledTimes(5)
    expectPlain(adapter.requests[3]!, 'prompt three')
    expect(adapter.requests[4]!.messages).toEqual(adapter.requests[3]!.messages)
    expect(adapter.requests[3]!.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'third' }])
    const events = h.agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'step/start')).toHaveLength(3)
    expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(3)
    expect(events.filter(event => event.type === 'request/header').map(event => event.data.reason)).toEqual(['initial', 'series'])
    expect(events.filter(event => event.type === 'system/message').filter(event => event.data.turn === 3).at(-1)?.surfaceOp).not.toBe('append')
  })

  it.each([false, true])('normalizes capable history on a plain route, changed=%s', async (changed) => {
    const h = await harness()
    await send(h.agent, 'first')
    h.setPrompt('prompt two')
    await send(h.agent, 'second')
    expect(systemTexts(h.capable.requests[1]!)).toHaveLength(2)
    h.agent.model.select({ provider: 'plain', model: 'model' })
    if (changed) h.setPrompt('prompt three')
    await send(h.agent, 'third')
    expectPlain(h.plain.requests[0]!, changed ? 'prompt three' : 'prompt two')
    const events = h.agent.session.snapshotEvents()
    const replacements = events.filter(event => event.type === 'system/message').filter(event => event.surfaceOp !== 'append')
    expect(replacements).toHaveLength(2)
    expect(replacements[0]?.type === 'system/message' && replacements[0].data.message.content).toEqual([])
    for (const event of replacements) {
      expect(event.surfaceOp).toEqual({ op: 'replace', startSeq: event.sourceEventSeqs?.[0], endSeq: event.sourceEventSeqs?.[0] })
    }
    await send(h.agent, 'fourth')
    expect(h.agent.session.snapshotEvents().filter(event => event.type === 'system/message')).toHaveLength(4)
    expectPlain(h.plain.requests[1]!, changed ? 'prompt three' : 'prompt two')
  })

  it('appends on the first capable request after a plain route', async () => {
    const h = await harness()
    h.agent.model.select({ provider: 'plain', model: 'model' })
    await send(h.agent, 'first')
    h.agent.model.select({ provider: 'capable', model: 'model' })
    h.setPrompt('prompt two')
    await send(h.agent, 'second')
    expect(systemTexts(h.capable.requests[0]!)).toEqual([
      [{ type: 'text', text: 'prompt one' }], [{ type: 'text', text: 'prompt two' }],
    ])
    const messages = h.capable.requests[0]!.messages
    expect(messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'system', 'user', 'user'])
    const notice = [{
      type: 'text',
      text: '[model changed: assistant turns above this point were generated by plain/model; the session continues with capable/model]',
    }]
    expect(messages.slice(-2).map(message => message.content)).toEqual([
      [{ type: 'text', text: 'second' }], notice,
    ])
    const notices = h.agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'model-selection')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.data).toMatchObject({
      content: notice,
      source: { kind: 'model-selection', form: 'notice', summary: 'plain/model → capable/model' },
    })
  })

  it.each([false, true])('resumes capable history with first pre-step replacement=%s', async (replace) => {
    const h = await harness()
    await send(h.agent, 'first')
    h.setPrompt('prompt two')
    await send(h.agent, 'second')
    const { agent: resumed } = await h.ctx.agents.create({
      sessionId: SessionId('resumed-capable'), agentOptions: { provider: 'capable', model: 'model' },
      seed: [...h.agent.session.snapshotEvents()],
    })
    h.ctx.on('agent/pre-step', ({ agent }, next) => {
      if (agent === resumed && replace) {
        const seq = agent.session.surface.nodes.find(seq => agent.session.eventAt(seq)?.type === 'user/message')!
        agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'compacted history' }], source: { kind: 'test-compaction' },
        }), { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
      }
      return next()
    })
    await send(resumed, 'resume')
    const previous = h.capable.requests[1]!
    const request = h.capable.requests[2]!
    // The first resumed pre-step replacement still starts a series, but an unchanged rendering
    // keeps both prompt versions in place instead of re-baselining node 0.
    expect(systemTexts(request)).toEqual([
      [{ type: 'text', text: 'prompt one' }], [{ type: 'text', text: 'prompt two' }],
    ])
    expect(request.messages[0]).toEqual(previous.messages[0])
    if (!replace) expect(request.messages.slice(0, previous.messages.length)).toEqual(previous.messages)
    expect(resumed.session.snapshotEvents().filter(event => event.type === 'request/header').map(event => event.data.reason))
      .toEqual(['initial', 'resume'])
  })

  it('normalizes restored history after explicitly selecting the declared resume route', async () => {
    const h = await harness()
    await send(h.agent, 'first')
    h.setPrompt('prompt two')
    await send(h.agent, 'second')
    const seed = h.agent.session.snapshotEvents()
    const { agent: resumed } = await h.ctx.agents.create({
      sessionId: SessionId('resumed'),
      agentOptions: { provider: 'plain', model: 'model' },
      seed: [...seed],
      setup: (_ctx, agent) => { agent.model.select({ provider: 'plain', model: 'model' }) },
    })
    await send(resumed, 'resume')
    expectPlain(h.plain.requests[0]!, 'prompt two')
    expect(resumed.session.snapshotEvents().filter(event => event.type === 'request/header').at(-1)?.data.reason).toBe('resume')
  })

  it.each(['request', 'prepare'] as const)('cancels during %s with a balanced empty step before input admission', async (stage) => {
    const h = await harness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const observe = async () => {
      const types = h.agent.session.snapshotEvents().map(event => event.type)
      expect(types).toContain('step/start')
      expect(types).not.toContain('system/message')
      expect(types).not.toContain('user/message')
      expect(types).not.toContain('request/header')
      entered.resolve(undefined)
      await release.promise
    }
    if (stage === 'request') h.ctx.on('agent/request', async (_payload, next) => { await observe(); return next() })
    else {
      const resolve = h.capable.resolveModel.bind(h.capable)
      vi.spyOn(h.capable, 'resolveModel').mockImplementation(async (...args) => { await observe(); return resolve(...args) })
    }
    h.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'cancelled' }], source: { kind: 'user' } }))
    await entered.promise
    h.agent.cancel({ kind: 'user' })
    release.resolve(undefined)
    await h.agent.whenIdle()
    expect(h.capable.requests).toHaveLength(0)
    const types = h.agent.session.snapshotEvents().map(event => event.type)
    expect(types.filter(type => type === 'step/start' || type === 'step/end')).toEqual(['step/start', 'step/end'])
    expect(types.filter(type => ['system/message', 'user/message', 'request/header'].includes(type))).toEqual([])
  })

  it.each([
    { selected: undefined, proposed: ReasoningEffortId('high') },
    { selected: ReasoningEffortId('high'), proposed: ReasoningEffortId('low') },
    { selected: ReasoningEffortId('high'), proposed: undefined },
  ])('rejects an agent/request effort change from $selected to $proposed before input admission', async ({ selected, proposed }) => {
    const adapter = new MockAdapter([textResponse('never')], {
      efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }, { id: ReasoningEffortId('high'), name: 'High' }],
      defaultEffort: ReasoningEffortId('low'),
    })
    const h = await harness(adapter)
    h.agent.model.select({
      provider: 'capable', model: 'model', ...selected === undefined ? {} : { reasoningEffort: selected },
    })
    h.ctx.on('agent/request', async (_payload, next) => {
      const { reasoningEffort: _effort, ...config } = await next()
      return { ...config, ...proposed === undefined ? {} : { reasoningEffort: proposed } }
    })

    await send(h.agent, 'reject the changed effort')
    expect(adapter.requests).toEqual([])
    const events = h.agent.session.snapshotEvents()
    expect(events.filter(event => ['request/header', 'user/message', 'system/message'].includes(event.type))).toEqual([])
    expect(events.at(-1)).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'error', error: {
        message: `agent "admission": agent/request proposed reasoning effort "${proposed ?? 'adapter default'}" after step preparation fixed "${selected ?? 'adapter default'}"; use agent.model.select() before step preparation`,
      } } },
    })
  })

  it('retains the captured selection for a retry and uses a pending choice on the next step', async () => {
    const adapter = new MockAdapter([
      () => { throw new LlmError('retry this request', 'SERVER') },
      textResponse('recovered'),
    ], { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] })
    const h = await harness(adapter)
    const selection = { provider: 'capable', model: 'model', reasoningEffort: ReasoningEffortId('high') }
    h.agent.model.select(selection)
    const prepared: (Readonly<ModelSelection> | undefined)[] = []
    h.ctx.on('system-prompt/assemble', (_assembly, context, next) => {
      prepared.push(context.modelSelection)
      return next()
    })
    h.ctx.on('agent/pre-step', ({ modelSelection }, next) => {
      prepared.push(modelSelection)
      return next()
    })
    h.ctx.on('agent/request-error', () => {
      h.agent.model.select({ provider: 'plain', model: 'next-model' })
      return Promise.resolve({ kind: 'retry' as const })
    })

    await send(h.agent, 'retry once')
    expect(prepared).toEqual([selection, selection])
    expect(adapter.requests.map(({ provider, model, reasoningEffort }) => ({ provider, model, reasoningEffort })))
      .toEqual([selection, selection])
    expect(h.plain.requests).toHaveLength(0)
    expect(h.agent.model.current())
      .toEqual({ provider: 'plain', model: 'next-model' })

    await send(h.agent, 'use the pending choice')
    expect(h.plain.requests[0]).toMatchObject({ provider: 'plain', model: 'next-model' })
    expect(h.ctx.sessionProjections.snapshot(h.agent.session).values.modelSelection)
      .toEqual({ lastUsed: { provider: 'plain', model: 'next-model' }, next: { provider: 'plain', model: 'next-model' } })
  })

  it('keeps generic config changes and concurrent selection on the same prepared route', async () => {
    const h = await harness()
    await send(h.agent, 'first')
    h.setPrompt('prompt two')
    h.ctx.on('agent/request', async (_payload, next) => {
      const config = await next()
      h.agent.model.select({ provider: 'plain', model: 'model' })
      return { ...config, temperature: 0.5, maxTokens: 100 }
    })
    await send(h.agent, 'second')
    expect(h.plain.requests).toHaveLength(0)
    expect(h.capable.requests[1]).toMatchObject({ provider: 'capable', temperature: 0.5, maxTokens: 100 })
    expect(systemTexts(h.capable.requests[1]!)).toHaveLength(2)
    expect(h.agent.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(2)
  })
})
