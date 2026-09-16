/**
 * Node half of the HMR plugin: bundle watches follow the graph, stat changes
 * report through clientModuleHost.rebuilt, and everything dies with the fiber.
 */
import { EventEmitter } from 'node:events'
import type { ServerResponse, IncomingMessage } from 'node:http'
import { mkdtempSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientArtifactBaseline, ClientModuleRegistry, WebBootGraph } from '@deepseek-ai/dsh-client-modules'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { apply, Config, EVENTS_ENDPOINT, inject } from '../src/index.ts'

const POLL_MS = 20

let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/**
 * Controllable clientModuleHost fake over a mutable id → bundle-path table.
 * Structural (Pick+cast): the plugin only touches the read/notify surface;
 * the service class carries private scan state a literal need not reproduce.
 */
type FakeHost = ClientModuleRegistry & { rebuiltCalls: string[]; fireGraphChanged(): void }
interface FakeHostOptions {
  beforeGraphRead?: () => void
  rebuilt?: (id: string) => string | undefined
}

function artifactBaseline(path: string): ClientArtifactBaseline {
  const bundle = statSync(path)
  return { path, mtimeMs: bundle.mtimeMs, size: bundle.size }
}

function fakeClientModuleHost(rows: Map<string, string>, options: FakeHostOptions = {}): FakeHost {
  const graphListeners = new Set<() => void>()
  const rebuiltCalls: string[] = []
  const baselines = new Map([...rows].map(([id, path]) => [id, artifactBaseline(path)]))
  const fake: Pick<FakeHost, 'graph' | 'artifactBaseline' | 'rebuilt' | 'onRebuilt' | 'onGraphChanged' | 'rebuiltCalls' | 'fireGraphChanged'> = {
    rebuiltCalls,
    fireGraphChanged: () => { for (const l of graphListeners) l() },
    graph: (): WebBootGraph => {
      options.beforeGraphRead?.()
      return {
        rev: 'r',
        entries: [...rows.keys()].map(id => ({ id, url: `/plugins/??${id}/client.js&rev=r`, rev: 'r' })),
        batches: [],
      }
    },
    artifactBaseline: (id) => {
      const path = rows.get(id)
      if (path === undefined) return undefined
      let baseline = baselines.get(id)
      if (baseline?.path !== path) {
        baseline = artifactBaseline(path)
        baselines.set(id, baseline)
      }
      return { ...baseline }
    },
    rebuilt: (id) => {
      rebuiltCalls.push(id)
      return options.rebuilt?.(id) ?? 'r2'
    },
    onRebuilt: () => () => {},
    onGraphChanged: (listener) => {
      graphListeners.add(listener)
      return () => { graphListeners.delete(listener) }
    },
  }
  return fake as FakeHost
}

// Structural fake: the plugin only touches register(); the service class
// carries private state a literal cannot (and need not) reproduce.
function fakeHttpServer(routes: WebRoute[]): WebServer {
  const fake: Pick<WebServer, 'register' | 'tapIndex' | 'port'> = {
    register(route) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    tapIndex: () => () => {},
    port: 0,
  }
  return fake as WebServer
}

async function mount(clientModuleHost: FakeHost, webServer: WebServer) {
  const ctx = new Context()
  ctx.provide('clientModules', clientModuleHost)
  ctx.provide('webServer', webServer)
  const fiber = ctx.plugin(
    { inject: [...inject], Config, apply },
    { pollIntervalMs: POLL_MS },
  )
  await fiber.await()
  return fiber
}

