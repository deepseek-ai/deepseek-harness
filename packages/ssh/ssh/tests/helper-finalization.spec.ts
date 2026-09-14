/** Authenticated transport faults and competing native-range finalization. */
import { once } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { createServer, type Server, type TLSSocket } from 'node:tls'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { RemoteProcesses } from '../src/helper-processes.ts'
import { authenticateStream } from '../src/stream-security.ts'

vi.mock('node:tls', async (original) => {
  const actual = await original<typeof import('node:tls')>()
  return { ...actual, createServer: vi.fn(actual.createServer) }
})

function nativeProcess() {
  const completion = Promise.withResolvers<SubprocessOutcome>()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const control = new PassThrough()
  const finish = (): void => {
    stdout.end(); stderr.end(); control.end()
    completion.resolve({ exitCode: 0, signal: null })
  }
  const terminate = vi.fn(finish)
  const waitForExit = vi.fn(async () => { await completion.promise; return true })
  const handle: SubprocessHandle = {
    stdin: undefined, stdout, stderr, control, collected: {}, done: completion.promise,
    terminate, waitForExit,
  }
  return { handle, control, finish, terminate, waitForExit }
}

async function harness(child: ReturnType<typeof nativeProcess>, control: boolean) {
  const root = await mkdtemp('/tmp/dsh-ssh-finalize-')
  const ctx = new Context()
  const owner = new RemoteProcesses(ctx, root, 1, 5000)
  const sockets: Socket[] = []
  onTestFinished(async () => {
    child.finish()
    for (const socket of [...sockets].reverse()) socket.destroy()
    try { await owner.close() }
    finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
      vi.restoreAllMocks()
    }
  })
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(LocalSubprocessRuntime)
  vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue(child.handle)
  const prepared = await owner.prepare({
    argv: ['fixture-native-process'], cwd: root, graceMs: 100,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', ...(control ? { control: 'pipe' } : {}) },
  })
  const serving: Record<string, TLSSocket> = {}
  for (const [name, endpoint] of Object.entries(prepared.streams)) {
    let server: Server | undefined
    for (const result of vi.mocked(createServer).mock.results) {
      if (result.type === 'return' && result.value.address() === endpoint.path) { server = result.value; break }
    }
    if (server === undefined) throw new Error('Fixture endpoint listener was not created')
    const listener = server
    const authenticated = new Promise<TLSSocket>((resolve) => { listener.once('secureConnection', resolve) })
    const raw = createConnection({ path: endpoint.path, allowHalfOpen: true })
    sockets.push(raw)
    raw.on('error', () => {})
    await once(raw, 'connect')
    const socket = await authenticateStream(raw, endpoint.capability, 5000)
    sockets.push(socket)
    socket.on('error', () => {})
    serving[name] = await authenticated
    if (name !== 'control') { socket.end(); socket.resume() }
  }
  await owner.start(prepared.id)
  return { root, owner, id: prepared.id, serving }
}

describe.skipIf(process.platform === 'win32')('SSH helper finalization ownership', () => {
  it('destroys the native control endpoint when its authenticated TLS transport fails', async () => {
    const child = nativeProcess()
    const test = await harness(child, true)
    const control = test.serving.control!
    const closed = once(child.control, 'close')
    expect(child.control.destroyed).toBe(false)
    control.destroy(Object.assign(new Error('authenticated transport I/O failed'), { code: 'ECONNRESET' }))
    await closed
    expect(child.control.destroyed).toBe(true)
    await test.owner.terminate(test.id)
    expect(child.waitForExit).toHaveBeenCalled()
    expect(await test.owner.done(test.id)).toMatchObject({ outcome: { exitCode: 0, signal: null } })
  })

  it('does not republish completion after helper close has released the process record', async () => {
    const child = nativeProcess()
    const observing = Promise.withResolvers<undefined>()
    const releaseObservation = Promise.withResolvers<undefined>()
    child.waitForExit.mockImplementationOnce(async () => {
      observing.resolve(undefined)
      await releaseObservation.promise
      return true
    })
    const test = await harness(child, false)
    onTestFinished(async () => {
      await test.owner.close()
      releaseObservation.resolve(undefined)
      await setImmediate()
    })
    child.finish()
    await observing.promise
    await test.owner.close()
    expect(child.terminate).toHaveBeenCalledOnce()
    expect(child.waitForExit).toHaveBeenCalledTimes(2)
    expect(await readdir(test.root)).toEqual([])
    releaseObservation.resolve(undefined)
    await setImmediate()
    await expect(test.owner.done(test.id)).rejects.toThrow('Unknown or expired SSH process handle')
    expect(await readdir(test.root)).toEqual([])
  })

  it('leaves completion owned by a release that is still observing the native range', async () => {
    const child = nativeProcess()
    const firstEntered = Promise.withResolvers<undefined>()
    const secondEntered = Promise.withResolvers<undefined>()
    const first = Promise.withResolvers<undefined>()
    const second = Promise.withResolvers<undefined>()
    child.waitForExit.mockImplementationOnce(async () => {
      firstEntered.resolve(undefined)
      await first.promise
      return true
    }).mockImplementationOnce(async () => {
      secondEntered.resolve(undefined)
      await second.promise
      return true
    })
    const test = await harness(child, false)
    onTestFinished(() => { first.resolve(undefined); second.resolve(undefined) })
    child.finish()
    await firstEntered.promise
    const closed = test.owner.close()
    try {
      await secondEntered.promise
      first.resolve(undefined)
      await setImmediate()
      second.resolve(undefined)
      await closed
      await expect(test.owner.done(test.id)).rejects.toThrow('Unknown or expired SSH process handle')
    } finally {
      first.resolve(undefined)
      second.resolve(undefined)
      await closed
    }
  })
})
