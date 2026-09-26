/** Regression tests for bilingual snapshots, corpus scope, and structure. */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gitIndexPaths, readGitIndexBlob } from './translation-pairing-git.ts'
import {
  computeTranslationPairingRecord,
  parseTranslationPairingRecord,
  renderTranslationPairingRecord,
  translationPairingRecordDiff,
  translationPairPaths,
  type TranslationPairingRecord,
} from './translation-pairing-record.ts'
import {
  isTranslationPairingManifestExcluded,
  isTranslationScopeFile,
  languageSwitcherTargets,
  pairAnchorOfArgument,
  parseTranslationMarkdown,
  parseTranslationPairingCliArgs,
  parseTranslationPairingManifest,
  generatedRegions,
  renderGeneratedRegion,
  spliceGeneratedRegion,
  requiresSourceLanguageSwitcher,
  translationPairSourcePredicate,
  translationStructureDiff,
  translationStructureSignature,
} from './translation-pairing.ts'

const fixturePairSource = (): boolean => true

function signature(markdown: string) {
  return translationStructureSignature(
    parseTranslationMarkdown(markdown),
    'counterpart.zh.md',
    {
      repoRoot: process.cwd(), sourcePath: 'counterpart.md',
      isTranslationPairSource: fixturePairSource, repositoryFileExists: () => true, markdown,
    },
  )
}

function fixtureSignature(
  root: string,
  sourcePath: string,
  markdown: string,
  switcherTarget: string,
) {
  return translationStructureSignature(
    parseTranslationMarkdown(markdown),
    switcherTarget,
    { repoRoot: root, sourcePath, isTranslationPairSource: fixturePairSource, markdown },
  )
}

