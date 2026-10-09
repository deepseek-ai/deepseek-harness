import { afterEach, describe, expect, it, vi } from 'vitest'
import { setImmediate } from 'node:timers/promises'
import { verifyCurrentGenerationInWorker } from '../src/migration-verifier.ts'

const state = vi.hoisted(() => ({ workers: [] as unknown[] }))

vi.mock('node:worker_threads', () => ({
  Worker: class {
    readonly listeners = new Map<string, (value: never) => void>()
    readonly terminate = vi.fn<() => Promise<number>>(() => Promise.resolve(0))

    constructor(readonly entry: string | URL, readonly options: unknown) {
      state.workers.push(this)
    }

    once(event: string, listener: (value: never) => void): this {
      this.listeners.set(event, listener)
      return this
    }

    emit(event: string, value: unknown): void {
      this.listeners.get(event)?.(value as never)
    }
  },
}))

interface FakeWorker {
  readonly entry: string | URL
  readonly options: { readonly workerData: unknown }
  readonly terminate: ReturnType<typeof vi.fn<() => Promise<number>>>
  emit(event: string, value: unknown): void
}

function worker(index = 0): FakeWorker {
  const candidate = state.workers[index]
  if (candidate === undefined) throw new Error('verification did not create a Worker')
  return candidate as FakeWorker
}

const result = {
  identity: { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n, ctimeNs: 5n },
  bytes: 3,
  digest: 'digest',
}

afterEach(() => {
  state.workers.length = 0
})

