// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it, vi } from 'vitest'
import type { ClientModuleMeta, DshClientModuleManifest } from '@deepseek-ai/dsh-package-manifest'
import { createClientModuleSystem, type ClientModuleLoaderTarget } from '../src/client/index.ts'

const row = (id: string) => ({ id, url: `/plugins/??${id}/client.js&rev=0`, rev: '0' })
function fixture(
  staticModules: readonly DshClientModuleManifest[] = [], ids: readonly string[] = [], loadBundle?: (url: string) => Promise<void>,
) {
  const target: ClientModuleLoaderTarget = {
    mode: 'queue', pendingQueue: [], load: () => {},
    create: options => createClientModuleSystem(target, { id: 'bootstrap', exports: {} }, options),
  }
  const modules = target.create({ staticModules, boot: { rev: '0', entries: ids.map(row),
    batches: ids.length ? [{ phase: 'application', url: '/batch', rev: '0', entries: ids }] : [] },
  ...(loadBundle === undefined ? {} : { loadBundle }) })
  return { modules, target }
}

describe('materialized module records', () => {
  it('keeps adopted bootstrap exports when the static table also contains its entry and a chunk', async () => {
    const duplicate = vi.fn(() => ({ replaced: true }))
    const { modules } = fixture([
      { id: 'bootstrap', factory: duplicate },
      { id: 'bootstrap', chunk: 'client.shared.js', factory: () => ({ shared: true }) },
    ])
    try {
      expect(await modules.import('bootstrap')).toEqual({})
      expect(await modules.import('bootstrap/client.shared.js')).toEqual({ shared: true })
      expect(modules.loadCache.get('bootstrap/client.shared.js')?.ownerId).toBe('bootstrap')
      expect(duplicate).not.toHaveBeenCalled()
    } finally { await modules.dispose() }
  })

  it('prefetches an exact static key without fetching or materializing its factory', async () => {
    const factory = vi.fn(() => ({ marker: true }))
    const transport = vi.fn(async () => {})
    const { modules } = fixture([{ id: 'react-dom/client', factory }], [], transport)
    const changed = vi.fn()
    const off = modules.subscribeModules(changed)
    try {
      await modules.prefetch('react-dom/client')
      expect(transport).not.toHaveBeenCalled()
      expect(factory).not.toHaveBeenCalled()
      expect(changed).not.toHaveBeenCalled()
      expect(modules.loadCache.has('react-dom/client')).toBe(false)
      expect(await modules.import('react-dom/client')).toEqual({ marker: true })
      expect(factory).toHaveBeenCalledTimes(1)
      expect(changed).toHaveBeenCalledTimes(1)
    } finally {
      off()
      await modules.dispose()
    }
  })

  it('evicts and reports a stale chunk materialized before its invalidated transport finishes', async () => {
    let arrived!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { arrived = resolve })
    const pending = new Promise<void>((resolve) => { release = resolve })
    const stale = { version: 'old' }
    const fresh = { version: 'new' }
    const load = vi.fn(async (url: string): Promise<void> => {
      if (url.endsWith('rev=0')) {
        arrived()
        await pending
        target.load({ id: 'pkg', chunk: 'client.lazy.js', factory: () => stale })
        expect(await modules.import('pkg/client.lazy.js')).toBe(stale)
      } else {
        expect(url).toContain('rev=next')
        target.load({ id: 'pkg', chunk: 'client.lazy.js', factory: () => fresh })
      }
    })
    const { modules, target } = fixture([], ['pkg'], load)
    target.load({ id: 'pkg', factory: require => ({ open: () => require.async('./client.lazy.js') }) })
    const owner = await modules.import('pkg') as { open(): Promise<unknown> }
    const snapshots: unknown[] = []
    const off = modules.subscribeModules(() => { snapshots.push(modules.loadCache.get('pkg/client.lazy.js')?.exports) })
    const opening = owner.open()
    try {
      await started
      modules.invalidate('pkg', 'next')
      release()
      expect(await opening).toBe(fresh)
      expect(load).toHaveBeenCalledTimes(2)
      expect(snapshots).toEqual([undefined, stale, undefined, fresh])
      expect(modules.loadCache.get('pkg/client.lazy.js')?.exports).toBe(fresh)
    } finally {
      release()
      await opening
      off()
      await modules.dispose()
    }
  })

  it('materializes modules without metadata and keeps the field absent from their records', async () => {
    const factory = vi.fn(() => ({ marker: true }))
    const { modules, target } = fixture([{ id: 'static', factory }])
    target.load({ id: 'dynamic', factory: require => ({ dependency: require('static') }) })
    await expect(modules.import('dynamic')).resolves.toEqual({ dependency: { marker: true } })
    expect(factory).toHaveBeenCalledTimes(1)
    for (const id of ['bootstrap', 'static', 'dynamic']) {
      expect(modules.loadCache.get(id)).toBeDefined()
      expect(modules.loadCache.get(id)).not.toHaveProperty('meta')
    }
    modules.invalidate('dynamic')
    target.load({ id: 'dynamic', factory: () => ({ revision: 2 }) })
    await expect(modules.import('dynamic')).resolves.toEqual({ revision: 2 })
    expect(modules.loadCache.get('dynamic')).not.toHaveProperty('meta')
  })

  it('retains opaque metadata without evaluating it during registration or materialization', async () => {
    const text = vi.fn(() => '.a {}')
    const metadata = vi.fn(() => ({ stylesheets: { 'a.css': { text } }, description: 'resource owner' }))
    const factory = vi.fn(() => ({ marker: true }))
    const { modules } = fixture([{ id: 'a', factory, meta: metadata }])
    const changed = vi.fn()
    const off = modules.subscribeModules(changed)
    expect(modules.loadCache.has('a')).toBe(false)
    expect(factory).not.toHaveBeenCalled()
    expect(metadata).not.toHaveBeenCalled()
    const exports = await modules.import('a')
    expect(await modules.import('a')).toBe(exports)
    expect(modules.loadCache.get('a')?.meta).toBe(metadata)
    expect(metadata).not.toHaveBeenCalled()
    expect(text).not.toHaveBeenCalled()
    expect(changed).toHaveBeenCalledTimes(1)
    const describe = modules.loadCache.get('a')!.meta as typeof metadata
    expect(describe().description).toBe('resource owner')
    expect(text).not.toHaveBeenCalled()
    off()
  })

  it('retains metadata containing no stylesheets for an external consumer', async () => {
    const information: ClientModuleMeta & { description: string } = { description: 'ordinary module information' }
    const metadata = vi.fn(() => information)
    const { modules } = fixture([{ id: 'a', factory: () => ({}), meta: metadata }])
    await modules.import('a')
    expect(metadata).not.toHaveBeenCalled()
    expect(modules.loadCache.get('a')!.meta!()).toBe(information)
    expect(information).not.toHaveProperty('stylesheets')
  })

  it('leaves metadata failures to the caller that evaluates the stored producer', async () => {
    const metadata = vi.fn(() => { throw new Error('metadata unavailable') })
    const { modules } = fixture([{ id: 'a', factory: () => ({ marker: true }), meta: metadata }])
    await expect(modules.import('a')).resolves.toEqual({ marker: true })
    expect(metadata).not.toHaveBeenCalled()
    expect(() => modules.loadCache.get('a')!.meta!()).toThrow('metadata unavailable')
    expect(await modules.import('a')).toEqual({ marker: true })
  })

  it('replaces the module record on invalidation without evaluating reused metadata', async () => {
    const metadata = vi.fn(() => ({}))
    const { modules, target } = fixture()
    target.load({ id: 'a', factory: () => ({ version: 1 }), meta: metadata })
    await modules.import('a')
    const first = modules.loadCache.get('a')!
    const snapshots: (typeof first | undefined)[] = []
    const off = modules.subscribeModules(() => { snapshots.push(modules.loadCache.get('a')) })
    modules.invalidate('a')
    target.load({ id: 'a', factory: () => ({ version: 2 }), meta: metadata })
    expect(snapshots).toEqual([undefined])
    await modules.import('a')
    const second = modules.loadCache.get('a')!
    expect(second).not.toBe(first)
    expect(second.exports).toEqual({ version: 2 })
    expect(second.meta).toBe(metadata)
    expect(snapshots).toEqual([undefined, second])
    expect(metadata).not.toHaveBeenCalled()
    off()
  })

  it('uses the manifest owner when a synchronous shared chunk imports a lazy chunk', async () => {
    const load = vi.fn(async (url: string) => {
      expect(url).toContain('/pkg/client.lazy.js')
      target.load({ id: 'pkg', chunk: 'client.lazy.js', factory: () => ({ lazy: true }) })
    })
    const { modules, target } = fixture([
      { id: 'pkg', factory: require => require('pkg/client.shared.js') as Record<string, unknown> },
      { id: 'pkg', chunk: 'client.shared.js', factory: require => ({ open: () => require.async('./client.lazy.js') }) },
    ], ['pkg'], load)
    const exports = await modules.import('pkg') as { open(): Promise<unknown> }
    expect(await exports.open()).toEqual({ lazy: true })
    expect(load).toHaveBeenCalledTimes(1)
    expect(modules.loadCache.get('pkg')?.edges).toEqual(new Set(['pkg/client.shared.js']))
    expect(modules.loadCache.get('pkg/client.shared.js')?.edges).toEqual(new Set(['./client.lazy.js']))
    expect(modules.loadCache.get('pkg/client.lazy.js')?.exports).toEqual({ lazy: true })
    expect(modules.loadCache.get('pkg/client.shared.js')?.ownerId).toBe('pkg')
    expect(modules.loadCache.get('pkg/client.lazy.js')?.ownerId).toBe('pkg')
  })

  it('publishes materialized dependencies before their consumer record', async () => {
    const { modules } = fixture([
      { id: 'a', factory: (require) => { require('a/client.shared.js'); require('z'); return {} } },
      { id: 'a', chunk: 'client.shared.js', factory: (require) => { require('b'); return {} } },
      { id: 'z', factory: () => ({}) },
      { id: 'b', factory: () => ({}) },
    ])
    const observed: string[][] = []
    const off = modules.subscribeModules(() => { observed.push([...modules.loadCache.keys()]) })
    await modules.import('a')
    expect(observed).toEqual([
      ['bootstrap', 'b'],
      ['bootstrap', 'b', 'a/client.shared.js'],
      ['bootstrap', 'b', 'a/client.shared.js', 'z'],
      ['bootstrap', 'b', 'a/client.shared.js', 'z', 'a'],
    ])
    expect(modules.loadCache.get('a')?.edges).toEqual(new Set(['a/client.shared.js', 'z']))
    expect(modules.loadCache.get('a/client.shared.js')?.edges).toEqual(new Set(['b']))
    off()
  })

  it('publishes later dependency edges after asynchronous imports and supports unsubscription', async () => {
    const { modules, target } = fixture()
    target.load({ id: 'b', factory: () => ({}) })
    target.load({ id: 'a', factory: require => ({ open: () => require.async('b') }) })
    const a = await modules.import('a') as { open(): Promise<unknown> }
    const snapshots: string[][] = []
    const changed = vi.fn(() => { snapshots.push([...modules.loadCache.get('a')!.edges]) })
    const off = modules.subscribeModules(changed)
    await a.open()
    expect(snapshots).toEqual([[], ['b']])
    await a.open()
    expect(changed).toHaveBeenCalledTimes(2)
    off()
    modules.invalidate('a')
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('keeps initial static identities across pruning and ignores invalidation of exact static keys', async () => {
    const factory = vi.fn(() => ({ marker: true, apply: () => {} }))
    const { modules } = fixture([{ id: 'react-dom/client', factory }], ['react-dom/client'])
    const exports = await modules.import('react-dom/client')
    const ctx = new Context()
    try {
      await ctx.plugin(Loader)
      ctx.loader.internal = modules as never
      await modules.entries.start(ctx.loader, modules.manifest)
      await modules.entries.sync({ rev: '1', entries: [], batches: [] })
      modules.invalidate('react-dom/client')
      expect(await modules.import('react-dom/client')).toBe(exports)
      expect(factory).toHaveBeenCalledTimes(1)
    } finally { await ctx.fiber.dispose() }
  })
})
