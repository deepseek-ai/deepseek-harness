import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WebhookDeliveryId,
  WebhookRuleId,
  WebhookSourceId,
  type VerifiedWebhookDelivery,
  type WebhookSessionRequest,
} from '../src/index.ts'
import { createWebhookSession } from '../src/session.ts'

interface HarnessOptions {
  failAt?: 'permission-resolve' | 'preset-resolve' | 'standing' | 'workspace' | 'agent' | 'attach' | 'permission-set' | 'title' | 'followup'
  failDetach?: boolean
  failDispose?: boolean
  abortAt?: 'workspace' | 'agent'
}

interface SessionHarness {
  readonly ctx: Context
  readonly calls: string[]
  readonly messages: unknown[]
  readonly modelListeners: Map<string, unknown>
  readonly agent: unknown
  markRequestHeader(): void
  readonly controller: AbortController
  readonly request: WebhookSessionRequest
}

const active: SessionHarness[] = []

afterEach(() => {
  active.length = 0
})

/** Build a same-process fake around the private creation transaction. */
function harness(options: HarnessOptions = {}): SessionHarness {
  const calls: string[] = []
  const messages: unknown[] = []
  const modelListeners = new Map<string, unknown>()
  const controller = new AbortController()
  let requestHeader: object | undefined
  const session = {
    id: 'webhook-session',
    header: { cwd: '/workspace' },
    requestHeader: () => requestHeader,
  }
  const agent = {
    id: 'webhook-session',
    session,
    followup(message: unknown) {
      calls.push('followup')
      if (options.failAt === 'followup') throw new Error('followup failed')
      messages.push(message)
    },
  }
  const handle = {
    agent,
    async dispose() {
      calls.push('dispose')
      if (options.failDispose) throw new Error('dispose failed')
    },
  }
  const workspace = {
    path: '/workspace',
    async attachSession() {
      calls.push('attach')
      if (options.failAt === 'attach') throw new Error('attach failed')
    },
    async detachSession() {
      calls.push('detach')
      if (options.failDetach) throw new Error('detach failed')
    },
  }
  const fake = {
    logger: { warn: vi.fn() },
    permissionPresets: {
      resolve(name: string) {
        calls.push(`permission-resolve:${name}`)
        if (options.failAt === 'permission-resolve') throw new Error('permission resolve failed')
        return {}
      },
      set(_session: unknown, name: string) {
        calls.push(`permission-set:${name}`)
        if (options.failAt === 'permission-set') throw new Error('permission set failed')
      },
    },
    agentDefaultModel: {
      currentSelection() {
        calls.push('default-model')
        return { provider: 'default-provider', model: 'default-model', reasoningEffort: 'high' }
      },
    },
    agentPresets: {
      async resolve(name: string) {
        calls.push(`preset-resolve:${name}`)
        if (options.failAt === 'preset-resolve') throw new Error('preset resolve failed')
        return { id: name }
      },
      async standingKeyFor(name: string) {
        calls.push(`standing:${name}`)
        if (options.failAt === 'standing') throw new Error('standing failed')
        return {}
      },
      async mount(_agentCtx: unknown, name: string) {
        calls.push(`mount:${name}`)
        return { id: name }
      },
    },
    workspaceRegistry: {
      async create(path: string) {
        calls.push(`workspace:${path}`)
        if (options.failAt === 'workspace') throw new Error('workspace failed')
        if (options.abortAt === 'workspace') controller.abort(new Error('abort after workspace'))
        return workspace
      },
    },
    agents: {
      async create(createOptions: { setup?: (ctx: unknown, agent: unknown) => Promise<void> }) {
        calls.push('agent-create')
        if (options.failAt === 'agent') throw new Error('agent failed')
        await createOptions.setup?.({
          on(event: string, listener: unknown) {
            modelListeners.set(event, listener)
            return () => {}
          },
        }, agent)
        if (options.abortAt === 'agent') controller.abort(new Error('abort after agent'))
        return handle
      },
    },
    sessionTitle: {
      rename() {
        calls.push('title')
        if (options.failAt === 'title') throw new Error('title failed')
        return {}
      },
    },
  }
  const result: SessionHarness = {
    ctx: fake as unknown as Context,
    calls,
    messages,
    modelListeners,
    agent,
    markRequestHeader() { requestHeader = {} },
    controller,
    request: {
      workspacePath: '/workspace',
      title: 'Review PR',
      prompt: 'Review it',
      agentPreset: 'standard',
      permissionPreset: 'read-only',
    },
  }
  active.push(result)
  return result
}

const delivery: VerifiedWebhookDelivery = {
  kind: 'github',
  source: WebhookSourceId('primary'),
  deliveryId: WebhookDeliveryId('delivery'),
  event: { action: 'ready_for_review' },
  receivedAt: 1,
}

async function create(test: SessionHarness, request = test.request): Promise<void> {
  await createWebhookSession(
    test.ctx,
    delivery,
    WebhookRuleId('review'),
    request,
    test.controller.signal,
  )
}

/** Read the initial model-selection listener installed during Agent setup. */
function modelRequestListener(test: SessionHarness): (
  payload: unknown,
  next: () => Promise<LlmCallConfig>,
) => Promise<LlmCallConfig> {
  const listener = test.modelListeners.get('agent/request')
  if (typeof listener !== 'function') {
    throw new Error('webhook Session did not install its initial model selection')
  }
  const request = listener as (
    payload: unknown,
    next: () => Promise<LlmCallConfig>,
  ) => Promise<LlmCallConfig>
  return (_payload, next) => request({ agent: test.agent }, next)
}

