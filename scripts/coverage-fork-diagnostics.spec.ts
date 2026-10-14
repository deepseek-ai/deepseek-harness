import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runGate } from './run-gates.ts'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { ForksPoolWorker } from 'vitest/node'
import type { PoolOptions, PoolWorker, TestProject, WorkerRequest, WorkerResponse } from 'vitest/node'
import { coverageForkPool } from './coverage-fork-diagnostics.ts'

const roots: string[] = []
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  const cleanup = cleanups.splice(0)
  const directories = roots.splice(0)
  const results = await Promise.allSettled(cleanup.map(dispose => dispose()))
  vi.restoreAllMocks()
  for (const directory of directories) await rm(directory, { recursive: true, force: true })
  const errors: unknown[] = []
  for (const result of results) {
    if (result.status === 'rejected') errors.push(result.reason)
  }
  if (errors.length > 0) throw new AggregateError(errors, 'fork fixture cleanup failed')
})

async function fixture(exitCode: number, early = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-coverage-fork-'))
  roots.push(root)
  await mkdir(join(root, 'workers'))
  // The public pool's distPath selects a plain Node protocol fixture, not a nested Vitest run.
  await writeFile(join(root, 'workers/forks.js'), early ? `process.exit(${exitCode})\n` : `
process.on('message', (message) => {
  if (message.type === 'run' || message.type === 'collect') process.send({ kind: 'ready', pid: process.pid })
  if (message.type === 'cancel') process.exit(${exitCode})
  if (message.type === 'stop') process.exit(0)
})
`)
  return root
}

function poolOptions(root: string) {
  const outputStream = new PassThrough()
  const errorStream = new PassThrough()
  const error = vi.fn<(message: string) => void>()
  // ForksPoolWorker needs only the logger and project name from the Vitest project.
  const logger: Pick<TestProject['vitest']['logger'], 'outputStream' | 'errorStream' | 'error'> = {
    outputStream, errorStream, error,
  }
  const project = { name: 'fixture', vitest: { logger } } as TestProject
  const options: PoolOptions = {
    distPath: root, project, method: 'run', environment: { name: 'node', options: null },
    execArgv: [], env: {},
  }
  return { options, error, outputStream, errorStream }
}

/** Observers a pool registers on its worker, once `stubPool` has started it. */
interface WorkerObservers {
  off: MockInstance
  exit?: (code: number | null, signal?: NodeJS.Signals | null) => void
  error?: () => void
}

/**
 * Start a pool whose worker prototypes are stubs, and capture the observers it registers.
 * The test's cleanups own the pool and its streams.
 */
async function stubPool(): Promise<{
  pool: PoolWorker
  error: MockInstance<(message: string) => void>
  observers: WorkerObservers
}> {
  const observers: WorkerObservers = {
    off: vi.spyOn(ForksPoolWorker.prototype, 'off').mockImplementation(() => undefined),
  }
  vi.spyOn(ForksPoolWorker.prototype, 'start').mockResolvedValue(undefined)
  vi.spyOn(ForksPoolWorker.prototype, 'stop').mockResolvedValue(undefined)
  vi.spyOn(ForksPoolWorker.prototype, 'send').mockImplementation(() => undefined)
  vi.spyOn(ForksPoolWorker.prototype, 'on').mockImplementation((event, callback) => {
    if (event === 'exit') observers.exit = callback
    if (event === 'error') observers.error = callback as () => void
  })
  const { options, error, outputStream, errorStream } = poolOptions('/unused')
  const pool = coverageForkPool.createPoolWorker(options)
  cleanups.push(async () => {
    await pool.stop()
    outputStream.destroy()
    errorStream.destroy()
  })
  await pool.start()
  return { pool, error, observers }
}

async function start(root: string, diagnostic = true) {
  const { options, error, outputStream, errorStream } = poolOptions(root)
  const pool: PoolWorker = diagnostic ? coverageForkPool.createPoolWorker(options) : new ForksPoolWorker(options)
  let started = false
  const closed = Promise.withResolvers<undefined>()
  cleanups.push(async () => {
    if (started) {
      await pool.stop()
      await closed.promise
    }
    outputStream.destroy()
    errorStream.destroy()
  })
  await pool.start()
  started = true
  pool.on('close', () => { closed.resolve(undefined) })
  const exited = new Promise<number | null>((resolve) => { pool.on('exit', resolve) })
  const ready = new Promise<number>((resolve) => {
    pool.on('message', (message: unknown) => {
      const response = message as { kind: string; pid: number }
      if (response.kind === 'ready') resolve(response.pid)
    })
  })
  return { pool, ready, exited, error }
}

function request(filepath: string, workerId: number): Extract<WorkerRequest, { type: 'run' }> {
  return {
    __vitest_worker_request__: true, type: 'run',
    context: { files: [{ filepath }], workerId, providedContext: {}, environment: { name: 'node', options: null } },
  }
}

