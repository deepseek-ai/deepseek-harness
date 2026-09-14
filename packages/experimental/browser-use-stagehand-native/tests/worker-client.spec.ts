/** Real Workers pin explicit configuration, initialization, drainage, and termination. */

import { once } from 'node:events'
import { connect } from 'node:net'
import type { Worker } from 'node:worker_threads'
import { afterEach, expect, it, vi } from 'vitest'
import { openBrowserWorker } from '../src/worker-client.ts'
import type { NativeBrowserConfig, NativeBrowserRuntime } from '../src/native.ts'
import { nativeModel } from './fixtures/stagehand.ts'

const state = vi.hoisted(() => ({ workers: [] as Worker[], entries: [] as string[] }))
vi.mock('node:worker_threads', async (importActual) => {
  const actual = await importActual<typeof import('node:worker_threads')>()
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(entry: URL, options: import('node:worker_threads').WorkerOptions) {
        super(new URL('./fixtures/attachment-worker.mjs', import.meta.url), options)
        state.entries.push(entry.href)
        state.workers.push(this)
      }
    },
  }
})

const runtimes: NativeBrowserRuntime[] = []
const warn = vi.fn()
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close()))
  await Promise.all(state.workers.splice(0).map(worker => worker.terminate()))
  state.entries = []
  vi.unstubAllEnvs()
  warn.mockClear()
})

function config(scenario = 'ready'): NativeBrowserConfig {
  return { model: nativeModel, mode: 'attach', cdpEndpoint: `fixture://${scenario}`, headless: true, operationTimeoutMs: 30000, shutdownGraceMs: 1000 }
}

async function open(scenario = 'ready') {
  const runtime = await openBrowserWorker(config(scenario), new AbortController().signal, warn)
  runtimes.push(runtime)
  return runtime
}

function event(worker: Worker, name: string): Promise<void> {
  return new Promise((resolve) => {
    const receive = (value: { event?: string }) => {
      if (value.event !== name) return
      worker.off('message', receive)
      resolve()
    }
    worker.on('message', receive)
  })
}

it('passes explicit model credentials without ambient environment and awaits Worker listener release', async () => {
  vi.stubEnv('STAGEHAND_FIXTURE_TOKEN', 'ambient-secret')
  vi.stubEnv('HTTP_PROXY', 'https://ambient-proxy.example')
  const runtime = await open()
  const worker = state.workers[0]!
  expect(decodeURIComponent(state.entries[0]!)).toContain('tsx')
  const { port, model, env } = await runtime.execute('tabs', { action: 'list' }) as { port: number; model: unknown; env: Record<string, string> }
  expect(model).toEqual(nativeModel)
  expect(env.STAGEHAND_FIXTURE_TOKEN).toBeUndefined()
  expect(env.HTTP_PROXY).toBeUndefined()
  const socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  socket.destroy()
  const exited = once(worker, 'exit')
  await runtime.close()
  await exited
  expect(worker.threadId).toBe(-1)
  const disconnected = connect(port, '127.0.0.1')
  const [error] = await once(disconnected, 'error') as [Error]
  expect((error as NodeJS.ErrnoException).code).toBe('ECONNREFUSED')
})

it('preserves initialization failures while terminating the failed Worker', async () => {
  await expect(open('failure')).rejects.toThrow('Extension initialization failed')
  expect(state.workers[0]?.threadId).toBe(-1)
})

it('terminates a Worker whose initialization overlaps acquisition cancellation', async () => {
  const controller = new AbortController()
  const opening = openBrowserWorker(config('opening'), controller.signal, warn)
  const observed = expect(opening).rejects.toThrow('Acquisition canceled')
  await vi.waitFor(() => { expect(state.workers).toHaveLength(1) })
  controller.abort(new Error('Acquisition canceled'))
  await observed
  expect(state.workers[0]?.threadId).toBe(-1)
})

it('fails active and later operations when the Worker exits', async () => {
  const runtime = await open('crash')
  const exited = once(state.workers[0]!, 'exit')
  await expect(runtime.execute('tabs', { action: 'list' })).rejects.toThrow(/Worker (exited|reply channel closed)/u)
  await exited
  await expect(runtime.execute('tabs', { action: 'list' })).rejects.toThrow('Worker exited (23)')
  await expect(runtime.close()).rejects.toThrow('Worker exited (23)')
})

it.each(['closing', 'close-failure'])('rejects cleanup after an undrained extension (%s) even though its Worker terminates', async (scenario) => {
  const runtime = await openBrowserWorker({ ...config(scenario), shutdownGraceMs: 20 }, new AbortController().signal, warn)
  runtimes.push(runtime)
  const closing = runtime.close()
  const rejected = expect(closing).rejects.toThrow(/cleanup timed out|did not drain/u)
  await expect(runtime.execute('tabs', { action: 'list' })).rejects.toThrow('Worker is closed')
  await rejected
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('SDK cleanup did not finish'))
  expect(state.workers[0]?.threadId).toBe(-1)
  await expect(runtime.close()).rejects.toThrow()
})

it('rejects cleanup after a Worker crashes', async () => {
  const runtime = await open('error')
  await expect(runtime.execute('tabs', { action: 'list' })).rejects.toThrow()
  await expect(runtime.close()).rejects.toThrow()
  expect(state.workers[0]?.threadId).toBe(-1)
})

it('preserves the explicit source tsconfig for its Worker', async () => {
  vi.stubEnv('TSX_TSCONFIG_PATH', '/fixture/tsconfig.json')
  const runtime = await open()
  expect(await runtime.execute('tabs', { action: 'list' })).toMatchObject({ env: { TSX_TSCONFIG_PATH: '/fixture/tsconfig.json' } })
})

it('waits for the active extension request to drain after cancellation', async () => {
  const runtime = await open()
  const worker = state.workers[0]!
  const entered = event(worker, 'operation-started')
  const closing = event(worker, 'close-started')
  const controller = new AbortController()
  const operation = runtime.execute('act', { instruction: 'Read the page' }, controller.signal)
  const canceled = expect(operation).rejects.toThrow('Cancel browser call')
  await entered
  controller.abort(new Error('Cancel browser call'))
  await closing
  let closed = false
  const drainage = runtime.close().then(() => { closed = true })
  try {
    expect(closed).toBe(false)
    expect(worker.threadId).not.toBe(-1)
  } finally {
    worker.postMessage({ method: 'fixture-release' })
    await canceled
    await drainage
  }
  expect(worker.threadId).toBe(-1)
})

it('reports failed Worker termination during canceled request cleanup', async () => {
  const runtime = await open()
  const worker = state.workers[0]!
  const terminate = worker.terminate.bind(worker)
  const refused = vi.spyOn(worker, 'terminate').mockRejectedValueOnce(new Error('Worker shutdown refused'))
  const entered = event(worker, 'operation-started')
  const controller = new AbortController()
  const operation = runtime.execute('act', {}, controller.signal)
  const canceled = expect(operation).rejects.toThrow('Cancel active call')
  try {
    await entered
    controller.abort(new Error('Cancel active call'))
    worker.postMessage({ method: 'fixture-release' })
    await canceled
    await expect(runtime.close()).rejects.toThrow('Worker shutdown refused')
  } finally {
    refused.mockRestore()
    await terminate()
  }
})
