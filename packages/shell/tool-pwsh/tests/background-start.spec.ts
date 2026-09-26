import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ShellProcess } from '@deepseek-ai/dsh-shell'
import { processJob, processOutcome, processSources } from '../src/background.ts'

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
  const readOutput = vi.fn(() => ({ delta: 'output', lossy: false }))
  const process: ShellProcess = {
    status: 'running', exitCode: null, signal: null, done: exited.promise,
    readOutput, kill,
    observed: {
      stdout: { readFrom: fromByte => ({ text: 'output'.slice(fromByte), nextOffset: 6, lossy: false }) },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    },
  }
  onTestFinished(() => { exited.resolve(undefined) })
  return { process, exited, killed, kill, readOutput }
}

describe('background job ownership during asynchronous shell startup', () => {
  it('keeps observation empty during preparation and reads published output without consuming it', async () => {
    const child = processHandle()
    const prepared = Promise.withResolvers<ShellProcess>()
    let published: ShellProcess | undefined
    const source = processSources(() => published)[0]!
    const outcome = vi.fn(processOutcome)
    const hooks = processJob(async () => { published = await prepared.promise; return published }, outcome)
    expect(source.read(0).text).toBe('')
    expect(outcome).not.toHaveBeenCalled()
    prepared.resolve(child.process)
    await Promise.resolve()
    expect(source.read(0).text).toBe('output')
    expect(source.read(0).text).toBe('output')
    expect(child.readOutput).not.toHaveBeenCalled()
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
    }, processOutcome)
    expect(received?.aborted).toBe(false)
    hooks.cancel('cancel pending confinement')
    hooks.cancel('later cancellation')
    expect(received?.reason).toBe('cancel pending confinement')
    expect(await hooks.done).toEqual({ status: 'killed', detail: 'cancel pending confinement' })
  })

  it('kills a process that materializes after cancellation and awaits its exit', async () => {
    const child = processHandle()
    const prepared = Promise.withResolvers<ShellProcess>()
    const hooks = processJob(() => prepared.promise, processOutcome)
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
    const hooks = processJob(async () => child.process, processOutcome)
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
    const hooks = processJob(() => prepared.promise, processOutcome)
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
    const render = vi.fn(processOutcome)
    const hooks = processJob(async () => { throw new Error('remote sandbox unavailable') }, render)
    expect(await hooks.done).toEqual({ status: 'failed', detail: 'remote sandbox unavailable' })
    expect(render).not.toHaveBeenCalled()
  })

  it('reports a primitive upstream abort reason as a failed startup', async () => {
    const upstream = new AbortController()
    upstream.abort('upstream preparation stopped')
    const hooks = processJob(async () => { upstream.signal.throwIfAborted(); throw new Error('unreachable') }, processOutcome)
    expect(await hooks.done).toEqual({ status: 'failed', detail: 'upstream preparation stopped' })
  })
})
