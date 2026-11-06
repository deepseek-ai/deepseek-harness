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

it('walks shipped package files and skips dot directories holding transient roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-stylesheet-scan-'))
  roots.push(root)
  mkdirSync(join(root, 'pkg'))
  writeFileSync(join(root, 'pkg', 'package.json'), '{}')
  mkdirSync(join(root, '.typert-worker-failure-probe'))
  writeFileSync(join(root, '.typert-worker-failure-probe', 'package.json'), '{}')

  expect(packageFiles(name => name === 'package.json', root)).toEqual([`${root}/pkg/package.json`])
})
