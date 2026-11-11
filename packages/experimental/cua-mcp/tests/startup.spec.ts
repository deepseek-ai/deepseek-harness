/** The frontend parses its invocation and, only after readiness, creates the workspace and serves MCP. */
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { Server } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import * as frontend from '../src/index.ts'
import { createCuaMcpServer, type CuaMcpServer } from '../src/server.ts'

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
/** The server every boot serves unless a test replaces one creation. */
let served: CuaMcpServer
/** Scratch directory of one test; the default workspace is a directory inside it that does not exist yet. */
let scratch: string
let workspace: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-cua-mcp-startup-'))
  workspace = join(scratch, 'home', 'workspace')
  // oxlint-disable-next-line typescript/no-deprecated -- the frontend serves the SDK's low-level server.
  const server = new Server({ name: 'startup-fixture', version: '1' })
  closers.push(() => server.close())
  connect = vi.fn(async () => {})
  vi.spyOn(server, 'connect').mockImplementation(connect)
  dispose = vi.fn(() => server.close())
  served = { server, agent: {} as never, dispose }
  vi.mocked(createCuaMcpServer).mockResolvedValue(served)
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(closers.splice(0).map(close => close()))
  vi.restoreAllMocks()
  vi.clearAllMocks()
  internals.stdin = process.stdin
  internals.stdout = process.stdout
  internals.stderr = process.stderr
  await rm(scratch, { recursive: true, force: true })
})

/** Launcher facts of the profile; the launch directory is deliberately not the workspace. */
const profileContext = {
  name: 'cua-mcp', dir: '/profiles/cua-mcp', patchPath: '/profiles/cua-mcp/cordis.patch.yml',
  installAnchor: '/dsh/package.json', cwd: '/launch', home: '/home/me/.dsh',
  startedBundles: ['@deepseek-ai/dsh-cua-mcp'], overlays: [], telemetryDisabledEnv: undefined,
}

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
  ctx.provide('profileContext', profileContext)
  await ctx.plugin(frontend, frontend.Config({ workspace, ...config }))
  return { ctx, exit, stdout, stderr, stdin, ready: () => {
    committed = true
    for (const listener of [...listeners]) listener()
    listeners.clear()
  } }
}

describe('Computer Use MCP startup', () => {
  it('creates the workspace after readiness, then serves with the configured consent and joins disposal', async () => {
    let workspaceExistedAtCreation: boolean | undefined
    vi.mocked(createCuaMcpServer).mockImplementationOnce(async () => {
      workspaceExistedAtCreation = existsSync(workspace)
      return served
    })
    const { ctx, exit, ready, stdin } = await boot([], { consent: 'allow' })
    // Before readiness nothing is created: neither the workspace nor an Agent.
    expect(createCuaMcpServer).not.toHaveBeenCalled()
    expect(existsSync(workspace)).toBe(false)
    ready()
    await vi.waitFor(() => { expect(connect).toHaveBeenCalledOnce() })
    const options = vi.mocked(createCuaMcpServer).mock.calls[0]?.[1]
    if (options === undefined) throw new Error('the frontend did not construct a server')
    // The Agent works in the workspace, which exists before it, not in the directory the client launched the profile from.
    expect(options).toMatchObject({ consent: 'allow', cwd: workspace })
    expect(workspaceExistedAtCreation).toBe(true)
    expect((await stat(workspace)).isDirectory()).toBe(true)
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
    expect(help.stdout.join('')).toContain('DSH_CUA_WORKSPACE=/work')
    expect(help.exit).toHaveBeenCalledWith(0)
    // Neither invocation serves, so readiness creates neither the workspace nor an Agent.
    unknown.ready()
    help.ready()
    expect(existsSync(workspace)).toBe(false)
    expect(createCuaMcpServer).not.toHaveBeenCalled()
    expect(StdioServerTransport).not.toHaveBeenCalled()
  })

  it('reports a relative or uncreatable workspace on stderr and exits with code 1 before any Agent exists', async () => {
    const relative = await boot([], { workspace: 'relative/workspace' })
    relative.ready()
    await vi.waitFor(() => { expect(relative.exit).toHaveBeenCalledWith(1) })
    expect(relative.stderr).toEqual([
      'dsh: MCP startup failed: the workspace "relative/workspace" is not an absolute directory path; set DSH_CUA_WORKSPACE to an absolute path\n',
    ])
    // A file occupies the parent, so the directory cannot be created.
    await writeFile(join(scratch, 'occupied'), '')
    const occupied = join(scratch, 'occupied', 'workspace')
    const blocked = await boot([], { workspace: occupied })
    blocked.ready()
    await vi.waitFor(() => { expect(blocked.exit).toHaveBeenCalledWith(1) })
    expect(blocked.stderr).toHaveLength(1)
    expect(blocked.stderr[0]).toContain(`dsh: MCP startup failed: the workspace directory ${JSON.stringify(occupied)} cannot be created (Error: ENOTDIR`)
    expect(blocked.stderr[0]).toContain('set DSH_CUA_WORKSPACE to a writable location\n')
    expect(blocked.stdout).toEqual([])
    expect(createCuaMcpServer).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  it('reports an Agent creation or transport startup failure on stderr through bounded exit, except during disposal', async () => {
    vi.mocked(createCuaMcpServer).mockRejectedValueOnce(new Error('registry refused the Agent'))
    const refused = await boot([])
    refused.ready()
    await vi.waitFor(() => { expect(refused.exit).toHaveBeenCalledWith(1) })
    expect(refused.stderr).toEqual(['dsh: MCP startup failed: registry refused the Agent\n'])
    expect(connect).not.toHaveBeenCalled()
    await refused.ctx.fiber.dispose()
    // A rejection that is not an Error is reported as its string form.
    connect.mockRejectedValueOnce('transport start failed')
    const failing = await boot([])
    failing.ready()
    await vi.waitFor(() => { expect(failing.exit).toHaveBeenCalledWith(1) })
    expect(failing.stderr).toEqual(['dsh: MCP startup failed: transport start failed\n'])
    // A transport that fails while the frontend is being disposed is not a startup failure.
    const opening = Promise.withResolvers<undefined>()
    connect.mockImplementationOnce(async () => { await opening.promise })
    const closing = await boot([])
    closing.ready()
    await vi.waitFor(() => { expect(connect).toHaveBeenCalledTimes(2) })
    const disposal = closing.ctx.fiber.dispose()
    opening.reject(new Error('transport released'))
    await disposal
    expect(closing.exit).not.toHaveBeenCalled()
    expect(closing.stderr).toEqual([])
  })

  it('requires the profile launcher, a workspace, and a known consent mode', () => {
    const ctx = new Context()
    roots.push(ctx)
    provideCmdline(ctx, { args: [], exit: () => {}, ready: { onReady: () => () => {} } })
    expect(() => { frontend.apply(ctx, frontend.Config({ workspace })) }).toThrow('requires the dsh profile launcher')
    expect(frontend.Config({ workspace })).toEqual({ consent: 'elicit', workspace })
    expect(() => frontend.Config({})).toThrow()
    expect(() => frontend.Config({ workspace, consent: 'ask' as 'allow' })).toThrow()
  })
})
