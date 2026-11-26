import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { serveConnection } from '../src/daemon.ts'
import { ENVIRONMENT_PROTOCOL_VERSION, RpcPeer } from '../src/protocol.ts'
import { shipped } from './fixtures/definitions.ts'

const spawn = vi.hoisted(() => vi.fn<typeof import('node:child_process').spawn>())
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(), spawn,
}))
let input: PassThrough | undefined
let closed: Promise<Error> | undefined
let child: ChildProcessWithoutNullStreams | undefined
afterEach(async () => {
  input?.end()
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, 'close')
    child.kill('SIGKILL')
    await stopped
  }
  await closed
  vi.restoreAllMocks()
  input = undefined
  closed = undefined
  child = undefined
  spawn.mockReset()
})

it('ignores subsequent output after the execution output limit is exceeded', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const processHandle = child = actual.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  await once(processHandle, 'spawn')
  const kill = vi.spyOn(process, 'kill')
  const started = Promise.withResolvers<undefined>()
  spawn.mockImplementation(() => { started.resolve(undefined); return processHandle })
  const toDaemon = input = new PassThrough()
  const toHost = new PassThrough()
  closed = serveConnection({ input: toDaemon, output: toHost, mechanisms: ['transport'], authTimeoutMs: 1000 })
  const peer = new RpcPeer(toHost, toDaemon, { maxFrameBytes: 4096, maxMessageBytes: 4096, maxPending: 4, cancelGraceMs: 1000 })
  await peer.request('auth', { protocol: ENVIRONMENT_PROTOCOL_VERSION, mechanisms: ['transport'], limits: {
    maxFrameBytes: 4096, maxMessageBytes: 4096, maxPending: 4, cancelGraceMs: 1000, killGraceMs: 100,
  } })
  const run = peer.request('run', { run: 1, ...shipped('(_args, env) => env.exec(["controlled-process"])'), args: null })
  const rejected = expect(run).rejects.toThrow('exec output exceeds 4096 bytes')
  await started.promise
  processHandle.stdout.emit('data', Buffer.alloc(4097))
  processHandle.stderr.emit('data', Buffer.from('late stderr'))
  processHandle.stdout.emit('data', Buffer.from('late stdout'))
  await rejected
  expect(kill).toHaveBeenCalledExactlyOnceWith(-processHandle.pid!, 'SIGKILL')
})
