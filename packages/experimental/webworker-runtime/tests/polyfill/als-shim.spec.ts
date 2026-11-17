/**
 * Behavioural check of the folding AsyncLocalStorage shim: the two shapes the
 * agent service actually uses (nested instances; a boundary whose operation
 * returns a promise), the hook layer that carries a registration context into a
 * callback, and the explicit-switch slots the module transform's `await`
 * rewriting drives.
 *
 * Layering, because three mechanisms answer `getStore()` and the cases below
 * pick them apart deliberately:
 *  1. the **folding stack** — `run()` boundaries, unwound by identity;
 *  2. the **hook layer** — patched `then`/timers, so a callback reads the store
 *     from where it was REGISTERED rather than where it runs;
 *  3. the **explicit switch** — `__snapshotAll`/`__restoreAll` and the
 *     `alsCausality` face, which the transformed modules reach at every
 *     suspension point. This is the layer that survives true interleaving, and
 *     case 17 is the one that shows the folding stack alone cannot.
 *
 * Scope boundary: this file owns the shim (the state). `als-runtime.spec.ts`
 * owns the protocol that moves snapshots around, with the causality face stubbed.
 *
 * Every import goes through the **package name**, not a relative path: a check
 * that reaches built `lib/` while the shim resolves by package name to `src/`
 * gets two module instances and a shim mounted in the wrong world (the failure
 * mode asserted in `../node/fs.spec.ts`). One resolution path per module.
 */
import { expect, test } from 'vitest'
import {
  AsyncLocalStorage, __restoreAll, __snapshotAll, alsCausality, runAtAsyncContextRoot,
} from '@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/async_hooks.ts'
import { installAsyncContextHooks } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/polyfill/async-context/async-context-hooks.ts'
import { installTimerGlobals } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/node/globals/timers.ts'

// Same order the worker entry uses: patch the platform, then wrap the timers over
// the patched platform. The folding cases below must hold with both in place.
installAsyncContextHooks()
installTimerGlobals()

// Both sides are serialized at call time, not inside the case: several blocks
// below reuse a mutable array as the observed value, so a captured reference
// would read a later block's state by the time the case executes.
const check = (label: string, actual: unknown, expected: unknown): void => {
  const [seen, wanted] = [JSON.stringify(actual), JSON.stringify(expected)]
  test(label, () => { expect(seen).toBe(wanted) })
}
const delay = (ms = 0): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

// 0. The migration's own precondition: the hook layer really is installed over
//    this module instance. If the check and the shim ever resolve to two
//    instances again, the patched `then` below belongs to the other copy and
//    every hook-layer case would silently test an unpatched platform.
{
  const als = new AsyncLocalStorage<string>()
  let seen: string | undefined = 'unset'
  als.run('installed', () => { void Promise.resolve().then(() => { seen = als.getStore() }) })
  await delay()
  check('hook layer is installed over this module instance', seen, 'installed')
}

// 1. Synchronous operation: visible inside, gone after.
{
  const als = new AsyncLocalStorage<string>()
  const seen = als.run('sync', () => als.getStore())
  check('sync body sees store', seen, 'sync')
  check('sync boundary closes', als.getStore(), undefined)
  check('sync return value preserved', als.run('x', () => 42), 42)
}

// 2. The reason for the upgrade: the store survives awaits inside the operation.
{
  const als = new AsyncLocalStorage<string>()
  const observed: (string | undefined)[] = []
  const operation = async (): Promise<void> => {
    observed.push(als.getStore())
    await delay()
    observed.push(als.getStore())
    await delay(5)
    observed.push(als.getStore())
  }
  const running = als.run('agent-1', operation)
  observed.push(als.getStore())
  await running
  await delay()
  check('store visible across awaits', observed, ['agent-1', 'agent-1', 'agent-1', 'agent-1'])
  check('boundary closes after settle', als.getStore(), undefined)
}

