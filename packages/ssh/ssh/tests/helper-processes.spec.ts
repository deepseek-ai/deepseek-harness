/** Process reservations retain native cleanup ownership across stream and allocation failures. */
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import { RemoteProcesses } from '../src/helper-processes.ts'
import type { SshProcessId, SshStreamEndpoint } from '../src/schemas.ts'
import { authenticateStream } from '../src/stream-security.ts'
import { SshRpcPeer } from '../src/protocol.ts'
import { outputSnapshotSchema } from '../src/schemas.ts'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, chmod: vi.fn(actual.chmod), rm: vi.fn(actual.rm) }
})

const outcome = { exitCode: 0, signal: null }
const ordinaryRequest = { argv: ['target'], cwd: '/tmp', graceMs: 20, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } }
const terminalRequest = { argv: ['target'], cwd: '/tmp', graceMs: 20, terminal: { terminalType: 'dumb', rows: 24, cols: 80 } }

async function harness() {
  const root = await mkdtemp('/tmp/dsh-ssh-owner-')
  const ctx = new Context()
  const resolve = vi.fn(async () => ({ targetKey: root, displayPath: root }))
  const spawn = vi.fn<(spec: unknown) => SubprocessHandle>()
  const spawnTerminal = vi.fn<(spec: unknown) => Promise<SubprocessTerminalHandle>>()
  ctx.provide('fs', { resolve, processPath: () => root } as never)
  ctx.provide('subprocess', { spawn, spawnTerminal } as never)
  const owner = new RemoteProcesses(ctx, root, 1, 5000)
  const sockets = new Set<Socket>()
  const connect = async (endpoint: SshStreamEndpoint) => {
    const raw = createConnection({ path: endpoint.path, allowHalfOpen: true })
    sockets.add(raw)
    raw.on('error', () => {})
    await once(raw, 'connect')
    const socket = await authenticateStream(raw, endpoint.capability, 5000)
    sockets.add(socket)
    socket.on('error', () => {})
    return socket
  }
  const prepare = async (request: unknown) => {
    const prepared = await owner.prepare(request)
    const entries = await Promise.all(Object.entries(prepared.streams).map(async ([name, endpoint]) => [name, await connect(endpoint)]))
    const channels = Object.fromEntries(entries) as Record<string, Socket>
    return { id: prepared.id, channels }
  }
  const close = async () => {
    for (const socket of [...sockets].reverse()) socket.destroy()
    try { await owner.close() } finally { await rm(root, { recursive: true, force: true }) }
  }
  return { root, owner, resolve, spawn, spawnTerminal, prepare, close }
}

function ordinary(control = false) {
  const completion = Promise.withResolvers<SubprocessOutcome>()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const channel = control ? new PassThrough() : undefined
  const finish = () => { stdout.end(); stderr.end(); channel?.end(); completion.resolve(outcome) }
  const terminate = vi.fn(finish)
  const waitForExit = vi.fn(async () => { await completion.promise; return true })
  const handle: SubprocessHandle = {
    stdin, stdout, stderr, control: channel, collected: {}, done: completion.promise, terminate, waitForExit,
  }
  return { handle, finish, completion, stdin, stdout, stderr, channel, terminate, waitForExit }
}

function terminal() {
  const output = new PassThrough()
  const completion = Promise.withResolvers<SubprocessOutcome>()
  const write = vi.fn(async (_data: string) => {})
  const inspectForeground = vi.fn<SubprocessTerminalHandle['inspectForeground']>(async () => undefined)
  const signalForeground = vi.fn(async () => 42)
  const terminate = vi.fn(async () => { output.end(); completion.resolve(outcome) })
  const resize = vi.fn(async (_cols: number, _rows: number) => {})
  const handle: SubprocessTerminalHandle = {
    resize,
    pid: 42, output, done: completion.promise, write, inspectForeground, signalForeground, terminate,
  }
  return { handle, completion, output, write, resize, inspectForeground, signalForeground, terminate }
}

