import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(), rm: vi.fn(), writeFile: vi.fn(),
}))
const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const { DragFiles } = await import('../src/file-drag-files.ts')
afterEach(() => { vi.mocked(rm).mockReset(); vi.mocked(writeFile).mockReset(); vi.useRealTimers() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-image-release-'))
  const store = new DragFiles(root)
  vi.mocked(rm).mockImplementation(fs.rm)
  vi.mocked(writeFile).mockImplementation(fs.writeFile)
  onTestFinished(async () => {
    vi.mocked(rm).mockImplementation(fs.rm)
    await store.dispose()
    await fs.rm(root, { recursive: true, force: true })
  })
  const handle = await store.prepare(new Uint8Array([1]), { name: 'image.png', mediaType: 'image/png' })
  return { root, store, handle }
}

it('waits for an in-flight release before disposal completes', async () => {
  const { root, store, handle } = await fixture()
  const barrier = Promise.withResolvers<undefined>()
  vi.mocked(rm).mockImplementationOnce(async (path, options) => { await barrier.promise; await fs.rm(path, options) })
  const releasing = store.release(handle)
  const secondRelease = store.release(handle)
  expect(store.take(handle, false)).toBeUndefined()
  let stopped = false
  const disposing = store.dispose().then(() => { stopped = true })
  await Promise.resolve()
  expect(stopped).toBe(false)
  expect(await readdir(root)).toHaveLength(1)
  barrier.resolve(undefined)
  await Promise.all([releasing, secondRelease, disposing])
  expect(await readdir(root)).toEqual([])
})

it('retains a partial write whose immediate cleanup fails for disposal to retry', async () => {
  const { root, store } = await fixture()
  await store.prepare(new Uint8Array(0), { name: 'empty', mediaType: '' })
  vi.mocked(writeFile).mockImplementationOnce(async (path, data, options) => {
    await fs.writeFile(path, data, options)
    throw new Error('disk full after partial write')
  })
  vi.mocked(rm).mockRejectedValueOnce(new Error('file busy'))
  await expect(store.prepare(new Uint8Array(64 * 1024 * 1024 - 1), { name: 'partial.pdf', mediaType: 'application/pdf' })).rejects.toThrow('file busy')
  await expect(store.prepare(new Uint8Array([2]), { name: 'later', mediaType: '' })).rejects.toThrow('File drag temporary storage unavailable')
  await store.dispose()
  expect(await readdir(root)).toEqual([])
})

it('reclaims delivered temporary bytes after the receiver grace period', async () => {
  const { root, store, handle } = await fixture()
  vi.useFakeTimers()
  store.take(handle)
  await store.release(handle)
  expect(await readdir(root)).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(60_000)
  await store.dispose()
  expect(await readdir(root)).toEqual([])
})

it('retains a failed release for the shutdown cleanup to retry', async () => {
  const { root, store, handle } = await fixture()
  const path = store.take(handle, false)!
  vi.mocked(rm).mockRejectedValueOnce(new Error('file busy'))
  await expect(store.release(handle)).rejects.toThrow('file busy')
  expect(new Uint8Array(await readFile(path))).toEqual(new Uint8Array([1]))
  await store.dispose()
  expect(await readdir(root)).toEqual([])
})

it('waits for all removals before reporting a shutdown cleanup failure', async () => {
  const { store } = await fixture()
  await store.prepare(new Uint8Array([2]), { name: 'second.png', mediaType: 'image/png' })
  const barrier = Promise.withResolvers<undefined>()
  vi.mocked(rm).mockRejectedValueOnce(new Error('file busy'))
    .mockImplementationOnce(async (path, options) => { await barrier.promise; await fs.rm(path, options) })
  let settled = false
  const disposing = store.dispose().finally(() => { settled = true })
  const rejected = expect(disposing).rejects.toThrow('file busy')
  await vi.waitFor(() => { expect(rm).toHaveBeenCalledTimes(2) })
  expect(settled).toBe(false)
  barrier.resolve(undefined)
  await rejected
  await store.dispose()
})
