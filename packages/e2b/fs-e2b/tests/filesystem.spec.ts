import { Buffer } from 'node:buffer'
import { dirname, posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  CommandExitError,
  FileNotFoundError,
  FileType,
  type EntryInfo,
  type Sandbox,
} from '@deepseek-ai/dsh-e2b'
import type E2BRuntime from '@deepseek-ai/dsh-e2b'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import E2BFileSystem from '@deepseek-ai/dsh-fs-e2b'
import { describe, expect, it, vi } from 'vitest'

interface RemoteNode {
  type: FileType
  data: Uint8Array
  mode: number
  modified: number
  metadata?: Record<string, string>
  symlinkTarget?: string
}

function bytes(value: string | readonly number[]): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value)
}

function commandError(exitCode: number, stderr = ''): CommandExitError {
  return new CommandExitError({ exitCode, stdout: '', stderr, error: stderr })
}

class FakeRemote {
  readonly nodes = new Map<string, RemoteNode>()
  readonly writes: Array<{ path: string; data: string; metadata?: Record<string, string> }> = []
  readonly writeParentModes: number[] = []
  readonly renames: Array<{ from: string; to: string }> = []
  readonly links: Array<{ from: string; to: string }> = []
  readonly removals: string[] = []
  readonly commands: string[] = []
  readonly reads: Array<{ path: string; format: 'bytes' | 'stream' }> = []
  streamChunks: Uint8Array[] | undefined
  streamKeepOpen = false
  readonly streamCancel = vi.fn()
  nextCommandError: unknown
  nextMakeDirResult: boolean | undefined
  nextInfoError: unknown
  nextListError: unknown
  nextReadError: unknown
  nextRenameError: unknown
  nextRemoveError: unknown
  canonicalOutput: string | undefined
  abortAfterRename: AbortController | undefined
  competitorBeforeLink:
    | { path: string; kind: 'file'; data: string }
    | { path: string; kind: 'directory' }
    | undefined
  guardedLinkOutput: string | undefined
  disappearOnInfo = new Set<string>()
  private clock = 1

  constructor() {
    this.dir('/')
    this.dir('/workspace')
  }

  dir(path: string): void {
    this.nodes.set(path, { type: FileType.DIR, data: bytes(''), mode: 0o755, modified: this.clock++ })
  }

  file(path: string, data: string | readonly number[], mode = 0o644): void {
    this.nodes.set(path, { type: FileType.FILE, data: bytes(data), mode, modified: this.clock++ })
  }

  other(path: string): void {
    this.nodes.set(path, { type: 'other' as FileType, data: bytes(''), mode: 0o600, modified: this.clock++ })
  }

  symlink(path: string, target: string): void {
    this.nodes.set(path, {
      type: FileType.FILE,
      data: bytes(''),
      mode: 0o777,
      modified: this.clock++,
      symlinkTarget: target,
    })
  }

  mutate(path: string, data: string): void {
    const node = this.required(path)
    node.data = bytes(data)
    node.modified = this.clock++
  }

  private required(path: string): RemoteNode {
    const node = this.nodes.get(path)
    if (node === undefined) throw new FileNotFoundError(`missing: ${path}`)
    return node
  }

  private followed(path: string): { path: string; node: RemoteNode; link?: RemoteNode } {
    const node = this.required(path)
    if (node.symlinkTarget === undefined) return { path, node }
    return { path: node.symlinkTarget, node: this.required(node.symlinkTarget), link: node }
  }

  private info(path: string): EntryInfo {
    if (this.disappearOnInfo.delete(path)) throw new FileNotFoundError(`missing: ${path}`)
    return this.rawInfo(path)
  }

  private rawInfo(path: string): EntryInfo {
    const followed = this.followed(path)
    const node = followed.node
    return {
      name: posix.basename(path),
      path,
      type: node.type,
      size: node.data.byteLength,
      mode: node.mode,
      permissions: 'rw-------',
      owner: 'user',
      group: 'user',
      modifiedTime: new Date(node.modified),
      ...(node.metadata !== undefined ? { metadata: { ...node.metadata } } : {}),
      ...(followed.link?.symlinkTarget !== undefined ? { symlinkTarget: followed.link.symlinkTarget } : {}),
    }
  }

