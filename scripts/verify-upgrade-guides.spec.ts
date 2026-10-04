import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectUpgradeGuideViolations } from './verify-upgrade-guides.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const VALID = [
  '---',
  'kind: upgrade-guide',
  'description: "The `--preset` flag is removed."',
  '---',
  '',
  '# `--profile` replaces `--preset`',
  '',
  '## Change',
  '',
  'Old and new behavior.',
  '',
  '### Detail',
  '',
  '```md',
  '# not a heading',
  '```',
  '',
  '## Migration',
  '',
  '1. Rename the flag.',
  '',
].join('\n')

const VALID_ZH = VALID
  .replace('description: "The `--preset` flag is removed."', 'description: "移除 `--preset` 参数。"')
  .replace('## Change', '## 变更')
  .replace('## Migration', '## 迁移')

function fixtureRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-guides-'))
  roots.push(root)
  for (const [file, source] of Object.entries(files)) {
    const path = join(root, 'docs/upgrade-guide', file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, source)
  }
  return root
}

describe('upgrade guide gate', () => {
  it('accepts an absent tree and conforming guide pairs, including prerelease versions and CRLF files', () => {
    expect(collectUpgradeGuideViolations(fixtureRoot({}))).toEqual([])
    expect(collectUpgradeGuideViolations(fixtureRoot({
      'v0.1.7-rc.2/profile-flag/guide.md': VALID,
      'v0.1.7-rc.2/profile-flag/guide.zh.md': VALID_ZH,
      'v0.1.7-rc.2/profile-flag/guide.i18n.yaml': 'not parsed by this gate\n',
      'v1.0.0/crlf-item/guide.md': VALID.replaceAll('\n', '\r\n'),
    }))).toEqual([])
  })

  it('rejects files outside the version/item/guide pair layout', () => {
    expect(collectUpgradeGuideViolations(fixtureRoot({
      'README.md': VALID,
      '0.1.7/item/guide.md': VALID,
      'v0.1/item/guide.md': VALID,
      'v0.1.7/Item_Name/guide.md': VALID,
      'v0.1.7/item/notes.md': VALID,
      'v0.1.7/item/extra/guide.md': VALID,
    }))).toEqual([
      'docs/upgrade-guide/0.1.7/item/guide.md',
      'docs/upgrade-guide/README.md',
      'docs/upgrade-guide/v0.1.7/Item_Name/guide.md',
      'docs/upgrade-guide/v0.1.7/item/extra/guide.md',
      'docs/upgrade-guide/v0.1.7/item/notes.md',
      'docs/upgrade-guide/v0.1/item/guide.md',
    ].map(path => `${path}: only v<semver>/<kebab-case-item>/guide.{md,zh.md,i18n.yaml} files belong in docs/upgrade-guide`))
  })

  it('rejects missing, extra, or invalid frontmatter fields', () => {
    const body = VALID.slice(VALID.indexOf('# '))
    expect(collectUpgradeGuideViolations(fixtureRoot({
      'v0.1.7/none/guide.md': body,
      'v0.1.7/list/guide.md': `---\n- a\n---\n${body}`,
      'v0.1.7/fields/guide.md': `---\nkind: persistence-change\ndescription: ""\nversion: v0.1.7\n---\n${body}`,
    }))).toEqual([
      'docs/upgrade-guide/v0.1.7/fields/guide.md: frontmatter keys must be exactly description, kind; got description, kind, version',
      'docs/upgrade-guide/v0.1.7/fields/guide.md: kind must be upgrade-guide',
      'docs/upgrade-guide/v0.1.7/fields/guide.md: description must be a non-empty string',
      'docs/upgrade-guide/v0.1.7/list/guide.md: frontmatter must be a YAML object',
      'docs/upgrade-guide/v0.1.7/none/guide.md: must start with YAML frontmatter',
    ])
  })

  it('rejects a missing title and missing, renamed, extra, or reordered sections', () => {
    const cases = {
      'no-title': VALID.replace('# `--profile` replaces `--preset`\n', ''),
      'two-titles': VALID.replace('## Migration', '# Migration'),
      'renamed': VALID.replace('## Change', '## Changes'),
      'extra': `${VALID}\n## References\n`,
      'reordered': VALID.replace('## Change', '## Placeholder').replace('## Migration', '## Change').replace('## Placeholder', '## Migration'),
    }
    const violations = collectUpgradeGuideViolations(fixtureRoot(Object.fromEntries(
      Object.entries(cases).map(([item, source]) => [`v0.1.7/${item}/guide.md`, source]),
    )))
    expect(violations.map(violation => violation.split('/')[3])).toEqual(['extra', 'no-title', 'renamed', 'reordered', 'two-titles'])
    expect(violations[0]).toBe('docs/upgrade-guide/v0.1.7/extra/guide.md: headings must be one "#" title followed by "## Change", "## Migration"; got "# `--profile` replaces `--preset`", "## Change", "## Migration", "## References"')
  })

  it('checks the Chinese sibling against its own section names and metadata', () => {
    expect(collectUpgradeGuideViolations(fixtureRoot({
      'v0.1.7/english-headings/guide.zh.md': VALID,
      'v0.1.7/wrong-kind/guide.zh.md': VALID_ZH.replace('kind: upgrade-guide', 'kind: guide'),
    }))).toEqual([
      'docs/upgrade-guide/v0.1.7/english-headings/guide.zh.md: headings must be one "#" title followed by "## 变更", "## 迁移"; got "# `--profile` replaces `--preset`", "## Change", "## Migration"',
      'docs/upgrade-guide/v0.1.7/wrong-kind/guide.zh.md: kind must be upgrade-guide',
    ])
  })

  it('rejects an English guide over 500 words, counting frontmatter, and leaves the Chinese sibling uncounted', () => {
    const words = VALID.split(/\s+/u).filter(Boolean).length
    expect(collectUpgradeGuideViolations(fixtureRoot({
      'v0.1.7/at-limit/guide.md': `${VALID}${'word '.repeat(500 - words)}\n`,
      'v0.1.7/over-limit/guide.md': `${VALID}${'word '.repeat(501 - words)}\n`,
      'v0.1.7/over-limit/guide.zh.md': `${VALID_ZH}${'词 '.repeat(600)}\n`,
    }))).toEqual(['docs/upgrade-guide/v0.1.7/over-limit/guide.md: 501 words exceeds the 500-word ceiling'])
  })
})