const cancel: WorkerRequest = { __vitest_worker_request__: true, type: 'cancel' }
const stop: WorkerRequest = { __vitest_worker_request__: true, type: 'stop' }

async function configuredPool(pool: 'stock' | 'diagnostic', outcome: 'exit' | 'pass', signal: AbortSignal) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'dsh-configured-fork-cache-'))
  roots.push(cacheDir)
  const controller = new AbortController()
  const result = runGate({
    id: `fork-${pool}`, label: 'fork fixture', displayCommand: 'Vitest pool fixture',
    command: process.execPath,
    args: [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', 'scripts/fixtures/coverage-fork.config.ts'],
    env: { DSH_TEST_FORK_POOL: pool, DSH_TEST_FORK_OUTCOME: outcome, DSH_TEST_FORK_CACHE: cacheDir },
  }, AbortSignal.any([signal, controller.signal]))
  let settled = false
  cleanups.push(async () => {
    if (!settled) controller.abort()
    await result
  })
  try {
    return await result
  } finally {
    settled = true
  }
}

/**
 * Vitest reports one unexpected worker exit either as the clean exit path or, when
 * the worker's channel closes under a send, as a runner-level worker error.
 */
function workerExitReport(output: string, pool: string): string | undefined {
  return ['Worker exited unexpectedly', `Worker ${pool} emitted error`].find(message => output.includes(message))
}

describe('coverage fork configuration entry', () => {
  it('preserves the real Vitest failure and adds metadata before its error report', async ({ signal }) => {
    const [stock, diagnostic] = await Promise.all([
      configuredPool('stock', 'exit', signal),
      configuredPool('diagnostic', 'exit', signal),
    ])
    const stockOutput = stock.output.map(chunk => chunk.text).join('')
    const output = diagnostic.output.map(chunk => chunk.text).join('')
    for (const [pool, result, text] of [
      ['forks', stock, stockOutput],
      ['coverage-forks', diagnostic, output],
    ] as const) {
      expect(result.aborted).not.toBe(true)
      expect(result.error).toBeUndefined()
      expect(result.signalCode).toBeNull()
      expect(result.exitCode).toBe(1)
      expect(workerExitReport(text, pool)).toBeDefined()
    }
    expect(stockOutput).not.toContain('coverage-worker-exit:')
    const encoded = /coverage-worker-exit: (\{[^\r\n]*\})/u.exec(output)?.[1]
    expect(encoded).toBeDefined()
    const record = JSON.parse(encoded!) as {
      pid: number
      project: string
      workerId: number
      files: string[]
      exitCode: number
      signalCode: null
    }
    const pid = Number(/coverage-fixture-pid: (\d+)/u.exec(output)?.[1])
    const anyNumber: unknown = expect.any(Number)
    const anyString: unknown = expect.any(String)
    expect(record).toEqual({
      pid, project: 'configured-fork', workerId: anyNumber,
      files: [anyString], exitCode: 23, signalCode: null,
    })
    expect(record.files.map(file => file.replaceAll('\\', '/')))
      .toEqual([resolve('scripts/fixtures/coverage-fork.fixture.ts').replaceAll('\\', '/')])
    expect(output.indexOf('coverage-worker-exit:'))
      .toBeLessThan(output.indexOf(workerExitReport(output, 'coverage-forks')!))
  })

  it('keeps a successful configured run silent and successful', async ({ signal }) => {
    const result = await configuredPool('diagnostic', 'pass', signal)
    expect(result.aborted).not.toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.signalCode).toBeNull()
    expect(result.exitCode).toBe(0)
    expect(result.output.map(chunk => chunk.text).join('')).not.toContain('coverage-worker-exit:')
  })
})

describe('coverage fork exit callback', () => {
  it.each([
    ['native receiver', { pid: 41 }, 41],
    ['unavailable receiver', undefined, null],
  ] as const)('retains a signal with %s and silences expected shutdown', async (_name, receiver, pid) => {
    const { pool, error, observers } = await stubPool()
    pool.send(request('/signal.spec.ts', 9))
    const exit = observers.exit
    if (exit === undefined) throw new Error('exit observer was not registered')
    Reflect.apply(exit, receiver, [null, 'SIGTERM'])
    expect(error).toHaveBeenCalledWith(`coverage-worker-exit: ${JSON.stringify({
      pid, project: 'fixture', workerId: 9, files: ['/signal.spec.ts'], exitCode: null, signalCode: 'SIGTERM',
    })}`)
    error.mockClear()
    pool.send(stop)
    expect(() => { Reflect.apply(exit, undefined, [null, 'SIGTERM']) }).not.toThrow()
    expect(error).not.toHaveBeenCalled()
  })

  it('reports an exit whose worker errored even when a teardown raced it', async () => {
    const { pool, error, observers } = await stubPool()
    pool.send(request('/raced.spec.ts', 11))
    const failed = observers.error
    if (failed === undefined) throw new Error('error observer was not registered')
    // Node reports the failed reply before it reports the exit of the same child.
    failed()
    await pool.stop()
    expect(observers.off).not.toHaveBeenCalled()
    const exit = observers.exit
    if (exit === undefined) throw new Error('exit observer was not registered')
    Reflect.apply(exit, { pid: 42 }, [23, null])
    expect(error).toHaveBeenCalledWith(`coverage-worker-exit: ${JSON.stringify({
      pid: 42, project: 'fixture', workerId: 11, files: ['/raced.spec.ts'], exitCode: 23, signalCode: null,
    })}`)
  })
})