  private checkAbort(options: { signal?: AbortSignal } | undefined): void {
    if (options?.signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
  }

  readonly sandbox = {
    sandboxId: 'fake',
    files: {
      makeDir: async (path: string, options?: { signal?: AbortSignal }): Promise<boolean> => {
        this.checkAbort(options)
        if (this.nextMakeDirResult !== undefined) {
          const result = this.nextMakeDirResult
          this.nextMakeDirResult = undefined
          return result
        }
        if (this.nodes.has(path)) return false
        this.dir(path)
        return true
      },
      getInfo: async (path: string, options?: { signal?: AbortSignal }): Promise<EntryInfo> => {
        this.checkAbort(options)
        if (this.nextInfoError !== undefined) {
          const error = this.nextInfoError
          this.nextInfoError = undefined
          throw error
        }
        return this.info(path)
      },
      read: async (path: string, options: { format: 'bytes' | 'stream'; signal?: AbortSignal }): Promise<Uint8Array | ReadableStream<Uint8Array> | string> => {
        this.checkAbort(options)
        this.reads.push({ path, format: options.format })
        if (this.nextReadError !== undefined) {
          const error = this.nextReadError
          this.nextReadError = undefined
          throw error
        }
        const data = this.followed(path).node.data
        if (options.format === 'bytes') return data.slice()
        // Pinned-SDK fidelity: a content-length-0 response returns '' even in stream format.
        if (data.length === 0 && this.streamChunks === undefined) return ''
        const chunks = this.streamChunks ?? [data.slice()]
        return new ReadableStream<Uint8Array>({
          start: (controller) => {
            for (const chunk of chunks) controller.enqueue(chunk)
            if (!this.streamKeepOpen) controller.close()
          },
          cancel: () => { this.streamCancel() },
        })
      },
      list: async (path: string, options?: { depth?: number; signal?: AbortSignal }): Promise<EntryInfo[]> => {
        this.checkAbort(options)
        if (this.nextListError !== undefined) {
          const error = this.nextListError
          this.nextListError = undefined
          throw error
        }
        this.required(path)
        return [...this.nodes.keys()]
          .filter(candidate => candidate !== path && dirname(candidate) === path)
          .map(candidate => this.rawInfo(candidate))
      },
      write: async (path: string, data: string, options?: { metadata?: Record<string, string>; signal?: AbortSignal }): Promise<object> => {
        this.checkAbort(options)
        const parent = dirname(path)
        if (!this.nodes.has(parent)) this.dir(parent)
        this.writeParentModes.push(this.required(parent).mode)
        this.nodes.set(path, {
          type: FileType.FILE,
          data: bytes(data),
          mode: 0o644,
          modified: this.clock++,
          ...(options?.metadata !== undefined ? { metadata: { ...options.metadata } } : {}),
        })
        this.writes.push({ path, data, ...(options?.metadata !== undefined ? { metadata: options.metadata } : {}) })
        return {}
      },
      rename: async (from: string, to: string, options?: { signal?: AbortSignal }): Promise<EntryInfo> => {
        this.checkAbort(options)
        if (this.nextRenameError !== undefined) {
          const error = this.nextRenameError
          this.nextRenameError = undefined
          throw error
        }
        const node = this.required(from)
        this.nodes.delete(from)
        this.nodes.set(to, node)
        this.renames.push({ from, to })
        this.abortAfterRename?.abort('after commit')
        this.checkAbort(options)
        return this.info(to)
      },
      remove: async (path: string): Promise<void> => {
        this.removals.push(path)
        if (this.nextRemoveError !== undefined) {
          const error = this.nextRemoveError
          this.nextRemoveError = undefined
          throw error
        }
        for (const candidate of this.nodes.keys()) {
          if (candidate === path || candidate.startsWith(`${path}/`)) this.nodes.delete(candidate)
        }
      },
    },
    commands: {
      run: async (
        command: string,
        options?: { envs?: Record<string, string>; signal?: AbortSignal },
      ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
        this.checkAbort(options)
        const home = options?.envs?.HOME
        expect(home).toMatch(/^\/\.dsh-e2b-control-/)
        expect(options?.envs).toEqual({ HOME: home })
        this.commands.push(command)
        if (this.nextCommandError !== undefined) {
          const error = this.nextCommandError
          this.nextCommandError = undefined
          throw error
        }
        const realpathPrefix = 'set -o pipefail; realpath -mz -- '
        const realpathSuffix = ' | base64 -w0'
        if (command.startsWith(realpathPrefix) && command.endsWith(realpathSuffix)) {
          const quoted = command.slice(realpathPrefix.length, -realpathSuffix.length)
          const input = quoted.slice(1, -1).replaceAll(String.raw`'"'"'`, '\'')
          const node = this.nodes.get(input)
          const canonical = `${node?.symlinkTarget ?? input}\0`
          return {
            exitCode: 0,
            stdout: this.canonicalOutput ?? Buffer.from(canonical).toString('base64'),
            stderr: '',
          }
        }
        const chmod = /^chmod ([0-7]+) -- '([^']+)'$/.exec(command)
        if (chmod !== null) this.required(chmod[2]!).mode = Number.parseInt(chmod[1]!, 8)
        const guardedLink = new RegExp(
          "^if ln -T -- '([^']+)' '([^']+)'; then printf created; "
          + "elif test -e '[^']+' \\|\\| test -L '[^']+'; then printf exists; else exit 1; fi$",
        ).exec(command)
        if (guardedLink !== null) {
          const from = guardedLink[1]!
          const to = guardedLink[2]!
          if (this.guardedLinkOutput !== undefined) {
            const stdout = this.guardedLinkOutput
            this.guardedLinkOutput = undefined
            return { exitCode: 0, stdout, stderr: '' }
          }
          if (this.competitorBeforeLink?.path === to) {
            if (this.competitorBeforeLink.kind === 'directory') this.dir(to)
            else this.file(to, this.competitorBeforeLink.data)
            this.competitorBeforeLink = undefined
          }
          if (this.nodes.has(to)) return { exitCode: 0, stdout: 'exists', stderr: '' }
          this.nodes.set(to, this.required(from))
          this.links.push({ from, to })
          this.abortAfterRename?.abort('after commit')
          return { exitCode: 0, stdout: 'created', stderr: '' }
        }
        const move = /^mv -f -- '([^']+)' '([^']+)'$/.exec(command)
        if (move !== null) {
          if (this.nextRenameError !== undefined) {
            const error = this.nextRenameError
            this.nextRenameError = undefined
            throw error
          }
          const node = this.required(move[1]!)
          this.nodes.delete(move[1]!)
          this.nodes.set(move[2]!, node)
          this.renames.push({ from: move[1]!, to: move[2]! })
          this.abortAfterRename?.abort('after commit')
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
  } as unknown as Sandbox
}

async function setup(remote = new FakeRemote()): Promise<{ ctx: Context; fs: E2BFileSystem; remote: FakeRemote }> {
  const ctx = new Context()
  const runtime = {
    cwd: '/workspace',
    runtimeRoot: '/workspace/.dsh-e2b',
    getSandbox: async () => remote.sandbox,
  } as unknown as E2BRuntime
  ctx.provide('e2b', runtime)
  await ctx.plugin(E2BFileSystem)
  return { ctx, fs: ctx.fs as E2BFileSystem, remote }
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code })
}

