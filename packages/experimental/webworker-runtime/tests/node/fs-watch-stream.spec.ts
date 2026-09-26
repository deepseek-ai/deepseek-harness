/** Node differential checks for the Worker filesystem watcher and stream faces. */
import {
  closeSync as closeNodeSync,
  createReadStream as createNodeReadStream,
  createWriteStream as createNodeWriteStream,
  mkdtempSync,
  openSync as openNodeSync,
  readSync as readNodeSync,
  readFileSync,
  renameSync as renameNodeSync,
  rmSync,
  unwatchFile as unwatchNodeFile,
  watchFile as watchNodeFile,
  writeSync as writeNodeSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { setActiveVfs } from '../../src/storage/active.ts'
import * as workerFs from '../../src/node/builtin_modules/implemented/fs.ts'
import * as workerFsp from '../../src/node/builtin_modules/implemented/fs/promises.ts'
import * as workerStream from '../../src/node/builtin_modules/implemented/stream.ts'

const VFS_ROOT = '/dsh/watch-stream'
const nativeRoots: string[] = []
let vfs: MemoryVfs

beforeEach(() => {
  vfs = new MemoryVfs()
  setActiveVfs(vfs)
  vfs.mkdirSync(VFS_ROOT, { recursive: true })
})

afterEach(() => {
  for (const root of nativeRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** Await the next callback value with a bounded failure instead of an open watcher. */
function nextValue<T>(install: (resolve: (value: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => { reject(new Error('timed out waiting for filesystem event')) }, 2_000)
    install((value) => {
      clearTimeout(timeout)
      resolve(value)
    })
  })
}

interface ReadableFileStream {
  readonly bytesRead: number
  on(event: string, listener: (...args: unknown[]) => void): ReadableFileStream
}

/** Collect byte chunks and lifecycle events from one read stream implementation. */
async function readScenario(create: () => ReadableFileStream): Promise<{
  chunks: string[]
  events: string[]
  bytesRead: number
}> {
  const stream = create()
  const chunks: string[] = []
  const events: string[] = []
  stream.on('open', () => { events.push('open') })
  stream.on('ready', () => { events.push('ready') })
  stream.on('data', (chunk: unknown) => {
    events.push('data')
    chunks.push(Buffer.from(chunk as Uint8Array).toString('utf8'))
  })
  stream.on('end', () => { events.push('end') })
  await new Promise<void>((resolve, reject) => {
    stream.on('error', reject)
    stream.on('close', () => {
      events.push('close')
      resolve()
    })
  })
  return { chunks, events, bytesRead: stream.bytesRead }
}

interface WritableFileStream {
  readonly bytesWritten: number
  on(event: string, listener: (...args: unknown[]) => void): WritableFileStream
  write(chunk: string): boolean
  end(chunk?: string): void
}

/** Write the same chunks and record backpressure plus lifecycle ordering. */
async function writeScenario(create: () => WritableFileStream): Promise<{
  writes: boolean[]
  events: string[]
  bytesWritten: number
}> {
  const stream = create()
  const events: string[] = []
  for (const event of ['open', 'ready', 'drain', 'finish'] as const) {
    stream.on(event, () => { events.push(event) })
  }
  const writes = [stream.write('ab'), stream.write('cd')]
  stream.end('ef')
  await new Promise<void>((resolve, reject) => {
    stream.on('error', reject)
    stream.on('close', () => {
      events.push('close')
      resolve()
    })
  })
  return { writes, events, bytesWritten: stream.bytesWritten }
}

describe('file streams', () => {
  it('keeps an opened file identity across rename, replacement, and unlink', () => {
    const nativeRoot = mkdtempSync(join(tmpdir(), 'dsh-stream-diff-'))
    nativeRoots.push(nativeRoot)
    const nativePath = join(nativeRoot, 'identity.txt')
    const workerPath = `${VFS_ROOT}/identity.txt`

    const nativeScenario = (): string[] => {
      writeFileSync(nativePath, 'original')
      const fd = openNodeSync(nativePath, 'r')
      renameNodeSync(nativePath, `${nativePath}.moved`)
      writeFileSync(nativePath, 'replacement')
      const beforeUnlink = Buffer.alloc(16)
      const firstCount = readNodeSync(fd, beforeUnlink, 0, beforeUnlink.length, 0)
      rmSync(`${nativePath}.moved`)
      const afterUnlink = Buffer.alloc(16)
      const secondCount = readNodeSync(fd, afterUnlink, 0, afterUnlink.length, 0)
      closeNodeSync(fd)
      return [beforeUnlink.subarray(0, firstCount).toString(), afterUnlink.subarray(0, secondCount).toString()]
    }
    const workerScenario = (): string[] => {
      vfs.writeFileSync(workerPath, 'original')
      const fd = workerFs.openSync(workerPath, 'r')
      vfs.renameSync(workerPath, `${workerPath}.moved`)
      vfs.writeFileSync(workerPath, 'replacement')
      const beforeUnlink = Buffer.alloc(16)
      const firstCount = workerFs.readSync(fd, beforeUnlink, 0, beforeUnlink.length, 0)
      vfs.rmSync(`${workerPath}.moved`)
      const afterUnlink = Buffer.alloc(16)
      const secondCount = workerFs.readSync(fd, afterUnlink, 0, afterUnlink.length, 0)
      workerFs.closeSync(fd)
      return [beforeUnlink.subarray(0, firstCount).toString(), afterUnlink.subarray(0, secondCount).toString()]
    }

    expect(workerScenario()).toEqual(nativeScenario())
  })

  it('keeps a read stream on the file opened before an atomic replacement', async () => {
    const nativeRoot = mkdtempSync(join(tmpdir(), 'dsh-stream-diff-'))
    nativeRoots.push(nativeRoot)
    const nativePath = join(nativeRoot, 'stream-identity.txt')
    const workerPath = `${VFS_ROOT}/stream-identity.txt`
    writeFileSync(nativePath, 'original')
    vfs.writeFileSync(workerPath, 'original')

    const readAfterReplacement = async (
      stream: AsyncIterable<Uint8Array> & { once(event: string, listener: () => void): unknown },
      replace: () => void,
    ): Promise<string> => {
      stream.once('open', replace)
      const chunks: Uint8Array[] = []
      for await (const chunk of stream) chunks.push(chunk)
      return Buffer.concat(chunks).toString()
    }
    const native = await readAfterReplacement(createNodeReadStream(nativePath, { highWaterMark: 2 }), () => {
      renameNodeSync(nativePath, `${nativePath}.moved`)
      writeFileSync(nativePath, 'replacement')
    })
    const worker = await readAfterReplacement(workerFs.createReadStream(workerPath, { highWaterMark: 2 }), () => {
      vfs.renameSync(workerPath, `${workerPath}.moved`)
      vfs.writeFileSync(workerPath, 'replacement')
    })
    expect(worker).toBe(native)
  })

  it('rejects descriptor operations that conflict with the open mode', () => {
    const nativeRoot = mkdtempSync(join(tmpdir(), 'dsh-stream-diff-'))
    nativeRoots.push(nativeRoot)
    const nativePath = join(nativeRoot, 'mode.txt')
    const workerPath = `${VFS_ROOT}/mode.txt`
    writeFileSync(nativePath, 'content')
    vfs.writeFileSync(workerPath, 'content')
    const codeOf = (run: () => unknown): string | undefined => {
      try {
        run()
        return undefined
      } catch (error) {
        return (error as NodeJS.ErrnoException).code
      }
    }

    const nativeReadOnly = openNodeSync(nativePath, 'r')
    const workerReadOnly = workerFs.openSync(workerPath, 'r')
    expect(codeOf(() => workerFs.writeSync(workerReadOnly, 'x')))
      .toBe(codeOf(() => writeNodeSync(nativeReadOnly, 'x')))
    closeNodeSync(nativeReadOnly)
    workerFs.closeSync(workerReadOnly)

    const nativeWriteOnly = openNodeSync(nativePath, 'w')
    const workerWriteOnly = workerFs.openSync(workerPath, 'w')
    expect(codeOf(() => workerFs.readSync(workerWriteOnly, Buffer.alloc(1), 0, 1, 0)))
      .toBe(codeOf(() => readNodeSync(nativeWriteOnly, Buffer.alloc(1), 0, 1, 0)))
    closeNodeSync(nativeWriteOnly)
    workerFs.closeSync(workerWriteOnly)
  })

  it('keeps hard-link identity and content shared through the Node face', () => {
    const source = `${VFS_ROOT}/linked-source.txt`
    const alias = `${VFS_ROOT}/linked-alias.txt`
    workerFs.writeFileSync(source, 'one')
    workerFs.linkSync(source, alias)
    expect(workerFs.statSync(alias, { bigint: true }).ino)
      .toBe(workerFs.statSync(source, { bigint: true }).ino)
    workerFs.appendFileSync(alias, '-two')
    expect(workerFs.readFileSync(source, 'utf8')).toBe('one-two')
  })

  it('reports incompatible read and write stream flags as EBADF', async () => {
    const path = `${VFS_ROOT}/stream-mode.txt`
    vfs.writeFileSync(path, 'content')
    const writeError = nextValue<NodeJS.ErrnoException>((resolve) => {
      const stream = workerFs.createWriteStream(path, { flags: 'r' })
      stream.once('error', resolve)
      stream.end('x')
    })
    await expect(writeError).resolves.toMatchObject({ code: 'EBADF' })

    const read = workerFs.createReadStream(path, { flags: 'w' })
    const readError = nextValue<NodeJS.ErrnoException>((resolve) => { read.once('error', resolve) })
    read.resume()
    await expect(readError).resolves.toMatchObject({ code: 'EBADF' })
  })

  it('zero-extends through promise and file-handle truncate', async () => {
    const path = `${VFS_ROOT}/truncate.txt`
    vfs.writeFileSync(path, new Uint8Array([1, 2]))
    await workerFsp.truncate(path, 4)
    expect([...workerFs.readFileSync(path) as Uint8Array]).toEqual([1, 2, 0, 0])
    const handle = await workerFsp.open(path, 'r+')
    await handle.truncate(6)
    await handle.close()
    expect([...workerFs.readFileSync(path) as Uint8Array]).toEqual([1, 2, 0, 0, 0, 0])
  })

  it('matches Node chunking, inclusive ranges, and read lifecycle ordering', async () => {
    const nativeRoot = mkdtempSync(join(tmpdir(), 'dsh-stream-diff-'))
    nativeRoots.push(nativeRoot)
    const nativePath = join(nativeRoot, 'input.txt')
    const workerPath = `${VFS_ROOT}/input.txt`
    writeFileSync(nativePath, '0123456789')
    vfs.writeFileSync(workerPath, '0123456789')

    const native = await readScenario(() => createNodeReadStream(nativePath, { start: 2, end: 7, highWaterMark: 2 }))
    const worker = await readScenario(() => workerFs.createReadStream(workerPath, { start: 2, end: 7, highWaterMark: 2 }))
    expect(worker).toEqual(native)
  })

  it('matches Node write backpressure, lifecycle ordering, and byte accounting', async () => {
    const nativeRoot = mkdtempSync(join(tmpdir(), 'dsh-stream-diff-'))
    nativeRoots.push(nativeRoot)
    const nativePath = join(nativeRoot, 'output.txt')
    const workerPath = `${VFS_ROOT}/output.txt`

    const native = await writeScenario(() => createNodeWriteStream(nativePath, { highWaterMark: 2 }))
    const worker = await writeScenario(() => workerFs.createWriteStream(workerPath, { highWaterMark: 2 }))
    expect(worker).toEqual(native)
    expect(workerFs.readFileSync(workerPath, 'utf8')).toBe('abcdef')
  })

  it('uses the maintained stream implementation for backpressure and async iteration', async () => {
    const values: string[] = []
    for await (const value of workerStream.Readable.from(['one', 'two'])) values.push(String(value))
    expect(values).toEqual(['one', 'two'])
    expect(workerStream.default).toBe(workerStream.Stream)
    expect(new workerStream.Writable({ write: (_chunk, _encoding, callback) => { callback() } }))
      .toBeInstanceOf(workerStream.default)
    expect(typeof workerStream.pipeline).toBe('function')
    expect(typeof workerStream.finished).toBe('function')
    expect(workerStream.getDefaultHighWaterMark(false)).toBe(64 * 1024)
    expect(workerStream.default._isArrayBufferView(new Uint8Array())).toBe(true)
  })

  it('uses Node 22 Linux file-stream defaults and abort error identity', async () => {
    const nativeRoot = mkdtempSync(join(tmpdir(), 'dsh-stream-diff-'))
    nativeRoots.push(nativeRoot)
    const nativePath = join(nativeRoot, 'input.txt')
    const workerPath = `${VFS_ROOT}/input.txt`
    writeFileSync(nativePath, 'content')
    vfs.writeFileSync(workerPath, 'content')
    const nativeRead = createNodeReadStream(nativePath)
    const nativeWrite = createNodeWriteStream(join(nativeRoot, 'output.txt'))
    const workerRead = workerFs.createReadStream(workerPath)
    const workerWrite = workerFs.createWriteStream(`${VFS_ROOT}/output.txt`)
    expect([workerRead.readableHighWaterMark, workerWrite.writableHighWaterMark]).toEqual([
      nativeRead.readableHighWaterMark,
      nativeWrite.writableHighWaterMark,
    ])
    interface CloseableStream {
      once(event: string, listener: (...args: unknown[]) => void): unknown
      destroy(): unknown
    }
    const streams = [nativeRead, nativeWrite, workerRead, workerWrite] as CloseableStream[]
    const closed = streams.map(stream => new Promise<void>((resolve) => {
      stream.once('error', () => {})
      stream.once('close', () => { resolve() })
    }))
    for (const stream of streams) stream.destroy()
    await Promise.all(closed)

    const controller = new AbortController()
    controller.abort(new Error('stop'))
    const aborted = workerFs.createReadStream(workerPath, { signal: controller.signal })
    const error = await nextValue<Error & { code?: string }>((resolve) => { aborted.once('error', resolve) })
    expect(error).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' })
  })

  it('keeps autoClose false descriptors open until explicit stream close', async () => {
    const readPath = `${VFS_ROOT}/manual-read-close.txt`
    vfs.writeFileSync(readPath, 'content')
    const read = workerFs.createReadStream(readPath, { autoClose: false })
    read.resume()
    await nextValue<undefined>((resolve) => { read.once('end', () => { resolve(undefined) }) })
    const readFd = read.fd
    expect(readFd).not.toBeNull()
    expect(read.destroyed).toBe(false)
    expect(() => workerFs.readSync(readFd as number, Buffer.alloc(1), 0, 1, 0)).not.toThrow()
    const readClosed = nextValue<undefined>((resolve) => { read.once('close', () => { resolve(undefined) }) })
    read.close()
    await readClosed
    expect(() => workerFs.readSync(readFd as number, Buffer.alloc(1), 0, 1, 0)).toThrow(/EBADF/)

    const write = workerFs.createWriteStream(`${VFS_ROOT}/manual-write-close.txt`, { autoClose: false })
    write.end('a')
    await nextValue<undefined>((resolve) => { write.once('finish', () => { resolve(undefined) }) })
    const writeFd = write.fd
    expect(writeFd).not.toBeNull()
    expect(write.destroyed).toBe(false)
    expect(workerFs.writeSync(writeFd as number, 'b')).toBe(1)
    const writeClosed = nextValue<undefined>((resolve) => { write.once('close', () => { resolve(undefined) }) })
    write.close()
    await writeClosed
    expect(workerFs.readFileSync(`${VFS_ROOT}/manual-write-close.txt`, 'utf8')).toBe('ab')

    vfs.writeFileSync(`${VFS_ROOT}/manual-error-close.txt`, 'content')
    const errored = workerFs.createWriteStream(`${VFS_ROOT}/manual-error-close.txt`, {
      flags: 'r',
      autoClose: false,
    })
    const error = nextValue<NodeJS.ErrnoException>((resolve) => { errored.once('error', resolve) })
    errored.end('rejected')
    await expect(error).resolves.toMatchObject({ code: 'EBADF' })
    const errorFd = errored.fd
    expect(errorFd).not.toBeNull()
    expect(errored.destroyed).toBe(false)
    expect(() => workerFs.readSync(errorFd as number, Buffer.alloc(1), 0, 1, 0)).not.toThrow()
    const errorClosed = nextValue<undefined>((resolve) => { errored.once('close', () => { resolve(undefined) }) })
    errored.destroy()
    await errorClosed
    expect(() => workerFs.readSync(errorFd as number, Buffer.alloc(1), 0, 1, 0)).toThrow(/EBADF/)
  })

  it('matches Node positional overwrite and missing-file failure', async () => {
    const nativeRoot = mkdtempSync(join(tmpdir(), 'dsh-stream-diff-'))
    nativeRoots.push(nativeRoot)
    const nativePath = join(nativeRoot, 'position.txt')
    const workerPath = `${VFS_ROOT}/position.txt`
    writeFileSync(nativePath, 'abcdef')
    vfs.writeFileSync(workerPath, 'abcdef')

    const writeAt = async (stream: WritableFileStream): Promise<void> => {
      stream.end('XY')
      await new Promise<void>((resolve) => { stream.on('close', () => { resolve() }) })
    }
    await writeAt(createNodeWriteStream(nativePath, { flags: 'r+', start: 2 }))
    await writeAt(workerFs.createWriteStream(workerPath, { flags: 'r+', start: 2 }))
    expect(workerFs.readFileSync(workerPath, 'utf8')).toBe(readFileSync(nativePath, 'utf8'))

    const missing = workerFs.createReadStream(`${VFS_ROOT}/missing.txt`)
    const events: string[] = []
    missing.on('error', () => { events.push('error') })
    await new Promise<void>((resolve) => {
      missing.on('close', () => {
        events.push('close')
        resolve()
      })
    })
    expect(events).toEqual(['error', 'close'])
  })

  it('publishes descriptors before open and ready listener exceptions escape', () => {
    const readPath = `${VFS_ROOT}/listener-read.txt`
    vfs.writeFileSync(readPath, 'content')
    const readCallback = vi.fn()
    const readFailure = new Error('read open listener failed')
    const readReceiver: {
      path: string
      flags: string
      start: number
      end: number
      signal: undefined
      pending: boolean
      fd: number | null
      emit(event: string): boolean
    } = {
      path: readPath,
      flags: 'r',
      start: 0,
      end: Number.POSITIVE_INFINITY,
      signal: undefined,
      pending: true,
      fd: null,
      emit(event) {
        expect(readCallback).toHaveBeenCalledOnce()
        if (event === 'open') throw readFailure
        return true
      },
    }
    expect(() => {
      workerFs.ReadStream.prototype._construct.call(
        readReceiver as unknown as workerFs.ReadStream,
        readCallback,
      )
    }).toThrow(readFailure)
    expect(readReceiver.pending).toBe(false)
    expect(readReceiver.fd).not.toBeNull()
    workerFs.closeSync(readReceiver.fd as number)

    const writeCallback = vi.fn()
    const writeFailure = new Error('write ready listener failed')
    const writeReceiver: {
      path: string
      flags: string
      mode: undefined
      start: undefined
      signal: undefined
      pending: boolean
      fd: number | null
      emit(event: string): boolean
    } = {
      path: `${VFS_ROOT}/listener-write.txt`,
      flags: 'w',
      mode: undefined,
      start: undefined,
      signal: undefined,
      pending: true,
      fd: null,
      emit(event) {
        expect(writeCallback).toHaveBeenCalledOnce()
        if (event === 'ready') throw writeFailure
        return true
      },
    }
    expect(() => {
      workerFs.WriteStream.prototype._construct.call(
        writeReceiver as unknown as workerFs.WriteStream,
        writeCallback,
      )
    }).toThrow(writeFailure)
    expect(writeReceiver.pending).toBe(false)
    expect(writeReceiver.fd).not.toBeNull()
    workerFs.closeSync(writeReceiver.fd as number)
  })

  it('codes a write before descriptor publication as EBADF', () => {
    let failure: Error | null | undefined
    workerFs.WriteStream.prototype._write.call(
      { fd: null } as unknown as workerFs.WriteStream,
      Buffer.from('x'),
      'utf8',
      (error) => { failure = error },
    )
    expect(failure).toMatchObject({ code: 'EBADF', syscall: 'write' })
  })
})

interface StatTransition {
  currentExists: boolean
  previousExists: boolean
  currentSize: number
  previousSize: number
  currentOtherKinds: boolean[]
}

/** Observe missing, creation, rewrite, and deletion through one watchFile implementation. */
async function watchFileScenario(
  path: string,
  watchFile: typeof watchNodeFile,
  unwatchFile: typeof unwatchNodeFile,
  write: (text: string) => void,
  remove: () => void,
): Promise<StatTransition[]> {
  const waiting: Array<(value: StatTransition) => void> = []
  const queued: StatTransition[] = []
  const listener = (current: import('node:fs').Stats, previous: import('node:fs').Stats): void => {
    const transition = {
      currentExists: current.isFile(),
      previousExists: previous.isFile(),
      currentSize: current.size,
      previousSize: previous.size,
      currentOtherKinds: [
        current.isDirectory(), current.isSymbolicLink(), current.isFIFO(),
        current.isSocket(), current.isBlockDevice(), current.isCharacterDevice(),
      ],
    }
    const resolve = waiting.shift()
    if (resolve === undefined) queued.push(transition)
    else resolve(transition)
  }
  const next = async (): Promise<StatTransition> => {
    const queuedValue = queued.shift()
    if (queuedValue !== undefined) return queuedValue
    return await nextValue((resolve) => { waiting.push(resolve) })
  }
  watchFile(path, { interval: 10, persistent: false }, listener)
  try {
    const missing = await next()
    write('a')
    const created = await next()
    write('longer')
    const changed = await next()
    remove()
    const removed = await next()
    return [missing, created, changed, removed]
  } finally {
    unwatchFile(path, listener)
  }
}

describe('watchers', () => {
  it('does not catch exceptions thrown by a successful stat callback', () => {
    const path = `${VFS_ROOT}/callback.txt`
    vfs.writeFileSync(path, 'value')
    const failure = new Error('callback failed')
    let calls = 0
    const dispatch = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => { callback() })
    expect(() => {
      workerFs.stat(path, () => {
        calls += 1
        throw failure
      })
    }).toThrow(failure)
    expect(calls).toBe(1)
    dispatch.mockRestore()
  })

  it('matches Node watchFile state transitions for a missing and recreated file', async () => {
    const nativeRoot = mkdtempSync(join(tmpdir(), 'dsh-watch-diff-'))
    nativeRoots.push(nativeRoot)
    const nativePath = join(nativeRoot, 'watched.txt')
    const workerPath = `${VFS_ROOT}/watched.txt`
    const native = await watchFileScenario(
      nativePath,
      watchNodeFile,
      unwatchNodeFile,
      (text) => { writeFileSync(nativePath, text) },
      () => { rmSync(nativePath) },
    )
    const worker = await watchFileScenario(
      workerPath,
      workerFs.watchFile as unknown as typeof watchNodeFile,
      workerFs.unwatchFile as unknown as typeof unwatchNodeFile,
      (text) => { vfs.writeFileSync(workerPath, text) },
      () => { vfs.rmSync(workerPath) },
    )
    expect(worker).toEqual(native)
  })

  it('shares one StatWatcher and removes only the named listener', async () => {
    const path = `${VFS_ROOT}/shared.txt`
    vfs.writeFileSync(path, 'a')
    const firstEvents: number[] = []
    const secondEvents: number[] = []
    const first = (): void => { firstEvents.push(1) }
    const second = (): void => { secondEvents.push(1) }
    const firstWatcher = workerFs.watchFile(path, { interval: 1, persistent: false }, first)
    const secondWatcher = workerFs.watchFile(path, { interval: 1, persistent: false }, second)
    expect(secondWatcher).toBe(firstWatcher)
    workerFs.unwatchFile(path, first)
    vfs.writeFileSync(path, 'bb')
    await nextValue<undefined>((resolve) => {
      const poll = setInterval(() => {
        if (secondEvents.length === 0) return
        clearInterval(poll)
        resolve(undefined)
      }, 1)
    })
    expect(firstEvents).toEqual([])
    expect(secondEvents).toEqual([1])
    workerFs.unwatchFile(path)
  })

  it('reports direct and recursive names, then reaches quiescence on close', async () => {
    const root = `${VFS_ROOT}/tree`
    vfs.mkdirSync(`${root}/nested`, { recursive: true })
    const directEvents: Array<[string, string]> = []
    const recursiveEvents: Array<[string, string]> = []
    const direct = workerFs.watch(root, (_event, _filename) => {})
    direct.on('change', (event, filename) => { directEvents.push([String(event), String(filename)]) })
    const recursive = workerFs.watch(root, { recursive: true }, (event, filename) => {
      recursiveEvents.push([event, String(filename)])
    })
    vfs.writeFileSync(`${root}/top.txt`, 'top')
    vfs.writeFileSync(`${root}/nested/deep.txt`, 'deep')
    await Promise.resolve()
    expect(directEvents).toEqual([['rename', 'top.txt']])
    expect(recursiveEvents).toEqual([
      ['rename', 'top.txt'],
      ['rename', 'nested/deep.txt'],
    ])
    direct.close()
    recursive.close()
    vfs.writeFileSync(`${root}/after.txt`, 'after')
    await Promise.resolve()
    expect(directEvents).toHaveLength(1)
    expect(recursiveEvents).toHaveLength(2)
  })

  it('supports Buffer filenames, file targets, abort closure, and ref state', async () => {
    const path = `${VFS_ROOT}/encoded.txt`
    vfs.writeFileSync(path, 'before')
    const controller = new AbortController()
    const event = nextValue<[string, Buffer]>((resolve) => {
      const watcher = workerFs.watch(
        new TextEncoder().encode(path),
        { encoding: 'buffer', persistent: false, signal: controller.signal },
        (eventType, filename) => { resolve([eventType, filename as Buffer]) },
      )
      expect(watcher.hasRef()).toBe(false)
      expect(watcher.ref().hasRef()).toBe(true)
      expect(watcher.unref().hasRef()).toBe(false)
    })
    vfs.writeFileSync(path, 'after')
    const [eventType, filename] = await event
    expect(eventType).toBe('change')
    expect(Buffer.isBuffer(filename)).toBe(true)
    expect(filename.toString()).toBe('encoded.txt')

    const watcher = workerFs.watch(path, { signal: controller.signal })
    let closes = 0
    const closed = nextValue<undefined>((resolve) => {
      watcher.on('close', () => {
        closes += 1
        resolve(undefined)
      })
    })
    controller.abort(new Error('stop'))
    await closed
    watcher.close()
    await Promise.resolve()
    expect(closes).toBe(1)
  })

  it('supports the string encoding overload and suppresses queued delivery after close', async () => {
    const encoded = nextValue<Buffer>((resolve) => {
      const watcher = workerFs.watch(VFS_ROOT, 'buffer', (_eventType, filename) => {
        watcher.close()
        resolve(filename as Buffer)
      })
    })
    vfs.writeFileSync(`${VFS_ROOT}/buffer-name.txt`, 'x')
    await expect(encoded).resolves.toEqual(Buffer.from('buffer-name.txt'))

    let calls = 0
    const closed = workerFs.watch(VFS_ROOT, () => { calls += 1 })
    vfs.writeFileSync(`${VFS_ROOT}/queued.txt`, 'x')
    closed.close()
    await Promise.resolve()
    expect(calls).toBe(0)
  })

  it('reports removal of an ancestor to a watched file', async () => {
    const directory = `${VFS_ROOT}/removed-parent`
    const path = `${directory}/file.txt`
    vfs.mkdirSync(directory)
    vfs.writeFileSync(path, 'x')
    const event = nextValue<[string, string]>((resolve) => {
      const watcher = workerFs.watch(path, (eventType, filename) => {
        watcher.close()
        resolve([eventType, String(filename)])
      })
    })
    vfs.rmSync(directory, { recursive: true })
    await expect(event).resolves.toEqual(['rename', 'file.txt'])
  })

  it('returns an asynchronously closing watcher for a pre-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort(new Error('already stopped'))
    const order: string[] = []
    const watcher = workerFs.watch(VFS_ROOT, { signal: controller.signal })
    const closed = nextValue<undefined>((resolve) => {
      watcher.once('close', () => {
        order.push('close')
        resolve(undefined)
      })
    })
    order.push('return')
    await closed
    expect(order).toEqual(['return', 'close'])
    expect(() => { vfs.writeFileSync(`${VFS_ROOT}/after-abort.txt`, 'x') }).not.toThrow()
  })

  it('reports an atomic replacement destination as rename even when it existed', async () => {
    const target = `${VFS_ROOT}/target.txt`
    const replacement = `${VFS_ROOT}/replacement.txt`
    vfs.writeFileSync(target, 'old')
    vfs.writeFileSync(replacement, 'new')
    const event = nextValue<[string, string]>((resolve) => {
      const watcher = workerFs.watch(VFS_ROOT, (eventType, filename) => {
        if (String(filename) !== 'target.txt') return
        watcher.close()
        resolve([eventType, String(filename)])
      })
    })
    vfs.renameSync(replacement, target)
    await expect(event).resolves.toEqual(['rename', 'target.txt'])
  })

  it('supports BigInt watchFile state, default options, and idempotent stop', async () => {
    const path = `${VFS_ROOT}/bigint.txt`
    const states = nextValue<[bigint, bigint]>((resolve) => {
      const watcher = workerFs.watchFile(new URL(`file://${path}`), { bigint: true, interval: 1 }, (current, previous) => {
        resolve([current.size as bigint, previous.size as bigint])
      })
      expect(watcher.hasRef()).toBe(true)
      expect(watcher.unref().hasRef()).toBe(false)
      expect(watcher.ref().hasRef()).toBe(true)
    })
    vfs.writeFileSync(path, 'big')
    await expect(states).resolves.toEqual([3n, 0n])
    workerFs.unwatchFile(path)
    workerFs.unwatchFile(path)

    vfs.writeFileSync(`${VFS_ROOT}/default.txt`, 'x')
    const listener = (): void => {}
    const defaultWatcher = workerFs.watchFile(`${VFS_ROOT}/default.txt`, listener)
    expect(defaultWatcher.hasRef()).toBe(true)
    defaultWatcher.close()
    defaultWatcher.close()
    expect(() => workerFs.watchFile(`${VFS_ROOT}/default.txt`, {})).toThrow(/listener/)

    let cancelledCalls = 0
    const cancelled = workerFs.watchFile(`${VFS_ROOT}/never-created`, { interval: 1 }, () => { cancelledCalls += 1 })
    cancelled.close()
    cancelled.close()
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
    expect(cancelledCalls).toBe(0)
  })

  it('propagates non-absence stat failures from watchFile', () => {
    const failure = Object.assign(new Error('denied'), { code: 'EACCES' })
    vi.spyOn(vfs, 'statSync').mockImplementationOnce(() => { throw failure })
    expect(() => workerFs.watchFile(`${VFS_ROOT}/denied`, () => {})).toThrow(failure)
  })

  it('exposes promise watch as an abortable async iterator', async () => {
    const controller = new AbortController()
    const iterator = workerFsp.watch(VFS_ROOT, { signal: controller.signal })[Symbol.asyncIterator]()
    const event = iterator.next()
    vfs.writeFileSync(`${VFS_ROOT}/async.txt`, 'x')
    await expect(event).resolves.toEqual({ done: false, value: { eventType: 'rename', filename: 'async.txt' } })
    const failed = iterator.next()
    const completed = iterator.next()
    controller.abort()
    await expect(failed).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' })
    await expect(completed).resolves.toEqual({ done: true, value: undefined })
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('rejects the first promise-watch read for a pre-aborted signal', async () => {
    const controller = new AbortController()
    const reason = new Error('already stopped')
    controller.abort(reason)
    const iterator = workerFsp.watch(VFS_ROOT, { signal: controller.signal })[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR', cause: reason })
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('lets promise-watch return interrupt a pending next call', async () => {
    const iterator = workerFsp.watch(VFS_ROOT)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined })
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    vfs.writeFileSync(`${VFS_ROOT}/after-return.txt`, 'x')
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('propagates promise-watch startup and throw failures', async () => {
    const missing = workerFsp.watch(`${VFS_ROOT}/missing`)[Symbol.asyncIterator]()
    await expect(missing.next()).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(missing.next()).resolves.toEqual({ done: true, value: undefined })

    const iterator = workerFsp.watch(VFS_ROOT)[Symbol.asyncIterator]()
    const reason = { reason: 'caller stopped iteration' }
    if (iterator.throw === undefined) throw new Error('watch iterator has no throw method')
    await expect(iterator.throw(reason)).rejects.toBe(reason)
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('queues promise-watch events when no next call is waiting', async () => {
    const iterator = workerFsp.watch(VFS_ROOT)[Symbol.asyncIterator]()
    const first = iterator.next()
    vfs.writeFileSync(`${VFS_ROOT}/one.txt`, 'one')
    vfs.writeFileSync(`${VFS_ROOT}/two.txt`, 'two')
    await expect(first).resolves.toEqual({ done: false, value: { eventType: 'rename', filename: 'one.txt' } })
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { eventType: 'rename', filename: 'two.txt' } })
    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined })
    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined })
  })
})
