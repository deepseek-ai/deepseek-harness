/**
 * Session Controller model-directory and selection behavior: dynamic provider grouping,
 * provider-local catalog failures, logged-selection restoration without stale
 * catalog injection, advisory pass-through models, and the prompt-assembly
 * boundary for a running selection change.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AttachmentStore from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmCallConfig, LlmCallConfigAdapterDefaults, LlmModelInfo,
  LlmModelReasoningInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk,
  UserMessage,
} from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPromptRequest, SessionRequestId } from '../src/types.ts'
import { ApiSessionAgentController } from '../src/agent.ts'
import { buildModelCatalog } from '../src/catalog.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createSessionTestRemote } from './test-remote.ts'

function request<P>(payload: P): P {
  return payload
}

let nextRequestId = 1
function promptRequest(
  payload: Omit<SessionPromptRequest, 'requestId'>,
): SessionPromptRequest {
  return {
    ...payload,
    requestId: `models-${String(nextRequestId++)}` as SessionRequestId,
  }
}

class CatalogAdapter extends LlmAdapter {
  constructor(
    private readonly name: string,
    private readonly models: readonly LlmModelInfo[] | Error,
    private readonly reasoning?: LlmModelReasoningInfo,
    private readonly exactError?: Error,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.name }
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return this.models instanceof Error
      ? Promise.reject(this.models)
      : Promise.resolve(this.models)
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (this.exactError !== undefined) return Promise.reject(this.exactError)
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.reasoning === undefined ? {} : { reasoning: this.reasoning },
    })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Catalog tests never enter provider streaming.
  }
}

const REASONING: LlmModelReasoningInfo = {
  efforts: [
    { id: ReasoningEffortId('off'), name: 'Off' },
    { id: ReasoningEffortId('high'), name: 'High' },
    { id: ReasoningEffortId('max'), name: 'Max' },
  ],
  defaultEffort: ReasoningEffortId('high'),
}

async function harness(logged?: {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
  adapterDefaults?: LlmCallConfigAdapterDefaults
}): Promise<{
  ctx: Context
  agent: Agent
  sessionId: SessionId
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentRegistry)
  ctx.llm.registerAdapter(['deepseek-official'], new CatalogAdapter('DeepSeek', [
    { provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' },
    { provider: 'deepseek-official', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', description: 'Reasoning model' },
  ], REASONING))
  ctx.llm.registerAdapter(['broken'], new CatalogAdapter('Broken Provider', new Error('catalog offline')))
  ctx.llm.registerAdapter(['metadata-broken'], new CatalogAdapter('Metadata Broken', [
    { provider: 'metadata-broken', id: 'listed', name: 'Listed' },
  ], undefined, new Error('reasoning metadata offline')))
  ctx.llm.registerAdapter(['remote-rejected'], new CatalogAdapter(
    'Remote Rejected',
    [],
    undefined,
    new RemoteError('gateway/internal', 'fixture rejected the selection', {}),
  ))
  ctx.llm.registerAdapter(['empty'], new CatalogAdapter('Empty Provider', []))
  ctx.llm.registerAdapter(['duplicate'], new CatalogAdapter('Duplicate Provider', [
    { provider: 'duplicate', id: 'same', name: 'Same' },
    { provider: 'duplicate', id: 'same', name: 'Same Again' },
  ]))
  const session = ctx.sessions.create()
  if (logged !== undefined) {
    const { adapterDefaults, ...config } = logged
    session.append('request/header', {
      header: { config, ...adapterDefaults === undefined ? {} : { adapterDefaults } },
      reason: 'initial',
    })
  }
  const agent = {
    id: session.id,
    session,
    status: 'running',
    ctx,
    inbox: { nextTurn: [], nextStep: [] },
  } as unknown as Agent
  ctx.agents.register(agent)
  return { ctx, agent, sessionId: session.id }
}

function expectValue<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error('expected successful response')
  return result.value
}

function registerTextOnly(ctx: Context): void {
  ctx.llm.registerAdapter(['text-only'], new class extends CatalogAdapter {
    override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
      return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
    }
  }('Text Only', []))
}

/** Resolve the Client-visible next selection from durable state and the Host default. */
function currentSelection(ctx: Context, sessionId: SessionId) {
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error('expected a live test Session')
  return ctx.sessionProjections.snapshot(session).values.modelSelection?.next
    ?? ctx.agentDefaultModel.currentSelection()
}

