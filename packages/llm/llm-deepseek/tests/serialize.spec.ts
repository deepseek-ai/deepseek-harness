import { describe, expect, it, vi } from 'vitest'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, ToolCallId, ReasoningEffortId, createMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import {
  serializeMessages,
  serializeMessagesWithImages,
  serializeRequest,
  serializeRequestWithImages,
} from '../src/protocols/chat-completions/serialize.ts'
import type { ImageSerializationOptions } from '../src/protocols/chat-completions/serialize.ts'

type FileResolver = Extract<ImageSerializationOptions['representation'], { kind: 'file' }>['resolveFileId']

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: [], ...overrides }
}

function imageRef(mediaType: ImageMediaType = 'image/png', bytes = 3): ImageAttachmentRef {
  const digit = ({
    'image/png': 'a',
    'image/jpeg': 'b',
    'image/webp': 'c',
    'image/gif': 'd',
  } as const)[mediaType]
  return {
    attachmentId: AttachmentId(`sha256:${digit.repeat(64)}`),
    mediaType,
    bytes,
    width: 1,
    height: 1,
  }
}

function fileResolver(id = 'file-api-image') {
  return vi.fn<FileResolver>(() => Promise.resolve(id))
}

function requestVersion(ref: ImageAttachmentRef): RequestImageAttachment {
  const hash = String(ref.attachmentId).slice('sha256:'.length)
  return {
    variantId: ImageVariantId(`sha256:${hash}`),
    attachment: ref,
    data: new Uint8Array(ref.bytes),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: ref.mediaType === 'image/png',
  }
}

function imageOptions(
  refs: readonly ImageAttachmentRef[],
  resolveFileId: FileResolver = fileResolver(),
  maxRequestImageBytes = 20 * 1024 * 1024,
): ImageSerializationOptions {
  return {
    representation: { kind: 'file' as const, resolveFileId },
    requestImages: new Map(refs.map(ref => [ref.attachmentId, requestVersion(ref)])),
    maxRequestImageBytes,
  }
}

function inlineImageOptions(
  refs: readonly ImageAttachmentRef[],
  maxRequestImageBytes = 20 * 1024 * 1024,
  byteQuantum = 10 * 1024 * 1024,
): ImageSerializationOptions {
  return {
    representation: { kind: 'base64' },
    requestImages: new Map(refs.map(ref => [ref.attachmentId, requestVersion(ref)])),
    maxRequestImageBytes,
    byteQuantum,
  }
}

