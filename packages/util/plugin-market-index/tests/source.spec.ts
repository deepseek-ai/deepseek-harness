import { expect, it } from 'vitest'
import { parseMarketIndex } from '../src/index.ts'
import { gitMarketIndexSource, isGitMarketIndexSourceAddress, parseGitMarketIndexSource } from '../src/source.ts'

it.each([
  ['https://raw.githubusercontent.com/team/plugins/main/index.json', false],
  ['https://cdn.example/plugins.json', false],
  ['https://github.com/team/plugins.json', true],
  ['https://git.example/team/plugins.git', true],
  ['ssh://git@git.example:2222/team/plugins.git', true],
  ['git@github.com:team/plugins.git', true],
  ['git+https://git.example/team/plugins', true],
  ['https://git.example/team/plugins', false],
  ['https://github.com/team/plugins/blob/main/index.json', false],
  ['file:///tmp/index.json', false],
  ['not an address', false],
])('identifies whether %s is a Git repository address', (address, git) => {
  expect(isGitMarketIndexSourceAddress(address)).toBe(git)
})

it('canonicalizes Git source options and keeps them out of the clone URL', () => {
  const source = gitMarketIndexSource('git@github.com:team/plugins', 'market/index.json', 'release/stable')
  expect(parseGitMarketIndexSource(source)).toEqual({
    url: 'git+ssh://git@github.com/team/plugins.git?path=market%2Findex.json&ref=release%2Fstable',
    repository: 'ssh://git@github.com/team/plugins.git', path: 'market/index.json', ref: 'release/stable',
  })
  expect(gitMarketIndexSource('https://github.com/team/plugins/', 'index.json')).toBe('git+https://github.com/team/plugins.git')
  expect(parseGitMarketIndexSource(gitMarketIndexSource('https://github.com/team/plugins', undefined, '发布@staging')).ref).toBe('发布@staging')
  expect(parseGitMarketIndexSource(gitMarketIndexSource('https://github.com/team/plugins', undefined, 'A'.repeat(40))).ref).toBe('a'.repeat(40))
})

it.each([
  'git+http://git.example/team/plugins',
  'git+https://user:token@git.example/team/plugins',
  'git+ssh://git:token@git.example/team/plugins',
  'git+https://github.com/team/plugins/blob/main/index.json',
  'git+https://git.example/team/plugins?token=secret',
  'git+https://git.example/team/plugins?path=..%2Findex.json',
  'git+https://git.example/team/plugins?ref=main%3Arefs%2Fheads%2Fother',
  'git+https://git.example/team/plugins?ref=main&ref=other',
  'git+https://git.example/team/plugins?ref=-main',
  'git+https://git.example/',
])('rejects unsupported Git index address %s', (address) => {
  expect(() => parseGitMarketIndexSource(address)).toThrow()
})

it('accepts a Git index icon with an absolute HTTPS address and rejects repository-relative icons', () => {
  const url = gitMarketIndexSource('https://github.com/team/plugins')
  const plugin = { name: 'plugin', versions: [{ version: '1.0.0', publishTimestamp: 1, source: { type: 'npm' } }] }
  const index = (icon: string) => ({ format: 1, title: 'Catalog', plugins: [{ ...plugin, icon }] })
  expect(parseMarketIndex(index('https://cdn.example/icon.svg'), url).plugins[0]?.icon).toBe('https://cdn.example/icon.svg')
  expect(() => parseMarketIndex(index('icon.svg'), url)).toThrow('Git indexes require an absolute HTTPS or inline icon URL')
})
