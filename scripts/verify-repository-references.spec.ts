import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, type TestContext } from 'vitest'
import { findRepositoryReferences, scanRepositoryReferences } from './verify-repository-references.ts'

const organizationUrl = `https://${['github.com', ['deepseek', 'harness'].join('-')].join('/')}`

function repository(test: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-repository-references-'))
  test.onTestFinished(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })
  function git(args: string[], input?: string): string {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: join(root, 'global.gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Repository reference test',
        GIT_AUTHOR_EMAIL: 'repository-reference@example.invalid',
        GIT_COMMITTER_NAME: 'Repository reference test',
        GIT_COMMITTER_EMAIL: 'repository-reference@example.invalid',
      },
      ...(input === undefined ? {} : { input }),
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  }
  function write(file: string, source: string): void {
    const path = join(root, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, source)
  }
  git(['init', '--quiet'])
  write('tracked.md', 'release tags\n')
  git(['add', 'tracked.md'])
  const tree = git(['write-tree'])
  const commit = git(['commit-tree', tree, '-m', 'fixture'])
  git(['update-ref', 'HEAD', commit])
  return { root, git, write, commit, tree }
}

describe('maintained repository reference policy', () => {
  it('permits only the independent kit repository and its source URLs', () => {
    for (const suffix of ['', '.git', '/tree/main/packages/entry']) {
      expect(findRepositoryReferences('package.json', `${organizationUrl}/libreoffice-kit${suffix}`, new Set())).toEqual([])
    }
    for (const suffix of ['-other', '.example', 's']) {
      expect(findRepositoryReferences('package.json', `${organizationUrl}/libreoffice-kit${suffix}`, new Set())).toHaveLength(1)
    }
  })

  it('rejects complete and abbreviated commit identifiers in tracked, staged, and new files', (test) => {
    const fixture = repository(test)
    fixture.write('tracked.md', `release\n${fixture.commit}\n${fixture.commit.toUpperCase()}\n`)
    fixture.write('staged.md', fixture.commit.slice(0, 7))
    fixture.git(['add', 'staged.md'])
    fixture.write('new.md', `\0${fixture.commit.slice(0, 12)}`)

    expect(scanRepositoryReferences(fixture.root)).toEqual(expect.arrayContaining([
      { file: 'tracked.md', line: 2, kind: 'commit-hash' },
      { file: 'tracked.md', line: 3, kind: 'commit-hash' },
      { file: 'staged.md', line: 1, kind: 'commit-hash' },
      { file: 'new.md', line: 1, kind: 'commit-hash' },
    ]))
    expect(scanRepositoryReferences(fixture.root)).toHaveLength(4)
  })

  it('checks available unreachable commits without requiring a branch or network', (test) => {
    const fixture = repository(test)
    const unreachable = fixture.git(['commit-tree', fixture.tree, '-m', 'unreachable fixture'])
    fixture.write('unreachable.md', unreachable)
    expect(scanRepositoryReferences(fixture.root)).toEqual([
      { file: 'unreachable.md', line: 1, kind: 'commit-hash' },
    ])
  })

  it('does not fetch missing commits from a partial clone\'s promisor remote', (test) => {
    const remote = repository(test)
    remote.git(['config', 'uploadpack.allowFilter', 'true'])
    const clone = join(remote.root, 'partial-clone')
    remote.git(['clone', '--filter=blob:none', '--no-local', remote.root, clone])
    const missing = remote.git(['commit-tree', remote.tree, '-p', remote.commit, '-m', 'remote-only fixture'])
    remote.git(['update-ref', 'HEAD', missing])
    remote.write('partial-clone/new.md', missing)

    expect(scanRepositoryReferences(clone)).toEqual([])
    expect(execFileSync('git', ['cat-file', '--batch-check'], {
      cwd: clone,
      encoding: 'utf8',
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
      input: `${missing}\n`,
    }).trim()).toBe(`${missing} missing`)
  })

  it('accepts blobs, trees, unknown hex, long digests, and identifiers embedded in alphanumeric words', (test) => {
    const fixture = repository(test)
    const blob = fixture.git(['hash-object', '-w', '--stdin'], 'blob fixture')
    fixture.write('accepted.md', [
      blob,
      fixture.tree,
      '0'.repeat(40),
      `${fixture.commit}${'0'.repeat(24)}`,
      fixture.commit.slice(0, 6),
      `prefix${fixture.commit}`,
      `${fixture.commit}suffix`,
      'dsh-v0.0.1-rc.1',
    ].join('\n'))
    expect(scanRepositoryReferences(fixture.root)).toEqual([])
  })

  it('accepts hexadecimal branch names that do not match the referenced commit identifier', (test) => {
    const fixture = repository(test)
    const branch = 'b'.repeat(12)
    fixture.git(['update-ref', `refs/heads/${branch}`, fixture.commit])
    fixture.write('branch.md', branch)
    expect(scanRepositoryReferences(fixture.root)).toEqual([])
  })

  it('excludes only ignored new files, vendored sources, frozen notes, and deleted files', (test) => {
    const fixture = repository(test)
    fixture.write('.gitignore', 'ignored.md\ntracked-ignore.md\n')
    fixture.write('ignored.md', fixture.commit)
    fixture.write('vendor/project/file.md', `${fixture.commit}\n${organizationUrl}`)
    fixture.write('.agents/notes/archived/process/frozen.md', `${fixture.commit}\n${organizationUrl}`)
    fixture.write('tracked-ignore.md', fixture.commit)
    fixture.git(['add', '--force', 'tracked-ignore.md'])
    unlinkSync(join(fixture.root, 'tracked.md'))

    expect(scanRepositoryReferences(fixture.root)).toEqual([
      { file: 'tracked-ignore.md', line: 1, kind: 'commit-hash' },
    ])
  })

  it.skipIf(process.platform === 'win32')('inspects dangling symlink targets without following files outside the tree', (test) => {
    const fixture = repository(test)
    symlinkSync(`../${fixture.commit}`, join(fixture.root, 'reference-link'))
    symlinkSync('../outside', join(fixture.root, 'ordinary-link'))
    expect(scanRepositoryReferences(fixture.root)).toEqual([
      { file: 'reference-link', line: 1, kind: 'commit-hash' },
    ])
  })

  it('rejects literal, encoded, escaped, case-varied, and compatibility forms of the organization URL', () => {
    const fullwidth = organizationUrl.split('').map(character =>
      String.fromCodePoint(character.charCodeAt(0) + 0xfee0)).join('')
    const source = [
      organizationUrl,
      `${organizationUrl.toUpperCase()}/project`,
      organizationUrl.replaceAll('/', '\\/'),
      organizationUrl.replaceAll('/', String.raw`\u002f`),
      organizationUrl.replaceAll('/', String.raw`\x2f`),
      organizationUrl.replaceAll('/', '%2F').replace('github', '%67ithub'),
      organizationUrl.replaceAll('/', '&#47;'),
      organizationUrl.replaceAll('/', '&#x2f;'),
      organizationUrl.replaceAll('/', '&sol;').replaceAll('-', '&hyphen;'),
      fullwidth,
      `${organizationUrl}?tab=repositories`,
    ].join('\n')
    expect(findRepositoryReferences('source.md', source, new Set())).toEqual(
      source.split('\n').map((_line, index) => ({ file: 'source.md', line: index + 1, kind: 'organization-url' })),
    )
  })

  it('accepts distinct organization names and excludes the frozen and vendored paths', () => {
    expect(findRepositoryReferences('source.md', `${organizationUrl}-tools/project`, new Set())).toEqual([])
    expect(findRepositoryReferences('vendor/project/source.md', organizationUrl, new Set())).toEqual([])
    expect(findRepositoryReferences('.agents/notes/archived/process/frozen.md', organizationUrl, new Set())).toEqual([])
    expect(findRepositoryReferences('.agents/notes/implemented/process/current.md', organizationUrl, new Set()))
      .toEqual([{ file: '.agents/notes/implemented/process/current.md', line: 1, kind: 'organization-url' }])
  })
})
