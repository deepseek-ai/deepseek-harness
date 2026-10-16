/**
 * Async context of Worker filesystem watcher callbacks. Node delivers watcher events from the watch handle, so a
 * listener reads the async context where its watcher was created, never the context of the code whose write
 * produced the event. HMR depends on it: its configuration watchers run outside the transaction that writes the
 * profile manifest.
 *
 * Imports go through the package name so the shim, the hook layer, and the watcher share one module instance.
 */
import { beforeEach, expect, test } from 'vitest'
import { AsyncLocalStorage } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/async_hooks.ts'
import { installAsyncContextHooks } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/polyfill/async-context/async-context-hooks.ts'
import { installTimerGlobals } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/node/globals/timers.ts'
import { MemoryVfs } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/memory.ts'
import { setActiveVfs } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/active.ts'
import * as workerFs from '@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/fs.ts'

// The worker entry's order: patch the platform, then wrap the timers over it.
installAsyncContextHooks()
installTimerGlobals()

const ROOT = '/dsh/watch-context'
let vfs: MemoryVfs

beforeEach(() => {
  vfs = new MemoryVfs()
  setActiveVfs(vfs)
  vfs.mkdirSync(ROOT, { recursive: true })
})

/** Resolve with the store `als` reads inside the first event; the test timeout bounds a missing event. */
function storeAtEvent(als: AsyncLocalStorage<string>, subscribe: (listener: () => void) => () => void): Promise<string | undefined> {
  return new Promise((resolve) => {
    const unsubscribe = subscribe(() => {
      resolve(als.getStore())
      unsubscribe()
    })
  })
}

test('an fs.watch listener created outside a store does not read the writer’s store', async () => {
  const als = new AsyncLocalStorage<string>()
  const file = `${ROOT}/package.json`
  workerFs.writeFileSync(file, '{}')
  const observed = storeAtEvent(als, (listener) => {
    const watcher = workerFs.watch(file, listener)
    return () => { watcher.close() }
  })
  als.run('transaction', () => { workerFs.writeFileSync(file, '{"a":1}') })
  await expect(observed).resolves.toBeUndefined()
})

test('an fs.watch listener reads the store its watcher was created in', async () => {
  const als = new AsyncLocalStorage<string>()
  const file = `${ROOT}/patch.yml`
  workerFs.writeFileSync(file, 'a')
  const observed = als.run('watcher', () => storeAtEvent(als, (listener) => {
    const watcher = workerFs.watch(file, listener)
    return () => { watcher.close() }
  }))
  als.run('transaction', () => { workerFs.writeFileSync(file, 'b') })
  await expect(observed).resolves.toBe('watcher')
})

test('an fs.watchFile listener created outside a store does not read the writer’s store', async () => {
  const als = new AsyncLocalStorage<string>()
  const file = `${ROOT}/polled.json`
  workerFs.writeFileSync(file, '{}')
  const observed = storeAtEvent(als, (listener) => {
    workerFs.watchFile(file, { interval: 5 }, listener)
    return () => { workerFs.unwatchFile(file, listener) }
  })
  als.run('transaction', () => { workerFs.writeFileSync(file, '{"changed":true}') })
  await expect(observed).resolves.toBeUndefined()
})
