import { describe, expect, it } from 'vitest'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import {
  ToolCallId,
  contentHasFile,
  createUserMessage,
  fileHandleText,
  projectFilesToText,
  offloadedImageText,
  offloadedImagePrefixCount,
  offloadRequestImagesWithPolicy,
  projectImagesForTextModel,
  resolveImageAttachmentAccess,
  requestImageHandleText,
} from '../src/index.ts'
import type { ContentBlock, Message } from '../src/index.ts'

const source = { kind: 'plugin' as const, plugin: 'test' }

const OMITTED = '[omitted]'

function offloadBase64(messages: readonly Message[], maxBytes: number | undefined): readonly Message[] {
  return offloadRequestImagesWithPolicy(messages, {
    representation: 'base64',
    ...maxBytes === undefined ? {} : { maxBytes },
    byteQuantum: 1,
    placeholder: () => OMITTED,
  })
}

function image(bytes: number): Extract<ContentBlock, { type: 'image' }> {
  return {
    type: 'image',
    attachment: {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png',
      bytes,
      width: 1,
      height: 1,
    },
  }
}

describe('base64 request-image offload', () => {
  it('preserves every image when no payload bound is configured', () => {
    const messages = [createUserMessage({ content: [image(300)], source })]
    expect(offloadBase64(messages, undefined)).toBe(messages)
  })

  it('preserves the original request when its base64 payload fits exactly', () => {
    const messages = [createUserMessage({ content: [image(3), image(3)], source })]
    expect(offloadBase64(messages, 8)).toBe(messages)
  })

  it('keeps five 3 MiB images at 20 MiB and offloads the oldest after one more raw byte', () => {
    const rawImageBytes = 3 * 1024 * 1024
    const maxRequestImageBytes = 20 * 1024 * 1024
    const exact = [createUserMessage({
      content: Array.from({ length: 5 }, () => image(rawImageBytes)),
      source,
    })]
    expect(offloadBase64(exact, maxRequestImageBytes)).toBe(exact)

    const over = [createUserMessage({
      content: [image(rawImageBytes + 1), ...Array.from({ length: 4 }, () => image(rawImageBytes))],
      source,
    })]
    expect(offloadBase64(over, maxRequestImageBytes)[0]?.content).toEqual([
      { type: 'text', text: OMITTED },
      ...Array.from({ length: 4 }, () => image(rawImageBytes)),
    ])
  })

  it('replaces the oldest nested occurrences without mutating durable messages', () => {
    const shared = image(3)
    const messages = [
      createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: ToolCallId('shot'),
          content: [shared],
        }],
        source,
      }),
      createUserMessage({ content: [shared, image(3)], source }),
    ]

    const fitted = offloadBase64(messages, 8)
    expect(fitted).not.toBe(messages)
    expect(fitted[0]?.content).toEqual([{
      type: 'tool-result',
      toolCallId: ToolCallId('shot'),
      content: [{ type: 'text', text: OMITTED }],
    }])
    expect(fitted[1]?.content).toEqual([shared, image(3)])
    expect(messages[0]?.content[0]).toMatchObject({ type: 'tool-result', content: [shared] })
  })

  it('replaces a single image that cannot fit', () => {
    const messages = [createUserMessage({ content: [image(300)], source })]
    expect(offloadBase64(messages, 8)[0]?.content)
      .toEqual([{ type: 'text', text: OMITTED }])
  })

  it('keeps unchanged nested content while replacing a later image', () => {
    const nested = {
      type: 'tool-result' as const,
      toolCallId: ToolCallId('text-only'),
      content: [{ type: 'text' as const, text: 'kept' }],
    }
    const messages = [createUserMessage({ content: [nested, image(3)], source })]
    expect(offloadBase64(messages, 1)[0]?.content).toEqual([
      nested,
      { type: 'text', text: OMITTED },
    ])
  })
})

