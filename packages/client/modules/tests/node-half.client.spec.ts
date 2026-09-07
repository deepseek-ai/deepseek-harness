/** Node-half composition diagnostics for package metadata and built client bundles. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SourceMap } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderIndexInjections, type WebServer, type WebRoute } from '@deepseek-ai/dsh-host-webserver'
import * as modulesClient from '../src/client/index.ts'
import { ClientModuleRegistry, bootInjections, orderByModuleGraph } from '../src/index.ts'
import type { ClientModuleLoaderTarget, WebBootEntry, WebBootGraph } from '../src/client/index.ts'

const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const UI_RENDERER_ID = '@deepseek-ai/dsh-client-ui-renderer'

const comboUrl = (ids: readonly string[], rev: string): string =>
  `/plugins/??${ids.map(id => `${id}/client.js`).join(',')}&rev=${rev}`
const mapUrl = (url: string): string => url.replace(/\/client\.js(?=,|&rev=)/g, '/client.js.map')
const BOOTSTRAP_URL = comboUrl([MODULES_ID], 'boot')
const APPLICATION_URL = comboUrl([UI_RENDERER_ID], 'app')

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

/** Create a resolvable package whose client export points at the returned path. */
function writePackage(
  packageName: string,
  metadata: Record<string, unknown> = { dsh: { client: { platform: 'web' } } },
): string {
  root ??= realpathSync(mkdtempSync(join(tmpdir(), 'dsh-client-modules-')))
  const pkgRoot = join(root, 'node_modules', ...packageName.split('/'))
  const clientPath = join(pkgRoot, 'lib', 'client.js')
  mkdirSync(pkgRoot, { recursive: true })
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
    name: packageName,
    exports: {
      './client': './lib/client.js',
      './package.json': './package.json',
    },
    ...metadata,
  }))
  return clientPath
}

/** Create a built package with the supplied client declaration. */
function writeBuiltPackage(packageName: string, client: Record<string, unknown>): void {
  const clientPath = writePackage(packageName, { dsh: { client: { platform: 'web', ...client } } })
  mkdirSync(dirname(clientPath), { recursive: true })
  writeFileSync(clientPath, 'module.exports = {}\n')
}

/** Construct the node-half service and capture its plugin-bundle route. */
function constructWithRoute(
  packageNames: string[],
  options: {
    contextBaseUrl?: string
    entryBaseUrl?: string
    internal?: NonNullable<Context['loader']['internal']>
  } = {},
): { context: Context; service: ClientModuleRegistry; route: WebRoute } {
  const ctx = new Context()
  ctx.baseUrl = options.contextBaseUrl ?? pathToFileURL(root!).href + '/'
  ctx.provide('loader', {
    internal: options.internal,
    *entries() {
      for (const packageName of packageNames) {
        yield {
          options: { name: packageName },
          fiber: {},
          disabled: false,
          parent: { tree: { ctx: { baseUrl: options.entryBaseUrl ?? ctx.baseUrl } } },
        }
      }
    },
  })
  let route: WebRoute | undefined
  const webServer: Pick<WebServer, 'port' | 'register' | 'tapIndex'> = {
    port: 0,
    register: (candidate) => {
      if (candidate.path === '/plugins') route = candidate
      return () => {}
    },
    tapIndex: () => () => {},
  }
  ctx.provide('webServer', webServer as WebServer)
  const service = new ClientModuleRegistry(ctx)
  if (route === undefined) throw new Error('client bundle route was not registered')
  return { context: ctx, service, route }
}

/** Construct the node-half service over the enabled fixture entries. */
function construct(packageNames: string[]): ClientModuleRegistry {
  return constructWithRoute(packageNames).service
}

/** Invoke the registered plugin route and capture status, headers, and bytes. */
async function routeRequest(route: WebRoute, url: string, method = 'GET'): Promise<{
  status: number
  headers: Record<string, string> | undefined
  body: Buffer
}> {
  let status = 0
  let headers: Record<string, string> | undefined
  let body = Buffer.alloc(0)
  const response = {
    writeHead(nextStatus: number, nextHeaders?: Record<string, string>) {
      status = nextStatus
      headers = nextHeaders
      return response
    },
    end(chunk?: Uint8Array) {
      body = chunk === undefined ? Buffer.alloc(0) : Buffer.from(chunk)
      return response
    },
  } as unknown as ServerResponse
  await route.handler({ method, url } as IncomingMessage, response)
  return { status, headers, body }
}

