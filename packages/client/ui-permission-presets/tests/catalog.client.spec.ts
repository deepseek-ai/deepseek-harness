import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type {
  ConnectionGeneration, ConnectionHandle,
} from '@deepseek-ai/dsh-client-connection/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { PermissionCatalog } from '@deepseek-ai/dsh-permission-presets/client'
import { PermissionCatalogDirectory } from '../src/client/catalog.ts'

const FIRST: PermissionCatalog = {
  options: [{ value: 'read-only', name: 'Read only' }],
}
const SECOND: PermissionCatalog = {
  options: [{ value: 'workspace-write', name: 'Workspace write' }],
}

interface GenerationDriver {
  set(id: number | undefined): void
  setSilently(id: number | undefined): void
  captureListener(): () => void
}

function installConnection(ctx: Context, initialId: number | undefined): GenerationDriver {
  let generation = generationOf(initialId)
  const listeners = new Set<() => void>()
  const connection = {
    isLoopback: true,
    generation: {
      getSnapshot: () => generation,
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
  } as ConnectionHandle
  ctx.provide('connection', connection)
  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }
  return {
    set(id) {
      generation = generationOf(id)
      notify()
    },
    setSilently(id) {
      generation = generationOf(id)
    },
    captureListener() {
      const listener = [...listeners][0]
      if (listener === undefined) throw new Error('generation listener is not installed')
      return listener
    },
  }
}

function generationOf(id: number | undefined): ConnectionGeneration | undefined {
  return id === undefined
    ? undefined
    : { id, host: { home: `/host-${String(id)}` } }
}