describe('migration verifier Worker lifecycle', () => {
  it('retains a valid response until natural exit without terminating the Worker', async () => {
    const expectedPrefix = { bytes: 3, digest: 'a'.repeat(64) }
    const verification = verifyCurrentGenerationInWorker('/stage', 'none', 'session', 2, expectedPrefix)
    const instance = worker()
    expect(instance.options.workerData).toEqual({
      path: '/stage', compression: 'none', expectedId: 'session', expectedEventCount: 2,
      expectedPrefix,
    })
    instance.emit('message', { ok: true, result })
    try {
      expect(instance.terminate).not.toHaveBeenCalled()
      let settled = false
      void verification.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
    } finally {
      instance.emit('exit', 0)
      await verification
    }
    await expect(verification).resolves.toEqual(result)
  })

  it('rejects a nonzero exit after a valid response', async () => {
    const code = 7
    const verification = verifyCurrentGenerationInWorker('/stage', 'none', 'session', 0)
    const instance = worker()
    instance.emit('message', { ok: true, result })
    instance.emit('exit', code)
    await expect(verification).rejects.toThrow(`code ${code}`)
    expect(instance.terminate).not.toHaveBeenCalled()
  })

  it('retains a Worker error after a valid response', async () => {
    const verification = verifyCurrentGenerationInWorker('/stage', 'none', 'session', 0)
    const failure = new Error('worker cleanup failed')
    worker().emit('message', { ok: true, result })
    worker().emit('error', failure)
    await expect(verification).rejects.toBe(failure)
    expect(worker().terminate).toHaveBeenCalledOnce()
  })

  it('honors cancellation after a valid response and joins termination', async () => {
    const controller = new AbortController()
    const verification = verifyCurrentGenerationInWorker('/stage', 'none', 'session', 0, undefined, controller.signal)
    const instance = worker()
    const termination = Promise.withResolvers<number>()
    instance.terminate.mockReturnValueOnce(termination.promise)
    const observed = verification.catch((error: unknown) => error)
    const reason = new Error('cancelled while Worker closes')
    try {
      instance.emit('message', { ok: true, result })
      controller.abort(reason)
      expect(instance.terminate).toHaveBeenCalledOnce()
      let settled = false
      void observed.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
    } finally {
      termination.resolve(1)
    }
    await expect(observed).resolves.toBe(reason)
  })

  it('reconstructs a Worker-reported error', async () => {
    const verification = verifyCurrentGenerationInWorker('/stage', 'zstd', 'session', 0)
    worker().emit('message', { ok: false, message: 'invalid stage', stack: 'worker stack' })

    await expect(verification).rejects.toMatchObject({ message: 'invalid stage', stack: 'worker stack' })
  })

  it('accepts an error response without a stack', async () => {
    const verification = verifyCurrentGenerationInWorker('/stage', 'none', 'session', 0)
    worker().emit('message', { ok: false, message: 'invalid stage' })
    await expect(verification).rejects.toThrow('invalid stage')
  })

  it.each([
    ['invalid response', 'message', null, /invalid response/],
    ['non-object response', 'message', 'invalid', /invalid response/],
    ['missing discriminator', 'message', {}, /invalid response/],
    ['invalid discriminator', 'message', { ok: 'yes' }, /invalid response/],
    ['worker error', 'error', new Error('worker failed'), /worker failed/],
    ['early exit', 'exit', 7, /code 7/],
  ])('rejects an %s', async (_name, event, value, expected) => {
    const verification = verifyCurrentGenerationInWorker('/stage', 'none', 'session', 0)
    worker().emit(event, value)
    await expect(verification).rejects.toThrow(expected)
  })

  it('aggregates termination failure after a Worker failure', async () => {
    const verification = verifyCurrentGenerationInWorker('/stage', 'none', 'session', 0)
    const instance = worker()
    instance.terminate.mockRejectedValueOnce(new Error('terminate failed'))
    instance.emit('error', new Error('worker failed'))

    await expect(verification).rejects.toBeInstanceOf(AggregateError)
  })

  it('ignores terminal signals after a successful Worker exit', async () => {
    const verification = verifyCurrentGenerationInWorker('/stage', 'none', 'session', 0)
    const instance = worker()
    instance.emit('message', { ok: true, result })
    instance.emit('exit', 0)
    instance.emit('error', new Error('late error'))
    instance.emit('exit', 1)
    instance.emit('message', null)

    await expect(verification).resolves.toEqual(result)
    expect(instance.terminate).not.toHaveBeenCalled()
  })

  it('retains the concurrency permit until the successful Worker exits', async () => {
    const controller = new AbortController()
    const first = verifyCurrentGenerationInWorker('/first', 'none', 'session', 0, undefined, controller.signal)
    const second = verifyCurrentGenerationInWorker('/second', 'none', 'session', 0, undefined, controller.signal)
    const third = verifyCurrentGenerationInWorker('/third', 'none', 'session', 0, undefined, controller.signal)
    try {
      expect(state.workers).toHaveLength(2)
      worker(0).emit('message', { ok: true, result })
      await setImmediate()
      expect(state.workers).toHaveLength(2)
      worker(0).emit('exit', 0)
      await first
      await vi.waitFor(() => { expect(state.workers).toHaveLength(3) })
      worker(1).emit('message', { ok: true, result })
      worker(1).emit('exit', 0)
      worker(2).emit('message', { ok: true, result })
      worker(2).emit('exit', 0)
      await expect(Promise.all([second, third])).resolves.toEqual([result, result])
    } finally {
      controller.abort()
      await Promise.allSettled([first, second, third])
    }
  })

  it('hands a released permit directly to the oldest waiter', async () => {
    const first = verifyCurrentGenerationInWorker('/first', 'none', 'session', 0)
    const second = verifyCurrentGenerationInWorker('/second', 'none', 'session', 0)
    const third = verifyCurrentGenerationInWorker('/third', 'none', 'session', 0)
    let fourth: Promise<typeof result> | undefined
    worker(0).emit('message', { ok: true, result })
    worker(0).emit('exit', 0)
    queueMicrotask(() => {
      fourth = verifyCurrentGenerationInWorker('/fourth', 'none', 'session', 0)
    })
    await first
    await vi.waitFor(() => { expect(state.workers).toHaveLength(3) })
    expect(worker(2).options.workerData).toMatchObject({ path: '/third' })

    worker(1).emit('message', { ok: true, result })
    worker(1).emit('exit', 0)
    await second
    await vi.waitFor(() => { expect(state.workers).toHaveLength(4) })
    expect(worker(3).options.workerData).toMatchObject({ path: '/fourth' })
    if (fourth === undefined) throw new Error('fourth verification was not scheduled')

    worker(2).emit('message', { ok: true, result })
    worker(2).emit('exit', 0)
    worker(3).emit('message', { ok: true, result })
    worker(3).emit('exit', 0)
    await expect(Promise.all([third, fourth])).resolves.toEqual([result, result])
  })

  it('removes an aborted waiter without starting another Worker', async () => {
    const first = verifyCurrentGenerationInWorker('/first', 'none', 'session', 0)
    const second = verifyCurrentGenerationInWorker('/second', 'none', 'session', 0)
    const controller = new AbortController()
    const reason = new Error('queued verification cancelled')
    const queued = verifyCurrentGenerationInWorker(
      '/queued', 'none', 'session', 0, undefined, controller.signal,
    )

    controller.abort(reason)
    await expect(queued).rejects.toBe(reason)
    expect(state.workers).toHaveLength(2)

    worker(0).emit('message', { ok: true, result })
    worker(0).emit('exit', 0)
    worker(1).emit('message', { ok: true, result })
    worker(1).emit('exit', 0)
    await expect(Promise.all([first, second])).resolves.toEqual([result, result])
    expect(state.workers).toHaveLength(2)
  })

  it('terminates an active Worker before rejecting cancellation', async () => {
    const controller = new AbortController()
    const reason = new Error('active verification cancelled')
    const verification = verifyCurrentGenerationInWorker(
      '/stage', 'none', 'session', 0, undefined, controller.signal,
    )
    const instance = worker()
    let finishTermination: ((value: number) => void) | undefined
    instance.terminate.mockReturnValueOnce(new Promise((resolve) => {
      finishTermination = resolve
    }))
    let settled = false
    void verification.then(
      () => { settled = true },
      () => { settled = true },
    )

    controller.abort(reason)
    expect(instance.terminate).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(settled).toBe(false)

    finishTermination?.(0)
    await expect(verification).rejects.toBe(reason)
  })

  it('wraps a non-Error active cancellation reason', async () => {
    const controller = new AbortController()
    const verification = verifyCurrentGenerationInWorker(
      '/stage', 'none', 'session', 0, undefined, controller.signal,
    )

    controller.abort('cancelled')
    await expect(verification).rejects.toMatchObject({
      message: 'migration verifier aborted',
      cause: 'cancelled',
    })
  })
})