describe('E2BFileSystem identity, metadata, and reads', () => {
  it('resolves remote paths, reports symlinks, and lists direct children in stable order', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/z.txt', 'z')
    remote.file('/workspace/a.txt', 'a')
    remote.dir('/workspace/dir')
    remote.other('/workspace/special')
    remote.file('/workspace/dir/nested.txt', 'nested')
    remote.symlink('/workspace/link.txt', '/workspace/a.txt')
    const { fs } = await setup(remote)

    const link = await fs.resolve('link.txt')
    expect(link).toEqual({ targetKey: '/workspace/a.txt', displayPath: '/workspace/link.txt' })
    await expect(fs.lstat('link.txt')).resolves.toMatchObject({ type: 'symlink', size: 1 })
    await expect(fs.lstat('a.txt')).resolves.toMatchObject({ type: 'file', size: 1 })
    await expect(fs.lstat('dir')).resolves.toEqual(expect.objectContaining({ type: 'directory' }))
    await expect(fs.lstat('special')).resolves.toEqual(expect.objectContaining({ type: 'other' }))
    await expect(fs.lstat('missing')).resolves.toBeUndefined()
    await expect(fs.stat(link)).resolves.toMatchObject({ type: 'file', size: 1 })
    const directory = await fs.resolve('.')
    const listed = await fs.listDir(directory)
    expect(listed.map(entry => entry.name)).toEqual(['a.txt', 'dir', 'link.txt', 'special', 'z.txt'])
    expect(listed.find(entry => entry.name === 'dir')).toMatchObject({ type: 'directory' })
    expect(listed.find(entry => entry.name === 'link.txt')).toMatchObject({
      type: 'file',
      target: { targetKey: '/workspace/a.txt', displayPath: '/workspace/link.txt' },
    })
    expect(listed.some(entry => entry.name === 'nested.txt')).toBe(false)
  })

  it('projects canonical process paths, file URLs, and containment', async () => {
    const remote = new FakeRemote()
    remote.dir('/workspace/nested')
    remote.file('/workspace/nested/multibyte # file.ts', 'text')
    remote.file('/outside.ts', 'outside')
    const { fs } = await setup(remote)
    const workspace = await fs.resolve('/workspace')
    const nested = await fs.resolve('/workspace/nested/multibyte # file.ts')
    const outside = await fs.resolve('/outside.ts')

    expect(fs.processPath(nested)).toBe('/workspace/nested/multibyte # file.ts')
    expect(fs.processPathFromHostPath('/Users/alice/.dsh/attachments/object')).toBeUndefined()
    expect(fs.fileUrl(nested)).toBe('file:///workspace/nested/multibyte%20%23%20file.ts')
    expect(fs.contains(workspace, workspace)).toBe(true)
    expect(fs.contains(workspace, nested)).toBe(true)
    expect(fs.contains(nested, workspace)).toBe(false)
    expect(fs.contains(workspace, outside)).toBe(false)
    expect(() => fs.fileUrl({ targetKey: FsTargetKey('relative'), displayPath: 'relative' }))
      .toThrow('expected an absolute process path')
  })

  it('preserves newline and multibyte canonical paths through strict ASCII framing', async () => {
    const remote = new FakeRemote()
    const path = '/workspace/你好\nfile.ts'
    remote.file(path, 'text')
    const { fs } = await setup(remote)

    await expect(fs.resolve(path)).resolves.toEqual({ targetKey: path, displayPath: path })
  })

  it.each([
    ['invalid base64', '!!!!'],
    ['missing terminator', Buffer.from('/workspace/file').toString('base64')],
    ['multiple records', Buffer.from('/workspace/file\0/other\0').toString('base64')],
    ['invalid UTF-8', Buffer.from([47, 0xff, 0]).toString('base64')],
    ['relative path', Buffer.from('workspace/file\0').toString('base64')],
  ])('rejects %s from canonical path transport', async (_label, output) => {
    const remote = new FakeRemote()
    remote.canonicalOutput = output
    const { fs } = await setup(remote)
    await expectCode(fs.resolve('file'), 'FS_IO_ERROR')
  })

  it('reads whole and streamed UTF-8 across chunk boundaries', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/text.txt', 'A€B')
    remote.streamChunks = [bytes([65, 0xe2]), bytes([0x82, 0xac, 66])]
    const { fs } = await setup(remote)
    const target = await fs.resolve('text.txt')
    await expect(fs.readText(target)).resolves.toBe('A€B')
    let streamed = ''
    for await (const chunk of await fs.streamText(target)) streamed += chunk
    expect(streamed).toBe('A€B')

    remote.streamChunks = [bytes([0xe2]), bytes([0x82, 0xac])]
    let initiallyBuffered = ''
    for await (const chunk of await fs.streamText(target)) initiallyBuffered += chunk
    expect(initiallyBuffered).toBe('€')
  })

  it('streams an empty file even though the pinned SDK returns a non-stream value', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/empty.txt', '')
    const { fs } = await setup(remote)
    let streamed = ''
    for await (const chunk of await fs.streamText(await fs.resolve('empty.txt'))) streamed += chunk
    expect(streamed).toBe('')
  })

  it('cancels a remote stream when its consumer stops early', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/text.txt', 'ab')
    remote.streamChunks = [bytes('a'), bytes('b')]
    remote.streamKeepOpen = true
    const { fs } = await setup(remote)
    const stream = await fs.streamText(await fs.resolve('text.txt'))

    for await (const chunk of stream) {
      expect(chunk).toBe('a')
      break
    }

    expect(remote.streamCancel).toHaveBeenCalledOnce()
  })

  it('matches local binary sampling while edits still reject any NUL byte', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/late-nul.txt', `${'a'.repeat(8192)}\0tail`)
    const { fs } = await setup(remote)
    const target = await fs.resolve('late-nul.txt')
    await expect(fs.readText(target)).resolves.toContain('\0tail')
    remote.streamChunks = [bytes('a'.repeat(8192)), bytes([0, 116])]
    let streamed = ''
    for await (const chunk of await fs.streamText(target)) streamed += chunk
    expect(streamed).toBe(`${'a'.repeat(8192)}\0t`)
    await expectCode(fs.editText(target, { oldString: 'tail', newString: 'end', replaceAll: false }), 'FS_NOT_TEXT')
  })

  it('maps binary, invalid UTF-8, missing, and non-regular read failures', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/binary', [0, 1])
    remote.file('/workspace/invalid', [0xff])
    remote.dir('/workspace/directory')
    const { fs } = await setup(remote)
    await expectCode(fs.readText(await fs.resolve('binary')), 'FS_NOT_TEXT')
    await expectCode(fs.readText(await fs.resolve('invalid')), 'FS_NOT_TEXT')
    await expectCode(fs.readText(await fs.resolve('missing')), 'FS_NOT_FOUND')
    await expectCode(fs.readText(await fs.resolve('directory')), 'FS_NOT_REGULAR_FILE')

    remote.streamChunks = [bytes([0xff])]
    const invalid = await fs.streamText(await fs.resolve('invalid'))
    await expect((async () => { for await (const _chunk of invalid) void _chunk })()).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    remote.streamChunks = [bytes([0])]
    const binary = await fs.streamText(await fs.resolve('binary'))
    await expect((async () => { for await (const _chunk of binary) void _chunk })()).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })

    remote.streamChunks = [bytes([0xe2])]
    const incomplete = await fs.streamText(await fs.resolve('invalid'))
    await expect((async () => { for await (const _chunk of incomplete) void _chunk })()).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })

    const raced = await fs.resolve('invalid')
    remote.nextReadError = new FileNotFoundError('gone after stat')
    await expectCode(fs.streamText(raced), 'FS_NOT_FOUND')
  })

  it('readBytes returns raw content, enforces the byte cap, and maps failures', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/img.bin', [0x89, 0, 0xff, 0x47])
    remote.dir('/workspace/directory')
    const { fs } = await setup(remote)
    const target = await fs.resolve('img.bin')
    expect(Array.from(await fs.readBytes(target, undefined, 4))).toEqual([0x89, 0, 0xff, 0x47])
    expect(remote.reads).toEqual([{ path: '/workspace/img.bin', format: 'stream' }])
    remote.reads.length = 0
    await expectCode(fs.readBytes(target, undefined, 3), 'FS_TOO_LARGE')
    expect(remote.reads).toEqual([])
    await expectCode(fs.readBytes(await fs.resolve('missing'), undefined, 4), 'FS_NOT_FOUND')
    await expectCode(fs.readBytes(await fs.resolve('directory'), undefined, 4), 'FS_NOT_REGULAR_FILE')

    const live = new AbortController()
    expect((await fs.readBytes(target, live.signal, 4)).byteLength).toBe(4)
    remote.nextReadError = new DOMException('aborted', 'AbortError')
    await expectCode(fs.readBytes(target, undefined, 4), 'FS_ABORTED')
  })

  it('readBytes bounds a post-stat grower mid-stream and reads an empty file through the SDK quirk', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/grow.bin', [1, 1, 1, 1])
    remote.file('/workspace/empty.bin', '')
    const { fs } = await setup(remote)

    remote.streamChunks = [bytes([1, 1, 1]), bytes([1, 2, 2])]
    remote.streamKeepOpen = true
    await expectCode(fs.readBytes(await fs.resolve('grow.bin'), undefined, 4), 'FS_TOO_LARGE')
    expect(remote.streamCancel).toHaveBeenCalledOnce()

    remote.streamChunks = undefined
    remote.streamKeepOpen = false
    expect((await fs.readBytes(await fs.resolve('empty.bin'), undefined, 4)).byteLength).toBe(0)
  })

  it('honors aborts before and during remote reads', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/a', 'a')
    const { fs } = await setup(remote)
    await expectCode(fs.resolve('a', { signal: AbortSignal.abort() }), 'FS_ABORTED')
    await expectCode(fs.lstat('a', undefined, AbortSignal.abort()), 'FS_ABORTED')
    await expectCode(fs.stat(await fs.resolve('a'), AbortSignal.abort()), 'FS_ABORTED')
    remote.nextReadError = new DOMException('aborted', 'AbortError')
    await expectCode(fs.readText(await fs.resolve('a')), 'FS_ABORTED')
  })

  it('rejects empty paths and directory-listing type errors', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/file', 'x')
    const { fs } = await setup(remote)
    await expectCode(fs.resolve('   '), 'FS_NOT_FOUND')
    await expectCode(fs.lstat(''), 'FS_NOT_FOUND')
    await expectCode(fs.listDir(await fs.resolve('missing')), 'FS_NOT_FOUND')
    await expectCode(fs.listDir(await fs.resolve('/workspace/file')), 'FS_NOT_DIRECTORY')
    remote.nextListError = new Error('listing transport failed')
    await expectCode(fs.listDir(await fs.resolve('/workspace')), 'FS_IO_ERROR')
  })
})

