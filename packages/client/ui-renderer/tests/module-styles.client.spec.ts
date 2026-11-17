// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClientModuleSystem, type ClientModuleLoaderTarget, type ClientModuleRecord } from '@deepseek-ai/dsh-client-modules/client'
import type { DshClientModuleManifest } from '@deepseek-ai/dsh-package-manifest'
import { DocumentStyles } from '../src/client/styles/document-styles.ts'

const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  document.head.querySelectorAll('style[data-path]').forEach((element) => { element.remove() })
  vi.restoreAllMocks()
})

function fixture(staticModules: readonly DshClientModuleManifest[] = [], resolveAsset?: (reference: string) => string) {
  const target: ClientModuleLoaderTarget = {
    mode: 'queue', pendingQueue: [], load: () => {},
    create: options => createClientModuleSystem(target, { id: 'bootstrap', exports: {} }, options),
  }
  const modules = target.create({ boot: { rev: '0', entries: [], batches: [] }, staticModules,
    ...(resolveAsset === undefined ? {} : { resolveAsset }) })
  const register = (id: string, css: string, dependency?: string) => {
    const manifest: DshClientModuleManifest = {
      id,
      factory: (require) => { if (dependency !== undefined) require(dependency); return {} },
      meta: () => ({ stylesheets: { [id]: { text: () => css } } }),
    }
    target.load(manifest)
  }
  return { modules, target, register }
}

const paths = () => [...document.head.querySelectorAll('style[data-path]')].map(style => style.getAttribute('data-path'))

const metadata = (path: string, css = '.fixture { display: block }') => () => ({ stylesheets: { [path]: { text: () => css } } })

