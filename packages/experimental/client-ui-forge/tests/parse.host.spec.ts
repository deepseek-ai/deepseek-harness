import { describe, expect, it } from 'vitest'
import {
  parseBaseBranches, parseName, parseRemotes, parseTopLevel, parseWorktreeBases, parseWorktrees, remoteOrder, remoteRepository,
  upstreamBranch,
} from '../src/parse.ts'
import type { GitRemote } from '../src/parse.ts'

describe('parseTopLevel', () => {
  it('reads the first line', () => {
    expect(parseTopLevel('/work/repo\n')).toBe('/work/repo')
    expect(parseTopLevel('C:/work/repo\r\n')).toBe('C:/work/repo')
    expect(parseTopLevel('/work/repo/.git\nignored\n')).toBe('/work/repo/.git')
  })

  it('rejects empty output', () => {
    expect(() => parseTopLevel('')).toThrow('git rev-parse printed no directory')
    expect(() => parseTopLevel('\n')).toThrow('git rev-parse printed no directory')
  })
})

describe('parseName', () => {
  it('reads the first line', () => {
    expect(parseName('main\n')).toBe('main')
    expect(parseName('origin/feat/x\r\nignored\n')).toBe('origin/feat/x')
  })

  it('reads no name from empty output', () => {
    expect(parseName('')).toBeNull()
    expect(parseName('\n')).toBeNull()
  })
})

describe('parseWorktreeBases', () => {
  const remotes: GitRemote[] = [
    { name: 'upstream', urls: ['https://github.com/acme/demo.git'] },
    { name: 'origin', urls: ['git@github.com:me/demo.git'] },
    { name: 'team/fork', urls: ['/srv/team.git'] },
    { name: 'empty', urls: [] },
  ]
  const output = [
    'refs/remotes/upstream/HEAD\0refs/remotes/upstream/master',
    'refs/remotes/origin/HEAD\0refs/remotes/origin/main',
    'refs/remotes/team/fork/HEAD\0refs/remotes/team/fork/gone',
    'refs/remotes/empty/HEAD\0refs/heads/main',
    'refs/remotes/origin/alias\0refs/remotes/origin/main',
    'refs/heads/alias\0refs/heads/main',
    'refs/heads/topic\0',
    'refs/remotes/upstream/master\0',
    'refs/remotes/origin/main\0',
    'refs/remotes/team/fork/feature\0',
    'refs/remotes/upstream/release/2.4\0',
    'refs/remotes/upstream/dev\0',
    'refs/heads/main\0',
    'refs/remotes/stray/main\0',
    'refs/heads/Fix/Login\0',
    'refs/tags/v1\0',
    '',
  ].join('\r\n')
  const repositories = (remote: GitRemote): string | null => remote.urls[0] ?? null

  it('pins the checked-out branch and each remote default, then groups local branches and each remote in remote order', () => {
    expect(parseWorktreeBases(output, 'main', remotes, '', 10, repositories)).toEqual({
      current: { ref: 'refs/heads/main', name: 'main' },
      defaults: [
        { ref: 'refs/remotes/upstream/master', name: 'upstream/master', remote: 'upstream' },
        { ref: 'refs/remotes/origin/main', name: 'origin/main', remote: 'origin' },
      ],
      local: [{ ref: 'refs/heads/topic', name: 'topic' }, { ref: 'refs/heads/Fix/Login', name: 'Fix/Login' }],
      remotes: [
        {
          name: 'upstream',
          repository: 'https://github.com/acme/demo.git',
          branches: [{ ref: 'refs/remotes/upstream/release/2.4', name: 'upstream/release/2.4' }, { ref: 'refs/remotes/upstream/dev', name: 'upstream/dev' }],
        },
        { name: 'team/fork', repository: '/srv/team.git', branches: [{ ref: 'refs/remotes/team/fork/feature', name: 'team/fork/feature' }] },
      ],
    })
  })

  it('keeps the branches whose names contain the query, ignoring case, at most `limit` in each group', () => {
    expect(parseWorktreeBases(output, 'main', remotes, ' FIX ', 10, repositories)).toEqual({ current: null, defaults: [], local: [{ ref: 'refs/heads/Fix/Login', name: 'Fix/Login' }], remotes: [] })
    const limited = parseWorktreeBases(output, null, remotes, '', 1, repositories)
    expect(limited.current).toBeNull()
    expect(limited.local).toEqual([{ ref: 'refs/heads/topic', name: 'topic' }])
    expect(limited.remotes.map(remote => remote.branches.length)).toEqual([1, 1])
  })

  it('names no current branch on a detached HEAD or an unborn branch', () => {
    expect(parseWorktreeBases(output, null, remotes, '', 10, repositories).current).toBeNull()
    expect(parseWorktreeBases('', 'main', [], '', 10, repositories)).toEqual({ current: null, defaults: [], local: [], remotes: [] })
  })
})