describe('E2BFileSystem atomic writes and edits', () => {
  it('creates owner-only files and returns metadata after the committed move', async () => {
    const { fs, remote } = await setup()
    const target = await fs.resolve('new.txt')
    const outcome = await fs.writeText(target, 'one\r\ntwo\rthree', { kind: 'createIfAbsent' })
    expect(outcome).toMatchObject({ operation: 'create', before: null, after: 'one\ntwo\rthree' })
    expect(remote.nodes.get('/workspace/new.txt')?.mode).toBe(0o600)
    expect(remote.nodes.get('/workspace/new.txt')?.metadata?.['dsh-version']).toBeDefined()
    expect(remote.writeParentModes).toEqual([0o700])
    expect(remote.links).toHaveLength(1)
    const stagingDirectory = posix.dirname(remote.writes[0]!.path)
    expect(posix.dirname(stagingDirectory)).toBe('/workspace')
    expect(remote.removals).toContain(stagingDirectory)
    await expect(fs.stat(target)).resolves.toMatchObject({ version: outcome.version, size: 14 })
  })

  it('preserves replacement mode, normalizes only CRLF for diffs, and changes version on external writes', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/file.txt', 'old\r\nline\rlone', 0o640)
    const { fs } = await setup(remote)
    const target = await fs.resolve('file.txt')
    const before = (await fs.stat(target))!.version
    const outcome = await fs.writeText(target, 'new', { kind: 'replaceIfVersion', version: before })
    expect(outcome).toMatchObject({ operation: 'update', before: 'old\nline\rlone', after: 'new' })
    expect(remote.nodes.get('/workspace/file.txt')?.mode).toBe(0o640)
    const committed = outcome.version
    remote.mutate('/workspace/file.txt', 'external')
    expect((await fs.stat(target))!.version).not.toBe(committed)
  })

  it('returns null as the overwrite diff basis for binary or invalid prior content', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/file.txt', [0xff])
    const { fs } = await setup(remote)
    const target = await fs.resolve('file.txt')
    await expect(fs.writeText(target, 'valid')).resolves.toMatchObject({ before: null, after: 'valid' })
  })

  it('fails an overwrite when reading its text diff basis fails for another reason', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/file.txt', 'prior')
    const { fs } = await setup(remote)
    const target = await fs.resolve('file.txt')
    remote.nextReadError = new Error('read transport failed')
    await expectCode(fs.writeText(target, 'replacement'), 'FS_IO_ERROR')
    expect(new TextDecoder().decode(remote.nodes.get('/workspace/file.txt')?.data)).toBe('prior')
  })

  it('enforces create and version intents before publication', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/file.txt', 'v1')
    const { fs } = await setup(remote)
    const target = await fs.resolve('file.txt')
    const version = (await fs.stat(target))!.version
    await expectCode(fs.writeText(target, 'blind', { kind: 'createIfAbsent' }), 'FS_NOT_OBSERVED')
    remote.mutate('/workspace/file.txt', 'v2')
    await expectCode(fs.writeText(target, 'stale', { kind: 'replaceIfVersion', version }), 'FS_STALE_VERSION')
    await expectCode(fs.writeText(await fs.resolve('missing'), 'stale', { kind: 'replaceIfVersion', version }), 'FS_STALE_VERSION')
    remote.dir('/workspace/dir')
    await expectCode(fs.writeText(await fs.resolve('dir'), 'x'), 'FS_NOT_REGULAR_FILE')
  })

  it('preserves a competitor created after the guarded-create probe', async () => {
    const remote = new FakeRemote()
    remote.competitorBeforeLink = { path: '/workspace/race.txt', kind: 'file', data: 'competitor' }
    const { fs } = await setup(remote)

    await expectCode(
      fs.writeText(await fs.resolve('race.txt'), 'ours', { kind: 'createIfAbsent' }),
      'FS_NOT_OBSERVED',
    )
    expect(new TextDecoder().decode(remote.nodes.get('/workspace/race.txt')?.data)).toBe('competitor')
    expect(remote.links).toHaveLength(0)
    expect(remote.removals).toHaveLength(1)
  })

  it('preserves a competing directory during guarded-create publication', async () => {
    const remote = new FakeRemote()
    remote.competitorBeforeLink = { path: '/workspace/race-dir', kind: 'directory' }
    const { fs } = await setup(remote)

    await expectCode(
      fs.writeText(await fs.resolve('race-dir'), 'ours', { kind: 'createIfAbsent' }),
      'FS_NOT_OBSERVED',
    )
    expect(remote.nodes.get('/workspace/race-dir')?.type).toBe(FileType.DIR)
    expect(remote.nodes.has('/workspace/race-dir/content')).toBe(false)
    expect(remote.links).toHaveLength(0)
    expect(remote.removals).toHaveLength(1)
  })

  it('rejects an invalid guarded-create publication response before claiming success', async () => {
    const remote = new FakeRemote()
    remote.guardedLinkOutput = 'unexpected'
    const { fs } = await setup(remote)

    await expectCode(
      fs.writeText(await fs.resolve('invalid.txt'), 'ours', { kind: 'createIfAbsent' }),
      'FS_IO_ERROR',
    )
    expect(remote.nodes.has('/workspace/invalid.txt')).toBe(false)
    expect(remote.removals).toHaveLength(1)
  })

  it('does not turn an abort observed after a successful move into a failed write', async () => {
    const remote = new FakeRemote()
    const controller = new AbortController()
    remote.abortAfterRename = controller
    const { fs } = await setup(remote)
    await expect(fs.writeText(await fs.resolve('committed'), 'yes', undefined, controller.signal))
      .resolves.toMatchObject({ operation: 'create' })
    expect(controller.signal.aborted).toBe(true)
  })

  it('does not turn an abort observed after a guarded create into a failed write', async () => {
    const remote = new FakeRemote()
    const controller = new AbortController()
    remote.abortAfterRename = controller
    const { fs } = await setup(remote)
    await expect(fs.writeText(
      await fs.resolve('committed-create'),
      'yes',
      { kind: 'createIfAbsent' },
      controller.signal,
    )).resolves.toMatchObject({ operation: 'create' })
    expect(controller.signal.aborted).toBe(true)
  })

  it('does not turn post-commit staging cleanup failure into a failed write', async () => {
    const remote = new FakeRemote()
    remote.nextRemoveError = new Error('empty staging cleanup failed')
    const { fs } = await setup(remote)
    await expect(fs.writeText(await fs.resolve('committed'), 'yes'))
      .resolves.toMatchObject({ operation: 'create' })
    expect(new TextDecoder().decode(remote.nodes.get('/workspace/committed')?.data)).toBe('yes')
  })

  it('returns committed rename metadata without a fallible post-commit lookup', async () => {
    const remote = new FakeRemote()
    const getInfo = vi.spyOn(remote.sandbox.files, 'getInfo')
    const { fs } = await setup(remote)

    await expect(fs.writeText(await fs.resolve('committed'), 'yes'))
      .resolves.toMatchObject({ operation: 'create' })
    expect(getInfo).toHaveBeenCalledTimes(1)
    expect(remote.renames).toHaveLength(1)
  })

  it('cleans staging files and maps command, permission, and abort failures', async () => {
    const remote = new FakeRemote()
    const { fs } = await setup(remote)
    const commandTarget = await fs.resolve('command')
    remote.nextCommandError = commandError(1, 'chmod failed')
    await expectCode(fs.writeText(commandTarget, 'x'), 'FS_IO_ERROR')
    expect(remote.removals).toHaveLength(1)

    remote.nextRenameError = new Error('permission denied')
    await expectCode(fs.writeText(await fs.resolve('permission'), 'x'), 'FS_PERMISSION_DENIED')
    remote.nextRemoveError = new Error('cleanup also failed')
    remote.nextRenameError = new DOMException('aborted', 'AbortError')
    await expectCode(fs.writeText(await fs.resolve('abort'), 'x'), 'FS_ABORTED')

    const removalsBeforeCollision = remote.removals.length
    remote.nextMakeDirResult = false
    await expectCode(fs.writeText(await fs.resolve('collision'), 'x'), 'FS_IO_ERROR')
    expect(remote.removals).toHaveLength(removalsBeforeCollision)
  })

  it('applies literal edits atomically and restores the detected CRLF style', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/file.txt', 'one\r\ntwo\r\nthree\n')
    const { fs } = await setup(remote)
    const target = await fs.resolve('file.txt')
    const version = (await fs.stat(target))!.version
    const outcome = await fs.editText(
      target,
      { oldString: 'two\r\n', newString: 'TWO\r\n', replaceAll: false },
      { version },
    )
    expect(outcome).toMatchObject({ before: 'one\ntwo\nthree\n', after: 'one\nTWO\nthree\n' })
    expect(new TextDecoder().decode(remote.nodes.get('/workspace/file.txt')?.data)).toBe('one\r\nTWO\r\nthree\r\n')
  })

  it('reports stale and literal-match failures with stable codes', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/file.txt', 'a a')
    remote.dir('/workspace/dir')
    const { fs } = await setup(remote)
    const target = await fs.resolve('file.txt')
    await expectCode(fs.editText(target, { oldString: '', newString: 'x', replaceAll: false }), 'FS_EDIT_NOT_FOUND')
    await expectCode(fs.editText(target, { oldString: 'z', newString: 'x', replaceAll: false }), 'FS_EDIT_NOT_FOUND')
    await expectCode(fs.editText(target, { oldString: 'a', newString: 'x', replaceAll: false }), 'FS_AMBIGUOUS_EDIT')
    await expect(fs.editText(target, { oldString: 'a', newString: 'x', replaceAll: true }))
      .resolves.toMatchObject({ after: 'x x' })
    await expectCode(fs.editText(target, { oldString: 'x', newString: 'y', replaceAll: false }, { version: FsVersion('stale') }), 'FS_STALE_VERSION')
    await expectCode(fs.editText(await fs.resolve('missing'), { oldString: 'x', newString: 'y', replaceAll: false }), 'FS_STALE_VERSION')
    await expectCode(fs.editText(await fs.resolve('dir'), { oldString: 'x', newString: 'y', replaceAll: false }), 'FS_NOT_REGULAR_FILE')
  })

  it('serializes guarded mutations so only one stale version can win', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/file.txt', 'base')
    const { fs } = await setup(remote)
    const target = await fs.resolve('file.txt')
    const version = (await fs.stat(target))!.version
    const results = await Promise.allSettled([
      fs.writeText(target, 'one', { kind: 'replaceIfVersion', version }),
      fs.editText(target, { oldString: 'base', newString: 'two', replaceAll: false }, { version }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  })
})

