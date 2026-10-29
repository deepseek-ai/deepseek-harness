import { describe, expect, it } from 'vitest'
import { baseBranches, parseName, parseRemotes, parseTopLevel, remoteOrder, upstreamBranch } from '../src/parse.ts'
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

describe('baseBranches', () => {
  it('puts the checked-out branch first without repeating it', () => {
    expect(baseBranches('feat', 'main\nfeat\nfix\n', 10)).toEqual(['feat', 'main', 'fix'])
  })

  it('keeps the checked-out branch when the listing omits it', () => {
    expect(baseBranches('old', 'main\nfeat\n', 2)).toEqual(['old', 'main'])
    expect(baseBranches('main', '', 50)).toEqual(['main'])
  })

  it('lists the branches of a detached HEAD in listed order', () => {
    expect(baseBranches(null, 'main\r\nfeat\r\n', 10)).toEqual(['main', 'feat'])
    expect(baseBranches(null, '', 10)).toEqual([])
  })

  it('returns at most `limit` names and skips empty lines', () => {
    expect(baseBranches('main', '\nmain\n\nfeat\nfix\n', 2)).toEqual(['main', 'feat'])
    expect(baseBranches(null, 'main\nfeat\nfix\n', 1)).toEqual(['main'])
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