describe('webhook Session creation', () => {
  it('preflights, mounts, attaches, configures, titles, and prompts in order', async () => {
    const test = harness()
    await create(test)
    expect(test.calls).toEqual([
      'default-model',
      'permission-resolve:read-only',
      'preset-resolve:standard',
      'standing:standard',
      'workspace:/workspace',
      'agent-create',
      'mount:standard',
      'attach',
      'permission-set:read-only',
      'title',
      'followup',
    ])
    expect(test.messages).toHaveLength(1)
    expect(test.messages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'Review it' }],
      source: {
        kind: 'webhook', provider: 'github', source: 'primary', deliveryId: 'delivery', ruleId: 'review',
      },
    })
  })

  it('uses a complete explicit model without consulting the default', async () => {
    const test = harness()
    await create(test, { ...test.request, model: { provider: 'p', model: 'm', maxTokens: 10 } })
    expect(test.calls).not.toContain('default-model')
    const withoutCap = harness()
    await create(withoutCap, { ...withoutCap.request, model: { provider: 'p', model: 'm' } })
    expect(withoutCap.calls).not.toContain('default-model')
    await expect(modelRequestListener(withoutCap)(undefined, async () => ({
      provider: 'p', model: 'm', reasoningEffort: ReasoningEffortId('inherited'),
    }))).resolves.toEqual({ provider: 'p', model: 'm' })
  })

  it('preserves default reasoning until the first request header is durable', async () => {
    const test = harness()
    await create(test)
    const request = modelRequestListener(test)

    await expect(request(undefined, async () => ({
      provider: 'other-provider',
      model: 'default-model',
      reasoningEffort: ReasoningEffortId('other-provider-effort'),
    }))).resolves.toMatchObject({ reasoningEffort: 'other-provider-effort' })
    await expect(request(undefined, async () => ({
      provider: 'default-provider',
      model: 'other-model',
      reasoningEffort: ReasoningEffortId('other-model-effort'),
    }))).resolves.toMatchObject({ reasoningEffort: 'other-model-effort' })

    const routed = await request(undefined, async () => ({
      provider: 'default-provider',
      model: 'default-model',
      reasoningEffort: ReasoningEffortId('inherited'),
    })) as unknown
    expect(routed).toEqual({
      provider: 'default-provider',
      model: 'default-model',
      reasoningEffort: 'high',
    })

    test.markRequestHeader()
    await expect(request(undefined, async () => ({
      provider: 'later-provider',
      model: 'later-model',
      reasoningEffort: ReasoningEffortId('later'),
    }))).resolves.toEqual({
      provider: 'later-provider',
      model: 'later-model',
      reasoningEffort: 'later',
    })
  })

  it.each([
    [null, /must be null or a Session request object/],
    [{}, /workspacePath/],
    [{ workspacePath: 'relative', title: 't', prompt: 'p', agentPreset: 'a', permissionPreset: 'x' }, /must be absolute/],
    [{ workspacePath: '/w', title: ' ', prompt: 'p', agentPreset: 'a', permissionPreset: 'x' }, /title/],
    [{ workspacePath: '/w', title: 't', prompt: '', agentPreset: 'a', permissionPreset: 'x' }, /prompt/],
    [{ workspacePath: '/w', title: 't', prompt: 'p', agentPreset: '', permissionPreset: 'x' }, /agentPreset/],
    [{ workspacePath: '/w', title: 't', prompt: 'p', agentPreset: 'a', permissionPreset: '' }, /permissionPreset/],
    [{ workspacePath: '/w', title: 't', prompt: 'p', agentPreset: 'a', permissionPreset: 'x', model: null }, /model must be an object/],
    [{ workspacePath: '/w', title: 't', prompt: 'p', agentPreset: 'a', permissionPreset: 'x', model: {} }, /provider/],
    [{ workspacePath: '/w', title: 't', prompt: 'p', agentPreset: 'a', permissionPreset: 'x', model: { provider: 'p', model: 'm', maxTokens: 0 } }, /maxTokens/],
  ] as const)('rejects malformed rule result %# before side effects', async (request, message) => {
    const test = harness()
    await expect(create(test, request as never)).rejects.toThrow(message)
    expect(test.calls).toEqual([])
  })

  it.each([
    'permission-resolve', 'preset-resolve', 'standing', 'workspace', 'agent', 'attach',
  ] as const)('contains a %s failure before prompt admission', async (failAt) => {
    const test = harness({ failAt })
    await expect(create(test)).rejects.toThrow()
    expect(test.calls).not.toContain('followup')
    if (failAt === 'attach') expect(test.calls).toContain('dispose')
  })

  it.each(['permission-set', 'title', 'followup'] as const)(
    'detaches and disposes after a %s failure',
    async (failAt) => {
      const test = harness({ failAt })
      await expect(create(test)).rejects.toThrow()
      expect(test.calls).toContain('detach')
      expect(test.calls).toContain('dispose')
    },
  )

  it('preserves the original failure while reporting rollback failures', async () => {
    const test = harness({ failAt: 'title', failDetach: true, failDispose: true })
    await expect(create(test)).rejects.toThrow('title failed')
    expect((test.ctx.logger.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2)
  })

  it.each(['workspace', 'agent'] as const)('honors cancellation after %s settlement', async (abortAt) => {
    const test = harness({ abortAt })
    await expect(create(test)).rejects.toThrow(/abort after/)
    expect(test.calls).not.toContain('followup')
    if (abortAt === 'agent') expect(test.calls).toContain('dispose')
  })
})