describe.skipIf(process.platform === 'win32')('SSH helper process settlement', () => {
  it('forwards terminal operations and retains a bounded completed-result cache', async () => {
    const test = await harness()
    const ids: SshProcessId[] = []
    try {
      for (let index = 0; index < 5; index++) {
        const child = terminal()
        test.spawnTerminal.mockResolvedValueOnce(child.handle)
        const run = await test.prepare({ ...terminalRequest, env: { PRESENT: 'value', REMOVED: null } })
        ids.push(run.id)
        run.channels.terminal!.end()
        run.channels.terminal!.resume()
        expect(await test.owner.start(run.id)).toEqual({ pid: 42 })
        expect(test.spawnTerminal).toHaveBeenLastCalledWith(expect.objectContaining({ env: { PRESENT: 'value' }, rows: 24, cols: 80 }))
        await expect(test.owner.start(run.id)).rejects.toThrow('already requested')
        await test.owner.terminal(run.id, 'write', 'input')
        expect(child.write).toHaveBeenCalledWith('input')
        await test.owner.resizeTerminal(run.id, 120, 40)
        expect(child.resize).toHaveBeenCalledWith(120, 40)
        expect(await test.owner.terminal(run.id, 'inspect')).toBeNull()
        child.inspectForeground.mockResolvedValueOnce({ processGroupId: 42, inputWaiting: true })
        expect(await test.owner.terminal(run.id, 'inspect')).toEqual({ processGroupId: 42, inputWaiting: true })
        expect(await test.owner.terminal(run.id, 'signal', 'SIGINT')).toBe(42)
        expect(child.signalForeground).toHaveBeenCalledWith('SIGINT')
        expect(await test.owner.wait(run.id)).toBe(true)
        await expect(test.owner.done(run.id)).resolves.toEqual({ outcome, spills: {}, collected: {} })
        await vi.waitFor(async () => { expect(await readdir(test.root)).toEqual([]) })
        expect(await test.owner.done(run.id)).toEqual({ outcome, spills: {}, collected: {} })
        expect(await test.owner.wait(run.id)).toBe(true)
        await test.owner.terminate(run.id)
      }
      await expect(test.owner.done(ids[0]!)).rejects.toThrow('Unknown or expired')
    } finally { await test.close() }
  })

  it('joins a terminal allocated after its start request is cancelled', async () => {
    const test = await harness()
    const allocated = Promise.withResolvers<SubprocessTerminalHandle>()
    const entered = Promise.withResolvers<undefined>()
    const child = terminal()
    test.spawnTerminal.mockImplementation(() => { entered.resolve(undefined); return allocated.promise })
    try {
      const run = await test.prepare(terminalRequest)
      const controller = new AbortController()
      const started = test.owner.start(run.id, controller.signal)
      const rejected = expect(started).rejects.toThrow('cancelled allocation')
      await entered.promise
      controller.abort(new Error('cancelled allocation'))
      allocated.resolve(child.handle)
      await rejected
      expect(child.terminate).toHaveBeenCalledOnce()
      await test.owner.terminate(run.id)
      expect(child.terminate).toHaveBeenCalledOnce()
    } finally { await test.close() }
  })

  it('pipes stdin bytes and distinguishes an unstarted reservation from a completed process', async () => {
    const test = await harness()
    const child = ordinary()
    test.spawn.mockReturnValue(child.handle)
    try {
      const run = await test.prepare({ ...ordinaryRequest, env: { VALUE: 'kept', REMOVED: null }, stdio: { ...ordinaryRequest.stdio, stdin: 'pipe' } })
      await expect(test.owner.done(run.id)).rejects.toThrow('has not started')
      await expect(test.owner.wait(run.id)).rejects.toThrow('was not started')
      await expect(test.owner.resizeTerminal(run.id, 80, 24)).rejects.toThrow('does not own a terminal')
      const bytes: Buffer[] = []
      child.stdin.on('data', (chunk: Buffer) => { bytes.push(Buffer.from(chunk)) })
      const ended = once(child.stdin, 'end')
      await test.owner.start(run.id)
      expect(test.spawn).toHaveBeenCalledWith(expect.objectContaining({ env: { VALUE: 'kept', REMOVED: undefined } }))
      run.channels.stdout!.end(); run.channels.stdout!.resume()
      run.channels.stderr!.end(); run.channels.stderr!.resume()
      run.channels.stdin!.end('stdin bytes')
      await ended
      expect(Buffer.concat(bytes).toString()).toBe('stdin bytes')
      await test.owner.terminate(run.id)
      expect(await test.owner.done(run.id)).toEqual({ outcome, spills: {}, collected: {} })
      expect(child.waitForExit).toHaveBeenCalled()
    } finally { await test.close() }
  })

  it('rejects a missing native control descriptor and still reaps the native process', async () => {
    const test = await harness()
    const child = ordinary()
    child.waitForExit.mockResolvedValue(true)
    test.spawn.mockImplementation(() => {
      child.completion.reject(new Error('native descriptor allocation failed'))
      return child.handle
    })
    try {
      const run = await test.prepare({ ...ordinaryRequest, stdio: { ...ordinaryRequest.stdio, control: 'pipe' } })
      await expect(test.owner.start(run.id)).rejects.toThrow('did not establish fd 7')
      await test.owner.terminate(run.id)
      expect(child.terminate).toHaveBeenCalled()
      expect(child.waitForExit).toHaveBeenCalled()
      await vi.waitFor(async () => { expect(await readdir(test.root)).toEqual([]) })
      await expect(test.owner.done(run.id)).rejects.toThrow('did not establish fd 7')
      const next = await test.owner.prepare(ordinaryRequest)
      await test.owner.terminate(next.id)
    } finally { await test.close() }
  })

  it('closes an unpublished listener when filesystem permissions cannot be established', async () => {
    const test = await harness()
    try {
      vi.mocked(chmod).mockRejectedValueOnce(Object.assign(new Error('listener chmod denied'), { code: 'EACCES' }))
      await expect(test.owner.prepare(ordinaryRequest)).rejects.toThrow('listener chmod denied')
      expect(await readdir(test.root)).toEqual([])
      const run = await test.prepare(ordinaryRequest)
      await test.owner.terminate(run.id)
      expect(await readdir(test.root)).toEqual([])
    } finally { await test.close() }
  })

  it('rolls back a listener path that exceeds the operating system socket limit', async () => {
    const root = await mkdtemp('/tmp/dsh-ssh-long-')
    const longRoot = `${root}/${'x'.repeat(140)}`
    await mkdir(longRoot)
    const owner = new RemoteProcesses(new Context(), longRoot, 1, 5000)
    try {
      await expect(owner.prepare(ordinaryRequest)).rejects.toThrow()
    } finally { await owner.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('continues collecting while a live snapshot waits for acknowledgement', async () => {
    const test = await harness()
    const child = ordinary()
    test.spawn.mockReturnValue(child.handle)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let peer: SshRpcPeer | undefined
    try {
      const run = await test.prepare({ ...ordinaryRequest, stdio: { ...ordinaryRequest.stdio, stdout: { maxBytes: 64 } } })
      peer = new SshRpcPeer(run.channels.stdout!, run.channels.stdout!, 4096, 1, async (method, raw) => {
        expect(method).toBe('snapshot')
        outputSnapshotSchema.parse(raw)
        entered.resolve(undefined)
        await release.promise
        return null
      })
      run.channels.stderr!.end(); run.channels.stderr!.resume()
      await test.owner.start(run.id)
      child.stdout.write('first')
      await entered.promise
      child.stdout.write('second')
      child.finish()
      expect(await test.owner.done(run.id)).toMatchObject({ collected: { stdout: { totalBytes: 11, tail: Buffer.from('firstsecond').toString('base64') } } })
      release.resolve(undefined)
      await vi.waitFor(async () => { expect(await readdir(test.root)).toEqual([]) })
    } finally { release.resolve(undefined); peer?.close(); await test.close() }
  })

  it('keeps final capture available after the live snapshot transport closes', async () => {
    const test = await harness()
    const child = ordinary()
    test.spawn.mockReturnValue(child.handle)
    const remoteClosed = Promise.withResolvers<undefined>()
    // The spy invokes this saved implementation with its original receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalClose = SshRpcPeer.prototype.close
    let peer: SshRpcPeer | undefined
    const observeClose = vi.spyOn(SshRpcPeer.prototype, 'close').mockImplementation(function (this: SshRpcPeer, error?: Error) {
      originalClose.call(this, error)
      if (this !== peer) remoteClosed.resolve(undefined)
    })
    try {
      const run = await test.prepare({ ...ordinaryRequest, stdio: { ...ordinaryRequest.stdio, stdout: { maxBytes: 64 } } })
      peer = new SshRpcPeer(run.channels.stdout!, run.channels.stdout!, 4096, 1, async () => null)
      run.channels.stderr!.end(); run.channels.stderr!.resume()
      await test.owner.start(run.id)
      peer.close()
      await remoteClosed.promise
      child.stdout.write('after channel loss')
      child.finish()
      expect(await test.owner.done(run.id)).toMatchObject({ collected: { stdout: {
        totalBytes: 18, tail: Buffer.from('after channel loss').toString('base64'),
      } } })
    } finally { peer?.close(); observeClose.mockRestore(); await test.close() }
  })

  it('reports a native cleanup failure instead of claiming quiescence', async () => {
    const test = await harness()
    const child = ordinary()
    child.waitForExit.mockRejectedValue(new Error('native range no longer observable'))
    test.spawn.mockReturnValue(child.handle)
    try {
      const run = await test.prepare(ordinaryRequest)
      await test.owner.start(run.id)
      await expect(test.owner.close()).rejects.toThrow('SSH remote process cleanup failed')
      expect(child.terminate).toHaveBeenCalled()
    } finally { await test.close() }
  })

  it('expires an unused reservation and prevents launch during helper shutdown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const test = await harness()
    try {
      const unused = await test.owner.prepare(ordinaryRequest)
      await vi.advanceTimersByTimeAsync(5000)
      await vi.waitFor(async () => { expect(await readdir(test.root)).toEqual([]) })
      await expect(test.owner.start(unused.id)).rejects.toThrow('Unknown or expired')
      const run = await test.prepare(ordinaryRequest)
      const started = test.owner.start(run.id)
      const rejected = expect(started).rejects.toThrow('helper is closing')
      await test.owner.close()
      await rejected
      expect(test.spawn).not.toHaveBeenCalled()
    } finally { await test.close(); vi.useRealTimers() }
  })

  it('reaps a terminal after its driver rejects completion', async () => {
    const test = await harness()
    const child = terminal()
    test.spawnTerminal.mockResolvedValue(child.handle)
    try {
      const run = await test.prepare(terminalRequest)
      await test.owner.start(run.id)
      const done = expect(test.owner.done(run.id)).rejects.toThrow('terminal driver disconnected')
      child.completion.reject(new Error('terminal driver disconnected'))
      child.output.destroy(new Error('terminal stream closed'))
      await done
      await test.owner.terminate(run.id)
      expect(child.terminate).toHaveBeenCalled()
      await vi.waitFor(async () => { expect(await readdir(test.root)).toEqual([]) })
      await expect(test.owner.done(run.id)).rejects.toThrow('terminal driver disconnected')
      const next = await test.owner.prepare(terminalRequest)
      await test.owner.terminate(next.id)
    } finally { await test.close() }
  })

  it.each(['terminate', 'close'] as const)('joins a live terminal during %s', async (operation) => {
    const test = await harness()
    const child = terminal()
    test.spawnTerminal.mockResolvedValue(child.handle)
    try {
      const run = await test.prepare(terminalRequest)
      await test.owner.start(run.id)
      if (operation === 'terminate') await test.owner.terminate(run.id)
      else await test.owner.close()
      expect(child.terminate).toHaveBeenCalled()
    } finally { await test.close() }
  })

  it('retains a failed terminal whose native owner cannot confirm cleanup', async () => {
    const test = await harness()
    const child = terminal()
    child.terminate.mockRejectedValue(new Error('terminal cleanup is unknown'))
    test.spawnTerminal.mockResolvedValue(child.handle)
    try {
      const run = await test.prepare(terminalRequest)
      await test.owner.start(run.id)
      const failed = expect(test.owner.done(run.id)).rejects.toThrow('terminal driver failed')
      child.completion.reject(new Error('terminal driver failed'))
      await failed
      await expect(test.owner.wait(run.id)).rejects.toThrow('terminal cleanup is unknown')
      await expect(test.owner.prepare(ordinaryRequest)).rejects.toThrow('capacity unavailable')
      await expect(test.owner.close()).rejects.toThrow('SSH remote process cleanup failed')
    } finally { await test.close() }
  })

  it('preserves an ordinary driver failure through direct-result and cleanup observations', async () => {
    const test = await harness()
    const child = ordinary()
    test.spawn.mockReturnValue(child.handle)
    try {
      const run = await test.prepare(ordinaryRequest)
      await test.owner.start(run.id)
      const failed = expect(test.owner.done(run.id)).rejects.toThrow('ordinary driver disconnected')
      child.completion.reject(new Error('ordinary driver disconnected'))
      child.stdout.end(); child.stderr.end()
      await failed
      await expect(test.owner.close()).rejects.toThrow('SSH remote process cleanup failed')
    } finally { await test.close() }
  })

  it('observes an expired reservation cleanup error without an unhandled rejection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const test = await harness()
    try {
      const run = await test.owner.prepare(ordinaryRequest)
      vi.mocked(rm).mockClear().mockRejectedValueOnce(new Error('temporary directory became unavailable'))
      await vi.advanceTimersByTimeAsync(5000)
      await vi.waitFor(() => { expect(rm).toHaveBeenCalledOnce() })
      await expect(test.owner.start(run.id)).rejects.toThrow('Unknown or expired')
    } finally { await test.close(); vi.useRealTimers() }
  })

  it.each(['control', 'socket'] as const)('destroys the other control endpoint after a %s failure', async (failed) => {
    const test = await harness()
    const child = ordinary(true)
    test.spawn.mockReturnValue(child.handle)
    try {
      const run = await test.prepare({ ...ordinaryRequest, stdio: { ...ordinaryRequest.stdio, stdin: 'pipe', control: 'pipe' } })
      await test.owner.start(run.id)
      run.channels.stdout!.end(); run.channels.stdout!.resume()
      run.channels.stderr!.end(); run.channels.stderr!.resume()
      child.stdin.destroy(new Error('native input pipe closed'))
      child.stdout.destroy(new Error('native output pipe closed'))
      if (failed === 'control') child.channel!.destroy(new Error('native control failed'))
      else run.channels.control!.destroy(new Error('forwarded control failed'))
      await vi.waitFor(() => { expect(child.channel!.destroyed).toBe(true) })
      await test.owner.terminate(run.id)
      await expect(test.owner.done(run.id)).resolves.toMatchObject({ outcome })
    } finally { await test.close() }
  })
})
