/** Web runtime dist ownership, advertised addresses, exposure warnings, and shell context. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { bindUrlHost, type WebServer } from '@deepseek-ai/dsh-host-webserver'
import { apply, Config, internals } from '../src/index.ts'

let dist: string | undefined
const originalResolve = internals.resolveDistIndex

afterEach(() => {
  vi.restoreAllMocks()
  internals.resolveDistIndex = originalResolve
  if (dist !== undefined) {
    if (!isAbsolute(dist) || dirname(dist) !== resolve(tmpdir()) || !basename(dist).startsWith('dsh-web-app-')) {
      throw new Error(`refusing unexpected fixture cleanup path: ${dist}`)
    }
    rmSync(dist, { recursive: true, force: true })
  }
  dist = undefined
})

/** Supply a distribution owned by this test without invoking a frontend build. */
function stageDist(): void {
  dist = mkdtempSync(join(tmpdir(), 'dsh-web-app-'))
  mkdirSync(join(dist, 'dist'))
  const index = join(dist, 'dist', 'index.html')
  writeFileSync(index, '<head></head><body>shell</body>')
  internals.resolveDistIndex = () => index
}

/** Web carrier without a network listener; address formatting follows production. */
function fakeHttpServer(host = '127.0.0.1', protocol: 'http:' | 'https:' = 'http:'): WebServer {
  const server: Pick<WebServer, 'host' | 'port' | 'protocol' | 'getOrigin' | 'registerFallback' | 'renderIndex'> = {
    host, port: 4567, protocol,
    getOrigin() { return `${protocol}//${bindUrlHost(host) ?? ''}:${String(this.port)}` },
    registerFallback: () => () => {},
    renderIndex: (html: string) => html,
  }
  return server as WebServer
}

interface BashContribution {
  name: string
  variables: Record<string, { description: string }>
  resolve: () => Record<string, string>
}

function context(host = '127.0.0.1', protocol: 'http:' | 'https:' = 'http:'): Context {
  stageDist()
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('webServer', fakeHttpServer(host, protocol))
  return ctx
}

function shellContributions(ctx: Context): BashContribution[] {
  const contributions: BashContribution[] = []
  ctx.provide('shellEnv', {
    register(contribution: BashContribution) {
      contributions.push(contribution)
      return () => { contributions.splice(contributions.indexOf(contribution), 1) }
    },
  } as never)
  return contributions
}

