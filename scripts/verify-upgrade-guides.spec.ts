import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectStaleUpgradeGuideAdditions, collectUpgradeGuideViolations } from './verify-upgrade-guides.ts'

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

function writeGuides(root: string, files: Record<string, string>): void {
  for (const [file, source] of Object.entries(files)) {
    const path = join(root, 'docs/upgrade-guide', file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, source)
  }
}

function fixtureRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upgrade-guides-'))
  roots.push(root)
  writeGuides(root, files)
  return root
}

/** Run Git with an identity and no user or system configuration, so the fixture ignores the host's settings. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=master', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
}

/** Commit `files` with the root version `version` on top of the current branch. */
function commit(root: string, version: string, files: Record<string, string>): void {
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ version })}\n`)
  writeGuides(root, files)
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', version)
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

  describe('added guide versions', () => {
    const MESSAGE = ': added outside the current version directory; the root version is 0.2.2-rc.1, so move the guide to docs/upgrade-guide/v0.2.2-rc.1/<item>/'

    beforeEach(() => {
      vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null')
      vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    })
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    /** An `origin` whose master holds released guides and whose `release/dsh-0.2.1` branch adds a backported one. */
    function originRoot(): string {
      const origin = fixtureRoot({})
      git(origin, 'init', '-q')
      commit(origin, '0.2.2-alpha.3', { 'v0.2.2-alpha.3/frozen/guide.md': VALID, 'v0.2.2-alpha.3/moving/guide.md': VALID })
      git(origin, 'checkout', '-q', '-b', 'release/dsh-0.2.1')
      commit(origin, '0.2.1-rc.4', { 'v0.2.1-rc.4/backport/guide.md': VALID })
      git(origin, 'checkout', '-q', 'master')
      return origin
    }

    /** A clone of `origin`'s master whose index bumps the root version to 0.2.2-rc.1 and stages `files`. */
    function bumpedClone(origin: string, files: Record<string, string>, ...cloneArgs: string[]): string {
      const root = fixtureRoot({})
      git(root, 'clone', '-q', '--single-branch', ...cloneArgs, origin, '.')
      writeFileSync(join(root, 'package.json'), `${JSON.stringify({ version: '0.2.2-rc.1' })}\n`)
      writeGuides(root, files)
      git(root, 'add', '-A')
      return root
    }

    it('accepts guides added in the current directory, edits of released guides, and moves out of a released directory', () => {
      const root = bumpedClone(originRoot(), { 'v0.2.2-rc.1/current/guide.md': VALID, 'v0.2.2-alpha.3/frozen/guide.md': `${VALID}edited\n` })
      git(root, 'mv', 'docs/upgrade-guide/v0.2.2-alpha.3/moving', 'docs/upgrade-guide/v0.2.2-rc.1/moving')
      expect(collectStaleUpgradeGuideAdditions(root, 'HEAD')).toEqual([])
    })

    it('rejects guides added in a released directory unless the release branch of their line has them', () => {
      const root = bumpedClone(originRoot(), {
        'v0.2.2-alpha.3/stale/guide.md': VALID,
        'v0.2.1-rc.4/backport/guide.md': VALID,
        'v0.2.1-rc.4/backport/guide.zh.md': VALID_ZH,
        'v0.2.0-rc.2/no-branch/guide.md': VALID,
        'README.md': VALID,
      })
      expect(collectStaleUpgradeGuideAdditions(root, 'HEAD')).toEqual([
        'docs/upgrade-guide/v0.2.0-rc.2/no-branch/guide.md',
        'docs/upgrade-guide/v0.2.1-rc.4/backport/guide.zh.md',
        'docs/upgrade-guide/v0.2.2-alpha.3/stale/guide.md',
      ].map(path => `${path}${MESSAGE}`))
      expect(git(root, 'for-each-ref', 'refs/remotes/origin/release')).toBe('')
    })

    it('reads a release branch tip in a shallow clone, fetching it only when absent, without cutting the history it already has', () => {
      const origin = originRoot()
      git(origin, 'merge', '-q', '--no-edit', 'release/dsh-0.2.1')
      commit(origin, '0.2.2-alpha.3', { 'v0.2.2-alpha.3/later/guide.md': VALID })
      const root = bumpedClone(`file://${origin}`, { 'v0.2.1-rc.4/backport-again/guide.md': VALID }, '--depth=3')
      const history = git(root, 'rev-list', 'HEAD')
      expect(git(root, 'rev-parse', '--is-shallow-repository').trim()).toBe('true')
      expect(collectStaleUpgradeGuideAdditions(root, 'HEAD')).toEqual([`docs/upgrade-guide/v0.2.1-rc.4/backport-again/guide.md${MESSAGE}`])
      expect(git(root, 'rev-list', 'HEAD')).toBe(history)

      git(origin, 'checkout', '-q', 'release/dsh-0.2.1')
      commit(origin, '0.2.1-rc.5', { 'v0.2.1-rc.4/backport-again/guide.md': VALID })
      expect(collectStaleUpgradeGuideAdditions(root, 'HEAD')).toEqual([])
      expect(git(root, 'rev-list', 'HEAD')).toBe(history)
    })

    it('names the failing Git command for an unknown base', () => {
      const root = bumpedClone(originRoot(), {})
      expect(() => collectStaleUpgradeGuideAdditions(root, 'no-such-ref')).toThrow(/`git diff .* no-such-ref -- docs\/upgrade-guide` failed: /u)
    })
  })
})