describe('offloadedImagePrefixCount', () => {
  it('removes nothing under unbounded budgets and whole quanta past them', () => {
    const lengths = [4, 4, 4, 4]
    expect(offloadedImagePrefixCount(lengths, {})).toBe(0)
    expect(offloadedImagePrefixCount(lengths, { maxBytes: 16 })).toBe(0)
    expect(offloadedImagePrefixCount(lengths, { maxImages: 4 })).toBe(0)
    // One excess image rounds up to the whole count quantum.
    expect(offloadedImagePrefixCount([...lengths, 4], { maxImages: 4, countQuantum: 2 })).toBe(2)
    // One excess byte removes a whole byte quantum, crossing the second image.
    expect(offloadedImagePrefixCount([...lengths, 1], { maxBytes: 16, byteQuantum: 5 })).toBe(2)
  })
})

describe('offloadRequestImagesWithPolicy', () => {
  it('drops 129 MiB to 64 MiB and keeps the removed prefix stable through 192 MiB', () => {
    const mib = 1024 * 1024
    const project = (count: number) => offloadRequestImagesWithPolicy([
      createUserMessage({ content: Array.from({ length: count }, () => image(mib)), source }),
    ], {
      representation: 'raw',
      maxBytes: 128 * mib,
      byteQuantum: 64 * mib,
      placeholder: () => OMITTED,
    })[0]?.content

    expect(project(128)?.filter(block => block.type === 'image')).toHaveLength(128)
    expect(project(129)?.filter(block => block.type === 'text')).toHaveLength(65)
    expect(project(192)?.filter(block => block.type === 'text')).toHaveLength(65)
    expect(project(193)?.filter(block => block.type === 'text')).toHaveLength(129)
  })

  it('rounds a count excess up to a 20-image removal step', () => {
    const projected = offloadRequestImagesWithPolicy([
      createUserMessage({ content: Array.from({ length: 601 }, () => image(1)), source }),
    ], {
      representation: 'raw',
      maxImages: 600,
      countQuantum: 20,
      placeholder: () => OMITTED,
    })
    expect(projected[0]?.content.filter(block => block.type === 'text')).toHaveLength(20)
    expect(projected[0]?.content.filter(block => block.type === 'image')).toHaveLength(581)
  })

  it('uses route-owned request byte lengths when supplied', () => {
    const messages = [createUserMessage({ content: [image(100), image(100)], source })]
    const projected = offloadRequestImagesWithPolicy(messages, {
      representation: 'raw',
      maxBytes: 3,
      byteLength: () => 2,
      placeholder: () => OMITTED,
    })
    expect(projected[0]?.content).toEqual([
      { type: 'text', text: OMITTED },
      image(100),
    ])
  })

  it('builds a distinct placeholder from each omitted attachment', () => {
    const first = image(3)
    const second = image(3)
    first.attachment = { ...first.attachment, name: 'first.png' }
    second.attachment = { ...second.attachment, name: 'second.png' }
    const projected = offloadRequestImagesWithPolicy([
      createUserMessage({ content: [first, second], source }),
    ], {
      representation: 'raw',
      maxBytes: 3,
      placeholder: ref => `omitted:${ref.name}`,
    })
    expect(projected[0]?.content).toEqual([
      { type: 'text', text: 'omitted:first.png' },
      second,
    ])
  })
})