/** Execute the exact first inline script emitted by the Host boot rows. */
function injectedFacade(graph: WebBootGraph): { html: string; target: ClientModuleLoaderTarget } {
  const html = renderIndexInjections(
    '<html><head></head><body><script type="module" src="/index.js"></script></body></html>',
    bootInjections(graph),
  )
  const source = /<head><script>([\s\S]*?)<\/script>/.exec(html)?.[1]
  if (source === undefined) throw new Error('missing injected ModuleLoader facade script')
  const window: { __ModuleLoader__?: ClientModuleLoaderTarget } = {}
  runInNewContext(source, { window })
  if (window.__ModuleLoader__ === undefined) throw new Error('facade script did not install __ModuleLoader__')
  return { html, target: window.__ModuleLoader__ }
}

const bootGraph = (): WebBootGraph => ({
  rev: 'graph',
  entries: [
    { id: MODULES_ID, url: comboUrl([MODULES_ID], 'm'), rev: 'm' },
    { id: UI_RENDERER_ID, url: comboUrl([UI_RENDERER_ID], 'r'), rev: 'r' },
  ],
  batches: [
    {
      phase: 'bootstrap',
      url: BOOTSTRAP_URL,
      rev: 'boot',
      entries: [MODULES_ID],
    },
    {
      phase: 'application',
      url: APPLICATION_URL,
      rev: 'app',
      entries: [UI_RENDERER_ID],
    },
  ],
})

describe('HTML bootstrap facade', () => {
  it('precedes blocking preloads and the boot graph, then becomes the live registration target', async () => {
    const graph = bootGraph()
    const { html, target } = injectedFacade(graph)
    const facadeAt = html.indexOf('window.__ModuleLoader__=')
    const applicationAt = html.indexOf(
      `<link rel="preload" as="script" href="${APPLICATION_URL.replaceAll('&', '&amp;')}">`,
    )
    const bootstrapAt = html.indexOf(`<script src="${BOOTSTRAP_URL.replaceAll('&', '&amp;')}"></script>`)
    const graphAt = html.indexOf('globalThis["__DSH_BOOT__"] = ')
    const entryAt = html.indexOf('<script type="module" src="/index.js"></script>')
    expect([facadeAt, applicationAt, bootstrapAt, graphAt, entryAt]).toEqual([...new Set([
      facadeAt, applicationAt, bootstrapAt, graphAt, entryAt,
    ])].sort((a, b) => a - b))

    target.load({ id: MODULES_ID, factory: () => modulesClient })
    const system = target.create({
      boot: graph,
      staticModules: {},
      loadBundle: async (url) => {
        expect(url).toBe(APPLICATION_URL)
        target.load({ id: UI_RENDERER_ID, factory: () => ({ marker: 'ui-renderer' }) })
      },
    })

    expect(target.mode).toBe('live')
    expect(target.pendingQueue).toEqual([])
    expect(system.manifest.rev).toBe('graph')
    expect(await system.import(MODULES_ID)).toBe(modulesClient)
    expect(await system.import(`${UI_RENDERER_ID}/client`)).toEqual({ marker: 'ui-renderer' })
    expect(() => target.create({ boot: graph, staticModules: {} }))
      .toThrow('create called after module-system boot')
  })

  it('preloads every application combo', () => {
    const graph = bootGraph()
    const secondId = '@fixture/second-application-combo'
    const secondUrl = comboUrl([secondId], 'app-2')
    graph.entries.push({ id: secondId, url: comboUrl([secondId], 'row-2'), rev: 'row-2' })
    graph.batches.push({ phase: 'application', url: secondUrl, rev: 'app-2', entries: [secondId] })
    expect(bootInjections(graph).flatMap(row => row.kind === 'script-preload' ? [row.src] : []))
      .toEqual([APPLICATION_URL, secondUrl])
  })

  it('rejects a page that did not preload the modules bundle', () => {
    const graph = bootGraph()
    const { target } = injectedFacade(graph)
    expect(() => target.create({ boot: graph, staticModules: {} }))
      .toThrow(`HTML did not preload ${MODULES_ID}/client.js`)
  })

  it('rejects a bootstrap bundle with a runtime external', () => {
    const graph = bootGraph()
    const { target } = injectedFacade(graph)
    target.load({
      id: MODULES_ID,
      factory: (require) => {
        require('react')
        return modulesClient
      },
    })
    expect(() => target.create({ boot: graph, staticModules: {} }))
      .toThrow(`${MODULES_ID}/client.js requested external "react"`)
  })

  it.each([
    null,
    { ...modulesClient, createClientModuleSystem: undefined },
    { ...modulesClient, apply: undefined },
  ])('rejects a bootstrap bundle without the complete module face', (exports) => {
    const graph = bootGraph()
    const { target } = injectedFacade(graph)
    target.load({ id: MODULES_ID, factory: () => exports as unknown as Record<string, unknown> })
    expect(() => target.create({ boot: graph, staticModules: {} }))
      .toThrow(`${MODULES_ID}/client.js did not export the bootstrap module face`)
  })
})

