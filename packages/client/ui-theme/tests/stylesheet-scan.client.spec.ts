/** Tests for the package-tree scan helpers that the stylesheet contracts range over. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { packageFiles } from './stylesheet-scan.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('skips dot directories holding transient roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-stylesheet-scan-'))
  roots.push(root)
  mkdirSync(join(root, 'pkg', 'nested'), { recursive: true })
  writeFileSync(join(root, 'pkg', 'package.json'), '{}')
  writeFileSync(join(root, 'pkg', 'nested', 'package.json'), '{}')
  mkdirSync(join(root, '.typert-worker-failure-probe'))
  writeFileSync(join(root, '.typert-worker-failure-probe', 'package.json'), '{}')

  // The helper reports `/`-separated paths on every platform, so the Windows
  // temporary root's separators must not reach the expectation. Traversal
  // reports the nested manifest before its parent, and directory order is not
  // guaranteed, so both sides are compared sorted.
  const normalized = root.replaceAll('\\', '/')
  expect(packageFiles(name => name === 'package.json', root).sort()).toEqual([
    `${normalized}/pkg/nested/package.json`,
    `${normalized}/pkg/package.json`,
  ])
})
