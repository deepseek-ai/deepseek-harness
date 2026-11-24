import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
// The browser-facing child controls and their stable failure
// codes. Session Controller owns catalog observation and transport.

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AttachmentStore, { AttachmentError } from '@deepseek-ai/dsh-attachment'
import { LlmError, type MessageId, type ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime, {
  SubagentError,
  type SubagentErrorCode,
  type SubagentPromptRequestId,
} from '@deepseek-ai/dsh-subagent'
import { subagentManager } from './manager-internals.ts'
import type { PeerId, Principal, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only non-owner caller shared by the access specs. */
    'test-guest': { readonly kind: 'test-guest'; readonly guest: string }
  }
}

const PARENT = brandString<SessionId>('parent')
const CHILD = brandString<SessionId>('child')
const PARENT_CREATED_AT = 1
const REQUEST_ID = 'req-1' as SubagentPromptRequestId
const GUEST: Principal = { kind: 'test-guest', guest: 'subagent' }
const signal = new AbortController().signal
/** Durable-reference base for the fake store; per-test ids and media types override. */
const IMAGE_REF = { attachmentId: 'att', mediaType: 'image/png', bytes: 2, width: 1, height: 1 }

/** Models each stub provider lists in its catalog. */
const CATALOG: Readonly<Record<string, readonly string[]>> = { mock: ['chosen'] }

/**
 * The runtime plus a programmable live-Agent registry, omitted to compose none,
 * and a catalog-only LLM registry, `null` to compose none.
 */
async function bench(
  live?: Record<string, { status: 'running' | 'idle' }>,
  catalog: Readonly<Record<string, readonly string[]>> | null = CATALOG,
) {
  const ctx = new Context()
  await mountWorkingDirectoryFixture(ctx)
  if (ctx.get('sessionProjections') === undefined) await ctx.plugin(SessionProjectionRegistry)
  if (catalog !== null) {
    ctx.provide('llm', {
      isModelInCatalog: async (provider: string, model: string) => catalog[provider]?.includes(model) === true,
    } as never)
  }
  await ctx.plugin(SubagentRuntime)
  if (live !== undefined) {
    ctx.provide('agents', {
      get: (id: SessionId) => {
        const agent = live[id]
        return agent === undefined
          ? undefined
          : { ...agent, session: { header: { createdAt: PARENT_CREATED_AT } } }
      },
    } as never)
  }
  return { ctx, subagents: ctx.subagents }
}

/** Observe host delivery without widening the public service. */
function promptDelivery(ctx: Context) {
  return vi.spyOn(subagentManager(ctx), 'deliverPrompt')
}

function promptRequest(clientTimeZone?: string, delivery: 'queue' | 'steer' = 'queue') {
  return {
    requestId: REQUEST_ID,
    childSessionId: CHILD,
    delivery,
    content: [{ type: 'text' as const, text: 'continue' }],
    ...clientTimeZone === undefined ? {} : { clientTimeZone },
  }
}

function emptyIdFailure(method: string, field: string) {
  return {
    code: 'gateway/bad-request',
    message: `invalid payload for ${method}`,
    details: {
      issues: [{
        origin: 'string',
        code: 'too_small',
        minimum: 1,
        inclusive: true,
        path: [field],
        message: 'Too small: expected string to have >=1 characters',
      }],
    },
  }
}

