import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ShellProcess } from '@deepseek-ai/dsh-shell'
import { processJob } from '../src/background.ts'

function processHandle() {
  const exited = Promise.withResolvers<undefined>()
  const killed = Promise.withResolvers<undefined>()
  const kill = vi.fn(() => {
    if (process.status !== 'running') return false
    process.status = 'killed'
    process.signal = 'SIGTERM'
    killed.resolve(undefined)
    return true
  })
  const process: ShellProcess = {
    status: 'running', exitCode: null, signal: null, done: exited.promise,
    readOutput: () => ({ delta: 'output', lossy: false }), kill,
  }
  onTestFinished(() => { exited.resolve(undefined) })
  return { process, exited, killed, kill }
}

describe('background job ownership during asynchronous shell startup', () => {
  it('keeps output empty until a process is published and then consumes its output', async () => {
    const child = processHandle()
    const prepared = Promise.withResolvers<ShellProcess>()
    const render = vi.fn((process: ShellProcess) => process.readOutput().delta)
    const hooks = processJob(() => prepared.promise, render)
    expect(hooks.readOutput!()).toBe('')
    expect(render).not.toHaveBeenCalled()
    prepared.resolve(child.process)
    await Promise.resolve()
    expect(hooks.readOutput!()).toBe('output')
    child.process.status = 'completed'
    child.process.exitCode = 5
    child.exited.resolve(undefined)
    expect(await hooks.done).toEqual({ status: 'completed', detail: 'exit code: 5' })
  })

  it('aborts pending preparation through the job-owned signal', async () => {
    let received: AbortSignal | undefined
    const hooks = processJob((signal) => {
      received = signal
      return new Promise<ShellProcess>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error(String(signal.reason))) }, { once: true })
      })
    }, () => 'unreachable')
    expect(received?.aborted).toBe(false)
    hooks.cancel('cancel pending confinement')
    hooks.cancel('later cancellation')
    expect(received?.reason).toBe('cancel pending confinement')
    expect(await hooks.done).toEqual({ status: 'killed', detail: 'cancel pending confinement' })
    expect(hooks.readOutput!()).toBe('')
  })

  it('kills a process that materializes after cancellation and awaits its exit', async () => {
    const child = processHandle()
    const prepared = Promise.withResolvers<ShellProcess>()
    const hooks = processJob(() => prepared.promise, () => 'output')
    let settled = false
    void hooks.done.then(() => { settled = true })
    hooks.cancel('cancel before process publication')
    prepared.resolve(child.process)
    await child.killed.promise
    expect(child.kill).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    child.exited.resolve(undefined)
    expect(await hooks.done).toEqual({ status: 'killed', detail: 'signal: SIGTERM' })
  })

  it('cancels a published process once and keeps done pending until exit', async () => {
    const child = processHandle()
    const hooks = processJob(async () => child.process, () => 'output')
    await Promise.resolve()
    let settled = false
    void hooks.done.then(() => { settled = true })
    hooks.cancel('stop')
    hooks.cancel('stop again')
    await child.killed.promise
    expect(child.kill).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    child.exited.resolve(undefined)
    expect((await hooks.done).status).toBe('killed')
  })

  it('joins a late process even when its termination request throws', async () => {
    const child = processHandle()
    const attempted = Promise.withResolvers<undefined>()
    vi.mocked(child.kill).mockImplementation(() => { attempted.resolve(undefined); throw new Error('termination failed') })
    const prepared = Promise.withResolvers<ShellProcess>()
    const hooks = processJob(() => prepared.promise, () => '')
    let settled = false
    void hooks.done.then(() => { settled = true })
    hooks.cancel('stop before publication')
    prepared.resolve(child.process)
    await attempted.promise
    expect(settled).toBe(false)
    child.exited.resolve(undefined)
    expect(await hooks.done).toEqual({ status: 'failed', detail: 'termination failed' })
  })

  it('reports a startup failure through job completion without publishing output', async () => {
    const render = vi.fn(() => 'unreachable')
    const hooks = processJob(async () => { throw new Error('remote sandbox unavailable') }, render)
    expect(await hooks.done).toEqual({ status: 'failed', detail: 'remote sandbox unavailable' })
    expect(hooks.readOutput!()).toBe('')
    expect(render).not.toHaveBeenCalled()
  })

  it('reports a primitive upstream abort reason as a failed startup', async () => {
    const upstream = new AbortController()
    upstream.abort('upstream preparation stopped')
    const hooks = processJob(async () => { upstream.signal.throwIfAborted(); throw new Error('unreachable') }, () => '')
    expect(await hooks.done).toEqual({ status: 'failed', detail: 'upstream preparation stopped' })
  })
})