describe('remoteRepository', () => {
  const recognize = (url: string) => url.startsWith('https://host.test/') ? { owner: 'acme', name: 'demo' } : undefined

  it('names the first recognized repository, else the first URL, else nothing', () => {
    expect(remoteRepository({ name: 'origin', urls: ['/srv/demo.git', 'https://host.test/acme/demo.git'] }, recognize)).toBe('acme/demo')
    expect(remoteRepository({ name: 'fork', urls: ['/srv/fork.git'] }, recognize)).toBe('/srv/fork.git')
    expect(remoteRepository({ name: 'empty', urls: [] }, recognize)).toBeNull()
  })

  it.each([
    ['a user name and token', 'https://oauth2:glpat-secret@gitlab.internal.test/group/repo.git', 'https://gitlab.internal.test/group/repo.git'],
    ['a token as the user name', 'https://ghp_secret@git.internal.test/acme/demo.git', 'https://git.internal.test/acme/demo.git'],
    ['an `@` in the password', 'https://user:p@ss@git.internal.test:8443/repo', 'https://git.internal.test:8443/repo'],
    ['an SSH user', 'ssh://git@git.internal.test:2222/acme/demo.git', 'ssh://git.internal.test:2222/acme/demo.git'],
    ['an `@` only in the path', 'https://git.internal.test/users/@me/repo.git', 'https://git.internal.test/users/@me/repo.git'],
    ['the scp-like form, which has no password', 'git@git.internal.test:acme/demo.git', 'git@git.internal.test:acme/demo.git'],
  ])('shows an unrecognized URL with %s without its user information', (_label, url, shown) => {
    expect(remoteRepository({ name: 'selfhost', urls: [url] }, recognize)).toBe(shown)
  })
})

describe('parseBaseBranches', () => {
  const output = [
    'refs/remotes/origin/HEAD\0refs/remotes/origin/main',
    'refs/remotes/origin/main\0',
    'refs/heads/feat\0',
    'refs/heads/Release/2.4\0',
    'refs/remotes/upstream/release/2.3\0',
    'refs/heads/main\0',
    'refs/tags/v1\0',
    '',
  ].join('\r\n')

  it('keeps the listed order, leaving out symbolic refs, the hidden branches, and other ref kinds', () => {
    expect(parseBaseBranches(output, ['refs/heads/feat'], '', 10)).toEqual({
      remote: [
        { ref: 'refs/remotes/origin/main', name: 'origin/main' },
        { ref: 'refs/remotes/upstream/release/2.3', name: 'upstream/release/2.3' },
      ],
      local: [
        { ref: 'refs/heads/Release/2.4', name: 'Release/2.4' },
        { ref: 'refs/heads/main', name: 'main' },
      ],
    })
    // The shown branch and the branch the automatic base stands for are both left out.
    expect(parseBaseBranches(output, ['refs/heads/feat', 'refs/heads/main'], '', 10).local)
      .toEqual([{ ref: 'refs/heads/Release/2.4', name: 'Release/2.4' }])
  })

  it('leaves out a shown remote-tracking branch and keeps a local branch of the same short name', () => {
    const listed = parseBaseBranches('refs/remotes/origin/main\0\nrefs/heads/origin/main\0\n', ['refs/remotes/origin/main'], '', 10)
    expect(listed).toEqual({ remote: [], local: [{ ref: 'refs/heads/origin/main', name: 'origin/main' }] })
  })

  it('keeps names containing the trimmed query in any case, at most limit in each group', () => {
    expect(parseBaseBranches(output, [], '  RELEASE ', 1)).toEqual({
      remote: [{ ref: 'refs/remotes/upstream/release/2.3', name: 'upstream/release/2.3' }],
      local: [{ ref: 'refs/heads/Release/2.4', name: 'Release/2.4' }],
    })
    expect(parseBaseBranches(output, [], '', 1).local).toEqual([{ ref: 'refs/heads/feat', name: 'feat' }])
    expect(parseBaseBranches('refs/heads/\0\n', [], '', 10)).toEqual({ remote: [], local: [] })
  })
})

