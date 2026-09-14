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
  projectImagesForTextModel,
  projectOffloadedImages,
  requiredImageOffload,
  resolveImageAttachmentAccess,
  requestImageHandleText,
} from '../src/index.ts'
import type { ContentBlock } from '../src/index.ts'

const source = { kind: 'plugin' as const, plugin: 'test' }

const OMITTED = '[omitted]'

function image(bytes: number, offloaded?: true): Extract<ContentBlock, { type: 'image' }> {
  return {
    type: 'image',
    attachment: {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png',
      bytes,
      width: 1,
      height: 1,
    },
    ...offloaded === undefined ? {} : { offloaded },
  }
}

describe('requiredImageOffload traversal', () => {
  it('visits image occurrences at every tool-result depth in message order', () => {
    const seen: number[] = []
    const content: ContentBlock[] = [
      { type: 'text', text: 'before' },
      image(1),
      {
        type: 'tool-result',
        toolCallId: ToolCallId('shot'),
        content: [
          { type: 'text', text: 'x' },
          image(2),
          {
            type: 'tool-result',
            toolCallId: ToolCallId('nested'),
            content: [{ type: 'tool-result', toolCallId: ToolCallId('deep'), content: [image(4)] }],
          },
        ],
      },
      image(3),
    ]
    expect(requiredImageOffload([createUserMessage({ content, source })],
      { representation: 'raw', maxImages: 0 }, (block) => {
        seen.push(block.attachment.bytes)
        return block.attachment.bytes
      })).toBe(4)
    expect(seen).toEqual([1, 2, 4, 3])
  })
})

describe('projectOffloadedImages', () => {
  it('keeps messages without offloaded occurrences by identity', () => {
    const messages = [createUserMessage({ content: [image(300)], source })]
    const projected = projectOffloadedImages(messages, () => OMITTED)
    expect(projected[0]).toBe(messages[0])
  })

  it('replaces marked top-level and nested occurrences with route placeholders', () => {
    const messages = [
      createUserMessage({
        content: [{ type: 'tool-result', toolCallId: ToolCallId('shot'), content: [image(3, true)] }],
        source,
      }),
      createUserMessage({ content: [image(3, true), image(3)], source }),
    ]
    const projected = projectOffloadedImages(messages, ref => `${OMITTED}:${ref.bytes}`)
    expect(projected[0]?.content).toEqual([{
      type: 'tool-result',
      toolCallId: ToolCallId('shot'),
      content: [{ type: 'text', text: `${OMITTED}:3` }],
    }])
    expect(projected[1]?.content).toEqual([{ type: 'text', text: `${OMITTED}:3` }, image(3)])
    expect(messages[1]?.content[0]).toEqual(image(3, true))
  })

  it('keeps unchanged nested content while replacing a later occurrence', () => {
    const nested = {
      type: 'tool-result' as const,
      toolCallId: ToolCallId('text-only'),
      content: [{ type: 'text' as const, text: 'kept' }],
    }
    const messages = [createUserMessage({ content: [nested, image(3, true)], source })]
    expect(projectOffloadedImages(messages, () => OMITTED)[0]?.content).toEqual([
      nested,
      { type: 'text', text: OMITTED },
    ])
  })
})

describe('requiredImageOffload', () => {
  const request = (lengths: number[], offloaded: number[] = []) => [createUserMessage({
    content: lengths.map((bytes, index) => image(bytes, offloaded.includes(index) ? true : undefined)),
    source,
  })]
  const bytesOf = (block: Extract<ContentBlock, { type: 'image' }>): number => block.attachment.bytes
  const raw = { representation: 'raw' as const }

  it('removes nothing under unbounded budgets and whole quanta past them', () => {
    const lengths = [4, 4, 4, 4]
    expect(requiredImageOffload(request(lengths), raw, bytesOf)).toBe(0)
    expect(requiredImageOffload(request(lengths), { ...raw, maxBytes: 16 }, bytesOf)).toBe(0)
    expect(requiredImageOffload(request(lengths), { ...raw, maxImages: 4 }, bytesOf)).toBe(0)
    // One excess image rounds up to the whole count quantum.
    expect(requiredImageOffload(request([...lengths, 4]), { ...raw, maxImages: 4, countQuantum: 2 }, bytesOf)).toBe(2)
    // One excess byte removes a whole byte quantum, crossing the second image.
    expect(requiredImageOffload(request([...lengths, 1]), { ...raw, maxBytes: 16, byteQuantum: 5 }, bytesOf)).toBe(2)
    // 129 one-mebibyte images under a 128 MiB bound with a 64 MiB quantum offload the oldest 65.
    const mib = 1024 * 1024
    const budget = { ...raw, maxBytes: 128 * mib, byteQuantum: 64 * mib }
    expect(requiredImageOffload(request(Array.from({ length: 129 }, () => mib)), budget, bytesOf)).toBe(65)
  })

  it('skips offloaded occurrences and accounts inline bytes by their base64 length', () => {
    expect(requiredImageOffload(request([3, 3, 3]), { representation: 'base64', maxBytes: 8 }, bytesOf)).toBe(1)
    expect(requiredImageOffload(request([3, 3, 3], [0]), { representation: 'base64', maxBytes: 8 }, bytesOf)).toBe(0)
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
    const nested = [createUserMessage({
      content: [{ type: 'tool-result', toolCallId: ToolCallId('plain-result'), content: messages[0]!.content }],
      source,
    })]
    expect(projectImagesForTextModel(nested)).toBe(nested)
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

  it('scans frozen branches and observes later mutations in file-free content', () => {
    const nested: ContentBlock[] = [{ type: 'text', text: 'plain' }]
    const empty: ContentBlock[] = []
    Object.freeze(empty)
    const content: ContentBlock[] = [
      { type: 'tool-result', toolCallId: ToolCallId('empty'), content: empty },
      { type: 'tool-result', toolCallId: ToolCallId('nested'), content: nested },
    ]
    Object.freeze(content[0])
    Object.freeze(content[1])
    Object.freeze(content)
    expect(contentHasFile(Object.freeze([]))).toBe(false)
    expect(contentHasFile(content)).toBe(false)
    nested.push(fileBlock('later.txt'))
    expect(contentHasFile(content)).toBe(true)
    nested.pop()
    expect(contentHasFile(content)).toBe(false)
    nested.push(fileBlock('frozen.txt'))
    Object.freeze(nested[0])
    Object.freeze(nested[1])
    Object.freeze(nested)
    expect(contentHasFile(content)).toBe(true)
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
