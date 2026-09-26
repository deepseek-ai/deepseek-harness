import { describe, expect, it } from 'vitest'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import {
  ToolCallId,
  contentHasFile,
  createDeveloperMessage,
  createToolResultMessage,
  createUserMessage,
  fileHandleText,
  projectFilesToText,
  offloadedImageText,
  projectImagesForTextModel,
  projectOffloadedImages,
  projectToolUpdates,
  requiredImageOffload,
  resolveImageAttachmentAccess,
  requestImageHandleText,
} from '../src/index.ts'
import type { ContentBlock, RequestMessage, RequestUserInput, ToolHistory, ToolSchema } from '../src/index.ts'

const source = { kind: 'test' as const }

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
  it('visits image occurrences in user and tool messages in message order', () => {
    const seen: number[] = []
    const messages = [
      createUserMessage({ content: [{ type: 'text', text: 'before' }, image(1)], source }),
      createToolResultMessage({
        callId: ToolCallId('shot'),
        content: [{ type: 'text', text: 'x' }, image(2)],
        isError: false,
      }),
      createToolResultMessage({
        callId: ToolCallId('second'),
        content: [image(4)],
        isError: false,
      }),
      createUserMessage({ content: [image(3)], source }),
    ]
    expect(requiredImageOffload(messages, { representation: 'raw', maxImages: 0 }, (block) => {
      seen.push(block.attachment.bytes)
      return block.attachment.bytes
    })).toBe(4)
    expect(seen).toEqual([1, 2, 4, 3])
  })
})

