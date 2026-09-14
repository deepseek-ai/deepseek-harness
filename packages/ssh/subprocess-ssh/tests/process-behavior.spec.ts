/** Remote process transport, output observations, and managed cleanup through the public provider. */
import { duplexPair, type Duplex, type Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { SshRpcPeer } from '../../ssh/src/protocol.ts'
import { outputSnapshotFrameLimit } from '../../ssh/src/schemas.ts'
import { SshSubprocessRuntime } from '../src/index.ts'

const id = 'fd897b7b-1b7e-4cd0-9b8d-06b354062d91'
const spec: SubprocessSpawnSpec = {
  argv: ['/usr/bin/node', '-e', ''], cwd: '/workspace', graceMs: 5,
  stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
}
interface FinalOutput {
  outcome: { exitCode: number | null; signal: string | null }
  spills: { stdout?: string; stderr?: string }
  collected: { stdout?: { tail: string; totalBytes: number }; stderr?: { tail: string; totalBytes: number } }
}
const emptyResult: FinalOutput = { outcome: { exitCode: 0, signal: null }, spills: {}, collected: {} }

async function setup(options: { pause?: 'prepare' | 'connect' | 'start'; failPrepare?: Error; failStart?: unknown; failTerminate?: Error; wait?: boolean } = {}) {
  const ctx = new Context()
  const disposalErrors: unknown[] = []
  ctx.logger.error = ((error: unknown) => { disposalErrors.push(error) }) as typeof ctx.logger.error
  const finished = Promise.withResolvers<FinalOutput>()
  const gate = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  const started = Promise.withResolvers<undefined>()
  const peers = new Map<string, { host: Duplex; remote: Duplex }>()
  const rpcPeers: SshRpcPeer[] = []
  const calls: { method: string; params: unknown }[] = []
  let preparedSpec: SubprocessSpawnSpec | undefined
  const waitStage = async (stage: string) => {
    if (stage === options.pause) { entered.resolve(undefined); await gate.promise }
  }
  const connection = {
    dispose: vi.fn(async () => {}),
    request: async <T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T> => {
      calls.push({ method, params })
      let value: unknown
      if (method === 'process.prepare') {
        if (options.failPrepare !== undefined) throw options.failPrepare
        preparedSpec = params as SubprocessSpawnSpec
        await waitStage('prepare')
        const names = ['stdout', 'stderr', ...(preparedSpec.stdio.stdin === 'pipe' ? ['stdin'] : []),
          ...(preparedSpec.stdio.control === 'pipe' ? ['control'] : [])]
        value = { id, streams: Object.fromEntries(names.map(name => [name, { path: `/tmp/test-${name}`, capability: 'a'.repeat(64) }])) }
      } else if (method === 'process.start') {
        started.resolve(undefined)
        await waitStage('start')
        if (options.failStart !== undefined) throw options.failStart
        value = {}
      } else if (method === 'process.done') value = await finished.promise
      else if (method === 'process.wait') value = options.wait ?? true
      else if (method === 'process.terminate') {
        if (options.failTerminate !== undefined) throw options.failTerminate
        value = null
      } else if (method === 'executable') value = '/remote/bin/node'
      else throw new Error(`Unexpected SSH operation ${method}`)
      return schema.parse(value)
    },
    connectStream: async (endpoint: { path: string }, signal?: AbortSignal): Promise<Duplex> => {
      await waitStage('connect')
      signal?.throwIfAborted()
      const name = endpoint.path.slice('/tmp/test-'.length)
      const [host, remote] = duplexPair({ allowHalfOpen: true })
      host.on('error', () => {})
      remote.on('error', () => {})
      peers.set(name, { host, remote })
      return host
    },
  }
  ctx.provide('ssh', connection as never)
  const fiber = await ctx.plugin(SshSubprocessRuntime)
  const close = async () => {
    gate.resolve(undefined)
    finished.resolve(emptyResult)
    for (const peer of rpcPeers) peer.close()
    for (const peer of peers.values()) { peer.host.destroy(); peer.remote.destroy() }
    return fiber.dispose()
  }
  onTestFinished(async () => {
    await close()
    if (options.failTerminate === undefined) expect(disposalErrors).toEqual([])
  })
  const stream = (name: string): Duplex => {
    const peer = peers.get(name)
    if (peer === undefined) throw new Error(`stream ${name} has not been connected`)
    return peer.remote
  }
  const snapshots = (name: string, maxBytes: number) => {
    const socket = stream(name)
    const peer = new SshRpcPeer(socket, socket, outputSnapshotFrameLimit(maxBytes), 1)
    rpcPeers.push(peer)
    return (tail: string, totalBytes: number, method = 'snapshot') => peer.request(method, {
      tail: Buffer.from(tail).toString('base64'), totalBytes,
    }, z.null())
  }
  const closeStream = async (name: string): Promise<void> => {
    const peer = peers.get(name)
    if (peer === undefined) throw new Error(`stream ${name} has not been connected`)
    const closed = new Promise<void>((resolve) => { peer.host.once('close', () => { resolve() }) })
    peer.host.destroy()
    peer.remote.destroy()
    await closed
  }
  return { runtime: ctx.subprocess, fiber, calls, connection, disposalErrors, finished, entered: entered.promise, started: started.promise,
    release: () => { gate.resolve(undefined) }, stream, closeStream, snapshots, close }
}

/** Read incoming bytes without closing a duplex's outgoing half. */
async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const value of stream.iterator({ destroyOnReturn: false })) chunks.push(Buffer.from(value as Uint8Array))
  return Buffer.concat(chunks).toString()
}