// 3. Rejection still closes the boundary, and the caller still sees the rejection.
{
  const als = new AsyncLocalStorage<string>()
  const failing = als.run('doomed', async () => {
    await delay()
    throw new Error('operation failed')
  })
  const message = await failing.then(() => 'resolved', (error: unknown) => (error as Error).message)
  check('rejection propagates', message, 'operation failed')
  await delay()
  check('boundary closes after rejection', als.getStore(), undefined)
}

// 4. A synchronous throw closes the boundary too.
{
  const als = new AsyncLocalStorage<string>()
  try {
    als.run('thrower', () => { throw new Error('sync failure') })
  } catch (_syncFailure) { /* The callback throws on purpose; the check below reads the store after it. */ }
  check('boundary closes after sync throw', als.getStore(), undefined)
}

// 5. Nested boundaries on ONE instance unwind by identity, innermost first.
{
  const als = new AsyncLocalStorage<string>()
  const observed: (string | undefined)[] = []
  await als.run('outer', async () => {
    observed.push(als.getStore())
    await als.run('inner', async () => {
      await delay()
      observed.push(als.getStore())
    })
    await delay()
    observed.push(als.getStore())
  })
  await delay()
  check('nested unwind', observed, ['outer', 'inner', 'outer'])
  check('nested boundaries all closed', als.getStore(), undefined)
}

// 6. The agent service's real shape: two instances, the outer run returning the
//    inner run's promise (agent/src/index.ts:649).
{
  const runs = new AsyncLocalStorage<{ id: number }>()
  const initiators = new AsyncLocalStorage<string>()
  const observed: unknown[] = []
  const operation = async (): Promise<void> => {
    await delay()
    // What requireInitiator() does, several awaits below the boundary.
    observed.push([initiators.getStore(), runs.getStore()?.id])
  }
  const parent = runs.getStore()
  check('parent chain empty at first boundary', parent, undefined)
  await runs.run({ id: 1 }, () => initiators.run('agent-1', operation))
  await delay()
  check('both instances answered inside', observed, [['agent-1', 1]])
  check('runs closed', runs.getStore(), undefined)
  check('initiators closed', initiators.getStore(), undefined)
}

// 7. exit()/withoutInitiator hides the inherited store and restores it.
{
  const als = new AsyncLocalStorage<string>()
  const observed: (string | undefined)[] = []
  await als.run('agent-1', async () => {
    observed.push(als.getStore())
    await als.exit(async () => {
      await delay()
      observed.push(als.getStore())
    })
    observed.push(als.getStore())
  })
  await delay()
  check('exit hides then restores', observed, ['agent-1', undefined, 'agent-1'])
}

// 8. Interleaved boundaries: attribution follows the newest entry (the documented
//    single-concurrency limit) but nothing throws and the stack fully unwinds.
{
  const als = new AsyncLocalStorage<string>()
  const seen: (string | undefined)[] = []
  const body = async (_label: string, ms: number): Promise<void> => {
    await delay(ms)
    seen.push(als.getStore())
  }
  const first = als.run('A', () => body('A', 20))
  const second = als.run('B', () => body('B', 5))
  await Promise.all([first, second])
  await delay()
  check('interleaved reads never crash', seen.length, 2)
  check('interleaved reads resolve to an open boundary', seen.every(entry => entry === 'A' || entry === 'B'), true)
  check('stack unwinds after interleaving', als.getStore(), undefined)
}

// 9. disable() drops everything, as teardown expects.
{
  const als = new AsyncLocalStorage<string>()
  const pending = als.run('leaked', async () => { await delay(50) })
  als.disable()
  check('disable clears the stack', als.getStore(), undefined)
  await pending
}

// 10. HOOK LAYER: a `.then` callback reads the store from where it was REGISTERED,
//     even though the registering boundary is long closed by the time it runs.
{
  const als = new AsyncLocalStorage<string>()
  let seen: string | undefined = 'unset'
  const promise = new Promise<void>((resolve) => { setTimeout(resolve, 10) })
  als.run('registrar', () => { void promise.then(() => { seen = als.getStore() }) })
  check('boundary closed before the callback runs', als.getStore(), undefined)
  await delay(30)
  check('then callback reads the registration store', seen, 'registrar')
}

