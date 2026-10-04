/** Context and Fiber identities collected from live Cordis plugins. */

import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import { assert, describe, expect, it, type TestContext } from 'vitest'
import { CordisTreeCollector } from '../src/shared/cordis/collector.ts'
import type { CordisTreeNode } from '../src/shared/cordis/snapshot.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    collectorSpawner: CollectorSpawner
  }
}

const SHADOW = Symbol.for('cordis.shadow')

function childPlugin(): void {}

class CollectorSpawner extends Service {
  constructor(ctx: Context) {
    super(ctx, 'collectorSpawner')
  }

  spawn(): Fiber & PromiseLike<Fiber> {
    return this.ctx.plugin(childPlugin)
  }
}

function setup(test: TestContext): { root: Context; collector: CordisTreeCollector } {
  const root = new Context()
  test.onTestFinished(async () => { await root.fiber.dispose() })
  const collector = new CordisTreeCollector(root, { maxNodes: 100, maxBytes: 100_000 })
  test.onTestFinished(() => { collector.close() })
  return { root, collector }
}

function* walk(node: CordisTreeNode): Generator<CordisTreeNode> {
  yield node
  for (const child of node.children) yield* walk(child)
}

describe('Cordis collector live object identities', () => {
  it('retains a service-created Fiber with its canonical Context', async (test) => {
    const { root, collector } = setup(test)
    const provider = await root.plugin(CollectorSpawner)
    let spawned: Fiber | undefined
    const consumer = await root.plugin({
      name: 'collector-consumer',
      inject: ['collectorSpawner'],
      apply(ctx: Context) {
        spawned = ctx.collectorSpawner.spawn()
      },
    })
    assert(spawned, 'Service consumer did not create a Fiber')
    const fiber = await spawned.await()
    const canonical: unknown = Object.getPrototypeOf(fiber.ctx)
    assert(Context.is(canonical))
    expect(Object.hasOwn(fiber.ctx, SHADOW)).toBe(true)
    expect(Object.hasOwn(fiber.ctx, 'fiber')).toBe(false)
    expect(Object.hasOwn(canonical, 'fiber')).toBe(true)
    expect(canonical.fiber).toBe(fiber)
    expect(Object.getPrototypeOf(canonical)).toBe(consumer.ctx)
    expect(Object.getPrototypeOf(fiber.parent)).toBe(consumer.ctx)
    expect(Reflect.get(fiber.parent, SHADOW)).toBe(provider.ctx)

    const snapshot = collector.snapshot()
    expect(snapshot.truncated).toBe(false)
    const nodes = [...walk(snapshot.root)]
    const fibers = nodes.filter(node => node.kind === 'fiber')
    const owned = fibers.find(node => node.uid === fiber.uid)
    assert(owned, 'Fiber missing from collector snapshot')
    // The repository test setup also mounts an invariant-service Fiber at the root.
    for (const expected of [provider, consumer, fiber]) {
      expect(fibers.filter(node => collector.objects.resolve(node.objectHandle) === expected)).toHaveLength(1)
    }
    expect(collector.objects.resolve(owned.objectHandle)).toBe(fiber)
    const reference = { registryId: snapshot.objectRegistryId, handle: owned.objectHandle }
    expect(collector.objects.identify(fiber)).toEqual(reference)
    expect(collector.objects.identify(spawned)).toEqual(reference)
    const context = owned.children[0]
    expect(collector.objects.resolve(context.objectHandle)).toBe(canonical)
    expect(collector.objects.identify(canonical)).toEqual({
      registryId: snapshot.objectRegistryId,
      handle: context.objectHandle,
    })
    const retained = nodes.map(node => collector.objects.resolve(node.objectHandle))
    expect(new Set(retained).size).toBe(nodes.length)
  })

  it('keeps ordinary and inherited-fiber Contexts distinct without duplicating their Fiber', async (test) => {
    const { root, collector } = setup(test)
    const extended = root.extend()
    const isolated = extended.isolate('collector-value')
    const intercepted = isolated.intercept('collector-value', { enabled: true })
    const fiber = await intercepted.plugin(childPlugin)
    const derived = fiber.ctx.extend()
    derived.on('internal/status', () => {})

    expect(fiber.parent).toBe(intercepted)
    expect(Object.getPrototypeOf(fiber.ctx)).toBe(intercepted)
    for (const ctx of [extended, isolated, intercepted, derived]) {
      expect(Object.hasOwn(ctx, 'fiber')).toBe(false)
    }
    expect(derived.fiber).toBe(fiber)
    const snapshot = collector.snapshot()
    expect(snapshot.truncated).toBe(false)
    const subtree = [...walk(snapshot.root)].find(node =>
      node.kind === 'context' && collector.objects.resolve(node.objectHandle) === extended)
    assert(subtree)
    const nodes = [...walk(subtree)]
    expect(nodes.filter(node => node.kind === 'fiber')).toHaveLength(1)
    expect(nodes.map(node => collector.objects.resolve(node.objectHandle))).toEqual([
      extended, isolated, intercepted, fiber, fiber.ctx, derived,
    ])
    const reference = collector.objects.identify(fiber)
    assert(reference)

    await fiber.dispose()
    collector.snapshot()
    for (const node of nodes) expect(collector.objects.resolve(node.objectHandle)).toBeUndefined()
    expect(collector.objects.resolve(reference.handle)).toBeUndefined()
  })
})