describe('model-facing image access', () => {
  it('describes the request preview, immutable normalized path, and source uncertainty', () => {
    const attachment = {
      attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
      mediaType: 'image/png' as const,
      bytes: 4_000,
      width: 2048,
      height: 1536,
      name: 'source "map".png',
    }
    const access = { readonlyPath: '/tmp/.dsh/attachments/v1/objects/bb/object' }
    const version = {
      variantId: ImageVariantId(`sha256:${'c'.repeat(64)}`),
      attachment,
      data: Uint8Array.of(1),
      mediaType: 'image/png' as const,
      bytes: 1,
      width: 923,
      height: 692,
      depth: 'uchar' as const,
      space: 'srgb' as const,
      hasAlpha: true,
    }
    expect(requestImageHandleText(attachment, version, access)).toBe(
      `Image "source \\"map\\".png" (${attachment.attachmentId}); request preview 923x692px.`
      + ' Normalized copy (read-only; may be resized or re-encoded): "/tmp/.dsh/attachments/v1/objects/bb/object" (2048x1536px, image/png).'
      + ' Source dimensions, format, and byte size may differ.'
      + ' Copy to a writable path ending in .png before editing.',
    )
  })

  it('bridges a provider host object only through the mounted filesystem mapping', () => {
    const attachment = image(1).attachment
    const attachments = {
      imageHostPath: () => '/host/.dsh/attachments/object',
    } as unknown as AttachmentStore
    const mapped = (hostPath: string): string | undefined => hostPath === '/host/.dsh/attachments/object'
      ? '/workspace/.attachments/object'
      : undefined
    expect(resolveImageAttachmentAccess(
      attachments,
      mapped,
      attachment,
    )).toEqual({ readonlyPath: '/workspace/.attachments/object' })
    expect(resolveImageAttachmentAccess(
      attachments,
      () => undefined,
      attachment,
    )).toBeUndefined()
    expect(resolveImageAttachmentAccess(
      { imageHostPath: () => undefined } as unknown as AttachmentStore,
      mapped,
      attachment,
    )).toBeUndefined()
  })

  it('names each occurrence from its own reference when one prepared version is shared', () => {
    const attachment = {
      attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
      mediaType: 'image/png' as const,
      bytes: 4_000,
      width: 8,
      height: 8,
      name: 'second.png',
    }
    const version = {
      variantId: ImageVariantId(`sha256:${'c'.repeat(64)}`),
      attachment,
      data: Uint8Array.of(1),
      mediaType: 'image/png' as const,
      bytes: 1,
      width: 8,
      height: 8,
      depth: 'uchar' as const,
      space: 'srgb' as const,
      hasAlpha: false,
    }
    expect(requestImageHandleText({ ...attachment, name: 'first.png' }, version))
      .toContain('"first.png"')
  })

  it('keeps a useful omission identity with and without a local path', () => {
    const ref = {
      attachmentId: AttachmentId(`sha256:${'d'.repeat(64)}`),
      mediaType: 'image/jpeg' as const,
      bytes: 10,
      width: 10,
      height: 5,
      name: 'photo.jpg',
    }
    expect(offloadedImageText(ref)).toContain('No local normalized image path is available')
    expect(offloadedImageText(ref, { readonlyPath: '/tmp/object' })).toBe(
      `[image omitted to fit request image limits; "photo.jpg" (${ref.attachmentId}).`
      + ' Normalized copy (read-only; may be resized or re-encoded): "/tmp/object" (10x5px, image/jpeg).'
      + ' Source dimensions, format, and byte size may differ.'
      + ' Copy to a writable path ending in .jpg before editing.]',
    )
  })

  it.each([
    ['image/png', '.png'],
    ['image/jpeg', '.jpg'],
    ['image/webp', '.webp'],
    ['image/gif', '.gif'],
  ] as const)('names the writable extension for %s', (mediaType, suffix) => {
    const ref = {
      attachmentId: AttachmentId(`sha256:${'e'.repeat(64)}`),
      mediaType,
      bytes: 1,
      width: 1,
      height: 1,
    }
    expect(offloadedImageText(ref, { readonlyPath: '/tmp/object' }))
      .toContain(`writable path ending in ${suffix}`)
  })

  it('rejects a media type that escaped the closed union at runtime', () => {
    const ref = {
      attachmentId: AttachmentId(`sha256:${'e'.repeat(64)}`),
      mediaType: 'image/tiff' as unknown as ImageMediaType,
      bytes: 1,
      width: 1,
      height: 1,
    }
    expect(() => offloadedImageText(ref, { readonlyPath: '/tmp/object' }))
      .toThrow('unreachable variant in image extension: "image/tiff"')
  })
})

