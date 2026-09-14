import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import LlmRuntime, { ToolCallId, createUserMessage,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  userAgent,
} from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { getOrCreateAnonymousUserId, type AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { SessionId } from '@deepseek-ai/dsh-session'
import DeepSeekLlmApiExtensionRegistry from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import type { PreparedDeepSeekLlmApiExtensions } from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { httpErrorCode } from '../src/protocols/chat-completions/adapter.ts'
import { resolveRequestImageTarget } from '../src/common/request-pricing.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'
import type { Behavior } from './mock-server.ts'

const TEST_USER_ID = '00000000-0000-4000-8000-000000000001' as AnonymousUserId
let testHome: string

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'dsh-llm-deepseek-'))
  vi.stubEnv('DSH_HOME', testHome)
})

afterEach(async () => {
  await closeMockServers()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  rmSync(testHome, { recursive: true, force: true })
})

async function harness(baseURL: string, config: object = {}) {
  // Configuration carries only the reference; the key comes from the
  // environment, which is the whole credential plane without a mounted seam.
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(DeepSeekLlmApiExtensionRegistry)
  await ctx.plugin(LlmDeepSeek, { protocol: 'chat-completions', baseURL, ...config })
  return ctx
}

/** Direct adapter over the plugin's real resolve step, with a static key. */
function noExtensions(): Promise<PreparedDeepSeekLlmApiExtensions> {
  return Promise.resolve({ fields: {}, accept: () => Promise.resolve() })
}

/** Direct adapter over the plugin's real resolve step, with a static key. */
function adapterOf(
  config: Partial<LlmDeepSeek.Config> & { apiKey?: string } = {},
  attachments?: AttachmentStore,
  files?: LlmDeepSeek.DeepSeekFileStore,
): DeepSeekAdapter {
  const { apiKey, ...rest } = config
  return new DeepSeekAdapter({
    options: () => resolveAdapterOptions({ protocol: 'chat-completions', ...rest }),
    resolveApiKey: () => Promise.resolve(apiKey ?? 'k'),
    resolveUserId: () => TEST_USER_ID,
    resolveAttachments: () => attachments,
    ...files === undefined ? {} : { resolveFiles: () => files },
    prepareExtensions: noExtensions,
  })
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) { /* drain */ }
}

const imageRef: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
}

