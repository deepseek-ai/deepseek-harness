/** Published terminal operations and cleanup failures over the remote provider seam. */
import { duplexPair } from 'node:stream'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { SshSubprocessRuntime } from '../src/index.ts'

const id = 'aa910b47-e7d7-467b-8421-3331569dd02b'
const spec: SubprocessTerminalSpawnSpec = { argv: ['bash'], cwd: '/remote/workspace', terminalType: 'dumb', rows: 24, cols: 80, graceMs: 100 }
const completion = { outcome: { exitCode: 0, signal: null }, spills: {}, collected: {} }

async function setup(options: {
  connectFailure?: Error
  terminateFailure?: Error | undefined
  pauseConnect?: boolean
  missingEndpoint?: boolean
} = {}) {
  const ctx = new Context()
  const cleanupErrors: unknown[] = []
  ctx.logger.error = ((error: unknown) => { cleanupErrors.push(error) }) as typeof ctx.logger.error
  const [host, remote] = duplexPair({ allowHalfOpen: true })
  host.on('error', () => {})
  remote.on('error', () => {})
  const entered = Promise.withResolvers<undefined>()
  const allocationAborted = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const finished = Promise.withResolvers<typeof completion>()
  const calls: { method: string; params: unknown; longRunning?: boolean }[] = []
  let foreground: { processGroupId: number; inputWaiting: boolean } | null = null
  const connection = {
    dispose: vi.fn(() => { host.destroy(); remote.destroy(); return Promise.resolve() }),
    request: async <T>(method: string, params: unknown, schema: z.ZodType<T>, _signal?: AbortSignal, longRunning?: boolean): Promise<T> => {
      calls.push({ method, params, ...(longRunning === undefined ? {} : { longRunning }) })
      let value: unknown
      if (method === 'process.prepare') {
        value = { id, streams: options.missingEndpoint ? {} : { terminal: { path: '/tmp/terminal', capability: 'a'.repeat(64) } } }
      } else if (method === 'process.start') value = { pid: 321 }
      else if (method === 'process.done') value = await finished.promise
      else if (method === 'process.terminate') {
        if (options.terminateFailure !== undefined) throw options.terminateFailure
        finished.resolve(completion)
        value = null
      } else if (method === 'terminal.write' || method === 'terminal.resize') value = null
      else if (method === 'terminal.inspect') value = foreground
      else if (method === 'terminal.signal') value = 321
      else throw new Error(`Unexpected terminal request ${method}`)
      return schema.parse(value)
    },
    connectStream: vi.fn(async (_endpoint: unknown, signal?: AbortSignal) => {
      entered.resolve(undefined)
      signal?.addEventListener('abort', () => { allocationAborted.resolve(undefined) }, { once: true })
      if (options.pauseConnect) await release.promise
      if (options.connectFailure !== undefined) throw options.connectFailure
      return host
    }),
  }
  ctx.provide('ssh', connection as never)
  const fiber = await ctx.plugin(SshSubprocessRuntime)
  let closing: Promise<void> | undefined
  const dispose = (): Promise<void> => closing ??= fiber.dispose()
  const close = (): Promise<void> => {
    release.resolve(undefined)
    finished.resolve(completion)
    host.destroy()
    remote.destroy()
    return dispose()
  }
  onTestFinished(async () => {
    host.destroy()
    remote.destroy()
    if (closing === undefined) await close()
  })
  return {
    runtime: ctx.subprocess, connection, calls, host, remote, finished, close, dispose, cleanupErrors,
    entered: entered.promise, release: () => { release.resolve(undefined) },
    allocationAborted: allocationAborted.promise,
    setForeground: (value: typeof foreground) => { foreground = value },
  }
}

