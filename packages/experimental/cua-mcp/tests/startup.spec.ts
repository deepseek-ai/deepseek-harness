/** The frontend parses its invocation and serves MCP only after readiness. */
import { EventEmitter } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { Server } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import * as frontend from '../src/index.ts'
import { createCuaMcpServer } from '../src/server.ts'

vi.mock('../src/server.ts', async original => ({
  ...await original<typeof import('../src/server.ts')>(), createCuaMcpServer: vi.fn(),
}))
vi.mock('@modelcontextprotocol/server/stdio', () => ({ StdioServerTransport: vi.fn() }))

/** Controllable stdin for one invocation. */
class TestStdin extends EventEmitter {
  readableEnded = false

  end(): void {
    this.readableEnded = true
    this.emit('end')
  }
}

const roots: Context[] = []
const closers: (() => Promise<void>)[] = []
let connect: Mock<() => Promise<void>>
let dispose: Mock<() => Promise<void>>

beforeEach(() => {
  // oxlint-disable-next-line typescript/no-deprecated -- the frontend serves the SDK's low-level server.
  const server = new Server({ name: 'startup-fixture', version: '1' })
  closers.push(() => server.close())
  connect = vi.fn(async () => {})
  vi.spyOn(server, 'connect').mockImplementation(connect)
  dispose = vi.fn(() => server.close())
  vi.mocked(createCuaMcpServer).mockResolvedValue({ server, agent: {} as never, dispose })
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(closers.splice(0).map(close => close()))
  vi.restoreAllMocks()
  vi.clearAllMocks()
  internals.stdin = process.stdin
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

async function boot(args: string[], config: Partial<frontend.Config> = {}) {
  const ctx = new Context()
  roots.push(ctx)
  const exit = vi.fn()
  const listeners = new Set<() => void>()
  let committed = false
  const stdout: string[] = []
  const stderr: string[] = []
  const stdin = new TestStdin()
  internals.stdin = stdin
  internals.stdout = { write: (chunk) => { stdout.push(chunk); return true } }
  internals.stderr = { write: (chunk) => { stderr.push(chunk); return true } }
  provideCmdline(ctx, { args, exit, ready: { onReady(listener) {
    if (committed) { listener(); return () => {} }
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  } } })
  // The served connection reads these services inside the mocked server; the rows only need to exist for activation.
  for (const service of ['agents', 'agentPresets', 'tools', 'systemPrompt', 'attachments'] as const) ctx.provide(service, {} as never)
  ctx.provide('profileContext', {
    name: 'cua-mcp', dir: '/profiles/cua-mcp', patchPath: '/profiles/cua-mcp/cordis.patch.yml',
    installAnchor: '/dsh/package.json', cwd: '/workspace', home: '/home/me/.dsh',
    startedBundles: ['@deepseek-ai/dsh-cua-mcp'], overlays: [], telemetryDisabledEnv: undefined,
  })
  await ctx.plugin(frontend, frontend.Config(config))
  return { ctx, exit, stdout, stderr, stdin, ready: () => {
    committed = true
    for (const listener of [...listeners]) listener()
    listeners.clear()
  } }
}

describe('Computer Use MCP startup', () => {
  it('serves after readiness with the configured consent and joins disposal', async () => {
    const { ctx, exit, ready, stdin } = await boot([], { consent: 'allow' })
    // Nothing is created before readiness; the Agent then exists before the transport opens.
    expect(createCuaMcpServer).not.toHaveBeenCalled()
    ready()
    const options = vi.mocked(createCuaMcpServer).mock.calls[0]?.[1]
    if (options === undefined) throw new Error('the frontend did not construct a server')
    expect(options).toMatchObject({ consent: 'allow', cwd: '/workspace' })
    await vi.waitFor(() => { expect(connect).toHaveBeenCalledOnce() })
    expect(StdioServerTransport).toHaveBeenCalledOnce()
    stdin.end()
    expect(exit).toHaveBeenCalledWith(0)
    await ctx.fiber.dispose()
    expect(options.signal.aborted).toBe(true)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('rejects an unknown option and documents help without starting anything', async () => {
    const unknown = await boot(['--print-client-config', 'json'])
    expect(unknown.exit).toHaveBeenCalledWith(1)
    expect(unknown.stderr.join('')).toContain("unknown option '--print-client-config'")
    expect(unknown.stdout.join('')).toBe('')
    const help = await boot(['--help'])
    expect(help.stdout.join('')).toContain('Usage: dsh --profile cua-mcp [options]')
    expect(help.stdout.join('')).toContain('DSH_CUA_CONSENT=allow')
    expect(help.exit).toHaveBeenCalledWith(0)
    expect(createCuaMcpServer).not.toHaveBeenCalled()
    expect(StdioServerTransport).not.toHaveBeenCalled()
  })

  it('reports an Agent creation or transport startup failure through bounded exit, except during disposal', async () => {
    vi.mocked(createCuaMcpServer).mockRejectedValueOnce(new Error('registry refused the Agent'))
    const refused = await boot([])
    refused.ready()
    await vi.waitFor(() => { expect(refused.exit).toHaveBeenCalledWith(1) })
    expect(connect).not.toHaveBeenCalled()
    await refused.ctx.fiber.dispose()
    connect.mockRejectedValueOnce(new Error('transport start failed'))
    const failing = await boot([])
    failing.ready()
    await vi.waitFor(() => { expect(failing.exit).toHaveBeenCalledWith(1) })
    const opening = Promise.withResolvers<undefined>()
    connect.mockImplementationOnce(async () => { await opening.promise })
    const closing = await boot([])
    closing.ready()
    const disposal = closing.ctx.fiber.dispose()
    opening.reject(new Error('transport released'))
    await disposal
    expect(closing.exit).not.toHaveBeenCalled()
  })

  it('requires the profile launcher and validates the consent mode', () => {
    const ctx = new Context()
    roots.push(ctx)
    provideCmdline(ctx, { args: [], exit: () => {}, ready: { onReady: () => () => {} } })
    expect(() => { frontend.apply(ctx, frontend.Config({})) }).toThrow('requires the dsh profile launcher')
    expect(frontend.Config({})).toEqual({ consent: 'elicit' })
    expect(() => frontend.Config({ consent: 'ask' as 'allow' })).toThrow()
  })
})
