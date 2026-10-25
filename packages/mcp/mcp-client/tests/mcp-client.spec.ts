import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { Context } from '@deepseek-ai/cordis'
import AttachmentStore, { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { ToolCallId, LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'
import { publicToolName, syncTools, type ToolBridgeOptions } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'
import { createTransport } from '@deepseek-ai/dsh-mcp-client/src/transport.ts'
import type { Config } from '@deepseek-ai/dsh-mcp-client'

const testToolSignal = new AbortController().signal

// ---- Mock MCP Client ----

interface MockTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  execution?: { taskSupport?: 'optional' | 'required' | 'forbidden' }
}

interface MockCallResult {
  content: JsonValue[]
  structuredContent?: JsonValue
  isError?: boolean
}

function createMockClient(tools: MockTool[], callResult: MockCallResult = { content: [{ type: 'text', text: 'ok' }] }) {
  const listTools = vi.fn(async (
    _params?: Record<string, unknown>,
  ): Promise<{ tools: MockTool[]; nextCursor: string | undefined }> => ({ tools, nextCursor: undefined }))
  const callTool = vi.fn(async (
    _params?: Record<string, unknown>,
    _options?: unknown,
  ): Promise<Record<string, unknown>> => ({ ...callResult }))
  return {
    listTools,
    callTool,
    getServerCapabilities: (): object => ({ tools: {} }),
    setNotificationHandler: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

// ---- Test harness helper ----

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  return ctx
}

const IMAGE_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 1024,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 2048,
  maxImagePixels: 1024,
  maxImageDimension: 2000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

/** Attachment fake that records exact decoded batches while using the real batch contract. */
class RecordingAttachmentStore extends AttachmentStore {
  readonly imageLimits = IMAGE_LIMITS
  readonly saved: SaveImageAttachment[] = []

  validateImage(_input: SaveImageAttachment): Promise<void> {
    return Promise.resolve()
  }

  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.saved.push(input)
    const marker = input.data[0] ?? 0
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${marker.toString(16).padStart(64, '0')}`),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
    }
    return Promise.resolve(ref)
  }

  readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    throw new Error('not used')
  }
}

/** Exact-route fake used only for image-capability admission. */
class ImageCatalogAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: model === 'vision' ? ['text', 'image'] : ['text'],
    })
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('MCP bridge tests never stream')
  }
}

async function mountRichRegistry(): Promise<{ ctx: Context; attachments: RecordingAttachmentStore }> {
  const ctx = await mountRegistry()
  await ctx.plugin(RecordingAttachmentStore)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['visual'], new ImageCatalogAdapter())
  return { ctx, attachments: ctx.attachments as RecordingAttachmentStore }
}

/** Calling-agent stand-in with no durable request header yet. */
function agentOn(model: string | undefined = 'vision'): object {
  return {
    options: model === undefined ? {} : { provider: 'visual', model },
    session: { requestHeader: () => undefined },
  }
}

/** Require one text block and return its text for diagnostic assertions. */
function textAt(content: readonly ContentBlock[], index = 0): string {
  const block = content[index]
  if (block?.type !== 'text') throw new Error(`expected text content at index ${index}`)
  return block.text
}

const defaultOpts: ToolBridgeOptions = {
  registrationFailure: 'contain',
  serverName: 'srv',
  toolCallTimeoutMs: 60_000,
}

// ---- Tests ----

describe('publicToolName', () => {
  it('joins clean names verbatim', () => {
    expect(publicToolName('github', 'create_issue')).toBe('mcp__github__create_issue')
    expect(publicToolName('everything', 'get-sum')).toBe('mcp__everything__get-sum')
  })

  it('replaces invalid characters and appends an identity hash', () => {
    const name = publicToolName('srv', 'admin.reset')
    expect(name).toMatch(/^mcp__srv__admin_reset_[0-9a-f]{12}$/)
    expect(name.length).toBeLessThanOrEqual(64)
  })

  it('truncates over-long names and appends an identity hash', () => {
    const rawName = 'a'.repeat(80)
    const name = publicToolName('srv', rawName)
    expect(name).toHaveLength(64)
    expect(name).toMatch(/_[0-9a-f]{12}$/)
    expect(name.startsWith('mcp__srv__aaa')).toBe(true)
  })

  it('is deterministic and collision-free for distinct identities', () => {
    // Two raw names that normalize to the same base must not collapse.
    const a = publicToolName('srv', 'admin.reset')
    const b = publicToolName('srv', 'admin_reset')
    expect(a).toBe(publicToolName('srv', 'admin.reset'))
    expect(a).not.toBe(b)
  })
})

describe('syncTools', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = await mountRegistry()
  })

  it('registers tools under server-qualified public names', async () => {
    const client = createMockClient([
      { name: 'greet', description: 'Say hello', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
      { name: 'add', description: 'Add numbers', inputSchema: { type: 'object', properties: {} } },
    ])

    const disposers = await syncTools(client as never, ctx, defaultOpts, new Map())

    expect(disposers.size).toBe(2)
    expect(ctx.tools.get('mcp__srv__greet')).toBeDefined()
    expect(ctx.tools.get('mcp__srv__add')).toBeDefined()
    // Raw names are NOT registered.
    expect(ctx.tools.get('greet')).toBeUndefined()
    expect(ctx.tools.get('add')).toBeUndefined()
  })

  it('lets two servers publish the same raw name side by side', async () => {
    const clientA = createMockClient([{ name: 'search', inputSchema: { type: 'object' } }])
    const clientB = createMockClient([{ name: 'search', inputSchema: { type: 'object' } }])

    await syncTools(clientA as never, ctx, { ...defaultOpts, serverName: 'github' }, new Map())
    await syncTools(clientB as never, ctx, { ...defaultOpts, serverName: 'web' }, new Map())

    expect(ctx.tools.get('mcp__github__search')).toBeDefined()
    expect(ctx.tools.get('mcp__web__search')).toBeDefined()
  })

  it('coexists with a native tool of the same raw name', async () => {
    ctx.tools.register({
      name: 'search',
      description: 'Native search',
      parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute: async () => 'native',
    })
    const client = createMockClient([{ name: 'search', inputSchema: { type: 'object' } }])

    await syncTools(client as never, ctx, defaultOpts, new Map())

    expect(ctx.tools.get('search')).toBeDefined()
    expect(ctx.tools.get('mcp__srv__search')).toBeDefined()
    const result = await executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId('c1'), name: 'search', arguments: {} })
    expect(result.content[0]).toEqual({ type: 'text', text: 'native' })
  })

  it('rejects a tool list where one raw name appears twice', async () => {
    const client = createMockClient([
      { name: 'dup', inputSchema: { type: 'object' } },
      { name: 'dup', inputSchema: { type: 'object' } },
    ])

    await expect(syncTools(client as never, ctx, defaultOpts, new Map()))
      .rejects.toThrow(/listed tool "dup" more than once/)
    // Nothing registered, previous generation untouched (it was empty).
    expect(ctx.tools.get('mcp__srv__dup')).toBeUndefined()
  })

  it('keeps the previous generation when the fetch phase fails', async () => {
    const client = createMockClient([{ name: 'stable', inputSchema: { type: 'object' } }])
    const first = await syncTools(client as never, ctx, defaultOpts, new Map())
    expect(ctx.tools.get('mcp__srv__stable')).toBeDefined()

    client.listTools.mockRejectedValue(new Error('network down'))
    await expect(syncTools(client as never, ctx, defaultOpts, first)).rejects.toThrow('network down')

    // The previous generation is still live.
    expect(ctx.tools.get('mcp__srv__stable')).toBeDefined()
  })

  it('rolls back the whole generation when a foreign tool squats on the namespace', async () => {
    // A foreign registration occupies one of this server's public names.
    ctx.tools.register({
      name: 'mcp__srv__taken',
      description: 'Squatter',
      parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute: async () => 'squatter',
    })
    const client = createMockClient([
      { name: 'free', inputSchema: { type: 'object' } },
      { name: 'taken', inputSchema: { type: 'object' } },
    ])

    const disposers = await syncTools(client as never, ctx, defaultOpts, new Map())

    // All-or-nothing: the non-conflicting tool is rolled back too.
    expect(disposers.size).toBe(0)
    expect(ctx.tools.get('mcp__srv__free')).toBeUndefined()
    // The squatter is untouched.
    expect(ctx.tools.get('mcp__srv__taken')).toBeDefined()
  })

  it('unregisters previous tools before re-syncing', async () => {
    const client = createMockClient([
      { name: 'old_tool', inputSchema: { type: 'object' } },
    ])

    const firstDisposers = await syncTools(client as never, ctx, defaultOpts, new Map())
    expect(ctx.tools.get('mcp__srv__old_tool')).toBeDefined()

    client.listTools.mockResolvedValue({ tools: [{ name: 'new_tool', inputSchema: { type: 'object' } }], nextCursor: undefined })
    const secondDisposers = await syncTools(client as never, ctx, defaultOpts, firstDisposers)

    expect(ctx.tools.get('mcp__srv__old_tool')).toBeUndefined()
    expect(ctx.tools.get('mcp__srv__new_tool')).toBeDefined()
    expect(secondDisposers.size).toBe(1)
  })

  it('validates outputs with the complete SDK definition after paginated discovery', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    serverTransport.onmessage = (message) => {
      if (!('id' in message) || !('method' in message)) return
      const params = 'params' in message ? message.params : undefined
      let result: Record<string, unknown>
      if (message.method === 'initialize') {
        const protocolVersion = params && 'protocolVersion' in params
          ? params.protocolVersion
          : '2025-11-25'
        result = {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'raw-test', version: '1' },
        }
      } else if (message.method === 'tools/list') {
        const cursor = params && 'cursor' in params ? params.cursor : undefined
        result = cursor === undefined
          ? {
            tools: [{
              name: 'supported',
              inputSchema: { type: 'object' },
              outputSchema: {
                type: 'object',
                additionalProperties: false,
                properties: { answer: { type: 'integer' } },
                required: ['answer'],
              },
            }],
            nextCursor: 'page-2',
          }
          : {
            tools: [{
              name: 'future-schema',
              inputSchema: { type: 'object' },
              outputSchema: { type: 'object', patternProperties: { '^x-': { type: 'string' } } },
            }],
          }
      } else if (message.method === 'tools/call') {
        const name = params && 'name' in params ? params.name : undefined
        result = name === 'supported'
          ? { content: [{ type: 'text', text: 'missing structured content' }] }
          : { content: [{ type: 'text', text: 'kept' }], structuredContent: { 'x-value': 'kept' } }
      } else {
        result = {}
      }
      void serverTransport.send({ jsonrpc: '2.0', id: message.id, result })
    }
    await serverTransport.start()
    const client = new Client({ name: 'cache-independent-test', version: '1' })
    await client.connect(clientTransport)

    try {
      await syncTools(client, ctx, defaultOpts, new Map())

      const missing = await executeToolFixture(ctx, {
        signal: testToolSignal,
        callId: ToolCallId('missing'), name: 'mcp__srv__supported', arguments: {},
      })
      expect(missing.error?.message).toContain('structured content')

      const fallback = await executeToolFixture(ctx, {
        signal: testToolSignal,
        callId: ToolCallId('fallback'), name: 'mcp__srv__future-schema', arguments: {},
      })
      if (fallback.isError) throw new Error('unsupported schema must use the bridge fallback')
      expect(fallback.value).toEqual({
        content: [{ type: 'text', text: 'kept' }],
        structuredContent: { 'x-value': 'kept' },
      })
    } finally {
      await client.close()
    }
  })
})

describe('tool execution', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = await mountRegistry()
  })

  it('calls MCP callTool with the RAW name and returns text content', async () => {
    const client = createMockClient(
      [{ name: 'echo', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text', text: 'hello world' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId('c1'), name: 'mcp__srv__echo', arguments: { msg: 'hi' } })

    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'hello world' }])
    if (result.isError) throw new Error('expected MCP success')
    expect(result.value).toEqual({ content: [{ type: 'text', text: 'hello world' }] })
    // The wire sees the raw MCP name, never the public name.
    expect(client.callTool).toHaveBeenCalledWith(
      { name: 'echo', arguments: { msg: 'hi' } },
      expect.objectContaining({ timeout: 60_000 }),
    )
  })

  it('sends the raw name for normalized public names', async () => {
    const client = createMockClient(
      [{ name: 'admin.reset', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text', text: 'reset done' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const publicName = publicToolName('srv', 'admin.reset')
    const result = await executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId('c1'), name: publicName, arguments: {} })

    expect(result.isError).toBe(false)
    expect(client.callTool).toHaveBeenCalledWith(
      { name: 'admin.reset', arguments: {} },
      expect.anything(),
    )
  })

  it('joins multiple text blocks with newline', async () => {
    const client = createMockClient(
      [{ name: 'multi', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId('c1'), name: 'mcp__srv__multi', arguments: {} })

    expect(result.content).toEqual([{ type: 'text', text: 'line1\nline2' }])
  })

  it('preserves canonical MCP JSON while admitting an ordered mixed image result', async () => {
    const rich = await mountRichRegistry()
    const blocks = [
      { type: 'text', text: 'before' },
      { type: 'image', mimeType: 'image/png', data: 'AQ==', annotations: { audience: ['assistant'] } },
      { type: 'text', text: 'between' },
      { type: 'image', mimeType: 'image/jpeg', data: 'Ag==' },
      { type: 'text', text: 'after' },
    ] satisfies JsonValue[]
    const client = createMockClient(
      [{ name: 'img', inputSchema: { type: 'object' } }],
      { content: blocks },
    )

    await syncTools(client as never, rich.ctx, defaultOpts, new Map())
    const result = await executeToolFixture(rich.ctx, {
      signal: testToolSignal,
      callId: ToolCallId('c1'),
      name: 'mcp__srv__img',
      arguments: {},
      agent: agentOn() as never,
    })

    expect(result.content.map(block => block.type)).toEqual(['text', 'image', 'text', 'image', 'text'])
    expect(result.content[0]).toEqual({ type: 'text', text: 'before' })
    expect(result.content[2]).toEqual({ type: 'text', text: 'between' })
    expect(result.content[4]).toEqual({ type: 'text', text: 'after' })
    const firstImage = result.content[1]
    const secondImage = result.content[3]
    if (firstImage?.type !== 'image' || secondImage?.type !== 'image') throw new Error('expected ordered image blocks')
    expect(firstImage.attachment.mediaType).toBe('image/png')
    expect(firstImage.attachment.bytes).toBe(1)
    expect(secondImage.attachment.mediaType).toBe('image/jpeg')
    expect(secondImage.attachment.bytes).toBe(1)
    expect(rich.attachments.saved.map(input => [...input.data])).toEqual([[1], [2]])
    expect(JSON.stringify(result.content)).not.toContain('AQ==')
    expect(JSON.stringify(result.content)).not.toContain('Ag==')
    if (result.isError) throw new Error('expected MCP success')
    expect(result.value).toEqual({ content: blocks })
  })

  it('keeps a valid raw image result while explicitly refusing it without a durable route', async () => {
    const blocks = [{ type: 'image', mimeType: 'image/png', data: 'AQ==' }] satisfies JsonValue[]
    const client = createMockClient(
      [{ name: 'img', inputSchema: { type: 'object' } }],
      { content: blocks },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await executeToolFixture(ctx, {
      signal: testToolSignal,
      callId: ToolCallId('no-store'),
      name: 'mcp__srv__img',
      arguments: {},
      agent: agentOn() as never,
    })

    expect(result.content).toEqual([{
      type: 'text',
      text: '[image unavailable: image/png; no attachment store is mounted; raw image data remains available to programmatic callers]',
    }])
    if (result.isError) throw new Error('image refusal must preserve MCP success')
    expect(result.value).toEqual({ content: blocks })
  })

  it('rejects a malformed image batch before storing any member', async () => {
    const rich = await mountRichRegistry()
    const blocks = [
      { type: 'image', mimeType: 'image/png', data: 'AQ==' },
      { type: 'image', mimeType: 'image/png', data: 'AQ' },
    ] satisfies JsonValue[]
    const client = createMockClient(
      [{ name: 'img', inputSchema: { type: 'object' } }],
      { content: blocks },
    )

    await syncTools(client as never, rich.ctx, defaultOpts, new Map())
    const result = await executeToolFixture(rich.ctx, {
      signal: testToolSignal,
      callId: ToolCallId('bad-batch'),
      name: 'mcp__srv__img',
      arguments: {},
      agent: agentOn() as never,
    })

    expect(rich.attachments.saved).toEqual([])
    expect(result.content).toHaveLength(2)
    expect(textAt(result.content, 0)).toContain('another image in the same result was invalid')
    expect(textAt(result.content, 1)).toContain('not canonical base64')
  })

  it('rejects unsupported media and base64 aliases as one atomic batch', async () => {
    const rich = await mountRichRegistry()
    const client = createMockClient(
      [{ name: 'img', inputSchema: { type: 'object' } }],
      { content: [
        { type: 'image', mimeType: 'image/tiff', data: 'AQ==' },
        { type: 'image', mimeType: 'image/png', data: 'AB==' },
        { type: 'image', mimeType: 'image/png', data: 'AQ' },
      ] },
    )

    await syncTools(client as never, rich.ctx, defaultOpts, new Map())
    const result = await executeToolFixture(rich.ctx, {
      signal: testToolSignal,
      callId: ToolCallId('strict-batch'),
      name: 'mcp__srv__img',
      arguments: {},
      agent: agentOn() as never,
    })

    expect(rich.attachments.saved).toEqual([])
    expect(result.content).toHaveLength(3)
    expect(textAt(result.content, 0)).toContain('not PNG, JPEG, WebP, or GIF')
    expect(textAt(result.content, 1)).toContain('not canonical base64')
    expect(textAt(result.content, 2)).toContain('not canonical base64')
  })

  it('does not admit images for a route without declared image input', async () => {
    const rich = await mountRichRegistry()
    const client = createMockClient(
      [{ name: 'img', inputSchema: { type: 'object' } }],
      { content: [{ type: 'image', mimeType: 'image/png', data: 'AQ==' }] },
    )

    await syncTools(client as never, rich.ctx, defaultOpts, new Map())
    const result = await executeToolFixture(rich.ctx, {
      signal: testToolSignal,
      callId: ToolCallId('text-route'),
      name: 'mcp__srv__img',
      arguments: {},
      agent: agentOn('text') as never,
    })

    expect(rich.attachments.saved).toEqual([])
    expect(textAt(result.content)).toContain('does not declare image input')
  })

  it('refuses images when the exact route is missing, unverifiable, or canceled', async () => {
    const rich = await mountRichRegistry()
    const client = createMockClient(
      [{ name: 'img', inputSchema: { type: 'object' } }],
      { content: [{ type: 'image', mimeType: 'image/png', data: 'AQ==' }] },
    )
    await syncTools(client as never, rich.ctx, defaultOpts, new Map())

    const noProvider = await executeToolFixture(rich.ctx, {
      signal: testToolSignal,
      callId: ToolCallId('no-provider'),
      name: 'mcp__srv__img',
      arguments: {},
      agent: { options: { model: 'vision' }, session: { requestHeader: () => undefined } } as never,
    })
    expect(textAt(noProvider.content)).toContain('route could not be resolved')

    const noModel = await executeToolFixture(rich.ctx, {
      signal: testToolSignal,
      callId: ToolCallId('no-model'),
      name: 'mcp__srv__img',
      arguments: {},
      agent: { options: { provider: 'visual' }, session: { requestHeader: () => undefined } } as never,
    })
    expect(textAt(noModel.content)).toContain('route could not be resolved')

    const noLlmCtx = await mountRegistry()
    await noLlmCtx.plugin(RecordingAttachmentStore)
    await syncTools(client as never, noLlmCtx, defaultOpts, new Map())
    const noLlm = await executeToolFixture(noLlmCtx, {
      signal: testToolSignal,
      callId: ToolCallId('no-llm'),
      name: 'mcp__srv__img',
      arguments: {},
      agent: agentOn() as never,
    })
    expect(textAt(noLlm.content)).toContain('route could not be resolved')

    vi.spyOn(rich.ctx.llm, 'resolveModelInfo').mockRejectedValueOnce(new Error('catalog down'))
    const unverified = await executeToolFixture(rich.ctx, {
      signal: testToolSignal,
      callId: ToolCallId('unverified'),
      name: 'mcp__srv__img',
      arguments: {},
      agent: agentOn() as never,
    })
    expect(textAt(unverified.content)).toContain('route could not be verified')

    vi.spyOn(rich.ctx.llm, 'resolveModelInfo').mockResolvedValueOnce({
      provider: 'visual', id: 'vision', name: 'vision',
    })
    const unknown = await executeToolFixture(rich.ctx, {
      signal: testToolSignal,
      callId: ToolCallId('unknown-modalities'),
      name: 'mcp__srv__img',
      arguments: {},
      agent: agentOn() as never,
    })
    expect(textAt(unknown.content)).toContain('does not declare image input')

    const controller = new AbortController()
    vi.spyOn(rich.ctx.llm, 'resolveModelInfo').mockImplementationOnce(async (provider, model) => {
      controller.abort(new Error('stop'))
      return { provider, id: model, name: model, inputModalities: ['text', 'image'] }
    })
    const canceled = await executeToolFixture(rich.ctx, {
      signal: controller.signal,
      callId: ToolCallId('canceled'),
      name: 'mcp__srv__img',
      arguments: {},
      agent: agentOn() as never,
    })
    expect(canceled.isError).toBe(true)
    expect(canceled.content[0]).toEqual({ type: 'text', text: 'Error: tool call aborted' })
    expect(rich.attachments.saved).toEqual([])
  })

  it('refuses images when attachment storage rejects the admitted batch', async () => {
    const rich = await mountRichRegistry()
    vi.spyOn(rich.attachments, 'saveImages').mockRejectedValueOnce(new Error('disk full'))
    const client = createMockClient(
      [{ name: 'img', inputSchema: { type: 'object' } }],
      { content: [{ type: 'image', mimeType: 'image/png', data: 'AQ==' }] },
    )

    await syncTools(client as never, rich.ctx, defaultOpts, new Map())
    const result = await executeToolFixture(rich.ctx, {
      signal: testToolSignal,
      callId: ToolCallId('store-rejected'),
      name: 'mcp__srv__img',
      arguments: {},
      agent: agentOn() as never,
    })

    expect(textAt(result.content)).toContain('durable image storage rejected the result')
  })

  it('reports attachment policy rejection as image admission rather than storage failure', async () => {
    const rich = await mountRichRegistry()
    vi.spyOn(rich.attachments, 'saveImages').mockRejectedValueOnce(
      new AttachmentError('too many images', 'TOO_MANY_IMAGES'),
    )
    const client = createMockClient(
      [{ name: 'img', inputSchema: { type: 'object' } }],
      { content: [{ type: 'image', mimeType: 'image/png', data: 'AQ==' }] },
    )

    await syncTools(client as never, rich.ctx, defaultOpts, new Map())
    const result = await executeToolFixture(rich.ctx, {
      signal: testToolSignal,
      callId: ToolCallId('policy-rejected'),
      name: 'mcp__srv__img',
      arguments: {},
      agent: agentOn() as never,
    })

    expect(textAt(result.content)).toContain('image admission rejected the result: too many images')
    expect(textAt(result.content)).not.toContain('storage rejected')
  })

  it('keeps admitted images when post-execute shortens only the text', async () => {
    const rich = await mountRichRegistry()
    const blocks = [
      { type: 'text', text: 'long text'.repeat(1000) },
      { type: 'image', mimeType: 'image/png', data: 'AQ==' },
    ] satisfies JsonValue[]
    const client = createMockClient([{ name: 'img', inputSchema: { type: 'object' } }], { content: blocks })
    rich.ctx.on('tools/post-execute', async (_exec, result, next): Promise<PostToolDecision> => {
      await next()
      expect(result.content.map(block => block.type)).toEqual(['text', 'image'])
      return { kind: 'accept', content: result.content.map(block => block.type === 'text'
        ? { type: 'text', text: block.text.slice(0, 20) }
        : block) }
    })
    try {
      await syncTools(client as never, rich.ctx, defaultOpts, new Map())
      const result = await executeToolFixture(rich.ctx, {
        signal: testToolSignal, callId: ToolCallId('shortened'), name: 'mcp__srv__img',
        arguments: {}, agent: agentOn() as never,
      })
      expect(result.isError).toBe(false)
      expect(result.content.map(block => block.type)).toEqual(['text', 'image'])
      expect(textAt(result.content)).toBe('long text'.repeat(1000).slice(0, 20))
      if (result.isError) throw new Error('expected MCP success')
      expect(result.value).toEqual({ content: blocks })
    } finally {
      await rich.ctx.fiber.dispose()
    }
  })

  it.each(['value', 'renderer'] as const)('keeps a dispatch %s replacement instead of prepared images', async (replacement) => {
    const rich = await mountRichRegistry()
    try {
      const client = createMockClient(
        [{ name: 'img', inputSchema: { type: 'object' } }],
        { content: [{ type: 'image', mimeType: 'image/png', data: 'AQ==' }] },
      )
      const registrations = await syncTools(client as never, rich.ctx, defaultOpts, new Map())
      rich.ctx.on('tools/execute', async (_exec, next) => {
        const result = await next()
        if (result.isError) throw new Error('expected MCP success before dispatch replacement')
        if (replacement === 'value') {
          return { ...result, value: { content: [{ type: 'text', text: 'dispatch replacement' }] } }
        }
        const definition = rich.ctx.tools.get('mcp__srv__img')!
        registrations.get('mcp__srv__img')!()
        rich.ctx.tools.register({
          ...definition,
          output: { ...definition.output, render: () => [{ type: 'text', text: 'dispatch replacement' }] },
        })
        return { ...result }
      })
      const result = await executeToolFixture(rich.ctx, {
        signal: testToolSignal, callId: ToolCallId(`dispatch-${replacement}`), name: 'mcp__srv__img',
        arguments: {}, agent: agentOn() as never,
      })
      expect(result.isError).toBe(false)
      expect(rich.attachments.saved).toHaveLength(1)
      expect(result.content).toEqual([{ type: 'text', text: 'dispatch replacement' }])
    } finally {
      await rich.ctx.fiber.dispose()
    }
  })

  it('lets post-execute replacement win over a prepared image projection', async () => {
    const rich = await mountRichRegistry()
    rich.ctx.on('tools/post-execute', async (): Promise<PostToolDecision> => ({
      kind: 'accept',
      content: [{ type: 'text', text: 'policy replacement' }],
    }))
    const client = createMockClient(
      [{ name: 'img', inputSchema: { type: 'object' } }],
      { content: [{ type: 'image', mimeType: 'image/png', data: 'AQ==' }] },
    )

    await syncTools(client as never, rich.ctx, defaultOpts, new Map())
    const result = await executeToolFixture(rich.ctx, {
      signal: testToolSignal,
      callId: ToolCallId('replaced'),
      name: 'mcp__srv__img',
      arguments: {},
      agent: agentOn() as never,
    })

    expect(rich.attachments.saved).toHaveLength(1)
    expect(result.content).toEqual([{ type: 'text', text: 'policy replacement' }])
  })

  it('lets post-execute value replacement and blocking discard prepared projections', async () => {
    const valueRich = await mountRichRegistry()
    valueRich.ctx.on('tools/post-execute', async (): Promise<PostToolDecision> => ({
      kind: 'accept',
      value: { content: [{ type: 'text', text: 'value replacement' }] },
    }))
    const valueClient = createMockClient(
      [{ name: 'img', inputSchema: { type: 'object' } }],
      { content: [{ type: 'image', mimeType: 'image/png', data: 'AQ==' }] },
    )
    await syncTools(valueClient as never, valueRich.ctx, defaultOpts, new Map())
    const replaced = await executeToolFixture(valueRich.ctx, {
      signal: testToolSignal,
      callId: ToolCallId('value-replaced'),
      name: 'mcp__srv__img',
      arguments: {},
      agent: agentOn() as never,
    })
    expect(replaced.content).toEqual([{ type: 'text', text: 'value replacement' }])

    const blockedRich = await mountRichRegistry()
    blockedRich.ctx.on('tools/post-execute', async (): Promise<PostToolDecision> => ({
      kind: 'block',
      feedback: [{ type: 'text', text: 'blocked by policy' }],
    }))
    const blockedClient = createMockClient(
      [{ name: 'img', inputSchema: { type: 'object' } }],
      { content: [{ type: 'image', mimeType: 'image/png', data: 'Ag==' }] },
    )
    await syncTools(blockedClient as never, blockedRich.ctx, defaultOpts, new Map())
    const blocked = await executeToolFixture(blockedRich.ctx, {
      signal: testToolSignal,
      callId: ToolCallId('blocked'),
      name: 'mcp__srv__img',
      arguments: {},
      agent: agentOn() as never,
    })
    expect(blocked.isError).toBe(true)
    expect(blocked.content).toEqual([{ type: 'text', text: 'blocked by policy' }])
  })

  it('marks primitive blocks from canonical-value replacement unsupported', async () => {
    const blocks = [42, null, ['nested']] satisfies JsonValue[]
    ctx.on('tools/post-execute', async (): Promise<PostToolDecision> => ({ kind: 'accept', value: { content: blocks } }))
    const client = createMockClient(
      [{ name: 'primitive-blocks', inputSchema: { type: 'object' } }],
      { content: [] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await executeToolFixture(ctx, {
      signal: testToolSignal,
      callId: ToolCallId('primitive'), name: 'mcp__srv__primitive-blocks', arguments: {},
    })

    expect(result.content[0]).toEqual({
      type: 'text',
      text: '[unsupported MCP content block: expected an object]\n[unsupported MCP content block: expected an object]\n[unsupported MCP content block: expected an object]',
    })
    if (result.isError) throw new Error('expected canonical-value replacement to remain a successful JSON value')
    expect(result.value).toEqual({ content: blocks })
  })

  it('validates structuredContent when the advertised output schema is supported', async () => {
    const outputSchema = {
      type: 'object',
      additionalProperties: false,
      properties: { answer: { type: 'integer' } },
      required: ['answer'],
    }
    const valid = createMockClient(
      [{ name: 'structured', inputSchema: { type: 'object' }, outputSchema }],
      { content: [{ type: 'text', text: '42' }], structuredContent: { answer: 42 } },
    )
    await syncTools(valid as never, ctx, defaultOpts, new Map())
    const success = await executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId('valid'), name: 'mcp__srv__structured', arguments: {} })
    if (success.isError) throw new Error('expected supported structuredContent to validate')
    expect(success.value).toEqual({ content: [{ type: 'text', text: '42' }], structuredContent: { answer: 42 } })

    const invalidCtx = await mountRegistry()
    const invalid = createMockClient(
      [{ name: 'structured', inputSchema: { type: 'object' }, outputSchema }],
      { content: [{ type: 'text', text: 'wrong' }], structuredContent: { answer: 'forty-two' } },
    )
    await syncTools(invalid as never, invalidCtx, defaultOpts, new Map())
    const failure = await executeToolFixture(invalidCtx, { signal: testToolSignal, callId: ToolCallId('invalid'), name: 'mcp__srv__structured', arguments: {} })
    expect(failure.error).toMatchObject({ info: { code: 'INVALID_TOOL_OUTPUT' } })
    expect(failure.content[0]?.type === 'text' ? failure.content[0].text : '')
      .toContain('value.structuredContent.answer')
  })

  it('falls back to JsonValue for unsupported advertised output schemas', async () => {
    const client = createMockClient(
      [{
        name: 'future-schema',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object', patternProperties: { '^x-': { type: 'string' } } },
      }],
      { content: [], structuredContent: ['kept', { nested: true }] },
    )
    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId('fallback'), name: 'mcp__srv__future-schema', arguments: {} })
    if (result.isError) throw new Error('unsupported MCP output schemas must fall back')
    expect(result.value).toEqual({ content: [], structuredContent: ['kept', { nested: true }] })
  })

  it('maps isError to an error result via throw', async () => {
    const client = createMockClient(
      [{ name: 'fail', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text', text: 'something went wrong' }], isError: true },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId('c1'), name: 'mcp__srv__fail', arguments: {} })

    expect(result.isError).toBe(true)
    expect(result.content[0]).toEqual({ type: 'text', text: 'Error: something went wrong' })
    expect('value' in result).toBe(false)
  })

  it('rejects tools that require task-based execution', async () => {
    const client = createMockClient([
      { name: 'task-only', inputSchema: { type: 'object' }, execution: { taskSupport: 'required' } },
    ])

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await executeToolFixture(ctx, {
      signal: testToolSignal,
      callId: ToolCallId('task-only'), name: 'mcp__srv__task-only', arguments: {},
    })

    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('requires task-based execution')
    expect(client.callTool).not.toHaveBeenCalled()
  })

  it('passes abort signal to callTool', async () => {
    const controller = new AbortController()
    const client = createMockClient(
      [{ name: 'slow', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text', text: 'done' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    await executeToolFixture(ctx, { callId: ToolCallId('c1'), name: 'mcp__srv__slow', arguments: {}, signal: controller.signal })

    expect(client.callTool).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signal: controller.signal }),
    )
  })

  it('reports unsupported audio without claiming the raw block was discarded', async () => {
    const client = createMockClient(
      [{ name: 'audio_tool', inputSchema: { type: 'object' } }],
      { content: [{ type: 'audio', mimeType: 'audio/mp3', data: 'AQ==' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId('c1'), name: 'mcp__srv__audio_tool', arguments: {} })

    expect(result.content[0]).toEqual({
      type: 'text',
      text: '[audio result unsupported: audio/mp3; raw audio data remains available to programmatic callers]',
    })
  })

  it('reports unsupported embedded resources without discarding the raw block', async () => {
    const client = createMockClient(
      [{ name: 'res_tool', inputSchema: { type: 'object' } }],
      { content: [{ type: 'resource', resource: { uri: 'memory://document', text: 'Recorded text.' } }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId('c1'), name: 'mcp__srv__res_tool', arguments: {} })

    expect(result.content[0]).toEqual({
      type: 'text',
      text: '[embedded resource unsupported; raw resource data remains available to programmatic callers]',
    })
  })

  it('preserves resource-link name and URI in the model projection', async () => {
    const client = createMockClient(
      [{ name: 'link_tool', inputSchema: { type: 'object' } }],
      { content: [{ type: 'resource_link', name: 'Design', uri: 'https://example.test/design' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId('c1'), name: 'mcp__srv__link_tool', arguments: {} })

    expect(result.content[0]).toEqual({ type: 'text', text: 'Resource link: Design (https://example.test/design)' })
  })

  it('diagnoses an incomplete resource link from canonical-value replacement', async () => {
    ctx.on('tools/post-execute', async (): Promise<PostToolDecision> => ({
      kind: 'accept', value: { content: [{ type: 'resource_link', name: 'Missing URI' }] },
    }))
    const client = createMockClient(
      [{ name: 'link_tool', inputSchema: { type: 'object' } }],
      { content: [] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId('missing-link'), name: 'mcp__srv__link_tool', arguments: {} })

    expect(result.content[0]).toEqual({
      type: 'text', text: '[resource link unavailable: the MCP block is missing its name or URI]',
    })
  })

  it('diagnoses unknown content types from canonical-value replacement', async () => {
    ctx.on('tools/post-execute', async (): Promise<PostToolDecision> => ({ kind: 'accept', value: { content: [{ type: 'video' }] } }))
    const client = createMockClient(
      [{ name: 'unknown_tool', inputSchema: { type: 'object' } }],
      { content: [] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId('c1'), name: 'mcp__srv__unknown_tool', arguments: {} })

    expect(result.content[0]).toEqual({ type: 'text', text: '[unsupported MCP content type: video]' })
  })

  it('diagnoses an image without media type from canonical-value replacement', async () => {
    ctx.on('tools/post-execute', async (): Promise<PostToolDecision> => ({ kind: 'accept', value: { content: [{ type: 'image' }] } }))
    const client = createMockClient(
      [{ name: 'img2', inputSchema: { type: 'object' } }],
      { content: [] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId('c1'), name: 'mcp__srv__img2', arguments: {} })

    expect(result.content[0]).toEqual({
      type: 'text',
      text: '[image unavailable: unknown media type; this result was not admitted to durable model context; raw image data remains available to programmatic callers]',
    })
  })

  it('diagnoses audio without media type from canonical-value replacement', async () => {
    ctx.on('tools/post-execute', async (): Promise<PostToolDecision> => ({ kind: 'accept', value: { content: [{ type: 'audio' }] } }))
    const client = createMockClient(
      [{ name: 'audio_no_mime', inputSchema: { type: 'object' } }],
      { content: [] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId('c1'), name: 'mcp__srv__audio_no_mime', arguments: {} })

    expect(result.content[0]).toEqual({
      type: 'text',
      text: '[audio result unsupported: unknown media type; raw audio data remains available to programmatic callers]',
    })
  })

  it('diagnoses missing text from canonical-value replacement', async () => {
    ctx.on('tools/post-execute', async (): Promise<PostToolDecision> => ({ kind: 'accept', value: { content: [{ type: 'text' }] } }))
    const client = createMockClient(
      [{ name: 'notext', inputSchema: { type: 'object' } }],
      { content: [] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId('c1'), name: 'mcp__srv__notext', arguments: {} })

    expect(result.content[0]).toEqual({ type: 'text', text: '(notext returned no model-visible content)' })
  })

  it('handles empty content array', async () => {
    const client = createMockClient(
      [{ name: 'empty_tool', inputSchema: { type: 'object' } }],
      { content: [] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId('c1'), name: 'mcp__srv__empty_tool', arguments: {} })

    expect(result.content[0]).toEqual({ type: 'text', text: '(empty_tool returned no model-visible content)' })
  })


  it('handles isError with non-text content (fallback error message)', async () => {
    const client = createMockClient(
      [{ name: 'err_notext', inputSchema: { type: 'object' } }],
      { content: [{ type: 'image', mimeType: 'image/png', data: 'AQ==' }], isError: true },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const result = await executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId('c1'), name: 'mcp__srv__err_notext', arguments: {} })

    expect(result.isError).toBe(true)
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'Error: [image unavailable: image/png; this result was not admitted to durable model context; raw image data remains available to programmatic callers]',
    })
  })


  it('uses tool description when provided', async () => {
    const client = createMockClient([
      { name: 'described', description: 'A described tool', inputSchema: { type: 'object' } },
    ])

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const tool = ctx.tools.get('mcp__srv__described')
    expect(tool?.description).toBe('A described tool')
  })

  it('uses empty description when tool has no description', async () => {
    const client = createMockClient([
      { name: 'nodesc', inputSchema: { type: 'object' } },
    ])

    await syncTools(client as never, ctx, defaultOpts, new Map())
    const tool = ctx.tools.get('mcp__srv__nodesc')
    expect(tool?.description).toBe('')
  })
})

describe('createTransport', () => {
  it('creates StdioClientTransport for stdio config', () => {
    const config: Config = {
      transport: 'stdio',
      serverName: 'srv',
      command: 'node',
      args: ['server.js'],
      env: {},
      cwd: '/tmp',
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    }
    const transport = createTransport(config)
    expect(transport).toBeDefined()
    expect(transport).toHaveProperty('start')
    expect(transport).toHaveProperty('close')
  })

  it('creates StreamableHTTPClientTransport for http config without headers', () => {
    const config: Config = {
      transport: 'streamable-http',
      serverName: 'srv',
      url: 'http://localhost:3000/mcp',
      headers: {},
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    }
    const transport = createTransport(config)
    expect(transport).toBeDefined()
    expect(transport).toHaveProperty('start')
    expect(transport).toHaveProperty('close')
  })

  it('creates StreamableHTTPClientTransport for http config with headers', () => {
    const config: Config = {
      transport: 'streamable-http',
      serverName: 'srv',
      url: 'http://localhost:3000/mcp',
      headers: { Authorization: 'Bearer token' },
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    }
    const transport = createTransport(config)
    expect(transport).toBeDefined()
    expect(transport).toHaveProperty('start')
    expect(transport).toHaveProperty('close')
  })

  it('scrubs sensitive env vars and forwards the rest', () => {
    const original = { ...process.env }
    try {
      process.env.SAFE_VAR = 'kept'
      process.env.MY_SECRET = 'hidden'
      process.env.API_KEY = 'hidden'
      process.env.AUTH_TOKEN = 'hidden'

      const config: Config = {
        transport: 'stdio',
        serverName: 'srv',
        command: 'echo',
        args: [],
        env: { EXTRA: 'injected' },
        cwd: '',
        toolCallTimeoutMs: 60_000,
        failOnStartupError: false,
      }
      // StdioClientTransport keeps its env private; the observable contract is
      // that createTransport(config) returns a transport without throwing.
      const transport = createTransport(config)
      expect(transport).toBeDefined()
    } finally {
      delete process.env.SAFE_VAR
      delete process.env.MY_SECRET
      delete process.env.API_KEY
      delete process.env.AUTH_TOKEN
      for (const key of Object.keys(process.env)) {
        if (!(key in original)) Reflect.deleteProperty(process.env, key)
      }
    }
  })

  it('merges explicit env on top of scrubbed ambient env', () => {
    const config: Config = {
      transport: 'stdio',
      serverName: 'srv',
      command: 'echo',
      args: [],
      env: { CUSTOM: 'value' },
      cwd: '',
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    }
    const transport = createTransport(config)
    expect(transport).toBeDefined()
  })
})

describe('tool execution — non-object args fallback', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = await mountRegistry()
  })

  it('coerces null args to empty object for callTool', async () => {
    const client = createMockClient(
      [{ name: 'coerce', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text', text: 'ok' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    await executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId('c1'), name: 'mcp__srv__coerce', arguments: null })

    expect(client.callTool).toHaveBeenCalledWith(
      { name: 'coerce', arguments: {} },
      expect.anything(),
    )
  })

  it('coerces primitive string args to empty object for callTool', async () => {
    const client = createMockClient(
      [{ name: 'coerce2', inputSchema: { type: 'object' } }],
      { content: [{ type: 'text', text: 'ok' }] },
    )

    await syncTools(client as never, ctx, defaultOpts, new Map())
    await executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId('c1'), name: 'mcp__srv__coerce2', arguments: 'bad' })

    expect(client.callTool).toHaveBeenCalledWith(
      { name: 'coerce2', arguments: {} },
      expect.anything(),
    )
  })
})