describe('Web session model selection', () => {
  it('validates an ordered image batch before persisting any member', async () => {
    const { ctx, agent, sessionId } = await harness()
    const validateImage = vi.fn((_input: { data: Uint8Array }) => Promise.resolve())
    const saveImage = vi.fn((input: { data: Uint8Array; mediaType: 'image/png'; name?: string }) => Promise.resolve({
      attachmentId: `att-${String(input.data[0])}`,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      ...input.name === undefined ? {} : { name: input.name },
    }))
    const attachments = {
      imageLimits: {
        maxImageBytes: 4,
        maxImagesPerMessage: 2,
        maxMessageImageBytes: 4,
        maxImagePixels: 4,
        maxImageDimension: 2000,
        mediaTypes: ['image/png'],
      },
      validateImage,
      saveImage,
    }
    ctx.provide('attachments', Object.setPrototypeOf(attachments, AttachmentStore.prototype) as never)
    const followup = vi.fn()
    Object.assign(agent, { followup })
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })

    const result = await remote.prompt(promptRequest({
      sessionId,
      mode: 'queue' as const,
      content: [
        { type: 'image' as const, mediaType: 'image/png' as const, data: 'AQ==', name: 'first.png' },
        { type: 'text' as const, text: 'compare' },
        { type: 'image' as const, mediaType: 'image/png' as const, data: 'Ag==' },
      ],
    }))
    expect(result.ok).toBe(true)
    expect(validateImage.mock.calls.map(([input]) => [...input.data])).toEqual([[1], [2]])
    expect(saveImage.mock.calls.map(([input]) => [...input.data])).toEqual([[1], [2]])
    expect((followup.mock.calls[0]?.[0] as UserMessage).content).toEqual([
      {
        type: 'image',
        attachment: {
          attachmentId: 'att-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1, name: 'first.png',
        },
      },
      { type: 'text', text: 'compare' },
      { type: 'image', attachment: { attachmentId: 'att-2', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
    ])

    const denied = await remote.prompt(promptRequest({
      sessionId,
      mode: 'queue' as const,
      content: Array.from({ length: 3 }, () => ({
        type: 'image' as const, mediaType: 'image/png' as const, data: 'AQ==',
      })),
    }))
    expect(denied).toMatchObject({
      ok: false,
      error: { code: 'session/attachment-invalid', details: { reason: 'TOO_MANY_IMAGES' } },
    })
    expect(saveImage).toHaveBeenCalledTimes(2)
    await ctx.fiber.dispose()
  })

  it('delivers an admitted image batch through steer with the same ordered content as queue', async () => {
    const { ctx, agent, sessionId } = await harness()
    const attachments = {
      imageLimits: {
        maxImageBytes: 4,
        maxImagesPerMessage: 2,
        maxMessageImageBytes: 4,
        maxImagePixels: 4,
        maxImageDimension: 2000,
        mediaTypes: ['image/png'],
      },
      validateImage: vi.fn(() => Promise.resolve()),
      saveImage: vi.fn((input: { data: Uint8Array; mediaType: 'image/png'; name?: string }) => Promise.resolve({
        attachmentId: `att-${String(input.data[0])}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1,
        height: 1,
        ...input.name === undefined ? {} : { name: input.name },
      })),
    }
    ctx.provide('attachments', Object.setPrototypeOf(attachments, AttachmentStore.prototype) as never)
    const steer = vi.fn()
    const followup = vi.fn()
    Object.assign(agent, { steer, followup })
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })

    const result = await remote.prompt(promptRequest({
      sessionId,
      mode: 'steer' as const,
      content: [
        { type: 'text' as const, text: 'look at this' },
        { type: 'image' as const, mediaType: 'image/png' as const, data: 'AQ==', name: 'mid-turn.png' },
      ],
    }))
    expect(result.ok).toBe(true)
    expect(followup).not.toHaveBeenCalled()
    expect((steer.mock.calls[0]?.[0] as UserMessage).content).toEqual([
      { type: 'text', text: 'look at this' },
      {
        type: 'image',
        attachment: {
          attachmentId: 'att-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1, name: 'mid-turn.png',
        },
      },
    ])
    await ctx.fiber.dispose()
  })

  it('allows a text-only selection while durable or pending images remain available for later models', async () => {
    const { ctx, agent, sessionId } = await harness()
    registerTextOnly(ctx)
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })
    const image = {
      type: 'image' as const,
      attachment: { attachmentId: 'att-history', mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 },
    }
    const imageEvent = agent.session.append('user/message', {
      id: 'image-message', role: 'user', source: { kind: 'user' }, content: [image],
    } as never, { surfaceOp: 'append' })
    expect(expectValue(await remote.selectModel(request({
      sessionId, provider: 'text-only', model: 'plain',
    }))).selected).toEqual({ provider: 'text-only', model: 'plain' })

    agent.session.append('user/message', {
      id: 'summary', role: 'user', source: { kind: 'plugin', plugin: 'compact' },
      content: [{ type: 'text', text: 'image summarized' }],
    } as never, {
      surfaceOp: { op: 'replace', start: imageEvent.seq, end: imageEvent.seq },
      sourceEventSeqs: [imageEvent.seq],
    })
    ;(agent.inbox.nextTurn as UserMessage[]).push({
      id: 'pending-image', role: 'user', source: { kind: 'user' }, content: [image],
    } as never)
    expect(expectValue(await remote.selectModel(request({
      sessionId, provider: 'text-only', model: 'plain',
    }))).selected).toEqual({ provider: 'text-only', model: 'plain' })
    await ctx.fiber.dispose()
  })

  it('authorizes attachment bytes only when the session event stream references the id', async () => {
    const { ctx, agent, sessionId } = await harness()
    const ref = {
      attachmentId: 'att-authorized', mediaType: 'image/png' as const, bytes: 2, width: 1, height: 1,
    }
    const readImage = vi.fn(() => Promise.resolve({ ref, data: Uint8Array.of(1, 2) }))
    ctx.provide('attachments', { readImage } as never)
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })
    agent.session.append('agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [{
        id: 'queued-image', role: 'user', source: { kind: 'user' },
        content: [{ type: 'image', attachment: ref }],
      }],
    } as never)

    const allowed = await remote.attachment(request({
      sessionId, attachmentId: 'att-authorized' as never,
    }))
    expect(allowed).toMatchObject({ ok: true, value: { attachment: ref, data: 'AQI=' } })
    const denied = await remote.attachment(request({
      sessionId, attachmentId: 'att-other' as never,
    }))
    expect(denied).toMatchObject({
      ok: false,
      error: { code: 'session/attachment-invalid', details: { reason: 'ATTACHMENT_NOT_REFERENCED' } },
    })
    expect(readImage).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })
  it('groups successful providers and leaves an unlisted current selection out of the catalog', async () => {
    const { ctx, sessionId } = await harness({
      provider: 'deepseek-official',
      model: 'private-preview',
      reasoningEffort: ReasoningEffortId('max'),
    })
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }), cwd: '/tmp' })

    const catalog = expectValue(await remote.modelCatalog())
    expect(currentSelection(ctx, sessionId)).toEqual({
      provider: 'deepseek-official',
      model: 'private-preview',
      reasoningEffort: 'max',
    })
    expect(catalog.groups).toEqual([{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat', reasoning: REASONING },
        {
          id: 'deepseek-reasoner',
          name: 'DeepSeek Reasoner',
          description: 'Reasoning model',
          reasoning: REASONING,
        },
      ],
    }])
    expect(catalog.failures).toEqual([
      { id: 'broken', name: 'Broken Provider', message: 'catalog offline' },
      { id: 'metadata-broken', name: 'Metadata Broken', message: 'reasoning metadata offline' },
      {
        id: 'duplicate',
        name: 'Duplicate Provider',
        message: 'adapter returned invalid or duplicate model metadata for provider "duplicate"',
      },
    ])
    await ctx.fiber.dispose()
  })

  it('preserves optional catalog metadata and string provider failures', async () => {
    const { ctx } = await harness()
    ctx.llm.registerAdapter(['plain'], new CatalogAdapter('Plain', [
      { provider: 'plain', id: 'plain-model', name: 'Plain Model' },
    ]))
    ctx.llm.registerAdapter(['described-reasoning'], new CatalogAdapter('Described Reasoning', [
      { provider: 'described-reasoning', id: 'reasoning-model', name: 'Reasoning Model' },
    ], {
      efforts: [{ id: ReasoningEffortId('high'), name: 'High', description: 'More thinking' }],
    }))
    ctx.llm.registerAdapter(['string-failure'], new class extends CatalogAdapter {
      override listModels(): Promise<readonly LlmModelInfo[]> {
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- non-Error provider normalization is the scenario.
        return Promise.reject('string catalog failure')
      }
    }('String Failure', []))
    createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })

    const catalog = await buildModelCatalog(ctx)
    expect(catalog.groups).toEqual(expect.arrayContaining([
      { id: 'plain', name: 'Plain', models: [{ id: 'plain-model', name: 'Plain Model' }] },
      {
        id: 'described-reasoning',
        name: 'Described Reasoning',
        models: [{
          id: 'reasoning-model',
          name: 'Reasoning Model',
          reasoning: {
            efforts: [{ id: 'high', name: 'High', description: 'More thinking' }],
          },
        }],
      },
    ]))
    expect(catalog.failures).toContainEqual({
      id: 'string-failure', name: 'String Failure', message: 'string catalog failure',
    })
    await ctx.fiber.dispose()
  })

  it('accepts an advisory-unlisted model, rejects an unavailable provider, and switches only after the next assembly', async () => {
    const { ctx, agent, sessionId } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }), cwd: '/tmp' })
    const seed: LlmCallConfig = { provider: 'seed', model: 'seed', temperature: 0.2 }
    const signal = new AbortController().signal

    expect(currentSelection(ctx, sessionId))
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })

    const selected = expectValue(await remote.selectModel(request({
      sessionId,
      provider: 'deepseek-official',
      model: 'private-preview',
      reasoningEffort: 'max',
    })))
    expect(selected.selected).toEqual({
      provider: 'deepseek-official',
      model: 'private-preview',
      reasoningEffort: 'max',
    })
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toEqual(seed)

    expect((await ctx.systemPrompt.assemble()).variables)
      .toMatchObject({ provider: 'deepseek-official', model: 'private-preview' })
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 1, signal }, () => Promise.resolve(seed),
    )).resolves.toMatchObject({
      provider: 'deepseek-official',
      model: 'private-preview',
      reasoningEffort: 'max',
    })

    const unsupported = await remote.selectModel(request({
      sessionId,
      provider: 'deepseek-official',
      model: 'private-preview',
      reasoningEffort: 'medium',
    }))
    expect(unsupported).toMatchObject({
      ok: false,
      error: {
        code: 'session/model-unavailable',
        message: 'provider "deepseek-official" model "private-preview" does not support reasoning effort "medium"',
      },
    })

    const rejected = await remote.selectModel(request({
      sessionId,
      provider: 'missing',
      model: 'model',
    }))
    expect(rejected).toMatchObject({
      ok: false,
      error: {
        code: 'session/model-unavailable',
        message: 'no adapter registered for provider "missing"',
        details: { provider: 'missing', model: 'model' },
      },
    })
    expect(await remote.selectModel(request({
      sessionId,
      provider: 'remote-rejected',
      model: 'model',
    }))).toMatchObject({
      ok: false,
      error: {
        code: 'gateway/internal',
        message: 'fixture rejected the selection',
        details: {},
      },
    })
    expect(currentSelection(ctx, sessionId))
      .toEqual({ provider: 'deepseek-official', model: 'private-preview', reasoningEffort: 'max' })
    await ctx.fiber.dispose()
  })

  it('reads the Agent default live for a session whose log names no selection', async () => {
    const { ctx, sessionId } = await harness()
    let stored = { provider: 'deepseek-official', model: 'deepseek-chat' }
    createSessionTestRemote(ctx, {
      defaultModelSelection: () => stored,
      cwd: '/tmp',
    })

    expect(currentSelection(ctx, sessionId))
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    // The default moving after the session exists still reaches it: New
    // Session reuses a blank session rather than minting another, so a seed
    // captured at creation would show the superseded model there.
    stored = { provider: 'deepseek-official', model: 'deepseek-reasoner' }
    expect(currentSelection(ctx, sessionId))
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-reasoner' })
    await ctx.fiber.dispose()
  })

  it('keeps a session on its logged selection when the Agent default differs', async () => {
    const { ctx, sessionId } = await harness({
      provider: 'deepseek-official',
      model: 'deepseek-chat',
    })
    let stored = { provider: 'deepseek-official', model: 'deepseek-chat' }
    createSessionTestRemote(ctx, {
      defaultModelSelection: () => stored,
      cwd: '/tmp',
    })

    stored = { provider: 'duplicate', model: 'same' }
    expect(currentSelection(ctx, sessionId))
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    await ctx.fiber.dispose()
  })

  it('does not reinterpret an adapter-owned reasoning default as an explicit Web selection', async () => {
    const { ctx, agent } = await harness({
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      reasoningEffort: ReasoningEffortId('high'),
      adapterDefaults: { reasoningEffort: true },
    })
    createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'duplicate', model: 'same' }),
      cwd: '/tmp',
    })

    expect(new ApiSessionAgentController(ctx).selectionFor(agent).current)
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    await ctx.fiber.dispose()
  })

  it('saves an accepted selection as the default and survives a storage failure', async () => {
    const { ctx, sessionId } = await harness()
    const saved: unknown[] = []
    let reject = false
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      saveDefaultModelSelection: (selection) => {
        saved.push(selection)
        return reject ? Promise.reject(new Error('read-only document')) : Promise.resolve()
      },
      cwd: '/tmp',
    })

    expectValue(await remote.selectModel(request({
      sessionId, provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'max',
    })))
    expect(saved).toEqual([
      { provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'max' },
    ])

    // A refused selection never becomes anyone's default.
    await remote.selectModel(request({ sessionId, provider: 'missing', model: 'model' }))
    expect(saved).toHaveLength(1)

    // Storage failing is not the selection failing: the switch already applies
    // to this session, so the call still succeeds.
    reject = true
    const stillAccepted = expectValue(await remote.selectModel(request({
      sessionId, provider: 'deepseek-official', model: 'deepseek-chat',
    })))
    expect(stillAccepted.selected).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'high' })
    expect(currentSelection(ctx, sessionId))
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'high' })
    await ctx.fiber.dispose()
  })

  it('refuses a prompt no adapter can route, and reports it on the directory', async () => {
    const { ctx, sessionId } = await harness()
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'deleted-gateway', model: 'deleted-model' }),
      cwd: '/tmp',
    })

    // The client disabling its input is an affordance; this method stays
    // callable, so the refusal has to live here.
    const refused = await remote.prompt(promptRequest({
      sessionId, mode: 'queue' as const, content: [{ type: 'text' as const, text: 'hi' }],
    }))
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'session/model-unavailable', details: { provider: 'deleted-gateway', model: 'deleted-model' } },
    })
    const unavailableCatalog = await buildModelCatalog(ctx)
    expect(unavailableCatalog.routableProviders.includes(currentSelection(ctx, sessionId).provider)).toBe(false)

    // An advisory-unlisted model on a live route is NOT this: the route
    // serves it, so the prompt goes through and nothing blocks.
    expectValue(await remote.selectModel(request({
      sessionId, provider: 'deepseek-official', model: 'unlisted-but-served',
    })))
    const catalog = await buildModelCatalog(ctx)
    expect(catalog.routableProviders.includes(currentSelection(ctx, sessionId).provider)).toBe(true)
    expect(catalog.groups.flatMap(group => group.models.map(model => model.id)))
      .not.toContain('unlisted-but-served')
    await ctx.fiber.dispose()
  })

  it('serves a session and its catalog when the stored default names a route that is gone', async () => {
    const { ctx, sessionId } = await harness()
    createSessionTestRemote(ctx, {
      // What a Models-page removal leaves behind: the settings document still
      // names the route the user last picked, and nothing serves it.
      defaultModelSelection: () => ({ provider: 'deleted-gateway', model: 'deleted-model' }),
      cwd: '/tmp',
    })

    const catalog = await buildModelCatalog(ctx)
    // Passed through rather than repaired: matching no group is precisely what
    // makes the composer seat prompt for a selection instead of naming a model
    // the deployment cannot reach.
    expect(currentSelection(ctx, sessionId)).toEqual({ provider: 'deleted-gateway', model: 'deleted-model' })
    expect(catalog.groups.flatMap(group => group.models.map(model => `${group.id}/${model.id}`)))
      .not.toContain('deleted-gateway/deleted-model')
    await ctx.fiber.dispose()
  })

  it('maps image admission failures and accepts image-capable selections', async () => {
    const { ctx, agent, sessionId } = await harness()
    registerTextOnly(ctx)
    ctx.llm.registerAdapter(['image-capable'], new class extends CatalogAdapter {
      override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return Promise.resolve({
          provider, id: model, name: model, inputModalities: ['text', 'image'],
        })
      }
    }('Image Capable', []))
    ctx.llm.registerAdapter(['string-error'], new class extends CatalogAdapter {
      override resolveModel(): Promise<LlmResolvedModelInfo> {
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- non-Error provider normalization is the scenario.
        return Promise.reject('string selection failure')
      }
    }('String Error', []))
    let saveMode: 'success' | 'error' | 'remote' = 'success'
    const savedRef = {
      attachmentId: 'saved-image', mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1,
    }
    ctx.provide('attachments', Object.setPrototypeOf({
      saveImages: () => {
        if (saveMode === 'error') return Promise.reject(new Error('image store offline'))
        if (saveMode === 'remote') {
          return Promise.reject(new RemoteError('gateway/internal', 'fixture rejected', {}))
        }
        return Promise.resolve([savedRef])
      },
    }, AttachmentStore.prototype) as never)
    const followup = vi.fn()
    Object.assign(agent, { followup })
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })
    const image = { type: 'image' as const, mediaType: 'image/png' as const, data: 'AQ==' }

    expectValue(await remote.selectModel(request({
      sessionId, provider: 'text-only', model: 'plain',
    })))
    expect(await remote.prompt(promptRequest({
      sessionId, mode: 'queue', content: [image],
    }))).toMatchObject({
      ok: false,
      error: { code: 'session/attachment-invalid', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } },
    })

    expectValue(await remote.selectModel(request({
      sessionId, provider: 'image-capable', model: 'vision',
    })))
    expect(await remote.prompt(promptRequest({
      sessionId, mode: 'queue', content: [{ ...image, data: '' }],
    }))).toMatchObject({
      ok: false,
      error: { code: 'session/attachment-invalid', details: { reason: 'INVALID_IMAGE_BASE64' } },
    })

    saveMode = 'error'
    expect(await remote.prompt(promptRequest({
      sessionId, mode: 'queue', content: [image],
    }))).toMatchObject({ ok: false, error: { code: 'session/agent-busy' } })
    saveMode = 'remote'
    expect(await remote.prompt(promptRequest({
      sessionId, mode: 'queue', content: [image],
    }))).toMatchObject({ ok: false, error: { code: 'gateway/internal', message: 'fixture rejected' } })
    saveMode = 'success'
    expectValue(await remote.prompt(promptRequest({ sessionId, mode: 'queue', content: [image] })))
    expect(followup).toHaveBeenCalledOnce()

    ;(agent.inbox.nextTurn as UserMessage[]).push({
      id: 'pending-image', role: 'user', source: { kind: 'user' },
      content: [{ type: 'image', attachment: savedRef }],
    } as never)
    expectValue(await remote.selectModel(request({
      sessionId, provider: 'deepseek-official', model: 'deepseek-chat',
    })))
    expectValue(await remote.selectModel(request({
      sessionId, provider: 'image-capable', model: 'vision',
    })))
    expect(await remote.selectModel(request({
      sessionId, provider: 'metadata-broken', model: 'broken',
    }))).toMatchObject({
      ok: false, error: { code: 'session/model-unavailable', message: 'reasoning metadata offline' },
    })
    expect(await remote.selectModel(request({
      sessionId, provider: 'string-error', model: 'broken',
    }))).toMatchObject({
      ok: false,
      error: { code: 'session/model-unavailable', message: 'string selection failure' },
    })
    await ctx.fiber.dispose()
  })
})
