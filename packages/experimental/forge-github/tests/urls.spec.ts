import { describe, expect, it } from 'vitest'
import { isSegment, parsePullRequestUrl, parseRemoteUrl } from '../src/urls.ts'

const demo = { host: 'github.com', owner: 'octo', name: 'demo' }

describe('remote URLs', () => {
  it.each([
    ['https://github.com/octo/demo.git', demo],
    ['https://user:secret@GitHub.com/octo/demo', demo],
    ['http://github.com/octo/demo/', demo],
    ['ssh://git@github.com:22/octo/demo.git', demo],
    ['https://ghe.example.com:8443/team/repo.git', { host: 'ghe.example.com:8443', owner: 'team', name: 'repo' }],
    ['http://ghe.example.com:8080/team/repo', { host: 'ghe.example.com:8080', owner: 'team', name: 'repo' }],
    ['SSH://git@ghe.example.com:7999/team/repo.git', { host: 'ghe.example.com', owner: 'team', name: 'repo' }],
    ['git://github.com/octo/demo', demo],
    ['git@github.com:octo/demo.git', demo],
    ['github.com:octo/demo.git', demo],
    ['  git@ghe.corp.example:team/svc.GIT  ', { host: 'ghe.corp.example', owner: 'team', name: 'svc' }],
    ['https://github.com/octo/my.repo-name_1.git', { host: 'github.com', owner: 'octo', name: 'my.repo-name_1' }],
  ])('parses %s', (url, expected) => {
    expect(parseRemoteUrl(url)).toEqual(expected)
  })

  it.each([
    'https://github.com/octo',
    'https://github.com/octo/demo/extra',
    '/local/path/repo.git',
    'file:///tmp/repo.git',
    'C:/repo',
    'git@github.com:octo/../demo',
    'git@github.com:../demo',
    'https://github.com/oc to/demo',
    'not a url',
  ])('rejects %s', (url) => {
    expect(parseRemoteUrl(url)).toBeUndefined()
  })

  it('rejects dot segments as owner or name', () => {
    expect(isSegment('.')).toBe(false)
    expect(isSegment('..')).toBe(false)
    expect(isSegment('demo.js')).toBe(true)
  })
})

describe('pull request URLs', () => {
  it('uses the same host identity as an HTTP remote with a custom port', () => {
    const remote = parseRemoteUrl('https://ghe.example.com:8443/team/repo.git')
    expect(parsePullRequestUrl('https://ghe.example.com:8443/team/repo/pull/1')).toEqual({ ...remote, number: 1 })
  })
  it.each([
    ['https://github.com/octo/demo/pull/12', { ...demo, number: 12 }],
    ['https://GITHUB.com/octo/demo/pull/12/files?diff=split#top', { ...demo, number: 12 }],
    ['http://ghe.corp.example/team/svc/pull/3', { host: 'ghe.corp.example', owner: 'team', name: 'svc', number: 3 }],
  ])('parses %s', (url, expected) => {
    expect(parsePullRequestUrl(url)).toEqual(expected)
  })

  it.each([
    'https://github.com/octo/demo/issues/12',
    'https://github.com/octo/demo/pull/0',
    'https://github.com/octo/demo/pull/99999999999999999999',
    'https://github.com/o o/demo/pull/1',
    'https://github.com/octo/demo/pulls/1',
  ])('rejects %s', (url) => {
    expect(parsePullRequestUrl(url)).toBeUndefined()
  })
})
