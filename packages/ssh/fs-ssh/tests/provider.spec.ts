import { Context, Service } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import { FsError, FsTargetKey, FsVersion, type FsTarget } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { RemoteOperationError } from '@deepseek-ai/dsh-ssh/protocol'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { SshFileSystem } from '../src/index.ts'

type Dispatch = (method: string, params: unknown, signal?: AbortSignal) => Promise<unknown>
const target: FsTarget = { targetKey: FsTargetKey('/remote/work/file.txt'), displayPath: 'file.txt' }
const streamId = '00000000-0000-4000-8000-000000000001'

async function setup() {
  const dispatch = vi.fn<Dispatch>()
  class WireConnection extends Service {
    constructor(ctx: Context) { super(ctx, 'ssh') }
    async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
      return result.parse(await dispatch(method, params, signal))
    }
  }
  class Policy extends Service {
    readonly defaultMode = 'read-only'
    constructor(ctx: Context) { super(ctx, 'sandboxPolicy') }
    resolve(): SandboxExecutionPolicy { return { mode: 'read-only', workspaceRoot: '/remote/work' } }
  }
  const ctx = new Context()
  const fibers = [await ctx.plugin(WireConnection), await ctx.plugin(Policy), await ctx.plugin(SshFileSystem)]
  onTestFinished(async () => { for (const fiber of fibers.reverse()) await fiber.dispose() })
  return { fs: ctx.fs, dispatch }
}

