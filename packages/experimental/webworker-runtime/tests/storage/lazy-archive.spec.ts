/**
 * Lazy archives: files the image registers by path and size whose bytes arrive
 * with their own archive on the first asynchronous read. Synchronous readers are
 * refused by name, one archive is fetched once however many readers wait, and a
 * failed fetch leaves the files registered so a later read retries.
 */
import { describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { packTar } from '../../src/storage/tar.ts'
import { setActiveVfs } from '../../src/storage/active.ts'
import * as fs from '../../src/node/builtin_modules/implemented/fs.ts'
import * as fsp from '../../src/node/builtin_modules/implemented/fs/promises.ts'
import type { VfsBigIntStats, VfsMutation } from '../../src/storage/types.ts'

const encoder = new TextEncoder()
const PDF = 'node_modules/@scope/preview/lib/client.pdf.js'
const EXCEL = 'node_modules/@scope/preview/lib/client.excel.js'
const pdfBytes = encoder.encode('module.exports = "pdf"\n')
const excelBytes = encoder.encode('module.exports = "excel"\n')

/** One registered archive over `/dsh`, whose loader the caller controls. */
function deferred(load: () => Promise<Uint8Array>, files = [
  { path: PDF, size: pdfBytes.length },
  { path: EXCEL, size: excelBytes.length },
]): MemoryVfs {
  const vfs = new MemoryVfs()
  vfs.seedDirectory('/dsh')
  vfs.seed('/dsh/node_modules/@scope/preview/lib/client.js', 'module.exports = "entry"\n')
  vfs.deferArchive({ name: 'lazy/abc.tar.gz', root: '/dsh', files, load })
  return vfs
}

const archive = (): Uint8Array => packTar({ [PDF]: pdfBytes, [EXCEL]: excelBytes })

describe('registration', () => {
  it('answers existence, stats, and listings before any fetch', () => {
    const load = vi.fn(() => Promise.resolve(archive()))
    const vfs = deferred(load)
    expect(vfs.existsSync(`/dsh/${PDF}`)).toBe(true)
    const stats = vfs.statSync(`/dsh/${PDF}`)
    expect(stats.isFile()).toBe(true)
    expect(stats.size).toBe(pdfBytes.length)
    expect(vfs.readdirSync('/dsh/node_modules/@scope/preview/lib')).toEqual(['client.excel.js', 'client.js', 'client.pdf.js'])
    expect(vfs.realpathSync(`/dsh/${EXCEL}`)).toBe(`/dsh/${EXCEL}`)
    expect(load).not.toHaveBeenCalled()
  })

  it('refuses synchronous reads and mutations by naming the archive', () => {
    const vfs = deferred(() => Promise.resolve(archive()))
    const refusals = [
      () => vfs.readFileSync(`/dsh/${PDF}`),
      () => vfs.openFileSync(`/dsh/${PDF}`),
      () => { vfs.writeFileSync(`/dsh/${PDF}`, 'x') },
      () => { vfs.appendFileSync(`/dsh/${PDF}`, 'x') },
      () => { vfs.truncateSync(`/dsh/${PDF}`) },
      () => { vfs.chmodSync(`/dsh/${PDF}`, 0o600) },
      () => { vfs.linkSync(`/dsh/${PDF}`, '/dsh/alias.js') },
      () => { vfs.renameSync(`/dsh/${PDF}`, '/dsh/moved.js') },
      () => { vfs.renameSync('/dsh/node_modules/@scope/preview', '/dsh/moved') },
    ]
    for (const refusal of refusals) {
      expect(refusal).toThrow(expect.objectContaining({ code: 'ERR_DSH_VFS_DEFERRED' }))
      expect(refusal).toThrow(/lazy archive lazy\/abc\.tar\.gz supplies/)
    }
    expect(() => { vfs.mkdirSync(`/dsh/${PDF}`) }).toThrow(expect.objectContaining({ code: 'EEXIST' }))
  })

  it('leaves an empty destination directory in place when a tree with a registered file is refused', () => {
    const vfs = deferred(() => Promise.resolve(archive()))
    vfs.mkdirSync('/dsh/target')
    const mutations: VfsMutation[] = []
    vfs.subscribe((mutation) => { mutations.push(mutation) })
    expect(() => { vfs.renameSync('/dsh/node_modules/@scope/preview', '/dsh/target') })
      .toThrow(expect.objectContaining({ code: 'ERR_DSH_VFS_DEFERRED' }))
    expect(vfs.statSync('/dsh/target').isDirectory()).toBe(true)
    expect(vfs.existsSync(`/dsh/${PDF}`)).toBe(true)
    expect(mutations).toEqual([])
  })

  it('removes a registered file that is unlinked or removed with its directory', async () => {
    const vfs = deferred(() => Promise.resolve(archive()))
    vfs.unlinkSync(`/dsh/${PDF}`)
    expect(vfs.existsSync(`/dsh/${PDF}`)).toBe(false)
    expect(vfs.whenReadable(`/dsh/${PDF}`)).toBeUndefined()
    await vfs.whenReadable(`/dsh/${EXCEL}`)
    expect(vfs.existsSync(`/dsh/${PDF}`)).toBe(false)
    expect(vfs.readFileSync(`/dsh/${EXCEL}`, 'utf8')).toBe('module.exports = "excel"\n')

    const other = deferred(() => Promise.resolve(archive()))
    other.rmSync('/dsh/node_modules', { recursive: true })
    expect(other.existsSync(`/dsh/${EXCEL}`)).toBe(false)
  })

  it('replaces a registered file that the image or a store seeds again', () => {
    const vfs = deferred(() => Promise.resolve(archive()))
    vfs.seed(`/dsh/${PDF}`, 'seeded')
    expect(vfs.readFileSync(`/dsh/${PDF}`, 'utf8')).toBe('seeded')
    expect(vfs.whenReadable(`/dsh/${PDF}`)).toBeUndefined()
  })
})

describe('fetch', () => {
  it('fetches one archive once for concurrent readers and keeps each file identity', async () => {
    let resolve: ((bytes: Uint8Array) => void) | undefined
    const load = vi.fn(() => new Promise<Uint8Array>((settle) => { resolve = settle }))
    const vfs = deferred(load)
    const mutations: VfsMutation[] = []
    vfs.subscribe((mutation) => { mutations.push(mutation) })
    const before = (vfs.statSync(`/dsh/${PDF}`, { bigint: true }) as VfsBigIntStats).ino
    const reads = Promise.all([
      vfs.promises.readFile(`/dsh/${PDF}`, 'utf8'),
      vfs.promises.readFile(`/dsh/${EXCEL}`, 'utf8'),
    ])
    expect(load).toHaveBeenCalledTimes(1)
    resolve?.(archive())
    expect(await reads).toEqual(['module.exports = "pdf"\n', 'module.exports = "excel"\n'])
    expect(load).toHaveBeenCalledTimes(1)
    expect((vfs.statSync(`/dsh/${PDF}`, { bigint: true }) as VfsBigIntStats).ino).toBe(before)
    expect(vfs.readFileSync(`/dsh/${PDF}`, 'utf8')).toBe('module.exports = "pdf"\n')
    expect(vfs.whenReadable(`/dsh/${PDF}`)).toBeUndefined()
    // Arrival is hydration, not a runtime write.
    expect(mutations).toEqual([])
  })

  it('reports a failed fetch to the reader and retries on the next read', async () => {
    const load = vi.fn<() => Promise<Uint8Array>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(archive())
    const vfs = deferred(load)
    const failure: unknown = await vfs.promises.readFile(`/dsh/${PDF}`).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('webworker vfs: lazy archive lazy/abc.tar.gz could not be fetched')
    expect(((failure as Error).cause as Error).message).toBe('offline')
    expect(vfs.existsSync(`/dsh/${PDF}`)).toBe(true)
    expect(await vfs.promises.readFile(`/dsh/${PDF}`, 'utf8')).toBe('module.exports = "pdf"\n')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['an unregistered entry', () => packTar({ [PDF]: pdfBytes, [EXCEL]: excelBytes, 'node_modules/extra.js': pdfBytes }), /unregistered entry "node_modules\/extra\.js"/],
    ['a size other than registered', () => packTar({ [PDF]: excelBytes, [EXCEL]: excelBytes }), /holds \d+ bytes for/],
    ['a missing registered file', () => packTar({ [PDF]: pdfBytes }), /lacks registered file/],
  ])('refuses an archive with %s and leaves its files registered', async (_label, contents, message) => {
    const vfs = deferred(() => Promise.resolve(contents()))
    await expect(vfs.promises.readFile(`/dsh/${PDF}`)).rejects.toThrow(message)
    expect(() => vfs.readFileSync(`/dsh/${PDF}`)).toThrow(expect.objectContaining({ code: 'ERR_DSH_VFS_DEFERRED' }))
  })

  it('opens a promise handle only after the archive arrived', async () => {
    const vfs = deferred(() => Promise.resolve(archive()))
    const handle = await vfs.promises.open(`/dsh/${PDF}`)
    expect(await handle.readFile('utf8')).toBe('module.exports = "pdf"\n')
    await handle.close()
  })

  it('refuses to register a file twice or over an existing file', () => {
    const vfs = deferred(() => Promise.resolve(archive()))
    expect(() => { vfs.deferArchive({ name: 'lazy/other.tar.gz', root: '/dsh', files: [{ path: PDF, size: 1 }], load: () => Promise.resolve(archive()) }) })
      .toThrow(/already registered/)
    expect(() => {
      vfs.deferArchive({
        name: 'lazy/other.tar.gz', root: '/dsh', files: [{ path: 'node_modules/@scope/preview/lib/client.js', size: 1 }],
        load: () => Promise.resolve(archive()),
      })
    }).toThrow(/already registered/)
  })
})

describe('node:fs bridge', () => {
  it('serves asynchronous faces after the fetch and refuses synchronous ones before it', async () => {
    const vfs = deferred(() => Promise.resolve(archive()))
    setActiveVfs(vfs)
    expect(() => fs.readFileSync(`/dsh/${PDF}`)).toThrow(expect.objectContaining({ code: 'ERR_DSH_VFS_DEFERRED' }))
    expect(fs.existsSync(`/dsh/${PDF}`)).toBe(true)
    expect(await fsp.readFile(`/dsh/${PDF}`, 'utf8')).toBe('module.exports = "pdf"\n')

    const streamed: Buffer[] = []
    for await (const chunk of fs.createReadStream(`/dsh/${EXCEL}`)) streamed.push(chunk as Buffer)
    expect(Buffer.concat(streamed).toString('utf8')).toBe('module.exports = "excel"\n')
  })

  it('opens handles and copies trees whose files are still registered', async () => {
    const vfs = deferred(() => Promise.resolve(archive()))
    setActiveVfs(vfs)
    const handle = await fsp.open(`/dsh/${PDF}`)
    expect(await handle.readFile('utf8')).toBe('module.exports = "pdf"\n')
    await handle.close()

    const copied = deferred(() => Promise.resolve(archive()))
    setActiveVfs(copied)
    await fsp.cp('/dsh/node_modules/@scope/preview', '/dsh/copy')
    expect(fs.readFileSync('/dsh/copy/lib/client.excel.js', 'utf8')).toBe('module.exports = "excel"\n')
  })
})
