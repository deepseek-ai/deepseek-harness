/** Request conversion and durable replay validation. */
import { describe, expect, it, vi } from 'vitest'
import { createDeveloperMessage, createUserMessage, createAssistantMessage, createMessage, createSystemMessage, createToolResultMessage, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageBlock, Message, RequestMessage, RequestUserInput } from '@deepseek-ai/dsh-llm'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { resolveAdapterOptions } from '../src/config.ts'
import { modelInfo } from '../src/model-info.ts'
import type { Options as Config } from '../src/config.ts'
import { imagePricing, inlineImages, prepareImages } from '../src/images.ts'
import { readReplay, replayState } from '../src/replay.ts'
import { serialize } from '../src/serialize.ts'
import { MODEL, options, user, requestImageStore } from './helpers.ts'

const connection = resolveAdapterOptions({})
const call = (id = 'a'): ContentBlock => ({ type: 'tool-call', id: ToolCallId(id), name: 'read', arguments: '{"path":"a"}' })
const assistant = (content: ContentBlock[]) => createAssistantMessage({ content, source: { provider: 'deepseek-official', model: MODEL } })
const result = (id = 'a', content: ContentBlock[] = [{ type: 'text', text: 'result' }]) => createToolResultMessage({ callId: ToolCallId(id), content, isError: false })
const body = (messages: RequestMessage[] = [user()], overrides: Partial<GenerateOptions> = {}) => serialize(
  options({ messages, ...overrides }), connection, messages, new Map(), () => undefined,
)
const capable = resolveAdapterOptions({ models: [{ id: MODEL, systemPromptUpdate: 'in-history' }] })
const nativeBody = (messages: Message[]) => serialize(options({ messages }), capable, messages, new Map(), () => undefined)

