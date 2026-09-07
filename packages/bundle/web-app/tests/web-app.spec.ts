/**
 * Web runtime glue behavior: dist resolution through the bundle's own hook,
 * the frontend-static child claiming the fallback seat, the web-surface
 * prompt section and bash runtime variables, and readiness publication through
 * the URL line and default-browser handoff.
 */

import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { apply, Config, internals } from '../src/index.ts'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}))

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  networkInterfaces: () => ({
    lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    en0: [{ family: 'IPv4', internal: false, address: '192.168.1.5' }],
  }),
}))

let dist: string | undefined

beforeEach(() => {
  vi.stubEnv('SSH_CONNECTION', '')
  vi.stubEnv('SSH_TTY', '')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(spawn).mockReset()
  vi.unstubAllEnvs()
  internals.resolveDistIndex = originalResolve
  internals.openBrowser = originalOpenBrowser
  if (dist !== undefined) rmSync(dist, { recursive: true, force: true })
  dist = undefined
})

const originalResolve = internals.resolveDistIndex
const originalOpenBrowser = internals.openBrowser

type BrowserLauncher = ChildProcess & { stderr: PassThrough }

/** Minimal browser-launcher process for the native handoff adapter. */
function launcher(): BrowserLauncher {
  return Object.assign(new EventEmitter(), { stderr: new PassThrough() }) as unknown as BrowserLauncher
}

/** Stage a dist fixture and point the bundle's resolver at it. */
function stageDist(): string {
  dist = mkdtempSync(join(tmpdir(), 'dsh-web-app-'))
  mkdirSync(join(dist, 'dist'))
  const index = join(dist, 'dist', 'index.html')
  writeFileSync(index, '<head></head><body>shell</body>')
  internals.resolveDistIndex = () => index
  return index
}

/** A fake webServer capturing the fallback seat and index taps. */
function fakeHttpServer(host: '127.0.0.1' | '0.0.0.0' = '127.0.0.1'): { server: WebServer; seat: () => unknown } {
  let fallback: unknown
  const server = {
    host,
    port: 4567,
    registerFallback: (handler: unknown) => {
      fallback = handler
      return () => { fallback = undefined }
    },
    renderIndex: (html: string) => html,
  } as unknown as WebServer
  return { server, seat: () => fallback }
}

/** Deterministic Host Connection face for URL publication and frontend injection. */
function provideConnection(ctx: Context): void {
  ctx.provide('connection', {
    authenticatedUrl(baseUrl: string) {
      const url = new URL(baseUrl)
      url.pathname = '/'
      url.searchParams.set('token', 'test-token')
      return url.href
    },
    authorizeIndex: () => true,
    requestRejection: () => undefined,
    rpc: {},
  } as never)
}

/** A fake Loader whose settlement the test controls (the URL line waits on it). */
function provideLoader(ctx: Context, settle: () => Promise<void> = async () => {}): void {
  ctx.provide('loader', { await: settle } as never)
}

interface BashContribution {
  name: string
  variables: Record<string, { description: string }>
  resolve: () => Record<string, string>
}