describe('web-app runtime glue', () => {
  it.each([
    { mode: 'omitted', enabled: true },
    { mode: 'disabled', enabled: false },
  ])('publishes and opens entries with $mode startup flags', async ({ enabled }) => {
    const ctx = context()
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const open = vi.spyOn(internals, 'openBrowser').mockResolvedValue(undefined)
    ctx.on('webserver/entry-url', (baseUrl, entries) => {
      entries.push({ label: 'dsh web', url: `${baseUrl}/?token=fixture`, open: true })
    })
    const config = enabled ? new Config() : new Config({ surfaceContext: false, printUrl: false, openBrowser: false })
    expect(config).toMatchObject({ printUrl: enabled, openBrowser: enabled })
    apply(ctx, config)
    expect(log).toHaveBeenCalledTimes(enabled ? 2 : 0)
    expect(open).toHaveBeenCalledTimes(enabled ? 1 : 0)
    if (enabled) {
      expect(log).toHaveBeenCalledWith('dsh web: http://127.0.0.1:4567/?token=fixture')
      expect(open).toHaveBeenCalledWith('http://127.0.0.1:4567/?token=fixture', expect.any(AbortSignal))
      await open.mock.results[0]!.value
    }
  })

  it.each([
    { bind: '127.0.0.1', advertised: '127.0.0.1' },
    { bind: '::1', advertised: '[::1]' },
    { bind: '::ffff:127.0.0.1', advertised: '127.0.0.1' },
    { bind: '::ffff:7f00:1', advertised: '127.0.0.1' },
    { bind: '0:0:0:0:0:ffff:7f08:a', advertised: '127.8.0.10' },
    { bind: '::ffff:127.0.0.1%lo', advertised: '127.0.0.1' },
    { bind: '::0.0.0.1', advertised: '[::1]' },
    { bind: '::0.0.0.1%lo', advertised: '[::1]' },
    { bind: '::1%lo', advertised: '[::1]' },
  ])('advertises $bind and publishes the same clean address to shell context', async ({ bind, advertised }) => {
    const ctx = context(bind)
    const contributions = shellContributions(ctx)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    apply(ctx, new Config({ printUrl: false, openBrowser: false, surfaceContext: true }))
    const url = `http://${advertised}:4567`
    expect(ctx.webApp.getAdvertisedUrl()).toBe(url)
    await vi.waitFor(() => {
      expect(contributions.find(item => item.name === 'web-runtime')?.resolve()).toEqual({ DSH_WEB_URL: url })
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it('advertises the configured public root behind a prefix-stripping proxy', async () => {
    const ctx = context()
    const contributions = shellContributions(ctx)
    apply(ctx, new Config({ printUrl: false, openBrowser: false, surfaceContext: true, publicUrl: 'https://proxy.example:8443/web' }))
    expect(ctx.webApp.getAdvertisedUrl()).toBe('https://proxy.example:8443/web/')
    await vi.waitFor(() => {
      expect(contributions.find(item => item.name === 'web-runtime')?.resolve()).toEqual({
        DSH_WEB_URL: 'https://proxy.example:8443/web/',
      })
    })
  })

  it('skips shell context registration when surface context is disabled', async () => {
    const ctx = context()
    const contributions = shellContributions(ctx)
    apply(ctx, new Config({ printUrl: false, openBrowser: false, surfaceContext: false }))
    const available = Promise.withResolvers<undefined>()
    ctx.inject(['shellEnv'], () => { available.resolve(undefined) })
    await available.promise
    expect(contributions).toEqual([])
    expect(ctx.webApp.getAdvertisedUrl()).toBe('http://127.0.0.1:4567')
  })

  it.each([
    { bind: '10.1.2.3', advertised: '10.1.2.3' },
    { bind: '::127.0.0.1', advertised: '[::127.0.0.1]' },
  ])('warns about plaintext exposure and advertises the $bind bind address', ({ bind, advertised }) => {
    const ctx = context(bind)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    apply(ctx, new Config({ printUrl: false, openBrowser: false, surfaceContext: false }))
    expect(ctx.webApp.getAdvertisedUrl()).toBe(`http://${advertised}:4567`)
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      `dsh web: listening on ${bind} over plain HTTP; restrict this port to a trusted proxy or network`,
    )
  })

  it('keeps the plaintext warning when an HTTPS public URL fronts an HTTP listener', () => {
    const ctx = context('10.1.2.3')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    apply(ctx, new Config({ printUrl: false, openBrowser: false, surfaceContext: false, publicUrl: 'https://proxy.example/ui/' }))
    expect(warn).toHaveBeenCalledOnce()
    expect(ctx.webApp.getAdvertisedUrl()).toBe('https://proxy.example/ui/')
  })

  it('advertises listener TLS without a plaintext warning', () => {
    const ctx = context('10.1.2.3', 'https:')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    apply(ctx, new Config({ printUrl: false, openBrowser: false, surfaceContext: false }))
    expect(ctx.webApp.getAdvertisedUrl()).toBe('https://10.1.2.3:4567')
    expect(warn).not.toHaveBeenCalled()
  })

  it.each(['fe80::1%lo', '::127.0.0.1%lo'])('requires publicUrl when %s cannot form an advertised URL', (bind) => {
    const ctx = context(bind)
    expect(() => { apply(ctx, new Config({ printUrl: false, openBrowser: false, surfaceContext: false })) })
      .toThrow(/carries an interface zone id, which no URL can express; pass --public-url/u)
    const declared = new Context()
    onTestFinished(() => declared.fiber.dispose())
    declared.provide('webServer', fakeHttpServer(bind))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    apply(declared, new Config({ printUrl: false, openBrowser: false, surfaceContext: false, publicUrl: 'https://app.example/ui/' }))
    expect(declared.webApp.getAdvertisedUrl()).toBe('https://app.example/ui/')
  })

  it('uses the bind address when publicUrl is explicitly null', () => {
    const ctx = context()
    apply(ctx, new Config({ printUrl: false, openBrowser: false, surfaceContext: false, publicUrl: null as never }))
    expect(ctx.webApp.getAdvertisedUrl()).toBe('http://127.0.0.1:4567')
  })

  it('anchors the dist index on the frontend package manifest without requiring a built dist', () => {
    expect(originalResolve()).toMatch(/dist[/\\]index\.html$/)
  })
})