describe('hmr node half', () => {
  it('watches graph bundles, ignores map-only changes, and unwatches on dispose', async () => {
    const bundle = join(dir, 'a.js')
    writeFileSync(bundle, 'v1')
    const clientModuleHost = fakeClientModuleHost(new Map([['pkg-a', bundle]]))
    const routes: WebRoute[] = []
    const fiber = await mount(clientModuleHost, fakeHttpServer(routes))

    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'exact', path: EVENTS_ENDPOINT })
    expect(clientModuleHost.rebuiltCalls).toEqual([])

    // Nudge mtime past stat granularity so the poller sees a content signal.
    await new Promise(resolve => setTimeout(resolve, POLL_MS * 2))
    writeFileSync(bundle, 'v2-longer')
    await vi.waitFor(() => { expect(clientModuleHost.rebuiltCalls).toContain('pkg-a') }, { timeout: 3_000 })

    clientModuleHost.rebuiltCalls.length = 0
    await new Promise(resolve => setTimeout(resolve, POLL_MS * 2))
    writeFileSync(`${bundle}.map`, '{"version":3}')
    await new Promise(resolve => setTimeout(resolve, POLL_MS * 3))
    expect(clientModuleHost.rebuiltCalls).toEqual([])

    writeFileSync(bundle, 'v3-even-longer')
    await vi.waitFor(() => { expect(clientModuleHost.rebuiltCalls).toContain('pkg-a') }, { timeout: 3_000 })

    await fiber.dispose()
    expect(routes).toHaveLength(0)
    // Watcher gone: further file changes report nothing.
    clientModuleHost.rebuiltCalls.length = 0
    writeFileSync(bundle, 'v4-after-dispose')
    await new Promise(resolve => setTimeout(resolve, POLL_MS * 4))
    expect(clientModuleHost.rebuiltCalls).toHaveLength(0)
  })

  it('follows graph changes: rows added after activation get watched', async () => {
    const early = join(dir, 'early.js')
    const late = join(dir, 'late.js')
    writeFileSync(early, 'v1')
    const rows = new Map([['pkg-early', early]])
    const clientModuleHost = fakeClientModuleHost(rows)
    const fiber = await mount(clientModuleHost, fakeHttpServer([]))
    clientModuleHost.rebuiltCalls.length = 0

    writeFileSync(late, 'v1')
    rows.set('pkg-late', late)
    clientModuleHost.fireGraphChanged()
    expect(clientModuleHost.rebuiltCalls).toEqual([])

    await new Promise(resolve => setTimeout(resolve, POLL_MS * 2))
    writeFileSync(late, 'v2-longer')
    await vi.waitFor(() => { expect(clientModuleHost.rebuiltCalls).toContain('pkg-late') }, { timeout: 3_000 })

    rows.delete('pkg-late')
    clientModuleHost.fireGraphChanged()
    clientModuleHost.rebuiltCalls.length = 0
    writeFileSync(late, 'v3-even-longer')
    await new Promise(resolve => setTimeout(resolve, POLL_MS * 3))
    expect(clientModuleHost.rebuiltCalls).toHaveLength(0)
    await fiber.dispose()
  })

  it('rehashes only a row changed between its startup snapshot and watch installation', async () => {
    const bundle = join(dir, 'construction.js')
    writeFileSync(bundle, 'v1')
    let rewrite = true
    const clientModuleHost = fakeClientModuleHost(new Map([['pkg-a', bundle]]), {
      beforeGraphRead: () => {
        if (!rewrite) return
        rewrite = false
        writeFileSync(bundle, 'v2-written-during-watch-construction')
      },
    })

    const fiber = await mount(clientModuleHost, fakeHttpServer([]))

    expect(clientModuleHost.rebuiltCalls).toEqual(['pkg-a'])
    clientModuleHost.rebuiltCalls.length = 0
    await new Promise(resolve => setTimeout(resolve, POLL_MS * 3))
    expect(clientModuleHost.rebuiltCalls).toHaveLength(0)
    await fiber.dispose()
  })

  it('marks a vanished bundle dirty so identical metadata still re-hashes after it reappears', async () => {
    const bundle = join(dir, 'replace.js')
    writeFileSync(bundle, 'seed')
    const fixedTime = new Date(1_600_000_000_000)
    utimesSync(bundle, fixedTime, fixedTime)
    const baseline = statSync(bundle)
    const clientModuleHost = fakeClientModuleHost(new Map([['pkg-a', bundle]]))
    const fiber = await mount(clientModuleHost, fakeHttpServer([]))
    clientModuleHost.rebuiltCalls.length = 0

    unlinkSync(bundle)
    await new Promise(resolve => setTimeout(resolve, POLL_MS * 2))
    writeFileSync(bundle, 'x'.repeat(baseline.size))
    utimesSync(bundle, fixedTime, fixedTime)
    const restored = statSync(bundle)
    expect({ mtimeMs: restored.mtimeMs, size: restored.size }).toEqual({
      mtimeMs: baseline.mtimeMs,
      size: baseline.size,
    })
    await vi.waitFor(() => { expect(clientModuleHost.rebuiltCalls).toEqual(['pkg-a']) }, { timeout: 3_000 })
    await fiber.dispose()
  })

  it('retains a dirty baseline when a catch-up re-hash races a rename', async () => {
    const bundle = join(dir, 'rename.js')
    writeFileSync(bundle, 'v1')
    let first = true
    const clientModuleHost = fakeClientModuleHost(new Map([['pkg-a', bundle]]), {
      beforeGraphRead: () => {
        if (!first) return
        writeFileSync(bundle, 'v2-written-during-watch-construction')
      },
      rebuilt: () => {
        if (!first) return 'r2'
        first = false
        throw Object.assign(new Error('bundle renamed'), { code: 'ENOENT' })
      },
    })

    const fiber = await mount(clientModuleHost, fakeHttpServer([]))

    await vi.waitFor(() => { expect(clientModuleHost.rebuiltCalls).toEqual(['pkg-a', 'pkg-a']) }, { timeout: 3_000 })
    await fiber.dispose()
  })
})


