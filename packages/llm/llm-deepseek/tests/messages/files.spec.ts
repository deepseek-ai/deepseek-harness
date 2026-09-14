/** Messages file-reference admission, bounded recovery and request-wide inline fallback. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { createAssistantMessage, createToolResultMessage, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import { DeepSeekFileId } from '../../src/common/file-id.ts'
import type { DeepSeekFileStore } from '../../src/common/file-store.ts'
import { resolveAdapterOptions } from '../../src/config.ts'
import type { Config } from '../../src/config.ts'
import { DeepSeekMessagesAdapter } from '../../src/protocols/messages/adapter.ts'
import { prepareImages } from '../../src/protocols/messages/images.ts'
import { providerErrorDetail } from '../../src/protocols/messages/transport.ts'
import { chunks, options, prepareExtensions, sse, textEvents, user } from './helpers.ts'

const model = 'deepseek-flash'
const ref: ImageAttachmentRef = { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), width: 1, height: 1, mediaType: 'image/png', bytes: 3 }
const second = { ...ref, attachmentId: AttachmentId(`sha256:${'c'.repeat(64)}`) }
const version = (attachment: ImageAttachmentRef): RequestImageAttachment => ({
  attachment, variantId: ImageVariantId(`sha256:${(attachment === ref ? 'b' : 'd').repeat(64)}`),
  data: Uint8Array.of(1, 2, 3), bytes: 3, mediaType: 'image/png', width: 1, height: 1, depth: 'uchar', space: 'srgb', hasAlpha: false,
})
const request = (refs = [ref]) => options({ model, messages: [{ ...user(), content: refs.map(attachment => ({ type: 'image' as const, attachment })) }] })
const success = () => new Response(sse(textEvents), { headers: { 'content-type': 'text/event-stream' } })
function body(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('expected a JSON request body')
  return init.body
}
const rejected = (message: string, status = 400) => new Response(JSON.stringify({ error: { type: 'invalid_request_error', message } }), { status })
function harness(config: Config = {}) {
  const ensureUploaded = vi.fn<DeepSeekFileStore['ensureUploaded']>(async image => ({
    record: { fileId: DeepSeekFileId(image.attachment.attachmentId === ref.attachmentId ? 'file-a' : 'file-b') }, uploaded: false,
  } as Awaited<ReturnType<DeepSeekFileStore['ensureUploaded']>>))
  const invalidate = vi.fn<DeepSeekFileStore['invalidate']>(async () => {})
  const files = { ensureUploaded, invalidate } as unknown as DeepSeekFileStore
  const readImageRequest = vi.fn(async (attachment: ImageAttachmentRef) => version(attachment))
  // The codec and remote upload are the expensive boundaries; request projection and recovery stay real.
  const attachments = { readImageRequest } as unknown as AttachmentStore
  const prepare = vi.fn(prepareExtensions)
  const adapter = new DeepSeekMessagesAdapter({
    connection: () => resolveAdapterOptions(Object.assign({ baseURL: 'https://gateway.example/custom' }, config)),
    apiKey: async () => 'test-key', userId: () => 'test-user', attachments: () => attachments,
    imageAccess: () => ({ readonlyPath: '/workspace/image.png' }), files: () => files, prepareExtensions: prepare,
  })
  return { adapter, ensureUploaded, invalidate, readImageRequest, prepare }
}
afterEach(() => { vi.unstubAllGlobals() })

describe('Messages Files requests', () => {
  it('keeps nested tool-result images in order and sends only Files ids with the beta header', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => success())
    vi.stubGlobal('fetch', fetchImpl)
    const h = harness()
    const callId = ToolCallId('image-tool')
    const messages = [user(), createAssistantMessage({ source: { provider: 'deepseek-official', model }, content: [{ type: 'tool-call', id: callId, name: 'read_image', arguments: '{}' }] }),
      createToolResultMessage({ callId, isError: false, content: [{ type: 'image', attachment: ref }, { type: 'image', attachment: ref }] })]
    await chunks(h.adapter.stream(options({ model, messages })))
    expect(h.readImageRequest).toHaveBeenCalledTimes(1)
    expect(h.ensureUploaded).toHaveBeenCalledWith(expect.anything(), { baseURL: 'https://gateway.example/custom', apiKey: 'test-key', protocol: 'messages' }, expect.anything(), expect.any(AbortSignal))
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://gateway.example/custom/v1/messages')
    expect(new Headers(init?.headers).get('anthropic-beta')).toBe('files-api-2025-04-14')
    const payload = JSON.parse(body(init)) as { messages: { content: unknown[] }[] }
    expect(payload.messages[2]?.content[0]).toMatchObject({ type: 'tool_result', content: [
      { type: 'text', text: expect.stringContaining('/workspace/image.png') as string }, { type: 'image', source: { type: 'file', file_id: 'file-a' } },
      { type: 'text' }, { type: 'image', source: { type: 'file', file_id: 'file-a' } },
    ] })
    expect(body(init)).not.toContain('base64')
  })

  it('invalidates the named stale id once and prepares extensions for each HTTP attempt', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(rejected('file-a expired')).mockImplementation(async () => success())
    vi.stubGlobal('fetch', fetchImpl)
    const h = harness()
    await chunks(h.adapter.stream(request([ref, second])))
    expect(h.invalidate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ attachment: ref }), 'file-a', expect.objectContaining({ protocol: 'messages' }))
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(h.prepare).toHaveBeenCalledTimes(2)
    expect(h.ensureUploaded).toHaveBeenCalledTimes(4)
  })

  it('invalidates all referenced mappings when the provider identifies no particular stale id, then fails after one retry', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => rejected('file id not found'))
    vi.stubGlobal('fetch', fetchImpl)
    const h = harness()
    await expect(chunks(h.adapter.stream(request([ref, second])))).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(h.invalidate).toHaveBeenCalledTimes(4)
    expect(fetchImpl.mock.calls.every(call => !body(call[1]).includes('base64'))).toBe(true)
  })

  it('attributes normalized-image rejection without retrying its bytes as inline', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => rejected('invalid image file-a'))
    vi.stubGlobal('fetch', fetchImpl)
    const h = harness()
    await expect(chunks(h.adapter.stream(request()))).rejects.toMatchObject({ code: 'INVALID_REQUEST', message: expect.stringContaining('message 1, image 1') as string })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(h.invalidate).not.toHaveBeenCalled()
  })

  it('switches every retained image to inline after a partial upload failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => success())
    vi.stubGlobal('fetch', fetchImpl)
    const h = harness()
    h.ensureUploaded
      .mockResolvedValueOnce({ record: { fileId: DeepSeekFileId('file-a') }, uploaded: true } as Awaited<ReturnType<DeepSeekFileStore['ensureUploaded']>>)
      .mockRejectedValueOnce(new LlmError('quota exhausted', 'FILES_API'))
    await chunks(h.adapter.stream(request([ref, second])))
    const init = fetchImpl.mock.calls[0]?.[1]
    expect(body(init).match(/"type":"base64"/gu)).toHaveLength(2)
    expect(body(init)).not.toContain('file_id')
    expect(new Headers(init?.headers).has('anthropic-beta')).toBe(false)
    expect(h.prepare).toHaveBeenCalledTimes(1)
  })

  it('applies the tighter inline byte budget only after Files resolution fails', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => success())
    vi.stubGlobal('fetch', fetchImpl)
    const h = harness({
      maxInlineRequestImageBytes: 4, inlineImageOffloadByteQuantum: 1, maxImagesPerRequest: 2, imageOffloadCountQuantum: 1,
    })
    const original = request([ref, second])
    const saved = JSON.stringify(original.messages)
    await chunks(h.adapter.stream(original))
    expect(body(fetchImpl.mock.calls[0]?.[1]).match(/"file_id"/gu)).toHaveLength(2)
    h.ensureUploaded.mockRejectedValueOnce(new Error('offline'))
    await expect(chunks(h.adapter.stream(original))).rejects.toMatchObject({ failure: { code: 'IMAGE_OFFLOAD_REQUIRED', offloadImages: 1 } })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    h.ensureUploaded.mockRejectedValueOnce(new Error('offline'))
    await chunks(h.adapter.stream(options({ model, messages: [{ ...user(), content: [
      { type: 'image', attachment: ref, offloaded: true }, { type: 'image', attachment: second },
    ] }] })))
    const fallback = body(fetchImpl.mock.calls[1]?.[1])
    expect(fallback.match(/"type":"base64"/gu)).toHaveLength(1)
    expect(fallback).toContain('image omitted to fit request image limits')
    expect(JSON.stringify(original.messages)).toBe(saved)
  })

  it('reads and prices only the retained occurrences selected by the logged offload', async () => {
    vi.stubGlobal('fetch', async () => success())
    const h = harness({ maxRequestFilesBytes: 3, imageOffloadByteQuantum: 1, maxImagesPerRequest: 2, imageOffloadCountQuantum: 1 })
    const images = [{ type: 'image' as const, attachment: ref, offloaded: true as const }, { type: 'image' as const, attachment: second }]
    await chunks(h.adapter.stream(options({ model, messages: [{ ...user(), content: images }] })))
    expect(h.readImageRequest).toHaveBeenCalledExactlyOnceWith(second, expect.anything(), expect.any(AbortSignal))
    expect(h.adapter.imageRequestPricing('deepseek-official', model).priceImages(images).map(image => image.visualTokens)).toEqual([0, expect.any(Number)])
  })

  it.each([
    { maxRequestFilesBytes: 5, imageOffloadByteQuantum: 1, maxImagesPerRequest: 2, imageOffloadCountQuantum: 1 },
    { maxRequestFilesBytes: 100, imageOffloadByteQuantum: 1, maxImagesPerRequest: 1, imageOffloadCountQuantum: 1 },
  ])('requires durable offload of repeated occurrences before upload for %j', async (config) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => success())
    vi.stubGlobal('fetch', fetchImpl)
    const h = harness(config)
    const original = request([ref, ref])
    const saved = JSON.stringify(original.messages)
    await expect(chunks(h.adapter.stream(original))).rejects.toMatchObject({ failure: { code: 'IMAGE_OFFLOAD_REQUIRED', offloadImages: 1 } })
    expect(h.readImageRequest).toHaveBeenCalledTimes(1)
    expect(h.ensureUploaded).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(JSON.stringify(original.messages)).toBe(saved)
  })

  it('uses exact prepared bytes when the durable reference fits the Files budget', async () => {
    const h = harness({ maxRequestFilesBytes: 3, imageOffloadByteQuantum: 1, imageOffloadCountQuantum: 1 })
    h.readImageRequest.mockResolvedValue({ ...version(ref), bytes: 4, data: Uint8Array.of(1, 2, 3, 4) })
    await expect(chunks(h.adapter.stream(request()))).rejects.toMatchObject({ failure: { code: 'IMAGE_OFFLOAD_REQUIRED', offloadImages: 1 } })
    expect(h.ensureUploaded).not.toHaveBeenCalled()
  })

  it('projects nested logged offloads without an attachment service or a vision model', async () => {
    const messages = [createToolResultMessage({ callId: ToolCallId('offloaded'), isError: false, content: [
      { type: 'image', attachment: ref, offloaded: true },
    ] })]
    const prepared = await prepareImages(messages, resolveAdapterOptions({}), 'text-model', undefined,
      () => ({ readonlyPath: '/workspace/image.png' }), new AbortController().signal)
    expect(prepared.versions.size).toBe(0)
    expect(prepared.messages[0]?.content).toMatchObject([{ type: 'tool-result', content: [
      { type: 'text', text: expect.stringContaining('image omitted to fit request image limits') as string },
    ] }])
    expect(JSON.stringify(prepared.messages)).toContain('/workspace/image.png')
    expect(messages[0]?.content).toMatchObject([{ type: 'tool-result', content: [{ type: 'image', offloaded: true }] }])
  })

  it('falls back when the Files deadline expires but never converts caller cancellation into another request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => success())
    vi.stubGlobal('fetch', fetchImpl)
    const h = harness({ filesApiTimeoutMs: 20 })
    let entered!: () => void
    let resolveStarted = new Promise<void>((resolve) => { entered = resolve })
    h.ensureUploaded.mockImplementation(async (_version, _connection, _policy, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => {
        const reason: unknown = signal!.reason
        reject(reason instanceof Error ? reason : new Error('upload aborted'))
      }, { once: true })
      entered()
    }))
    await chunks(h.adapter.stream(request()))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    resolveStarted = new Promise<void>((resolve) => { entered = resolve })
    const controller = new AbortController()
    const ongoing = chunks(h.adapter.stream({ ...request(), signal: controller.signal }))
    const result = expect(ongoing).rejects.toMatchObject({ code: 'ABORTED' })
    await resolveStarted
    controller.abort()
    await result
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('classifies Files recovery only from provider error fields', () => {
    expect(providerErrorDetail({ extra: 'file-a expired', error: { message: 'invalid request' } })).toBe('invalid request')
    expect(providerErrorDetail({ error: { code: 'file_not_found', type: 'invalid_request_error', message: 'missing' } })).toBe('file_not_found invalid_request_error missing')
    expect(providerErrorDetail({ error: 'file-a expired' })).toBe('')
    expect(providerErrorDetail(null)).toBe('')
  })
})
