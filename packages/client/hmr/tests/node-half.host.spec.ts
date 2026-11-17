/**
 * Node half of the HMR plugin: bundle watches follow the graph, stat changes
 * report through clientModuleHost.rebuilt, and everything dies with the fiber,
 * including the plugin-events Remote service.
 */
import { mkdtempSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientArtifactBaseline, ClientModuleRegistry, WebBootGraph } from '@deepseek-ai/dsh-client-modules'
import { apply, Config, inject } from '../src/index.ts'

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
  return { path, mtimeMs: bundle.mtimeMs, ctimeMs: bundle.ctimeMs, size: bundle.size }
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
        entries: [...rows.keys()].map(id => ({ id, url: `plugins/??${id}/client.js&rev=r`, rev: 'r' })),
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

async function mount(clientModuleHost: FakeHost) {
  const ctx = new Context()
  ctx.provide('clientModules', clientModuleHost)
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
    const fiber = await mount(clientModuleHost)

    expect(fiber.ctx.get('pluginEvents')).toBeDefined()
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
    expect(fiber.ctx.get('pluginEvents')).toBeUndefined()
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
    const fiber = await mount(clientModuleHost)
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

  it('publishes only a row changed between its startup snapshot and watch installation', async () => {
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

    const fiber = await mount(clientModuleHost)

    expect(clientModuleHost.rebuiltCalls).toEqual(['pkg-a'])
    clientModuleHost.rebuiltCalls.length = 0
    await new Promise(resolve => setTimeout(resolve, POLL_MS * 3))
    expect(clientModuleHost.rebuiltCalls).toHaveLength(0)
    await fiber.dispose()
  })

  it('publishes a ctime change when a rewrite preserves mtime and size', async () => {
    const bundle = join(dir, 'preserved-mtime.js')
    writeFileSync(bundle, 'seed')
    const fixedTime = new Date(1_600_000_000_000)
    utimesSync(bundle, fixedTime, fixedTime)
    const baseline = statSync(bundle)
    const clientModuleHost = fakeClientModuleHost(new Map([['pkg-a', bundle]]))
    const fiber = await mount(clientModuleHost)
    try {
      expect(clientModuleHost.rebuiltCalls).toEqual([])
      // Filesystem ctime can advance more coarsely than Date.now(); the fixture needs a distinct value.
      await expect.poll(() => {
        writeFileSync(bundle, 'next')
        utimesSync(bundle, fixedTime, fixedTime)
        return statSync(bundle).ctimeMs
      }).not.toBe(baseline.ctimeMs)
      expect(statSync(bundle)).toMatchObject({ mtimeMs: baseline.mtimeMs, size: baseline.size })
      await vi.waitFor(() => { expect(clientModuleHost.rebuiltCalls).toEqual(['pkg-a']) }, { timeout: 3_000 })
    } finally {
      await fiber.dispose()
    }
  })

  it('publishes a reappearing bundle with restored mtime and size', async () => {
    const bundle = join(dir, 'replace.js')
    writeFileSync(bundle, 'seed')
    const fixedTime = new Date(1_600_000_000_000)
    utimesSync(bundle, fixedTime, fixedTime)
    const baseline = statSync(bundle)
    const clientModuleHost = fakeClientModuleHost(new Map([['pkg-a', bundle]]))
    const fiber = await mount(clientModuleHost)
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

  it('retains a dirty baseline when catch-up publication races a rename', async () => {
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

    const fiber = await mount(clientModuleHost)

    await vi.waitFor(() => { expect(clientModuleHost.rebuiltCalls).toEqual(['pkg-a', 'pkg-a']) }, { timeout: 3_000 })
    await fiber.dispose()
  })
})