describe('SSH terminal behavior', () => {
  it('publishes output and forwards terminal operations with remote process observations', async () => {
    const test = await setup()
    const handle = await test.runtime.spawnTerminal({ ...spec, env: { KEEP: 'value' } })
    expect(handle.pid).toBe(321)
    const data = once(handle.output, 'data')
    test.remote.write('terminal output')
    expect(String((await data)[0])).toBe('terminal output')
    await handle.write('input\n')
    await handle.resize(120, 40)
    expect(test.calls.find(call => call.method === 'terminal.resize')?.params).toEqual({ id, cols: 120, rows: 40 })
    expect(await handle.inspectForeground()).toBeUndefined()
    test.setForeground({ processGroupId: 321, inputWaiting: true })
    expect(await handle.inspectForeground()).toEqual({ processGroupId: 321, inputWaiting: true })
    expect(await handle.signalForeground('SIGINT')).toBe(321)
    expect(test.calls.find(call => call.method === 'process.prepare')?.params).toEqual({
      argv: ['bash'], cwd: spec.cwd, env: { KEEP: 'value' }, graceMs: 100,
      terminal: { terminalType: 'dumb', rows: 24, cols: 80 },
    })
    expect(test.calls.find(call => call.method === 'terminal.write')?.params).toEqual({ id, value: 'input\n' })
    expect(test.calls.find(call => call.method === 'terminal.signal')?.params).toEqual({ id, value: 'SIGINT' })
    test.finished.resolve(completion)
    expect(await handle.done).toEqual({ exitCode: 0, signal: null })
    await Promise.all([handle.terminate(), handle.terminate()])
    expect(test.calls.filter(call => call.method === 'process.terminate')).toHaveLength(1)
    expect(test.calls.find(call => call.method === 'process.terminate')?.longRunning).toBe(true)
    expect(test.host.destroyed).toBe(true)
    expect(handle.output.destroyed).toBe(true)
    await test.close()
    expect(test.calls.filter(call => call.method === 'process.terminate')).toHaveLength(1)
  })

  it('retries termination after a remote cleanup failure without discarding the live handle', async () => {
    const failure = new Error('range observation failed')
    const options = { terminateFailure: failure as Error | undefined }
    const test = await setup(options)
    const handle = await test.runtime.spawnTerminal(spec)
    await expect(handle.terminate()).rejects.toBe(failure)
    expect(handle.output.destroyed).toBe(false)
    expect(test.connection.dispose).not.toHaveBeenCalled()
    options.terminateFailure = undefined
    await handle.terminate()
    expect(await handle.done).toEqual(completion.outcome)
    expect(test.calls.filter(call => call.method === 'process.terminate')).toHaveLength(2)
    expect(handle.output.destroyed).toBe(true)
  })

  it('keeps termination available after the direct-result observation fails', async () => {
    const test = await setup()
    const handle = await test.runtime.spawnTerminal(spec)
    const failure = new Error('direct result channel closed')
    const rejected = expect(handle.done).rejects.toBe(failure)
    test.finished.reject(failure)
    await rejected
    await handle.terminate()
    expect(test.calls.filter(call => call.method === 'process.terminate')).toHaveLength(1)
    expect(handle.output.destroyed).toBe(true)
  })

  it('terminates a published terminal when its caller aborts', async () => {
    const test = await setup()
    const controller = new AbortController()
    const handle = await test.runtime.spawnTerminal({ ...spec, signal: controller.signal })
    controller.abort(new Error('caller stopped'))
    await handle.terminate()
    expect(test.calls.filter(call => call.method === 'process.terminate')).toHaveLength(1)
    expect(handle.output.destroyed).toBe(true)
    expect(await handle.done).toEqual(completion.outcome)
  })

  it('releases the SSH connection when abort cannot confirm remote termination', async () => {
    const options = { terminateFailure: new Error('termination lost') as Error | undefined }
    const test = await setup(options)
    test.connection.dispose.mockRejectedValueOnce(new Error('transport already lost'))
    const controller = new AbortController()
    const handle = await test.runtime.spawnTerminal({ ...spec, signal: controller.signal })
    controller.abort()
    await expect.poll(() => test.connection.dispose.mock.calls.length).toBe(1)
    options.terminateFailure = undefined
    await handle.terminate()
    expect(handle.output.destroyed).toBe(true)
  })

  it('rejects a terminal reservation without its required stream and confirms cleanup', async () => {
    const test = await setup({ missingEndpoint: true })
    await expect(test.runtime.spawnTerminal(spec)).rejects.toBeInstanceOf(z.ZodError)
    expect(test.connection.connectStream).not.toHaveBeenCalled()
    expect(test.calls.map(call => call.method)).toEqual(['process.prepare', 'process.terminate'])
  })

  it('reports both unpublished allocation and cleanup failures during provider disposal', async () => {
    const connectFailure = new Error('stream connection failed')
    const terminateFailure = new Error('remote cleanup failed')
    const test = await setup({ connectFailure, terminateFailure, pauseConnect: true })
    test.connection.dispose.mockRejectedValueOnce(new Error('transport already lost'))
    const allocation = test.runtime.spawnTerminal(spec)
    const failed = expect(allocation).rejects.toMatchObject({ errors: [connectFailure, terminateFailure] })
    await test.entered
    const disposal = test.dispose()
    await test.allocationAborted
    test.release()
    await Promise.all([failed, disposal])
    expect(test.cleanupErrors).toMatchObject([{
      message: 'SSH process cleanup could not be confirmed',
      errors: [expect.objectContaining({ errors: [connectFailure, terminateFailure] })],
    }])
    expect(test.connection.dispose).toHaveBeenCalledOnce()
    expect(test.calls.some(call => call.method === 'process.start')).toBe(false)
  })

  it('refuses admission after caller cancellation or provider disposal', async () => {
    const test = await setup()
    const stopped = AbortSignal.abort(new Error('cancelled before admission'))
    await expect(test.runtime.spawnTerminal({ ...spec, signal: stopped })).rejects.toThrow('cancelled before admission')
    expect(test.calls).toEqual([])
    await test.close()
    await expect(test.runtime.spawnTerminal(spec)).rejects.toThrow('disposed')
    expect(test.calls).toEqual([])
  })

  it('terminates a published terminal when the provider is disposed', async () => {
    const test = await setup()
    const handle = await test.runtime.spawnTerminal(spec)
    await test.close()
    expect(test.calls.filter(call => call.method === 'process.terminate')).toHaveLength(1)
    expect(handle.output.destroyed).toBe(true)
    expect(await handle.done).toEqual(completion.outcome)
  })
})