describe('projectImagesForTextModel', () => {
  it('returns image-free history unchanged', () => {
    const messages = [createUserMessage({ content: [{ type: 'text', text: 'plain' }], source })]
    expect(projectImagesForTextModel(messages)).toBe(messages)
  })

  it('replaces direct and nested images while retaining unaffected messages and blocks', () => {
    const plain = createUserMessage({ content: [{ type: 'text', text: 'plain' }], source })
    const nested = {
      type: 'tool-result' as const,
      toolCallId: ToolCallId('nested-image'),
      content: [{ type: 'text' as const, text: 'before' }, image(3), { type: 'text' as const, text: 'after' }],
    }
    const unchangedNested = {
      type: 'tool-result' as const,
      toolCallId: ToolCallId('text-only'),
      content: [{ type: 'text' as const, text: 'unchanged' }],
    }
    const visual = createUserMessage({
      content: [{ type: 'text', text: 'lead' }, image(3), unchangedNested, nested],
      source,
    })

    const projected = projectImagesForTextModel([plain, visual])
    expect(projected[0]).toBe(plain)
    expect(projected[1]?.content).toEqual([
      { type: 'text', text: 'lead' },
      { type: 'text', text: '[image omitted because this model accepts text only; attachment sha256:aaaaaaaa]' },
      unchangedNested,
      {
        ...nested,
        content: [
          { type: 'text', text: 'before' },
          { type: 'text', text: '[image omitted because this model accepts text only; attachment sha256:aaaaaaaa]' },
          { type: 'text', text: 'after' },
        ],
      },
    ])
  })
})

describe('file projection', () => {
  function fileBlock(name: string): Extract<ContentBlock, { type: 'file' }> {
    return {
      type: 'file',
      attachment: {
        attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`),
        name,
        bytes: 42,
      },
    }
  }

  it('detects file blocks at the top level and inside nested tool results', () => {
    expect(contentHasFile([{ type: 'text', text: 'x' }])).toBe(false)
    expect(contentHasFile([fileBlock('a.txt')])).toBe(true)
    expect(contentHasFile([{
      type: 'tool-result',
      toolCallId: ToolCallId('call-1'),
      content: [{
        type: 'tool-result',
        toolCallId: ToolCallId('call-2'),
        content: [fileBlock('deep.txt')],
      }],
    }])).toBe(true)
  })

  it('renders the handle with the read path or the explicit no-path fallback', () => {
    const withPath = fileHandleText(fileBlock('notes.pdf').attachment, '/home/.dsh/attachments/v1/files/ab/x/notes.pdf')
    expect(withPath).toContain('"notes.pdf"')
    expect(withPath).toContain('42 bytes')
    expect(withPath).toContain('sha256:abababab')
    expect(withPath).toContain('"/home/.dsh/attachments/v1/files/ab/x/notes.pdf"')
    expect(withPath).toContain('include this saved path in the delegation prompt')
    expect(withPath).toContain('only subagents sharing this execution environment can read it')
    const withoutPath = fileHandleText(fileBlock('notes.pdf').attachment, undefined)
    expect(withoutPath).toContain('current execution environment cannot access a readable path')
    expect(withoutPath).toContain('do not claim to have read it')
  })

  it('replaces every file occurrence with handle text and keeps file-free history identical', () => {
    const plain = [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source })]
    expect(projectFilesToText(plain, () => '/p')).toBe(plain)
    const unchangedTool = {
      type: 'tool-result' as const,
      toolCallId: ToolCallId('call-plain'),
      content: [{ type: 'text' as const, text: 'unchanged result' }],
    }
    const messages = [plain[0]!, createUserMessage({
      content: [
        fileBlock('top.csv'),
        { type: 'text', text: 'keep' },
        unchangedTool,
        {
          type: 'tool-result',
          toolCallId: ToolCallId('call-3'),
          content: [fileBlock('nested.csv')],
        },
      ],
      source,
    })]
    const projected = projectFilesToText(messages, ref => `/copies/${ref.name}`)
    expect(projected).not.toBe(messages)
    expect(projected[0]).toBe(messages[0])
    const content = projected[1]!.content
    expect(content[0]).toEqual({ type: 'text', text: fileHandleText(fileBlock('top.csv').attachment, '/copies/top.csv') })
    expect(content[1]).toEqual({ type: 'text', text: 'keep' })
    expect(content[2]).toBe(messages[1]!.content[2])
    const nested = content[3] as Extract<ContentBlock, { type: 'tool-result' }>
    expect(nested.content[0]).toEqual({
      type: 'text',
      text: fileHandleText(fileBlock('nested.csv').attachment, '/copies/nested.csv'),
    })
    // The durable message is untouched: projection returns shallow copies.
    expect(messages[1]!.content[0]!.type).toBe('file')
  })
})
