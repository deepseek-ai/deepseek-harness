/** Whole-file capture storage and content comparison. */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { captureFile, sameCapture } from '../src/capture.ts'
import { scratchDir } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

describe('captureFile', () => {
  it('stores text once by content, reads no more than the cap, and classifies absent, oversized, binary, and non-regular paths', async () => {
    const root = await scratchDir('dsh-capture-', cleanups)
    const store = join(root, 'captures')
    await writeFile(join(root, 'a.txt'), 'one\ntwo\n')
    await writeFile(join(root, 'same.txt'), 'one\ntwo\n')
    await writeFile(join(root, 'big.txt'), 'x'.repeat(17))
    await writeFile(join(root, 'bin.dat'), Uint8Array.of(65, 0, 66))
    await mkdir(join(root, 'dir'))
    const a = await captureFile(join(root, 'a.txt'), store, 16)
    const same = await captureFile(join(root, 'same.txt'), store, 16)
    expect(a).toMatchObject({ kind: 'file', binary: false })
    expect(same).toEqual(a)
    if (a?.kind !== 'file' || same === undefined) throw new Error('expected a stored copy')
    expect(await readFile(a.file, 'utf8')).toBe('one\ntwo\n')
    expect(await readdir(store)).toHaveLength(1)
    expect(await captureFile(join(root, 'big.txt'), store, 16)).toEqual({ kind: 'oversized' })
    expect(await captureFile(join(root, 'missing.txt'), store, 16)).toEqual({ kind: 'absent' })
    expect(await captureFile(join(root, 'bin.dat'), store, 16)).toMatchObject({ kind: 'file', binary: true })
    expect(await captureFile(join(root, 'dir'), store, 16)).toBeUndefined()
    // The cap is inclusive: exactly `maxBytes` is stored, one byte more is not.
    await writeFile(join(root, 'edge.txt'), 'y'.repeat(16))
    expect(await captureFile(join(root, 'edge.txt'), store, 16)).toMatchObject({ kind: 'file' })
    expect(sameCapture({ kind: 'absent' }, { kind: 'absent' })).toBe(true)
    expect(sameCapture({ kind: 'absent' }, { kind: 'oversized' })).toBe(false)
    expect(sameCapture(a, same)).toBe(true)
    expect(sameCapture(a, { kind: 'file', file: 'elsewhere', binary: false })).toBe(false)
    // Unread content is never known to match: two oversized sides may differ.
    expect(sameCapture({ kind: 'oversized' }, { kind: 'oversized' })).toBe(false)
    expect(sameCapture({ kind: 'oversized' }, a)).toBe(false)
  })
})
