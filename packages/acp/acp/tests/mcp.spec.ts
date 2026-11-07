import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { McpServer } from '@agentclientprotocol/sdk'
import type { Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'
import { mountAcpMcpServers } from '../src/mcp.ts'

/** Context stand-in that captures validated MCP configs without opening transports. */
function captureContext(): { ctx: Context; configs: McpClientConfig[] } {
  const configs: McpClientConfig[] = []
  const plugin = vi.fn((_plugin: unknown, config: McpClientConfig) => {
    configs.push(config)
    return Promise.resolve(undefined)
  })
  return { ctx: { plugin } as unknown as Context, configs }
}

describe('ACP MCP declaration mapping', () => {
  it('normalizes human server names and preserves standard stdio/HTTP fields', async () => {
    const { ctx, configs } = captureContext()

    await mountAcpMcpServers(ctx, [
      {
        name: 'Fancy server!',
        command: process.execPath,
        args: ['server.js'],
        env: [{ name: 'TOKEN', value: 'secret' }],
      },
      {
        type: 'http',
        name: '!!!',
        url: 'https://example.test/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer token' }],
      },
    ], process.cwd())

    expect(configs).toHaveLength(2)
    expect(configs[0]).toMatchObject({
      transport: 'stdio',
      command: process.execPath,
      args: ['server.js'],
      env: { TOKEN: 'secret' },
      cwd: process.cwd(),
      failOnStartupError: true,
    })
    expect(configs[0]?.serverName).toMatch(/^Fancy_server_[0-9a-f]{8}$/)
    expect(configs[1]).toMatchObject({
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer token' },
      failOnStartupError: true,
    })
    expect(configs[1]?.serverName).toMatch(/^server_[0-9a-f]{8}$/)
  })

  it.each([
    [[{ name: 'A', value: '1' }, { name: 'A', value: '2' }], /duplicate name/],
    [[{ name: '', value: '1' }], /invalid environment entry/],
    [[{ name: 'A\0', value: '1' }], /invalid environment entry/],
    [[{ name: 'A', value: '1\0' }], /invalid environment entry/],
  ] as const)('rejects invalid environment entries %#', async (env, message) => {
    const { ctx } = captureContext()
    await expect(mountAcpMcpServers(ctx, [{
      name: 'fixture', command: process.execPath, args: [], env: [...env],
    }], process.cwd())).rejects.toThrow(message)
  })

  it('rejects case-insensitive duplicate headers and malformed URLs', async () => {
    const { ctx } = captureContext()
    await expect(mountAcpMcpServers(ctx, [{
      type: 'http',
      name: 'web',
      url: 'https://example.test/mcp',
      headers: [{ name: 'X-Key', value: 'one' }, { name: 'x-key', value: 'two' }],
    }], process.cwd())).rejects.toThrow(/duplicate name/)
    await expect(mountAcpMcpServers(ctx, [{
      type: 'http', name: 'web', url: 'not a URL', headers: [],
    }], process.cwd())).rejects.toThrow(/absolute HTTP/)
  })

  it('preserves legal names that collide with Object prototype setters', async () => {
    const { ctx, configs } = captureContext()

    await mountAcpMcpServers(ctx, [
      {
        name: 'stdio',
        command: process.execPath,
        args: [],
        env: [{ name: '__proto__', value: 'environment-value' }],
      },
      {
        type: 'http',
        name: 'http',
        url: 'https://example.test/mcp',
        headers: [{ name: '__proto__', value: 'header-value' }],
      },
    ], process.cwd())

    expect(configs[0]?.transport === 'stdio' && Object.hasOwn(configs[0].env, '__proto__')).toBe(true)
    expect(configs[0]?.transport === 'stdio' && configs[0].env['__proto__']).toBe('environment-value')
    expect(configs[1]?.transport === 'streamable-http' && Object.hasOwn(configs[1].headers, '__proto__')).toBe(true)
    expect(configs[1]?.transport === 'streamable-http' && configs[1].headers['__proto__']).toBe('header-value')
  })

  it('maps provider schema failures into the indexed declaration error', async () => {
    const { ctx } = captureContext()
    const malformed = {
      name: 'fixture',
      command: process.execPath,
      args: 'not-an-array',
      env: [],
    } as unknown as McpServer

    await expect(mountAcpMcpServers(ctx, [malformed], process.cwd()))
      .rejects.toThrow(/mcpServers\[0\] is invalid/)
  })
})
