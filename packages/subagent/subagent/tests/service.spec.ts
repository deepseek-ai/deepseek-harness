import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { type Agent } from '@deepseek-ai/dsh-agent'

import { HarnessError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { carrierKeyOf } from '@deepseek-ai/dsh-scope'
import SubagentRuntime, {
  foldSubagentDescriptor,
  snapshotSubagentDescriptor,
  SUBAGENT_DESCRIPTOR_VERSION,
  SubagentError,
  assertSubagentMaxDepth,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
  type SubagentResult,
  type SubagentRun,
  type SubagentRunEndInfo,
  type SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

function fakeParent(id = 'parent-1'): Agent {
  return { id: SessionId(id) } as unknown as Agent
}

const ALL_CAPS: SubagentCapabilities = { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true }
const NO_CAPS: SubagentCapabilities = { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false }

function baseRequest(overrides: Partial<SubagentStartRequest> = {}): SubagentStartRequest {
  return {
    prompt: [{ type: 'text', text: 'do a thing' }],
    parent: fakeParent(),
    signal: new AbortController().signal,
    ...overrides,
  }
}

class StubProvider implements SubagentProvider {
  readonly inheritsParentContext = false
  startCount = 0
  lastRequest: ResolvedSubagentStartRequest | undefined

  constructor(
    readonly name: string,
    readonly capabilities: SubagentCapabilities = ALL_CAPS,
    private readonly outcome: SubagentResult = {
      output: [{ type: 'text', text: 'ok' }],
      stopReason: 'completed',
    },
  ) {}

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    this.startCount += 1
    this.lastRequest = request
    return {
      id: SessionId(`child:${this.name}:${request.parent.id}`),
      localAgent: undefined,
      result: Promise.resolve(this.outcome),
      async dispose() {},
    }
  }
}

async function service(): Promise<{ ctx: Context; subagents: SubagentRuntime }> {
  const ctx = new Context()
  // The registry is a required injection of SubagentRuntime (its projection
  // units register in the constructor).
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  return { ctx, subagents: ctx.subagents }
}

describe('SubagentRuntime', () => {
  it('registers, lists, looks up, starts, and removes providers', async () => {
    const { ctx, subagents } = await service()
    const added: string[] = []
    const removed: string[] = []
    ctx.on('subagent/provider-added', provider => void added.push(provider.name))
    ctx.on('subagent/provider-removed', name => void removed.push(name))
    const provider = new StubProvider('alpha')

    const dispose = subagents.registerProvider(provider)
    expect(subagents.list()).toEqual(['alpha'])
    expect(subagents.getProvider('alpha')).toBe(provider)
    const run = await subagents.start('alpha', baseRequest())
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    expect(provider.startCount).toBe(1)

    dispose()
    expect(added).toEqual(['alpha'])
    expect(removed).toEqual(['alpha'])
    expect(subagents.getProvider('alpha')).toBeUndefined()
  })

  it('rolls registration back when provider-added throws', async () => {
    const { ctx, subagents } = await service()
    ctx.on('subagent/provider-added', () => { throw new Error('added boom') })
    expect(() => { subagents.registerProvider(new StubProvider('alpha')) }).toThrow('added boom')
    expect(subagents.getProvider('alpha')).toBeUndefined()
  })

  it('rejects duplicate and absent provider names with typed errors', async () => {
    const { subagents } = await service()
    subagents.registerProvider(new StubProvider('dup'))
    expect(() => { subagents.registerProvider(new StubProvider('dup')) })
      .toThrow(expect.objectContaining({ code: 'DUPLICATE_PROVIDER' }))
    await expect(subagents.start('missing', baseRequest()))
      .rejects.toMatchObject({ code: 'NO_PROVIDER' })
  })

  it('resolves the one-shot descriptor and exposes no provider continuation operations', async () => {
    const { subagents } = await service()
    const provider = new StubProvider('one-shot')
    subagents.registerProvider(provider)
    const request = baseRequest()
    await subagents.start('one-shot', request)

    expect(provider.lastRequest).toEqual({
      ...request,
      descriptor: {
        version: SUBAGENT_DESCRIPTOR_VERSION,
        mode: 'one-shot',
        provider: 'one-shot',
      },
    })
    expect(provider.lastRequest).not.toBe(request)
    expectTypeOf<Parameters<SubagentRuntime['start']>[1]>().toExtend<SubagentStartRequest>()
    expect('resume' in subagents).toBe(false)
    expect('resume' in provider).toBe(false)
  })

  it('does not expose manager teardown and treats public drains as no-ops when no manager was bound', async () => {
    const { subagents } = await service()
    // Without `ctx.agents` no manager exists, so nothing was ever materialized.
    expect('drainContinuable' in subagents).toBe(false)
    await expect(subagents.drainContinuableDescendants([])).resolves.toBeUndefined()
    await expect(subagents.drainContinuableChildren(fakeParent(), [SessionId('child')])).resolves.toBeUndefined()
  })

  it('treats interrupt as an accepted no-op when no manager was bound', async () => {
    const { subagents } = await service()
    // Without a continuation manager no live Activation can exist, so there is
    // nothing to stop and nothing to authorize against.
    expect(() => { subagents.interrupt(SessionId('child'), {
      kind: 'user',
      parentSessionId: SessionId('parent-1'),
    }) }).not.toThrow()
  })

  it('rejects continuable operations when their runtime services are absent', async () => {
    const { subagents } = await service()
    await expect(subagents.startContinuable({
      provider: 'unused',
      label: 'unused child',
      request: baseRequest(),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'CONTINUATION_UNAVAILABLE' })
    await expect(subagents.sendMessage(
      fakeParent(),
      SessionId('child'),
      [{ type: 'text', text: 'hello' }],
      { signal: new AbortController().signal },
    )).rejects.toMatchObject({ code: 'CONTINUATION_UNAVAILABLE' })
  })

  it.each([
    ['agentOptions', { agentOptions: { model: 'child-model' } }],
    ['outputSchema', { outputSchema: { type: 'object', properties: {} } }],
    ['depthLimit', { maxDepth: 1 }],
    ['toolFilter', { toolFilter: { deny: ['bash'] } }],
    ['persona', { persona: 'reviewer' }],
  ] as const)('rejects unsupported %s before provider startup', async (_capability, override) => {
    const { subagents } = await service()
    const provider = new StubProvider('weak', NO_CAPS)
    subagents.registerProvider(provider)
    await expect(subagents.start('weak', baseRequest(override)))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
    expect(provider.startCount).toBe(0)
  })

  it('validates depth and schema semantics before provider startup', async () => {
    const { subagents } = await service()
    const provider = new StubProvider('strong')
    subagents.registerProvider(provider)
    await expect(subagents.start('strong', baseRequest({ maxDepth: -1 })))
      .rejects.toThrow('non-negative safe integer')
    await expect(subagents.start('strong', baseRequest({ outputSchema: { type: 'string' } as never })))
      .rejects.toThrow()
    expect(provider.startCount).toBe(0)
    expect(() => { assertSubagentMaxDepth(undefined) }).not.toThrow()
  })

  it('publishes lifecycle only after async provider start and keeps parent scope', async () => {
    const { ctx, subagents } = await service()
    const ready = Promise.withResolvers<SubagentRun>()
    const result = Promise.withResolvers<SubagentResult>()
    subagents.registerProvider({
      name: 'deferred',
      capabilities: NO_CAPS,
      inheritsParentContext: false,
      start: () => ready.promise,
    })
    const parent = fakeParent('delegator')
    const events: string[] = []
    const keys: unknown[] = []
    const runIds: string[] = []
    ctx.on('subagent/start', function (info) { events.push('start'); keys.push(carrierKeyOf(this)); runIds.push(info.runId) })
    ctx.on('subagent/end', function (info) { events.push('end'); keys.push(carrierKeyOf(this)); runIds.push(info.runId) })

    const starting = subagents.start('deferred', baseRequest({ parent }))
    await Promise.resolve()
    expect(events).toEqual([])
    ready.resolve({ id: SessionId('child'), localAgent: undefined, result: result.promise, async dispose() {} })
    const run = await starting
    expect(events).toEqual(['start'])
    result.resolve({ output: [{ type: 'text', text: 'answer' }], stopReason: 'completed' })
    await run.result
    await Promise.resolve()
    expect(events).toEqual(['start', 'end'])
    expect(keys).toEqual([parent, parent])
    expect(runIds[0]).toBe(runIds[1])
  })

  it('mints distinct lifecycle identities when provider and child ids repeat', async () => {
    const { ctx, subagents } = await service()
    subagents.registerProvider(new StubProvider('reused'))
    const runIds: string[] = []
    ctx.on('subagent/start', info => void runIds.push(info.runId))

    const first = await subagents.start('reused', baseRequest())
    const second = await subagents.start('reused', baseRequest())
    await Promise.all([first.result, second.result])

    expect(runIds).toHaveLength(2)
    expect(new Set(runIds).size).toBe(2)
  })

  it('emits no run lifecycle when provider startup rejects', async () => {
    const { ctx, subagents } = await service()
    subagents.registerProvider({
      name: 'failed',
      capabilities: NO_CAPS,
      inheritsParentContext: false,
      start: async () => { throw new Error('setup rolled back') },
    })
    const lifecycle = vi.fn()
    ctx.on('subagent/start', lifecycle)
    ctx.on('subagent/end', lifecycle)
    await expect(subagents.start('failed', baseRequest())).rejects.toThrow('setup rolled back')
    expect(lifecycle).not.toHaveBeenCalled()
  })

  it('emits an enriched end event and maps result rejection to error telemetry', async () => {
    const { ctx, subagents } = await service()
    const completed = new StubProvider('completed', NO_CAPS, {
      output: [{ type: 'text', text: 'answer' }],
      stopReason: 'completed',
    })
    subagents.registerProvider(completed)
    const ended = vi.fn()
    ctx.on('subagent/end', ended)
    const run = await subagents.start('completed', baseRequest())
    await run.result
    await Promise.resolve()
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'answer' }],
      stopReason: 'completed',
    }))

    // The lifecycle event omits lastAssistantMessage when output is empty,
    // matching the continuable epoch event.
    const silent = new StubProvider('silent', NO_CAPS, { output: [], stopReason: 'completed' })
    subagents.registerProvider(silent)
    const silentRun = await subagents.start('silent', baseRequest())
    await silentRun.result
    await Promise.resolve()
    const silentEnd = ended.mock.calls.map(call => call[0] as SubagentRunEndInfo).find(info => info.provider === 'silent')
    expect(silentEnd).toBeDefined()
    expect('lastAssistantMessage' in silentEnd!).toBe(false)

    const failure = Promise.withResolvers<SubagentResult>()
    subagents.registerProvider({
      name: 'infra',
      capabilities: NO_CAPS,
      inheritsParentContext: false,
      async start() {
        return { id: SessionId('infra-child'), localAgent: undefined, result: failure.promise, async dispose() {} }
      },
    })
    const failedRun = await subagents.start('infra', baseRequest())
    failure.reject(new Error('transport'))
    await expect(failedRun.result).rejects.toThrow('transport')
    await Promise.resolve()
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({ provider: 'infra', stopReason: 'error' }))
  })

  it('contains synchronous and asynchronous lifecycle observer failures', async () => {
    const { ctx, subagents } = await service()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => void warnings.push(String(message))) as typeof ctx.logger.warn
    const heard: string[] = []
    ctx.on('subagent/provider-removed', () => { throw new Error('sync boom') })
    // Runtime listeners may return thenables even though the declaration's observable result is void.
    // oxlint-disable-next-line typescript/no-misused-promises -- exercises rejected-listener containment
    ctx.on('subagent/provider-removed', async () => { throw new Error('async boom') })
    ctx.on('subagent/provider-removed', () => { throw { toString: () => { throw new Error('coercion') } } })
    ctx.on('subagent/provider-removed', name => void heard.push(name))
    const dispose = subagents.registerProvider(new StubProvider('contained'))

    dispose()
    await Promise.resolve()
    expect(heard).toEqual(['contained'])
    expect(warnings.some(message => message.includes('sync boom'))).toBe(true)
    expect(warnings.some(message => message.includes('async boom'))).toBe(true)
    expect(warnings.some(message => message.includes('<unrenderable thrown value>'))).toBe(true)
  })

  it('SubagentError participates in the harness error taxonomy', () => {
    const error = new SubagentError('boom', 'NO_PROVIDER')
    expect(error).toBeInstanceOf(HarnessError)
    expect(error.name).toBe('SubagentError')
    expect(error.code).toBe('NO_PROVIDER')
  })
})