describe('SSH filesystem provider', () => {
  it('declares watching unsupported without sending a remote request', async () => {
    const { fs, dispatch } = await setup()
    await expect(fs.watch(target, vi.fn(), new AbortController().signal))
      .rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it.each([
    ['literal%20name.ts', 'literal%2520name.ts'],
    ['back\\slash.ts', 'back%5Cslash.ts'],
    ['line\nfeed.ts', 'line%0Afeed.ts'],
  ])('preserves the POSIX filename %j in a file URL', async (name, encoded) => {
    const { fs } = await setup()
    const path = `/remote/work/${name}`
    const url = fs.fileUrl({ targetKey: FsTargetKey(path), displayPath: path })
    expect(url).toBe(`file:///remote/work/${encoded}`)
    expect(fileURLToPath(url)).toBe(path)
  })

  it('keeps remote canonical paths and sends relative spelling to the remote resolver', async () => {
    const { fs, dispatch } = await setup()
    dispatch.mockResolvedValue({ targetKey: '/remote/physical/file #?.txt', displayPath: 'link/../file #?.txt' })
    const signal = new AbortController().signal
    const resolved = await fs.resolve('link/../file #?.txt', { cwd: '/remote/work', signal })
    expect(dispatch).toHaveBeenCalledWith('fs.resolve', { path: 'link/../file #?.txt', cwd: '/remote/work' }, signal)
    expect(fs.processPath(resolved)).toBe('/remote/physical/file #?.txt')
    expect(fs.fileUrl(resolved)).toBe('file:///remote/physical/file%20%23%3F.txt')
    expect(fs.processPathFromHostPath('/host/private/bootstrap.js')).toBeUndefined()
    await fs.resolve('file.txt')
    expect(dispatch).toHaveBeenLastCalledWith('fs.resolve', { path: 'file.txt', cwd: undefined }, undefined)
    expect(fs.sandboxMode).toBe('read-only')
  })

  it('compares POSIX canonical identities without accepting a sibling prefix', async () => {
    const { fs } = await setup()
    const makeTarget = (path: string): FsTarget => ({ targetKey: FsTargetKey(path), displayPath: path })
    const root = makeTarget('/remote/work')
    expect(fs.contains(root, root)).toBe(true)
    expect(fs.contains(root, target)).toBe(true)
    expect(fs.contains(root, makeTarget('/remote/work-other/file'))).toBe(false)
    expect(fs.contains(root, makeTarget('/remote'))).toBe(false)
    expect(fs.contains(root, makeTarget('/outside/file'))).toBe(false)
  })

  it('preserves metadata, final symlinks, directory entries and missing observations', async () => {
    const { fs, dispatch } = await setup()
    const info = { version: 'v1', type: 'file', size: 7 }
    const link = { version: 'link-v1', type: 'symlink', size: 8 }
    const entries = [{ name: 'file.txt', type: 'file', target, version: 'v1', size: 7 }]
    dispatch.mockResolvedValueOnce(info).mockResolvedValueOnce(null).mockResolvedValueOnce(link).mockResolvedValueOnce(null)
      .mockResolvedValueOnce(entries)
    expect(await fs.stat(target)).toEqual(info)
    expect(await fs.stat(target)).toBeUndefined()
    expect(await fs.lstat('link', { cwd: '/remote/work' })).toEqual(link)
    expect(await fs.lstat('missing')).toBeUndefined()
    expect(await fs.listDir(target)).toEqual(entries)
    expect(dispatch.mock.calls[2]).toEqual(['fs.lstat', { path: 'link', cwd: '/remote/work' }, undefined])
  })

  it('decodes binary responses and retains caller-owned read limits', async () => {
    const { fs, dispatch } = await setup()
    const bytes = Buffer.from([0, 255, 128, 10])
    dispatch.mockResolvedValueOnce('remote text').mockResolvedValueOnce(bytes.toString('base64'))
      .mockResolvedValueOnce(bytes.subarray(1, 3).toString('base64'))
    expect(await fs.readText(target)).toBe('remote text')
    expect(await fs.readBytes(target, undefined, 64)).toEqual(bytes)
    expect(await fs.readByteRange(target, { offset: 1, length: 2 })).toEqual(bytes.subarray(1, 3))
    expect(dispatch.mock.calls[1]).toEqual(['fs.readBytes', { target, maxBytes: 64 }, undefined])
    expect(dispatch.mock.calls[2]).toEqual(['fs.readRange', { target, offset: 1, length: 2 }, undefined])
  })

  it('forwards mutation guards and explicit per-call policy without normalizing remote roots', async () => {
    const { fs, dispatch } = await setup()
    const written = { operation: 'update', version: 'v2', before: 'old', after: 'new' }
    const edited = { version: 'v3', before: 'new', after: 'next' }
    dispatch.mockResolvedValueOnce(written).mockResolvedValueOnce(edited)
    const signal = new AbortController().signal
    const policy: SandboxExecutionPolicy = { mode: 'workspace-write', workspaceRoot: '/remote/link/..' }
    const expected = { kind: 'replaceIfVersion' as const, version: FsVersion('v1') }
    const edit = { oldString: 'new', newString: 'next', replaceAll: false }
    expect(await fs.writeText(target, 'new', expected, signal, policy)).toEqual(written)
    expect(dispatch).toHaveBeenLastCalledWith('fs.write', { target, content: 'new', expected, policy }, signal)
    expect(await fs.editText(target, edit, { version: FsVersion('v2') }, signal, policy)).toEqual(edited)
    expect(dispatch).toHaveBeenLastCalledWith('fs.edit', { target, edit, expected: { version: 'v2' }, policy }, signal)
  })

  it('resolves deployment policy for mutations without an explicit policy', async () => {
    const { fs, dispatch } = await setup()
    dispatch.mockResolvedValueOnce({ operation: 'create', version: 'v1', before: null, after: 'new' })
      .mockResolvedValueOnce({ version: 'v2', before: 'new', after: 'next' })
    await fs.writeText(target, 'new', { kind: 'createIfAbsent' })
    await fs.editText(target, { oldString: 'new', newString: 'next', replaceAll: true })
    for (const [, params] of dispatch.mock.calls) expect(params).toMatchObject({ policy: { mode: 'read-only', workspaceRoot: '/remote/work' } })
  })

  it('pulls text through completion without an unnecessary close request', async () => {
    const { fs, dispatch } = await setup()
    dispatch.mockResolvedValueOnce(streamId).mockResolvedValueOnce({ done: false, value: '' })
      .mockResolvedValueOnce({ done: false, value: 'first' }).mockResolvedValueOnce({ done: true, value: 'last' })
    const chunks: string[] = []
    for await (const chunk of await fs.streamText(target)) chunks.push(chunk)
    expect(chunks).toEqual(['first', 'last'])
    expect(dispatch.mock.calls.map(([method]) => method)).toEqual(['fs.stream', 'fs.next', 'fs.next', 'fs.next'])
  })

  it.each([false, true])('closes the remote iterator after an early consumer stop (close fails: %s)', async (closeFails) => {
    const { fs, dispatch } = await setup()
    dispatch.mockResolvedValueOnce(streamId).mockResolvedValueOnce({ done: false, value: 'first' })
    if (closeFails) dispatch.mockRejectedValueOnce(new Error('connection lost'))
    else dispatch.mockResolvedValueOnce(null)
    for await (const chunk of await fs.streamText(target)) { expect(chunk).toBe('first'); break }
    expect(dispatch).toHaveBeenLastCalledWith('fs.streamClose', { id: streamId }, undefined)
  })

  it('closes the remote iterator when its signal aborts between pulls', async () => {
    const { fs, dispatch } = await setup()
    dispatch.mockResolvedValueOnce(streamId).mockResolvedValueOnce({ done: false, value: 'first' }).mockResolvedValueOnce(null)
    const controller = new AbortController()
    const iterator = (await fs.streamText(target, controller.signal))[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ done: false, value: 'first' })
    controller.abort(new Error('cancel text stream'))
    await expect(iterator.next()).rejects.toThrow('cancel text stream')
    expect(dispatch).toHaveBeenLastCalledWith('fs.streamClose', { id: streamId }, undefined)
  })

  it('closes a remote iterator after a malformed pull response', async () => {
    const { fs, dispatch } = await setup()
    dispatch.mockResolvedValueOnce(streamId).mockResolvedValueOnce({ done: false, value: 1 }).mockResolvedValueOnce(null)
    const iterator = (await fs.streamText(target))[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    expect(dispatch).toHaveBeenLastCalledWith('fs.streamClose', { id: streamId }, undefined)
  })

  it.each(['FS_STALE_VERSION', 'FS_SANDBOX_DENIED', 'FS_NOT_OBSERVED'] as const)('preserves remote %s failures', async (code) => {
    const { fs, dispatch } = await setup()
    const cause = new RemoteOperationError('remote mutation rejected', code)
    dispatch.mockRejectedValueOnce(cause)
    await expect(fs.writeText(target, 'new')).rejects.toMatchObject({ code, message: cause.message, cause })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, 'OTHER_ERROR', 'FS_UNKNOWN_REMOTE_CODE'])('maps an unrecognized remote error code %s to I/O failure', async (code) => {
    const { fs, dispatch } = await setup()
    dispatch.mockRejectedValueOnce(new RemoteOperationError('unrecognized failure', code))
    await expect(fs.readText(target)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  })

  it('reports a cancelled remote request without retrying its mutation', async () => {
    const { fs, dispatch } = await setup()
    const controller = new AbortController()
    dispatch.mockImplementationOnce(async () => { controller.abort(); throw new Error('request cancelled') })
    await expect(fs.writeText(target, 'new', undefined, controller.signal)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('preserves a primitive AbortSignal reason as a filesystem cancellation', async () => {
    const { fs, dispatch } = await setup()
    const signal = AbortSignal.abort('caller cancelled')
    dispatch.mockImplementationOnce(async (_method, _params, cancellation) => { cancellation?.throwIfAborted() })
    await expect(fs.readText(target, signal)).rejects.toMatchObject({ code: 'FS_ABORTED', message: 'caller cancelled' })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it.each([null, { targetKey: 'relative', displayPath: 'file' }, { targetKey: '/remote/file', displayPath: 1 }])(
    'rejects malformed target observations from the wire', async (raw) => {
      const { fs, dispatch } = await setup()
      dispatch.mockResolvedValueOnce(raw)
      await expect(fs.resolve('file')).rejects.toBeInstanceOf(FsError)
    },
  )
})