it('broadcasts the desired graph without waiting for Host activation or cleanup', async () => {
  const ctx = new Context()
  await ctx.plugin(Loader)
  const bundle = join(dir, 'a.js')
  writeFileSync(bundle, 'a')
  const rows = new Map([['a', bundle]])
  const host = fakeClientModuleHost(rows)
  const routes: WebRoute[] = []
  ctx.provide('clientModules', host)
  ctx.provide('webServer', fakeHttpServer(routes))
  let release!: () => void
  let cleaned!: () => void
  let started!: () => void
  const starting = new Promise<void>((resolve) => { started = resolve })
  const activation = new Promise<void>((resolve) => { release = resolve })
  const cleanup = new Promise<void>((resolve) => { cleaned = resolve })
  let disposed = false
  ctx.loader.internal = { version: 'client', import: async () => ({
    apply: async (pluginCtx: Context) => {
      pluginCtx.effect(() => async () => { await cleanup; disposed = true })
      started()
      await activation
    },
  }) } as never
  const entryId = await ctx.loader.create({ name: 'owned' })
  await starting
  const fiber = ctx.plugin({ inject, Config, apply }, { pollIntervalMs: POLL_MS })
  await fiber.await()
  const route = routes[0]!
  const connect = async () => {
    const lines: string[] = []
    const response = Object.assign(new EventEmitter(), {
      writeHead: vi.fn(), write: (line: string) => { lines.push(line) },
      destroy: vi.fn(), end: vi.fn(),
    })
    await route.handler({ method: 'GET' } as IncomingMessage, response as unknown as ServerResponse)
    return { lines, response }
  }
  try {
    const first = await connect()
    expect(first.lines).toHaveLength(2)
    const frame = JSON.parse(first.lines[1]!.slice(6)) as { graph: WebBootGraph }
    expect(frame.graph.entries.map(row => row.id)).toEqual(['a'])
    const second = await connect()
    expect(second.lines[1]).toBe(first.lines[1])
    expect(first.lines).toHaveLength(2)
    release()
    const owned = ctx.loader.resolve(entryId).fiber!
    await owned.await()
    const child = owned.ctx.plugin({ apply() {} })
    await child.await()
    expect(child.entry).toBe(owned.entry)
    await child.dispose()
    await child.await()
    await ctx.loader.await()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(second.lines).toHaveLength(2)
    first.response.emit('close')
    ctx.loader.remove(entryId)
    rows.clear()
    host.fireGraphChanged()
    expect(second.lines).toHaveLength(3)
    expect(disposed).toBe(false)
    expect((JSON.parse(second.lines[2]!.slice(6)) as { graph: WebBootGraph }).graph.entries).toEqual([])
    const third = await connect()
    expect(third.lines[1]).toBe(second.lines[2])
    expect(second.lines).toHaveLength(3)
    cleaned()
    while (owned.inertia !== undefined) await owned.inertia
    expect(disposed).toBe(true)
    expect(second.lines).toHaveLength(3)
    await fiber.dispose()
    host.fireGraphChanged()
    expect(second.lines).toHaveLength(3)
    expect(second.response.destroy).toHaveBeenCalledOnce()
    expect(third.response.destroy).toHaveBeenCalledOnce()
  } finally {
    release()
    cleaned()
    await fiber.dispose()
    await ctx.fiber.dispose()
  }
})
