import { describe, expect, it, vi } from 'vitest'
import { DesktopBackendController, type DesktopBackendState } from '../src/backend-controller.ts'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

function fixture() {
  const started = deferred()
  const ready = deferred()
  const stopping = deferred()
  const exited = deferred()
  const states: DesktopBackendState[] = []
  let fail!: (error: Error) => void
  const host = {
    start: vi.fn(() => { started.resolve(); return ready.promise }),
    stop: vi.fn(() => { stopping.resolve(); return exited.promise }),
  }
  const create = vi.fn((onFailure: (error: Error) => void) => { fail = onFailure; return host })
  const controller = new DesktopBackendController(create, state => states.push(state))
  return { controller, host, create, states, started, ready, stopping, exited, fail: (error: Error) => { fail(error) } }
}

describe('desktop backend controller', () => {
  it('shares preparation and startup between concurrent retries', async () => {
    const f = fixture()
    const prepare = vi.fn(async () => {})
    const first = f.controller.start(prepare)
    expect(f.controller.start(prepare)).toBe(first)
    await f.started.promise
    expect(f.controller.host).toBeUndefined()
    expect(f.states).toEqual([{ phase: 'starting' }])
    f.ready.resolve()
    await first
    expect(f.controller.host).toBe(f.host)
    await f.controller.start(prepare)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(f.host.start).toHaveBeenCalledTimes(1)
    f.exited.resolve()
    await f.controller.close()
  })

  it('waits for pending preparation on close and never spawns afterward', async () => {
    const f = fixture()
    const preparing = deferred()
    const prepared = deferred()
    const start = f.controller.start(() => { preparing.resolve(); return prepared.promise })
    await preparing.promise
    let closed = false
    const close = f.controller.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    prepared.resolve()
    await Promise.all([start, close])
    expect(f.create).not.toHaveBeenCalled()
    expect(f.states).toEqual([{ phase: 'starting' }])
    await expect(f.controller.start(async () => {})).rejects.toThrow('closed')
  })

  it('stops a pending child once and waits for startup and child exit on close', async () => {
    const f = fixture()
    const start = f.controller.start(async () => {})
    const rejected = expect(start).rejects.toThrow('stopped')
    await f.started.promise
    const close = f.controller.close()
    expect(f.controller.close()).toBe(close)
    await f.stopping.promise
    let closed = false
    void close.then(() => { closed = true })
    f.ready.reject(new Error('stopped'))
    await Promise.resolve()
    expect(closed).toBe(false)
    f.exited.resolve()
    await Promise.all([rejected, close])
    expect(f.host.stop).toHaveBeenCalledTimes(1)
    expect(f.states).toEqual([{ phase: 'starting' }])
    expect(f.controller.host).toBeUndefined()
  })

  it('publishes preparation errors and permits retry', async () => {
    const f = fixture()
    await expect(f.controller.start(async () => { throw new Error('invalid profile') })).rejects.toThrow('invalid profile')
    expect(f.controller.state).toEqual({ phase: 'error', message: 'invalid profile' })
    expect(f.create).not.toHaveBeenCalled()
    f.ready.resolve()
    await f.controller.start(async () => {})
    expect(f.controller.state).toEqual({ phase: 'ready' })
    f.exited.resolve()
    await f.controller.close()
  })

  it('cleans up a failed startup before rejecting and displays the actual failure', async () => {
    const f = fixture()
    const start = f.controller.start(async () => {})
    const rejected = expect(start).rejects.toThrow('plugin failed')
    await f.started.promise
    f.ready.reject(new Error('plugin failed'))
    await f.stopping.promise
    f.exited.resolve()
    await rejected
    expect(f.controller.state).toEqual({ phase: 'error', message: 'plugin failed' })
    expect(f.host.stop).toHaveBeenCalledTimes(1)
    await f.controller.close()
  })

  it('waits for failed ready child cleanup before preparing a retry', async () => {
    const f = fixture()
    f.ready.resolve()
    await f.controller.start(async () => {})
    f.fail(new Error('transport failed'))
    expect(f.controller.state).toEqual({ phase: 'error', message: 'transport failed' })
    expect(f.controller.host).toBeUndefined()
    await f.stopping.promise
    const prepare = vi.fn(async () => {})
    const retry = f.controller.start(prepare)
    await Promise.resolve()
    expect(prepare).not.toHaveBeenCalled()
    f.exited.resolve()
    await retry
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(f.create).toHaveBeenCalledTimes(2)
    await f.controller.close()
  })

  it('does not publish ready when the child fails as readiness settles', async () => {
    const f = fixture()
    const start = f.controller.start(async () => {})
    const rejected = expect(start).rejects.toThrow('immediate failure')
    await f.started.promise
    f.ready.resolve()
    f.fail(new Error('immediate failure'))
    await f.stopping.promise
    f.exited.resolve()
    await rejected
    expect(f.states).toEqual([{ phase: 'starting' }, { phase: 'error', message: 'immediate failure' }])
    await f.controller.close()
  })

  it('ignores failure callbacks caused by intentional stop and permits subsequent start', async () => {
    const f = fixture()
    f.ready.resolve()
    await f.controller.start(async () => {})
    const stop = f.controller.stop()
    await f.stopping.promise
    f.fail(new Error('stopped'))
    await expect(f.controller.start(async () => {})).rejects.toThrow('stopping')
    expect(f.controller.state).toEqual({ phase: 'starting' })
    f.exited.resolve()
    await stop
    await f.controller.start(async () => {})
    expect(f.create).toHaveBeenCalledTimes(2)
    await f.controller.close()
  })

  it('propagates cleanup failure and prevents retry from overlapping the remaining child', async () => {
    const f = fixture()
    f.ready.resolve()
    await f.controller.start(async () => {})
    f.fail(new Error('fatal'))
    await f.stopping.promise
    f.exited.reject(new Error('child did not exit'))
    await expect(f.controller.start(async () => {})).rejects.toThrow('child did not exit')
    await expect(f.controller.start(async () => {})).rejects.toThrow('child did not exit')
    expect(f.create).toHaveBeenCalledTimes(1)
    await expect(f.controller.close()).rejects.toThrow('child did not exit')
  })
})