describe('main Document module styles', () => {
  it('ignores modules without metadata while retaining their transitive dependency order', async () => {
    const f = fixture([
      { id: 'z-base', factory: () => ({}), meta: metadata('base.css') },
      { id: 'plain', factory: (require) => { require('z-base'); return {} } },
    ])
    f.target.load({ id: 'a-consumer', factory: (require) => { require('plain'); return {} }, meta: metadata('consumer.css') })
    await f.modules.import('a-consumer')
    const styles = new DocumentStyles(document.head, f.modules)
    disposers.push(() => { styles.dispose() })
    styles.mount()
    expect(f.modules.loadCache.get('plain')).not.toHaveProperty('meta')
    expect(paths()).toEqual(['base.css', 'consumer.css'])
    f.target.load({ id: 'later', factory: () => ({ marker: true }) })
    await expect(f.modules.import('later')).resolves.toEqual({ marker: true })
    expect(paths()).toEqual(['base.css', 'consumer.css'])
    f.modules.invalidate('a-consumer')
    expect(paths()).toEqual(['base.css'])
  })

  it('does not subscribe, evaluate metadata or change DOM until explicitly mounted', async () => {
    const f = fixture()
    const text = vi.fn(() => '.a { display: block }')
    const meta = vi.fn(() => ({ stylesheets: { 'a.css': { text } } }))
    f.target.load({ id: 'a', factory: () => ({}), meta })
    await f.modules.import('a')
    const subscribe = vi.spyOn(f.modules, 'subscribeModules')
    const styles = new DocumentStyles(document.head, f.modules)
    disposers.push(() =>{  styles.dispose() })
    expect(subscribe).not.toHaveBeenCalled()
    expect(meta).not.toHaveBeenCalled()
    expect(text).not.toHaveBeenCalled()
    expect(paths()).toEqual([])
    f.target.load({ id: 'plain', factory: () => ({}) })
    await f.modules.import('plain')
    expect(meta).not.toHaveBeenCalled()
    expect(paths()).toEqual([])
    styles.mount()
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(meta).toHaveBeenCalledTimes(1)
    expect(text).toHaveBeenCalledTimes(1)
    expect(paths()).toEqual(['a.css'])
  })

  it('rejects a second mount without taking another subscription', () => {
    const f = fixture()
    const subscribe = vi.spyOn(f.modules, 'subscribeModules')
    const styles = new DocumentStyles(document.head, f.modules)
    disposers.push(() =>{  styles.dispose() })
    styles.mount()
    expect(() =>{  styles.mount() }).toThrow('already mounted')
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it('can be disposed before mounting and cannot mount after disposal', () => {
    const f = fixture()
    const subscribe = vi.spyOn(f.modules, 'subscribeModules')
    const styles = new DocumentStyles(document.head, f.modules)
    expect(() => { styles.dispose(); styles.dispose() }).not.toThrow()
    expect(() =>{  styles.mount() }).toThrow('disposed')
    expect(subscribe).not.toHaveBeenCalled()
    expect(paths()).toEqual([])
  })

  it('does not evaluate metadata until the renderer attaches, and caches text between module notifications', async () => {
    const asset = vi.fn((reference: string) => `/resolved/${reference}`)
    const text = vi.fn((context: { asset(reference: string): string }) => `.a { background: url("${context.asset('image.svg')}") }`)
    const meta = vi.fn(() => ({ stylesheets: { 'a.css': { text } } }))
    const factory = vi.fn(() => ({}))
    const f = fixture([{ id: 'a', factory, meta }], asset)
    expect(factory).not.toHaveBeenCalled()
    expect(meta).not.toHaveBeenCalled()
    await f.modules.import('a')
    expect(meta).not.toHaveBeenCalled()
    expect(text).not.toHaveBeenCalled()
    const styles = new DocumentStyles(document.head, f.modules)
    disposers.push(() =>{  styles.dispose() })
    styles.mount()
    expect(paths()).toEqual(['a.css'])
    expect(document.head.querySelector('style[data-path="a.css"]')?.textContent).toContain('/resolved/image.svg')
    f.target.load({ id: 'plain', factory: () => ({}) })
    await f.modules.import('plain')
    expect(meta).toHaveBeenCalledTimes(1)
    expect(text).toHaveBeenCalledTimes(1)
    expect(asset).toHaveBeenCalledTimes(1)
  })

  it('installs the healthy stylesheets of a module whose other text producer fails, without running it again', async () => {
    const f = fixture()
    const styles = new DocumentStyles(document.head, f.modules)
    disposers.push(() =>{  styles.dispose() })
    styles.mount()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = vi.fn(() => '.first { display: block }')
    const failure = new Error('unavailable text')
    const second = vi.fn<() => string>(() => { throw failure })
    const meta = vi.fn(() => ({ stylesheets: { 'first.css': { text: first }, 'second.css': { text: second } } }))
    f.target.load({ id: 'a', factory: () => ({}), meta })
    await f.modules.import('a')
    expect(paths()).toEqual(['first.css'])
    expect(error.mock.calls).toEqual([['module styles: "second.css" of "a" failed and is not installed', failure]])
    f.register('later', '.later { display: grid }')
    await f.modules.import('later')
    expect(paths()).toEqual(['first.css', 'later'])
    expect(meta).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('reevaluates reused descriptors for a replacement module record', async () => {
    const f = fixture()
    let css = '.old { display: block }'
    const text = vi.fn(() => css)
    const descriptor = { text }
    const meta = vi.fn(() => ({ stylesheets: { 'shared.css': descriptor } }))
    f.target.load({ id: 'a', factory: () => ({}), meta })
    await f.modules.import('a')
    const styles = new DocumentStyles(document.head, f.modules)
    disposers.push(() =>{  styles.dispose() })
    styles.mount()
    expect(document.head.querySelector('style[data-path="shared.css"]')?.textContent).toBe(css)
    f.modules.invalidate('a')
    expect(paths()).toEqual([])
    css = '.new { display: flex }'
    f.target.load({ id: 'a', factory: () => ({}), meta })
    await f.modules.import('a')
    expect(document.head.querySelector('style[data-path="shared.css"]')?.textContent).toBe(css)
    expect(meta).toHaveBeenCalledTimes(2)
    expect(text).toHaveBeenCalledTimes(2)
  })

  it('orders static and dynamic dependencies once before their consumers', async () => {
    const f = fixture([
      { id: 'base', factory: () => ({}), meta: metadata('base.css') },
      { id: 'shared', factory: (require) => { require('base'); return {} }, meta: metadata('shared.css') },
    ])
    f.target.load({ id: 'b', factory: (require) => { require('shared'); return {} }, meta: metadata('b.css') })
    f.target.load({ id: 'a', factory: (require) => { require('b/client'); require('shared'); return {} }, meta: metadata('a.css') })
    await f.modules.import('a')
    const styles = new DocumentStyles(document.head, f.modules)
    disposers.push(() =>{  styles.dispose() })
    styles.mount()
    expect(paths()).toEqual(['base.css', 'shared.css', 'b.css', 'a.css'])
  })

  it('orders every owner dependency before entry and shared-chunk styles', async () => {
    const f = fixture([
      { id: 'a', meta: metadata('a.css'), factory: (require) => { require('a/client.shared.js'); require('z'); return {} } },
      { id: 'a', chunk: 'client.shared.js', meta: metadata('shared.css'), factory: (require) => { require('b'); return {} } },
      { id: 'z', meta: metadata('z.css'), factory: () => ({}) },
      { id: 'b', meta: metadata('b.css'), factory: () => ({}) },
    ])
    await f.modules.import('a')
    const styles = new DocumentStyles(document.head, f.modules)
    disposers.push(() =>{  styles.dispose() })
    styles.mount()
    expect(paths()).toEqual(['z.css', 'b.css', 'a.css', 'shared.css'])
  })

  it('places a lazy chunk dependency before already installed owner styles', async () => {
    const f = fixture()
    f.target.load({ id: 'a', meta: metadata('a.css'), factory: require => ({ open: () => require.async('./client.details.js') }) })
    f.target.load({ id: 'a', chunk: 'client.details.js', meta: metadata('details.css'), factory: (require) => { require('b'); return {} } })
    f.target.load({ id: 'b', meta: metadata('b.css'), factory: () => ({}) })
    const entry = await f.modules.import('a') as { open(): Promise<unknown> }
    const styles = new DocumentStyles(document.head, f.modules)
    disposers.push(() =>{  styles.dispose() })
    styles.mount()
    expect(paths()).toEqual(['a.css'])
    const original = document.head.querySelector('style[data-path="a.css"]')
    await entry.open()
    expect(paths()).toEqual(['b.css', 'a.css', 'details.css'])
    expect(document.head.querySelector('style[data-path="a.css"]')).toBe(original)
  })

  it('identifies each stylesheet by its owning package and its path within that package', async () => {
    const f = fixture()
    f.target.load({ id: 'b', factory: () => ({}), meta: metadata('src/shared.css', '.b { display: block }') })
    f.target.load({ id: 'a', factory: () => ({}), meta: metadata('src/shared.css', '.a { display: flex }') })
    await f.modules.import('b'); await f.modules.import('a')
    const styles = new DocumentStyles(document.head, f.modules)
    disposers.push(() =>{  styles.dispose() })
    styles.mount()
    const installed = [...document.head.querySelectorAll('style[data-path]')]
      .map(style => [style.getAttribute('data-plugin'), style.getAttribute('data-path'), style.textContent])
    expect(installed).toEqual([['a', 'src/shared.css', '.a { display: flex }'], ['b', 'src/shared.css', '.b { display: block }']])
  })

  it('deduplicates a path within a package and keeps the installed text when a chunk conflicts', async () => {
    const f = fixture()
    f.target.load({ id: 'a', meta: metadata('shared.css', '.same { display: block }'),
      factory: require => ({ open: (chunk: string) => require.async(chunk) }) })
    f.target.load({ id: 'a', chunk: 'client.same.js', factory: () => ({}), meta: metadata('shared.css', '.same { display: block }') })
    f.target.load({ id: 'a', chunk: 'client.other.js', factory: () => ({}), meta: metadata('shared.css', '.different { display: flex }') })
    f.register('unrelated', '.unrelated { display: grid }')
    const entry = await f.modules.import('a') as { open(chunk: string): Promise<unknown> }
    const styles = new DocumentStyles(document.head, f.modules)
    disposers.push(() =>{  styles.dispose() })
    styles.mount()
    const original = document.head.querySelector('style[data-path="shared.css"]')
    await entry.open('./client.same.js')
    expect(paths()).toEqual(['shared.css'])
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await entry.open('./client.other.js')
    expect(error.mock.calls).toEqual([[
      'module styles: "shared.css" of "a/client.other.js" is not installed; another module of "a" provides different CSS for the same path',
    ]])
    expect(document.head.querySelector('style[data-path="shared.css"]')).toBe(original)
    expect(original?.textContent).toBe('.same { display: block }')
    await f.modules.import('unrelated')
    expect(paths()).toEqual(['shared.css', 'unrelated'])
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('keeps a running stylesheet when a record ordered before it later claims the same path', () => {
    const listeners = new Set<() => void>()
    const record = (id: string, css: string): ClientModuleRecord => ({ id, ownerId: 'a', exports: {}, edges: new Set(), meta: metadata('shared.css', css) })
    const running = record('a/client.running.js', '.running { display: block }')
    let active: ClientModuleRecord[] = [running]
    const styles = new DocumentStyles(document.head, {
      subscribeModules: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      activeRecords: () => active,
      resolveAsset: reference => reference,
    })
    disposers.push(() =>{  styles.dispose() })
    styles.mount()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    active = [record('a', '.late { display: flex }'), running]
    for (const listener of listeners) listener()
    expect(document.head.querySelector('style[data-path="shared.css"]')?.textContent).toBe('.running { display: block }')
    expect(error.mock.calls).toEqual([[
      'module styles: "shared.css" of "a" is not installed; another module of "a" provides different CSS for the same path',
    ]])
    active = active.slice(0, 1)
    for (const listener of listeners) listener()
    expect(document.head.querySelector('style[data-path="shared.css"]')?.textContent).toBe('.late { display: flex }')
  })

  it('installs only materialized modules synchronously, with dependencies before consumers', async () => {
    const f = fixture()
    f.register('z-dependency', '.dependency { display: block }')
    f.register('a-consumer', '.consumer { display: flex }', 'z-dependency')
    f.register('unused', '.unused { display: none }')
    await f.modules.import('a-consumer')
    const scope = new DocumentStyles(document.head, f.modules)
    disposers.push(() =>{  scope.dispose() })
    scope.mount()
    expect(paths()).toEqual(['z-dependency', 'a-consumer'])
    const prior = [...document.head.querySelectorAll('style[data-path]')]
    f.register('later', '.later { display: grid }')
    expect(paths()).not.toContain('later')
    await f.modules.import('later')
    expect(paths()).toEqual(['z-dependency', 'a-consumer', 'later'])
    expect(document.head.querySelector('style[data-path="a-consumer"]')).toBe(prior[1])
    f.modules.invalidate('a-consumer')
    expect(paths()).toEqual(['later', 'z-dependency'])
    expect(document.head.querySelector('style[data-path="z-dependency"]')).toBe(prior[0])
    scope.dispose()
    expect(paths()).toEqual([])
    await f.modules.import('unused')
    expect(paths()).toEqual([])
  })

  it('removes invalidated module resources and installs the replacement before import resolves', async () => {
    const f = fixture()
    f.register('feature', '.feature { display: block }')
    await f.modules.import('feature')
    const scope = new DocumentStyles(document.head, f.modules)
    disposers.push(() =>{  scope.dispose() })
    scope.mount()
    f.modules.invalidate('feature')
    expect(paths()).toEqual([])
    f.register('feature', '.feature { display: flex }')
    await f.modules.import('feature')
    expect(document.head.querySelector('style[data-path="feature"]')?.textContent).toBe('.feature { display: flex }')
  })

  it('mounts with the healthy modules when a materialized style producer fails', async () => {
    const f = fixture()
    const failure = new Error('broken style')
    f.target.load({ id: 'broken', factory: () => ({}),
      meta: () => ({ stylesheets: { broken: { text: () => { throw failure } } } }) })
    f.register('healthy', '.healthy { display: block }')
    await f.modules.import('broken')
    await f.modules.import('healthy')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const styles = new DocumentStyles(document.head, f.modules)
    disposers.push(() =>{  styles.dispose() })
    styles.mount()
    expect(paths()).toEqual(['healthy'])
    expect(error.mock.calls).toEqual([['module styles: "broken" of "broken" failed and is not installed', failure]])
  })

  it('releases subscriptions and partially installed nodes when mounting fails', async () => {
    const f = fixture()
    f.register('a', '.a { display: block }')
    f.register('b', '.b { display: flex }')
    await f.modules.import('a')
    await f.modules.import('b')
    const unsubscribe = vi.fn()
    const subscribe = f.modules.subscribeModules.bind(f.modules)
    const subscribed = vi.spyOn(f.modules, 'subscribeModules').mockImplementation((listener) => {
      const stop = subscribe(listener)
      return () => { unsubscribe(); stop() }
    })
    const insert = document.head.insertBefore.bind(document.head)
    vi.spyOn(document.head, 'insertBefore')
      .mockImplementationOnce(insert)
      .mockImplementationOnce(() => { throw new Error('insertion failed') })
    const styles = new DocumentStyles(document.head, f.modules)
    disposers.push(() =>{  styles.dispose() })
    expect(() =>{  styles.mount() }).toThrow('insertion failed')
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(subscribed).toHaveBeenCalledTimes(1)
    expect(paths()).toEqual([])
    expect(() =>{  styles.mount() }).toThrow('disposed')
    styles.dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('mounts when module metadata cannot be produced and styles a module that loads afterwards', async () => {
    const f = fixture()
    const failure = new Error('broken metadata')
    const meta = vi.fn((): never => { throw failure })
    f.target.load({ id: 'broken', factory: () => ({}), meta })
    await f.modules.import('broken')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const styles = new DocumentStyles(document.head, f.modules)
    disposers.push(() =>{  styles.dispose() })
    styles.mount()
    expect(paths()).toEqual([])
    f.register('later', '.later { display: grid }')
    await f.modules.import('later')
    expect(paths()).toEqual(['later'])
    expect(meta).toHaveBeenCalledTimes(1)
    expect(error.mock.calls).toEqual([['module styles: metadata of "broken" failed; its styles are not installed', failure]])
    f.modules.invalidate('broken')
    f.target.load({ id: 'broken', factory: () => ({}), meta: metadata('repaired.css') })
    await f.modules.import('broken')
    expect(paths()).toEqual(['repaired.css', 'later'])
  })

  it('reports a later producer failure once and keeps installing other modules', async () => {
    const f = fixture()
    f.register('existing', '.existing { display: block }')
    await f.modules.import('existing')
    const scope = new DocumentStyles(document.head, f.modules)
    disposers.push(() =>{  scope.dispose() })
    scope.mount()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('broken style')
    f.target.load({ id: 'broken', factory: () => ({}),
      meta: () => ({ stylesheets: { broken: { text: () => { throw failure } } } }) })
    await f.modules.import('broken')
    expect(paths()).toEqual(['existing'])
    f.register('later', '.later { display: grid }')
    await f.modules.import('later')
    expect(paths()).toEqual(['existing', 'later'])
    expect(error.mock.calls).toEqual([['module styles: "broken" of "broken" failed and is not installed', failure]])
  })

  it('keeps the styles of a replaced module until its previous records are released', () => {
    const listeners = new Set<() => void>()
    const record = (css: string): ClientModuleRecord => ({ id: 'feature', ownerId: 'feature', exports: {}, edges: new Set(), meta: metadata('feature.css', css) })
    const previous = record('.old { display: block }')
    let active: ClientModuleRecord[] = [previous]
    const styles = new DocumentStyles(document.head, {
      subscribeModules: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      activeRecords: () => active,
      resolveAsset: reference => reference,
    })
    disposers.push(() =>{  styles.dispose() })
    styles.mount()
    const installed = document.head.querySelector('style[data-path="feature.css"]')
    // Replacement invalidates the code without notifying; an unrelated module arriving meanwhile must not release the styles.
    active = [previous, { id: 'other', ownerId: 'other', exports: {}, edges: new Set(), meta: metadata('other.css') }]
    for (const listener of listeners) listener()
    expect(paths()).toEqual(['feature.css', 'other.css'])
    expect(document.head.querySelector('style[data-path="feature.css"]')).toBe(installed)
    active = active.slice(1)
    for (const listener of listeners) listener()
    expect(paths()).toEqual(['other.css'])
    active = [record('.new { display: flex }'), ...active]
    for (const listener of listeners) listener()
    expect(document.head.querySelector('style[data-path="feature.css"]')?.textContent).toBe('.new { display: flex }')
  })

  it('installs initial styles during mounting and releases its module subscription on disposal', async () => {
    const f = fixture()
    f.register('theme', '.theme { display: block }')
    await f.modules.import('theme')
    const unsubscribe = vi.fn()
    const subscribe = f.modules.subscribeModules.bind(f.modules)
    const subscribed = vi.spyOn(f.modules, 'subscribeModules').mockImplementation((listener) => {
      const stop = subscribe(listener)
      return () => { unsubscribe(); stop() }
    })
    const styles = new DocumentStyles(document.head, f.modules)
    disposers.push(() =>{  styles.dispose() })
    styles.mount()
    expect(paths()).toEqual(['theme'])
    expect(subscribed).toHaveBeenCalledTimes(1)
    styles.dispose()
    styles.dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(paths()).toEqual([])
    f.register('later', '.later { display: grid }')
    await f.modules.import('later')
    expect(paths()).toEqual([])
  })
})
