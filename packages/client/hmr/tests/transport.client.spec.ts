/** The Web transport follows the plugin-events Remote stream into the page's entry controller. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import type { PluginsEventFrame } from '../src/types.ts'

afterEach(() => { vi.restoreAllMocks() })

async function collect(items: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const item of items) out.push(item)
  return out
}

/** A pushable stand-in for one logical Remote stream: items carry a generation number and an accept callback. */
function fakeStream() {
  const queue: { generation: number; value: PluginsEventFrame }[] = []
  let wake: (() => void) | undefined
  let ended = false
  const disposed = vi.fn()
  const stream = {
    async *[Symbol.asyncIterator]() {
      while (!ended) {
        const item = queue.shift()
        if (item === undefined) {
          await new Promise<void>((resolve) => { wake = resolve })
          continue
        }
        yield { ...item, signal: new AbortController().signal, accept: () => {} }
      }
    },
    restart: () => {},
    dispose: async () => { disposed(); ended = true; wake?.() },
  }
  return {
    stream,
    disposed,
    push(generation: number, value: PluginsEventFrame) { queue.push({ generation, value }); wake?.() },
  }
}

function harness() {
  const ctx = new Context()
  const sync = vi.fn(async (_graph: unknown) => {})
  const reload = vi.fn(async (_id: string, _rev: string) => {})
  ctx.provide('modules', { entries: { sync, reload } } as never)
  const stream = fakeStream()
  const unmount = vi.fn(async () => {})
  const opened: { name: string; open: (signal: AbortSignal) => AsyncIterable<unknown>; ended: () => Error & { code?: string } }[] = []
  const follow = vi.fn(async function *(_signal: AbortSignal): AsyncIterable<unknown> { yield 'frame' })
  const pluginEvents = { follow }
  ctx.provide('remote', {
    $mount: vi.fn(async () => unmount),
    $stream: (streamOptions: (typeof opened)[number]) => { opened.push(streamOptions); return stream.stream },
    pluginEvents,
  } as never)
  const revoke: (() => unknown)[] = []
  ctx.provide('remoteAccess', {
    whenAccess: (_action: string, callback: () => () => unknown) => { revoke.push(callback()); return () => {} },
  } as never)
  // `$mount` provides the generated namespace as its own service under `remote.pluginEvents`.
  const provideNamespace = (): void => { ctx.provide('remote.pluginEvents', pluginEvents as never) }
  return { ctx, sync, reload, stream, unmount, opened, follow, revoke, provideNamespace }
}

const baseline: PluginsEventFrame = { type: 'baseline', graph: { rev: 'g1', entries: [], batches: [] } }

it('forwards the baseline and increments to the entry controller while access allows the stream, and unmounts its namespace', async () => {
  const h = harness()
  h.provideNamespace()
  const fiber = h.ctx.plugin({ apply, inject })
  await fiber.await()
  const options = h.opened[0]!
  expect(options.name).toBe('Plugin events')
  const signal = new AbortController().signal
  expect(await collect(options.open(signal))).toEqual(['frame'])
  expect(h.follow).toHaveBeenCalledWith(signal)
  // An endpoint the Host withdrew while reloading reconnects; any other failure stays as it is.
  for (const code of ['gateway/invocation-unavailable', 'gateway/service-unavailable']) {
    h.follow.mockImplementationOnce(() => { throw Object.assign(new Error('withdrawn'), { code }) })
    await expect(collect(options.open(signal))).rejects.toMatchObject({ code: 'gateway/carrier-lost' })
  }
  const denied = Object.assign(new Error('denied'), { code: 'gateway/forbidden' })
  h.follow.mockImplementationOnce(() => { throw denied })
  await expect(collect(options.open(signal))).rejects.toBe(denied)
  const plain = new Error('plain')
  h.follow.mockImplementationOnce(() => { throw plain })
  await expect(collect(options.open(signal))).rejects.toBe(plain)
  // A normal generation end reconnects rather than ending the logical stream.
  expect(options.ended().code).toBe('gateway/carrier-lost')
  h.stream.push(1, baseline)
  h.stream.push(1, { type: 'graph', graph: { rev: 'g2', entries: [], batches: [] } })
  h.stream.push(1, { type: 'rebuilt', id: 'a', rev: 'r2' })
  await vi.waitFor(() => { expect(h.reload).toHaveBeenCalledWith('a', 'r2') })
  expect(h.sync.mock.calls.map(([graph]) => (graph as { rev: string }).rev)).toEqual(['g1', 'g2'])
  await h.revoke[0]!()
  expect(h.stream.disposed).toHaveBeenCalledOnce()
  await fiber.dispose()
  expect(h.unmount).toHaveBeenCalledOnce()
  await h.ctx.fiber.dispose()
})

it('reports controller failures, including a synchronous parse failure, and ignores unknown increments', async () => {
  const h = harness()
  const errors = vi.spyOn(h.ctx.logger, 'error').mockImplementation(() => {})
  h.sync.mockImplementationOnce(() => { throw new Error('bad graph') })
  h.reload.mockRejectedValueOnce(new Error('bad reload'))
  h.provideNamespace()
  const fiber = h.ctx.plugin({ apply, inject })
  await fiber.await()
  h.stream.push(1, baseline)
  h.stream.push(1, { type: 'future' } as never)
  h.stream.push(1, { type: 'rebuilt', id: 'a', rev: 'r2' })
  await vi.waitFor(() => { expect(errors).toHaveBeenCalledTimes(2) })
  expect(errors.mock.calls.map(([error]) => (error as Error).message)).toEqual(['bad graph', 'bad reload'])
  await fiber.dispose()
  await h.ctx.fiber.dispose()
})

it('fails loudly when the mounted namespace service is missing', async () => {
  const h = harness()
  const errors = vi.spyOn(h.ctx.logger, 'error').mockImplementation(() => {})
  const fiber = h.ctx.plugin({ apply, inject })
  await expect(fiber.await()).rejects.toThrow('the mounted pluginEvents namespace is not registered')
  errors.mockRestore()
  await h.ctx.fiber.dispose()
})

it('logs a terminal stream failure', async () => {
  const h = harness()
  h.provideNamespace()
  const errors = vi.spyOn(h.ctx.logger, 'error').mockImplementation(() => {})
  const fiber = h.ctx.plugin({ apply, inject })
  await fiber.await()
  h.stream.push(1, { type: 'graph', graph: { rev: 'g', entries: [], batches: [] } })
  await vi.waitFor(() => { expect(errors).toHaveBeenCalledOnce() })
  expect(errors.mock.calls[0]![0]).toContain('plugin events stopped')
  await fiber.dispose()
  await h.ctx.fiber.dispose()
})
