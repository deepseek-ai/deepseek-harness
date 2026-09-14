import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findConcreteTermViolations, readTrackedSource } from './verify-concrete-terms.ts'

const blockedTerm = 'prove' + 'nance'

describe('concrete terminology policy', () => {
  it('rejects case variants in paths, prose, and identifiers', () => {
    expect(findConcreteTermViolations(`docs/${blockedTerm}-notes.md`, [
      'origin metadata',
      blockedTerm.toUpperCase(),
      `Assistant${blockedTerm[0]?.toUpperCase()}${blockedTerm.slice(1)}`,
    ].join('\n'))).toEqual([
      { file: `docs/${blockedTerm}-notes.md`, line: null },
      { file: `docs/${blockedTerm}-notes.md`, line: 2 },
      { file: `docs/${blockedTerm}-notes.md`, line: 3 },
    ])
  })

  it('scans text that contains an embedded NUL', () => {
    expect(findConcreteTermViolations('packages/example/src/source.ts', `scope\0${blockedTerm}`))
      .toEqual([{ file: 'packages/example/src/source.ts', line: 1 }])
  })

  it('normalizes compatibility characters before scanning', () => {
    const fullwidthTerm = blockedTerm.split('')
      .map(character => String.fromCodePoint(character.charCodeAt(0) + 0xfee0))
      .join('')
    expect(findConcreteTermViolations('packages/example/src/source.ts', fullwidthTerm))
      .toEqual([{ file: 'packages/example/src/source.ts', line: 1 }])
  })

  it.skipIf(process.platform === 'win32')('reads the target of a dangling tracked symlink', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'dsh-concrete-terms-'))
    try {
      symlinkSync(`../${blockedTerm}-target`, join(repoRoot, 'tracked-link'))
      expect(findConcreteTermViolations(
        'tracked-link',
        readTrackedSource(repoRoot, 'tracked-link') ?? '',
      )).toEqual([{ file: 'tracked-link', line: 1 }])
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it('accepts exact replacement terms', () => {
    expect(findConcreteTermViolations(
      'packages/example/src/origin.ts',
      'provider metadata; source-event references; artifact identity; browser-zone evidence',
    )).toEqual([])
  })

  it('excludes vendored sources and frozen Agent Notes', () => {
    expect(findConcreteTermViolations(`vendor/example/${blockedTerm}.ts`, blockedTerm)).toEqual([])
    expect(findConcreteTermViolations(
      `.agents/notes/archived/process/${blockedTerm}.md`,
      blockedTerm,
    )).toEqual([])
    expect(findConcreteTermViolations(
      '.agents/notes/implemented/process/current.md',
      blockedTerm,
    )).toEqual([{ file: '.agents/notes/implemented/process/current.md', line: 1 }])
  })

  it('preserves historical identifiers only in alpha and RC release schema snapshots', () => {
    for (const channel of ['alpha', 'rc']) {
      expect(findConcreteTermViolations(
        `docs/persistence-changes/releases/dsh-v0.1.2-${channel}.1.schema.json`,
        `{"names":["Historical${blockedTerm}"]}`,
      )).toEqual([])
    }
    for (const file of [
      'docs/persistence-changes/releases/dsh-v0.1.2-alpha.1.md',
      'docs/persistence-changes/releases/dsh-v0.1.2-alpha.1.zh.md',
      'docs/persistence-changes/releases/README.md',
      'docs/persistence-changes/releases/manifest.json',
      'docs/persistence-changes/releases/other.schema.json',
      'docs/persistence-changes/2026-09-11-initial.schema.json',
      'docs/persistence-schema.json',
      'packages/example/src/types.ts',
    ]) {
      expect(findConcreteTermViolations(file, blockedTerm)).toEqual([{ file, line: 1 }])
    }
  })

  it.each(['0', '1', '2', '10'])('preserves historical identifiers in the canonical v%s machine schema', (version) => {
    expect(findConcreteTermViolations(`docs/persistence-changes/historical-formats/v${version}.schema.json`, blockedTerm)).toEqual([])
  })

  it.each([
    'docs/persistence-changes/historical-formats/v00.schema.json',
    'docs/persistence-changes/historical-formats/v01.schema.json',
    'docs/persistence-changes/historical-formats/v-1.schema.json',
    'docs/persistence-changes/historical-formats/v1.zh.schema.json',
    'docs/persistence-changes/historical-formats/v1.schema.json.backup',
    'docs/persistence-changes/historical-formats/V1.schema.json',
    'docs/persistence-changes/historical-formats/versions/v1.schema.json',
    'docs/persistence-changes/historical-formats-extra/v1.schema.json',
    'docs/other/persistence-changes/historical-formats/v1.schema.json',
    'docs/persistence-schema.json',
  ])('keeps machine content strict outside canonical historical schema path %s', (file) => {
    expect(findConcreteTermViolations(file, blockedTerm)).toEqual([{ file, line: 1 }])
  })

  it.each(['md', 'zh.md'])('exempts only generated historical schema lines in %s references', (suffix) => {
    const file = `docs/persistence-changes/historical-formats/v2.${suffix}`
    for (const newline of ['\n', '\r\n']) {
      expect(findConcreteTermViolations(file, [
        `Authored ${blockedTerm}.`,
        '<!-- persistence-format-schema:start -->',
        `Historical${blockedTerm}`,
        `Nested historical ${blockedTerm}.`,
        '<!-- persistence-format-schema:end -->',
        `Authored ${blockedTerm}.`,
      ].join(newline))).toEqual([{ file, line: 1 }, { file, line: 6 }])
    }
  })

  it.each([
    'docs/persistence-changes/historical-formats/v00.md',
    'docs/persistence-changes/historical-formats/v01.zh.md',
    'docs/persistence-changes/historical-formats/v-1.md',
    'docs/persistence-changes/historical-formats/v1.zh.zh.md',
    'docs/persistence-changes/historical-formats/v1.md.backup',
    'docs/persistence-changes/historical-formats/V1.md',
    'docs/persistence-changes/historical-formats/README.md',
    'docs/persistence-changes/historical-formats-extra/v1.md',
    'docs/other/persistence-changes/historical-formats/v1.zh.md',
    'docs/persistence-catalog.md',
    'docs/persistence-catalog.zh.md',
    'docs/persistence-schema.json',
  ])('keeps generated-looking content strict outside canonical historical reference path %s', (file) => {
    expect(findConcreteTermViolations(file, [
      '<!-- persistence-format-schema:start -->', blockedTerm, '<!-- persistence-format-schema:end -->',
    ].join('\n'))).toEqual([{ file, line: 2 }])
  })

  it.each([
    ['no markers', []],
    ['missing end', ['<!-- persistence-format-schema:start -->']],
    ['missing start', ['<!-- persistence-format-schema:end -->']],
    ['reversed', ['<!-- persistence-format-schema:end -->', '<!-- persistence-format-schema:start -->']],
    ['duplicate start', ['<!-- persistence-format-schema:start -->', '<!-- persistence-format-schema:start -->', '<!-- persistence-format-schema:end -->']],
    ['duplicate end', ['<!-- persistence-format-schema:start -->', '<!-- persistence-format-schema:end -->', '<!-- persistence-format-schema:end -->']],
    ['nested pair', ['<!-- persistence-format-schema:start -->', '<!-- persistence-format-schema:start -->', '<!-- persistence-format-schema:end -->', '<!-- persistence-format-schema:end -->']],
    ['second pair', ['<!-- persistence-format-schema:start -->', '<!-- persistence-format-schema:end -->', '<!-- persistence-format-schema:start -->', '<!-- persistence-format-schema:end -->']],
    ['inline pair', ['<!-- persistence-format-schema:start --><!-- persistence-format-schema:end -->']],
    ['indented start', [' <!-- persistence-format-schema:start -->', '<!-- persistence-format-schema:end -->']],
    ['malformed start', ['<!-- persistence-format-schema:start', '<!-- persistence-format-schema:end -->']],
    ['malformed end', ['<!-- persistence-format-schema:start -->', '<!-- persistence-format-schema:end']],
    ['malformed nested marker', ['<!-- persistence-format-schema:start -->', '<!--persistence-format-schema:start', '<!-- persistence-format-schema:end -->']],
    ['uppercase nested marker', ['<!-- persistence-format-schema:start -->', '<!-- PERSISTENCE-FORMAT-SCHEMA:start -->', '<!-- persistence-format-schema:end -->']],
    ['unknown nested marker', ['<!-- persistence-format-schema:start -->', '<!-- persistence-format-schema:other -->', '<!-- persistence-format-schema:end -->']],
    ['split nested marker', ['<!-- persistence-format-schema:start -->', '<!--\npersistence-format-schema:start -->', '<!-- persistence-format-schema:end -->']],
    ['other marker prefix', ['<!-- persistence-release-schema:start -->', '<!-- persistence-release-schema:end -->']],
    ['index marker', ['<!-- persistence-format-index:start -->', '<!-- persistence-format-index:end -->']],
  ])('exempts no lines with %s', (_label, markers) => {
    const file = 'docs/persistence-changes/historical-formats/v1.md'
    const lines = [blockedTerm, ...markers.flatMap(marker => [marker, blockedTerm])].join('\n').split('\n')
    const expected = lines.flatMap((line, index) => line === blockedTerm ? [{ file, line: index + 1 }] : [])
    expect(findConcreteTermViolations(file, lines.join('\n'))).toEqual(expected)
  })

  it('keeps marker lines strict when they contain authored text', () => {
    const file = 'docs/persistence-changes/historical-formats/v1.md'
    expect(findConcreteTermViolations(file, [
      `<!-- persistence-format-schema:start --> ${blockedTerm}`,
      blockedTerm,
      `<!-- persistence-format-schema:end --> ${blockedTerm}`,
    ].join('\n'))).toEqual([{ file, line: 1 }, { file, line: 2 }, { file, line: 3 }])
  })
})
