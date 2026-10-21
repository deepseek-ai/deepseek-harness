/** Helper leases, stream ownership and request validation over the administrative wire. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { createHelperHarness } from './fixtures/helper.ts'
import { runSshHelper } from '../src/helper.ts'
import { RemoteProcesses } from '../src/helper-processes.ts'
import { helloSchema, preparedSchema, targetSchema, writeResultSchema } from '../src/schemas.ts'
import { SSH_MAX_TEXT_STREAMS } from '../src/protocol.ts'

const entryPath = fileURLToPath(new URL('../src/helper-entry.ts', import.meta.url))
const nextSchema = z.object({ done: z.boolean(), value: z.string() })

describe.skipIf(process.platform === 'win32')('SSH helper wire and lifecycle bounds', () => {
  it('rejects unsupported hosts and cancellation before service startup', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const controller = new AbortController()
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      await expect(runSshHelper({ input, output, kind: 'node-script', entryPath, signal: controller.signal })).rejects.toThrow('POSIX host')
    } finally { platform.mockRestore() }
    controller.abort(new Error('startup cancelled'))
    try {
      await expect(runSshHelper({ input, output, kind: 'node-script', entryPath, signal: controller.signal })).rejects.toThrow('startup cancelled')
    } finally { input.destroy(); output.destroy() }
  })

  it('joins teardown when cancellation arrives while services are mounting', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const controller = new AbortController()
    const serving = runSshHelper({ input, output, kind: 'node-script', entryPath, signal: controller.signal })
    controller.abort()
    try {
      await serving
      expect(input.destroyed).toBe(true)
      expect(output.destroyed).toBe(true)
    } finally { input.destroy(); output.destroy() }
  })

  it('returns the negotiated bootstrap digest and rejects invalid handshake fields', async () => {
    const test = await createHelperHarness(false)
    try {
      for (const params of [
        { protocol: 2, workspace: test.root, leaseMs: 3000 },
        { protocol: 3, workspace: 'relative', leaseMs: 3000 },
        { protocol: 3, workspace: test.root, leaseMs: 2999 },
      ]) await expect(test.client.request('hello', params, helloSchema)).rejects.toThrow()
      const bootstrapPath = `${test.root}/bootstrap.js`
      await writeFile(bootstrapPath, 'export const identity = "test"\n')
      const facts = await test.client.request('hello', { protocol: 3, workspace: test.root, leaseMs: 3000, bootstrapPath }, helloSchema)
      expect(facts.bootstrapHash).toBe(createHash('sha256').update(await readFile(bootstrapPath)).digest('hex'))
    } finally { await test.close() }
  })

  it('refuses an external bootstrap for an executable helper', async () => {
    const test = await createHelperHarness(false, 30_000, 'executable')
    try {
      await expect(test.client.request('hello', { protocol: 3, workspace: test.root, leaseMs: 3000, bootstrapPath: '/external/process.js' }, helloSchema))
        .rejects.toThrow('embedded PTC bootstrap')
      expect((await test.hello()).kind).toBe('executable')
    } finally { await test.close() }
  })

  it('expires the client lease and joins open text streams and reserved sockets', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let test: Awaited<ReturnType<typeof createHelperHarness>> | undefined
    try {
      test = await createHelperHarness(true, 3000)
      await writeFile(`${test.root}/text`, 'pending stream')
      const target = await test.client.request('fs.resolve', { path: 'text' }, targetSchema)
      await test.client.request('fs.stream', { target }, z.string())
      const reservation = await test.client.request('process.prepare', {
        argv: ['true'], cwd: test.root, graceMs: 100,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      }, preparedSchema)
      const endpoint = reservation.streams.stdout
      expect(endpoint).toBeDefined()
      await test.client.request('heartbeat', {}, z.null())
      await vi.advanceTimersByTimeAsync(3000)
      await test.serving
      await expect(stat(test.facts!.root)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(endpoint!.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(test.client.request('heartbeat', {}, z.null())).rejects.toThrow('connection lost')
    } finally {
      try { await test?.close() }
      finally { vi.useRealTimers() }
    }
  })

  it('bounds whole-text and byte-range transfers while preserving streaming access', async () => {
    const test = await createHelperHarness()
    try {
      await writeFile(`${test.root}/large`, Buffer.alloc(8 * 1024 * 1024 + 1, 0x61))
      const target = await test.client.request('fs.resolve', { path: 'large' }, targetSchema)
      await expect(test.client.request('fs.readText', { target }, z.string())).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
      await expect(test.client.request('fs.readRange', { target, offset: 0, length: 8 * 1024 * 1024 + 1 }, z.string())).rejects.toThrow()
      const stream = await test.client.request('fs.stream', { target }, z.string())
      const next = await test.client.request('fs.next', { id: stream }, nextSchema)
      expect(next.done).toBe(false)
      expect(next.value.length).toBeGreaterThan(0)
      await test.client.request('fs.streamClose', { id: stream }, z.null())
    } finally { await test.close() }
  })

  it('enforces stream capacity before and after overlapping allocation', async () => {
    const test = await createHelperHarness()
    const bothEntered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    // oxlint-disable-next-line typescript/unbound-method -- The delayed call supplies the original service receiver.
    const original = LocalFileSystem.prototype.streamText
    const spy = vi.spyOn(LocalFileSystem.prototype, 'streamText')
    try {
      await writeFile(`${test.root}/text`, 'available')
      const target = await test.client.request('fs.resolve', { path: 'text' }, targetSchema)
      for (let index = 0; index < SSH_MAX_TEXT_STREAMS - 1; index++) {
        await test.client.request('fs.stream', { target }, z.string())
      }
      let entered = 0
      spy.mockImplementation(async function (this: LocalFileSystem, target, signal) {
        if (++entered === 2) bothEntered.resolve(undefined)
        await release.promise
        return original.call(this, target, signal)
      })
      const overlap = Promise.allSettled([
        test.client.request('fs.stream', { target }, z.string()),
        test.client.request('fs.stream', { target }, z.string()),
      ])
      await bothEntered.promise
      release.resolve(undefined)
      const overlapping = await overlap
      spy.mockRestore()
      expect(overlapping.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      const rejected = overlapping.find(result => result.status === 'rejected')
      expect(rejected?.status === 'rejected' ? rejected.reason : undefined).toMatchObject({ message: 'SSH text stream limit reached' })
      await expect(test.client.request('fs.stream', { target }, z.string())).rejects.toThrow('text stream limit')
      const created = overlapping.find(result => result.status === 'fulfilled')
      if (created?.status !== 'fulfilled') throw new Error('no stream was admitted')
      await test.client.request('fs.streamClose', { id: created.value }, z.null())
      expect(await test.client.request('fs.stream', { target }, z.string())).toBeTypeOf('string')
    } finally { release.resolve(undefined); spy.mockRestore(); await test.close() }
  })

  it('returns an iterator allocated after its remote request was cancelled', async () => {
    const test = await createHelperHarness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<AsyncIterable<string>>()
    const returned = vi.fn(() => Promise.resolve({ done: true as const, value: undefined }))
    const stream: AsyncIterable<string> = { [Symbol.asyncIterator]: () => ({ next: returned, return: returned }) }
    const spy = vi.spyOn(LocalFileSystem.prototype, 'streamText').mockImplementationOnce(() => { entered.resolve(undefined); return release.promise })
    const controller = new AbortController()
    try {
      const target = await test.client.request('fs.resolve', { path: 'delayed' }, targetSchema)
      const request = test.client.request('fs.stream', { target }, z.string(), controller.signal)
      const rejected = expect(request).rejects.toThrow('cancelled')
      await entered.promise
      controller.abort()
      await test.client.request('heartbeat', {}, z.null())
      release.resolve(stream)
      await rejected
      await expect.poll(() => returned.mock.calls.length).toBe(1)
    } finally { release.resolve(stream); spy.mockRestore(); await test.close() }
  })

  it('removes failed text iterators and reports the underlying filesystem error', async () => {
    const test = await createHelperHarness()
    try {
      const target = await test.client.request('fs.resolve', { path: 'missing' }, targetSchema)
      const id = await test.client.request('fs.stream', { target }, z.string())
      await expect(test.client.request('fs.next', { id }, nextSchema)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
      await expect(test.client.request('fs.next', { id }, nextSchema)).rejects.toThrow('Unknown SSH text stream')
    } finally { await test.close() }
  })

  it('cancels a pending iterator read and closes it before accepting another read', async () => {
    const test = await createHelperHarness()
    const entered = Promise.withResolvers<undefined>()
    const pending = Promise.withResolvers<IteratorResult<string>>()
    const returned = vi.fn(() => Promise.resolve({ done: true as const, value: undefined }))
    const spy = vi.spyOn(LocalFileSystem.prototype, 'streamText').mockImplementationOnce((_target, signal) => {
      signal!.addEventListener('abort', () => { pending.reject(signal!.reason) }, { once: true })
      let reads = 0
      return Promise.resolve({ [Symbol.asyncIterator]: () => ({
        next: () => {
          if (reads++ === 0) return Promise.resolve({ value: 'before wait' })
          entered.resolve(undefined)
          return pending.promise
        }, return: returned,
      }) })
    })
    const controller = new AbortController()
    try {
      const target = await test.client.request('fs.resolve', { path: 'pending' }, targetSchema)
      const id = await test.client.request('fs.stream', { target }, z.string())
      expect(await test.client.request('fs.next', { id }, nextSchema)).toEqual({ done: false, value: 'before wait' })
      const request = test.client.request('fs.next', { id }, nextSchema, controller.signal)
      const rejected = expect(request).rejects.toThrow('cancelled')
      await entered.promise
      controller.abort()
      await rejected
      await expect.poll(() => returned.mock.calls.length).toBe(1)
      await expect(test.client.request('fs.next', { id }, nextSchema)).rejects.toThrow('Unknown SSH text stream')
    } finally { pending.resolve({ done: true, value: undefined }); spy.mockRestore(); await test.close() }
  })

  it('reports cleanup failure through the serving lifetime after transport loss', async () => {
    const test = await createHelperHarness()
    const failure = new Error('native process range cleanup failed')
    const close = vi.spyOn(RemoteProcesses.prototype, 'close').mockRejectedValueOnce(failure)
    try {
      const rejected = expect(test.serving).rejects.toBe(failure)
      test.controller.abort()
      await rejected
      await expect(stat(test.facts!.root)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { close.mockRestore(); await expect(test.close()).rejects.toBe(failure) }
  })

  it('validates explicit physical writable roots over the wire without granting aliases', async () => {
    const base = await realpath(await mkdtemp(join(homedir(), '.dsh-ssh-policy-')))
    onTestFinished(() => rm(base, { recursive: true, force: true }))
    const test = await createHelperHarness()
    onTestFinished(() => test.close())
    const workspace = join(base, 'workspace')
    const extra = join(base, 'extra')
    const outside = join(base, 'outside')
    const alias = join(base, 'alias')
    await mkdir(workspace)
    await mkdir(extra)
    await mkdir(outside)
    await symlink(extra, alias, 'dir')
    const target = (path: string) => ({ targetKey: path, displayPath: path })
    const policy = { mode: 'workspace-write' as const, workspaceRoot: workspace, additionalWritableRoots: [extra, extra], sessionId: 'ssh-extra-grant' }
    try {
      const written = await test.client.request('fs.write', {
        target: target(join(extra, 'allowed.txt')), content: 'ok', policy,
      }, writeResultSchema)
      expect(written.operation).toBe('create')
      expect(await readFile(join(extra, 'allowed.txt'), 'utf8')).toBe('ok')
      await expect(test.client.request('fs.write', {
        target: target(join(workspace, 'empty-roots.txt')), content: 'ok', policy: { ...policy, additionalWritableRoots: [] },
      }, writeResultSchema)).resolves.toMatchObject({ operation: 'create' })

      await expect(test.client.request('fs.write', {
        target: target(join(extra, 'alias.txt')), content: 'no', policy: { ...policy, additionalWritableRoots: [alias] },
      }, writeResultSchema)).rejects.toThrow('use the physical directory path')

      // A sibling directory is still denied under the same widened policy.
      await expect(test.client.request('fs.write', {
        target: target(join(outside, 'denied.txt')), content: 'no', policy,
      }, writeResultSchema)).rejects.toThrow(/workspace-write/u)

      // Absence of the extra root denies the same target.
      await expect(test.client.request('fs.write', {
        target: target(join(extra, 'baseline.txt')), content: 'no',
        policy: { mode: 'workspace-write', workspaceRoot: workspace },
      }, writeResultSchema)).rejects.toThrow(/workspace-write/u)

      // Read-only grants nothing even when the extra roots arrive on the wire.
      await expect(test.client.request('fs.write', {
        target: target(join(extra, 'readonly.txt')), content: 'no',
        policy: { mode: 'read-only', workspaceRoot: workspace, additionalWritableRoots: [alias] },
      }, writeResultSchema)).rejects.toThrow(/read-only/u)

      // The strict decoder rejects a relative execution-world root.
      await expect(test.client.request('fs.write', {
        target: target(join(extra, 'relative.txt')), content: 'no',
        policy: { ...policy, additionalWritableRoots: ['relative'] },
      }, writeResultSchema)).rejects.toThrow()
    } finally {
      await test.close()
      await rm(base, { recursive: true, force: true })
    }
  })

  it('routes process and terminal lifecycle operations while rejecting unknown ids', async () => {
    const test = await createHelperHarness()
    try {
      const prepared = await test.client.request('process.prepare', {
        argv: ['true'], cwd: test.root, graceMs: 100,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      }, preparedSchema)
      for (const method of ['terminal.write', 'terminal.inspect', 'terminal.signal']) {
        await expect(test.client.request(method, { id: prepared.id, value: 'x' }, z.unknown())).rejects.toThrow('does not own a terminal')
      }
      await test.client.request('process.terminate', { id: prepared.id }, z.null())
      for (const method of ['process.start', 'process.done', 'process.wait', 'process.terminate']) {
        await expect(test.client.request(method, { id: randomUUID() }, z.unknown())).rejects.toThrow('Unknown or expired SSH process handle')
      }
      await expect(test.client.request('process.wait', { id: 'malformed' }, z.unknown())).rejects.toThrow()
    } finally { await test.close() }
  })
})
