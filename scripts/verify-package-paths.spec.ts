import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findPackagePathViolations } from './verify-package-paths.ts'

const historicalPath = 'docs/persistence-changes/historical-formats/v3.md'
const removedReference = 'packages/fs/tool-present/src/types.ts'
const currentReference = 'packages/deliverables/tool-present/src/types.ts'
const start = '<!-- persistence-format-schema:start -->'
const end = '<!-- persistence-format-schema:end -->'

function scan(file: string, source: string) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-package-paths-'))
  try {
    const current = join(root, currentReference)
    mkdirSync(dirname(current), { recursive: true })
    writeFileSync(current, 'export {}\n')
    const path = join(root, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, source)
    return findPackagePathViolations(root, path, new Set(['tool-present']))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('historical package references', () => {
  it.each(['v0.md', 'v3.md', 'v10.zh.md'])('preserves checked historical source paths in %s', (name) => {
    const file = `docs/persistence-changes/historical-formats/${name}`
    for (const newline of ['\n', '\r\n']) {
      expect(scan(file, [start, removedReference, end].join(newline))).toEqual([])
    }
  })

  it.each(['md', 'zh.md'])('checks authored prose around the generated %s region at its original lines', (suffix) => {
    const file = `docs/persistence-changes/historical-formats/v3.${suffix}`
    expect(scan(file, [removedReference, start, removedReference, end, removedReference].join('\r\n')))
      .toEqual([{ file, line: 1, ref: removedReference }, { file, line: 5, ref: removedReference }])
  })

  it.each([
    'docs/persistence-catalog.md',
    'docs/persistence-catalog.zh.md',
    'docs/persistence-changes/historical-formats/README.md',
    'docs/persistence-changes/historical-formats/v03.md',
    'docs/persistence-changes/historical-formats/V3.md',
    'docs/persistence-changes/historical-formats-extra/v3.md',
  ])('keeps generated-looking content strict in %s', (file) => {
    expect(scan(file, [start, removedReference, end].join('\n')))
      .toEqual([{ file, line: 2, ref: removedReference }])
  })

  it.each([
    ['missing end', [start, removedReference]],
    ['missing start', [end, removedReference]],
    ['reversed markers', [end, removedReference, start]],
    ['duplicate start', [start, removedReference, start, end]],
    ['inline markers', [`${start}${end}`, removedReference]],
    ['indented marker', [` ${start}`, removedReference, end]],
    ['malformed marker', ['<!-- persistence-format-schema:start', removedReference, end]],
    ['split nested marker', [start, removedReference, '<!--\npersistence-format-schema:start -->', end]],
  ])('rejects stale package paths with %s', (_name, lines) => {
    expect(scan(historicalPath, lines.join('\n')))
      .toEqual([{ file: historicalPath, line: 2, ref: removedReference }])
  })

  it('retains existing-path and hypothetical-package handling outside historical content', () => {
    const file = 'docs/current.md'
    expect(scan(file, [currentReference, 'packages/hypothetical/unpublished/src/types.ts', removedReference].join('\n')))
      .toEqual([{ file, line: 3, ref: removedReference }])
  })
})