describe('web-app runtime glue', () => {
  it('mounts dist serving, prompt section, bash variables, and publishes the URL with the LAN snapshot', async () => {
    stageDist()
    const ctx = new Context()
    // Editor markers and a project .env SSH value do not establish a remote launch.
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
      { source: 'process', values: { VSCODE_IPC_HOOK_CLI: '/tmp/local-vscode-ipc' } },
      { source: 'project-env', path: '/work/.env', values: { SSH_CONNECTION: 'stale-project-value' } },
    ]))
    const { server, seat } = fakeHttpServer('0.0.0.0')
    ctx.provide('webServer', server)
    provideConnection(ctx)
    const contributions: BashContribution[] = []
    ctx.provide('shellEnv', {
      register: (contribution: BashContribution) => {
        contributions.push(contribution)
        return () => {}
      },
    } as never)
    provideLoader(ctx)
    const lifecycle: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((message) => { lifecycle.push(String(message)) })
    const openBrowser = vi.fn(async (url: string) => { lifecycle.push(`open:${url}`) })
    internals.openBrowser = openBrowser
    apply(ctx, new Config({ openBrowser: true, printUrl: true, surfaceContext: true, trustedHosts: ['lab.internal'] }))
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    // Settle the injected registrations.
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(seat()).toBeDefined() // frontend-static claimed the fallback
    expect(ctx.get('webRuntime')).toEqual({
      lanAddresses: ['192.168.1.5'],
      trustedHosts: ['192.168.1.5', 'lab.internal'],
    })
    expect(log).toHaveBeenCalledWith('dsh web: http://127.0.0.1:4567/?token=test-token (LAN: http://192.168.1.5:4567/?token=test-token)')
    expect(log).toHaveBeenCalledWith('dsh web: opening the default browser; pass --no-open to disable')
    expect(openBrowser).toHaveBeenCalledWith('http://127.0.0.1:4567/?token=test-token')
    expect(lifecycle).toEqual([
      'dsh web: http://127.0.0.1:4567/?token=test-token (LAN: http://192.168.1.5:4567/?token=test-token)',
      'dsh web: opening the default browser; pass --no-open to disable',
      'open:http://127.0.0.1:4567/?token=test-token',
    ])
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.find(entry => entry.name === 'harness:source')?.text).toContain('DeepSeek Harness implementation checkout')
    const section = assembly.sections.find(entry => entry.name === 'app:web-surface')
    expect(section?.text).toContain('http://127.0.0.1:4567')
    // The single update contract: the receiver is always on; no-refresh
    // reloads additionally need the rebuild watcher.
    expect(section?.text).toContain('pnpm run dev:web')
    const webRuntime = contributions.find(contribution => contribution.name === 'web-runtime')
    expect(webRuntime?.resolve()).toEqual({ DSH_WEB_URL: 'http://127.0.0.1:4567' })
    await ctx.fiber.dispose()
  })

  it('publishes no readiness side effect when printing and browser opening are disabled', async () => {
    stageDist()
    const ctx = new Context()
    ctx.provide('webServer', fakeHttpServer().server)
    provideConnection(ctx)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const openBrowser = vi.fn(async () => {})
    internals.openBrowser = openBrowser
    apply(ctx, new Config({ openBrowser: false, printUrl: false, surfaceContext: true, trustedHosts: [] }))
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).not.toHaveBeenCalled()
    expect(openBrowser).not.toHaveBeenCalled()
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.find(entry => entry.name === 'app:web-surface')?.text)
      .toContain('rebuilding the affected Web artifacts')
    await ctx.fiber.dispose()
  })

  it('skips the surface context when disabled (the one-shot layer): no prompt section, no bash variables', async () => {
    stageDist()
    const ctx = new Context()
    ctx.provide('webServer', fakeHttpServer().server)
    provideConnection(ctx)
    const contributions: BashContribution[] = []
    ctx.provide('shellEnv', {
      register: (contribution: BashContribution) => {
        contributions.push(contribution)
        return () => {}
      },
    } as never)
    apply(ctx, new Config({ openBrowser: false, printUrl: false, surfaceContext: false, trustedHosts: [] }))
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await new Promise(resolve => setTimeout(resolve, 0))
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.some(entry => entry.name === 'app:web-surface')).toBe(false)
    expect(assembly.sections.some(entry => entry.name === 'harness:source')).toBe(false)
    expect(contributions).toEqual([])
    await ctx.fiber.dispose()
  })

  it('prints the loopback-only URL line when no LAN snapshot exists', async () => {
    stageDist()
    const ctx = new Context()
    ctx.provide('webServer', fakeHttpServer().server)
    provideConnection(ctx)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    apply(ctx, new Config({ openBrowser: false, printUrl: true, surfaceContext: true, trustedHosts: [] }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).toHaveBeenCalledWith('dsh web: http://127.0.0.1:4567/?token=test-token')
    await ctx.fiber.dispose()
  })

  it('does not publish readiness again when Connection reloads', async () => {
    stageDist()
    const ctx = new Context()
    ctx.provide('webServer', fakeHttpServer().server)
    const first = ctx.plugin((connectionCtx: Context) => { provideConnection(connectionCtx) })
    await first
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    apply(ctx, new Config({ openBrowser: false, printUrl: true, surfaceContext: true, trustedHosts: [] }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).toHaveBeenCalledTimes(1)

    await first.dispose()
    await ctx.plugin((connectionCtx: Context) => { provideConnection(connectionCtx) })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it.each([
    ['SSH_CONNECTION', '10.0.0.2 55000 10.0.0.9 22'],
    ['SSH_TTY', '/dev/pts/3'],
  ] as const)('prints the host URL but skips browser handoff when %s marks an SSH launch', async (name, value) => {
    vi.stubEnv(name, value)
    stageDist()
    const ctx = new Context()
    ctx.provide('webServer', fakeHttpServer().server)
    provideConnection(ctx)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const openBrowser = vi.fn(async () => {})
    internals.openBrowser = openBrowser
    apply(ctx, new Config({ openBrowser: true, printUrl: true, surfaceContext: false, trustedHosts: [] }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).toHaveBeenCalledWith('dsh web: http://127.0.0.1:4567/?token=test-token')
    expect(openBrowser).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('defers readiness publication until Loader settlement and drops it on failure or teardown', async () => {
    stageDist()
    const openBrowser = vi.fn(async () => {})
    internals.openBrowser = openBrowser
    // Settlement path: both actions wait for loader.await() so their consumers
    // can request the complete app immediately.
    const settled = new Context()
    settled.provide('webServer', fakeHttpServer().server)
    provideConnection(settled)
    let release: () => void
    const settlement = new Promise<void>((resolve) => { release = resolve })
    provideLoader(settled, () => settlement)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    apply(settled, new Config({ openBrowser: true, printUrl: true, surfaceContext: true, trustedHosts: [] }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).not.toHaveBeenCalled()
    expect(openBrowser).not.toHaveBeenCalled()
    release!()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).toHaveBeenCalledWith('dsh web: http://127.0.0.1:4567/?token=test-token')
    expect(openBrowser).toHaveBeenCalledWith('http://127.0.0.1:4567/?token=test-token')
    await settled.fiber.dispose()

    // Failed path: Loader reports the sibling failure; the app prints no URL
    // for a process that is about to exit.
    log.mockClear()
    openBrowser.mockClear()
    const failed = new Context()
    failed.provide('webServer', fakeHttpServer().server)
    provideConnection(failed)
    provideLoader(failed, async () => { throw new Error('boot failed') })
    apply(failed, new Config({ openBrowser: true, printUrl: true, surfaceContext: true, trustedHosts: [] }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).not.toHaveBeenCalled()
    expect(openBrowser).not.toHaveBeenCalled()
    await failed.fiber.dispose()

    // Torn-down path: settlement resolves after the webserver is gone — no
    // line, no crash.
    log.mockClear()
    openBrowser.mockClear()
    const torn = new Context()
    const child = torn.plugin((childCtx: Context) => {
      childCtx.provide('webServer', fakeHttpServer().server)
      provideConnection(childCtx)
    })
    await child
    let releaseTorn: () => void
    const tornSettlement = new Promise<void>((resolve) => { releaseTorn = resolve })
    provideLoader(torn, () => tornSettlement)
    apply(torn, new Config({ openBrowser: true, printUrl: true, surfaceContext: true, trustedHosts: [] }))
    await new Promise(resolve => setTimeout(resolve, 0))
    await child.dispose() // the webServer service goes away
    releaseTorn!()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).not.toHaveBeenCalled()
    expect(openBrowser).not.toHaveBeenCalled()
    await torn.fiber.dispose()
  })

  it('fails loud when the prompt section resolves against a portless webserver', async () => {
    stageDist()
    const ctx = new Context()
    // A webserver whose bound port is gone (torn down mid-request): the
    // section must throw, never render a URL with an undefined port.
    const { server } = fakeHttpServer()
    Object.defineProperty(server, 'port', { get: () => undefined })
    ctx.provide('webServer', server)
    provideConnection(ctx)
    apply(ctx, new Config({ openBrowser: false, printUrl: false, surfaceContext: true, trustedHosts: [] }))
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await new Promise(resolve => setTimeout(resolve, 0))
    await expect(ctx.systemPrompt.assemble()).rejects.toThrow('webServer service missing')
    await ctx.fiber.dispose()
  })

  it('anchors the dist index on the frontend package manifest without requiring a built dist', () => {
    // The production resolver (not the test hook): the anchor resolves on any
    // checkout, built or not — dist existence is the fallback owner's
    // request-time concern, so a dist-less composition (the static worker
    // preview ships its own page) still boots.
    expect(originalResolve()).toMatch(/dist[/\\]index\.html$/)
  })

  it.each([
    ['Error', new Error('no desktop'), 'no desktop'],
    ['non-Error', 'desktop unavailable', 'desktop unavailable'],
  ] as const)('keeps the server running and reports the manual URL when a browser failure is %s', async (_kind, failure, reason) => {
    stageDist()
    const ctx = new Context()
    ctx.provide('webServer', fakeHttpServer().server)
    provideConnection(ctx)
    internals.openBrowser = vi.fn(async () => { throw failure })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    apply(ctx, new Config({ openBrowser: true, printUrl: false, surfaceContext: false, trustedHosts: [] }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).toHaveBeenCalledWith('dsh web: opening the default browser; pass --no-open to disable')
    expect(diagnostic).toHaveBeenCalledWith(
      `web-app: could not open the default browser because ${reason}; use the dsh web URL printed at startup`,
    )
    expect(ctx.get('webServer')).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('scrubs the helper environment and reports helper spawn or exit failures', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'must-not-reach-browser')
    vi.stubEnv('DSH_HOME', '/must-not-reach-browser')
    const completed = launcher()
    vi.mocked(spawn).mockReturnValueOnce(completed)
    const completion = originalOpenBrowser('http://127.0.0.1:4567')
    const [command, args, options] = vi.mocked(spawn).mock.calls[0]!
    expect(command).toBe(process.execPath)
    expect(args).toEqual([
      '--input-type=module',
      '--eval', expect.stringContaining('await import('),
      '--', 'http://127.0.0.1:4567',
    ])
    expect(args?.[2]).toContain("if (process.platform === 'win32')")
    expect(args?.[2]).toContain('launcher.ref()')
    expect(options?.env).not.toHaveProperty('DEEPSEEK_API_KEY')
    expect(options?.env).not.toHaveProperty('DSH_HOME')
    expect(options?.env?.PATH).toBe(process.env.PATH)
    expect(options?.stdio).toEqual(['ignore', 'inherit', 'pipe'])
    completed.emit('close', 0)
    await expect(completion).resolves.toBeUndefined()
    expect(completed.listenerCount('error')).toBe(0)

    const completedWithStderr = launcher()
    vi.mocked(spawn).mockReturnValueOnce(completedWithStderr)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const completionWithStderr = originalOpenBrowser('http://127.0.0.1:4567')
    completedWithStderr.stderr?.write('launcher note\n')
    completedWithStderr.emit('close', 0)
    await expect(completionWithStderr).resolves.toBeUndefined()
    expect(stderr).toHaveBeenCalledWith('launcher note\n')

    const failedWithReason = launcher()
    vi.mocked(spawn).mockReturnValueOnce(failedWithReason)
    const reasonFailure = originalOpenBrowser('http://127.0.0.1:4567')
    const reasonAssertion = expect(reasonFailure).rejects.toThrow('desktop unavailable')
    failedWithReason.stderr?.write('Error: desktop unavailable\n    at fixture')
    failedWithReason.emit('close', 1)
    await reasonAssertion

    const failed = launcher()
    vi.mocked(spawn).mockReturnValueOnce(failed)
    const failure = originalOpenBrowser('http://127.0.0.1:4567')
    const failureAssertion = expect(failure).rejects.toThrow('exited with code 3')
    await Promise.resolve()
    failed.emit('close', 3)
    await failureAssertion

    const errored = launcher()
    vi.mocked(spawn).mockReturnValueOnce(errored)
    const error = originalOpenBrowser('http://127.0.0.1:4567')
    const errorAssertion = expect(error).rejects.toThrow('spawn failed')
    await Promise.resolve()
    errored.emit('error', new Error('spawn failed'))
    await errorAssertion
    expect(errored.listenerCount('close')).toBe(0)
  })
})
