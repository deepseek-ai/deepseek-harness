import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeOwnedDirectory } from '../src/owned-directory.ts'

const roots: string[] = []
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'desktop-owned-directory-'))
  roots.push(root)
  return root
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('removes nested files and directories while preserving unknown directory-link targets', () => {
  const root = fixture()
  const target = join(root, 'target')
  mkdirSync(target)
  writeFileSync(join(target, 'sentinel'), 'preserved')
  const owned = join(root, 'owned')
  const nested = join(owned, 'node_modules', '@unknown', 'private')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(nested, 'file'), 'remove')
  symlinkSync(target, join(nested, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  symlinkSync(join(root, 'missing-target'), join(owned, 'broken'), process.platform === 'win32' ? 'junction' : 'dir')
  removeOwnedDirectory(owned)
  expect(existsSync(owned)).toBe(false)
  expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('preserved')
})

it.each([false, true])('unlinks a root directory link with missing target: %s', (missing) => {
  const root = fixture()
  const target = join(root, 'target')
  if (!missing) {
    mkdirSync(target)
    writeFileSync(join(target, 'sentinel'), 'preserved')
  }
  const link = join(root, 'link')
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  removeOwnedDirectory(link)
  expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined()
  if (!missing) expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('preserved')
})

it('ignores a missing root and refuses to delete a regular-file root', () => {
  const root = fixture()
  expect(() => { removeOwnedDirectory(join(root, 'missing')) }).not.toThrow()
  const file = join(root, 'file')
  writeFileSync(file, 'preserved')
  expect(() => { removeOwnedDirectory(file) }).toThrow(/not a directory/u)
  expect(readFileSync(file, 'utf8')).toBe('preserved')
})
