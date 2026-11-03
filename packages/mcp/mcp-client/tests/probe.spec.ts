/**
 * Tests for the one-shot server probe: stage classification, listing
 * pagination and caps, the shared budget, and close containment.
 * Isolated file so vi.mock of the MCP SDK doesn't pollute other test suites.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Transport } from '@modelcontextprotocol/client'
import { Config } from '@deepseek-ai/dsh-mcp-client'

const { mockConnect, mockClose, mockListTools, mockGetServerVersion, MockClient, MockTransport } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockGetServerVersion = vi.fn<() => { name: string; version: string } | undefined>()
  const mockRequest = vi.fn(async (
    request: { method: string; params?: Record<string, unknown> },
  ): Promise<unknown> => {
    if (request.method === 'tools/list') return await mockListTools(request.params)
    throw new Error(`unexpected MCP request: ${request.method}`)
  })
  class MockTransport {
    onclose?: () => void
    start = async () => {}
    send = async () => {}
    close = async () => { this.onclose?.() }
  }
  class MockClient {
    transport: Transport | undefined
    async connect(transport: Transport): Promise<void> {
      this.transport = transport
      await transport.start()
      await mockConnect()
    }
    getServerCapabilities = () => ({ tools: {} })
    close = mockClose
    request = mockRequest
    getServerVersion = mockGetServerVersion
  }
  return { mockConnect, mockClose, mockListTools, mockGetServerVersion, MockClient, MockTransport }
})

vi.mock('@modelcontextprotocol/client', async importOriginal => ({
  ...await importOriginal<typeof import('@modelcontextprotocol/client')>(),
  Client: MockClient,
  StreamableHTTPClientTransport: vi.fn(function () { return new MockTransport() }),
}))
vi.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: vi.fn(function () { return new MockTransport() }),
}))

import { probeServer } from '@deepseek-ai/dsh-mcp-client/src/probe.ts'

// Typed views of vitest's asymmetric matchers: their `any` return would
// otherwise trip no-unsafe-assignment inside expectation literals.
const anyNumber = expect.any(Number) as number
const containing = (text: string): string => expect.stringContaining(text) as string

function httpConfig(): Config {
  return Config({
    transport: 'streamable-http',
    serverName: 'probe',
    url: 'http://localhost:9',
    headers: {},
    toolCallTimeoutMs: 60_000,
    startupTimeoutMs: 30_000,
    failOnStartupError: false,
  })
}

function page(names: string[], nextCursor?: string): unknown {
  return {
    tools: names.map(name => ({ name, inputSchema: { type: 'object' } })),
    ...nextCursor === undefined ? {} : { nextCursor },
  }
}

describe('probeServer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(async function (this: InstanceType<typeof MockClient>) { await this.transport?.close() })
    mockGetServerVersion.mockReturnValue({ name: 'fixture', version: '1.0.0' })
    mockListTools.mockResolvedValue(page(['add', 'greet']))
  })

  it('answers with the server identity and paginated tool names, then closes', async () => {
    mockListTools
      .mockResolvedValueOnce(page(['add'], 'cursor-1'))
      .mockResolvedValueOnce(page(['greet']))
    const result = await probeServer(new Context(), httpConfig())
    expect(result).toEqual({
      ok: true,
      closeConfirmed: true,
      serverInfo: { name: 'fixture', version: '1.0.0' },
      toolNames: ['add', 'greet'],
      truncated: false,
      durationMs: anyNumber,
    })
    expect(mockListTools).toHaveBeenCalledTimes(2)
    expect(mockListTools).toHaveBeenLastCalledWith({ cursor: 'cursor-1' })
    expect(mockClose).toHaveBeenCalledTimes(1)
  })

  it('omits serverInfo when the SDK captured no identity, and accepts an abort signal', async () => {
    mockGetServerVersion.mockReturnValue(undefined)
    const result = await probeServer(new Context(), httpConfig(), { signal: new AbortController().signal })
    expect(result).toMatchObject({ ok: true, toolNames: ['add', 'greet'] })
    expect(result).not.toHaveProperty('serverInfo')
  })

  it('classifies a connect failure and contains a failing close', async () => {
    mockConnect.mockRejectedValue(new Error('refused'))
    mockClose.mockImplementation(async function (this: InstanceType<typeof MockClient>) {
      await this.transport?.close()
      throw new Error('nothing to close')
    })
    const result = await probeServer(new Context(), httpConfig())
    expect(result).toEqual({
      ok: false,
      closeConfirmed: true,
      cleanupError: containing('nothing to close'),
      stage: 'connect',
      message: containing('refused'),
      durationMs: anyNumber,
    })
  })

  it('classifies a listing failure', async () => {
    mockListTools.mockRejectedValue(new Error('tools exploded'))
    const result = await probeServer(new Context(), httpConfig())
    expect(result).toMatchObject({ ok: false, stage: 'list', message: containing('tools exploded') })
  })

  it('fails at the current stage when the budget elapses', async () => {
    vi.useFakeTimers()
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    mockConnect.mockImplementation(() => { entered.resolve(); return gate.promise })
    mockClose.mockImplementation(async function (this: InstanceType<typeof MockClient>) {
      gate.reject(new Error('closed'))
      await this.transport?.close()
    })
    try {
      const pending = probeServer(new Context(), httpConfig(), { timeoutMs: 40 })
      await entered.promise
      await vi.advanceTimersByTimeAsync(41)
      expect(await pending).toMatchObject({ ok: false, stage: 'connect', message: containing('timed out'), closeConfirmed: true })
    } finally {
      gate.resolve()
      vi.useRealTimers()
    }
  })

  it('truncates instead of following an unbounded cursor chain', async () => {
    mockListTools.mockImplementation(() => Promise.resolve(page(['a', 'b'], 'again')))
    const result = await probeServer(new Context(), httpConfig())
    expect(result).toMatchObject({ ok: true, truncated: true })
    expect((result as { toolNames: string[] }).toolNames).toHaveLength(32)
    expect(mockListTools).toHaveBeenCalledTimes(16)
  })

  it('caps the returned tool-name list', async () => {
    const names = Array.from({ length: 600 }, (_, index) => `tool-${String(index)}`)
    mockListTools.mockResolvedValue(page(names))
    const result = await probeServer(new Context(), httpConfig())
    expect(result).toMatchObject({ ok: true, truncated: true })
    expect((result as { toolNames: string[] }).toolNames).toHaveLength(512)
  })

  it('answers a pre-aborted signal without ever connecting', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await probeServer(new Context(), httpConfig(), { signal: controller.signal })
    expect(result).toMatchObject({ ok: false, stage: 'connect', message: 'probe aborted', closeConfirmed: true })
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('breaks a hung connect by closing the client when the signal aborts', async () => {
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    mockConnect.mockImplementation(() => { entered.resolve(); return gate.promise })
    mockClose.mockImplementation(async function (this: InstanceType<typeof MockClient>) {
      await this.transport?.close()
      gate.reject(new Error('closed by abort'))
      // A client that never connected rejects its close; both the abort
      // lever's catch and the final close containment must absorb it.
      return Promise.reject(new Error('never connected'))
    })
    const controller = new AbortController()
    const pending = probeServer(new Context(), httpConfig(), { signal: controller.signal })
    await entered.promise
    controller.abort()
    const result = await pending
    expect(result).toMatchObject({ ok: false, stage: 'connect', message: 'probe aborted' })
    expect(mockClose).toHaveBeenCalled()
  })

  it('rejects a non-positive budget before doing anything', async () => {
    await expect(probeServer(new Context(), httpConfig(), { timeoutMs: 0 })).rejects.toThrow(TypeError)
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it.each([
    { maxPages: 0 },
    { maxPages: 1.5 },
    { maxToolNames: 0 },
    { maxToolNames: 1.5 },
  ])('rejects invalid listing caps %j before connecting', async (options) => {
    await expect(probeServer(new Context(), httpConfig(), options)).rejects.toThrow(TypeError)
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('applies caller-supplied listing caps', async () => {
    mockListTools.mockResolvedValue(page(['add', 'greet'], 'next'))
    const result = await probeServer(new Context(), httpConfig(), { maxPages: 1, maxToolNames: 1 })
    expect(result).toMatchObject({ ok: true, toolNames: ['add'], truncated: true, closeConfirmed: true })
    expect(mockListTools).toHaveBeenCalledTimes(1)
  })

  it('normalizes a non-Error connect rejection into the failure message', async () => {
    mockConnect.mockRejectedValue('string reason')
    const result = await probeServer(new Context(), httpConfig())
    expect(result).toMatchObject({ ok: false, stage: 'connect', message: containing('string reason') })
  })
})