describe('SSH ordinary process behavior', () => {
  it('forwards inherited output without ending the host standard streams', async () => {
    const test = await setup()
    const stdout: unknown[] = []
    const stderr: unknown[] = []
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { stdout.push(chunk); return true })
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { stderr.push(chunk); return true })
    try {
      const handle = test.runtime.spawn({ ...spec, stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' } })
      await test.started
      test.stream('stdout').end('inherited output')
      test.stream('stderr').end('inherited diagnostics')
      test.finished.resolve(emptyResult)
      await handle.done
      expect(stdout.map(String).join('')).toContain('inherited output')
      expect(stderr.map(String).join('')).toContain('inherited diagnostics')
      expect(process.stdout.writableEnded).toBe(false)
      expect(process.stderr.writableEnded).toBe(false)
      expect(handle.stdout).toBeUndefined()
      expect(handle.collected).toEqual({})
    } finally { out.mockRestore(); err.mockRestore() }
  })

  it('bounds output draining after process completion even when the output peer remains open', async () => {
    const test = await setup()
    const handle = test.runtime.spawn(spec)
    await test.started
    test.finished.resolve(emptyResult)
    expect(await handle.done).toEqual({ exitCode: 0, signal: null })
    expect(test.stream('stdout').destroyed).toBe(false)
    expect(await handle.waitForExit()).toBe(true)
  })

  it('observes output transports that closed before the start acknowledgement arrives', async () => {
    const test = await setup({ pause: 'start' })
    const handle = test.runtime.spawn(spec)
    await test.entered
    await test.closeStream('stdout')
    await test.closeStream('stderr')
    test.release()
    test.finished.resolve(emptyResult)
    expect(await handle.done).toEqual({ exitCode: 0, signal: null })
    expect(await handle.waitForExit()).toBe(true)
    await test.close()
    expect(test.disposalErrors).toEqual([])
  })

  it('keeps stdin, stdout, stderr and control independent and forwards explicit environment removals', async () => {
    const test = await setup()
    expect(await test.runtime.resolveExecutable('node', { PATH: '/remote/bin' })).toBe('/remote/bin/node')
    const handle = test.runtime.spawn({ ...spec, env: { REMOVE: undefined, KEEP: 'value' },
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', control: 'pipe' } })
    const stdout = readAll(handle.stdout!)
    const stderr = readAll(handle.stderr!)
    const control = readAll(handle.control!)
    handle.stdin!.end('ordinary input')
    handle.control!.end('private input')
    await test.started
    expect(await readAll(test.stream('stdin'))).toBe('ordinary input')
    expect(await readAll(test.stream('control'))).toBe('private input')
    expect(test.stream('control').destroyed).toBe(false)
    test.stream('stdout').end('ordinary output')
    test.stream('stderr').end('diagnostic output')
    test.stream('control').end('private output')
    expect(await Promise.all([stdout, stderr, control])).toEqual(['ordinary output', 'diagnostic output', 'private output'])
    test.finished.resolve(emptyResult)
    expect(await handle.done).toEqual({ exitCode: 0, signal: null })
    expect(await handle.waitForExit()).toBe(true)
    expect(await handle.waitForExit()).toBe(true)
    expect(test.calls.find(call => call.method === 'process.prepare')?.params).toMatchObject({ env: { REMOVE: null, KEEP: 'value' } })
    handle.terminate()
    expect(test.calls.filter(call => call.method === 'process.terminate')).toHaveLength(0)
  })

  it('retains authoritative collected byte offsets when older stream snapshots arrive after completion', async () => {
    const test = await setup()
    const handle = test.runtime.spawn({ ...spec, stdio: { stdin: 'ignore', stdout: { maxBytes: 4 }, stderr: { maxBytes: 4 } } })
    await test.started
    const snapshot = test.snapshots('stdout', 4)
    await snapshot('cdef', 6)
    expect(handle.collected.stdout!.readFrom(0)).toEqual({ text: 'cdef', nextOffset: 6, lossy: true })
    test.finished.resolve({ ...emptyResult, spills: { stdout: '/remote/spill' }, collected: {
      stdout: { tail: Buffer.from('ghij').toString('base64'), totalBytes: 10 }, stderr: { tail: '', totalBytes: 0 },
    } })
    await handle.done
    await snapshot('x', 1)
    expect(handle.collected.stdout!.readFrom(8)).toEqual({ text: 'ij', nextOffset: 10, lossy: false, spillPath: '/remote/spill' })
  })

  it.each([
    { tail: '12345', total: 5, error: 'invalid collected output coordinates' },
    { tail: 'abcd', total: 3, error: 'invalid collected output coordinates' },
    { tail: 'a', total: 1, error: 'rewound collected output' },
  ])('rejects a remote snapshot with $error', async ({ tail, total, error }) => {
    const test = await setup()
    const handle = test.runtime.spawn({ ...spec, stdio: { stdin: 'ignore', stdout: { maxBytes: 4 }, stderr: { maxBytes: 4 } } })
    await test.started
    const snapshot = test.snapshots('stdout', 4)
    await snapshot('abcd', 4)
    await expect(snapshot(tail, total)).rejects.toThrow(error)
    await expect(snapshot('a', 1, 'unexpected')).rejects.toThrow('Unexpected SSH output-stream operation')
    expect(handle.collected.stdout!.readFrom(0).text).toBe('abcd')
    test.finished.resolve({ ...emptyResult, collected: { stdout: { tail: 'YWJjZA==', totalBytes: 4 }, stderr: { tail: '', totalBytes: 0 } } })
    await handle.done
  })

  it('rejects a final output mode mismatch and terminates its remote process', async () => {
    const test = await setup()
    const handle = test.runtime.spawn({ ...spec, stdio: { stdin: 'ignore', stdout: { maxBytes: 4 }, stderr: { maxBytes: 4 } } })
    await test.started
    test.finished.resolve(emptyResult)
    await expect(handle.done).rejects.toThrow('mismatched output collection modes')
    expect(await handle.waitForExit()).toBe(true)
    expect(test.calls.filter(call => call.method === 'process.terminate')).toHaveLength(1)
  })

  it.each(['prepare', 'connect', 'start'] as const)('joins cancellation during %s and sends at most one termination', async (pause) => {
    const test = await setup({ pause })
    const controller = new AbortController()
    const handle = test.runtime.spawn({ ...spec, signal: controller.signal })
    await test.entered
    controller.abort(new Error('caller stopped'))
    handle.terminate()
    const quiescent = handle.waitForExit()
    test.release()
    if (pause === 'start') test.finished.resolve(emptyResult)
    await Promise.allSettled([handle.done])
    expect(await quiescent).toBe(true)
    handle.terminate()
    expect(test.calls.filter(call => call.method === 'process.terminate')).toHaveLength(1)
    if (pause !== 'start') expect(test.calls.some(call => call.method === 'process.start')).toBe(false)
  })

  it('reports range completion when preparation fails before any process can start', async () => {
    const test = await setup({ failPrepare: new Error('prepare refused') })
    const handle = test.runtime.spawn(spec)
    const quiescent = handle.waitForExit()
    await expect(handle.done).rejects.toThrow('prepare refused')
    expect(await quiescent).toBe(true)
    expect(test.calls.some(call => call.method === 'process.start' || call.method === 'process.terminate')).toBe(false)
  })

  it('reports an unconfirmed cleanup and closes the SSH connection', async () => {
    const test = await setup({ failStart: new Error('start lost'), failTerminate: new Error('cleanup lost') })
    test.connection.dispose.mockRejectedValue(new Error('connection cleanup failed'))
    const handle = test.runtime.spawn(spec)
    await expect(handle.done).rejects.toThrow('start lost')
    await expect(handle.waitForExit()).rejects.toThrow('cleanup lost')
    await test.close()
    expect(test.disposalErrors).toEqual([expect.objectContaining({ message: 'SSH process cleanup could not be confirmed' })])
    expect(test.connection.dispose).toHaveBeenCalled()
  })

  it('normalizes a non-Error transport rejection for stream consumers', async () => {
    const test = await setup()
    const handle = test.runtime.spawn(spec)
    const error = new Promise<Error>(resolve => handle.stdout!.once('error', resolve))
    await test.started
    test.finished.reject('connection lost')
    await expect(handle.done).rejects.toBe('connection lost')
    expect((await error).message).toBe('connection lost')
    expect(await handle.waitForExit()).toBe(true)
  })

  it('reports a live range until termination and rejects new work after disposal', async () => {
    const test = await setup({ wait: false })
    const handle = test.runtime.spawn(spec)
    await test.started
    expect(await handle.waitForExit()).toBe(false)
    handle.terminate()
    expect(await handle.waitForExit()).toBe(true)
    await test.close()
    expect(() => test.runtime.spawn(spec)).toThrow('disposed')
    expect(() => test.runtime.spawn({ ...spec, signal: AbortSignal.abort() })).toThrow()
  })
})