describe('E2B filesystem adapter integration edges', () => {
  it('maps canonicalization, permission, and generic provider failures', async () => {
    const remote = new FakeRemote()
    const { fs } = await setup(remote)
    remote.nextCommandError = commandError(1, 'not a directory')
    await expectCode(fs.resolve('bad'), 'FS_IO_ERROR')
    remote.nextCommandError = commandError(1)
    await expectCode(fs.resolve('bad-again'), 'FS_IO_ERROR')
    remote.nextCommandError = new Error('canonical transport failed')
    await expectCode(fs.resolve('bad-transport'), 'FS_IO_ERROR')
    remote.file('/workspace/a', 'a')
    const target = await fs.resolve('a')
    remote.nextInfoError = new Error('metadata transport failed')
    await expectCode(fs.stat(target), 'FS_IO_ERROR')
    remote.nextReadError = new Error('operation not permitted')
    await expectCode(fs.readText(target), 'FS_PERMISSION_DENIED')
    remote.nextReadError = 'transport vanished'
    await expectCode(fs.readText(target), 'FS_IO_ERROR')
  })

  it('uses listing metadata directly and canonicalizes only symbolic links', async () => {
    const remote = new FakeRemote()
    remote.file('/workspace/a', 'a')
    remote.file('/workspace/target', 'target')
    remote.file('/workspace/gone', 'gone')
    remote.symlink('/workspace/link', '/workspace/target')
    remote.symlink('/workspace/vanished-link', '/workspace/gone')
    remote.disappearOnInfo.add('/workspace/gone')
    const { fs } = await setup(remote)
    const directory = await fs.resolve('/workspace')
    const commandsBefore = remote.commands.length
    const getInfo = vi.spyOn(remote.sandbox.files, 'getInfo')

    const listed = await fs.listDir(directory)

    expect(listed.find(entry => entry.name === 'a')).toMatchObject({
      type: 'file', target: { targetKey: '/workspace/a' }, size: 1,
    })
    expect(listed.find(entry => entry.name === 'link')).toMatchObject({
      type: 'file', target: { targetKey: '/workspace/target' }, size: 6,
    })
    expect(listed.find(entry => entry.name === 'vanished-link')).toEqual({
      name: 'vanished-link',
      type: 'other',
      target: { targetKey: '/workspace/gone', displayPath: '/workspace/vanished-link' },
    })
    expect(remote.commands.slice(commandsBefore)).toHaveLength(2)
    expect(getInfo).toHaveBeenCalledTimes(3)
  })
})
