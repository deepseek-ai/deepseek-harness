// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { MainScriptRealm } from '../src/client/main-realm.ts'
import { createClientModuleSystem, type ClientModuleLoaderTarget } from '../src/client/index.ts'

function fixture(loadBundle?: (url: string) => Promise<void>) {
  const target: ClientModuleLoaderTarget = {
    mode: 'queue', pendingQueue: [], load: () => {},
    create: options => createClientModuleSystem(target, { id: 'bootstrap', exports: {} }, options),
  }
  const modules = target.create({
    boot: { rev: '1', entries: [{ id: 'a', url: '/a.js', rev: '1' }],
      batches: [{ phase: 'application', url: '/a.js', rev: '1', entries: ['a'] }] },
    staticModules: [], ...(loadBundle === undefined ? {} : { loadBundle }),
  })
  return { modules, target }
}

const registration = { id: 'a', factory: () => ({ marker: true }) }

describe('module-owned Main Realm', () => {
  it('uses the page script transport immediately without a readiness handoff', async () => {
    const { modules, target } = fixture()
    const append = document.head.append.bind(document.head)
    const load = vi.spyOn(document.head, 'append').mockImplementation((...nodes) => {
      append(...nodes)
      target.load(registration)
      const script = nodes[0]
      if (typeof script === 'string' || script === undefined) throw new Error('expected a script node')
      script.dispatchEvent(new Event('load'))
    })
    try {
      expect(modules.mainRealm.id).toBe('main')
      expect(await modules.import('a')).toEqual({ marker: true })
      expect(load).toHaveBeenCalledTimes(1)
      expect(document.head.querySelector('script')).toBeNull()
    } finally {
      load.mockRestore()
      await modules.dispose()
    }
  })

  it('preserves the configured carrier and shares one transport across concurrent requests', async () => {
    const load = vi.fn(async (url: string) => { expect(url).toBe('/a.js'); target.load(registration) })
    const { modules, target } = fixture(load)
    const realm = modules.mainRealm
    await Promise.all([modules.prefetch('a'), modules.prefetch('a')])
    expect(load).toHaveBeenCalledTimes(1)
    expect(modules.mainRealm).toBe(realm)
    expect(await modules.import('a')).toEqual({ marker: true })
    await modules.dispose()
  })

  it('returns the carrier completion and failure without replacing them', async () => {
    const failure = new Error('carrier failed')
    const task = Promise.reject(failure)
    const load = vi.fn(() => task)
    const realm = new MainScriptRealm(load)
    expect(realm.execute({ url: 'carrier-script' })).toBe(task)
    await expect(task).rejects.toBe(failure)
    expect(load).toHaveBeenCalledWith('carrier-script')
    await realm.dispose()
  })

  it('waits for existing carrier work and rejects new execution after disposal starts', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const load = vi.fn(() => pending)
    const realm = new MainScriptRealm(load)
    const execution = realm.execute({ url: 'pending' })
    const disposal = realm.dispose()
    expect(realm.dispose()).toBe(disposal)
    let disposed = false
    void disposal.then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    await expect(realm.execute({ url: 'late' })).rejects.toThrow('disposed')
    expect(load).toHaveBeenCalledTimes(1)
    finish()
    await execution
    await disposal
    expect(disposed).toBe(true)
  })

  it('keeps synchronous carrier throws synchronous', async () => {
    const error = new Error('synchronous carrier failure')
    const realm = new MainScriptRealm(() => { throw error })
    expect(() => realm.execute({ url: 'invalid' })).toThrow(error)
    await realm.dispose()
  })
})