describe('parseWorktrees', () => {
  /** One `git worktree list --porcelain` entry: its lines, then an empty line. */
  const listed = (...fields: string[]): string => `${fields.join('\n')}\n\n`

  it('maps each checked-out branch to its worktree, leaving out detached, bare, and prunable entries', () => {
    const output = [
      listed('worktree /work/repo', `HEAD ${'a'.repeat(40)}`, 'branch refs/heads/main'),
      listed('worktree /work/with space', `HEAD ${'b'.repeat(40)}`, 'branch refs/heads/feat/cache', 'locked reason'),
      listed('worktree /work/detached', `HEAD ${'c'.repeat(40)}`, 'detached'),
      listed('worktree /work/bare.git', 'bare'),
      listed('worktree /work/gone', `HEAD ${'d'.repeat(40)}`, 'branch refs/heads/gone', 'prunable gitdir file points to non-existent location'),
      listed('worktree /work/pruned', `HEAD ${'e'.repeat(40)}`, 'branch refs/heads/pruned', 'prunable'),
    ].join('')
    expect([...parseWorktrees(output)]).toEqual([['refs/heads/main', '/work/repo'], ['refs/heads/feat/cache', '/work/with space']])
    expect(parseWorktrees('').size).toBe(0)
    // A line break in a directory's name ends the path the listing gives.
    expect([...parseWorktrees(listed('worktree /work/a\nb', `HEAD ${'f'.repeat(40)}`, 'branch refs/heads/odd'))]).toEqual([['refs/heads/odd', '/work/a']])
  })
})

describe('parseRemotes', () => {
  it('groups fetch and push URLs per remote in listed order', () => {
    const output = [
      'origin\tgit@github.com:octo/demo.git (push)',
      'origin\thttps://github.com/octo/demo.git (fetch)',
      'upstream\thttps://github.com/upstream/demo.git (fetch)',
      'upstream\thttps://github.com/upstream/demo.git (push)',
      'mirror\thttps://mirror.example/demo.git (push)',
      'not a remote line',
      '',
    ].join('\r\n')

    expect(parseRemotes(output)).toEqual([
      { name: 'origin', urls: ['https://github.com/octo/demo.git', 'git@github.com:octo/demo.git'] },
      { name: 'upstream', urls: ['https://github.com/upstream/demo.git'] },
      { name: 'mirror', urls: ['https://mirror.example/demo.git'] },
    ])
  })
})

describe('upstreamBranch', () => {
  const remote = (name: string): GitRemote => ({ name, urls: [`https://example.test/${name}.git`] })

  it('splits the upstream at the longest remote name it starts with', () => {
    const remotes = [remote('origin'), remote('team'), remote('team/mirror')]

    expect(upstreamBranch('team/mirror/feat/x', remotes)).toEqual({ remote: remote('team/mirror'), branch: 'feat/x' })
    expect(upstreamBranch('origin/main', remotes)).toEqual({ remote: remote('origin'), branch: 'main' })
  })

  it('names no branch without an upstream or a remote it starts with', () => {
    expect(upstreamBranch(null, [remote('origin')])).toBeUndefined()
    expect(upstreamBranch('elsewhere/main', [remote('origin')])).toBeUndefined()
  })
})

describe('remoteOrder', () => {
  const remote = (name: string): GitRemote => ({ name, urls: [`https://example.test/${name}.git`] })

  it('puts the upstream remote first, preferring the longest matching name, then origin', () => {
    const remotes = [remote('fork'), remote('origin'), remote('team'), remote('team/mirror')]

    expect(remoteOrder('team/mirror/main', remotes).map(entry => entry.name)).toEqual(['team/mirror', 'origin', 'fork', 'team'])
    expect(remoteOrder('team/main', remotes).map(entry => entry.name)).toEqual(['team', 'origin', 'fork', 'team/mirror'])
    expect(remoteOrder('team/mirror/main', [remote('team/mirror'), remote('team')]).map(entry => entry.name)).toEqual(['team/mirror', 'team'])
  })

  it('falls back to origin without an upstream or a matching remote', () => {
    const remotes = [remote('fork'), remote('origin')]

    expect(remoteOrder(null, remotes).map(entry => entry.name)).toEqual(['origin', 'fork'])
    expect(remoteOrder('elsewhere/main', remotes).map(entry => entry.name)).toEqual(['origin', 'fork'])
  })
})