describe('PermissionCatalogDirectory', () => {
  it('retries a failed read only when a later popup load requests the catalog', async () => {
    const ctx = new Context()
    installConnection(ctx, 1)
    let calls = 0
    new TestRemote(ctx, {
      permissionPresets: {
        catalog() {
          calls += 1
          return calls === 1
            ? Promise.reject(new Error('catalog temporarily unavailable'))
            : Promise.resolve({ ok: true as const, value: FIRST })
        },
      },
    })
    const directory = new PermissionCatalogDirectory(ctx)
    await expect(directory.load()).rejects.toThrow('catalog temporarily unavailable')
    expect(directory.store.getSnapshot()).toEqual({ value: null })
    await Promise.resolve()
    expect(calls).toBe(1)
    await expect(directory.load()).resolves.toEqual(FIRST)
    expect(calls).toBe(2)
    directory.dispose()
  })

  it('subscribes before its first read and lets the newest same-generation refresh win', async () => {
    const ctx = new Context()
    installConnection(ctx, 1)
    const first = Promise.withResolvers<{ ok: true; value: PermissionCatalog }>()
    const second = Promise.withResolvers<{ ok: true; value: PermissionCatalog }>()
    let calls = 0
    const remote = new TestRemote(ctx, {
      permissionPresets: {
        catalog() {
          calls += 1
          if (calls === 1) {
            remote.emit('permission-presets/catalog-changed', [])
            return first.promise
          }
          return second.promise
        },
      },
    })

    const directory = new PermissionCatalogDirectory(ctx)
    expect(calls).toBe(2)
    second.resolve({ ok: true, value: SECOND })
    await vi.waitFor(() => { expect(directory.store.getSnapshot().value).toEqual(SECOND) })
    first.resolve({ ok: true, value: FIRST })
    await first.promise
    await Promise.resolve()
    expect(directory.store.getSnapshot()).toEqual({ value: SECOND })
    directory.dispose()
  })

  it('clears the public snapshot when the winning same-generation refresh fails', async () => {
    const ctx = new Context()
    installConnection(ctx, 1)
    let response: 'success' | 'rpc-failure' | 'throw' = 'success'
    const remote = new TestRemote(ctx, {
      permissionPresets: {
        catalog() {
          if (response === 'success') return Promise.resolve({ ok: true as const, value: FIRST })
          if (response === 'rpc-failure') {
            return Promise.resolve({
              ok: false as const,
              error: { code: 'catalog/unavailable', message: 'catalog unavailable', details: {} },
            })
          }
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- non-Error Remote rejection is the scenario.
          return Promise.reject('raw catalog failure')
        },
      },
    })
    const directory = new PermissionCatalogDirectory(ctx)
    await expect(directory.load()).resolves.toEqual(FIRST)
    response = 'rpc-failure'
    remote.emit('permission-presets/catalog-changed', [])
    await expect(directory.load()).rejects.toThrow('catalog/unavailable: catalog unavailable')
    expect(directory.store.getSnapshot()).toEqual({ value: null })

    response = 'success'
    remote.emit('permission-presets/catalog-changed', [])
    await expect(directory.load()).resolves.toEqual(FIRST)
    response = 'throw'
    remote.emit('permission-presets/catalog-changed', [])
    await expect(directory.load()).rejects.toThrow('raw catalog failure')
    expect(directory.store.getSnapshot()).toEqual({ value: null })
    directory.dispose()
  })

  it('waits for the active refresh before serving a retained value', async () => {
    const ctx = new Context()
    installConnection(ctx, 1)
    const refresh = Promise.withResolvers<{ ok: true; value: PermissionCatalog }>()
    let calls = 0
    const remote = new TestRemote(ctx, {
      permissionPresets: {
        catalog() {
          calls += 1
          return calls === 1
            ? Promise.resolve({ ok: true as const, value: FIRST })
            : refresh.promise
        },
      },
    })
    const directory = new PermissionCatalogDirectory(ctx)
    await expect(directory.load()).resolves.toEqual(FIRST)

    remote.emit('permission-presets/catalog-changed', [])
    const loaded = directory.load()
    let settled = false
    void loaded.finally(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    refresh.resolve({ ok: true, value: SECOND })
    await expect(loaded).resolves.toEqual(SECOND)
    directory.dispose()
  })

  it('hard-clears generation loss and rejects stale settlements from the old Host', async () => {
    const ctx = new Context()
    const generation = installConnection(ctx, 1)
    const oldRead = Promise.withResolvers<{ ok: true; value: PermissionCatalog }>()
    const newRead = Promise.withResolvers<{ ok: true; value: PermissionCatalog }>()
    let calls = 0
    new TestRemote(ctx, {
      permissionPresets: {
        catalog() {
          calls += 1
          return calls === 1 ? oldRead.promise : newRead.promise
        },
      },
    })
    const directory = new PermissionCatalogDirectory(ctx)
    expect(directory.invalidations.getSnapshot()).toEqual({ count: 0 })

    generation.set(undefined)
    // Generation loss and replacement each withdraw displayed options once.
    expect(directory.invalidations.getSnapshot()).toEqual({ count: 1 })
    expect(directory.store.getSnapshot()).toEqual({ value: null })
    directory.refresh()
    await expect(directory.load()).rejects.toThrow(/no active Host connection/)
    oldRead.reject(new Error('old Host failed'))
    await expect(oldRead.promise).rejects.toThrow('old Host failed')
    await Promise.resolve()
    expect(directory.store.getSnapshot()).toEqual({ value: null })

    generation.set(2)
    expect(directory.invalidations.getSnapshot()).toEqual({ count: 2 })
    expect(directory.store.getSnapshot()).toEqual({ value: null })
    newRead.resolve({ ok: true, value: SECOND })
    await expect(directory.load()).resolves.toEqual(SECOND)
    expect(calls).toBe(2)
    directory.dispose()
  })

  it('resynchronizes when refresh or load observes a generation notification first', async () => {
    const ctx = new Context()
    const generation = installConnection(ctx, 1)
    const catalogs = [FIRST, SECOND, FIRST]
    let calls = 0
    new TestRemote(ctx, {
      permissionPresets: {
        catalog() {
          const value = catalogs[calls]
          calls += 1
          if (value === undefined) throw new Error('unexpected permission catalog read')
          return Promise.resolve({ ok: true as const, value })
        },
      },
    })
    const directory = new PermissionCatalogDirectory(ctx)
    await expect(directory.load()).resolves.toEqual(FIRST)

    generation.set(1)
    expect(calls).toBe(1)
    // A notification repeating the published generation is not an invalidation.
    expect(directory.invalidations.getSnapshot()).toEqual({ count: 0 })

    generation.setSilently(2)
    await expect(directory.load()).resolves.toEqual(SECOND)
    expect(calls).toBe(2)
    // A generation change observed by load() withdraws displayed options too.
    expect(directory.invalidations.getSnapshot()).toEqual({ count: 1 })

    generation.setSilently(3)
    directory.refresh()
    await vi.waitFor(() => { expect(directory.store.getSnapshot().value).toEqual(FIRST) })
    expect(calls).toBe(3)
    expect(directory.invalidations.getSnapshot()).toEqual({ count: 2 })
    directory.dispose()
  })

  it('drops a late disposed settlement and makes disposal idempotent', async () => {
    const ctx = new Context()
    const generation = installConnection(ctx, 1)
    const read = Promise.withResolvers<{ ok: true; value: PermissionCatalog }>()
    let calls = 0
    new TestRemote(ctx, {
      permissionPresets: {
        catalog() {
          calls += 1
          return read.promise
        },
      },
    })
    const directory = new PermissionCatalogDirectory(ctx)
    const before = directory.store.getSnapshot()
    const lateGenerationListener = generation.captureListener()
    directory.dispose()
    directory.dispose()
    directory.refresh()
    // The pending generation change makes both assertions below depend on the
    // disposed guard rather than on the same-generation early return.
    generation.setSilently(2)
    lateGenerationListener()
    read.resolve({ ok: true, value: FIRST })
    await read.promise
    await Promise.resolve()

    expect(directory.store.getSnapshot()).toBe(before)
    // A listener that fires after disposal publishes nothing.
    expect(directory.invalidations.getSnapshot()).toEqual({ count: 0 })
    expect(calls).toBe(1)
    await expect(directory.load()).rejects.toThrow(/disposed/)
  })

  it('surfaces a first-read RPC failure when no complete catalog exists', async () => {
    const ctx = new Context()
    installConnection(ctx, 1)
    new TestRemote(ctx, {
      permissionPresets: {
        catalog: () => Promise.resolve({
          ok: false as const,
          error: { code: 'catalog/missing', message: 'missing catalog', details: {} },
        }),
      },
    })
    const directory = new PermissionCatalogDirectory(ctx)

    await expect(directory.load()).rejects.toThrow('catalog/missing: missing catalog')
    directory.dispose()
  })
})
