/**
 * Tests for the one-shot server probe: stage classification, listing
 * pagination and caps, the shared budget, and close containment.
 * Isolated file so vi.mock of the MCP SDK doesn't pollute other test suites.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Config } from '@deepseek-ai/dsh-mcp-client'

const { mockConnect, mockClose, mockListTools, mockGetServerVersion, MockClient } = vi.hoisted(() => {
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
  class MockClient {
    connect = mockConnect
    close = mockClose
    request = mockRequest
    getServerVersion = mockGetServerVersion
  }
  return { mockConnect, mockClose, mockListTools, mockGetServerVersion, MockClient }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: MockClient }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn() }))

import { probeServer } from '@deepseek-ai/dsh-mcp-client/src/probe.ts'

// Typed views of vitest's asymmetric matchers: their `any` return would
// otherwise trip no-unsafe-assignment inside expectation literals.
const anyNumber = expect.any(Number) as number
const containing = (text: string): string => expect.stringContaining(text) as string

function httpConfig(): Config {
  return {
    transport: 'streamable-http',
    serverName: 'probe',
    url: 'http://localhost:9',
    headers: {},
    toolCallTimeoutMs: 60_000,
    startupTimeoutMs: 30_000,
    failOnStartupError: false,
  }
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
    mockClose.mockResolvedValue(undefined)
    mockGetServerVersion.mockReturnValue({ name: 'fixture', version: '1.0.0' })
    mockListTools.mockResolvedValue(page(['add', 'greet']))
  })

  it('answers with the server identity and paginated tool names, then closes', async () => {
    mockListTools
      .mockResolvedValueOnce(page(['add'], 'cursor-1'))
      .mockResolvedValueOnce(page(['greet']))
    const result = await probeServer(httpConfig())
    expect(result).toEqual({
      ok: true,
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
    const result = await probeServer(httpConfig(), { signal: new AbortController().signal })
    expect(result).toMatchObject({ ok: true, toolNames: ['add', 'greet'] })
    expect(result).not.toHaveProperty('serverInfo')
  })

  it('classifies a connect failure and contains a failing close', async () => {
    mockConnect.mockRejectedValue(new Error('refused'))
    mockClose.mockRejectedValue(new Error('nothing to close'))
    const result = await probeServer(httpConfig())
    expect(result).toEqual({
      ok: false,
      stage: 'connect',
      message: containing('refused'),
      durationMs: anyNumber,
    })
  })

  it('classifies a listing failure', async () => {
    mockListTools.mockRejectedValue(new Error('tools exploded'))
    const result = await probeServer(httpConfig())
    expect(result).toMatchObject({ ok: false, stage: 'list', message: containing('tools exploded') })
  })

  it('fails at the current stage when the budget elapses', async () => {
    mockConnect.mockImplementation(() => new Promise(() => {}))
    const result = await probeServer(httpConfig(), { timeoutMs: 40 })
    expect(result).toMatchObject({ ok: false, stage: 'connect', message: containing('timed out') })
  })

  it('truncates instead of following an unbounded cursor chain', async () => {
    mockListTools.mockImplementation(() => Promise.resolve(page(['a', 'b'], 'again')))
    const result = await probeServer(httpConfig())
    expect(result).toMatchObject({ ok: true, truncated: true })
    expect((result as { toolNames: string[] }).toolNames).toHaveLength(32)
    expect(mockListTools).toHaveBeenCalledTimes(16)
  })

  it('caps the returned tool-name list', async () => {
    const names = Array.from({ length: 600 }, (_, index) => `tool-${String(index)}`)
    mockListTools.mockResolvedValue(page(names))
    const result = await probeServer(httpConfig())
    expect(result).toMatchObject({ ok: true, truncated: true })
    expect((result as { toolNames: string[] }).toolNames).toHaveLength(512)
  })

  it('rejects a non-positive budget before doing anything', async () => {
    await expect(probeServer(httpConfig(), { timeoutMs: 0 })).rejects.toThrow(TypeError)
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('normalizes a non-Error connect rejection into the failure message', async () => {
    mockConnect.mockRejectedValue('string reason')
    const result = await probeServer(httpConfig())
    expect(result).toMatchObject({ ok: false, stage: 'connect', message: containing('string reason') })
  })
})
