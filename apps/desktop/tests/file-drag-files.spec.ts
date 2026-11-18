import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { DragFiles } from '../src/file-drag-files.ts'

async function files() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-drag-test-'))
  const store = new DragFiles(root)
  onTestFinished(async () => { await store.dispose(); await rm(root, { recursive: true, force: true }) })
  return { root, store }
}

it('exports original bytes and keeps a used file readable until disposal', async () => {
  const { root, store } = await files()
  const bytes = new Uint8Array([137, 80, 78, 71])
  const handle = await store.prepare(bytes, { name: '../../original.png', mediaType: 'image/png' })
  const path = store.take(handle)!
  expect(basename(path)).toBe('_.._original.png')
  expect(new Uint8Array(await readFile(path))).toEqual(bytes)
  await store.release(handle)
  expect(new Uint8Array(await readFile(path))).toEqual(bytes)
  await store.dispose()
  expect(await readdir(root)).toEqual([])
  expect(store.take(handle)).toBeUndefined()
})

it('accepts non-image and unknown types while rejecting writes after disposal', async () => {
  const { store } = await files()
  for (const [name, mediaType] of [['报告.pdf', 'application/pdf'], ['custom.asset', 'application/x-unknown']]) {
    const bytes = new Uint8Array([37, 80, 68, 70])
    const handle = await store.prepare(bytes, { name, mediaType: mediaType! })
    const path = store.take(handle, false)!
    expect(basename(path)).toBe(name)
    expect(new Uint8Array(await readFile(path))).toEqual(bytes)
  }
  expect(store.take('foreign')).toBeUndefined()
  await store.dispose()
  await expect(store.prepare(new Uint8Array([1]), { name: 'x.png', mediaType: 'image/png' })).rejects.toThrow('File drag temporary storage unavailable')
})

it('releases unused preparations and waits for a concurrent write before cleanup', async () => {
  const { root, store } = await files()
  const handle = await store.prepare(new Uint8Array([1]), { name: 'x.png', mediaType: 'image/png' })
  await store.release(handle)
  expect(await readdir(root)).toEqual([])
  const pending = store.prepare(new Uint8Array([2]), { name: 'y.png', mediaType: 'image/png' })
  const rejected = expect(pending).rejects.toThrow('File transfer closed')
  await store.dispose()
  await rejected
  expect(await readdir(root)).toEqual([])
})

it.each(['CON', 'prn', 'AUX', 'NUL', 'COM1', 'LPT9', 'COM¹', 'CON.extra'])('sanitizes the Windows device filename %s', async (name) => {
  const { store } = await files()
  const handle = await store.prepare(new Uint8Array([1]), { name: `${name}.png`, mediaType: 'image/png' })
  expect(basename(store.take(handle, false)!)).toBe(`_${name}.png`)
})

it('bounds all retained bytes, including pending writes, and frees unused capacity', async () => {
  const { store } = await files()
  const pending = store.prepare(new Uint8Array(64 * 1024 * 1024), { name: 'large.png', mediaType: 'image/png' })
  await expect(store.prepare(new Uint8Array([1]), { name: 'extra.png', mediaType: 'image/png' })).rejects.toThrow('File drag temporary storage unavailable')
  const handle = await pending
  await store.release(handle)
  await expect(store.prepare(new Uint8Array([1]), { name: 'extra.png', mediaType: 'image/png' })).resolves.toEqual(expect.any(String))
})