describe('client bundle activation', () => {
  it.each(['v1', 'v2'] as const)(
    'resolves %s package metadata from the owning entry tree',
    (version) => {
      const packageName = `@fixture/entry-base-${version}`
      const clientPath = writePackage(packageName)
      const hostPath = join(dirname(clientPath), 'index.js')
      mkdirSync(dirname(hostPath), { recursive: true })
      writeFileSync(hostPath, 'export default {}\n')
      writeFileSync(clientPath, 'module.exports = {}\n')
      const contextBaseUrl = pathToFileURL(join(root!, 'profile')).href + '/'
      const entryBaseUrl = pathToFileURL(join(root!, 'overlay')).href + '/'
      const calls: unknown[][] = []
      const resolveSync = (...args: unknown[]) => {
        calls.push(args)
        return { format: 'module' as const, url: pathToFileURL(hostPath).href }
      }
      const internal = { version, resolveSync }

      const { service } = constructWithRoute([packageName], {
        contextBaseUrl,
        entryBaseUrl,
        internal: internal as NonNullable<Context['loader']['internal']>,
      })

      expect(calls).toEqual(version === 'v2'
        ? [[entryBaseUrl, { specifier: packageName, attributes: {} }]]
        : [[packageName, entryBaseUrl, {}]])
      expect(service.clientPath(packageName)).toBe(clientPath)
      expect(service.graph().entries.map(entry => entry.id)).toEqual([packageName])
    },
  )

  it('derives the browser module id from a file entry owning manifest', () => {
    const packageName = '@fixture/file-entry'
    const clientPath = writePackage(packageName)
    const hostPath = join(dirname(clientPath), 'index.js')
    mkdirSync(dirname(hostPath), { recursive: true })
    writeFileSync(hostPath, 'export default {}\n')
    writeFileSync(clientPath, 'module.exports = {}\n')

    const service = construct([pathToFileURL(hostPath).href])

    expect(service.clientPath(packageName)).toBe(clientPath)
    expect(service.graph().entries.map(entry => entry.id)).toEqual([packageName])
  })

  it.each(['relative', 'absolute'] as const)(
    'finds the owning manifest through the %s-path fallback without Node loader internals',
    (kind) => {
      const packageName = `@fixture/${kind}-fallback-entry`
      const clientPath = writePackage(packageName)
      const packageRoot = dirname(dirname(clientPath))
      const hostPath = join(packageRoot, 'index.js')
      mkdirSync(dirname(clientPath), { recursive: true })
      writeFileSync(hostPath, 'export default {}\n')
      writeFileSync(clientPath, 'module.exports = {}\n')
      const loaderName = kind === 'relative' ? './index.js' : hostPath

      const { service } = constructWithRoute([loaderName], {
        entryBaseUrl: pathToFileURL(packageRoot).href + '/',
      })

      expect(service.clientPath(packageName)).toBe(clientPath)
      expect(service.graph().entries.map(entry => entry.id)).toEqual([packageName])
    },
  )

  it.each(['v1', 'v2', 'worker'] as const)(
    'derives a file entry package id through the %s Loader resolver',
    (version) => {
      const packageName = `@fixture/file-entry-${version}`
      const clientPath = writePackage(packageName)
      const hostPath = join(dirname(clientPath), 'index.js')
      mkdirSync(dirname(hostPath), { recursive: true })
      writeFileSync(hostPath, 'export default {}\n')
      writeFileSync(clientPath, 'module.exports = {}\n')
      const loaderName = pathToFileURL(hostPath).href
      const entryBaseUrl = pathToFileURL(join(root!, 'overlay')).href + '/'
      const calls: unknown[][] = []
      const resolveSync = (...args: unknown[]) => {
        calls.push(args)
        return { format: 'module' as const, url: loaderName }
      }
      const internal = { version, resolveSync }

      const { service } = constructWithRoute([loaderName], {
        entryBaseUrl,
        internal: internal as NonNullable<Context['loader']['internal']>,
      })

      expect(calls).toEqual(version === 'v2'
        ? [[entryBaseUrl, { specifier: loaderName, attributes: {} }]]
        : [[loaderName, entryBaseUrl, {}]])
      expect(service.graph().entries.map(entry => entry.id)).toEqual([packageName])
    },
  )

  it('rejects distinct active Loader sources for one browser package', () => {
    const packageName = '@fixture/duplicate-source'
    const clientPath = writePackage(packageName)
    const hostPath = join(dirname(clientPath), 'index.js')
    mkdirSync(dirname(hostPath), { recursive: true })
    writeFileSync(hostPath, 'export default {}\n')
    writeFileSync(clientPath, 'module.exports = {}\n')
    const alias = './duplicate-source.js'
    const internal = {
      version: 'v2' as const,
      resolveSync: () => ({ format: 'module' as const, url: pathToFileURL(hostPath).href }),
    }

    expect(() => constructWithRoute([packageName, alias], {
      internal: internal as unknown as NonNullable<Context['loader']['internal']>,
    })).toThrow(
      `client-modules: package ${packageName} resolves from multiple active Loader sources:`,
    )
  })

  it('promotes the remaining Loader source after the selected alias unloads', async () => {
    const packageName = '@fixture/duplicate-source-recovery'
    const clientPath = writePackage(packageName)
    const hostPath = join(dirname(clientPath), 'index.js')
    mkdirSync(dirname(hostPath), { recursive: true })
    writeFileSync(hostPath, 'export default {}\n')
    writeFileSync(clientPath, 'module.exports = {}\n')
    const alias = './duplicate-source-recovery.js'
    const entries = [packageName]
    const internal = {
      version: 'v2' as const,
      resolveSync: () => ({ format: 'module' as const, url: pathToFileURL(hostPath).href }),
    }
    const { context, service } = constructWithRoute(entries, {
      internal: internal as unknown as NonNullable<Context['loader']['internal']>,
    })
    const firstRevision = service.graph().entries[0]!.rev
    const warning = vi.spyOn(context.logger, 'warn').mockImplementation(() => undefined)

    entries.push(alias)
    emitLoaderEntryChange(context, alias)
    await Promise.resolve()
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining(`package ${packageName} resolves from multiple active Loader sources`) as string,
    }))
    expect(service.graph().entries[0]!.rev).toBe(firstRevision)

    entries.splice(entries.indexOf(packageName), 1)
    emitLoaderEntryChange(context, packageName)
    await Promise.resolve()
    expect(service.graph().entries.map(entry => entry.id)).toEqual([packageName])
    expect(service.graph().entries[0]!.rev).not.toBe(firstRevision)
    expect(service.clientPath(packageName)).toBe(clientPath)
  })

  it('uses owning-tree package resolution for an import-only Worker module loader', () => {
    const packageName = '@fixture/worker-loader'
    writeBuiltPackage(packageName, {})
    const internal = {
      version: 'worker',
      import: async () => ({}),
    } as unknown as NonNullable<Context['loader']['internal']>

    const { service } = constructWithRoute([packageName], { internal })

    expect(service.graph().entries.map(entry => entry.id)).toEqual([packageName])
  })

  it('allows sibling dsh roles', () => {
    const currentName = '@fixture/current-client-field'
    const clientPath = writePackage(currentName, {
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web' },
        profile: { bundles: [] },
      },
    })
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    expect(construct([currentName]).graph().entries.map(entry => entry.id)).toEqual([currentName])
  })

  it('groups missing bundles under one source-build instruction with a package/path list', () => {
    const firstName = '@fixture/missing-first'
    const secondName = '@fixture/missing-second'
    const firstPath = writePackage(firstName)
    const secondPath = writePackage(secondName)
    expect(() => construct([firstName, secondName])).toThrow([
      'client-modules: 2 client packages failed to compose:',
      '  client bundles not found; run `pnpm run build` before launch:',
      `    - package: ${firstName}`,
      `      path: ${firstPath}`,
      `    - package: ${secondName}`,
      `      path: ${secondPath}`,
    ].join('\n'))
  })

  it('does not report other bundle read failures as missing builds', () => {
    const packageName = '@fixture/unreadable-client'
    const clientPath = writePackage(packageName)
    mkdirSync(clientPath, { recursive: true })
    let thrown: unknown
    try {
      construct([packageName])
    } catch (error) {
      thrown = error
    }
    expect(String(thrown)).toContain('client-modules: 1 client package failed to compose:')
    expect(String(thrown)).toContain('  other failures:')
    expect(String(thrown)).toContain('EISDIR')
    expect(String(thrown)).not.toContain('pnpm run build')
  })

  it('falls back to a generated-file map when an authored map is malformed', async () => {
    const packageName = '@fixture/malformed-source-map'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    writeFileSync(`${clientPath}.map`, '{')
    const torn = constructWithRoute([packageName])
    const tornRow = torn.service.graph().entries[0]!
    expect((await routeRequest(torn.route, tornRow.url)).body.toString('utf8'))
      .toContain(`sourceMappingURL=${mapUrl(tornRow.url)}`)
    const fallback = await routeRequest(torn.route, mapUrl(torn.service.graph().batches[0]!.url))
    expect(JSON.parse(fallback.body.toString('utf8'))).toMatchObject({
      sections: [{ map: { sources: [`/plugins/${packageName}/client.js`] } }],
    })

    writeFileSync(`${clientPath}.map`, '{"version":3,"sources":[null]}\n')
    expect(() => construct([packageName])).not.toThrow()
  })

  it('maps packed combo sections back to each generated client bundle', async () => {
    const names = ['@fixture/generated-first', '@fixture/generated-second']
    for (const [index, packageName] of names.entries()) {
      const clientPath = writePackage(packageName)
      mkdirSync(dirname(clientPath), { recursive: true })
      writeFileSync(
        clientPath,
        `window.generation = ${String(index)}\n//# sourceURL=packages/client/generated-${String(index)}/lib/client.js`,
      )
    }

    const { service, route } = constructWithRoute(names)
    const batch = service.graph().batches[0]!
    const script = (await routeRequest(route, batch.url)).body.toString('utf8')
    expect(script).not.toContain('//# sourceURL=')
    expect(script).toContain(`//# sourceMappingURL=${mapUrl(batch.url)}`)
    const payload = JSON.parse((await routeRequest(route, mapUrl(batch.url))).body.toString('utf8')) as {
      sections: { map: { mappings: string; sources: string[]; sourcesContent: string[] } }[]
    }
    expect(payload.sections.map(section => section.map)).toEqual([
      {
        version: 3,
        names: [],
        mappings: 'AAAA',
        sources: ['/packages/client/generated-0/lib/client.js'],
        sourcesContent: ['window.generation = 0\n'],
      },
      {
        version: 3,
        names: [],
        mappings: 'AAAA',
        sources: ['/packages/client/generated-1/lib/client.js'],
        sourcesContent: ['window.generation = 1\n'],
      },
    ])
    const consumer = new SourceMap(payload as unknown as ConstructorParameters<typeof SourceMap>[0])
    expect(consumer.findEntry(0, 0)).toMatchObject({
      originalSource: '/packages/client/generated-0/lib/client.js',
    })
    expect(consumer.findEntry(2, 0)).toMatchObject({
      originalSource: '/packages/client/generated-1/lib/client.js',
    })
  })

  it('retains one prior immutable batch generation across rebuild recomposition', async () => {
    const packageName = '@fixture/batch-rebuild-race'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = { generation: 1 }\n')
    const { service, route } = constructWithRoute([packageName])
    const first = service.graph().batches[0]!.url
    const firstSize = service.artifactBaseline(packageName)!.size

    writeFileSync(clientPath, 'module.exports = { generation: 200 }\n')
    service.rebuilt(packageName)
    const second = service.graph().batches[0]!.url
    expect(second).not.toBe(first)
    expect(service.artifactBaseline(packageName)!.size).toBeGreaterThan(firstSize)
    expect((await routeRequest(route, first)).status).toBe(200)
    expect((await routeRequest(route, second)).status).toBe(200)

    writeFileSync(clientPath, 'module.exports = { generation: 3 }\n')
    service.rebuilt(packageName)
    const third = service.graph().batches[0]!.url
    expect((await routeRequest(route, first)).status).toBe(404)
    expect((await routeRequest(route, second)).status).toBe(200)
    expect((await routeRequest(route, third)).status).toBe(200)
  })

  it('assigns opaque startup revisions instead of deriving them from artifact content', () => {
    const firstName = '@fixture/startup-revision-first'
    const secondName = '@fixture/startup-revision-second'
    writeBuiltPackage(firstName, {})
    writeBuiltPackage(secondName, {})

    const service = construct([firstName, secondName])
    const [first, second] = service.graph().entries
    const firstMatch = /^(?<nonce>[a-f\d]{16})-(?<sequence>\d+)$/.exec(first!.rev)
    const secondMatch = /^(?<nonce>[a-f\d]{16})-(?<sequence>\d+)$/.exec(second!.rev)
    expect(firstMatch?.groups).toMatchObject({ sequence: '0' })
    expect(secondMatch?.groups).toMatchObject({ nonce: firstMatch?.groups?.nonce, sequence: '1' })
    const firstPath = service.clientPath(firstName)!
    const firstStat = statSync(firstPath)
    expect(service.artifactBaseline(firstName)).toEqual({
      path: firstPath,
      mtimeMs: firstStat.mtimeMs,
      size: firstStat.size,
    })
    expect(service.artifactBaseline('@fixture/unknown')).toBeUndefined()
  })

  it('splits startup combos before the map-form URL exceeds 3 KiB', async () => {
    const packageNames = Array.from({ length: 48 }, (_, index) => (
      `@fixture/combo-url-${String(index).padStart(3, '0')}-${'x'.repeat(40)}`
    ))
    const sourceMap = JSON.stringify({
      version: 3,
      names: [],
      mappings: 'AAAA',
      sources: ['src/index.ts'],
    })
    for (const packageName of packageNames) {
      const clientPath = writePackage(packageName)
      mkdirSync(dirname(clientPath), { recursive: true })
      writeFileSync(clientPath, 'module.exports = {}\n')
      writeFileSync(`${clientPath}.map`, sourceMap)
    }

    const { service, route } = constructWithRoute(packageNames)
    const batches = service.graph().batches.filter(batch => batch.phase === 'application')
    expect(batches.length).toBeGreaterThan(1)
    expect(batches.flatMap(batch => batch.entries)).toEqual(packageNames)
    for (const batch of batches) {
      expect(Buffer.byteLength(batch.url)).toBeLessThanOrEqual(3 * 1024)
      expect(Buffer.byteLength(mapUrl(batch.url))).toBeLessThanOrEqual(3 * 1024)
      expect((await routeRequest(route, batch.url)).status).toBe(200)
      expect((await routeRequest(route, mapUrl(batch.url))).status).toBe(200)
    }
    for (let index = 0; index < batches.length - 1; index += 1) {
      const entries = [...batches[index]!.entries, batches[index + 1]!.entries[0]!]
      expect(Buffer.byteLength(mapUrl(comboUrl(entries, '0'.repeat(12))))).toBeGreaterThan(3 * 1024)
    }
  })

  it('serves the source map beside a registered client bundle', async () => {
    const packageName = '@fixture/source-map'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n//# sourceMappingURL=client.js.map')
    const map = '{"version":3,"names":[],"mappings":"AAAA","sources":["../../../packages/client/demo/src/index.tsx","https://cdn.example.test/library.js"]}\n'
    writeFileSync(`${clientPath}.map`, map)
    const { service, route } = constructWithRoute([packageName])
    const row = service.graph().entries[0]!
    const singleScript = await routeRequest(route, row.url)
    expect(singleScript.body.toString('utf8')).toContain(`sourceMappingURL=${mapUrl(row.url)}`)
    const singleMap = await routeRequest(route, mapUrl(row.url))
    expect(singleMap.status).toBe(200)
    expect(singleMap.headers).toEqual({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
    })
    expect(JSON.parse(singleMap.body.toString('utf8'))).toMatchObject({
      version: 3,
      file: 'client.js',
      sections: [{
        offset: { line: 0, column: 0 },
        map: {
          ...(JSON.parse(map) as Record<string, unknown>),
          sources: ['/packages/client/demo/src/index.tsx', 'https://cdn.example.test/library.js'],
        },
      }],
    })

    const batch = service.graph().batches[0]!
    expect(batch).toMatchObject({ phase: 'application', entries: [packageName] })
    const batchScript = await routeRequest(route, batch.url)
    expect(batchScript.status).toBe(200)
    expect(batchScript.headers?.['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(batchScript.body.toString('utf8')).toContain(`//# sourceMappingURL=${mapUrl(batch.url)}`)
    const shellResponse = service.fetchBundle(new Request(`dsh-app://app${batch.url}`))
    expect(shellResponse.status).toBe(200)
    expect(shellResponse.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await shellResponse.text()).toBe(batchScript.body.toString('utf8'))
    expect((await routeRequest(route, batch.url, 'HEAD')).body).toHaveLength(0)
    expect((await routeRequest(route, batch.url, 'POST')).status).toBe(405)
    const batchMap = await routeRequest(route, mapUrl(batch.url))
    const parsedBatchMap = JSON.parse(batchMap.body.toString('utf8')) as unknown
    const parsedPluginMap = JSON.parse(map) as Record<string, unknown>
    expect(parsedBatchMap).toMatchObject({
      version: 3,
      file: 'client.js',
      sections: [{
        offset: { line: 0, column: 0 },
        map: {
          ...parsedPluginMap,
          sources: ['/packages/client/demo/src/index.tsx', 'https://cdn.example.test/library.js'],
        },
      }],
    })
    expect((await routeRequest(route, `${row.url}&stale=1`.replace(`rev=${row.rev}`, 'rev=stale'))).status).toBe(404)

    writeFileSync(`${clientPath}.map`, '{"version":3,"names":[],"mappings":"AAAA","sources":["src/changed.tsx"]}\n')
    const nextRev = service.rebuilt(packageName)
    expect(nextRev).not.toBe(row.rev)
    const nextRow = service.graph().entries[0]!
    expect(nextRow.rev).toBe(nextRev)
    const nextMap = await routeRequest(route, mapUrl(nextRow.url))
    expect(JSON.parse(nextMap.body.toString('utf8'))).toMatchObject({
      sections: [{ map: { sources: ['/plugins/@fixture/source-map/src/changed.tsx'] } }],
    })
  })

  it('applies sourceRoot before relocating absolute-looking section sources', async () => {
    const packageName = '@fixture/source-root'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    writeFileSync(`${clientPath}.map`, JSON.stringify({
      version: 3,
      names: [],
      mappings: 'AAAA',
      sourceRoot: '../root',
      sources: ['/absolute.ts'],
    }))
    const { service, route } = constructWithRoute([packageName])
    const response = await routeRequest(route, mapUrl(service.graph().batches[0]!.url))
    const map = JSON.parse(response.body.toString('utf8')) as {
      sections: { map: { sourceRoot?: string; sources: string[] } }[]
    }
    expect(map.sections[0]?.map).toMatchObject({
      sources: ['/plugins/@fixture/root/absolute.ts'],
    })
    expect(map.sections[0]?.map).not.toHaveProperty('sourceRoot')
  })

  it('maps a non-zero second batch section through a standard source-map consumer', async () => {
    const firstName = '@fixture/offset-first'
    const secondName = '@fixture/offset-second'
    const firstPath = writePackage(firstName)
    const secondPath = writePackage(secondName)
    for (const [path, source] of [
      [firstPath, '../../../packages/demo/first.ts'],
      [secondPath, '../../../packages/demo/second.ts'],
    ] as const) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, 'window.first = true\nwindow.second = true\n')
      writeFileSync(`${path}.map`, JSON.stringify({
        version: 3,
        names: [],
        mappings: 'AAAA',
        sources: [source],
        sourcesContent: ['export {}\n'],
      }))
    }
    const { service, route } = constructWithRoute([firstName, secondName])
    const response = await routeRequest(route, mapUrl(service.graph().batches[0]!.url))
    const payload = JSON.parse(response.body.toString('utf8')) as ConstructorParameters<typeof SourceMap>[0]
    const sections = (payload as unknown as {
      sections: { offset: { line: number; column: number } }[]
    }).sections
    expect(sections.map(section => section.offset)).toEqual([
      { line: 0, column: 0 },
      { line: 3, column: 0 },
    ])
    const consumer = new SourceMap(payload)
    expect(consumer.findEntry(0, 0)).toMatchObject({ originalSource: '/packages/demo/first.ts' })
    expect(consumer.findEntry(3, 0)).toMatchObject({ originalSource: '/packages/demo/second.ts' })
  })

  it('combines a generated-file fallback with a later authored map', async () => {
    const unmappedName = '@fixture/unmapped-first'
    const mappedName = '@fixture/mapped-second'
    const unmappedPath = writePackage(unmappedName)
    const mappedPath = writePackage(mappedName)
    mkdirSync(dirname(unmappedPath), { recursive: true })
    mkdirSync(dirname(mappedPath), { recursive: true })
    writeFileSync(unmappedPath, 'window.unmapped = true\n')
    writeFileSync(mappedPath, 'window.mapped = true\n')
    writeFileSync(`${mappedPath}.map`, JSON.stringify({
      version: 3,
      names: [],
      mappings: 'AAAA',
      sources: ['../../../packages/demo/mapped.ts'],
      sourcesContent: ['export {}\n'],
    }))

    const { service, route } = constructWithRoute([unmappedName, mappedName])
    const response = await routeRequest(route, mapUrl(service.graph().batches[0]!.url))
    const payload = JSON.parse(response.body.toString('utf8')) as ConstructorParameters<typeof SourceMap>[0]
    const consumer = new SourceMap(payload)
    expect(consumer.findEntry(0, 0)).toMatchObject({
      originalSource: `/plugins/${unmappedName}/client.js`,
    })
    expect(consumer.findEntry(2, 0)).toMatchObject({ originalSource: '/packages/demo/mapped.ts' })
  })
})

