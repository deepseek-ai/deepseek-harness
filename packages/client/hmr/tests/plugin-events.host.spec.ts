/** The plugin-events Remote stream opens each generation with a complete baseline and then forwards ordered increments. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import type { ClientModuleRegistry, WebBootGraph } from '@deepseek-ai/dsh-client-modules'
import { PluginEvents } from '../src/plugin-events.ts'
import type { PluginsEventFrame } from '../src/types.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

function graph(rev: string, config = 'configured'): WebBootGraph {
  return { rev, entries: [{ id: 'a', url: 'a.js', rev, config: { value: config } }], batches: [] }
}

/** Structural fake: the service reads only these members. */
async function harness() {
  const ctx = new Context()
  roots.push(ctx)
  let current = graph('g1')
  const graphListeners = new Set<() => void>()
  const rebuiltListeners = new Set<(id: string, rev: string) => void>()
  const modules: Pick<ClientModuleRegistry, 'graph' | 'graphFor' | 'onGraphChanged' | 'onRebuilt'> = {
    graph: () => current,
    graphFor: principal => principal === undefined ? current : graph(current.rev, 'default'),
    onGraphChanged: (listener) => { graphListeners.add(listener); return () => { graphListeners.delete(listener) } },
    onRebuilt: (listener) => { rebuiltListeners.add(listener); return () => { rebuiltListeners.delete(listener) } },
  }
  ctx.provide('clientModules', modules as ClientModuleRegistry)
  const fiber = ctx.plugin(PluginEvents)
  await fiber.await()
  // No Context merge is declared for the service; its Remote namespace is the public face.
  const service = ctx.get('pluginEvents') as PluginEvents
  return {
    fiber,
    follow: (signal: AbortSignal) => service.follow(signal)[Symbol.asyncIterator](),
    /** Follow as the Remote call of one non-owner Peer. */
    followAs: (kind: string, signal: AbortSignal) => {
      const invocation = { peer: { principal: { kind } } }
      return (ctx.extend({ invocation }).get('pluginEvents') as PluginEvents).follow(signal)[Symbol.asyncIterator]()
    },
    setGraph(next: WebBootGraph) { current = next; for (const listener of graphListeners) listener() },
    rebuilt(id: string, rev: string) { for (const listener of rebuiltListeners) listener(id, rev) },
    listeners: () => graphListeners.size + rebuiltListeners.size,
  }
}

async function take(iterator: AsyncIterator<PluginsEventFrame>, count: number): Promise<PluginsEventFrame[]> {
  const frames: PluginsEventFrame[] = []
  for (let index = 0; index < count; index++) {
    const next = await iterator.next()
    if (next.done === true) break
    frames.push(next.value)
  }
  return frames
}

it('sends a baseline, then graph and rebuilt increments in order', async () => {
  const h = await harness()
  const controller = new AbortController()
  const iterator = h.follow(controller.signal)
  expect(await take(iterator, 1)).toEqual([{ type: 'baseline', graph: graph('g1') }])
  h.setGraph(graph('g2'))
  h.rebuilt('a', 'r2')
  expect(await take(iterator, 2)).toEqual([
    { type: 'graph', graph: graph('g2') },
    { type: 'rebuilt', id: 'a', rev: 'r2' },
  ])
  controller.abort()
  expect(await iterator.next()).toEqual({ done: true, value: undefined })
})

it('ends open streams and releases its listeners when unloaded', async () => {
  const h = await harness()
  const iterator = h.follow(new AbortController().signal)
  await take(iterator, 1)
  const pending = iterator.next()
  await h.fiber.dispose()
  expect(await pending).toEqual({ done: true, value: undefined })
  expect(h.listeners()).toBe(0)
})

it('rejects a follow whose signal is already aborted', async () => {
  const h = await harness()
  const controller = new AbortController()
  controller.abort()
  await expect(h.follow(controller.signal).next()).rejects.toThrow()
})

it('sends a non-owner Peer the graph with schema defaults while the owner receives configured values', async () => {
  const h = await harness()
  const controller = new AbortController()
  const owner = h.follow(controller.signal)
  const viewer = h.followAs('viewer', controller.signal)
  expect(await take(owner, 1)).toEqual([{ type: 'baseline', graph: graph('g1') }])
  expect(await take(viewer, 1)).toEqual([{ type: 'baseline', graph: graph('g1', 'default') }])
  h.setGraph(graph('g2'))
  h.rebuilt('a', 'r2')
  expect(await take(owner, 2)).toEqual([{ type: 'graph', graph: graph('g2') }, { type: 'rebuilt', id: 'a', rev: 'r2' }])
  expect(await take(viewer, 2)).toEqual([{ type: 'graph', graph: graph('g2', 'default') }, { type: 'rebuilt', id: 'a', rev: 'r2' }])
  controller.abort()
})