describe('Messages request conversion', () => {
  it('rejects unknown plugin content without interpreting its payload', () => {
    expect(() => body([createUserMessage({ source: { kind: 'user' }, content: [
      { type: 'plugin:text', text: 'opaque' } as never,
    ] })])).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTENT' }))
  })
  it.each(['user', 'system', 'assistant', 'tool'] as const)('rejects tool-change blocks in %s history', (role) => {
    for (const type of ['tool-addition', 'tool-removal'] as const) {
      const content: ContentBlock[] = [{ type, toolName: 'search' }]
      const message = role === 'user' ? createUserMessage({ source: { kind: 'user' }, content })
        : role === 'system' ? createMessage({ role, source: { kind: 'system-prompt' }, content })
          : role === 'assistant' ? assistant(content) : result('invalid', content)
      expect(() => body([message])).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTENT' }))
    }
  })

  it('declares deferred tools with defer_loading and leaves others unmarked', () => {
    const tools = [{ name: 'search', description: 'Search', parameters: {}, deferLoading: true as const }, { name: 'fetch', description: 'Fetch', parameters: {} }]
    expect(body([user()], { tools }).tools).toEqual([
      { name: 'search', description: 'Search', input_schema: {}, defer_loading: true },
      { name: 'fetch', description: 'Fetch', input_schema: {} },
    ])
  })

  it('preserves the exact request with request-only text after durable tool results', () => {
    const prefix = [user(), assistant([call()]), result()]
    const input: RequestUserInput = { role: 'user', content: [{ type: 'text', text: 'review or summarize this input' }] }
    const durable = createUserMessage({ content: input.content, source: { kind: 'user' } })
    expect(body([...prefix, input], { system: 'policy' })).toEqual(body([...prefix, durable], { system: 'policy' }))
  })

  it('preserves request-only image content through image preparation and wire conversion', async () => {
    const attachment: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'e'.repeat(64)}`), mediaType: 'image/png', bytes: 3, width: 1, height: 1,
    }
    const version: RequestImageAttachment = {
      variantId: ImageVariantId(`sha256:${'f'.repeat(64)}`), attachment, data: Uint8Array.of(1, 2, 3),
      mediaType: 'image/png', bytes: 3, width: 1, height: 1, depth: 'uchar', space: 'srgb', hasAlpha: true,
    }
    const input: RequestUserInput = { role: 'user', content: [
      { type: 'text', text: 'before' }, { type: 'image', attachment }, { type: 'text', text: 'after' },
    ] }
    const store = requestImageStore(async () => version)
    const vision = resolveAdapterOptions({ models: [{ id: MODEL, inputModalities: ['text', 'image'] }] })
    const durable = createUserMessage({ content: input.content, source: { kind: 'user' } })
    const actual = await prepareImages([input], vision, MODEL, store, () => undefined, new AbortController().signal)
    const expected = await prepareImages([durable], vision, MODEL, store, () => undefined, new AbortController().signal)
    expect(serialize(options({ messages: [input] }), vision, actual.messages, actual.versions, () => undefined))
      .toEqual(serialize(options({ messages: [durable] }), vision, expected.messages, expected.versions, () => undefined))
    expect(actual.messages[0]).toBe(input)
    expect(input).not.toHaveProperty('id')
    expect(input).not.toHaveProperty('source')
  })

  it('places developer tool changes as a system update after the preceding user turn', () => {
    const developer = (content: ContentBlock[]) => createDeveloperMessage({ content, source: { kind: 'tool-registry' } })
    const changes = developer([
      { type: 'tool-addition', toolName: 'search' }, { type: 'tool-removal', toolName: 'fetch' },
      { type: 'text', text: '' }, { type: 'text', text: 'search replaces fetch' },
    ])
    expect(body([user(), changes, assistant([{ type: 'text', text: 'ok' }])]).messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'system', content: [
        { type: 'tool_addition', tool: { type: 'tool_reference', name: 'search' } },
        { type: 'tool_removal', tool: { type: 'tool_reference', name: 'fetch' } },
        { type: 'text', text: 'search replaces fetch' },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ])
    expect(body([user(), developer([{ type: 'text', text: '' }])]).messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }])
    expect(body([changes, user()]).messages.map(message => message.role)).toEqual(['user', 'system'])
    expect(() => body([changes])).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTENT' }))
    expect(() => body([user(), developer([{ type: 'plugin:note', text: 'x' } as never])]))
      .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTENT' }))
  })

  it('keeps the original top-level prompt and cached prefix while appending native system updates', () => {
    const head = createSystemMessage('original')
    const first = [head, user('first')]
    const update = createSystemMessage('updated')
    const second = [...first, assistant([{ type: 'text', text: 'one' }]), update, user('second')]
    const saved = JSON.stringify(second)
    const before = nativeBody(first)
    const after = nativeBody(second)
    expect(after.system).toBe(before.system)
    expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages)
    expect(after.messages.slice(-2)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
      { role: 'system', content: [{ type: 'text', text: 'updated' }] },
    ])
    const third = nativeBody([...second, assistant([{ type: 'text', text: 'two' }]), user('third')])
    expect(third.messages.slice(0, after.messages.length)).toEqual(after.messages)
    expect(JSON.stringify(second)).toBe(saved)
  })

  it('places system updates after all parallel tool results and before the next assistant', () => {
    const history = [createSystemMessage('original'), user(), assistant([call(), call('b')]),
      createSystemMessage('first update'), result(), createSystemMessage('second update'), result('b'),
      user('more input'), assistant([{ type: 'text', text: 'done' }])]
    const request = nativeBody(history)
    expect(request.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'system', 'system', 'assistant'])
    expect(request.messages[2]?.content.map(block => block.type)).toEqual(['tool_result', 'tool_result', 'text'])
    expect(request.messages.slice(3, 5).map(message => message.content)).toEqual([
      [{ type: 'text', text: 'first update' }], [{ type: 'text', text: 'second update' }],
    ])
  })

  it('accepts native trailing updates without a top-level prompt and rejects unrepresentable positions', () => {
    const update = createSystemMessage('update')
    expect(nativeBody([user(), update])).toMatchObject({ messages: [
      { role: 'user' }, { role: 'system', content: [{ type: 'text', text: 'update' }] },
    ] })
    expect(nativeBody([user(), update]).system).toBeUndefined()
    expect(() => nativeBody([user(), assistant([{ type: 'text', text: 'done' }]), update])).toThrow(/preceding user/)
    expect(() => nativeBody([user(), createSystemMessage('')])).toThrow(/empty in-history/)
    expect(() => nativeBody([user(), assistant([call(), call('b')]), update, result()])).toThrow(/immediate results/)
  })

  it.each([[], [{ type: 'reasoning', text: 'child reasoning' }], [call('child-call')]] satisfies ContentBlock[][])(
    'rejects native system updates when their user input is omitted %#', (...content) => {
      const empty = createMessage({ role: 'user', source: { kind: 'user' }, content })
      const history = [user(), assistant([{ type: 'text', text: 'answer' }]), createSystemMessage('updated'), empty]
      const saved = JSON.stringify(history)
      for (const messages of [history, [...history, assistant([{ type: 'text', text: 'next answer' }])]]) {
        expect(() => nativeBody(messages)).toThrow(expect.objectContaining({
          code: 'UNSUPPORTED_CONTENT',
          message: 'DeepSeek Messages cannot represent system update without a preceding user or tool-result turn',
        }))
      }
      expect(JSON.stringify(history)).toBe(saved)
    },
  )

  it('keeps native system updates after retained text or tool results beside omitted user input', () => {
    const reasoning: ContentBlock = { type: 'reasoning', text: 'child reasoning' }
    const empty = createMessage({ role: 'user', source: { kind: 'user' }, content: [reasoning] })
    const update = createSystemMessage('updated')
    for (const [previous, retained, expected] of [
      [assistant([{ type: 'text', text: 'answer' }]), user('continue'), [{ type: 'text', text: 'continue' }]],
      [assistant([call()]), result('a', [reasoning]), [{ type: 'tool_result', tool_use_id: 'a', content: [], is_error: false }]],
    ] as const) {
      const history = [user(), previous, update, empty, retained, assistant([{ type: 'text', text: 'done' }])]
      const saved = JSON.stringify(history)
      const request = nativeBody(history)
      expect(request.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'system', 'assistant'])
      expect(request.messages[2]?.content).toEqual(expected)
      expect(request.messages[3]?.content).toEqual([{ type: 'text', text: 'updated' }])
      expect(JSON.stringify(history)).toBe(saved)
    }
  })

  it('groups parallel results before ordinary text and keeps tool failure content', () => {
    const messages = [user(), assistant([call(), call('b')]), user('follow-up'), result(), createToolResultMessage({ callId: ToolCallId('b'), content: [{ type: 'text', text: 'permission denied' }], isError: true })]
    expect(body(messages).messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: ['a', 'b'].map(id => ({ type: 'tool_use', id, name: 'read', input: { path: 'a' } })) },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'result' }], is_error: false },
        { type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: 'permission denied' }], is_error: true },
        { type: 'text', text: 'follow-up' },
      ] },
    ])
    expect(messages[2]?.content).toEqual([{ type: 'text', text: 'follow-up' }])
  })

  it('preserves empty results without inventing model-visible output', () => {
    const response = body([user(), assistant([call()]), result('a', [])])
    expect(response.messages[2]?.content[0]).toMatchObject({ content: [] })
    const { isError: _isError, ...minimal } = createToolResultMessage({ callId: ToolCallId('a'), content: [{ type: 'text', text: '' }], isError: false })
    expect(body([assistant([call()]), minimal]).messages[1]?.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'a', content: [] })
  })

  it('omits assistant-only blocks from user input while preserving text and durable content', () => {
    const history = [createMessage({ role: 'user', source: { kind: 'user' }, content: [
      { type: 'text', text: 'Background subagent finished.\n' },
      { type: 'reasoning', text: 'child reasoning' },
      call('child-call'),
      { type: 'text', text: '  child answer  ' },
    ] })]
    const saved = JSON.stringify(history)

    expect(body(history).messages).toEqual([{ role: 'user', content: [
      { type: 'text', text: 'Background subagent finished.\n' },
      { type: 'text', text: '  child answer  ' },
    ] }])
    expect(JSON.stringify(history)).toBe(saved)
  })

  it('omits assistant-only blocks inside tool results while retaining calls, errors and empty results', () => {
    const reasoning: ContentBlock = { type: 'reasoning', text: 'tool reasoning' }
    const history = [assistant([reasoning, call(), call('b')]),
      createToolResultMessage({ callId: ToolCallId('a'), content: [reasoning, call('nested-call'), { type: 'text', text: '  result\n' }], isError: true }),
      result('b', [reasoning, call('another-nested-call')]),
    ]
    const saved = JSON.stringify(history)

    expect(body(history).messages).toEqual([
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'tool reasoning' },
        ...['a', 'b'].map(id => ({ type: 'tool_use', id, name: 'read', input: { path: 'a' } })),
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: '  result\n' }], is_error: true },
        { type: 'tool_result', tool_use_id: 'b', content: [], is_error: false },
      ] },
    ])
    expect(JSON.stringify(history)).toBe(saved)
  })

  it.each([
    [], [{ type: 'reasoning', text: 'child reasoning' }], [call('child-call')],
  ] satisfies ContentBlock[][])('omits empty user input after conversion %#', (...content) => {
    const empty = createMessage({ role: 'user', source: { kind: 'user' }, content })
    expect(body([empty, user(), assistant([{ type: 'text', text: 'answer' }]), empty]).messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ])
  })

  it('collects leading system text and maps tools, stop sequences and explicit output cap', () => {
    const system = createMessage({ role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'instructions' }] })
    expect(body([system, user()], { system: 'top', maxTokens: 123, stop: ['END'], tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }] })).toMatchObject({
      system: 'top\n\ninstructions', max_tokens: 123, stop_sequences: ['END'], tools: [{ name: 'read', description: 'Read a file', input_schema: { type: 'object' } }],
    })
    expect(body([user(), system]).system).toBe('instructions')
  })

  it('uses the latest complete system snapshot without changing tool history or durable messages', () => {
    const conversation = [user(), assistant([call()]), result(), assistant([{ type: 'text', text: 'done' }]), user('continue')]
    const history = [createSystemMessage('obsolete'), ...conversation.slice(0, 2),
      createSystemMessage('intermediate'), ...conversation.slice(2, 4),
      createSystemMessage('current'), conversation[4]!]
    const saved = JSON.stringify(history)
    expect(body(history)).toEqual({ ...body(conversation), system: 'current' })
    expect(body(history, { system: 'one-shot prefix' }).system).toBe('one-shot prefix\n\ncurrent')
    expect(JSON.stringify(history)).toBe(saved)
  })

  it('replaces adjacent system snapshots and joins blocks only within the current snapshot', () => {
    const latest = createMessage({ role: 'system', source: { kind: 'system-prompt' },
      content: [{ type: 'text', text: 'part one' }, { type: 'text', text: ' and part two' }] })
    expect(body([createSystemMessage('old'), latest, user()]).system).toBe('part one and part two')
  })

  it.each([[], [{ type: 'text' as const, text: '' }]].map(content => ({ content })))('clears earlier prompt snapshots with empty content %#', ({ content }) => {
    const cleared = createMessage({ role: 'system', source: { kind: 'system-prompt' }, content })
    const history = [createSystemMessage('old'), user(), cleared]
    expect(body(history).system).toBeUndefined()
    expect(body(history, { system: 'one-shot prefix' }).system).toBe('one-shot prefix')
    expect(body(history, { system: '' }).system).toBeUndefined()
  })

  it('rejects non-text system content even when a later snapshot supersedes it', () => {
    const invalid = createMessage({ role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'reasoning', text: 'bad' }] })
    expect(() => body([invalid, user(), createSystemMessage('current')])).toThrow(/non-text system/)
  })

  it.each(['off', 'low', 'high', 'max'])('maps reasoning effort %s', (effort) => {
    const request = body([user()], { reasoningEffort: ReasoningEffortId(effort) })
    expect(request.thinking.type).toBe(effort === 'off' ? 'disabled' : 'enabled')
    expect(request.output_config).toEqual(effort === 'off' ? undefined : { effort })
  })

  it('disables thinking for titles, passes temperature with thinking and refuses unsupported effort', () => {
    expect(body([user()], { purpose: 'session-title', temperature: 0 })).toMatchObject({ thinking: { type: 'disabled' }, temperature: 0 })
    expect(body([user()], { temperature: 0 })).toMatchObject({ thinking: { type: 'enabled' }, temperature: 0 })
    expect(() => body([user()], { reasoningEffort: ReasoningEffortId('medium') })).toThrow(/effort/)
    const disabled = resolveAdapterOptions({ thinking: 'disabled' })
    expect(serialize(options(), disabled, [user()], new Map(), () => undefined).thinking).toEqual({ type: 'disabled' })
    expect(() => serialize(options({ reasoningEffort: ReasoningEffortId('high') }), disabled, [user()], new Map(), () => undefined)).toThrow(/effort/)
    const capped = resolveAdapterOptions({ models: [{ id: MODEL, maxTokens: 321 }] })
    expect(serialize(options(), capped, [user()], new Map(), () => undefined).max_tokens).toBe(321)
  })

  it.each([
    [result()], [assistant([call()])], [assistant([call()]), user()],
    [assistant([call(), call()]), result()],
    [assistant([call()]), result(), result()],
  ])('rejects unmatched or duplicated tool history %#', (...messages) => {
    expect(() => body(messages)).toThrow(/tool/)
  })

  it.each(['{', '', '[]', 'null', '42', 'true', '"text"', '{"description":"最快，但"某个说法"没有证据。"}'])('uses empty input for malformed or non-object historical tool arguments %s', (arguments_) => {
    const message = assistant([{ type: 'tool-call', id: ToolCallId('a'), name: 'read', arguments: arguments_ }])
    const history = [user(), message, createToolResultMessage({ callId: ToolCallId('a'), content: [{ type: 'text', text: 'Invalid arguments' }], isError: true }), user('Continue')]
    const saved = JSON.stringify(history)
    const restored = JSON.parse(saved) as Message[]
    expect(body(restored).messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'read', input: {} }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'Invalid arguments' }], is_error: true },
        { type: 'text', text: 'Continue' },
      ] },
    ])
    expect(JSON.stringify(restored)).toBe(saved)
  })

  it('preserves own signed thinking, omits absent signatures and validates durable metadata', () => {
    const content: ContentBlock[] = [{ type: 'reasoning', text: '' }, { type: 'text', text: 'answer' }]
    const source = { provider: 'deepseek-official', model: MODEL, replayState: replayState(MODEL, [{ type: 'reasoning', signature: 'signed' }, { type: 'text' }]) }
    const message = createAssistantMessage({ content, source })
    expect(body([user(), message, user()]).messages[1]?.content).toEqual([{ type: 'thinking', thinking: '', signature: 'signed' }, { type: 'text', text: 'answer' }])
    expect(body([assistant([{ type: 'reasoning', text: 'foreign thought' }])]).messages[0]?.content).toEqual([{ type: 'thinking', thinking: 'foreign thought' }])
    expect(readReplay(message, 'different-model')).toBeUndefined()
    expect(readReplay(user(), MODEL)).toBeUndefined()
  })

  it.each([
    null,
    [],
    { response: null, blocks: [] },
    { response: { kind: 'other', version: 1 }, blocks: [] },
    { response: { kind: 'deepseek-messages', version: 2 }, blocks: [] },
    { response: { kind: 'deepseek-messages', version: 1, model: 'wrong' }, blocks: [] },
    { response: { kind: 'deepseek-messages', version: 1, model: MODEL }, blocks: [] },
    { response: { kind: 'deepseek-messages', version: 1, model: MODEL }, blocks: null },
    { response: { kind: 'deepseek-messages', version: 1, model: MODEL }, blocks: [null] },
    { response: { kind: 'deepseek-messages', version: 1, model: MODEL }, blocks: [{ type: 'tool-call' }] },
    { response: { kind: 'deepseek-messages', version: 1, model: MODEL }, blocks: [{ type: 'reasoning', signature: 3 }] },
  ].map(state => ({ state })))('degrades unusable replay state with a diagnostic %#', ({ state }) => {
    const message = createAssistantMessage({ content: [{ type: 'reasoning', text: 'think' }], source: { provider: 'deepseek-official', model: MODEL, replayState: state } })
    const onDegrade = vi.fn()
    expect(readReplay(message, MODEL, onDegrade)).toBeUndefined()
    expect(onDegrade).toHaveBeenCalledExactlyOnceWith(expect.any(String))
    expect(body([message]).messages[0]?.content).toEqual([{ type: 'thinking', thinking: 'think' }])
  })

  it.each([MODEL, 'different-model'])('keeps durable content when replay degrades for %s', async (model) => {
    const message = createAssistantMessage({
      content: [{ type: 'reasoning', text: 'Read the file.' }, { type: 'text', text: 'Checking a.' }, call()],
      source: { provider: 'deepseek-official', model: MODEL, replayState: replayState(MODEL, [
        { type: 'reasoning', signature: 'do-not-send' }, { type: 'text', signature: 'invalid-for-text' }, { type: 'tool-call' },
      ]) },
    })
    const saved = JSON.stringify(message)
    const restored = JSON.parse(saved) as Message
    const messages = [user(), restored, result()]
    const onDegrade = vi.fn()
    const request = serialize(options({ model }), connection, messages, new Map(), () => undefined, onDegrade)
    expect(onDegrade).toHaveBeenCalledExactlyOnceWith('DeepSeek Messages replay: invalid signature')
    await expect(JSON.stringify(request.messages, null, 2) + '\n').toMatchFileSnapshot('expected/degraded-replay.json')
    expect(JSON.stringify(restored)).toBe(saved)
  })

  it('keeps valid cross-model and foreign history quiet and propagates diagnostic failures', () => {
    const onDegrade = vi.fn()
    const message = createAssistantMessage({ content: [{ type: 'reasoning', text: 'think' }], source: {
      provider: 'deepseek-official', model: MODEL, replayState: replayState(MODEL, [{ type: 'reasoning', signature: '' }]),
    } })
    expect(readReplay(message, MODEL, onDegrade)).toEqual([{ type: 'reasoning', signature: '' }])
    expect(readReplay(message, 'different-model', onDegrade)).toBeUndefined()
    expect(readReplay(assistant([{ type: 'text', text: 'foreign' }]), MODEL, onDegrade)).toBeUndefined()
    expect(onDegrade).not.toHaveBeenCalled()
    const damaged = { ...message, source: { ...message.source, replayState: { response: {}, blocks: [] } } }
    const failure = new Error('diagnostic failed')
    expect(() => readReplay(damaged, MODEL, () => { throw failure })).toThrow(failure)
  })

  it.each([1, 2])('uses empty historical tool input with replay version %s', (version) => {
    const message = createAssistantMessage({ content: [{ type: 'tool-call', id: ToolCallId('a'), name: 'read', arguments: '{' }], source: {
      provider: 'deepseek-official', model: MODEL, replayState: { response: { kind: 'deepseek-messages', version, model: MODEL }, blocks: [{ type: 'tool-call' }] },
    } })
    const saved = JSON.stringify(message)
    const onDegrade = vi.fn()
    const request = serialize(options(), connection, [message, result()], new Map(), () => undefined, onDegrade)
    expect(request.messages[0]?.content).toEqual([{ type: 'tool_use', id: 'a', name: 'read', input: {} }])
    expect(onDegrade).toHaveBeenCalledTimes(version === 1 ? 0 : 1)
    expect(JSON.stringify(message)).toBe(saved)
  })
})

describe('validated configuration', () => {
  it('advertises exact model metadata and allows unlisted text models', () => {
    expect(modelInfo(connection, 'deepseek-official', MODEL)).toMatchObject({ context: { contextWindow: 1_000_000 }, defaultMaxTokens: 256_000, reasoning: { defaultEffort: 'high' } })
    expect(modelInfo(connection, 'deepseek-official', 'custom').inputModalities).toEqual(['text'])
    expect(modelInfo(connection, 'deepseek-official', MODEL).systemPromptUpdate).toBeUndefined()
    expect(modelInfo(connection, 'deepseek-official', 'custom').systemPromptUpdate).toBeUndefined()
    expect(modelInfo(capable, 'deepseek-official', MODEL).systemPromptUpdate).toBe('in-history')
    expect(modelInfo(capable, 'deepseek-official', 'custom').systemPromptUpdate).toBeUndefined()
    expect(modelInfo(connection, 'deepseek-official', MODEL).toolUpdate).toBeUndefined()
    expect(modelInfo(connection, 'deepseek-official', 'deepseek-flash').toolUpdate).toBe('addition-only')
    const inHistoryTools = resolveAdapterOptions({ models: [{ id: MODEL, toolUpdate: 'in-history' }] })
    expect(modelInfo(inHistoryTools, 'deepseek-official', MODEL).toolUpdate).toBe('in-history')
    expect(modelInfo(inHistoryTools, 'deepseek-official', 'custom').toolUpdate).toBeUndefined()
    expect(modelInfo(resolveAdapterOptions({ thinking: 'disabled' }), 'deepseek-official', MODEL).reasoning?.efforts).toMatchObject([{ id: 'off', name: 'Off' }])
    expect(resolveAdapterOptions({ baseURL: 'https://example.com/anthropic///' }).baseURL).toBe('https://example.com/anthropic///')
  })
  it.each([
    { thinking: 'disabled', reasoningEffort: 'high' }, { models: [{ id: '' }] },
    { models: [{ id: 'a' }, { id: 'a' }] }, { models: [{ id: 'a', name: '' }] },
    { maxInlineRequestImageBytes: 1 }, { maxImagesPerRequest: 1 },
    { baseURL: 'ftp://example.com' }, { baseURL: 'https://user:pass@example.com' },
    { baseURL: 'https://example.com/?key=x' }, { baseURL: 'https://example.com/#x' },
    { maxTokens: 0 }, { streamIdleTimeoutMs: 0 },
    { models: [{ id: MODEL, systemPromptUpdate: 'unsupported' }] },
    { models: [{ id: MODEL, toolUpdate: 'unsupported' }] },
  ])('rejects invalid composition input %#', (value) => {
    expect(() => resolveAdapterOptions(value as Config)).toThrow()
  })
})

describe('Messages images', () => {
  const ref: ImageAttachmentRef = { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png', width: 1, height: 1, bytes: 3 }
  const image: ImageBlock = { type: 'image', attachment: ref }
  const version: RequestImageAttachment = { attachment: ref, variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`), mediaType: 'image/png', bytes: 3, data: Uint8Array.of(1, 2, 3), width: 1, height: 1, depth: 'uchar', space: 'srgb', hasAlpha: false }
  const access = () => ({ readonlyPath: '/workspace/image.png' })
  const model = 'deepseek-flash'
  // Only the read operation is consumed by image preparation; the transport is mocked, not durable content.
  const attachments = requestImageStore(async () => version)
  const signal = new AbortController().signal
  it('keeps image bytes inside tool results and deduplicates normalization', async () => {
    const history = [assistant([call()]), result('a', [image, image])]
    const prepared = await prepareImages(history, connection, model, attachments, access, signal)
    expect(prepared.versions.size).toBe(1)
    const request = serialize(options({ model }), connection, prepared.messages, prepared.versions, access)
    expect(request.messages[1]?.content[0]).toMatchObject({ type: 'tool_result', content: [
      { type: 'text', text: expect.stringContaining('/workspace/image.png') as string }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
      { type: 'text' }, { type: 'image' },
    ] })
    expect(imagePricing(connection, model, access).priceImages([image])[0]?.visualTokens).toBeGreaterThan(0)
    expect(imagePricing(connection, MODEL, access).priceImages([image])[0]?.visualTokens).toBe(0)
  })
  it('requires logged offload at exact encoded bytes and preserves durable references', async () => {
    const config = resolveAdapterOptions({
      maxInlineRequestImageBytes: 4, inlineImageOffloadByteQuantum: 1, maxImagesPerRequest: 2, imageOffloadCountQuantum: 1,
    })
    const offloadFailure: unknown = expect.objectContaining({ code: 'IMAGE_OFFLOAD_REQUIRED', offloadImages: 1 })
    const history = [result('a', [image, image])]
    const prepared = await prepareImages(history, config, model, attachments, access, signal)
    expect(prepared.messages[0]?.content).toMatchObject([image, image])
    expect(() => inlineImages(prepared.messages, prepared.versions, config)).toThrow(expect.objectContaining({
      failure: offloadFailure,
    }))
    const offloaded: ImageBlock = { ...image, offloaded: true }
    const retry = await prepareImages([result('a', [offloaded, image])], config, model, attachments, access, signal)
    expect(inlineImages(retry.messages, retry.versions, config)[0]?.content).toMatchObject([{ type: 'text' }, { type: 'image' }])
    expect(history[0]?.content).toMatchObject([image, image])
    expect(imagePricing(config, model, access).priceImages([image, image]).map(entry => entry.visualTokens))
      .toEqual([expect.any(Number), expect.any(Number)])
    const large = requestImageStore(async () => ({ ...version, bytes: 30, data: new Uint8Array(30) }))
    const exact = await prepareImages([result('a', [image])], config, model, large, access, signal)
    expect(() => inlineImages(exact.messages, exact.versions, config)).toThrow(expect.objectContaining({
      failure: offloadFailure,
    }))
  })
  it('rejects unsupported roles and unavailable image capabilities before HTTP', async () => {
    const history = [result('a', [image])]
    await expect(prepareImages(history, connection, MODEL, attachments, access, signal)).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    await expect(prepareImages(history, connection, model, undefined, access, signal)).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    await expect(prepareImages([assistant([image])], connection, model, attachments, access, signal)).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    expect(() => body([result('a', [image])])).toThrow(/image/)
    expect(() => body([assistant([image])])).toThrow(/assistant/)
    // @ts-expect-error -- malformed provider input can carry a retired nested result block.
    expect(() => body([result('a', [{ type: 'tool-result', toolCallId: ToolCallId('nested'), content: [] }])]))
      .toThrow(/user\/tool-result content tool-result/)
    expect(() => serialize(options({ model }), connection, [result('a', [image])], new Map([[ref.attachmentId, version]]), access, undefined, new Map()))
      .toThrow(/request file id is missing/)
  })
})