describe('subagent descriptors', () => {
  const event = (data: unknown): SessionEvent<'subagent/descriptor'> => ({
    type: 'subagent/descriptor',
    data,
  } as unknown as SessionEvent<'subagent/descriptor'>)

  it('omits absent fields, recovers a complete payload, and rejects unsupported versions', () => {
    expect(foldSubagentDescriptor([])).toBeUndefined()
    const minimal = snapshotSubagentDescriptor({ mode: 'one-shot', provider: 'spawn' })
    expect(minimal).toEqual({
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'one-shot',
      provider: 'spawn',
    })
    expect(foldSubagentDescriptor([event(minimal)])).toEqual(minimal)
    expect(snapshotSubagentDescriptor({
      mode: 'one-shot',
      provider: 'spawn',
      label: 'child work',
    })).toEqual({ ...minimal, label: 'child work' })
    const complete = {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable' as const,
      provider: 'spawn',
      label: 'complete child',
      agentProvider: 'deepseek',
      agentModel: 'chat',
      agentReasoningEffort: ReasoningEffortId('high'),
      persona: 'reviewer',
      toolFilter: { allow: ['read'], deny: ['bash'] },
    }
    expect(snapshotSubagentDescriptor({
      mode: 'continuable',
      provider: complete.provider,
      label: complete.label,
      agentProvider: complete.agentProvider,
      agentModel: complete.agentModel,
      agentReasoningEffort: complete.agentReasoningEffort,
      persona: complete.persona,
      toolFilter: complete.toolFilter,
    })).toEqual(complete)
    expect(foldSubagentDescriptor([event(complete)])).toEqual(complete)
    expect(foldSubagentDescriptor([
      event({
        version: SUBAGENT_DESCRIPTOR_VERSION,
        mode: 'continuable',
        provider: 'spawn',
        label: 'l',
        toolFilter: { allow: ['read'] },
      }),
    ])).toMatchObject({ toolFilter: { allow: ['read'] } })
    expect(foldSubagentDescriptor([
      event({
        version: SUBAGENT_DESCRIPTOR_VERSION,
        mode: 'continuable',
        provider: 'spawn',
        label: 'l',
        toolFilter: { deny: ['bash'] },
      }),
    ])).toMatchObject({ toolFilter: { deny: ['bash'] } })
    expect(foldSubagentDescriptor([
      event({ version: SUBAGENT_DESCRIPTOR_VERSION + 1, provider: 'spawn' }),
    ])).toBeUndefined()
    expect(() => snapshotSubagentDescriptor({
      mode: 'continuable',
      provider: 'spawn',
      label: 'bad',
      toolFilter: { deny: [Symbol('not-json')] as unknown as string[] },
    })).toThrow('not losslessly JSON-serializable')
  })

  it.each([
    ['string payload', 'invalid', 'payload must be an object'],
    ['null payload', null, 'payload must be an object'],
    ['array payload', [], 'payload must be an object'],
    ['missing version', { provider: 'spawn' }, 'version must be a number'],
    ['string version', { version: '1', provider: 'spawn' }, 'version must be a number'],
    ['missing mode', { version: SUBAGENT_DESCRIPTOR_VERSION }, 'mode must be "one-shot" or "continuable"'],
    ['invalid mode', { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'later' }, 'mode must be "one-shot" or "continuable"'],
    ['unknown one-shot field', {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'one-shot',
      provider: 'spawn',
      label: 'l',
      persona: 'reviewer',
    }, 'payload has unknown field "persona"'],
    ['invalid one-shot label', {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'one-shot',
      provider: 'spawn',
      label: 7,
    }, 'label must be a string'],
    ['unknown payload field', {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 'spawn',
      extra: true,
    }, 'payload has unknown field "extra"'],
    ['missing provider', { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'continuable' }, 'provider must be a string'],
    ['missing label', {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 'spawn',
    }, 'label must be a string'],
    ['invalid label', {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 'spawn',
      label: 7,
    }, 'label must be a string'],
    ['invalid provider', {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 7,
    }, 'provider must be a string'],
    ['invalid agent provider', {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 'spawn',
      label: 'l',
      agentProvider: 7,
    }, 'agentProvider must be a string'],
    ['invalid agent model', {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 'spawn',
      label: 'l',
      agentModel: [],
    }, 'agentModel must be a string'],
    ['invalid agent reasoning effort', {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 'spawn',
      label: 'l',
      agentReasoningEffort: 7,
    }, 'agentReasoningEffort must be a string'],
    ['invalid persona', {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 'spawn',
      label: 'l',
      persona: {},
    }, 'persona must be a string'],
    ['non-object tool filter', {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 'spawn',
      label: 'l',
      toolFilter: [],
    }, 'toolFilter must be an object'],
    ['unknown tool-filter field', {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 'spawn',
      label: 'l',
      toolFilter: { except: ['bash'] },
    }, 'toolFilter has unknown field "except"'],
    ['empty tool filter', {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 'spawn',
      label: 'l',
      toolFilter: {},
    }, 'toolFilter must declare allow and/or deny'],
    ['non-array allow list', {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 'spawn',
      label: 'l',
      toolFilter: { allow: 'read' },
    }, 'toolFilter.allow must be an array of strings'],
    ['non-string deny item', {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 'spawn',
      label: 'l',
      toolFilter: { deny: [7] },
    }, 'toolFilter.deny must be an array of strings'],
  ])('rejects a malformed persisted descriptor: %s', (_case, data, detail) => {
    expect(() => foldSubagentDescriptor([event(data)])).toThrow(detail)
  })
})