// 11. HOOK LAYER under interleaving: each callback reads ITS OWN registration
//     store, which the folding stack alone could not distinguish.
{
  const als = new AsyncLocalStorage<string>()
  const seen: (string | undefined)[] = []
  const register = (label: string, ms: number): void => {
    als.run(label, () => {
      setTimeout(() => { seen.push(`${label}:${String(als.getStore())}`) }, ms)
      void Promise.resolve().then(() => { seen.push(`${label}-then:${String(als.getStore())}`) })
      queueMicrotask(() => { seen.push(`${label}-micro:${String(als.getStore())}`) })
    })
  }
  register('A', 20)
  register('B', 5)
  await delay(40)
  check('interleaved timers read their own store', seen.filter((entry): entry is string => entry !== undefined && entry.includes(':')).sort(), [
    'A-micro:A', 'A-then:A', 'A:A', 'B-micro:B', 'B-then:B', 'B:B',
  ])
}

// 12. `catch`/`finally` inherit the patched `then` (they invoke it on the receiver).
{
  const als = new AsyncLocalStorage<string>()
  const seen: (string | undefined)[] = []
  const rejected = Promise.reject(new Error('boom'))
  const settled = als.run('handler', () => rejected
    .catch(() => { seen.push(als.getStore()) })
    .finally(() => { seen.push(als.getStore()) }))
  await settled
  await delay()
  check('catch and finally carry the registration store', seen, ['handler', 'handler'])
}

// 13. An empty handler slot stays empty: a rejection must not be swallowed by a
//     wrapper standing in for an absent fulfilled handler.
{
  const als = new AsyncLocalStorage<string>()
  const outcome = await als.run('slots', () => Promise
    .reject(new Error('preserved'))
    .then(undefined, (error: unknown) => `caught:${(error as Error).message}`))
  check('empty fulfilled slot preserved', outcome, 'caught:preserved')
  const passthrough = await als.run('slots', () => Promise.resolve('value').then(undefined, () => 'wrong'))
  check('value passes an empty fulfilled slot', passthrough, 'value')
}

// 14. A boundary opened inside a restored callback owns its reads, and the overlay
//     comes back afterwards.
{
  const als = new AsyncLocalStorage<string>()
  const seen: (string | undefined)[] = []
  als.run('outer', () => {
    queueMicrotask(() => {
      seen.push(als.getStore())
      als.run('inner', () => { seen.push(als.getStore()) })
      seen.push(als.getStore())
    })
  })
  await delay(10)
  check('nested run inside a restored callback', seen, ['outer', 'inner', 'outer'])
}

// 15. The tunnel entry's root context masks whatever was open before it.
{
  const als = new AsyncLocalStorage<string>()
  let seen: string | undefined = 'unset'
  als.run('stale', () => {
    runAtAsyncContextRoot(() => { seen = als.getStore() })
  })
  check('root context masks an open boundary', seen, undefined)
  check('root context restores afterwards', als.getStore(), undefined)
}

// 16. Promises stay native: the patch wraps handlers, not the chain.
{
  const als = new AsyncLocalStorage<string>()
  const chained = als.run('native', () => Promise.resolve(1).then(value => value + 1))
  check('then returns a native promise', chained instanceof Promise, true)
  check('chained value', await chained, 2)
}

// 17. EXPLICIT SWITCH: a resumed frame reads what its pause point read, even
//     while another boundary is open — this is what the loader's await rewriting
//     buys over the folding stack.
{
  const als = new AsyncLocalStorage<string>()
  const seen: (string | undefined)[] = []
  // Frame A pauses inside its boundary…
  let paused: ReturnType<typeof __snapshotAll> | undefined
  als.run('A', () => { paused = __snapshotAll() })
  // …an unrelated boundary opens and stays open…
  const other = als.run('B', async () => { await delay(20) })
  seen.push(als.getStore())
  // …and frame A resumes: the ambient slot answers A, not the open B.
  const release = __restoreAll(paused!)
  seen.push(als.getStore())
  release()
  seen.push(als.getStore())
  await other
  await delay()
  check('resume answers the paused context', seen, ['B', 'A', 'B'])
  check('all slots empty afterwards', als.getStore(), undefined)
}