describe('translation pairing index reads', () => {
  it('reads staged bytes independently of the working tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-translation-pairing-index-'))
    try {
      execFileSync('git', ['init', '--quiet', root], {
        env: { ...process.env, GIT_DEFAULT_HASH: 'sha1' },
      })
      execFileSync('git', ['-C', root, 'config', 'user.email', 'pairing@example.test'])
      execFileSync('git', ['-C', root, 'config', 'user.name', 'Pairing Test'])
      writeFileSync(join(root, 'owner.md'), 'staged')
      execFileSync('git', ['-C', root, 'add', 'owner.md'])
      writeFileSync(join(root, 'owner.md'), 'unstaged')

      expect(readGitIndexBlob(root, 'owner.md')?.toString('utf8')).toBe('staged')
      expect(readGitIndexBlob(root, 'absent.md')).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lists exact index files without treating a directory prefix as one entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-translation-pairing-index-'))
    try {
      execFileSync('git', ['init', '--quiet', root], {
        env: { ...process.env, GIT_DEFAULT_HASH: 'sha1' },
      })
      mkdirSync(join(root, 'docs'), { recursive: true })
      writeFileSync(join(root, 'docs/reference.md'), '# Reference\n')
      writeFileSync(join(root, 'docs/reference.zh.md'), '# 参考\n')
      execFileSync('git', ['-C', root, 'add', 'docs'])

      expect(gitIndexPaths(root)).toEqual(new Set([
        'docs/reference.md',
        'docs/reference.zh.md',
      ]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('translation pairing manifest', () => {
  it('accepts an exclusions-only manifest', () => {
    const manifest = parseTranslationPairingManifest(JSON.stringify({
      excluded: ['docs/generated/'],
    }))
    expect(manifest).toEqual({
      excluded: ['docs/generated/'],
    })
    expect(isTranslationPairingManifestExcluded('docs/generated/page.md', manifest)).toBe(true)
    expect(translationPairSourcePredicate(manifest)('docs/generated/page.md')).toBe(false)
    expect(translationPairSourcePredicate(manifest)('docs/guide.md')).toBe(true)
    expect(translationPairSourcePredicate(manifest)('packages/example/guide.md')).toBe(false)
  })

  it.each([
    ['required', ['packages/README.md']],
    ['requiredClasses', ['readme']],
    ['requiredSince', '2026-07-14'],
  ] as const)('rejects obsolete policy field %s instead of accepting an inert requirement', (field, value) => {
    expect(() => parseTranslationPairingManifest(JSON.stringify({
      excluded: [],
      [field]: value,
    }))).toThrow(`unsupported field(s): ${field}; every in-scope document is required`)
  })

  it('rejects a missing or non-string exclusion list', () => {
    expect(() => parseTranslationPairingManifest('{}')).toThrow('excluded must be an array of strings')
    expect(() => parseTranslationPairingManifest(JSON.stringify({
      excluded: [42],
    }))).toThrow('excluded must be an array of strings')
  })
})

describe('translation pairing switchers', () => {
  it('exempts only paired generated English sources from reciprocal switchers', () => {
    expect(requiresSourceLanguageSwitcher('docs/config-catalog.md')).toBe(false)
    expect(requiresSourceLanguageSwitcher('docs/cordis-api/context.md')).toBe(false)
    expect(requiresSourceLanguageSwitcher('docs/cordis-api/inherited.md')).toBe(false)
    expect(requiresSourceLanguageSwitcher('docs/architecture.md')).toBe(true)
    expect(requiresSourceLanguageSwitcher('packages/core/session/README.md')).toBe(true)
  })

  it('accepts only the canonical public URL for an absolute switcher', () => {
    const targets = languageSwitcherTargets('python/sdk/README.zh.md')
    const canonicalMarkdown = '# README\n\nEnglish | [中文](https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk/README.zh.md)\n'
    const canonical = parseTranslationMarkdown(canonicalMarkdown)
    const wrongMarkdown = '# README\n\nEnglish | [中文](https://github.com/deepseek-ai/deepseek-harness/blob/master/other/README.zh.md)\n'
    const wrongPath = parseTranslationMarkdown(wrongMarkdown)

    expect(translationStructureSignature(canonical, targets, {
      repoRoot: process.cwd(),
      sourcePath: 'python/sdk/README.md',
      isTranslationPairSource: fixturePairSource,
      markdown: canonicalMarkdown,
    }).links).toEqual([])
    expect(translationStructureSignature(wrongPath, targets, {
      repoRoot: process.cwd(),
      sourcePath: 'python/sdk/README.md',
      isTranslationPairSource: fixturePairSource,
      markdown: wrongMarkdown,
    }).links).toEqual([
      'https://github.com/deepseek-ai/deepseek-harness/blob/master/other/README.zh.md',
    ])
  })

  it('excludes only the header switcher from the structural links', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-translation-switcher-'))
    try {
      writeFileSync(join(root, 'guide.md'), '# Guide\n')
      writeFileSync(join(root, 'guide.zh.md'), '# 指南\n')
      const markdown = '# 指南\n\n[English](guide.md) | 中文\n\n[正文](guide.md)\n'
      expect(translationStructureSignature(
        parseTranslationMarkdown(markdown),
        languageSwitcherTargets('guide.md'),
        {
          repoRoot: root, sourcePath: 'guide.zh.md',
          isTranslationPairSource: fixturePairSource, markdown,
        },
      ).links).toEqual(['dsh-translation-target:guide.md'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('translation pairing link language parity', () => {
  it('compares a .zh.md target and its .md sibling as the same document', () => {
    const en = 'See [docs](persistence.md) and [notes](note.md#anchor).'
    const zh = '参见[文档](persistence.zh.md)与[笔记](note.zh.md#anchor)。'
    expect(
      translationStructureDiff(
        signature(en),
        signature(zh),
      ),
    ).toEqual([])
  })

  it('still rejects a genuinely different target', () => {
    const en = 'See [docs](persistence.md).'
    const zh = '参见[文档](other.md)。'
    expect(
      translationStructureDiff(
        signature(en),
        signature(zh),
      ),
    ).not.toEqual([])
  })
})

describe('translation pairing records', () => {
  const paths = translationPairPaths('docs/foo.md')
  const context = { repoRoot: process.cwd(), isTranslationPairSource: fixturePairSource, repositoryFileExists: () => true }
  const record = (en: string, zh: string): TranslationPairingRecord => (
    computeTranslationPairingRecord(paths, en, zh, context)
  )
  const en = [
    '# Guide', '', 'English | [中文](foo.zh.md)', '', 'Intro.', '',
    '## Events', '', 'Event table.', '', '| Event | Mode |', '| --- | --- |', '| `a` | `emit` |', '| `b` | `emit` |', '',
    '## Code', '', '```sh', 'pnpm run x', '```', '',
  ].join('\n')
  const zh = [
    '# 指南', '', '[English](foo.md) | 中文', '', '简介。', '',
    '## 事件', '', '事件表。', '', '| Event | Mode |', '| --- | --- |', '| `a` | `emit` |', '| `b` | `emit` |', '',
    '## 代码', '', '```sh', 'pnpm run x', '```', '',
  ].join('\n')

  it('keys sections by English heading path and hashes everything outside code blocks and generated regions', () => {
    const computed = record(en, zh)
    expect([...computed.keys()]).toEqual(['/guide', '/guide/events', '/guide/code'])
    expect(record(en.replace('pnpm run x', 'pnpm run y'), zh.replace('pnpm run x', 'pnpm run y'))).toEqual(computed)
    expect(record(
      en.replace('| `b` | `emit` |', '| `b` | `emit` |\n| `c` | `emit` |'),
      zh.replace('| `b` | `emit` |', '| `b` | `emit` |\n| `c` | `emit` |'),
    )).not.toEqual(computed)
    const region = (rows: string): string => renderGeneratedRegion('events', `| Event |\n| --- |\n${rows}`)
    expect(record(`${en}\n${region('| `a` |')}\n`, `${zh}\n${region('| `a` |')}\n`))
      .toEqual(record(`${en}\n${region('| `b` |')}\n`, `${zh}\n${region('| `b` |')}\n`))
    expect(record(`${en}\n## \`x\`\n\nshared\n`, `${zh}\n## \`x\`\n\nshared\n`).has('/guide/x')).toBe(true)
    const packaged = renderGeneratedRegion('pkg', '## `x`\n\n- `inject`: `a`\n\n```sh\nx\n```')
    expect(record(`${en}\n${packaged}\n`, `${zh}\n${packaged}\n`).has('/guide/x')).toBe(false)
  })

  it('treats locale-localized paired links, frontmatter, and repeated headings deterministically', () => {
    const computed = record(
      `---\nkind: guide\n---\n${en}\nSee [bar](bar.md).\n\n## Events\n\nAgain.\n`,
      `---\nkind: 指南\n---\n${zh}\nSee [bar](bar.zh.md).\n\n## 事件\n\n再次。\n`,
    )
    expect([...computed.keys()]).toEqual(['/', '/guide', '/guide/events', '/guide/code', '/guide/events~2'])
    expect(record(`${en}\nSee [bar](bar.md).\n`, `${zh}\nSee [bar](bar.zh.md).\n`))
      .toEqual(record(`${en}\nSee [bar](bar.zh.md).\n`, `${zh}\nSee [bar](bar.md).\n`))
  })

  it('refuses sides with different heading counts', () => {
    expect(() => record(en, `${zh}\n## 额外\n`)).toThrow('docs/foo.md has 3 heading(s) but docs/foo.zh.md has 4')
  })

  it('round-trips the canonical record and rejects malformed entries', () => {
    const computed = record(en, zh)
    const text = renderTranslationPairingRecord(paths, computed)
    expect(parseTranslationPairingRecord(text)).toEqual(computed)
    expect(parseTranslationPairingRecord(`/a:\n  en: ${'1'.repeat(16)}\n`)).toBeUndefined()
    expect(parseTranslationPairingRecord(`/a:\n  zh: ${'1'.repeat(16)}\n  en: ${'1'.repeat(16)}\n`)).toBeUndefined()
    expect(parseTranslationPairingRecord(
      `/a:\n  en: ${'1'.repeat(16)}\n  zh: ${'1'.repeat(16)}\n`.repeat(2),
    )).toBeUndefined()
    expect(parseTranslationPairingRecord('foo.md: 3f786850e387550fdab836ed7e6dc881de23001b\n')).toBeUndefined()
  })

  it('names changed, unconfirmed, and removed sections', () => {
    const confirmed = record(en, zh)
    expect(translationPairingRecordDiff(confirmed, confirmed)).toEqual([])
    expect(translationPairingRecordDiff(confirmed, record(en.replace('Intro.', 'Intro!'), zh)))
      .toEqual(['section /guide changed since confirmation (en)'])
    expect(translationPairingRecordDiff(confirmed, record(`${en}\n## Tail\n\nx\n`, `${zh}\n## 尾部\n\ny\n`)))
      .toEqual(['section /guide/tail has unconfirmed translated content'])
    expect(translationPairingRecordDiff(
      new Map([...confirmed, ['/gone', { en: '0'.repeat(16), zh: '0'.repeat(16) }]]),
      confirmed,
    )).toEqual(['section /gone is recorded but no longer has translated content'])
  })

  it('merges records of edits to different sections with the default text merge', () => {
    const edit = (heading: string, english: string, chinese: string): string => renderTranslationPairingRecord(
      paths,
      record(en.replace(heading, english), zh.replace(heading === 'Intro.' ? '简介。' : '事件表。', chinese)),
    )
    const root = mkdtempSync(join(tmpdir(), 'dsh-translation-pairing-merge-'))
    try {
      writeFileSync(join(root, 'base'), renderTranslationPairingRecord(paths, record(en, zh)))
      writeFileSync(join(root, 'current'), edit('Intro.', 'New intro.', '新简介。'))
      writeFileSync(join(root, 'other'), edit('Event table.', 'New table.', '新表。'))
      const merged = spawnSync('git', ['merge-file', '-p', 'current', 'base', 'other'], { cwd: root, encoding: 'utf8' })
      expect(merged.status).toBe(0)
      expect(merged.stdout).toBe(renderTranslationPairingRecord(paths, record(
        en.replace('Intro.', 'New intro.').replace('Event table.', 'New table.'),
        zh.replace('简介。', '新简介。').replace('事件表。', '新表。'),
      )))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('translation scope discovery', () => {
  it.each([
    'README.md',
    'CONTRIBUTING.md',
    'CONTRIBUTING.zh.md',
    'CONTRIBUTING.i18n.yaml',
    'BRAND_GUIDELINES.md',
    'BRAND_GUIDELINES.zh.md',
    'BRAND_GUIDELINES.i18n.yaml',
    'SAFETY.md',
    'SAFETY.zh.md',
    'SAFETY.i18n.yaml',
    'apps/cli/README.md',
    'future/subtree/readme.md',
    'packages/example/README.zh.md',
    'native/example/README.i18n.yaml',
    '.agents/notes/proposed/feature.md',
    'docs/guide.md',
    'python/guide.md',
    'python/sdk-runtime/README.md',
    'python/sdk-runtime/src/deepseek_harness_runtime/README.md',
  ])('includes %s', (file) => {
    expect(isTranslationScopeFile(file)).toBe(true)
  })

  it.each([
    'packages/example/guide.md',
    'packages/example/CONTRIBUTING.md',
    'packages/example/BRAND_GUIDELINES.md',
    'other/tutorial.md',
    'website/reference.md',
    'packages/example/README.txt',
    'vendor/example/README.md',
    'packages/example/node_modules/dependency/README.md',
    'packages/example/lib/README.md',
    'coverage/report/README.md',
    'python/sdk-runtime/src/deepseek_harness_runtime/runtime/deepseek-harness-sdk-runtime-macos-arm64/README.md',
    'python/sdk-runtime/src/deepseek_harness_runtime/runtime/node/README.md',
    'python/sdk-runtime/src/deepseek_harness_runtime/runtime/macos-arm64/office-skills/office-docx/SKILL.md',
  ])('excludes non-source or non-README path %s', (file) => {
    expect(isTranslationScopeFile(file)).toBe(false)
  })
})

describe('translation structural signature', () => {
  it('retains external GFM autolinks without parsing inline-link syntax', () => {
    const markdown = '<https://example.com/reference.md>\n'
    expect(signature(markdown).links).toEqual(['https://example.com/reference.md'])
  })

  it('retains exact authored bytes for ordinary external link targets', () => {
    const escaped = signature('[External](https://example.com/?x=1&amp;y=2)\n')
    const literal = signature('[External](https://example.com/?x=1&y=2)\n')
    expect(escaped.links).toEqual(['https://example.com/?x=1&amp;y=2'])
    expect(translationStructureDiff(escaped, literal)).toEqual([
      'link target #1 diverges between the pair: "https://example.com/?x=1&amp;y=2" vs "https://example.com/?x=1&y=2"',
    ])
  })

  it('treats target-locale siblings as one semantic link target', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-translation-structure-'))
    try {
      writeFileSync(join(root, 'reference.md'), '# Reference\n')
      writeFileSync(join(root, 'reference.zh.md'), '# 参考\n')
      const sourceMarkdown = '[Reference](reference.md?view=full#section)\n'
      const counterpartMarkdown = '[参考](reference.zh.md?view=full#section)\n'
      const source = fixtureSignature(root, 'guide.md', sourceMarkdown, 'guide.zh.md')
      const counterpart = fixtureSignature(root, 'guide.zh.md', counterpartMarkdown, 'guide.md')
      expect(translationStructureDiff(source, counterpart)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('includes reference-style document links but excludes image-only definitions', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-translation-structure-'))
    try {
      writeFileSync(join(root, 'reference.md'), '# Reference\n')
      writeFileSync(join(root, 'reference.zh.md'), '# 参考\n')
      const markdown = [
        '[Reference][doc]',
        '',
        '![Preview][asset]',
        '',
        '[doc]: reference.md',
        '[asset]: reference.zh.md',
        '',
      ].join('\n')
      expect(translationStructureSignature(
        parseTranslationMarkdown(markdown),
        'guide.zh.md',
        {
          repoRoot: root, sourcePath: 'guide.md',
          isTranslationPairSource: fixturePairSource, markdown,
        },
      ).links).toEqual(['dsh-translation-target:reference.md'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('compares the first duplicate reference definition that CommonMark resolves', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-translation-structure-'))
    try {
      for (const name of ['reference', 'different', 'other']) {
        writeFileSync(join(root, `${name}.md`), `# ${name}\n`)
        writeFileSync(join(root, `${name}.zh.md`), `# ${name} zh\n`)
      }
      const sourceMarkdown = '[Reference][ref]\n\n[ref]: reference.md\n[ref]: other.md\n'
      const counterpartMarkdown = '[参考][ref]\n\n[ref]: different.zh.md\n[ref]: other.zh.md\n'
      const source = fixtureSignature(root, 'guide.md', sourceMarkdown, 'guide.zh.md')
      const counterpart = fixtureSignature(root, 'guide.zh.md', counterpartMarkdown, 'guide.md')
      expect(translationStructureDiff(source, counterpart)).toEqual([
        'link target #1 diverges between the pair: "dsh-translation-target:reference.md" vs "dsh-translation-target:different.md"',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts matching list kinds, starts, and item counts', () => {
    const source = signature('3. One\n4. Two\n\n- A\n- B\n')
    const counterpart = signature('3. 一\n4. 二\n\n- 甲\n- 乙\n')
    expect(translationStructureDiff(source, counterpart)).toEqual([])
  })

  it('rejects an altered ordered-list start', () => {
    const source = signature('3. One\n4. Two\n\n- A\n- B\n')
    const counterpart = signature('1. 一\n2. 二\n\n- 甲\n- 乙\n')
    expect(translationStructureDiff(source, counterpart)).toEqual([
      'list (kind, start, item count) #1 diverges between the pair: "ordered:start=3:items=2" vs "ordered:start=1:items=2"',
    ])
  })

  it('rejects a missing list item', () => {
    const source = signature('- A\n- B\n')
    const counterpart = signature('- 甲\n')
    expect(translationStructureDiff(source, counterpart)).toEqual([
      'list (kind, start, item count) #1 diverges between the pair: "bullet:items=2" vs "bullet:items=1"',
    ])
  })

  it('rejects altered table row or column counts', () => {
    const source = signature('| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n')
    const counterpart = signature('| 甲 | 乙 |\n|---|---|\n| 一 | 二 |\n')
    expect(translationStructureDiff(source, counterpart)).toEqual([
      'table (row x column count) #1 diverges between the pair: "3x2" vs "2x2"',
    ])
  })
})

describe('pair CLI arguments', () => {
  it('normalizes any pair file or bare stem to the English anchor', () => {
    expect(pairAnchorOfArgument('docs/foo.md')).toBe('docs/foo.md')
    expect(pairAnchorOfArgument('docs/foo.zh.md')).toBe('docs/foo.md')
    expect(pairAnchorOfArgument('docs/foo.i18n.yaml')).toBe('docs/foo.md')
    expect(pairAnchorOfArgument('docs/foo')).toBe('docs/foo.md')
    expect(pairAnchorOfArgument('.\\docs\\foo.zh.md')).toBe('docs/foo.md')
  })

  it('scopes a check to named pairs and dedupes the three spellings', () => {
    expect(parseTranslationPairingCliArgs(['docs/foo.zh.md', 'docs/foo.i18n.yaml', 'docs/bar.md'])).toEqual({
      input: 'worktree',
      mode: 'check',
      scope: 'pairs',
      anchors: ['docs/bar.md', 'docs/foo.md'],
    })
    expect(parseTranslationPairingCliArgs([])).toEqual({
      input: 'worktree',
      mode: 'check',
      scope: 'corpus',
      anchors: [],
    })
  })

  it('requires --write to name confirmed pairs or opt into --all', () => {
    expect(() => parseTranslationPairingCliArgs(['--write'])).toThrow('requires the pair(s) you confirmed')
    expect(parseTranslationPairingCliArgs(['--write', 'docs/foo.md'])).toEqual({
      input: 'worktree',
      mode: 'write',
      scope: 'pairs',
      anchors: ['docs/foo.md'],
    })
    expect(parseTranslationPairingCliArgs(['--write', '--all'])).toEqual({
      input: 'worktree',
      mode: 'write',
      scope: 'corpus',
      anchors: [],
    })
    expect(() => parseTranslationPairingCliArgs(['--write', '--all', 'docs/foo.md'])).toThrow('not both')
  })

  it('keeps --list corpus-only and rejects unknown flags', () => {
    expect(parseTranslationPairingCliArgs(['--list'])).toEqual({
      input: 'worktree',
      mode: 'list',
      scope: 'corpus',
      anchors: [],
    })
    expect(() => parseTranslationPairingCliArgs(['--list', 'docs/foo.md'])).toThrow('takes no other flags or paths')
    expect(() => parseTranslationPairingCliArgs(['--all'])).toThrow('--all only applies to --write')
    expect(() => parseTranslationPairingCliArgs(['--frobnicate'])).toThrow('unknown flag(s): --frobnicate')
  })

  it('makes cached verification a named, read-only index check', () => {
    expect(parseTranslationPairingCliArgs(['--cached', 'docs/foo.i18n.yaml'])).toEqual({
      input: 'index',
      mode: 'check',
      scope: 'pairs',
      anchors: ['docs/foo.md'],
    })
    expect(() => parseTranslationPairingCliArgs(['--cached'])).toThrow('requires the staged pair paths')
    expect(() => parseTranslationPairingCliArgs(['--cached', '--write', 'docs/foo.md'])).toThrow('read-only')
  })
})

describe('generated regions', () => {
  const BEGIN = '<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->'
  const END = '<!-- END GENERATED cordis-surface -->'

  it('locates marker-delimited regions with their slugs and marker lines', () => {
    const doc = `# T\n\nprose\n\n${BEGIN}\ninjected\n${END}\ntail\n`
    expect(generatedRegions(doc)).toEqual([
      { slug: 'cordis-surface', begin: 4, end: 6, text: `${BEGIN}\ninjected\n${END}` },
    ])
    expect(generatedRegions('# T\n\nprose\n')).toEqual([])
  })

  it('replaces exactly one region with the same slug', () => {
    const doc = `a\n${renderGeneratedRegion('x', 'old')}\n${renderGeneratedRegion('y', 'keep')}\nb\n`
    expect(spliceGeneratedRegion(doc, renderGeneratedRegion('x', 'new\nlines')))
      .toBe(`a\n${renderGeneratedRegion('x', 'new\nlines')}\n${renderGeneratedRegion('y', 'keep')}\nb\n`)
    expect(() => spliceGeneratedRegion('a\n', renderGeneratedRegion('x', 'new')))
      .toThrow("expected exactly 1 generated region 'x', found 0")
  })

  it('rejects unbalanced or nested markers', () => {
    expect(() => generatedRegions(`${END}\n`)).toThrow('without a BEGIN')
    expect(() => generatedRegions(`${BEGIN}\n`)).toThrow('without an END')
    expect(() => generatedRegions(`${BEGIN}\n${BEGIN}\n${END}\n`)).toThrow('nested')
  })

  it('rejects mismatched slugs and malformed marker lines', () => {
    expect(() => generatedRegions('<!-- BEGIN GENERATED a -->\nx\n<!-- END GENERATED b -->\n'))
      .toThrow("END slug 'b' does not match its BEGIN slug 'a'")
    expect(() => generatedRegions('<!-- BEGIN GENERATED a --> trailing\nx\n<!-- END GENERATED a -->\n'))
      .toThrow('malformed generated region marker line')
    expect(() => generatedRegions('x\n<!-- END GENERATED a --> tail\n'))
      .toThrow('malformed generated region marker line')
  })
})