describe('subagent prompt Remote', () => {
  it('rejects an empty child id before delivery', async () => {
    const { ctx, subagents } = await bench({ [PARENT]: { status: 'idle' } })
    const delivery = promptDelivery(ctx)

    await expect(subagents.prompt({ ...promptRequest(), childSessionId: brandString<SessionId>('') }, signal))
      .rejects.toMatchObject(emptyIdFailure('subagent.prompt', 'childSessionId'))
    expect(delivery).not.toHaveBeenCalled()
  })

  it('rejects an unknown delivery before admission', async () => {
    const { ctx, subagents } = await bench({ [PARENT]: { status: 'idle' } })
    const delivery = promptDelivery(ctx)

    await expect(subagents.prompt({ ...promptRequest(), delivery: 'later' as 'queue' }, signal))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(delivery).not.toHaveBeenCalled()
  })

  it('admits ordered image parts into durable references before delivery', async () => {
    const { ctx, subagents } = await bench({ [PARENT]: { status: 'idle' } })
    const saveImages = vi.fn(async (inputs: readonly { mediaType: string }[]) =>
      inputs.map((input, index) => ({ ...IMAGE_REF, attachmentId: `att-${index}`, mediaType: input.mediaType })))
    ctx.provide('attachments', Object.setPrototypeOf({ saveImages }, AttachmentStore.prototype) as never)
    const delivery = promptDelivery(ctx).mockResolvedValue('m-content' as MessageId)
    const content = [
      { type: 'text' as const, text: 'before' },
      { type: 'image' as const, mediaType: 'image/png' as const, data: 'aGk=' },
      { type: 'text' as const, text: 'after' },
    ]

    await expect(subagents.prompt({ ...promptRequest(), content }, signal))
      .resolves.toEqual({ messageId: 'm-content' })
    expect(delivery.mock.calls[0]?.[1]).toEqual([
      { type: 'text', text: 'before' },
      { type: 'image', attachment: { ...IMAGE_REF, attachmentId: 'att-0', mediaType: 'image/png' } },
      { type: 'text', text: 'after' },
    ])
  })

  it('maps a refused image batch to subagent/attachment-invalid and delivers nothing', async () => {
    const { ctx, subagents } = await bench({ [PARENT]: { status: 'idle' } })
    ctx.provide('attachments', Object.setPrototypeOf({
      saveImages: async () => {
        throw new AttachmentError('Image batch exceeds the configured image-count limit.', 'TOO_MANY_IMAGES')
      },
    }, AttachmentStore.prototype) as never)
    const delivery = promptDelivery(ctx)

    await expect(subagents.prompt({
      ...promptRequest(),
      content: [{ type: 'image' as const, mediaType: 'image/png' as const, data: 'aGk=' }],
    }, signal)).rejects.toMatchObject({
      code: 'subagent/attachment-invalid', details: { reason: 'TOO_MANY_IMAGES' },
    })
    expect(delivery).not.toHaveBeenCalled()
  })

  it('maps non-canonical base64 to subagent/attachment-invalid without touching the store', async () => {
    const { ctx, subagents } = await bench({ [PARENT]: { status: 'idle' } })
    const saveImages = vi.fn()
    ctx.provide('attachments', Object.setPrototypeOf({ saveImages }, AttachmentStore.prototype) as never)
    const delivery = promptDelivery(ctx)

    await expect(subagents.prompt({
      ...promptRequest(),
      content: [{ type: 'image' as const, mediaType: 'image/png' as const, data: 'not base64!' }],
    }, signal)).rejects.toMatchObject({
      code: 'subagent/attachment-invalid', details: { reason: 'INVALID_IMAGE_BASE64' },
    })
    expect(saveImages).not.toHaveBeenCalled()
    expect(delivery).not.toHaveBeenCalled()
  })

  it('rejects an image prompt when no attachment store is composed', async () => {
    const { ctx, subagents } = await bench({ [PARENT]: { status: 'idle' } })
    const delivery = promptDelivery(ctx)

    await expect(subagents.prompt({
      ...promptRequest(),
      content: [{ type: 'image' as const, mediaType: 'image/png' as const, data: 'aGk=' }],
    }, signal)).rejects.toMatchObject({ code: 'gateway/internal', message: 'subagent prompt failed' })
    expect(delivery).not.toHaveBeenCalled()
  })

  it('maps a text-only child model refusal to subagent/attachment-invalid', async () => {
    const { ctx, subagents } = await bench({ [PARENT]: { status: 'idle' } })
    promptDelivery(ctx).mockRejectedValue(
      new SubagentError('Model "text-only" does not support image input.', 'MODEL_DOES_NOT_SUPPORT_IMAGES'),
    )

    await expect(subagents.prompt(promptRequest(), signal)).rejects.toMatchObject({
      code: 'subagent/attachment-invalid', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
    })
  })

  it('delivers the content under the caller-minted identity and canonical browser zone', async () => {
    const { ctx, subagents } = await bench({ [PARENT]: { status: 'idle' } })
    const delivery = promptDelivery(ctx).mockResolvedValue('m-1' as MessageId)

    await expect(subagents.prompt(promptRequest('Asia/Shanghai'), signal))
      .resolves.toEqual({ messageId: 'm-1' })
    expect(delivery).toHaveBeenCalledWith(
      CHILD,
      [{ type: 'text', text: 'continue' }],
      { source: { kind: 'user', rpcId: REQUEST_ID, clientTimeZone: 'Asia/Shanghai' }, signal, delivery: 'queue' },
    )
  })

  it('records a non-owner caller on the follow-up source and nothing for the owner', async () => {
    const { ctx } = await bench({ [PARENT]: { status: 'idle' } })
    const delivery = promptDelivery(ctx).mockResolvedValue('m-guest' as MessageId)
    const as = (principal: Principal) => ctx.extend({
      invocation: {
        request: { namespace: 'subagents', method: 'prompt', args: {} },
        service: 'subagents',
        peer: { id: 'subagent-peer' as PeerId, ctx, principal, interactions: 'answer', signal, dispose: async () => {} },
        signal,
        uplink: <In>(): AsyncIterable<In> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
      } satisfies RemoteInvocation,
    }).subagents

    await expect(as(GUEST).prompt(promptRequest(), signal)).resolves.toEqual({ messageId: 'm-guest' })
    await expect(as({ kind: 'owner' }).prompt(promptRequest(), signal)).resolves.toEqual({ messageId: 'm-guest' })
    expect(delivery.mock.calls.map(call => call[2].source)).toEqual([
      { kind: 'user', rpcId: REQUEST_ID, principal: GUEST },
      { kind: 'user', rpcId: REQUEST_ID },
    ])
  })

  it('passes steer delivery through the same admission operation', async () => {
    const { ctx, subagents } = await bench({ [PARENT]: { status: 'running' } })
    const delivery = promptDelivery(ctx).mockResolvedValue('m-steer' as MessageId)

    await expect(subagents.prompt(promptRequest(undefined, 'steer'), signal))
      .resolves.toEqual({ messageId: 'm-steer' })
    expect(delivery.mock.calls[0]?.[2].delivery).toBe('steer')
  })

  it('omits the zone from the durable source when the browser reported none', async () => {
    const { ctx, subagents } = await bench({ [PARENT]: { status: 'idle' } })
    const delivery = promptDelivery(ctx).mockResolvedValue('m-2' as MessageId)

    await expect(subagents.prompt(promptRequest(), signal)).resolves.toEqual({ messageId: 'm-2' })
    expect(delivery.mock.calls[0]?.[2].source).toEqual({ kind: 'user', rpcId: REQUEST_ID })
  })

  it('accepts UTC and rejects an empty, untrimmed, malformed, or unknown zone', async () => {
    const { ctx, subagents } = await bench({ [PARENT]: { status: 'idle' } })
    promptDelivery(ctx).mockResolvedValue('m-3' as MessageId)

    await expect(subagents.prompt(promptRequest('UTC'), signal)).resolves.toEqual({ messageId: 'm-3' })
    for (const zone of ['', ' UTC', 'Shanghai', 'Nowhere/Nowhere']) {
      await expect(subagents.prompt(promptRequest(zone), signal)).rejects.toMatchObject({
        code: 'subagent/invalid-time-zone', details: { value: zone },
      })
    }
  })

  it('passes the target id without requiring a creator Agent', async () => {
    const { ctx, subagents } = await bench({})
    const delivery = promptDelivery(ctx).mockResolvedValue('m-offline-creator' as MessageId)
    await expect(subagents.prompt(promptRequest(), signal)).resolves.toEqual({ messageId: 'm-offline-creator' })
    expect(delivery.mock.calls[0]?.[0]).toBe(CHILD)
  })

  it('maps each admission failure onto its stable code and hides the rest', async () => {
    const { ctx, subagents } = await bench({ [PARENT]: { status: 'idle' } })
    const delivery = promptDelivery(ctx)
    const cases: readonly [SubagentErrorCode, string][] = [
      ['NOT_RESUMABLE', 'subagent/not-resumable'],
      ['UNAUTHORIZED', 'subagent/unauthorized'],
      ['DRAINING', 'subagent/delivery-unavailable'],
      ['ACTIVATION_CLOSING', 'subagent/delivery-unavailable'],
      ['ACTIVATION_LIMIT_REACHED', 'subagent/delivery-unavailable'],
      ['NO_PROVIDER', 'gateway/internal'],
    ]
    for (const [thrown, code] of cases) {
      delivery.mockRejectedValue(new SubagentError('refused', thrown))
      await expect(subagents.prompt(promptRequest(), signal))
        .rejects.toMatchObject({ code })
    }

    delivery.mockRejectedValue(new Error('inbox exploded'))
    await expect(subagents.prompt(promptRequest(), signal))
      .rejects.toMatchObject({ code: 'gateway/internal', message: 'subagent prompt failed' })
  })

  it('answers a caller-cancelled delivery as cancelled rather than a failure', async () => {
    const { ctx, subagents } = await bench({ [PARENT]: { status: 'idle' } })
    const aborted = new AbortController()
    promptDelivery(ctx).mockImplementation(() => {
      aborted.abort()
      return Promise.reject(new SubagentError('gone', 'NOT_RESUMABLE'))
    })

    await expect(subagents.prompt(promptRequest(), aborted.signal))
      .rejects.toMatchObject({ code: 'gateway/cancelled' })
  })

  it('preserves a cancellation reported by the continuation operation', async () => {
    const { ctx, subagents } = await bench({ [PARENT]: { status: 'idle' } })
    promptDelivery(ctx)
      .mockRejectedValue(new SubagentError('stopped', 'CANCELLED'))

    await expect(subagents.prompt(promptRequest(), signal))
      .rejects.toMatchObject({ code: 'gateway/cancelled' })
  })
})