// 18. Two frames pausing and resuming alternately keep their own contexts. A
//     disposer only ever undoes ITS OWN publish: released while shadowed it is a
//     no-op (never clobbers the newer frame), and released on top it restores the
//     context it shadowed — the frame that owned that context re-publishes at its
//     next await anyway, and any new boundary shadows it.
{
  const als = new AsyncLocalStorage<string>()
  const seen: string[] = []
  const pauseIn = (label: string): ReturnType<typeof __snapshotAll> => {
    let snapshot: ReturnType<typeof __snapshotAll> | undefined
    als.run(label, () => { snapshot = __snapshotAll() })
    return snapshot!
  }
  const first = pauseIn('one')
  const second = pauseIn('two')
  const releaseFirst = __restoreAll(first)
  seen.push(`first:${String(als.getStore())}`)
  const releaseSecond = __restoreAll(second)
  seen.push(`second:${String(als.getStore())}`)
  releaseFirst()   // out of order on purpose
  seen.push(`afterFirstRelease:${String(als.getStore())}`)
  releaseSecond()
  seen.push(`afterSecondRelease:${String(als.getStore())}`)
  check('interleaved resumes keep their own context', seen, [
    'first:one', 'second:two', 'afterFirstRelease:two', 'afterSecondRelease:one',
  ])
}

// 19. The ambient slot outranks the folding stack but not a hook overlay: the
//     documented slot order.
{
  const als = new AsyncLocalStorage<string>()
  const seen: (string | undefined)[] = []
  let paused: ReturnType<typeof __snapshotAll> | undefined
  als.run('ambient', () => { paused = __snapshotAll() })
  als.run('stack', () => {
    const release = __restoreAll(paused!)
    seen.push(als.getStore())
    release()
    seen.push(als.getStore())
  })
  check('ambient outranks the stack, stack returns after release', seen, ['ambient', 'stack'])
}

// 20. The rewriter's face (`AlsCausality`: snapshot + void restore) replaces the
//     resumed slot instead of stacking, so repeated resumes cannot leak context.
{
  const als = new AsyncLocalStorage<string>()
  const pauseIn = (label: string): ReturnType<typeof alsCausality.snapshot> => {
    let snapshot: ReturnType<typeof alsCausality.snapshot> | undefined
    als.run(label, () => { snapshot = alsCausality.snapshot() })
    return snapshot!
  }
  const one = pauseIn('one')
  const two = pauseIn('two')
  alsCausality.restore(one)
  check('void restore publishes the paused context', als.getStore(), 'one')
  alsCausality.restore(two)
  check('a later resume replaces it', als.getStore(), 'two')
  alsCausality.restore(one)
  check('resuming the first frame again republishes its own', als.getStore(), 'one')
  // A new boundary shadows the resumed slot, and the slot comes back after it.
  als.run('boundary', () => { check('boundary shadows the resumed slot', als.getStore(), 'boundary') })
  check('resumed slot returns after the boundary', als.getStore(), 'one')
  als.disable()
  check('disable clears the resumed slot', als.getStore(), undefined)
}

// 21. A rewritten frame's await round trip (pause → other work interleaves → resume)
//     is exactly what `AlsRuntime.pause/resume` does with this face.
{
  const als = new AsyncLocalStorage<string>()
  const seen: (string | undefined)[] = []
  const paused = await als.run('frame', async () => {
    const captured = alsCausality.snapshot()
    await delay(10)
    return captured
  })
  const other = als.run('interleaved', async () => { await delay(30) })
  seen.push(als.getStore())
  alsCausality.restore(paused)
  seen.push(als.getStore())
  await other
  await delay()
  check('resume wins over an interleaved boundary', seen, ['interleaved', 'frame'])
}