function requestImage(ref = imageRef): RequestImageAttachment {
  return {
    variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`),
    attachment: ref,
    data: Uint8Array.of(1, 2, 3),
    mediaType: 'image/png',
    bytes: 3,
    width: 1,
    height: 1,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: true,
  }
}

function attachmentStoreOf(
  project: (ref: ImageAttachmentRef, policy: unknown, signal?: AbortSignal) => Promise<RequestImageAttachment>,
): {
  store: AttachmentStore
  readImageRequest: ReturnType<typeof vi.fn<typeof project>>
} {
  const readImageRequest = vi.fn(project)
  return {
    store: { readImageRequest, imageHostPath: () => undefined } as unknown as AttachmentStore,
    readImageRequest,
  }
}

function fileStoreOf(
  implementation: (...args: Parameters<LlmDeepSeek.DeepSeekFileStore['ensureUploaded']>) => ReturnType<LlmDeepSeek.DeepSeekFileStore['ensureUploaded']>,
) {
  const ensureUploaded = vi.fn(implementation)
  const invalidate = vi.fn(() => Promise.resolve())
  return {
    store: { ensureUploaded, invalidate } as unknown as LlmDeepSeek.DeepSeekFileStore,
    ensureUploaded,
    invalidate,
  }
}

function fileReference(fileId: string): Awaited<ReturnType<LlmDeepSeek.DeepSeekFileStore['ensureUploaded']>> {
  return {
    record: { fileId: LlmDeepSeek.DeepSeekFileId(fileId) },
    uploaded: true,
  } as Awaited<ReturnType<LlmDeepSeek.DeepSeekFileStore['ensureUploaded']>>
}

function successfulSseResponse(): Response {
  return new Response(textEvents.map(event => `data: ${event}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('request image target', () => {
  it.each([
    [
      { id: 'default' },
      { width: 1302, height: 1302, maxBytes: 2 * 1024 * 1024 },
    ],
    [
      { id: 'low', imagePixelBudget: 'low' as const },
      { width: 512, height: 512, maxBytes: 2 * 1024 * 1024 },
    ],
    [
      { id: 'custom', imagePixelBudget: 320_000, imageMaxBytes: 512_000 },
      { width: 565, height: 565, maxBytes: 512_000 },
    ],
  ])('resolves route-owned defaults and overrides for %s on a 4096x4096 source', (model, expected) => {
    expect(resolveRequestImageTarget(model, { width: 4096, height: 4096 })).toEqual(expected)
  })

  it('caps every request image at the provider per-side limit', () => {
    expect(resolveRequestImageTarget({ id: 'default' }, { width: 8192, height: 78 }))
      .toEqual({ width: 4096, height: 39, maxBytes: 2 * 1024 * 1024 })
    expect(resolveRequestImageTarget({ id: 'custom', imagePixelBudget: 640_000 }, { width: 10_000, height: 100 }))
      .toEqual({ width: 4096, height: 41, maxBytes: 2 * 1024 * 1024 })
  })

  it('answers image request pricing from the current connection snapshot', () => {
    const adapter = adapterOf({
      models: [{ id: 'vision', inputModalities: ['text', 'image'] }],
    })
    const priced = adapter.imageRequestPricing('deepseek-official', 'vision')?.priceImages([{ type: 'image', attachment: imageRef }])
    expect(priced).toHaveLength(1)
    expect(priced?.[0]!.visualTokens).toBeGreaterThan(0)
    const textOnly = adapter.imageRequestPricing('deepseek-official', 'unlisted')?.priceImages([{ type: 'image', attachment: imageRef }])
    expect(textOnly?.[0]!.visualTokens).toBe(0)
  })

  it('prices descriptor text through the serializer\'s access resolution', () => {
    const attachments = {} as AttachmentStore
    const adapter = new DeepSeekAdapter({
      options: () => resolveAdapterOptions({ protocol: 'chat-completions', models: [{ id: 'vision', inputModalities: ['text', 'image'] }] }),
      resolveApiKey: () => Promise.resolve('k'),
      resolveUserId: () => TEST_USER_ID,
      resolveAttachments: () => attachments,
      resolveImageAccess: (store, ref) => (store === attachments && ref === imageRef
        ? { readonlyPath: '/world/img.png' }
        : undefined),
      prepareExtensions: noExtensions,
    })
    const priced = adapter.imageRequestPricing('deepseek-official', 'vision')?.priceImages([{ type: 'image', attachment: imageRef }])
    expect(priced?.[0]?.text).toContain('/world/img.png')
  })
})

describe('DeepSeekAdapter against a mock server', () => {
  it('merges prepared extension fields and accepts them once after HTTP 2xx', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const accept = vi.fn()
    const prepareExtensions = vi.fn(async () => ({
      fields: { dsh_test: { version: 1 } },
      accept: async () => { accept() },
    }))
    const adapter = new DeepSeekAdapter({
      options: () => resolveAdapterOptions({ protocol: 'chat-completions', baseURL: server.url }),
      resolveApiKey: () => Promise.resolve('k'),
      resolveUserId: () => TEST_USER_ID,
      prepareExtensions: prepareExtensions as never,
    })

    await drain(adapter.stream({ provider: 'deepseek-official', model: 'm', messages: [], sessionId: SessionId('s') }))
    expect(server.requests[0]).toMatchObject({ dsh_test: { version: 1 } })
    expect(prepareExtensions).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's' }))
    expect(accept).toHaveBeenCalledOnce()
  })

  it('fails before fetch on extension preparation or base-field collision', async () => {
    const server = await mockServer([])
    const base = {
      options: () => resolveAdapterOptions({ protocol: 'chat-completions', baseURL: server.url }),
      resolveApiKey: () => Promise.resolve('k'),
      resolveUserId: () => TEST_USER_ID,
    }
    const failed = new DeepSeekAdapter({
      ...base,
      prepareExtensions: () => Promise.reject(new Error('metadata unavailable')),
    })
    await expect(drain(failed.stream({ provider: 'deepseek-official', model: 'm', messages: [] })))
      .rejects.toMatchObject({ code: 'REQUEST_EXTENSION' })

    const collision = new DeepSeekAdapter({
      ...base,
      prepareExtensions: (() => Promise.resolve({ fields: { model: 'replacement' }, accept: () => Promise.resolve() })) as never,
    })
    await expect(drain(collision.stream({ provider: 'deepseek-official', model: 'm', messages: [] })))
      .rejects.toMatchObject({ code: 'REQUEST_EXTENSION' })
    expect(server.requests).toHaveLength(0)
  })

  it('passes cancellation into extension preparation and aborts before fetch', async () => {
    const server = await mockServer([])
    const controller = new AbortController()
    const started = Promise.withResolvers<undefined>()
    let signalSeen: AbortSignal | undefined
    const adapter = new DeepSeekAdapter({
      options: () => resolveAdapterOptions({ protocol: 'chat-completions', baseURL: server.url }),
      resolveApiKey: () => Promise.resolve('k'),
      resolveUserId: () => TEST_USER_ID,
      prepareExtensions: ((request: { signal: AbortSignal }) => {
        signalSeen = request.signal
        started.resolve(undefined)
        if (request.signal === undefined) return new Promise(() => {})
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            const reason: unknown = request.signal.reason
            reject(reason instanceof Error ? reason : new Error('extension preparation aborted', { cause: reason }))
          }, { once: true })
        })
      }) as never,
    })

    const pending = drain(adapter.stream({
      provider: 'deepseek-official',
      model: 'm',
      messages: [],
      signal: controller.signal,
    }))
    await started.promise
    expect(signalSeen).toBeInstanceOf(AbortSignal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    expect(server.requests).toHaveLength(0)
  })

  it('passes cancellation through an outstanding fetch', async () => {
    const controller = new AbortController()
    const started = Promise.withResolvers<undefined>()
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      const signal = init?.signal
      return new Promise<Response>((_resolve, reject) => {
        started.resolve(undefined)
        signal?.addEventListener('abort', () => {
          const reason: unknown = signal.reason
          reject(reason instanceof Error ? reason : new Error('fetch aborted', { cause: reason }))
        }, { once: true })
      })
    })
    try {
      const adapter = adapterOf({ baseURL: 'https://provider.invalid' })
      const pending = drain(adapter.stream({
        provider: 'deepseek-official',
        model: 'm',
        messages: [],
        signal: controller.signal,
      }))
      await started.promise
      controller.abort()
      await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    } finally {
      fetch.mockRestore()
    }
  })

  it('does not accept extensions on non-2xx and does accept before a later stream failure', async () => {
    const server = await mockServer([
      { kind: 'http-error', status: 500, body: '{}' },
      { kind: 'close-early', events: ['{"choices":[{"delta":{"content":"partial"}}]}'] },
    ])
    const accept = vi.fn()
    const adapter = new DeepSeekAdapter({
      options: () => resolveAdapterOptions({ protocol: 'chat-completions', baseURL: server.url }),
      resolveApiKey: () => Promise.resolve('k'),
      resolveUserId: () => TEST_USER_ID,
      prepareExtensions: () => Promise.resolve({ fields: { dsh_test: 1 }, accept: async () => { accept() } }) as never,
    })
    const request = { provider: 'deepseek-official', model: 'm', messages: [] }

    await expect(drain(adapter.stream(request))).rejects.toMatchObject({ code: 'SERVER' })
    expect(accept).not.toHaveBeenCalled()
    await expect(drain(adapter.stream(request))).rejects.toBeDefined()
    expect(accept).toHaveBeenCalledOnce()
  })

  it('reports a post-2xx extension acceptance failure without relabelling it as transport', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const failure = new Error('watermark append failed')
    const adapter = new DeepSeekAdapter({
      options: () => resolveAdapterOptions({ protocol: 'chat-completions', baseURL: server.url }),
      resolveApiKey: () => Promise.resolve('k'),
      resolveUserId: () => TEST_USER_ID,
      prepareExtensions: () => Promise.resolve({
        fields: { dsh_test: 1 },
        accept: () => Promise.reject(failure),
      }) as never,
    })

    await expect(drain(adapter.stream({ provider: 'deepseek-official', model: 'm', messages: [] })))
      .rejects.toMatchObject({ code: 'REQUEST_EXTENSION', cause: failure })
    expect(server.requests).toHaveLength(1)
  })

  it('streams a text generation end to end through the assembler', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)

    const result = await assemble(ctx, {
      model: 'deepseek-v4-pro',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1, totalTokens: 4 })

    // The wire request carried the auth header contents we configured.
    expect(server.requests[0]).toMatchObject({
      model: 'deepseek-v4-pro',
      max_tokens: 256_000,
      reasoning_effort: 'high',
      stream: true,
      stream_options: { include_usage: true },
    })
    // App attribution and DeepSeek request identity are independent wire facts.
    expect(server.headers[0]?.['user-agent']).toBe(userAgent())
    expect(server.headers[0]?.['x-deepseek-harness-user-id']).toBe(getOrCreateAnonymousUserId())
    expect(server.headers[0]).not.toHaveProperty('x-deepseek-harness-session-id')
    expect(server.headers[0]).not.toHaveProperty('http-referer')
    expect(server.headers[0]).not.toHaveProperty('x-openrouter-title')
    expect(server.headers[0]).not.toHaveProperty('x-openrouter-categories')
    expect(server.headers[0]).not.toHaveProperty('x-deepseek-harness-compact')
  })

  it('uploads a durable image once and sends only its Files API id to the vision model', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const signalSeen: (AbortSignal | undefined)[] = []
    const policies: unknown[] = []
    const attachmentMocks = attachmentStoreOf((ref, policy, signal) => {
      signalSeen.push(signal)
      policies.push(policy)
      return Promise.resolve(requestImage(ref))
    })
    const adapter = adapterOf({ baseURL: server.url }, attachmentMocks.store)

    await drain(adapter.stream({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      messages: [createUserMessage({
        content: [
          { type: 'text', text: 'describe ' },
          { type: 'image', attachment: imageRef },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }))

    expect(server.requests[0]).toMatchObject({
      model: 'deepseek-flash',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe ' },
          { type: 'text', text: expect.stringContaining(`Image ${imageRef.attachmentId}; request preview 1x1px.`) as string },
          { type: 'file', file_id: 'file-api-1' },
        ],
      }],
    })
    expect(server.fileRequests).toEqual([{
      method: 'POST',
      path: '/files',
      filename: `dsh-${'a'.repeat(16)}-${'b'.repeat(8)}.png`,
      bytes: 3,
    }])
    expect(signalSeen[0]).toBeInstanceOf(AbortSignal)
    expect(policies).toEqual([{ width: 1, height: 1, maxBytes: 2 * 1024 * 1024 }])
  })

  it('falls back to one all-base64 request when Files API resolution fails', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const secondRef = { ...imageRef, attachmentId: AttachmentId(`sha256:${'c'.repeat(64)}`) }
    const attachments = attachmentStoreOf(ref => Promise.resolve({
      ...requestImage(ref),
      variantId: ImageVariantId(`sha256:${(ref.attachmentId === imageRef.attachmentId ? 'b' : 'd').repeat(64)}`),
    })).store
    const files = fileStoreOf(() => Promise.reject(new LlmError('Files unavailable', 'SERVER')))
    const adapter = adapterOf({
      baseURL: server.url,
      models: [{ id: 'deepseek-v4-flash-vision-exp', inputModalities: ['text', 'image'] }],
    }, attachments, files.store)

    await drain(adapter.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      messages: [createUserMessage({
        content: [
          { type: 'image', attachment: imageRef },
          { type: 'image', attachment: secondRef },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }))

    const body = server.requests[0] as { messages: Array<{ content: unknown }> }
    expect(JSON.stringify(body.messages[0]?.content).match(/"type":"image_url"/g)).toHaveLength(2)
    expect(JSON.stringify(body)).not.toContain('file_id')
    expect(files.ensureUploaded).toHaveBeenCalledTimes(1)
  })

  it('fails a base64 fallback whose retained images exceed the inline bound with the count to offload', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const attachments = attachmentStoreOf(ref => Promise.resolve(requestImage(ref))).store
    const files = fileStoreOf(() => Promise.reject(new LlmError('Files unavailable', 'SERVER')))
    const adapter = adapterOf({
      baseURL: server.url,
      maxInlineRequestImageBytes: 80,
      inlineImageOffloadByteQuantum: 40,
      models: [{ id: 'deepseek-v4-flash-vision-exp', inputModalities: ['text', 'image'] }],
    }, attachments, files.store)

    await expect(drain(adapter.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      messages: [createUserMessage({
        content: Array.from({ length: 21 }, () => ({ type: 'image' as const, attachment: imageRef })),
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }))).rejects.toMatchObject({ code: 'IMAGE_OFFLOAD_REQUIRED', message: expect.stringContaining('11 more') as string })
    expect(server.requests).toHaveLength(0)
  })
  it('discards partially resolved file ids and falls back with every retained image inline', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const secondRef = { ...imageRef, attachmentId: AttachmentId(`sha256:${'c'.repeat(64)}`) }
    const attachments = attachmentStoreOf(ref => Promise.resolve({
      ...requestImage(ref),
      variantId: ImageVariantId(`sha256:${(ref.attachmentId === imageRef.attachmentId ? 'b' : 'd').repeat(64)}`),
    })).store
    const files = fileStoreOf(() => Promise.reject(new Error('unused')))
    files.ensureUploaded
      .mockResolvedValueOnce(fileReference('file-api-partial'))
      .mockRejectedValueOnce(new LlmError('Files unavailable', 'TRANSPORT'))
    const adapter = adapterOf({
      baseURL: server.url,
      models: [{ id: 'deepseek-v4-flash-vision-exp', inputModalities: ['text', 'image'] }],
    }, attachments, files.store)

    await drain(adapter.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      messages: [createUserMessage({
        content: [
          { type: 'image', attachment: imageRef },
          { type: 'image', attachment: secondRef },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }))

    const body = server.requests[0] as { messages: Array<{ content: unknown }> }
    expect(JSON.stringify(body.messages[0]?.content).match(/"type":"image_url"/g)).toHaveLength(2)
    expect(JSON.stringify(body)).not.toContain('file-api-partial')
  })

  it('falls back after the configured Files API deadline without aborting chat', async () => {
    vi.useFakeTimers()
    const started = Promise.withResolvers<undefined>()
    const files = fileStoreOf((_version, _connection, _policy, signal) => new Promise((_resolve, reject) => {
      started.resolve(undefined)
      signal?.addEventListener('abort', () => {
        const reason: unknown = signal.reason
        reject(reason instanceof Error ? reason : new Error('files operation aborted'))
      }, { once: true })
    }))
    const attachments = attachmentStoreOf(ref => Promise.resolve(requestImage(ref))).store
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(successfulSseResponse())
    const adapter = adapterOf({
      baseURL: 'https://deepseek.invalid',
      filesApiTimeoutMs: 50,
      models: [{ id: 'deepseek-v4-flash-vision-exp', inputModalities: ['text', 'image'] }],
    }, attachments, files.store)

    const pending = drain(adapter.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: imageRef }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }))
    await started.promise
    await vi.advanceTimersByTimeAsync(50)
    await pending

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0]?.[1]?.body).toEqual(expect.stringContaining('image_url'))
    fetchSpy.mockRestore()
  })

  it('does not turn caller cancellation during file resolution into base64 fallback', async () => {
    const started = Promise.withResolvers<undefined>()
    const files = fileStoreOf((_version, _connection, _policy, signal) => new Promise((_resolve, reject) => {
      started.resolve(undefined)
      signal?.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
    }))
    const attachments = attachmentStoreOf(ref => Promise.resolve(requestImage(ref))).store
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const controller = new AbortController()
    const adapter = adapterOf({
      baseURL: 'https://deepseek.invalid',
      models: [{ id: 'deepseek-v4-flash-vision-exp', inputModalities: ['text', 'image'] }],
    }, attachments, files.store)

    const pending = drain(adapter.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      signal: controller.signal,
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: imageRef }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }))
    await started.promise
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('does not retry a generic chat failure through base64 fallback', async () => {
    const server = await mockServer([{
      kind: 'http-error',
      status: 503,
      body: JSON.stringify({ error: { message: 'chat unavailable' } }),
    }])
    const attachments = attachmentStoreOf(ref => Promise.resolve(requestImage(ref))).store
    const files = fileStoreOf(() => Promise.resolve(fileReference('file-api-ready')))
    const adapter = adapterOf({
      baseURL: server.url,
      models: [{ id: 'deepseek-v4-flash-vision-exp', inputModalities: ['text', 'image'] }],
    }, attachments, files.store)

    await expect(drain(adapter.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: imageRef }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }))).rejects.toMatchObject({ code: 'SERVER', message: 'chat unavailable' })

    expect(server.requests).toHaveLength(1)
    expect(JSON.stringify(server.requests[0])).toContain('file-api-ready')
    expect(JSON.stringify(server.requests[0])).not.toContain('image_url')
  })

  it('does not prepare a surface-offloaded image and sends its placeholder instead', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const old = { ...imageRef, attachmentId: AttachmentId(`sha256:${'c'.repeat(64)}`), bytes: 3 }
    const recent = { ...imageRef, attachmentId: AttachmentId(`sha256:${'d'.repeat(64)}`), bytes: 3 }
    const attachmentMocks = attachmentStoreOf((ref) => {
      if (ref.attachmentId === old.attachmentId) throw new Error('old image must not be read')
      return Promise.resolve(requestImage(ref))
    })
    const adapter = adapterOf({
      baseURL: server.url,
      models: [{ id: 'deepseek-v4-flash-vision-exp', inputModalities: ['text', 'image'] }],
    }, attachmentMocks.store)

    await drain(adapter.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      messages: [createUserMessage({
        content: [
          { type: 'image', attachment: old, offloaded: true },
          { type: 'image', attachment: recent },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }))

    expect(attachmentMocks.readImageRequest).toHaveBeenCalledWith(
      recent,
      { width: 1, height: 1, maxBytes: 2 * 1024 * 1024 },
      expect.any(AbortSignal),
    )
    const body = server.requests[0] as { messages: unknown[] }
    expect(body.messages[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: expect.stringContaining(`image omitted to fit request image limits; ${old.attachmentId}`) as string },
        { type: 'text', text: expect.stringContaining(String(recent.attachmentId)) as string },
        { type: 'file', file_id: 'file-api-1' },
      ],
    })
  })

  it('projects nested tool-result images with route-owned request budgets', async () => {
    const server = await mockServer([
      { kind: 'sse', events: textEvents },
      { kind: 'sse', events: textEvents },
    ])
    const attachmentMocks = attachmentStoreOf(ref => Promise.resolve(requestImage(ref)))
    const adapter = adapterOf({
      baseURL: server.url,
      models: [
        {
          id: 'vision-low',
          inputModalities: ['text', 'image'],
          imagePixelBudget: 'low',
          imageMaxBytes: 512_000,
        },
        {
          id: 'vision-custom',
          inputModalities: ['text', 'image'],
          imagePixelBudget: 320_000,
        },
      ],
    }, attachmentMocks.store)
    const nested = createUserMessage({
      content: [{
        type: 'tool-result',
        toolCallId: ToolCallId('image-result'),
        content: [{ type: 'image', attachment: imageRef }],
      }],
      source: { kind: 'plugin', plugin: 'test' },
    })

    await drain(adapter.stream({ provider: 'deepseek-official', model: 'vision-low', messages: [nested] }))
    await drain(adapter.stream({ provider: 'deepseek-official', model: 'vision-custom', messages: [nested] }))

    expect(attachmentMocks.readImageRequest).toHaveBeenNthCalledWith(
      1,
      imageRef,
      { width: 1, height: 1, maxBytes: 512_000 },
      expect.any(AbortSignal),
    )
    expect(attachmentMocks.readImageRequest).toHaveBeenNthCalledWith(
      2,
      imageRef,
      { width: 1, height: 1, maxBytes: 2 * 1024 * 1024 },
      expect.any(AbortSignal),
    )
  })

  it('reuses the exact request version between agent and compaction calls', async () => {
    const server = await mockServer([
      { kind: 'sse', events: textEvents },
      { kind: 'sse', events: textEvents },
    ])
    const attachments = attachmentStoreOf(ref => Promise.resolve(requestImage(ref))).store
    const adapter = adapterOf({
      baseURL: server.url,
      models: [{ id: 'deepseek-v4-flash-vision-exp', inputModalities: ['text', 'image'] }],
    }, attachments)
    const messages = [createUserMessage({
      content: [{ type: 'image' as const, attachment: imageRef }],
      source: { kind: 'plugin' as const, plugin: 'test' },
    })]

    await drain(adapter.stream({ provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp', messages }))
    await drain(adapter.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      messages,
      purpose: 'compaction',
    }))

    expect(server.fileRequests.filter(request => request.method === 'POST')).toHaveLength(1)
    expect(server.requests).toMatchObject([
      { messages: [{ content: [expect.objectContaining({ type: 'text' }), { file_id: 'file-api-1' }] }] },
      { messages: [{ content: [expect.objectContaining({ type: 'text' }), { file_id: 'file-api-1' }] }] },
    ])
    expect(server.headers[1]?.['x-deepseek-harness-compact']).toBe('1')
  })

  it('explains a provider rejection of a normalized image and retains the raw response as cause', async () => {
    const raw = JSON.stringify({ error: { message: 'unsupported image payload for file-api-1' } })
    const server = await mockServer([{ kind: 'http-error', status: 400, body: raw }])
    const attachments = attachmentStoreOf(ref => Promise.resolve(requestImage(ref))).store
    const adapter = adapterOf({
      baseURL: server.url,
      models: [{ id: 'deepseek-v4-flash-vision-exp', inputModalities: ['text', 'image'] }],
    }, attachments)

    let failure: unknown
    try {
      await drain(adapter.stream({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash-vision-exp',
        messages: [createUserMessage({
          content: [{ type: 'image', attachment: imageRef }],
          source: { kind: 'plugin', plugin: 'test' },
        })],
      }))
    } catch (error: unknown) {
      failure = error
    }
    expect(failure).toMatchObject({
      code: 'INVALID_REQUEST',
      message: expect.stringContaining(
        `normalized image "${imageRef.attachmentId}" at message 1, image 1`,
      ) as string,
      cause: { message: raw },
    })
    expect((failure as Error).message).toContain('image/png, 8-bit sRGBA, 1x1')
    expect((failure as Error).message).toContain('unsupported image payload for file-api-1')
    expect((failure as Error).message).not.toBe(raw)
  })

  it('identifies the sole image when a normalized rejection omits its file id', async () => {
    const raw = JSON.stringify({ error: { message: 'unsupported image payload' } })
    const server = await mockServer([{ kind: 'http-error', status: 400, body: raw }])
    const attachments = attachmentStoreOf(ref => Promise.resolve(requestImage(ref))).store
    const adapter = adapterOf({
      baseURL: server.url,
      models: [{ id: 'deepseek-v4-flash-vision-exp', inputModalities: ['text', 'image'] }],
    }, attachments)

    await expect(drain(adapter.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: imageRef }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }))).rejects.toMatchObject({
      message: expect.stringContaining(`normalized image "${imageRef.attachmentId}"`) as string,
    })
  })

  it('lists every candidate when a normalized multi-image rejection names no file id', async () => {
    const secondRef: ImageAttachmentRef = {
      ...imageRef,
      attachmentId: AttachmentId(`sha256:${'c'.repeat(64)}`),
    }
    const raw = JSON.stringify({ error: { message: 'unsupported image payload' } })
    const server = await mockServer([{ kind: 'http-error', status: 400, body: raw }])
    const attachments = attachmentStoreOf((ref) => {
      const first = ref.attachmentId === imageRef.attachmentId
      return Promise.resolve({
        ...requestImage(ref),
        variantId: ImageVariantId(`sha256:${(first ? 'b' : 'd').repeat(64)}`),
        attachment: first ? { ...ref, name: 'diagram.png' } : ref,
        hasAlpha: false,
      })
    }).store
    const adapter = adapterOf({
      baseURL: server.url,
      models: [{ id: 'deepseek-v4-flash-vision-exp', inputModalities: ['text', 'image'] }],
    }, attachments)

    await expect(drain(adapter.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      messages: [createUserMessage({
        content: [
          { type: 'image', attachment: imageRef },
          { type: 'image', attachment: secondRef },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }))).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: expect.stringContaining('Candidate images: "diagram.png"') as string,
      cause: { message: raw },
    })
  })

  it.each([
    'file-api-1 expired',
    'file_id file-api-10 invalid; file_id file-api-1 expired',
    'file_id file-api-1 expired',
    'file_not_found',
    'file_id file-api-1 deleted',
    'invalid file_id file-api-1',
  ])('reuploads once when chat rejects a Files API reference as %s', async (providerMessage) => {
    const server = await mockServer([
      {
        kind: 'http-error',
        status: 400,
        body: JSON.stringify({ error: { message: providerMessage } }),
      },
      { kind: 'sse', events: textEvents },
    ])
    const attachmentMocks = attachmentStoreOf(ref => Promise.resolve(requestImage(ref)))
    const adapter = adapterOf({
      baseURL: server.url,
      models: [{ id: 'deepseek-v4-flash-vision-exp', inputModalities: ['text', 'image'] }],
    }, attachmentMocks.store)
    const options = {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      messages: [createUserMessage({
        content: [{ type: 'image' as const, attachment: imageRef }],
        source: { kind: 'plugin' as const, plugin: 'test' },
      })],
    }

    await drain(adapter.stream(options))

    expect(server.fileRequests.filter(request => request.method === 'POST')).toHaveLength(2)
    expect(server.requests).toMatchObject([
      { messages: [{ content: [expect.objectContaining({ type: 'text' }), { file_id: 'file-api-1' }] }] },
      { messages: [{ content: [expect.objectContaining({ type: 'text' }), { file_id: 'file-api-2' }] }] },
    ])
    expect(attachmentMocks.readImageRequest).toHaveBeenCalledTimes(1)
  })

  it('uses inline fallback when stale-id recovery cannot resolve a replacement file', async () => {
    const server = await mockServer([
      {
        kind: 'http-error',
        status: 400,
        body: JSON.stringify({ error: { message: 'file_id file-api-stale expired' } }),
      },
      { kind: 'sse', events: textEvents },
    ])
    const attachments = attachmentStoreOf(ref => Promise.resolve(requestImage(ref))).store
    const files = fileStoreOf(() => Promise.reject(new Error('unused')))
    files.ensureUploaded
      .mockResolvedValueOnce(fileReference('file-api-stale'))
      .mockRejectedValueOnce(new LlmError('Files unavailable', 'SERVER'))
    const adapter = adapterOf({
      baseURL: server.url,
      models: [{ id: 'deepseek-v4-flash-vision-exp', inputModalities: ['text', 'image'] }],
    }, attachments, files.store)

    await drain(adapter.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: imageRef }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }))

    expect(files.invalidate).toHaveBeenCalledTimes(1)
    expect(server.requests).toHaveLength(2)
    expect(JSON.stringify(server.requests[0])).toContain('file-api-stale')
    expect(JSON.stringify(server.requests[1])).toContain('image_url')
  })

  it('invalidates only the identified mapping when a multi-image request names one stale file id', async () => {
    const secondRef: ImageAttachmentRef = {
      ...imageRef,
      attachmentId: AttachmentId(`sha256:${'c'.repeat(64)}`),
    }
    const server = await mockServer([
      {
        kind: 'http-error',
        status: 400,
        body: JSON.stringify({ error: { message: 'file_id file-api-2 expired' } }),
      },
      { kind: 'sse', events: textEvents },
    ])
    const attachments = attachmentStoreOf(ref => Promise.resolve({
      ...requestImage(ref),
      variantId: ImageVariantId(`sha256:${(ref.attachmentId === imageRef.attachmentId ? 'b' : 'd').repeat(64)}`),
    })).store
    const adapter = adapterOf({
      baseURL: server.url,
      models: [{ id: 'deepseek-v4-flash-vision-exp', inputModalities: ['text', 'image'] }],
    }, attachments)

    await drain(adapter.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      messages: [createUserMessage({
        content: [
          { type: 'image', attachment: imageRef },
          { type: 'image', attachment: secondRef },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }))

    expect(server.fileRequests.filter(request => request.method === 'POST')).toHaveLength(3)
    const retries = server.requests as Array<{ messages: Array<{ content: Array<{ type: string; file_id?: string }> }> }>
    expect(retries[0]?.messages[0]?.content.filter(block => block.type === 'file'))
      .toEqual([{ type: 'file', file_id: 'file-api-1' }, { type: 'file', file_id: 'file-api-2' }])
    expect(retries[1]?.messages[0]?.content.filter(block => block.type === 'file'))
      .toEqual([{ type: 'file', file_id: 'file-api-1' }, { type: 'file', file_id: 'file-api-3' }])
  })

  it('invalidates every listed missing file id and preserves unlisted mappings', async () => {
    const secondRef: ImageAttachmentRef = {
      ...imageRef,
      attachmentId: AttachmentId(`sha256:${'c'.repeat(64)}`),
    }
    const thirdRef: ImageAttachmentRef = {
      ...imageRef,
      attachmentId: AttachmentId(`sha256:${'e'.repeat(64)}`),
    }
    const server = await mockServer([
      {
        kind: 'http-error',
        status: 400,
        body: JSON.stringify({
          error: {
            message: 'path.to.object[index]: the following file_ids do not exist or are not created under your account: '
              + 'file-api-1, file-api-3, file-api-unknown',
          },
        }),
      },
      { kind: 'sse', events: textEvents },
    ])
    const attachments = attachmentStoreOf((ref) => {
      let digest = 'f'
      if (ref.attachmentId === imageRef.attachmentId) digest = 'b'
      else if (ref.attachmentId === secondRef.attachmentId) digest = 'd'
      return Promise.resolve({
        ...requestImage(ref),
        variantId: ImageVariantId(`sha256:${digest.repeat(64)}`),
      })
    }).store
    const adapter = adapterOf({
      baseURL: server.url,
      models: [{ id: 'deepseek-v4-flash-vision-exp', inputModalities: ['text', 'image'] }],
    }, attachments)

    await drain(adapter.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      messages: [createUserMessage({
        content: [
          { type: 'image', attachment: imageRef },
          { type: 'image', attachment: secondRef },
          { type: 'image', attachment: thirdRef },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }))

    expect(server.fileRequests.filter(request => request.method === 'POST')).toHaveLength(5)
    const retries = server.requests as Array<{ messages: Array<{ content: Array<{ type: string; file_id?: string }> }> }>
    expect(retries[0]?.messages[0]?.content.filter(block => block.type === 'file'))
      .toEqual([
        { type: 'file', file_id: 'file-api-1' },
        { type: 'file', file_id: 'file-api-2' },
        { type: 'file', file_id: 'file-api-3' },
      ])
    expect(retries[1]?.messages[0]?.content.filter(block => block.type === 'file'))
      .toEqual([
        { type: 'file', file_id: 'file-api-4' },
        { type: 'file', file_id: 'file-api-2' },
        { type: 'file', file_id: 'file-api-5' },
      ])
  })

  it('invalidates every used mapping when a stale-file response does not identify one file id', async () => {
    const secondRef: ImageAttachmentRef = {
      ...imageRef,
      attachmentId: AttachmentId(`sha256:${'c'.repeat(64)}`),
    }
    const server = await mockServer([
      {
        kind: 'http-error',
        status: 400,
        body: JSON.stringify({ error: { message: 'file reference expired' } }),
      },
      { kind: 'sse', events: textEvents },
    ])
    const attachments = attachmentStoreOf(ref => Promise.resolve({
      ...requestImage(ref),
      variantId: ImageVariantId(`sha256:${(ref.attachmentId === imageRef.attachmentId ? 'b' : 'd').repeat(64)}`),
    })).store
    const adapter = adapterOf({
      baseURL: server.url,
      models: [{ id: 'deepseek-v4-flash-vision-exp', inputModalities: ['text', 'image'] }],
    }, attachments)

    await drain(adapter.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      messages: [createUserMessage({
        content: [
          { type: 'image', attachment: imageRef },
          { type: 'image', attachment: secondRef },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }))

    expect(server.fileRequests.filter(request => request.method === 'POST')).toHaveLength(4)
    const retries = server.requests as Array<{ messages: Array<{ content: Array<{ type: string; file_id?: string }> }> }>
    expect(retries[1]?.messages[0]?.content.filter(block => block.type === 'file'))
      .toEqual([{ type: 'file', file_id: 'file-api-3' }, { type: 'file', file_id: 'file-api-4' }])
  })

  it('returns the second stale-file rejection without a third chat attempt', async () => {
    const stale = JSON.stringify({ error: { message: 'file_id file-api-1 expired' } })
    const server = await mockServer([
      { kind: 'http-error', status: 400, body: stale },
      { kind: 'http-error', status: 400, body: stale },
    ])
    const attachments = attachmentStoreOf(ref => Promise.resolve(requestImage(ref))).store
    const adapter = adapterOf({
      baseURL: server.url,
      models: [{ id: 'deepseek-v4-flash-vision-exp', inputModalities: ['text', 'image'] }],
    }, attachments)

    await expect(drain(adapter.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: imageRef }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }))).rejects.toMatchObject({ code: 'INVALID_REQUEST', message: 'file_id file-api-1 expired' })
    expect(server.requests).toHaveLength(2)
    expect(server.fileRequests.filter(request => request.method === 'POST')).toHaveLength(2)
  })

  it.each(['deepseek-v4-flash', 'unlisted-pass-through'])(
    'rejects image input for text-only model %s before credentials, attachments, or fetch',
    async (model) => {
      const server = await mockServer([])
      const resolveApiKey = vi.fn(() => Promise.resolve('k'))
      const resolveAttachments = vi.fn(() => ({}) as AttachmentStore)
      const adapter = new DeepSeekAdapter({
        options: () => resolveAdapterOptions({ protocol: 'chat-completions', baseURL: server.url }),
        resolveApiKey,
        resolveUserId: () => TEST_USER_ID,
        resolveAttachments,
        prepareExtensions: noExtensions,
      })

      await expect(drain(adapter.stream({
        provider: 'deepseek-official',
        model,
        messages: [createUserMessage({
          content: [{ type: 'image', attachment: imageRef }],
          source: { kind: 'plugin', plugin: 'test' },
        })],
      }))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
      expect(resolveApiKey).not.toHaveBeenCalled()
      expect(resolveAttachments).not.toHaveBeenCalled()
      expect(server.requests).toHaveLength(0)
    },
  )

  it('rejects vision input without an attachment provider before credentials or fetch', async () => {
    const server = await mockServer([])
    const resolveApiKey = vi.fn(() => Promise.resolve('k'))
    const adapter = new DeepSeekAdapter({
      options: () => resolveAdapterOptions({
        protocol: 'chat-completions',
        baseURL: server.url,
        models: [{ id: 'deepseek-v4-flash-vision-exp', inputModalities: ['text', 'image'] }],
      }),
      resolveApiKey,
      resolveUserId: () => TEST_USER_ID,
      prepareExtensions: noExtensions,
    })

    await expect(drain(adapter.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: imageRef }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    expect(resolveApiKey).not.toHaveBeenCalled()
    expect(server.requests).toHaveLength(0)
  })

  it('streams raw chunks through ctx.llm.stream', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents, delayMs: 2 }])
    const ctx = await harness(server.url)

    const kinds: string[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })) {
      kinds.push(chunk.type)
    }
    expect(kinds).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  })

  it('forwards the harness user and session ids for host-side trajectory routing', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)

    await assemble(ctx, {
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
      sessionId: SessionId('child-session'),
    })

    expect(server.headers[0]?.['x-deepseek-harness-session-id']).toBe('child-session')
    expect(server.headers[0]?.['x-deepseek-harness-user-id']).toBe(getOrCreateAnonymousUserId())
  })

  it('marks the auxiliary compaction call on the wire', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)

    await assemble(ctx, {
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
      purpose: 'compaction',
    })

    expect(server.headers[0]?.['x-deepseek-harness-compact']).toBe('1')
  })

  it('switches dynamically from the configured low default through off to max', async () => {
    const server = await mockServer([
      { kind: 'sse', events: textEvents },
      { kind: 'sse', events: textEvents },
      { kind: 'sse', events: textEvents },
    ])
    const ctx = await harness(server.url, { thinking: 'enabled', reasoningEffort: 'low' })

    await assemble(ctx,{
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    await assemble(ctx,{
      model: 'deepseek-v4-flash',
      reasoningEffort: ReasoningEffortId('off'),
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi again' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    await assemble(ctx,{
      model: 'deepseek-v4-flash',
      reasoningEffort: ReasoningEffortId('max'),
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'one more time' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(server.requests[0]).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'low',
    })
    expect(server.requests[1]).toMatchObject({
      thinking: { type: 'disabled' },
    })
    expect(server.requests[1]).not.toHaveProperty('reasoning_effort')
    expect(server.requests[2]).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    })
  })

  it('uses the configured maxTokens default and preserves an explicit request cap', async () => {
    const server = await mockServer([
      { kind: 'sse', events: textEvents },
      { kind: 'sse', events: textEvents },
    ])
    const ctx = await harness(server.url, { maxTokens: 32_000 })

    await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    await assemble(ctx, { model: 'deepseek-v4-flash', messages: [], maxTokens: 8_192 })

    expect(server.requests[0]).toMatchObject({ max_tokens: 32_000 })
    expect(server.requests[1]).toMatchObject({ max_tokens: 8_192 })
  })

  it('publishes only off and omits the wire effort when thinking is disabled', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url, { thinking: 'disabled' })

    await assemble(ctx,{
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(server.requests[0]).toMatchObject({
      thinking: { type: 'disabled' },
    })
    expect(server.requests[0]).not.toHaveProperty('reasoning_effort')
    await expect(ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-v4-flash'))
      .resolves.toMatchObject({
        reasoning: {
          efforts: [{
            id: ReasoningEffortId('off'),
            name: 'Off',
            description: 'Use for simple tasks that do not need reasoning.',
          }],
          defaultEffort: ReasoningEffortId('off'),
        },
      })
  })

  it('reports a per-request effort failure before I/O when thinking is disabled', async () => {
    const server = await mockServer([])
    const ctx = await harness(server.url, { thinking: 'disabled' })

    const result = await assemble(ctx, {
      model: 'deepseek-v4-flash',
      reasoningEffort: ReasoningEffortId('high'),
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { code: 'UNSUPPORTED_REASONING_EFFORT' },
    })
    expect(server.requests).toHaveLength(0)
  })

  it.each(['high', 'max'])(
    'rejects direct adapter effort %s before I/O when thinking is disabled',
    async (effort) => {
      const server = await mockServer([])
      const adapter = adapterOf({ apiKey: 'test-key', baseURL: server.url, thinking: 'disabled' })

      const stream = adapter.stream({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: ReasoningEffortId(effort),
        messages: [createUserMessage({
          content: [{ type: 'text', text: 'hi' }],
          source: { kind: 'plugin', plugin: 'test' },
        })],
      })
      await expect(async () => {
        for await (const _chunk of stream) { /* drain */ }
      }).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
      expect(server.requests).toHaveLength(0)
    },
  )

  it.each([
    [401, 'AUTH'],
    [403, 'AUTH'],
    [429, 'RATE_LIMIT'],
    [400, 'INVALID_REQUEST'],
    [500, 'SERVER'],
    [503, 'SERVER'],
  ])('maps HTTP %d to failure code %s with the body message', async (status, code) => {
    const behavior: Behavior = {
      kind: 'http-error',
      status,
      body: JSON.stringify({ error: { message: `failed with ${status}`, type: 't', code: 'c' } }),
    }
    const server = await mockServer([behavior])
    const ctx = await harness(server.url)
    const result = await assemble(ctx,{ model: 'deepseek-v4-flash', messages: [] })
    expect(result.finish).toEqual({
      kind: 'error',
      failure: { message: `failed with ${status}`, code, status },
    })
  })

  it('uses the HTTP status as the cause when an error response has no body', async () => {
    const server = await mockServer([{ kind: 'http-error', status: 500, body: '' }])
    const adapter = adapterOf({ baseURL: server.url })

    await expect(drain(adapter.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      messages: [],
    }))).rejects.toMatchObject({
      code: 'SERVER',
      cause: { message: 'DeepSeek HTTP 500' },
    })
  })

  it('classifies an HTTP context-window failure with the canonical code', async () => {
    const server = await mockServer([{
      kind: 'http-error',
      status: 400,
      body: JSON.stringify({
        error: {
          message: 'This model maximum context length is 128000 tokens; your input exceeds that limit.',
          type: 'invalid_request_error',
          code: 'context_length_exceeded',
        },
      }),
    }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE },
    })
  })

  it('retains status, Retry-After seconds, and provider request id as structured facts', async () => {
    const server = await mockServer([{
      kind: 'http-error',
      status: 429,
      body: JSON.stringify({ error: { message: 'slow down' } }),
      headers: { 'retry-after': '2', 'x-request-id': 'req-429' },
    }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(result.finish).toEqual({
      kind: 'error',
      failure: {
        message: 'slow down',
        code: 'RATE_LIMIT',
        status: 429,
        providerRetryAfterMs: 2_000,
        requestId: ProviderRequestId('req-429'),
      },
    })
  })

  it('parses a future Retry-After HTTP date and the DeepSeek request-id fallback', async () => {
    const now = 1_800_000_000_000
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const server = await mockServer([{
        kind: 'http-error',
        status: 503,
        body: JSON.stringify({ error: { message: 'come back later' } }),
        headers: {
          'retry-after': new Date(now + 3_000).toUTCString(),
          'x-deepseek-request-id': 'deepseek-503',
        },
      }])
      const ctx = await harness(server.url)
      const result = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
      expect(result.finish).toEqual({
        kind: 'error',
        failure: {
          message: 'come back later',
          code: 'SERVER',
          status: 503,
          providerRetryAfterMs: 3_000,
          requestId: ProviderRequestId('deepseek-503'),
        },
      })
    } finally {
      dateNow.mockRestore()
    }
  })

  it('omits zero, non-finite, invalid, and past Retry-After values', async () => {
    const values = [
      '0',
      '9'.repeat(400),
      'not-a-date',
      new Date(0).toUTCString(),
    ]
    for (const value of values) {
      const server = await mockServer([{
        kind: 'http-error',
        status: 429,
        body: JSON.stringify({ error: { message: 'retry later' } }),
        headers: { 'retry-after': value },
      }])
      const ctx = await harness(server.url)
      const result = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
      expect(result.finish).toEqual({
        kind: 'error',
        failure: { message: 'retry later', code: 'RATE_LIMIT', status: 429 },
      })
    }
  })

  it('classifies only context-capacity HTTP 400 details as context overflow', () => {
    expect(httpErrorCode(400, { message: 'request too large for model context' }))
      .toBe(CONTEXT_WINDOW_EXCEEDED_CODE)
    expect(httpErrorCode(400, { message: 'invalid input: temperature exceeds maximum allowed value' }))
      .toBe('INVALID_REQUEST')
    expect(httpErrorCode(413, { code: 'context_length_exceeded' })).toBe('INVALID_REQUEST')
  })

  it('distinguishes terminal quota exhaustion from transient HTTP 429 throttling', () => {
    expect(httpErrorCode(429, { code: 'insufficient_quota', message: 'account credits exhausted' }))
      .toBe(QUOTA_EXCEEDED_CODE)
    expect(httpErrorCode(429, { message: 'request rate limit exceeded' })).toBe('RATE_LIMIT')
  })

  it('keeps the status-line message for JSON error bodies without a message', async () => {
    const server = await mockServer([{ kind: 'http-error', status: 500, body: '{"error":{"type":"x"}}' }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx,{ model: 'deepseek-v4-flash', messages: [] })
    expect(result.finish.kind).toBe('error')
    if (result.finish.kind !== 'error') throw new Error('expected an error finish')
    expect(result.finish.failure.code).toBe('SERVER')
    expect(result.finish.failure.message).toMatch(/HTTP 500/)
  })

  it('keeps the status-line message for non-JSON error bodies', async () => {
    const server = await mockServer([{ kind: 'http-error', status: 502, body: 'Bad Gateway', contentType: 'text/plain' }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx,{ model: 'deepseek-v4-flash', messages: [] })
    expect(result.finish.kind).toBe('error')
    if (result.finish.kind !== 'error') throw new Error('expected an error finish')
    expect(result.finish.failure.code).toBe('SERVER')
    expect(result.finish.failure.message).toMatch(/HTTP 502/)
  })

  it('maps unusual statuses to HTTP_<status>', () => {
    expect(httpErrorCode(418)).toBe('HTTP_418')
  })

  it('reports a transport failure with the endpoint in the message', async () => {
    // Port 1 is reserved/unbound, so the service normalizes the fetch failure.
    const ctx = await harness('http://127.0.0.1:1')
    const result = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: {
        code: 'TRANSPORT',
        message: 'DeepSeek API request to http://127.0.0.1:1 failed',
      },
    })
  })

  it('classifies an aborted request as an aborted finish', async () => {
    const controller = new AbortController()
    controller.abort()
    const ctx = await harness('http://127.0.0.1:1')
    const result = await assemble(ctx, {
      model: 'deepseek-v4-flash',
      messages: [],
      signal: controller.signal,
    })
    expect(result.finish).toMatchObject({ kind: 'aborted', failure: { code: 'ABORTED' } })
  })

  it('throws EMPTY_RESPONSE when the response has no body', async () => {
    const adapter = adapterOf({ baseURL: 'http://127.0.0.1:1' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    )
    try {
      const iterate = async (): Promise<void> => {
        for await (const _chunk of adapter.stream({ provider: 'deepseek-official', model: 'm', messages: [] })) { /* drain */ }
      }
      await expect(iterate()).rejects.toThrow(/no response body/)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('classifies an abrupt body close as TRANSPORT', async () => {
    const server = await mockServer([{
      kind: 'close-early',
      events: ['{"choices":[{"delta":{"content":"par"}}]}'],
    }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx,{ model: 'deepseek-v4-flash', messages: [] })
    expect(result.finish.kind).toBe('error')
    if (result.finish.kind !== 'error') throw new Error('expected an error finish')
    expect(result.finish.failure.code).toBe('TRANSPORT')
    expect(result.finish.failure.message).toMatch(/^DeepSeek API stream from .* failed$/)
  })

  it('aborts mid-stream via the request signal', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents, delayMs: 50 }])
    const ctx = await harness(server.url)
    const controller = new AbortController()

    const pending = (async () => {
      const chunks = []
      for await (const chunk of ctx.llm.stream({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        messages: [],
        signal: controller.signal,
      })) {
        chunks.push(chunk)
      }
      return chunks
    })()

    setTimeout(() => { controller.abort() }, 30)
    const chunks = await pending
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.type).toBe('finish')
    if (chunks[0]?.type !== 'finish') throw new Error('expected a finish chunk')
    expect(chunks[0].reason.kind).toBe('aborted')
    if (chunks[0].reason.kind !== 'aborted') throw new Error('expected an aborted finish')
    expect(chunks[0].reason.failure.code).toBe('ABORTED')
  })

  it('maps connection failures to TRANSPORT without losing the cause', async () => {
    const cause = new TypeError('connection refused')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(cause)
    const adapter = adapterOf({ baseURL: 'https://example.invalid' })
    try {
      const drain = async (): Promise<void> => {
        for await (const _chunk of adapter.stream({ provider: 'deepseek-official', model: 'm', messages: [] })) { /* drain */ }
      }
      await expect(drain()).rejects.toMatchObject({ code: 'TRANSPORT', cause })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('renders a non-Error transport rejection without losing its cause', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const failed = Promise.withResolvers<Response>()
      failed.reject('offline')
      return failed.promise
    })
    const adapter = adapterOf({ baseURL: 'https://example.invalid' })
    try {
      const drain = async (): Promise<void> => {
        for await (const _chunk of adapter.stream({ provider: 'deepseek-official', model: 'm', messages: [] })) { /* drain */ }
      }
      await expect(drain()).rejects.toMatchObject({
        message: 'DeepSeek API request to https://example.invalid failed',
        code: 'TRANSPORT',
        cause: 'offline',
      })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('aborts the underlying body when the stream stays idle past its watchdog', async () => {
    vi.useFakeTimers()
    let stopped = false
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      const signal = init?.signal
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => {
            stopped = true
            controller.error(signal.reason)
          }, { once: true })
        },
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    })
    const adapter = adapterOf({
      baseURL: 'https://example.invalid',
      streamIdleTimeoutMs: 100,
    })
    try {
      const drain = (async () => {
        for await (const _chunk of adapter.stream({ provider: 'deepseek-official', model: 'm', messages: [] })) { /* drain */ }
      })()
      const rejected = expect(drain).rejects.toMatchObject({ code: 'TIMEOUT' })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(100)
      await rejected
      expect(stopped).toBe(true)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('keeps an idle provider read alive through SSE comments', async () => {
    vi.useFakeTimers()
    const encoder = new TextEncoder()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => { controller.enqueue(encoder.encode(': keep-alive\n\n')) }, 75)
          setTimeout(() => { controller.enqueue(encoder.encode(': keep-alive\n\n')) }, 150)
          setTimeout(() => {
            controller.enqueue(encoder.encode(textEvents.map(event => `data: ${event}\n\n`).join('')))
            controller.close()
          }, 225)
        },
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    })
    const adapter = adapterOf({
      baseURL: 'https://example.invalid',
      streamIdleTimeoutMs: 100,
    })
    try {
      const chunks: string[] = []
      const drain = (async () => {
        for await (const chunk of adapter.stream({ provider: 'deepseek-official', model: 'm', messages: [] })) {
          chunks.push(chunk.type)
        }
      })()
      await vi.advanceTimersByTimeAsync(75)
      await vi.advanceTimersByTimeAsync(75)
      await vi.advanceTimersByTimeAsync(75)
      await expect(drain).resolves.toBeUndefined()
      expect(chunks).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('plugin registration and config', () => {
  it('defaults to Messages and resolves the selected protocol endpoint without rewriting overrides', () => {
    expect(resolveAdapterOptions({})).toMatchObject({ protocol: 'messages', baseURL: 'https://api.deepseek.com/anthropic' })
    expect(resolveAdapterOptions({ protocol: 'chat-completions' })).toMatchObject({ protocol: 'chat-completions', baseURL: 'https://api.deepseek.com' })
    expect(resolveAdapterOptions({ protocol: 'messages' })).toMatchObject({ protocol: 'messages', baseURL: 'https://api.deepseek.com/anthropic' })
    for (const baseURL of ['https://gateway.example/custom/v1', 'https://gateway.example/v1/messages']) {
      expect(resolveAdapterOptions({ protocol: 'messages', baseURL }).baseURL).toBe(baseURL)
    }
    expect(() => resolveAdapterOptions({ protocol: 'responses' } as unknown as LlmDeepSeek.Config)).toThrow(/protocol/)
  })

  it('keeps wire helpers off the package root', () => {
    for (const helper of [
      'httpErrorCode',
      'serializeMessages',
      'serializeRequest',
      'DONE',
      'parseSse',
      'mapFinishReason',
      'mapUsage',
      'translate',
    ]) expect(LlmDeepSeek).not.toHaveProperty(helper)
  })

  it('registers the deepseek provider and unregisters on dispose (HMR safety)', async () => {
    const server = await mockServer([])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const fiber = await ctx.plugin(LlmDeepSeek, {
      protocol: 'chat-completions',
      baseURL: server.url,
    })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'deepseek-official', name: 'DeepSeek' }])
    expect(ctx.llm.listConfigurableProviders()).toEqual([{
      provider: 'deepseek-official',
      displayName: 'DeepSeek',
      settingsNs: 'llm-deepseek',
      settingsPath: [],
    }])
    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })

  it('registers retryPolicy from the provider config', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmDeepSeek, {
      protocol: 'chat-completions',
      baseURL: 'http://127.0.0.1:1',
      retryPolicy: {
        mode: 'always',
        backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 },
      },
    })

    expect(ctx.llm.providerRetryPolicy('deepseek-official')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })
  })

  it('owns the deepseek provider and advertises the default models', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmDeepSeek, { protocol: 'chat-completions', baseURL: 'http://127.0.0.1:1' })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'deepseek-official', name: 'DeepSeek' }])
    await expect(ctx.llm.listModels('deepseek-official')).resolves.toEqual([
      { provider: 'deepseek-official', id: 'deepseek-flash', name: 'DeepSeek-V41-Flash', inputModalities: ['text', 'image'] },
      {
        provider: 'deepseek-official',
        id: 'deepseek-v4-flash',
        name: 'DeepSeek-V4-Flash',
        description: 'Fast, efficient, and economical; suited to focused, routine, or parallel tasks.',
        inputModalities: ['text'],
      },
      {
        provider: 'deepseek-official',
        id: 'deepseek-v4-pro',
        name: 'DeepSeek-V4-Pro',
        description: 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
        inputModalities: ['text'],
      },
      { provider: 'deepseek-official', id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek-V4-Flash-Vision-Exp', inputModalities: ['text', 'image'] },
    ])
    await expect(ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-flash'))
      .resolves.toMatchObject({
        provider: 'deepseek-official',
        id: 'deepseek-flash',
        name: 'DeepSeek-V41-Flash',
        inputModalities: ['text', 'image'],
        systemPromptUpdate: 'in-history',
        context: { contextWindow: 1_000_000 },
        defaultMaxTokens: 256_000,
        reasoning: {
          efforts: [
            { id: ReasoningEffortId('off'), name: 'Off', description: 'Use for simple tasks that do not need reasoning.' },
            { id: ReasoningEffortId('low'), name: 'Low', description: 'Prefer for routine or latency-sensitive tasks.' },
            { id: ReasoningEffortId('high'), name: 'High', description: 'The default balance for most tasks.' },
            { id: ReasoningEffortId('max'), name: 'Max', description: 'Reserve for the hardest quality-first tasks.' },
          ],
          defaultEffort: ReasoningEffortId('high'),
        },
      })
  })

  it.each([
    { model: 'deepseek-v4-flash', inputModalities: ['text'] },
    { model: 'deepseek-v4-pro', inputModalities: ['text'] },
    { model: 'deepseek-v4-flash-vision-exp', inputModalities: ['text', 'image'] },
  ])('keeps $model available with its V4 capabilities', async ({ model, inputModalities }) => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmDeepSeek, { protocol: 'chat-completions', baseURL: 'http://127.0.0.1:1' })
    const info = await ctx.llm.resolveModelInfo('deepseek-official', model)
    expect(info).toMatchObject({
      id: model,
      inputModalities,
      context: { contextWindow: 1_000_000 },
      defaultMaxTokens: 256_000,
    })
    expect(info?.systemPromptUpdate).toBeUndefined()
  })

  it.each(['off', 'low', 'max'] as const)('uses the configured %s reasoning default', async (effort) => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmDeepSeek, {
      protocol: 'chat-completions',
      baseURL: 'http://127.0.0.1:1',
      reasoningEffort: effort,
    })
    await expect(ctx.llm.resolveModelInfo('deepseek-official', 'unlisted-pass-through'))
      .resolves.toMatchObject({
        reasoning: {
          efforts: [
            { id: ReasoningEffortId('off'), name: 'Off', description: 'Use for simple tasks that do not need reasoning.' },
            { id: ReasoningEffortId('low'), name: 'Low', description: 'Prefer for routine or latency-sensitive tasks.' },
            { id: ReasoningEffortId('high'), name: 'High', description: 'The default balance for most tasks.' },
            { id: ReasoningEffortId('max'), name: 'Max', description: 'Reserve for the hardest quality-first tasks.' },
          ],
          defaultEffort: ReasoningEffortId(effort),
        },
      })
  })

  it('accepts off as the default when thinking is deployment-disabled', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmDeepSeek, {
      protocol: 'chat-completions',
      baseURL: 'http://127.0.0.1:1',
      thinking: 'disabled',
      reasoningEffort: 'off',
    })
    await expect(ctx.llm.resolveModelInfo('deepseek-official', 'unlisted-pass-through'))
      .resolves.toMatchObject({
        reasoning: {
          efforts: [{
            id: ReasoningEffortId('off'),
            name: 'Off',
            description: 'Use for simple tasks that do not need reasoning.',
          }],
          defaultEffort: ReasoningEffortId('off'),
        },
      })
  })

  it.each(['low', 'high', 'max'] as const)(
    'rejects configured reasoning effort %s when thinking is disabled',
    async (reasoningEffort) => {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await expect(ctx.plugin(LlmDeepSeek, {
        protocol: 'chat-completions',
        baseURL: 'http://127.0.0.1:1',
        thinking: 'disabled',
        reasoningEffort,
      })).rejects.toThrow(/only reasoningEffort "off"/)
      expect(ctx.llm.listProviders()).toEqual([])
    },
  )

  it.each(['low', 'high', 'max'] as const)(
    'rejects disabled-thinking effort %s at the resolver boundary',
    (reasoningEffort) => {
      expect(() => resolveAdapterOptions({ thinking: 'disabled', reasoningEffort }))
        .toThrow(/only reasoningEffort "off"/)
    },
  )

  it('accepts disabled thinking with off at the resolver boundary', async () => {
    const adapter = adapterOf({ thinking: 'disabled', reasoningEffort: 'off' })
    await expect(adapter.resolveModel('deepseek-official', 'pass-through')).resolves.toMatchObject({
      reasoning: {
        efforts: [{
          id: ReasoningEffortId('off'),
          name: 'Off',
          description: 'Use for simple tasks that do not need reasoning.',
        }],
        defaultEffort: ReasoningEffortId('off'),
      },
    })
  })

  it('uses the default model catalog when apply is called directly', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    LlmDeepSeek.apply(ctx, { baseURL: 'http://127.0.0.1:1' })
    await expect(ctx.llm.listModels('deepseek-official')).resolves.toEqual([
      { provider: 'deepseek-official', id: 'deepseek-flash', name: 'DeepSeek-V41-Flash', inputModalities: ['text', 'image'] },
      {
        provider: 'deepseek-official',
        id: 'deepseek-v4-flash',
        name: 'DeepSeek-V4-Flash',
        description: 'Fast, efficient, and economical; suited to focused, routine, or parallel tasks.',
        inputModalities: ['text'],
      },
      {
        provider: 'deepseek-official',
        id: 'deepseek-v4-pro',
        name: 'DeepSeek-V4-Pro',
        description: 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
        inputModalities: ['text'],
      },
      { provider: 'deepseek-official', id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek-V4-Flash-Vision-Exp', inputModalities: ['text', 'image'] },
    ])
  })

  it('defaults an adapter-supplied catalog entry to text input', async () => {
    const connection = resolveAdapterOptions({ models: [] })
    const adapter = new DeepSeekAdapter({
      options: () => ({ ...connection, models: [{ id: 'adapter-model' }] }),
      resolveApiKey: () => Promise.resolve('k'),
      resolveUserId: () => TEST_USER_ID,
      prepareExtensions: noExtensions,
    })
    await expect(adapter.listModels('deepseek-official')).resolves.toEqual([{
      provider: 'deepseek-official',
      id: 'adapter-model',
      name: 'adapter-model',
      inputModalities: ['text'],
    }])
  })

  it('advertises configured models without restricting arbitrary request ids', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmDeepSeek, {
      protocol: 'chat-completions',
      baseURL: 'http://127.0.0.1:1',
      models: [
        { id: 'private-fast', contextWindow: 32_000 },
        {
          id: 'private-reasoner',
          name: 'Private Reasoner',
          description: 'Higher reasoning budget',
          contextWindow: 64_000,
          inputModalities: ['text', 'image'],
        },
      ],
    })
    await expect(ctx.llm.listModels('deepseek-official')).resolves.toEqual([
      { provider: 'deepseek-official', id: 'private-fast', name: 'private-fast', inputModalities: ['text'] },
      { provider: 'deepseek-official', id: 'private-reasoner', name: 'Private Reasoner', description: 'Higher reasoning budget', inputModalities: ['text', 'image'] },
    ])
    await expect(ctx.llm.resolveModelInfo('deepseek-official', 'private-fast'))
      .resolves.toMatchObject({ context: { contextWindow: 32_000 } })
    await expect(ctx.llm.resolveModelInfo('deepseek-official', 'private-reasoner'))
      .resolves.toMatchObject({
        name: 'Private Reasoner',
        description: 'Higher reasoning budget',
        inputModalities: ['text', 'image'],
      })
    await expect(ctx.llm.resolveModelInfo('deepseek-official', 'arbitrary-unlisted'))
      .resolves.toMatchObject({
        context: { contextWindow: 1_000_000 },
        defaultMaxTokens: 256_000,
      })
  })

  it('uses exact model capacity before the adapter-wide default', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmDeepSeek, {
      protocol: 'chat-completions',
      baseURL: 'http://127.0.0.1:1',
      defaultContextWindow: 256_000,
      models: [
        { id: 'inherits-default' },
        { id: 'exact-override', contextWindow: 64_000 },
      ],
    })

    await expect(ctx.llm.resolveModelInfo('deepseek-official', 'inherits-default'))
      .resolves.toMatchObject({ context: { contextWindow: 256_000 } })
    await expect(ctx.llm.resolveModelInfo('deepseek-official', 'exact-override'))
      .resolves.toMatchObject({ context: { contextWindow: 64_000 } })
    await expect(ctx.llm.resolveModelInfo('deepseek-official', 'unlisted-pass-through'))
      .resolves.toMatchObject({ context: { contextWindow: 256_000 } })
  })

  it('allows an explicit empty model catalog', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmDeepSeek, {
      protocol: 'chat-completions',
      baseURL: 'http://127.0.0.1:1',
      models: [],
    })
    await expect(ctx.llm.listModels('deepseek-official')).resolves.toEqual([])
  })

  const invalidModels: Array<[LlmDeepSeek.DeepSeekCatalogModel[], RegExp]> = [
    [[{ id: '' }], /ids must be non-empty/],
    [[{ id: 'm', name: '' }], /empty name/],
    [[{ id: 'm', contextWindow: 0 }], /contextWindow/],
    [[{ id: 'm', contextWindow: 1.5 }], /contextWindow/],
    [[{ id: 'm', inputModalities: [] }], /inputModalities/],
    [[{ id: 'm', inputModalities: ['text', 'text'] }], /inputModalities must not contain duplicates/],
    [[{
      id: 'm',
      inputModalities: ['audio'] as unknown as NonNullable<LlmDeepSeek.DeepSeekCatalogModel['inputModalities']>,
    }], /expected "text" \| "image"/],
    [[{ id: 'm' }, { id: 'm' }], /duplicate catalog model/],
  ]

  it.each(invalidModels)('rejects invalid advisory model config', async (models, message) => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(LlmDeepSeek, {
      protocol: 'chat-completions',
      baseURL: 'http://127.0.0.1:1',
      models: [...models],
    })).rejects.toThrow(message)
    expect(ctx.llm.listProviders()).toEqual([])
  })

  const invalidProgrammaticModalities: Array<[LlmDeepSeek.DeepSeekCatalogModel[], RegExp]> = [
    [[{ id: 'm', inputModalities: [] }], /inputModalities must not be empty/],
    [[{
      id: 'm',
      inputModalities: ['audio'] as unknown as NonNullable<LlmDeepSeek.DeepSeekCatalogModel['inputModalities']>,
    }], /inputModalities must contain only "text" and "image"/],
  ]

  it.each(invalidProgrammaticModalities)('rejects programmatic modality config that bypasses the schema', (models, message) => {
    expect(() => resolveAdapterOptions({ models: [...models] })).toThrow(message)
  })

  it('rejects the removed imageDetail model setting through schema and direct construction', async () => {
    const legacyModel = { id: 'vision', inputModalities: ['image'], imageDetail: 'low' } as unknown as
      LlmDeepSeek.DeepSeekCatalogModel
    expect(() => resolveAdapterOptions({ models: [legacyModel] })).toThrow(/imageDetail is no longer supported/)

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(LlmDeepSeek, {
      protocol: 'chat-completions',
      baseURL: 'http://127.0.0.1:1',
      models: [legacyModel],
    })).rejects.toThrow(/imageDetail is no longer supported/)
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it.each([0, 1.5])('rejects a per-model output cap of %s', (maxTokens) => {
    expect(() => resolveAdapterOptions({ models: [{ id: 'bad-cap', maxTokens }] }))
      .toThrow(/maxTokens must be a positive integer/)
  })

  it('surfaces a catalog model\'s in-history system prompt update mode and rejects any other mode', async () => {
    const adapter = adapterOf({ models: [
      { id: 'capable', systemPromptUpdate: 'in-history' },
      { id: 'plain' },
    ] })
    await expect(adapter.resolveModel('deepseek-official', 'capable'))
      .resolves.toMatchObject({ systemPromptUpdate: 'in-history' })
    await expect(adapter.resolveModel('deepseek-official', 'plain'))
      .resolves.not.toHaveProperty('systemPromptUpdate')
    await expect(adapter.resolveModel('deepseek-official', 'not-in-catalog'))
      .resolves.not.toHaveProperty('systemPromptUpdate')
    expect(() => resolveAdapterOptions({
      models: [{ id: 'bogus', systemPromptUpdate: 'leading' as unknown as 'in-history' }],
    })).toThrow(/systemPromptUpdate must be "in-history" when present/)
  })

  it('rejects image request limits on a text-only catalog model', () => {
    expect(() => resolveAdapterOptions({
      models: [{ id: 'text-only', inputModalities: ['text'], imagePixelBudget: 1 }],
    })).toThrow(/text-only catalog model .* cannot declare image request limits/)
  })

  it.each([
    ['imagePixelBudget', 0, /imagePixelBudget must be "low" or a positive safe integer/],
    ['imagePixelBudget', Number.MAX_SAFE_INTEGER + 1, /imagePixelBudget must be "low" or a positive safe integer/],
    ['imagePixelBudget', 'auto', /imagePixelBudget must be "low" or a positive safe integer/],
    ['imageMaxBytes', 0, /imageMaxBytes must be a positive safe integer/],
    ['imageMaxBytes', 1.5, /imageMaxBytes must be a positive safe integer/],
  ] as const)('rejects per-model %s=%s', (field, value, message) => {
    expect(() => resolveAdapterOptions({
      models: [{ id: 'vision', inputModalities: ['image'], [field]: value }],
    })).toThrow(message)
  })

  it('prefers a model\'s own output cap over the profile default', async () => {
    // The profile default stays what an unlisted or uncapped model resolves
    // to, so adding a per-model cap changes one model rather than the route.
    const adapter = adapterOf({ maxTokens: 4096, models: [
      { id: 'capped', maxTokens: 512 },
      { id: 'uncapped' },
    ] })
    await expect(adapter.resolveModel('deepseek-official', 'capped'))
      .resolves.toMatchObject({ defaultMaxTokens: 512 })
    await expect(adapter.resolveModel('deepseek-official', 'uncapped'))
      .resolves.toMatchObject({ defaultMaxTokens: 4096 })
    await expect(adapter.resolveModel('deepseek-official', 'not-in-catalog'))
      .resolves.toMatchObject({ defaultMaxTokens: 4096 })
  })

  it('rejects invalid context capacity when apply is called directly', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    expect(() => {
      LlmDeepSeek.apply(ctx, {
        baseURL: 'http://127.0.0.1:1',
        models: [{ id: 'invalid-context', contextWindow: 0 }],
      })
    }).toThrow(/contextWindow must be a positive integer/)
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it.each([0, 1.5])(
    'rejects invalid adapter-wide default context capacity %s',
    async (defaultContextWindow) => {
      expect(() => resolveAdapterOptions({ defaultContextWindow }))
        .toThrow(/defaultContextWindow must be a positive integer/)

      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await expect(ctx.plugin(LlmDeepSeek, {
        protocol: 'chat-completions',
        baseURL: 'http://127.0.0.1:1',
        defaultContextWindow,
      })).rejects.toThrow(/defaultContextWindow/)
      expect(ctx.llm.listProviders()).toEqual([])
    },
  )

  it.each([0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid adapter-wide maxTokens %s',
    async (maxTokens) => {
      expect(() => resolveAdapterOptions({ maxTokens }))
        .toThrow(/maxTokens must be a positive safe integer/)

      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await expect(ctx.plugin(LlmDeepSeek, {
        protocol: 'chat-completions',
        baseURL: 'http://127.0.0.1:1',
        maxTokens,
      })).rejects.toThrow(/maxTokens/)
      expect(ctx.llm.listProviders()).toEqual([])
    },
  )

  it('rejects offload quanta larger than their request bounds', () => {
    expect(() => resolveAdapterOptions({
      maxRequestFilesBytes: 10,
      imageOffloadByteQuantum: 11,
    })).toThrow(/imageOffloadByteQuantum must not exceed maxRequestFilesBytes/)
    expect(() => resolveAdapterOptions({
      maxInlineRequestImageBytes: 10,
      inlineImageOffloadByteQuantum: 11,
    })).toThrow(/inlineImageOffloadByteQuantum must not exceed maxInlineRequestImageBytes/)
    expect(() => resolveAdapterOptions({
      maxImagesPerRequest: 10,
      imageOffloadCountQuantum: 11,
    })).toThrow(/imageOffloadCountQuantum must not exceed maxImagesPerRequest/)
  })

  it.each([
    ['maxImagesPerRequest', 0, /maxImagesPerRequest must be a positive safe integer/],
    ['maxImagesPerRequest', 1.5, /maxImagesPerRequest must be a positive safe integer/],
    ['imageOffloadByteQuantum', 0, /imageOffloadByteQuantum must be a positive safe integer/],
    ['imageOffloadByteQuantum', Number.MAX_SAFE_INTEGER + 1, /imageOffloadByteQuantum must be a positive safe integer/],
    ['inlineImageOffloadByteQuantum', 0, /inlineImageOffloadByteQuantum must be a positive safe integer/],
    ['inlineImageOffloadByteQuantum', Number.MAX_SAFE_INTEGER + 1, /inlineImageOffloadByteQuantum must be a positive safe integer/],
    ['imageOffloadCountQuantum', 0, /imageOffloadCountQuantum must be a positive safe integer/],
    ['imageOffloadCountQuantum', 1.5, /imageOffloadCountQuantum must be a positive safe integer/],
    ['fileExpiresAfterSeconds', 3_599, /fileExpiresAfterSeconds must be an integer from 3600 through 2592000/],
    ['fileExpiresAfterSeconds', 2_592_001, /fileExpiresAfterSeconds must be an integer from 3600 through 2592000/],
    ['fileRefreshMarginSeconds', -1, /fileRefreshMarginSeconds must be a non-negative integer/],
    ['fileRefreshMarginSeconds', 604_800, /fileRefreshMarginSeconds must be a non-negative integer/],
    ['fileQuotaCleanupBatch', 0, /fileQuotaCleanupBatch must be an integer from 1 through 1000/],
    ['fileQuotaCleanupBatch', 1_001, /fileQuotaCleanupBatch must be an integer from 1 through 1000/],
  ] as const)('rejects %s=%s', (field, value, message) => {
    expect(() => resolveAdapterOptions({ [field]: value })).toThrow(message)
  })

  it.each([0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid request file bound %s',
    async (maxRequestFilesBytes) => {
      expect(() => resolveAdapterOptions({ maxRequestFilesBytes }))
        .toThrow(/maxRequestFilesBytes must be a positive safe integer/)

      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await expect(ctx.plugin(LlmDeepSeek, {
        protocol: 'chat-completions',
        baseURL: 'http://127.0.0.1:1',
        maxRequestFilesBytes,
      })).rejects.toThrow(/maxRequestFilesBytes/)
      expect(ctx.llm.listProviders()).toEqual([])
    },
  )

  it.each([0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid inline request image bound %s',
    async (maxInlineRequestImageBytes) => {
      expect(() => resolveAdapterOptions({ maxInlineRequestImageBytes }))
        .toThrow(/maxInlineRequestImageBytes must be a positive safe integer/)

      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await expect(ctx.plugin(LlmDeepSeek, {
        protocol: 'chat-completions',
        baseURL: 'http://127.0.0.1:1',
        maxInlineRequestImageBytes,
      })).rejects.toThrow(/maxInlineRequestImageBytes/)
      expect(ctx.llm.listProviders()).toEqual([])
    },
  )

  it('falls back to DEEPSEEK_API_KEY and DEEPSEEK_BASE_URL env vars', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'env-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', 'http://127.0.0.1:1')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmDeepSeek, { protocol: 'chat-completions' })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'deepseek-official', name: 'DeepSeek' }])
  })

  it('loads keyless, keeps the catalog browsable, and fails the request actionably', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmDeepSeek, { protocol: 'chat-completions', baseURL: 'http://127.0.0.1:1' })
    // First-boot onboarding: the route registers so models stay discoverable;
    // only the request itself needs a key.
    expect(ctx.llm.listProviders()).toEqual([{ id: 'deepseek-official', name: 'DeepSeek' }])
    await expect(ctx.llm.listModels('deepseek-official')).resolves.toHaveLength(4)
    const first = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(first.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    // The guidance leads with the managed credential store.
    const second = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(second.finish.kind).toBe('error')
    if (second.finish.kind !== 'error') throw new Error('expected an error finish')
    // The guidance names both places a credential can come from, and nothing
    // else: configuration carries the reference, never a literal key.
    expect(second.finish.failure.message)
      .toMatch(/store DEEPSEEK_API_KEY through the credentials service.*export DEEPSEEK_API_KEY/s)
  })

  it('reads the ambient variable when no credentials seam is mounted', async () => {
    // The plain cordis.yml composition: no credential provider, the key in
    // the launching environment.
    vi.stubEnv('DEEPSEEK_API_KEY', 'ambient-key')
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmDeepSeek, { protocol: 'chat-completions', baseURL: server.url })
    await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(server.headers[0]?.authorization).toBe('Bearer ambient-key')
  })

  it('treats an empty ambient variable as no key when no credentials seam is mounted', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmDeepSeek, { protocol: 'chat-completions', baseURL: 'http://127.0.0.1:1' })
    const result = await assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
  })

  it('prefers explicit config over env for key and base URL', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'env-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', 'http://env-host:1')
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url) // harness passes explicit config
    await assemble(ctx,{ model: 'deepseek-v4-flash', messages: [] })
    expect(server.requests).toHaveLength(1) // hit the explicit URL, not env
  })

  it('uses DEEPSEEK_BASE_URL when config omits baseURL', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    vi.stubEnv('DEEPSEEK_BASE_URL', server.url)
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmDeepSeek, { protocol: 'chat-completions' })
    await assemble(ctx,{ model: 'deepseek-v4-flash', messages: [] })
    expect(server.requests).toHaveLength(1)
  })


  it('takes DEEPSEEK_BASE_URL from any environment layer, with explicit config still on top', () => {
    const trusted = createLaunchEnvironmentSnapshot([
      { source: 'user-env', path: '/home/.dsh/.env', values: { DEEPSEEK_BASE_URL: 'https://user.example' } },
    ])
    expect(resolveAdapterOptions({}, trusted).baseURL).toBe('https://user.example')
    // The product trusts the project it is launched in, so a checkout can
    // point its own agent at the gateway that checkout is meant to use.
    const project = createLaunchEnvironmentSnapshot([
      { source: 'project-env', path: '/work/.env', values: { DEEPSEEK_BASE_URL: 'https://project.example' } },
    ])
    expect(resolveAdapterOptions({}, project).baseURL).toBe('https://project.example')
    // An explicitly configured endpoint outranks every environment layer, so a
    // stale shell value cannot rewrite a deployment's own gateway.
    const shell = createLaunchEnvironmentSnapshot([
      { source: 'process', values: { DEEPSEEK_BASE_URL: 'https://stale.example' } },
    ])
    expect(resolveAdapterOptions({ baseURL: 'https://gateway.internal' }, shell).baseURL).toBe('https://gateway.internal')
  })
  it('uses the public Chat base URL when selected without an endpoint override', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'k')
    vi.stubEnv('DEEPSEEK_BASE_URL', undefined)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    // Registration succeeds; no call is made (would hit api.deepseek.com).
    await ctx.plugin(LlmDeepSeek, { protocol: 'chat-completions' })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'deepseek-official', name: 'DeepSeek' }])
  })

  it('adapter is constructible directly for embedding over the shared resolver', async () => {
    const adapter = adapterOf()
    expect(adapter).toBeInstanceOf(DeepSeekAdapter)
    // Direct embedding shares the plugin's one resolve step, so it advertises
    // the same default catalog instead of a divergent empty one.
    await expect(adapter.listModels('deepseek-official')).resolves.toHaveLength(4)
  })

  it('resolves connection facts and the credential exactly once per stream call', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const options = vi.fn(() => resolveAdapterOptions({ protocol: 'chat-completions', baseURL: server.url }))
    const resolveApiKey = vi.fn(() => Promise.resolve('per-request-key'))
    const resolveUserId = vi.fn(() => TEST_USER_ID)
    const adapter = new DeepSeekAdapter({ options, resolveApiKey, resolveUserId, prepareExtensions: noExtensions })

    for await (const _chunk of adapter.stream({ provider: 'deepseek-official', model: 'm', messages: [] })) { /* drain */ }

    expect(options).toHaveBeenCalledTimes(1)
    expect(resolveApiKey).toHaveBeenCalledTimes(1)
    expect(resolveUserId).toHaveBeenCalledTimes(1)
    expect(server.headers[0]?.authorization).toBe('Bearer per-request-key')
  })

  it('rejects invalid idle watchdog bounds for direct and plugin composition', async () => {
    expect(() => resolveAdapterOptions({ streamIdleTimeoutMs: Number.POSITIVE_INFINITY }))
      .toThrow(/streamIdleTimeoutMs.*positive finite/)
    expect(() => resolveAdapterOptions({ streamIdleTimeoutMs: MAX_TIMER_DELAY_MS + 1 }))
      .toThrow(/streamIdleTimeoutMs.*no greater/)

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(LlmDeepSeek, {
      protocol: 'chat-completions',
      baseURL: 'http://127.0.0.1:1',
      streamIdleTimeoutMs: 0,
    })).rejects.toThrow(/streamIdleTimeoutMs/)
    await expect(ctx.plugin(LlmDeepSeek, {
      protocol: 'chat-completions',
      baseURL: 'http://127.0.0.1:1',
      streamIdleTimeoutMs: MAX_TIMER_DELAY_MS + 1,
    })).rejects.toThrow(/streamIdleTimeoutMs/)
  })

  it('validates Files API timeout bounds independently of the stream idle deadline', async () => {
    expect(() => resolveAdapterOptions({ filesApiTimeoutMs: Number.POSITIVE_INFINITY }))
      .toThrow(/filesApiTimeoutMs.*positive finite/)
    expect(() => resolveAdapterOptions({ filesApiTimeoutMs: MAX_TIMER_DELAY_MS + 1 }))
      .toThrow(/filesApiTimeoutMs.*no greater/)

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(LlmDeepSeek, {
      protocol: 'chat-completions',
      baseURL: 'http://127.0.0.1:1',
      filesApiTimeoutMs: 0,
    })).rejects.toThrow(/filesApiTimeoutMs/)
    await expect(ctx.plugin(LlmDeepSeek, {
      protocol: 'chat-completions',
      baseURL: 'http://127.0.0.1:1',
      filesApiTimeoutMs: MAX_TIMER_DELAY_MS + 1,
    })).rejects.toThrow(/filesApiTimeoutMs/)
    expect(resolveAdapterOptions({ filesApiTimeoutMs: 100, streamIdleTimeoutMs: 100 }))
      .toMatchObject({ filesApiTimeoutMs: 100, streamIdleTimeoutMs: 100 })
  })

  it('rejects invalid nested retryPolicy before registering the provider', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)

    await expect(ctx.plugin(LlmDeepSeek, {
      protocol: 'chat-completions',
      baseURL: 'http://127.0.0.1:1',
      retryPolicy: { mode: 'normal', maxRetries: -1 },
    })).rejects.toThrow(/retryPolicy/)
    expect(ctx.llm.listProviders()).toEqual([])
  })
})
