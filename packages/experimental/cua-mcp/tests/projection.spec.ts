/** Result projection: text passes through, screenshots become inline images, failures keep isError without DSH's error prefix. */
import { describe, expect, it, vi } from 'vitest'
import type { AttachmentStore, ImageAttachmentRef, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { projectToolResult } from '../src/projection.ts'

const attachment: ImageAttachmentRef = {
  attachmentId: brandString<ImageAttachmentRef['attachmentId']>(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png', bytes: 3, width: 400, height: 200,
}

function store() {
  const readImage = vi.fn<AttachmentStore['readImage']>(async () => ({ ref: attachment, data: new Uint8Array([1, 2, 3]) }))
  const readImageRequest = vi.fn<AttachmentStore['readImageRequest']>(async () => ({
    variantId: brandString<ImageVariantId>('variant'), attachment, data: new Uint8Array([9, 8]), mediaType: 'image/jpeg' as const,
    bytes: 2, width: 40, height: 20, depth: 'uchar' as const, space: 'srgb' as const, hasAlpha: false,
  }))
  const attachments: Pick<AttachmentStore, 'readImage' | 'readImageRequest'> = { readImage, readImageRequest }
  return { attachments, readImage, readImageRequest }
}

const success: ToolExecutionResult = { isError: false, value: 'ok', content: [{ type: 'text', text: '{"visits":1}' }] }
const deferred = [createUserMessage({ source: { kind: 'ptc-mode' }, content: [{ type: 'text', text: '{"windowId":7}' }, { type: 'image', attachment }] })]

describe('tool result projection', () => {
  it('delivers the request version the program observed when the provider fixes a target', async () => {
    const { attachments, readImageRequest, readImage } = store()
    const signal = new AbortController().signal
    const target = { width: 40, height: 20, maxBytes: 1024 }
    const result = await projectToolResult(success, deferred, { attachments, target: () => target }, signal)
    expect(result).toEqual({ content: [
      { type: 'text', text: '{"visits":1}' },
      { type: 'text', text: '{"windowId":7}' },
      { type: 'image', data: Buffer.from([9, 8]).toString('base64'), mimeType: 'image/jpeg' },
    ] })
    expect(readImageRequest).toHaveBeenCalledWith(attachment, target, signal)
    expect(readImage).not.toHaveBeenCalled()
  })

  it('falls back to the stored image without a fixed target and names unrenderable blocks', async () => {
    const { attachments, readImage, readImageRequest } = store()
    const result = await projectToolResult(
      { isError: false, value: null, content: [{ type: 'file', name: 'log.txt' } as never] }, deferred,
      { attachments, target: () => undefined }, new AbortController().signal,
    )
    expect(result.content).toEqual([
      { type: 'text', text: '[file content omitted]' },
      { type: 'text', text: '{"windowId":7}' },
      { type: 'image', data: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'image/png' },
    ])
    expect(readImage).toHaveBeenCalledOnce()
    expect(readImageRequest).not.toHaveBeenCalled()
    expect(result).not.toHaveProperty('isError')
  })

  it('keeps the flag of a failed execution and reports its message once, without the DSH error prefix', async () => {
    const { attachments } = store()
    const failure: ToolExecutionResult = {
      isError: true, error: { message: 'code run failed (exception): boom', info: { name: 'CodeRunFailedError', code: 'CODE_RUN_FAILED' } },
      // The failure rendering, then output the program displayed before it failed; only the rendering carries the prefix.
      content: [{ type: 'text', text: 'Error: code run failed (exception): boom' }, { type: 'text', text: 'Error: shown by the program' }],
    }
    expect(await projectToolResult(failure, [], { attachments, target: () => undefined }, new AbortController().signal)).toEqual({
      content: [{ type: 'text', text: 'code run failed (exception): boom' }, { type: 'text', text: 'Error: shown by the program' }], isError: true,
    })
    // A successful program that displays the same words keeps them.
    const shown: ToolExecutionResult = { isError: false, value: 'ok', content: [{ type: 'text', text: 'Error: code run failed (exception): boom' }] }
    expect(await projectToolResult(shown, [], { attachments, target: () => undefined }, new AbortController().signal))
      .toEqual({ content: [{ type: 'text', text: 'Error: code run failed (exception): boom' }] })
  })
})