function emitLoaderEntryChange(context: Context, name: string): void {
  context.emit('internal/plugin', {
    entry: { options: { name } },
  } as unknown as Fiber)
}

describe('shared module declarations', () => {
  it('accepts external requests and carries them onto the graph row', () => {
    const packageName = '@fixture/shared-declared'
    writeBuiltPackage(packageName, { external: ['react'] })
    expect(construct([packageName]).graph().entries).toEqual([{
      id: packageName,
      url: expect.stringContaining(`/plugins/??${packageName}/client.js&rev=`) as unknown as string,
      rev: expect.any(String) as unknown as string,
      external: ['react'],
    }])
  })

  it('omits external when the package declares no requests', () => {
    const packageName = '@fixture/shared-absent'
    writeBuiltPackage(packageName, {})
    const [row] = construct([packageName]).graph().entries
    expect(row).not.toHaveProperty('external')
  })

  it('rejects a non-array external', () => {
    const packageName = '@fixture/external-not-array'
    writeBuiltPackage(packageName, { external: 'react' })
    expect(() => construct([packageName]))
      .toThrow(`client-modules: ${packageName} dsh.client.external must be a string array`)
  })
})

describe('module graph order', () => {
  const entry = (id: string, fields: Partial<WebBootEntry> = {}): WebBootEntry =>
    ({ id, url: comboUrl([id], '0'), rev: '0', ...fields })
  const ids = (entries: readonly WebBootEntry[]): string[] => entries.map(row => row.id)

  it('places every requested package row before its consumers along a chain', () => {
    expect(ids(orderByModuleGraph([
      entry('ui', { external: ['slots'] }),
      entry('slots', { external: ['render'] }),
      entry('render'),
    ]))).toEqual(['render', 'slots', 'ui'])
  })

  it('places a shared package row before both arms of a diamond', () => {
    expect(ids(orderByModuleGraph([
      entry('app', { external: ['left', 'right'] }),
      entry('left', { external: ['vendor'] }),
      entry('right', { external: ['vendor'] }),
      entry('vendor'),
    ]))).toEqual(['vendor', 'left', 'right', 'app'])
  })

  it('resolves a /client request onto the requested package row', () => {
    expect(ids(orderByModuleGraph([
      entry('ui', { external: ['runtime/client'] }),
      entry('runtime'),
    ]))).toEqual(['runtime', 'ui'])
  })

  it('leaves a request no row answers to the static assembly channel', () => {
    expect(ids(orderByModuleGraph([
      entry('consumer', { external: ['@deepseek-ai/cordis'] }),
      entry('other'),
    ]))).toEqual(['consumer', 'other'])
  })

  it('rejects a cycle and names the packages on it', () => {
    expect(() => orderByModuleGraph([
      entry('a', { external: ['b'] }),
      entry('b', { external: ['a'] }),
    ])).toThrow('client-modules: module graph cycle a -> b -> a')
  })

  it('rejects a row requesting its own package name', () => {
    expect(() => orderByModuleGraph([entry('solo', { external: ['solo'] })]))
      .toThrow('client-modules: "solo" requests module "solo" that it answers itself')
  })

  it('composes the served graph in module-graph order', () => {
    const consumerName = '@fixture/order-consumer'
    const dependencyName = '@fixture/order-dependency'
    writeBuiltPackage(consumerName, { external: [dependencyName] })
    writeBuiltPackage(dependencyName, {})
    expect(ids(construct([consumerName, dependencyName]).graph().entries))
      .toEqual([dependencyName, consumerName])
  })

  it('fails activation loud when scanned packages form a module cycle', () => {
    writeBuiltPackage('@fixture/cycle-a', { external: ['@fixture/cycle-b'] })
    writeBuiltPackage('@fixture/cycle-b', { external: ['@fixture/cycle-a'] })
    expect(() => construct(['@fixture/cycle-a', '@fixture/cycle-b']))
      .toThrow('module graph cycle @fixture/cycle-a -> @fixture/cycle-b -> @fixture/cycle-a')
  })
})