describe('projectOffloadedImages', () => {
  it('keeps request-only inputs identity-free when replacing image content', () => {
    const input: RequestUserInput = { role: 'user', content: [image(3, true)] }
    expect(projectOffloadedImages([input], () => OMITTED)).toEqual([
      { role: 'user', content: [{ type: 'text', text: OMITTED }] },
    ])
    expect(projectImagesForTextModel([input])).toEqual([
      { role: 'user', content: [{ type: 'text', text: '[image omitted because this model accepts text only; attachment sha256:aaaaaaaa]' }] },
    ])
    expect(input.content).toEqual([image(3, true)])
  })

  it('keeps messages without offloaded occurrences by identity', () => {
    const messages = [createUserMessage({ content: [image(300)], source })]
    const projected = projectOffloadedImages(messages, () => OMITTED)
    expect(projected[0]).toBe(messages[0])
  })

  it('replaces marked user and tool occurrences with route placeholders', () => {
    const messages = [
      createToolResultMessage({
        callId: ToolCallId('shot'),
        content: [image(3, true)],
        isError: false,
      }),
      createUserMessage({ content: [image(3, true), image(3)], source }),
    ]
    const projected = projectOffloadedImages(messages, ref => `${OMITTED}:${ref.bytes}`)
    expect(projected[0]?.content).toEqual([{ type: 'text', text: `${OMITTED}:3` }])
    expect(projected[1]?.content).toEqual([{ type: 'text', text: `${OMITTED}:3` }, image(3)])
    expect(messages[1]?.content[0]).toEqual(image(3, true))
  })

  it('keeps unchanged tool content while replacing a later image', () => {
    const unchanged = createToolResultMessage({
      callId: ToolCallId('text-only'),
      content: [{ type: 'text', text: 'kept' }],
      isError: false,
    })
    const messages = [unchanged, createUserMessage({ content: [image(3, true)], source })]
    const projected = projectOffloadedImages(messages, () => OMITTED)
    expect(projected[0]).toBe(unchanged)
    expect(projected[1]?.content).toEqual([{ type: 'text', text: OMITTED }])
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
    const results = [createToolResultMessage({
      callId: ToolCallId('plain-result'),
      content: messages[0]!.content,
      isError: false,
    })]
    expect(projectImagesForTextModel(results)).toBe(results)
  })

  it('replaces direct images while retaining unaffected messages', () => {
    const plain = createUserMessage({ content: [{ type: 'text', text: 'plain' }], source })
    const unchangedTool = createToolResultMessage({
      callId: ToolCallId('text-only'),
      content: [{ type: 'text', text: 'unchanged' }],
      isError: false,
    })
    const visual = createUserMessage({
      content: [{ type: 'text', text: 'lead' }, image(3)],
      source,
    })
    const visualTool = createToolResultMessage({
      callId: ToolCallId('nested-image'),
      content: [
        { type: 'text', text: 'before' },
        image(3),
        { type: 'text', text: 'after' },
      ],
      isError: false,
    })

    const projected = projectImagesForTextModel([plain, visual, unchangedTool, visualTool])
    expect(projected[0]).toBe(plain)
    expect(projected[1]?.content).toEqual([
      { type: 'text', text: 'lead' },
      { type: 'text', text: '[image omitted because this model accepts text only; attachment sha256:aaaaaaaa]' },
    ])
    expect(projected[2]).toBe(unchangedTool)
    expect(projected[3]?.content).toEqual([
      { type: 'text', text: 'before' },
      { type: 'text', text: '[image omitted because this model accepts text only; attachment sha256:aaaaaaaa]' },
      { type: 'text', text: 'after' },
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

  it('keeps request-only inputs identity-free when replacing file content', () => {
    const block = fileBlock('review.txt')
    const input: RequestUserInput = { role: 'user', content: [block] }
    expect(projectFilesToText([input], () => '/copies/review.txt')).toEqual([
      { role: 'user', content: [{ type: 'text', text: fileHandleText(block.attachment, '/copies/review.txt') }] },
    ])
    expect(input.content).toEqual([block])
  })

  it('detects file blocks anywhere in message content', () => {
    expect(contentHasFile([{ type: 'text', text: 'x' }])).toBe(false)
    expect(contentHasFile([fileBlock('a.txt')])).toBe(true)
  })

  it('scans frozen blocks and observes later mutations in file-free content', () => {
    const content: ContentBlock[] = [{ type: 'text', text: 'plain' }]
    Object.freeze(content[0])
    expect(contentHasFile(Object.freeze([]))).toBe(false)
    expect(contentHasFile(content)).toBe(false)
    content.push(fileBlock('later.txt'))
    expect(contentHasFile(content)).toBe(true)
    content.pop()
    expect(contentHasFile(content)).toBe(false)
    content.push(fileBlock('frozen.txt'))
    Object.freeze(content[1])
    Object.freeze(content)
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
    const messages = [
      plain[0]!,
      createUserMessage({
        content: [
          fileBlock('top.csv'),
          { type: 'text', text: 'keep' },
        ],
        source,
      }),
      createToolResultMessage({
        callId: ToolCallId('call-3'),
        content: [fileBlock('nested.csv')],
        isError: false,
      }),
    ]
    const projected = projectFilesToText(messages, ref => `/copies/${ref.name}`)
    expect(projected).not.toBe(messages)
    expect(projected[0]).toBe(messages[0])
    const content = projected[1]!.content
    expect(content[0]).toEqual({ type: 'text', text: fileHandleText(fileBlock('top.csv').attachment, '/copies/top.csv') })
    expect(content[1]).toEqual({ type: 'text', text: 'keep' })
    expect(projected[2]!.content[0]).toEqual({
      type: 'text',
      text: fileHandleText(fileBlock('nested.csv').attachment, '/copies/nested.csv'),
    })
    // The durable message is untouched: projection returns shallow copies.
    expect(messages[1]!.content[0]!.type).toBe('file')
    expect(messages[2]!.content[0]!.type).toBe('file')
  })
})

describe('projectToolUpdates', () => {
  const search: ToolSchema = { name: 'search', description: 'Search', parameters: {} }
  const fetch: ToolSchema = { name: 'fetch', description: 'Fetch', parameters: {} }
  const developer = (content: ContentBlock[]) => createDeveloperMessage({ source, content })
  const prompt = createUserMessage({ source, content: [{ type: 'text', text: 'hi' }] })
  const roles = (messages: readonly RequestMessage[]) => messages.filter(message => message.role === 'developer').map(message => message.content)

  it('returns the input history and tools by identity when nothing is projected', () => {
    const messages = [prompt]
    const tools = [search]
    const projected = projectToolUpdates(messages, tools, 'in-history', { tools, updates: [] })
    expect(projected.messages).toBe(messages)
    expect(projected.tools).toEqual(tools)
    expect(projectToolUpdates(messages, tools, undefined).messages).toBe(messages)
  })

  it('strips deferred loading and developer updates when the route declares no mode', () => {
    const added = developer([{ type: 'tool-addition', toolName: 'fetch' }])
    const history: ToolHistory = { tools: [search], updates: [{ messageId: added.id, additions: [fetch] }] }
    const deferred = [search, { ...fetch, deferLoading: true as const }]
    const projected = projectToolUpdates([prompt, added, prompt], deferred, undefined, history)
    expect(projected.tools).toEqual([search, fetch])
    expect(projected.messages).toEqual([prompt, prompt])
    const plain = [search, fetch]
    expect(projectToolUpdates([prompt], plain, undefined, history).tools).toBe(plain)
    expect(projectToolUpdates([prompt], undefined, undefined, history).tools).toBeUndefined()
  })

  it.each(['addition-only', 'in-history'] as const)('activates explicitly deferred baseline tools on %s routes', (mode) => {
    const deferred = { ...search, deferLoading: true as const }
    const added = developer([{ type: 'tool-addition', toolName: 'search' }])
    const duplicate = developer([{ type: 'tool-addition', toolName: 'search' }])
    const removed = developer([{ type: 'tool-removal', toolName: 'search' }])
    const restored = developer([{ type: 'tool-addition', toolName: 'search' }])
    const history: ToolHistory = { tools: [deferred], updates: [
      { messageId: added.id, additions: [deferred] },
      { messageId: duplicate.id, additions: [deferred] },
      { messageId: removed.id, additions: [] },
      { messageId: restored.id, additions: [deferred] },
    ] }

    const projected = projectToolUpdates([prompt, added, duplicate, removed, restored], [deferred], mode, history)

    expect(projected.tools).toEqual([deferred])
    expect(projected.messages).toEqual(mode === 'in-history'
      ? [prompt, added, removed, restored]
      : [prompt, added])
  })

  it('uses current declarations without updates when history is missing or the prefix omits an update', () => {
    const added = developer([{ type: 'tool-addition', toolName: 'fetch' }])
    const history: ToolHistory = { tools: [search], updates: [{ messageId: added.id, additions: [fetch] }] }
    const tools = [search, fetch]
    const missing = projectToolUpdates([prompt, added], tools, 'in-history')
    expect(missing.tools).toBe(tools)
    expect(missing.messages).toEqual([prompt])
    const prefix = projectToolUpdates([prompt], tools, 'in-history', history)
    expect(prefix.tools).toBe(tools)
    expect(prefix.messages).toEqual([prompt])
  })

  it('omits updates from an earlier declaration series', () => {
    const earlier = developer([{ type: 'tool-addition', toolName: 'search' }])
    const current = developer([{ type: 'tool-addition', toolName: 'fetch' }])
    const history: ToolHistory = { tools: [search], updates: [{ messageId: current.id, additions: [fetch] }] }

    const projected = projectToolUpdates([prompt, earlier, current], [search, fetch], 'in-history', history)

    expect(projected.messages).toEqual([prompt, current])
    expect(projected.tools).toEqual([search, { ...fetch, deferLoading: true }])
  })

  it('defers historical additions and retains removed definitions for in-history routes', () => {
    const added = developer([{ type: 'tool-addition', toolName: 'fetch' }, { type: 'text', text: 'fetch is available' }])
    const removed = developer([{ type: 'tool-removal', toolName: 'search' }])
    const history: ToolHistory = { tools: [search], updates: [
      { messageId: added.id, additions: [fetch] },
      { messageId: removed.id, additions: [] },
    ] }
    const projected = projectToolUpdates([prompt, added, prompt, removed, prompt], [fetch], 'in-history', history)
    expect(projected.tools).toEqual([search, { ...fetch, deferLoading: true }])
    expect(projected.messages[1]).toBe(added)
    expect(roles(projected.messages)).toEqual([
      [{ type: 'tool-addition', toolName: 'fetch' }, { type: 'text', text: 'fetch is available' }],
      [{ type: 'tool-removal', toolName: 'search' }],
    ])
  })

  it('omits removed definitions and removal blocks for addition-only routes', () => {
    const swapped = developer([{ type: 'tool-addition', toolName: 'fetch' }, { type: 'tool-removal', toolName: 'search' }])
    const removed = developer([{ type: 'tool-removal', toolName: 'fetch' }])
    const history: ToolHistory = { tools: [search], updates: [
      { messageId: swapped.id, additions: [fetch] },
      { messageId: removed.id, additions: [] },
    ] }
    const projected = projectToolUpdates([prompt, swapped, prompt, removed, prompt], [], 'addition-only', history)
    expect(projected.tools).toEqual([])
    expect(projected.messages).toEqual([prompt, prompt, prompt])
    const partial = projectToolUpdates([prompt, swapped, prompt], [fetch], 'addition-only', { tools: [search], updates: [history.updates[0]!] })
    expect(partial.tools).toEqual([{ ...fetch, deferLoading: true }])
    expect(partial.messages[1]).not.toBe(swapped)
    expect(roles(partial.messages)).toEqual([[{ type: 'tool-addition', toolName: 'fetch' }]])
  })

  it('re-offers an unchanged restored tool through its recorded blocks', () => {
    const removed = developer([{ type: 'tool-removal', toolName: 'search' }])
    const restored = developer([{ type: 'tool-addition', toolName: 'search' }])
    const history: ToolHistory = { tools: [search, fetch], updates: [
      { messageId: removed.id, additions: [] },
      { messageId: restored.id, additions: [search] },
    ] }
    const messages = [prompt, removed, prompt, restored, prompt]
    const inHistory = projectToolUpdates(messages, [search, fetch], 'in-history', history)
    expect(inHistory.tools).toEqual([search, fetch])
    expect(roles(inHistory.messages)).toEqual([
      [{ type: 'tool-removal', toolName: 'search' }],
      [{ type: 'tool-addition', toolName: 'search' }],
    ])
    const additionOnly = projectToolUpdates(messages, [search, fetch], 'addition-only', history)
    expect(additionOnly.tools).toEqual([search, fetch])
    expect(roles(additionOnly.messages)).toEqual([])
  })

  it('declares a deferred tool once across removal and re-addition', () => {
    const added = developer([{ type: 'tool-addition', toolName: 'fetch' }])
    const removed = developer([{ type: 'tool-removal', toolName: 'fetch' }])
    const restored = developer([{ type: 'tool-addition', toolName: 'fetch' }])
    const history: ToolHistory = { tools: [search], updates: [
      { messageId: added.id, additions: [fetch] },
      { messageId: removed.id, additions: [] },
      { messageId: restored.id, additions: [fetch] },
    ] }
    const messages = [prompt, added, prompt, removed, prompt, restored, prompt]
    const inHistory = projectToolUpdates(messages, [search, fetch], 'in-history', history)
    expect(inHistory.tools).toEqual([search, { ...fetch, deferLoading: true }])
    expect(roles(inHistory.messages)).toHaveLength(3)
    const additionOnly = projectToolUpdates(messages, [search, fetch], 'addition-only', history)
    expect(roles(additionOnly.messages)).toEqual([[{ type: 'tool-addition', toolName: 'fetch' }]])
  })
})