describe('serializeMessages', () => {
  it('maps user text to string content', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(wire).toEqual([{ role: 'user', content: 'hello world' }])
  })

  it('maps system-role messages in history', () => {
    const wire = serializeMessages([
      createMessage({
        role: 'system', content: [{ type: 'text', text: 'be brief' }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(wire).toEqual([{ role: 'system', content: 'be brief' }])
  })

  it('passes reasoning_content back on tool-call-free turns', () => {
    const wire = serializeMessages([
      createMessage({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'thinking…' },
          { type: 'text', text: 'answer' },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    // A gateway that re-encodes the conversation for another vendor recovers
    // the upstream thinking signature by hashing this exact text, and a turn
    // that called no tool carries it nowhere else.
    expect(wire).toEqual([{ role: 'assistant', content: 'answer', reasoning_content: 'thinking…' }])
  })

  it('passes reasoning_content back on tool-call turns (official passback rule)', () => {
    const wire = serializeMessages([
      createMessage({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'I should check the weather.' },
          { type: 'tool-call', id: ToolCallId('call-1'), name: 'get_weather', arguments: '{"city":"Paris"}' },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(wire).toEqual([{
      role: 'assistant',
      // "" (not null) on tool-call turns — mirrors the official samples'
      // verbatim message replay; some gateways reject null.
      content: '',
      reasoning_content: 'I should check the weather.',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }],
    }])
  })

  it('serializes parallel tool calls in order', () => {
    const wire = serializeMessages([
      createMessage({
        role: 'assistant',
        content: [
          { type: 'tool-call', id: ToolCallId('a'), name: 'one', arguments: '{}' },
          { type: 'tool-call', id: ToolCallId('b'), name: 'two', arguments: '{}' },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    const assistant = wire[0] as { tool_calls: { id: string }[] }
    expect(assistant.tool_calls.map(call => call.id)).toEqual(['a', 'b'])
  })

  it('turns tool results into role:tool messages', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: ToolCallId('call-1'),
          content: [{ type: 'text', text: 'Sunny 22C' }],
        }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(wire).toEqual([{ role: 'tool', tool_call_id: 'call-1', content: 'Sunny 22C' }])
  })

  it('sends a sentinel for empty tool-result content', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [{ type: 'tool-result', toolCallId: ToolCallId('call-1'), content: [] }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(wire).toEqual([{ role: 'tool', tool_call_id: 'call-1', content: '(no output)' }])
  })

  it('splits mixed user text + tool results into separate wire messages', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [
          { type: 'text', text: 'context note' },
          { type: 'tool-result', toolCallId: ToolCallId('call-1'), content: [{ type: 'text', text: 'ok' }] },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(wire).toEqual([
      { role: 'user', content: 'context note' },
      { role: 'tool', tool_call_id: 'call-1', content: 'ok' },
    ])
  })

  it('skips plugin-added block types (merge-extensible ContentBlockMap)', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [
          { type: 'chart', data: 'x' } as unknown as ContentBlock,
          { type: 'text', text: 'see chart' },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(wire).toEqual([{ role: 'user', content: 'see chart' }])
  })

  it('rejects image blocks instead of silently flattening them away', () => {
    expect(() => serializeMessages([createUserMessage({
      content: [{
        type: 'image',
        attachment: {
          attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
          mediaType: 'image/png', bytes: 68, width: 1, height: 1,
        },
      }],
      source: { kind: 'plugin', plugin: 'test' },
    })])).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTENT' }))
  })

  it('emits an empty user message rather than dropping block-less messages', () => {
    const wire = serializeMessages([createUserMessage({
      content: [],
      source: { kind: 'plugin', plugin: 'test' },
    })])
    expect(wire).toEqual([{ role: 'user', content: '' }])
  })
})

describe('serializeRequest', () => {
  const history: Message[] = [createUserMessage({
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'plugin', plugin: 'test' },
  })]

  it('always streams with usage and maps the basics', () => {
    const wire = serializeRequest(request({ messages: history }))
    expect(wire).toEqual({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    })
  })

  it('prepends the system prompt', () => {
    const wire = serializeRequest(request({ messages: history, system: 'be helpful' }))
    expect(wire.messages[0]).toEqual({ role: 'system', content: 'be helpful' })
    expect(wire.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('serializes a leading system message byte-for-byte like the same prompt passed as options.system', async () => {
    const systemMessage = createMessage({
      role: 'system',
      content: [{ type: 'text', text: 'be helpful' }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
    })
    const tools = [{ name: 'f', description: 'F', parameters: { type: 'object', properties: {} } }]
    const fromHistory = serializeRequest(request({ messages: [systemMessage, ...history], tools }))
    const fromOption = serializeRequest(request({ messages: history, system: 'be helpful', tools }))
    expect(fromHistory.messages[0]).toEqual({ role: 'system', content: 'be helpful' })
    expect(JSON.stringify(fromHistory)).toBe(JSON.stringify(fromOption))
    const images = imageOptions([])
    const imageHistory = await serializeRequestWithImages(request({ messages: [systemMessage, ...history], tools }), images)
    const imageOption = await serializeRequestWithImages(request({ messages: history, system: 'be helpful', tools }), images)
    expect(JSON.stringify(imageHistory)).toBe(JSON.stringify(imageOption))
  })

  it('maps sampling params and stop sequences', () => {
    const wire = serializeRequest(request({ messages: history, temperature: 0.2, maxTokens: 100, stop: ['END'] }))
    expect(wire.temperature).toBe(0.2)
    expect(wire.max_tokens).toBe(100)
    expect(wire.stop).toEqual(['END'])
  })

  it('maps tools to the wire function shape', () => {
    const wire = serializeRequest(request({
      messages: history,
      tools: [
        { name: 'a', description: 'A', parameters: { type: 'object', properties: {} } },
        { name: 'b', description: 'B', parameters: { type: 'object', properties: { x: { type: 'string' } } } },
      ],
    }))
    expect(wire.tools).toEqual([
      { type: 'function', function: { name: 'a', description: 'A', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'b', description: 'B', parameters: { type: 'object', properties: { x: { type: 'string' } } } } },
    ])
  })

  it('omits an empty tools array', () => {
    const wire = serializeRequest(request({ messages: history, tools: [] }))
    expect(wire.tools).toBeUndefined()
  })

  it.each(['low', 'high', 'max'] as const)('maps adapter-default thinking and request effort %s', (effort) => {
    const wire = serializeRequest(
      request({ messages: history, reasoningEffort: ReasoningEffortId(effort) }),
      { thinking: 'enabled', reasoningEffort: 'high' },
    )
    expect(wire.thinking).toEqual({ type: 'enabled' })
    expect(wire.reasoning_effort).toBe(effort)
  })

  it('maps off to disabled thinking without a wire reasoning effort', () => {
    const wire = serializeRequest(
      request({ messages: history, reasoningEffort: ReasoningEffortId('off') }),
      { thinking: 'enabled', reasoningEffort: 'max' },
    )
    expect(wire.thinking).toEqual({ type: 'disabled' })
    expect(wire.reasoning_effort).toBeUndefined()
  })

  it('re-enables thinking when max overrides an off default', () => {
    const wire = serializeRequest(
      request({ messages: history, reasoningEffort: ReasoningEffortId('max') }),
      { reasoningEffort: 'off' },
    )
    expect(wire.thinking).toEqual({ type: 'enabled' })
    expect(wire.reasoning_effort).toBe('max')
  })

  it('rejects enabling thinking when the deployment is locked to disabled', () => {
    expect(() => serializeRequest(
      request({ messages: history, reasoningEffort: ReasoningEffortId('high') }),
      { thinking: 'disabled' },
    )).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_REASONING_EFFORT' }))
  })

  it('disables thinking for session-title requests without changing adapter defaults', () => {
    const wire = serializeRequest(
      request({
        messages: history,
        purpose: 'session-title',
        reasoningEffort: ReasoningEffortId('max'),
      }),
      { thinking: 'enabled', reasoningEffort: 'max' },
    )
    expect(wire.thinking).toEqual({ type: 'disabled' })
    expect(wire.reasoning_effort).toBeUndefined()
  })

  it('omits thinking fields when unset (provider default applies)', () => {
    const wire = serializeRequest(request({ messages: history }))
    expect(wire.thinking).toBeUndefined()
    expect(wire.reasoning_effort).toBeUndefined()
  })

  it('preserves an explicit enabled default without inventing a wire effort', () => {
    const wire = serializeRequest(request({ messages: history }), { thinking: 'enabled' })
    expect(wire.thinking).toEqual({ type: 'enabled' })
    expect(wire.reasoning_effort).toBeUndefined()
  })

  it('rejects an effort outside the DeepSeek capability', () => {
    expect(() => serializeRequest(request({
      messages: history,
      reasoningEffort: ReasoningEffortId('medium'),
    }))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_REASONING_EFFORT' }))
  })
})

describe('image serialization', () => {
  it.each([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
  ] as const)('preserves ordered text and %s image parts', async (mediaType) => {
    const resolveFileId = fileResolver()
    const ref = imageRef(mediaType)
    const wire = await serializeRequestWithImages(request({
      model: 'deepseek-v4-flash-vision-exp',
      messages: [createUserMessage({
        content: [
          { type: 'text', text: 'before' },
          { type: 'image', attachment: ref },
          { type: 'text', text: 'after' },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), imageOptions([ref], resolveFileId))

    expect(wire.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'before' },
        { type: 'text', text: expect.stringContaining(`Image ${ref.attachmentId}; request preview 1x1px`) as string },
        { type: 'file', file_id: 'file-api-image' },
        { type: 'text', text: 'after' },
      ],
    }])
  })

  it.each([
    ['image/png', 'data:image/png;base64,AAAA'],
    ['image/jpeg', 'data:image/jpeg;base64,AAAA'],
    ['image/webp', 'data:image/webp;base64,AAAA'],
    ['image/gif', 'data:image/gif;base64,AAAA'],
  ] as const)('serializes every retained %s request version as an inline data URL', async (mediaType, url) => {
    const ref = imageRef(mediaType)
    const wire = await serializeRequestWithImages(request({
      model: 'deepseek-v4-flash-vision-exp',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: ref }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), inlineImageOptions([ref]))

    expect(wire.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: expect.stringContaining(`Image ${ref.attachmentId}; request preview 1x1px`) as string },
        { type: 'image_url', image_url: { url } },
      ],
    }])
  })

  it('gives image-only input a stable handle and request dimensions', async () => {
    const ref = imageRef()
    const wire = await serializeRequestWithImages(request({
      model: 'deepseek-v4-flash-vision-exp',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: ref }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), imageOptions([ref]))

    expect(wire.messages).toEqual([{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Image ${ref.attachmentId}; request preview 1x1px. It may be resized or re-encoded; source dimensions, format, and byte size may differ.`,
        },
        { type: 'file', file_id: 'file-api-image' },
      ],
    }])
  })

  it('includes provider-resolved normalized access in a retained image handle', async () => {
    const ref = { ...imageRef(), name: 'diagram.png', width: 2048, height: 1024 }
    const images = imageOptions([ref])
    const version = images.requestImages.get(ref.attachmentId) as RequestImageAttachment
    version.width = 1130
    version.height = 565
    images.resolveImageAccess = () => ({ readonlyPath: '/tmp/dsh/objects/aa/object' })
    const wire = await serializeRequestWithImages(request({
      model: 'deepseek-v4-flash-vision-exp',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: ref }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), images)

    expect(wire.messages[0]).toMatchObject({
      role: 'user',
      content: [{
        type: 'text',
        text: expect.stringContaining('Image "diagram.png"') as string,
      }, { type: 'file' }],
    })
    expect(JSON.stringify(wire.messages[0])).toContain('/tmp/dsh/objects/aa/object')
    expect(JSON.stringify(wire.messages[0])).toContain('request preview 1130x565px')
  })

  it('rejects an image whose prepared request version is absent', async () => {
    const ref = imageRef()
    await expect(serializeMessagesWithImages([createUserMessage({
      content: [{ type: 'image', attachment: ref }],
      source: { kind: 'plugin', plugin: 'test' },
    })], imageOptions([]))).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('keeps tool content textual and groups consecutive tool-result images afterward', async () => {
    const messages = [
      createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: ToolCallId('first'),
          content: [{ type: 'image', attachment: imageRef() }],
        }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
      createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: ToolCallId('second'),
          content: [
            { type: 'text', text: 'caption' },
            { type: 'image', attachment: imageRef('image/jpeg') },
          ],
        }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ]

    const png = imageRef()
    const jpeg = imageRef('image/jpeg')
    await expect(serializeMessagesWithImages(messages, imageOptions(
      [png, jpeg],
      vi.fn((version: RequestImageAttachment) => Promise.resolve(`file-api-${version.mediaType}`)),
    ))).resolves.toEqual([
      {
        role: 'tool',
        tool_call_id: 'first',
        content: expect.stringContaining(`Image ${png.attachmentId}`) as string,
      },
      {
        role: 'tool',
        tool_call_id: 'second',
        content: expect.stringContaining(`caption\nImage ${jpeg.attachmentId}`) as string,
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Attached image(s) from tool result:' },
          { type: 'file', file_id: 'file-api-image/png' },
          { type: 'file', file_id: 'file-api-image/jpeg' },
        ],
      },
    ])
  })

  it('does not emit an empty user message for ignored content beside a tool result', async () => {
    const messages = [createUserMessage({
      content: [
        { type: 'text', text: '' },
        { type: 'chart', data: 'ignored' } as unknown as ContentBlock,
        {
          type: 'tool-result',
          toolCallId: ToolCallId('result'),
          content: [{ type: 'text', text: 'ok' }],
        },
      ],
      source: { kind: 'plugin', plugin: 'test' },
    })]

    await expect(serializeMessagesWithImages(messages, imageOptions([], fileResolver()))).resolves.toEqual([
      { role: 'tool', tool_call_id: 'result', content: 'ok' },
    ])
  })

  it('recursively converts nested tool-result content and preserves the empty fallback', async () => {
    const messages = [createUserMessage({
      content: [
        {
          type: 'tool-result',
          toolCallId: ToolCallId('nested'),
          content: [{
            type: 'tool-result',
            toolCallId: ToolCallId('inner'),
            content: [{ type: 'text', text: 'inside' }],
          }],
        },
        { type: 'tool-result', toolCallId: ToolCallId('empty'), content: [] },
      ],
      source: { kind: 'plugin', plugin: 'test' },
    })]

    await expect(serializeMessagesWithImages(messages, imageOptions([], fileResolver()))).resolves.toEqual([
      { role: 'tool', tool_call_id: 'nested', content: 'inside' },
      { role: 'tool', tool_call_id: 'empty', content: '(no output)' },
    ])
  })

  it('flushes tool-result images before system and assistant history', async () => {
    const imageResult = (id: string) => createUserMessage({
      content: [{
        type: 'tool-result',
        toolCallId: ToolCallId(id),
        content: [{ type: 'image', attachment: imageRef() }],
      }],
      source: { kind: 'plugin' as const, plugin: 'test' },
    })
    const messages = [
      imageResult('before-system'),
      createMessage({
        role: 'system',
        content: [{ type: 'text', text: 'system history' }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
      imageResult('before-assistant'),
      createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'assistant history' }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ]

    const wire = await serializeMessagesWithImages(messages, imageOptions([imageRef()], fileResolver()))
    expect(wire).toEqual([
      {
        role: 'tool',
        tool_call_id: 'before-system',
        content: expect.stringContaining('request preview 1x1px') as string,
      },
      expect.objectContaining({ role: 'user' }),
      { role: 'system', content: 'system history' },
      {
        role: 'tool',
        tool_call_id: 'before-assistant',
        content: expect.stringContaining('request preview 1x1px') as string,
      },
      expect.objectContaining({ role: 'user' }),
      { role: 'assistant', content: 'assistant history' },
    ])
  })

  it('projects surface-offloaded occurrences to placeholders without resolving them', async () => {
    const resolveFileId = fileResolver()
    const png = imageRef('image/png', 3)
    const jpeg = imageRef('image/jpeg', 3)
    const images = imageOptions([png, jpeg], resolveFileId, 4)
    images.resolveImageAccess = ref => ref.mediaType === 'image/png'
      ? { readonlyPath: '/tmp/dsh/objects/png' }
      : undefined
    const wire = await serializeRequestWithImages(request({
      model: 'deepseek-v4-flash-vision-exp',
      messages: [createUserMessage({
        content: [
          { type: 'image', attachment: png, offloaded: true },
          { type: 'image', attachment: jpeg },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), images)

    expect(wire.messages[0]).toMatchObject({
      role: 'user',
      content: [
        {
          type: 'text',
          text: expect.stringContaining(`image omitted to fit request image limits; ${png.attachmentId}. Normalized copy (read-only; may be resized or re-encoded): "/tmp/dsh/objects/png"`) as string,
        },
        { type: 'text', text: expect.stringContaining(`Image ${jpeg.attachmentId}`) as string },
        { type: 'file', file_id: 'file-api-image' },
      ],
    })
    expect(resolveFileId).toHaveBeenCalledTimes(1)
    expect(resolveFileId.mock.calls[0]?.[0]).toMatchObject({ attachment: { mediaType: 'image/jpeg' } })
  })
  it('rejects retained inline images beyond the bound with the quantized count to offload', async () => {
    const ref = imageRef('image/png', 3)
    // 21 retained 3-byte images encode to 84 base64 bytes against an 80-byte bound with a
    // 40-byte quantum: the removal crosses the quantum at the eleventh oldest occurrence.
    await expect(serializeRequestWithImages(request({
      model: 'deepseek-v4-flash-vision-exp',
      messages: [createUserMessage({
        content: Array.from({ length: 21 }, () => ({ type: 'image' as const, attachment: ref })),
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), inlineImageOptions([ref], 80, 40))).rejects.toMatchObject({
      code: 'IMAGE_OFFLOAD_REQUIRED',
      failure: { offloadImages: 11 },
    })
  })

  it('counts only retained occurrences against the bound', async () => {
    const ref = imageRef('image/png', 3)
    const wire = await serializeRequestWithImages(request({
      model: 'deepseek-v4-flash-vision-exp',
      messages: [createUserMessage({
        content: [
          ...Array.from({ length: 11 }, () => ({ type: 'image' as const, attachment: ref, offloaded: true as const })),
          ...Array.from({ length: 10 }, () => ({ type: 'image' as const, attachment: ref })),
        ],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), inlineImageOptions([ref], 80, 40))
    const content = wire.messages[0]?.content
    expect(JSON.stringify(content).match(/image omitted to fit request image limits/g)).toHaveLength(11)
    expect(JSON.stringify(content).match(/"type":"image_url"/g)).toHaveLength(10)
  })
  it('rejects an unprepared image while computing exact request bytes', async () => {
    const ref = imageRef()
    await expect(serializeRequestWithImages(request({
      model: 'deepseek-v4-flash-vision-exp',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: ref }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), imageOptions([]))).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it.each(['system', 'assistant'] as const)('rejects an image in %s history before reading attachments', async (role) => {
    const resolveFileId = vi.fn()
    await expect(serializeMessagesWithImages([createMessage({
      role,
      content: [{ type: 'image', attachment: imageRef() }],
      source: { kind: 'plugin', plugin: 'test' },
    })], imageOptions([imageRef()], resolveFileId)))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    expect(resolveFileId).not.toHaveBeenCalled()
  })

  it('rejects unsupported image history before request offloading can replace it', async () => {
    const resolveFileId = vi.fn()
    await expect(serializeRequestWithImages(request({
      messages: [createMessage({
        role: 'system',
        content: [{ type: 'image', attachment: imageRef('image/png', 300) }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), imageOptions([imageRef('image/png', 300)], resolveFileId, 1)))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    expect(resolveFileId).not.toHaveBeenCalled()
  })

  it('prepends the request system prompt on the image path', async () => {
    const ref = imageRef()
    const wire = await serializeRequestWithImages(request({
      system: 'system prompt',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: ref }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), imageOptions([ref]))
    expect(wire.messages[0]).toEqual({ role: 'system', content: 'system prompt' })
  })

  it('preserves stable file-resolution failure codes', async () => {
    const failure = new Error('Stored attachment bytes are corrupt.') as Error & { code: string }
    failure.code = 'ATTACHMENT_CORRUPT'
    const resolveFileId = vi.fn(() => Promise.reject(failure))
    await expect(serializeMessagesWithImages([createUserMessage({
      content: [{ type: 'image', attachment: imageRef() }],
      source: { kind: 'plugin', plugin: 'test' },
    })], imageOptions([imageRef()], resolveFileId)))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
  })

  it('preserves non-attachment resolver failures', async () => {
    const failure = new Error('resolver failed')
    const resolveFileId = vi.fn(() => Promise.reject(failure))
    await expect(serializeMessagesWithImages([createUserMessage({
      content: [{ type: 'image', attachment: imageRef() }],
      source: { kind: 'plugin', plugin: 'test' },
    })], imageOptions([imageRef()], resolveFileId))).rejects.toBe(failure)
  })
})

describe('review fixes: assistant content shapes', () => {
  it('serializes a content-less, tool-call-less assistant message as "" content, never null', () => {
    // Aborted/empty assistant turns: no text, no calls → "". The earlier
    // null shape was live-falsified: the API 400s a null-content assistant
    // message without tool_calls ("content or tool_calls must be set").
    const wire = serializeMessages([createMessage({
      role: 'assistant', content: [],
      source: { kind: 'plugin', plugin: 'test' },
    })])
    expect(wire).toEqual([{ role: 'assistant', content: '' }])
  })

  it('serializes a reasoning-ONLY assistant message as "" content beside its reasoning', () => {
    // The model can answer entirely in the reasoning channel (a v4-flash
    // greeting did, live). Content must still be SET — a null here poisoned
    // the session log and bricked every later turn of that session.
    const wire = serializeMessages([createMessage({
      role: 'assistant', content: [{ type: 'reasoning', text: '你好！有什么我可以帮你的吗？' }],
      source: { kind: 'plugin', plugin: 'test' },
    })])
    expect(wire).toEqual([{
      role: 'assistant', content: '', reasoning_content: '你好！有什么我可以帮你的吗？',
    }])
  })

  it('serializes tool-call turns with empty string content, not null', () => {
    const wire = serializeMessages([createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: ToolCallId('c'), name: 'f', arguments: '{}' }],
      source: { kind: 'plugin', plugin: 'test' },
    })])
    expect(wire[0]).toMatchObject({ content: '' })
  })
})
