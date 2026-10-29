import { describe, expect, it } from 'vitest'
import { changeRequestUrls, commandEvidence, commandOf, ownChangeRequestUrls, pushedBranches, sameChangeRequestUrl } from '../src/commands.ts'

describe('commandOf', () => {
  it('reads the string command argument', () => {
    expect(commandOf('{"command":"git push","description":"push"}')).toBe('git push')
  })

  it.each([
    ['malformed JSON', '{"command":'],
    ['a JSON string', '"git push"'],
    ['JSON null', 'null'],
    ['a missing command', '{"cmd":"git push"}'],
    ['a non-string command', '{"command":["git","push"]}'],
  ])('returns undefined for %s', (_label, raw) => {
    expect(commandOf(raw)).toBeUndefined()
  })
})

describe('commandEvidence', () => {
  const url = 'https://github.com/octo/demo/pull/12'
  const created = { urls: 'created', pushes: false, named: [] }
  const pushed = { urls: null, pushes: true, named: [] }

  it.each([
    ['gh pr create --fill', created],
    ['gh pr new -t title -b body', created],
    ['git push', pushed],
    ['git push -u origin HEAD', pushed],
    ['git -C ../checkout push origin feat', pushed],
    ['git -c credential.helper= push', pushed],
    ['git --no-pager push --force-with-lease', pushed],
    ['cd repo && git push && gh pr create --fill', { ...created, pushes: true }],
    ['gh pr view 12 --json url', { urls: 'referenced', pushes: false, named: [] }],
    ['gh pr view 12 --repo octo/demo --json number', { urls: 'referenced', pushes: false, named: [] }],
    [`gh pr view '${url}' --json title`, { urls: 'referenced', pushes: false, named: [url] }],
    [`gh pr edit ${url}/files --add-label bug`, { urls: 'referenced', pushes: false, named: [url] }],
    [`gh pr checkout ${url} && git push`, { urls: 'referenced', pushes: true, named: [url] }],
    [`gh pr view --json url ${url}`, { urls: 'referenced', pushes: false, named: [url] }],
    [`gh pr create --fill && gh pr view ${url}`, { ...created, named: [url] }],
  ])('classifies %j', (command, evidence) => {
    expect(commandEvidence(command)).toEqual(evidence)
  })

  it.each([
    'git commit -m "push the fix"',
    'git stash push -m wip',
    'gh pr list --head feat',
    'gh pr status',
    'git-push origin',
  ])('ignores %j', (command) => {
    expect(commandEvidence(command)).toBeUndefined()
  })
})

describe('ownChangeRequestUrls', () => {
  const pull = (number: number): string => `https://github.com/octo/demo/pull/${number}`

  it('reads the url field and a URL alone on a line before a description, and JSON url members', () => {
    const view = ['title:\tAdd it', 'state:\tOPEN', `url:\t${pull(7)}`, '--', `Stacked on ${pull(8)}`, pull(9)].join('\n')
    expect(ownChangeRequestUrls(view)).toEqual([pull(7)])
    expect(ownChangeRequestUrls(`${pull(5)}\n`)).toEqual([pull(5)])
    const members = JSON.stringify({ number: 6, url: pull(6), body: `see ${pull(8)}`, comments: [{ url: `${pull(6)}#issuecomment-1` }] })
    expect(ownChangeRequestUrls(members)).toEqual([pull(6)])
    expect(ownChangeRequestUrls(`{\n  "url": "${pull(4)}/"\n}`)).toEqual([pull(4)])
  })

  it('finds nothing in output that names no change request of its own', () => {
    expect(ownChangeRequestUrls("Switched to branch 'feat'\n")).toEqual([])
    expect(ownChangeRequestUrls(`see ${pull(3)} for details`)).toEqual([])
  })
})

describe('changeRequestUrls', () => {
  it('finds distinct pull request URLs in order', () => {
    const text = [
      'https://github.com/octo/demo/pull/12',
      'see (https://github.com/octo/demo/pull/3/files) and https://github.com/octo/demo/pull/12',
      '[link](http://ghe.corp.example/team/svc/pull/7)',
    ].join('\n')

    expect(changeRequestUrls(text)).toEqual([
      'https://github.com/octo/demo/pull/12',
      'https://github.com/octo/demo/pull/3',
      'http://ghe.corp.example/team/svc/pull/7',
    ])
  })

  it('ignores compare links and malformed numbers', () => {
    expect(changeRequestUrls('https://github.com/octo/demo/pull/new/feat https://github.com/octo/demo/pull/12abc')).toEqual([])
  })
})

describe('pushedBranches', () => {
  it('reads created, updated, forced, and current branches under their remote', () => {
    const text = [
      'To github.com:octo/demo.git',
      ' * [new branch]      feat -> feat',
      '   1a2b3c4..5d6e7f8  main -> main',
      ' + 1a2b3c4...5d6e7f8 topic -> topic (forced update)',
      ' = [up to date]      stable -> stable',
      ' * [new branch]      HEAD -> refs/heads/review',
    ].join('\n')

    expect(pushedBranches(text)).toEqual([
      { remote: 'github.com:octo/demo.git', branch: 'feat' },
      { remote: 'github.com:octo/demo.git', branch: 'main' },
      { remote: 'github.com:octo/demo.git', branch: 'topic' },
      { remote: 'github.com:octo/demo.git', branch: 'stable' },
      { remote: 'github.com:octo/demo.git', branch: 'review' },
    ])
  })

  it('excludes rejected, deleted, tag, and non-branch refs', () => {
    const text = [
      'To https://github.com/octo/demo.git',
      ' ! [rejected]        feat -> feat (fetch first)',
      ' ! [remote rejected] main -> main (protected branch hook declined)',
      ' - [deleted]         old',
      ' * [new tag]         v1.0 -> v1.0',
      ' * [new reference]   HEAD -> refs/for/main',
      'error: failed to push some refs to \'https://github.com/octo/demo.git\'',
    ].join('\n')

    expect(pushedBranches(text)).toEqual([])
  })

  it('assigns each ref line to the nearest preceding remote and ignores ref lines before any remote', () => {
    const text = [
      ' * [new branch]      orphan -> orphan',
      'To fake.test:octo/one.git\r',
      ' * [new branch]      feat -> feat\r',
      'To fake.test:octo/two.git',
      ' * [new branch]      feat -> feat',
      ' * [new branch]      feat -> feat',
    ].join('\n')

    expect(pushedBranches(text)).toEqual([
      { remote: 'fake.test:octo/one.git', branch: 'feat' },
      { remote: 'fake.test:octo/two.git', branch: 'feat' },
    ])
  })
})

describe('sameChangeRequestUrl', () => {
  it('ignores scheme, letter case, query, fragment, and trailing slashes', () => {
    expect(sameChangeRequestUrl('https://github.com/Octo/Demo/pull/1/', 'http://github.com/octo/demo/pull/1?tab=checks#top')).toBe(true)
  })

  it('distinguishes different numbers and repositories', () => {
    expect(sameChangeRequestUrl('https://github.com/octo/demo/pull/1', 'https://github.com/octo/demo/pull/10')).toBe(false)
    expect(sameChangeRequestUrl('https://github.com/octo/demo/pull/1', 'https://github.com/octo/other/pull/1')).toBe(false)
  })
})