describe('subagent interrupt Remote', () => {
  it('rejects an empty child id before interrupting', async () => {
    const { subagents } = await bench()
    const interrupt = vi.spyOn(subagents, 'interrupt')
    expect(() => subagents.interruptByUser(brandString<SessionId>('')))
      .toThrow(expect.objectContaining(emptyIdFailure('subagent.interrupt', 'childSessionId')))
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('admits a target-only user interrupt and acknowledges it', async () => {
    const { subagents } = await bench()
    const interrupt = vi.spyOn(subagents, 'interrupt').mockReturnValue()
    expect(subagents.interruptByUser(CHILD)).toEqual({ accepted: true })
    expect(interrupt).toHaveBeenCalledWith(CHILD, { kind: 'user' })
  })

  it('reports an interrupt failure as internal', async () => {
    const { subagents } = await bench()
    vi.spyOn(subagents, 'interrupt').mockImplementation(() => { throw new Error('boom') })
    expect(() => subagents.interruptByUser(CHILD)).toThrow(
      expect.objectContaining({ code: 'gateway/internal', message: 'subagent interrupt failed: Error: boom', details: {} }),
    )
  })
})

describe('subagent model selection Remote', () => {
  const request = { childSessionId: CHILD, provider: 'mock', model: 'chosen' }

  it.each(['childSessionId', 'provider', 'model', 'reasoningEffort'] as const)(
    'rejects an empty %s before changing the child', async (field) => {
      const { ctx, subagents } = await bench({})
      const select = vi.spyOn(subagentManager(ctx), 'selectModel')
      await expect(subagents.selectModelByUser({ ...request, [field]: '' }, signal))
        .rejects.toMatchObject(emptyIdFailure('subagent.selectModel', field))
      expect(select).not.toHaveBeenCalled()
    },
  )

  it.each([undefined, 'high'])('passes a complete user choice with effort %s through the host service', async (reasoningEffort) => {
    const { ctx, subagents } = await bench({})
    const selection = {
      provider: request.provider, model: request.model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort: brandString<ReasoningEffortId>(reasoningEffort) },
    }
    const select = vi.spyOn(subagentManager(ctx), 'selectModel').mockResolvedValue(selection)

    await expect(subagents.selectModelByUser({
      ...request,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    }, signal))
      .resolves.toEqual({ selected: selection })
    expect(select).toHaveBeenCalledWith(CHILD, selection, { kind: 'user' }, signal)
  })

  it.each([
    ['an unlisted model', { ...request, model: 'unlisted' }],
    ['an unregistered provider', { ...request, provider: 'missing' }],
  ])('refuses %s before changing the child', async (_case, unlisted) => {
    const { ctx, subagents } = await bench({})
    const select = vi.spyOn(subagentManager(ctx), 'selectModel')
    await expect(subagents.selectModelByUser(unlisted, signal)).rejects.toMatchObject({
      code: 'subagent/model-unavailable', details: { childSessionId: CHILD },
      message: 'the selected subagent model is unavailable; choose another model or retry',
    })
    expect(select).not.toHaveBeenCalled()
  })

  it('refuses a user choice when no LLM registry can read the catalog', async () => {
    const { ctx, subagents } = await bench({}, null)
    const select = vi.spyOn(subagentManager(ctx), 'selectModel')
    await expect(subagents.selectModelByUser(request, signal)).rejects.toMatchObject({
      code: 'subagent/model-unavailable', details: { childSessionId: CHILD },
    })
    expect(select).not.toHaveBeenCalled()
  })

  it('maps unavailable runtime services to an actionable refusal', async () => {
    const { subagents } = await bench()
    await expect(subagents.selectModel(CHILD, request, { kind: 'user' }, signal))
      .rejects.toMatchObject({ code: 'CONTINUATION_UNAVAILABLE' })
    await expect(subagents.selectModelByUser(request, signal))
      .rejects.toMatchObject({ code: 'subagent/model-selection-unavailable' })
  })

  it('keeps actionable selection failures distinct and hides backend details', async () => {
    const { ctx, subagents } = await bench({})
    const select = vi.spyOn(subagentManager(ctx), 'selectModel')
    const cases: readonly [SubagentErrorCode, string][] = [
      ['MODEL_UNAVAILABLE', 'subagent/model-unavailable'],
      ['UNAUTHORIZED', 'subagent/unauthorized'],
      ['NOT_RESUMABLE', 'subagent/not-resumable'],
      ['UNSUPPORTED_CAPABILITY', 'subagent/not-resumable'],
      ['NOT_CONTINUABLE', 'subagent/not-resumable'],
      ['DRAINING', 'subagent/model-selection-unavailable'],
      ['ACTIVATION_CLOSING', 'subagent/model-selection-unavailable'],
      ['CONTINUATION_UNAVAILABLE', 'subagent/model-selection-unavailable'],
      ['PERSISTENCE_UNAVAILABLE', 'subagent/model-selection-unavailable'],
    ]
    for (const [thrown, code] of cases) {
      select.mockRejectedValue(new SubagentError('private provider detail', thrown))
      await expect(subagents.selectModelByUser(request, signal))
        .rejects.toMatchObject({ code, details: { childSessionId: CHILD } })
    }
    for (const error of [new SubagentError('private provider detail', 'NO_PROVIDER'), new Error('private provider detail')]) {
      select.mockRejectedValue(error)
      await expect(subagents.selectModelByUser(request, signal)).rejects.toMatchObject({
        code: 'gateway/internal', message: 'subagent model selection failed', details: {},
      })
    }
  })

  it('reports the LLM validation reason for a rejected route', async () => {
    const { ctx, subagents } = await bench({})
    const failure = new LlmError('provider "mock" model "chosen" does not support reasoning effort "max"', 'UNSUPPORTED_REASONING_EFFORT')
    vi.spyOn(subagentManager(ctx), 'selectModel').mockRejectedValue(failure)
    await expect(subagents.selectModelByUser(request, signal)).rejects.toMatchObject({
      code: 'subagent/model-unavailable', message: failure.message, details: { childSessionId: CHILD }, cause: failure,
    })
  })

  it('preserves operation cancellation and caller cancellation before recording', async () => {
    const { ctx, subagents } = await bench({})
    const select = vi.spyOn(subagentManager(ctx), 'selectModel')
    select.mockRejectedValue(new SubagentError('stopped', 'CANCELLED'))
    await expect(subagents.selectModelByUser(request, signal)).rejects.toMatchObject({ code: 'gateway/cancelled' })

    select.mockRejectedValue(new Error('aborted operation'))
    await expect(subagents.selectModelByUser(request, AbortSignal.abort()))
      .rejects.toMatchObject({ code: 'gateway/cancelled' })
  })

  it.each([false, true])('reports an uncertain durable outcome even when cancellation is %s', async (cancelled) => {
    const { ctx, subagents } = await bench({})
    vi.spyOn(subagentManager(ctx), 'selectModel')
      .mockRejectedValue(new SubagentError('private provider detail', 'PERSISTENCE_UNCONFIRMED'))
    await expect(subagents.selectModelByUser(request, cancelled ? AbortSignal.abort() : signal)).rejects.toMatchObject({
      code: 'subagent/model-selection-unconfirmed', details: { childSessionId: CHILD },
      message: 'the child model choice may have changed, but persistence is unconfirmed; reload its state before retrying',
    })
  })
})