describe('coverage fork exit diagnostics', () => {
  it('attributes a later collect request instead of an earlier run request', async () => {
    const instance = await start(await fixture(23))
    instance.pool.send(request('/earlier.spec.ts', 4))
    const pid = await instance.ready
    instance.pool.send({ ...request('/collected.spec.ts', 5), type: 'collect' })
    const unrelated = { type: 'testfileFinished' }
    expect(instance.pool.deserialize(unrelated)).toBe(unrelated)
    expect(instance.pool.deserialize(null)).toBeNull()
    instance.pool.send(cancel)
    expect(await instance.exited).toBe(23)
    expect(instance.error).toHaveBeenCalledWith(`coverage-worker-exit: ${JSON.stringify({
      pid, project: 'fixture', workerId: 5, files: ['/collected.spec.ts'], exitCode: 23, signalCode: null,
    })}`)
  })

  it('does not attribute a post-completion exit to a finished file', async () => {
    const instance = await start(await fixture(23))
    instance.pool.send(request('/finished.spec.ts', 6))
    const pid = await instance.ready
    const finished = {
      __vitest_worker_response__: true, type: 'testfileFinished',
    } satisfies Extract<WorkerResponse, { type: 'testfileFinished' }>
    expect(instance.pool.deserialize(finished)).toBe(finished)
    instance.pool.send(cancel)
    expect(await instance.exited).toBe(23)
    expect(instance.error).toHaveBeenCalledWith(`coverage-worker-exit: ${JSON.stringify({
      pid, project: 'fixture', workerId: null, files: [], exitCode: 23, signalCode: null,
    })}`)
  })

  it('records the exact owner while an independent ready fork remains alive', async () => {
    const root = await fixture(23)
    const [first, second] = await Promise.all([start(root), start(root)])
    first.pool.send(request('/first.spec.ts', 1))
    second.pool.send(request('/second.spec.ts', 2))
    const [firstPid, secondPid] = await Promise.all([first.ready, second.ready])
    expect(firstPid).not.toBe(secondPid)
    first.pool.send(cancel)
    expect(await first.exited).toBe(23)
    expect(first.error.mock.calls).toEqual([[`coverage-worker-exit: ${JSON.stringify({
      pid: firstPid, project: 'fixture', workerId: 1, files: ['/first.spec.ts'], exitCode: 23, signalCode: null,
    })}`]])
    expect(second.error).not.toHaveBeenCalled()
    expect(() => process.kill(secondPid, 0)).not.toThrow()
    second.pool.send(stop)
    expect(await second.exited).toBe(0)
    expect(second.error).not.toHaveBeenCalled()
  })

  it('retains an unexpected zero exit instead of interpreting it as suite success', async () => {
    const instance = await start(await fixture(0))
    instance.pool.send(request('/unfinished.spec.ts', 3))
    const pid = await instance.ready
    instance.pool.send(cancel)
    expect(await instance.exited).toBe(0)
    expect(instance.error).toHaveBeenCalledWith(`coverage-worker-exit: ${JSON.stringify({
      pid, project: 'fixture', workerId: 3, files: ['/unfinished.spec.ts'], exitCode: 0, signalCode: null,
    })}`)
  })

  it('records an exit before any file request without inventing a file owner', async () => {
    const instance = await start(await fixture(31, true))
    expect(await instance.exited).toBe(31)
    expect(instance.error).toHaveBeenCalledOnce()
    const record = JSON.parse(instance.error.mock.calls[0]![0].slice('coverage-worker-exit: '.length)) as Record<string, unknown>
    const anyNumber: unknown = expect.any(Number)
    expect(record).toEqual({
      pid: anyNumber, project: 'fixture', workerId: null, files: [], exitCode: 31, signalCode: null,
    })
  })

  it('observes the same child failure without diagnostics under the stock pool negative control', async () => {
    const instance = await start(await fixture(23), false)
    instance.pool.send(request('/stock.spec.ts', 4))
    await instance.ready
    instance.pool.send(cancel)
    expect(await instance.exited).toBe(23)
    expect(instance.error).not.toHaveBeenCalled()
  })
})
