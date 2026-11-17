import { describe, expect, it } from 'vitest'
import {
  checkedProject, encodedPath, isSegment, mergeRequestPath, parseIssueUrl, parseMergeRequestUrl, parseRemoteUrl, repositoryOf,
} from '../src/urls.ts'
import { app, merge } from './fixtures.ts'

describe('GitLab remote URLs', () => {
  it.each([
    ['https://gitlab.com/group/app.git', { host: 'gitlab.com', owner: 'group', name: 'app' }],
    ['https://user@GitLab.Example.test:8443/group/sub/app/', { host: 'gitlab.example.test:8443', owner: 'group/sub', name: 'app' }],
    ['ssh://git@gitlab.example.test:8022/group/sub/app.git', { host: 'gitlab.example.test', owner: 'group/sub', name: 'app' }],
    ['git://gitlab.example.test/group/app', { host: 'gitlab.example.test', owner: 'group', name: 'app' }],
    ['git@gitlab.example.test:group/sub/app.git', { host: 'gitlab.example.test', owner: 'group/sub', name: 'app' }],
  ])('parses %s', (url, location) => {
    expect(parseRemoteUrl(url)).toEqual(location)
  })

  it.each([
    '/local/repo',
    'https://gitlab.com/app',
    'https://gitlab.com/group/../app',
    'git@gitlab.com:group/a b',
    'file:///srv/app.git',
  ])('refuses %s', (url) => {
    expect(parseRemoteUrl(url)).toBeUndefined()
  })
})

describe('GitLab page URLs', () => {
  it('parses merge request pages with nested groups and suffixes', () => {
    expect(parseMergeRequestUrl('https://GitLab.example.test/group/sub/app/-/merge_requests/12/diffs?view=inline#note_1'))
      .toEqual({ host: 'gitlab.example.test', owner: 'group/sub', name: 'app', number: 12 })
    expect(parseMergeRequestUrl('https://gitlab.com/group/app/-/merge_requests/3')).toEqual({ host: 'gitlab.com', owner: 'group', name: 'app', number: 3 })
  })

  it.each([
    'https://gitlab.com/group/app/merge_requests/3',
    'https://gitlab.com/app/-/merge_requests/3',
    'https://gitlab.com/group/app/-/merge_requests/0',
    'https://gitlab.com/group/app/-/merge_requests/99999999999999999999',
    'https://gitlab.com/group/app/-/issues/3',
  ])('refuses %s as a merge request', (url) => {
    expect(parseMergeRequestUrl(url)).toBeUndefined()
  })

  it('parses issue and work item pages', () => {
    expect(parseIssueUrl('https://gitlab.com/group/app/-/issues/7')).toEqual({ host: 'gitlab.com', owner: 'group', name: 'app', number: 7 })
    expect(parseIssueUrl('https://gitlab.com/group/sub/app/-/work_items/8#note')).toEqual({ host: 'gitlab.com', owner: 'group/sub', name: 'app', number: 8 })
    expect(parseIssueUrl('https://gitlab.com/app/-/issues/7')).toBeUndefined()
    expect(parseIssueUrl('https://gitlab.com/group/app/issues/7')).toBeUndefined()
  })
})

describe('GitLab request paths', () => {
  it('checks and encodes the project path', () => {
    expect(checkedProject(merge(4))).toBe('group/sub/app')
    expect(mergeRequestPath(merge(4))).toBe('projects/group%2Fsub%2Fapp/merge_requests/4')
    expect(repositoryOf({ host: 'gitlab.com', owner: 'group', name: 'app' })).toEqual({ forge: 'gitlab', host: 'gitlab.com', owner: 'group', name: 'app' })
  })

  it.each([
    [merge(1, { ...app, owner: 'group/..' }), 'forge-gitlab: invalid project "group/../app"'],
    [merge(1, { ...app, name: 'a b' }), 'forge-gitlab: invalid project "group/sub/a b"'],
    [merge(0), 'forge-gitlab: invalid merge request number 0'],
    [merge(1.5), 'forge-gitlab: invalid merge request number 1.5'],
  ])('refuses a reference that cannot be inlined', (ref, message) => {
    expect(() => checkedProject(ref)).toThrow(message)
  })

  it('encodes each path segment and checks segments', () => {
    expect(encodedPath('docs/a b/#1.md')).toBe('docs/a%20b/%231.md')
    expect(isSegment('app.v2')).toBe(true)
    expect(isSegment('.')).toBe(false)
    expect(isSegment('..')).toBe(false)
    expect(isSegment('a/b')).toBe(false)
  })
})
