/** Explicit Worker root contexts remain attached to deferred callbacks. */
import { expect, it } from 'vitest'
import {
  AsyncLocalStorage, __restoreAll, __snapshotAll, bindAsyncContext, runAtAsyncContextRoot,
} from '@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/async_hooks.ts'
import { installTimerGlobals } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/node/globals/timers.ts'

it('keeps a root-bound callback outside a later transaction and restores its caller', () => {
  const store = new AsyncLocalStorage<string>()
  try {
    const callback = runAtAsyncContextRoot(() => bindAsyncContext(() => store.getStore()))
    store.run('transaction', () => {
      expect(callback()).toBeUndefined()
      expect(store.getStore()).toBe('transaction')
    })
  } finally {
    store.disable()
  }
})

it('keeps a resumed root context on callbacks registered after await', () => {
  const store = new AsyncLocalStorage<string>()
  const root = runAtAsyncContextRoot(() => __snapshotAll())
  const restore = __restoreAll(root)
  const callback = bindAsyncContext(() => store.getStore())
  restore()
  try {
    expect(store.run('transaction', callback)).toBeUndefined()
  } finally {
    store.disable()
  }
})

it('keeps callbacks registered inside exit outside a later transaction', () => {
  const store = new AsyncLocalStorage<string>()
  try {
    const callback = store.exit(() => bindAsyncContext(() => store.getStore()))
    expect(store.run('transaction', callback)).toBeUndefined()
  } finally {
    store.disable()
  }
})

it('keeps an unbound callback on the existing ambient fallback', () => {
  const store = new AsyncLocalStorage<string>()
  try {
    const callback = () => store.getStore()
    const bound = bindAsyncContext(callback)
    expect(bound).toBe(callback)
    expect(store.run('transaction', bound)).toBe('transaction')
  } finally {
    store.disable()
  }
})

it('keeps a timer registered at the root outside an overlapping transaction', async () => {
  const names = ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate', 'clearImmediate'] as const
  const descriptors = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  const store = new AsyncLocalStorage<string>()
  const release = Promise.withResolvers<undefined>()
  const observed = Promise.withResolvers<string | undefined>()
  const transaction = store.run('transaction', () => release.promise)
  let timer: ReturnType<typeof setTimeout> | undefined
  const nativeSetTimeout = globalThis.setTimeout
  try {
    // Browser timers return numeric ids; Node also accepts their numeric ids when clearing them.
    Object.defineProperty(globalThis, 'setTimeout', {
      configurable: true, writable: true,
      value: (callback: VoidFunction, timeout?: number): number => Number(nativeSetTimeout(callback, timeout)),
    })
    installTimerGlobals()
    runAtAsyncContextRoot(() => {
      timer = setTimeout(() => { observed.resolve(store.getStore()) }, 0)
    })
    expect(store.getStore()).toBe('transaction')
    expect(await observed.promise).toBeUndefined()
    expect(store.getStore()).toBe('transaction')
  } finally {
    clearTimeout(timer)
    release.resolve(undefined)
    await transaction
    store.disable()
    for (const [name, descriptor] of descriptors) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, name)
      else Object.defineProperty(globalThis, name, descriptor)
    }
  }
})
