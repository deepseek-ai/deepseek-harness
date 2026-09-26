/** The projection of the plugins carrying configuration: what it reads from the ledgers and when it moves. */

import { describe, expect, it, vi } from 'vitest'
import { configLedgerSource, rowConfigKey } from '../src/client/config-ledger.ts'

interface Registration {
  options: { id?: string; key?: string; label?: string | (() => string) }
}

/** A slot registry and locale stand-in: ledgers by slot, versions that move on registration, and a locale revision. */
function bench() {
  const entries: Record<string, Registration[]> = { 'plugins.item': [], 'plugins.bundle.config': [], 'plugins.row.config': [] }
  const versions: Record<string, number> = { 'plugins.item': 0, 'plugins.bundle.config': 0, 'plugins.row.config': 0 }
  const listeners = new Map<string, Set<() => void>>()
  const localeListeners = new Set<() => void>()
  let revision = 0
  const ctx = {
    slots: {
      entries: (name: string) => entries[name] ?? [],
      getVersion: (name: string) => versions[name] ?? 0,
      subscribe: (name: string, listener: () => void) => {
        const set = listeners.get(name) ?? new Set<() => void>()
        set.add(listener)
        listeners.set(name, set)
        return () => { set.delete(listener) }
      },
    },
    locale: {
      getSnapshot: () => ({ revision }),
      subscribe: (listener: () => void) => {
        localeListeners.add(listener)
        return () => { localeListeners.delete(listener) }
      },
    },
  }
  return {
    ctx: ctx as never,
    register: (name: string, options: Registration['options']): void => {
      entries[name]?.push({ options })
      versions[name] = (versions[name] ?? 0) + 1
      for (const listener of listeners.get(name) ?? []) listener()
    },
    setLocale: (): void => {
      revision += 1
      for (const listener of localeListeners) listener()
    },
    listenerCount: (): number => [...listeners.values()].reduce((count, set) => count + set.size, 0) + localeListeners.size,
  }
}

describe('configLedgerSource', () => {
  it('projects the official items in ledger order with locale-following labels, and the bundle and row keys', () => {
    const b = bench()
    const source = configLedgerSource(b.ctx)
    expect(source.getSnapshot()).toEqual({ items: [], bundles: new Set(), rows: new Set() })

    let title = 'Shell'
    b.register('plugins.item', { id: 'bash', label: () => title })
    b.register('plugins.item', { id: 'loop', label: 'Agent loop' })
    b.register('plugins.bundle.config', { key: 'dsh-x' })
    b.register('plugins.row.config', { key: rowConfigKey('dsh-x', 'row') })

    expect(source.getSnapshot()).toEqual({
      items: [{ id: 'bash', label: 'Shell' }, { id: 'loop', label: 'Agent loop' }],
      bundles: new Set(['dsh-x']),
      rows: new Set(['dsh-x#row']),
    })
    // A label thunk is re-read when the locale moves, not before.
    title = '终端'
    expect(source.getSnapshot().items[0]?.label).toBe('Shell')
    b.setLocale()
    expect(source.getSnapshot().items[0]?.label).toBe('终端')
  })

  it('lists an entry without a label under an empty title and skips a keyed entry without a key', () => {
    const b = bench()
    const source = configLedgerSource(b.ctx)
    b.register('plugins.item', { id: 'bare' })
    b.register('plugins.bundle.config', {})

    expect(source.getSnapshot()).toEqual({ items: [{ id: 'bare', label: '' }], bundles: new Set(), rows: new Set() })
  })

  it('keeps its snapshot until a ledger or the locale moves, and follows every source while subscribed', () => {
    const b = bench()
    const source = configLedgerSource(b.ctx)
    const first = source.getSnapshot()
    expect(source.getSnapshot()).toBe(first)
    const listener = vi.fn()
    const off = source.subscribe(listener)

    b.register('plugins.item', { id: 'bash', label: 'Shell' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(source.getSnapshot()).not.toBe(first)
    b.setLocale()
    expect(listener).toHaveBeenCalledTimes(2)

    off()
    expect(b.listenerCount()).toBe(0)
    b.register('plugins.item', { id: 'loop', label: 'Loop' })
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
