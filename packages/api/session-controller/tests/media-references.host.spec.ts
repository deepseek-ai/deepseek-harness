import { appendFile, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionMediaReferences } from '../src/media-references.ts'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const DEFAULT_LIMIT = 20 * 1024 * 1024

async function responseBytes(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer())
}

describe('SessionMediaReferences /api/file', () => {
  let root: string
  const contexts: Context[] = []

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-media-references-')))
  })

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
    await rm(root, { recursive: true, force: true })
  })

  async function mount(maxBytes = DEFAULT_LIMIT) {
    const ctx = new Context()
    contexts.push(ctx)
    let handler: ((request: Request) => Promise<Response>) | undefined
    const unregister = vi.fn(() => {})
    ctx.provide('connection', {
      fetch: {
        register: (registered: { fetch: (request: Request) => Promise<Response> }) => {
          handler = registered.fetch
          return unregister
        },
      },
    } as never)
    ctx.provide('attachments', { imageLimits: { maxImageBytes: maxBytes } } as never)
    await ctx.plugin(LocalFileSystem, { cwd: root }).await()
    await ctx.plugin(SessionMediaReferences).await()
    const raw = (url: string, init?: RequestInit) => {
      if (handler === undefined) throw new Error('route not registered')
      return handler(new Request(url, init))
    }
    return {
      call: (path: string, init?: RequestInit) => raw(`http://127.0.0.1/api/file?path=${encodeURIComponent(path)}`, init),
      raw,
      fs: ctx.fs as LocalFileSystem,
      unregister,
      dispose: () => ctx.fiber.dispose(),
    }
  }

  it('serves the inclusive image cap and refuses larger images for GET, HEAD and Range', async () => {
    const route = await mount(PNG_BYTES.length)
    const path = join(root, 'bounded.png')
    await writeFile(path, PNG_BYTES)
    expect(await responseBytes(await route.call(path))).toEqual(PNG_BYTES)
    await appendFile(path, new Uint8Array(1))
    expect((await route.call(path)).status).toBe(413)
    expect((await route.call(path, { headers: { range: 'bytes=0-0' } })).status).toBe(413)
    const head = await route.call(path, { method: 'HEAD' })
    expect(head.status).toBe(413)
    expect(head.body).toBeNull()
  })

  it('rejects a sparse 1 GiB image before content I/O', async () => {
    const route = await mount()
    const inspect = vi.fn()
    route.fs.internals.inspectReadBytesAfterStat = inspect
    const path = join(root, 'huge.png')
    const handle = await open(path, 'w')
    try {
      await handle.truncate(1024 * 1024 * 1024)
    } finally {
      await handle.close()
    }
    expect((await route.call(path)).status).toBe(413)
    expect(inspect).not.toHaveBeenCalled()
  })

  it('uses the filesystem byte reader to reject post-stat image growth', async () => {
    const route = await mount(PNG_BYTES.length)
    const path = join(root, 'growing.png')
    await writeFile(path, PNG_BYTES)
    route.fs.internals.inspectReadBytesAfterStat = async () => {
      await appendFile(path, new Uint8Array(1))
    }
    expect((await route.call(path)).status).toBe(413)
  })

  it.each([
    ['png', 'image/png'], ['svg', 'image/svg+xml'], ['mp4', 'video/mp4'], ['mp3', 'audio/mpeg'],
    ['txt', 'text/plain'], ['html', 'text/html'], ['bin', 'application/octet-stream'], ['', 'application/octet-stream'],
  ])('serves .%s files with their MIME type and response protections', async (extension, mediaType) => {
    const route = await mount()
    const path = join(root, `file${extension === '' ? '' : `.${extension}`}`)
    await writeFile(path, PNG_BYTES)
    const response = await route.call(path)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(mediaType)
    expect(response.headers.get('content-length')).toBe(String(PNG_BYTES.length))
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
    expect(await responseBytes(response)).toEqual(PNG_BYTES)
  })

  it.each(['mp4', 'mp3', 'bin'])('applies the attachment byte cap to .%s files', async (extension) => {
    const route = await mount(PNG_BYTES.length)
    const path = join(root, `file.${extension}`)
    await writeFile(path, PNG_BYTES)
    expect(await responseBytes(await route.call(path))).toEqual(PNG_BYTES)
    await appendFile(path, new Uint8Array(1))
    expect((await route.call(path)).status).toBe(413)
    expect((await route.call(path, { method: 'HEAD' })).status).toBe(413)
  })

  it('ignores Range headers and returns complete bodies without advertising ranges', async () => {
    const route = await mount()
    const path = join(root, 'clip.mp4')
    await writeFile(path, PNG_BYTES)
    for (const range of ['bytes=0-3', 'bytes=-4', 'bytes=999-', 'bytes=abc', 'items=0-0', 'bytes=0-1,3-4']) {
      const response = await route.call(path, { headers: { range } })
      expect(response.status).toBe(200)
      expect(response.headers.get('accept-ranges')).toBeNull()
      expect(response.headers.get('content-range')).toBeNull()
      expect(await responseBytes(response)).toEqual(PNG_BYTES)
    }
  })

  it('answers HEAD without reading content and reports missing and non-regular files', async () => {
    const route = await mount()
    const path = join(root, 'image.png')
    await writeFile(path, PNG_BYTES)
    const read = vi.spyOn(route.fs, 'readBytes')
    const response = await route.call(path, { method: 'HEAD', headers: { range: 'bytes=0-3' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(PNG_BYTES.length))
    expect(response.body).toBeNull()
    expect(read).not.toHaveBeenCalled()
    expect((await route.call(join(root, 'missing'), { method: 'HEAD' })).status).toBe(404)
    expect((await route.call(root, { method: 'HEAD' })).status).toBe(403)
    vi.spyOn(route.fs, 'stat').mockResolvedValue({ type: 'file', version: FsVersion('v1') })
    expect((await route.call(path, { method: 'HEAD' })).headers.get('content-length')).toBeNull()
  })

  it('rejects malformed paths, absent files, and directories', async () => {
    const route = await mount()
    expect((await route.raw('http://127.0.0.1/api/file')).status).toBe(400)
    for (const path of ['', 'relative.png', '/a\0b.png']) {
      expect((await route.call(path)).status).toBe(400)
    }
    const head = await route.call('', { method: 'HEAD' })
    expect(head.status).toBe(400)
    expect(head.body).toBeNull()
    expect((await route.call(join(root, 'missing.png'))).status).toBe(404)
    await mkdir(join(root, 'frames.png'))
    expect((await route.call(join(root, 'frames.png'))).status).toBe(403)
  })

  it('reads files and symlink targets outside the default cwd without a workspace registry', async () => {
    const route = await mount()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-media-outside-'))
    try {
      const path = join(outside, 'image.png')
      await writeFile(path, PNG_BYTES)
      expect(await responseBytes(await route.call(path))).toEqual(PNG_BYTES)
      const link = join(root, 'linked.png')
      await symlink(path, link)
      expect(await responseBytes(await route.call(link))).toEqual(PNG_BYTES)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('rejects a FIFO before opening it', async () => {
    const route = await mount()
    const path = join(root, 'stream.png')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    await promisify(execFile)('mkfifo', [path])
    expect((await route.call(path)).status).toBe(403)
  })

  it('reads opaque remote targets through ctx.fs and preserves provider failures', async () => {
    const route = await mount()
    const target = { targetKey: FsTargetKey('opaque-remote-id'), displayPath: '/remote/photo.png' }
    vi.spyOn(route.fs, 'resolve').mockResolvedValue(target)
    const read = vi.spyOn(route.fs, 'readBytes').mockResolvedValue(PNG_BYTES)
    expect(await responseBytes(await route.call('/remote/photo.png'))).toEqual(PNG_BYTES)
    expect(read).toHaveBeenCalledWith(target, expect.any(AbortSignal), DEFAULT_LIMIT)
    for (const [code, status] of [
      ['FS_PERMISSION_DENIED', 403], ['FS_SANDBOX_DENIED', 403], ['FS_NOT_FOUND', 404],
      ['FS_NOT_REGULAR_FILE', 403], ['FS_TOO_LARGE', 413], ['FS_IO_ERROR', 500],
    ] as const) {
      read.mockRejectedValueOnce(new FsError('provider rejected read', code))
      expect((await route.call('/remote/photo.png')).status).toBe(status)
    }
    read.mockRejectedValueOnce(new Error('provider bug'))
    await expect(route.call('/remote/photo.png')).rejects.toThrow('provider bug')
  })

  it('serves an empty file and respects an aborted request', async () => {
    const route = await mount()
    const path = join(root, 'empty.png')
    await writeFile(path, '')
    const response = await route.call(path)
    expect(response.headers.get('content-length')).toBe('0')
    expect(await response.text()).toBe('')
    expect((await route.call(path, { signal: AbortSignal.abort() })).status).toBe(499)
  })

  it('unregisters the route on disposal', async () => {
    const route = await mount()
    await route.dispose()
    expect(route.unregister).toHaveBeenCalledTimes(1)
  })
})
