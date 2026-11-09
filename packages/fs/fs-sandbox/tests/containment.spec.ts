/**
 * Containment tests for lexical canonical paths and filesystem-identity aliases.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { isPathUnder } from '../src/containment.ts'

let base: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'dsh-fssbx-containment-'))
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('filesystem sandbox containment', () => {
  it('accepts equal paths, descendants, and a filesystem-root boundary', async () => {
    expect(await isPathUnder(base, base)).toBe(true)
    expect(await isPathUnder(join(base, 'child'), base)).toBe(true)
    expect(await isPathUnder(base, parse(base).root)).toBe(true)
  })

  it('uses case-insensitive lexical comparison for Windows-style containment', async () => {
    expect(await isPathUnder(join(base.toUpperCase(), 'child'), base.toLowerCase(), false)).toBe(true)
    expect(await isPathUnder(join(base, 'case-sensitive-child'), base, true)).toBe(true)
  })

  it('recognizes an alias-equivalent root by filesystem identity for a missing target', async () => {
    const realRoot = join(base, 'real')
    const aliasRoot = join(base, 'alias')
    await mkdir(realRoot)
    await symlink(realRoot, aliasRoot)
    expect(await isPathUnder(join(await realpath(realRoot), 'missing', 'file.txt'), aliasRoot)).toBe(true)
  })

  it('denies unrelated and missing roots', async () => {
    const allowed = join(base, 'allowed')
    const outside = join(base, 'outside')
    await mkdir(allowed)
    await mkdir(outside)
    expect(await isPathUnder(join(outside, 'file.txt'), allowed)).toBe(false)
    expect(await isPathUnder(join(outside, 'file.txt'), join(base, 'missing-root'))).toBe(false)
  })

  it('treats a regular-file path segment as a missing target, not containment', async () => {
    const allowed = join(base, 'allowed')
    const blocker = join(base, 'blocker')
    await mkdir(allowed)
    await writeFile(blocker, 'not a directory')
    expect(await isPathUnder(join(blocker, 'child.txt'), allowed)).toBe(false)
  })

  it('classifies an ancestor inspection fault as a filesystem error', async () => {
    const root = join(base, 'root')
    const loop = join(base, 'loop')
    await mkdir(root)
    await symlink(loop, loop)
    await expect(isPathUnder(loop, root)).rejects.toMatchObject({ name: 'FsError', code: 'FS_IO_ERROR' })
  })
})
