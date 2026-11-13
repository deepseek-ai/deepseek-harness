import { describe, expect, it } from 'vitest'
import { GH_COMMANDS } from '@deepseek-ai/dsh-experimental-forge-github/src/commands.ts'
import { compileRules, commandOf, FORGE_CHANGE_REQUESTS_VERSION, pushedBranches, sameChangeRequestUrl, validateRule } from '../src/commands.ts'
import type { CommandEvidence, ForgeCommandRule } from '../src/index.ts'
import { TEA_COMMANDS } from './fixtures.ts'

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

describe('validateRule', () => {
  it('accepts a well-formed rule', () => {
    expect(() => { validateRule(GH_COMMANDS) }).not.toThrow()
    expect(() => { validateRule(TEA_COMMANDS) }).not.toThrow()
  })

  it.each<[string, Partial<ForgeCommandRule>, RegExp]>([
    ['an empty id', { id: ' ' }, /needs an id/],
    ['a zero version', { version: 0 }, /positive integer version/],
    ['a fractional version', { version: 1.5 }, /positive integer version/],
    ['an executable with a path', { executable: '/usr/bin/gh' }, /invalid executable/],
    ['an empty subcommand sequence', { references: { ...GH_COMMANDS.references, subcommands: [[]] } }, /invalid subcommand/],
    ['an uppercase API subcommand', { apiRequests: { ...GH_COMMANDS.apiRequests, subcommands: [['API']] } }, /invalid subcommand/],
    ['an uppercase subcommand', { creates: [['PR', 'create']] }, /invalid subcommand/],
    ['no subcommand', { creates: [], references: { ...GH_COMMANDS.references, subcommands: [] }, apiRequests: { ...GH_COMMANDS.apiRequests, subcommands: [] } },
      /names no subcommand/],
    ['a malformed JSON member', { urlMembers: ['web url'] }, /invalid JSON member/],
    ['a malformed option', { references: { ...GH_COMMANDS.references, flagOptions: ['---web'] } }, /invalid option/],
    ['an option in both lists of a group', { apiRequests: { ...GH_COMMANDS.apiRequests, flagOptions: ['--hostname'] } }, /both a value option and a flag/],
    ['a page path that is not a regular expression', { changeRequestPath: '(' }, /invalid changeRequestPath/],
  ])('rejects %s', (_label, change, message) => {
    expect(() => { validateRule({ ...GH_COMMANDS, ...change }) }).toThrow(message)
  })
})

describe('compileRules', () => {
  const gh = compileRules([GH_COMMANDS])
  const url = 'https://github.com/octo/demo/pull/12'
  const created: CommandEvidence = { urls: 'created', pushes: false, named: [], rules: ['gh'] }
  const pushed: CommandEvidence = { urls: null, pushes: true, named: [], rules: [] }
  const referenced: CommandEvidence = { urls: 'referenced', pushes: false, named: [], rules: ['gh'] }

  it('derives the state version from the rule ids and versions, in any order', () => {
    const empty = compileRules([])
    expect(empty.version).toBeGreaterThanOrEqual(FORGE_CHANGE_REQUESTS_VERSION * 2 ** 32)
    expect(empty.version).toBeLessThan((FORGE_CHANGE_REQUESTS_VERSION + 1) * 2 ** 32)
    expect(compileRules([GH_COMMANDS, TEA_COMMANDS]).version).toBe(compileRules([TEA_COMMANDS, GH_COMMANDS]).version)
    expect(new Set([empty.version, gh.version, compileRules([{ ...GH_COMMANDS, version: 3 }]).version]).size).toBe(3)
  })

  it('hints at the raw arguments that name an executable or a push', () => {
    expect(gh.hint.test('{"command":"gh pr create"}')).toBe(true)
    expect(gh.hint.test('{"command":"git push"}')).toBe(true)
    expect(gh.hint.test('{"command":"ls"}')).toBe(false)
  })

  it.each([
    ['gh pr create --fill', created],
    ['gh pr new -t title -b body', created],
    ['git push', pushed],
    ['git push -u origin HEAD', pushed],
    ['git -C ../checkout push origin feat', pushed],
    ['git -c credential.helper= push', pushed],
    ['git --no-pager push --force-with-lease', pushed],
    ['cd repo && git push && gh pr create --fill', { ...created, pushes: true }],
    ['gh pr view 12 --json url', referenced],
    ['gh pr view 12 --repo octo/demo --json number', referenced],
    ['gh -R octo/demo pr view 12', referenced],
    [`gh pr view '${url}' --json title`, { ...referenced, named: [url] }],
    [`gh pr edit ${url}/files --add-label bug`, { ...referenced, named: [url] }],
    [`gh pr checkout ${url} && git push`, { ...referenced, pushes: true, named: [url] }],
    [`gh pr view --json url ${url}`, { ...referenced, named: [url] }],
    [`gh pr create --fill && gh pr view ${url}`, { ...created, named: [url] }],
  ])('classifies %j', (command, evidence) => {
    expect(gh.evidence(command)).toEqual(evidence)
  })

  it.each([
    'git commit -m "push the fix"',
    'git stash push -m wip',
    'gh pr list --head feat',
    'gh pr status',
    'git-push origin',
    'tea pulls create',
  ])('ignores %j', (command) => {
    expect(gh.evidence(command)).toBeUndefined()
  })

  it('recognizes only pushes without rules', () => {
    const empty = compileRules([])
    expect(empty.hint.test('{"command":"gh pr create"}')).toBe(false)
    expect(empty.evidence('gh pr create --fill')).toBeUndefined()
    expect(empty.evidence('git push')).toEqual(pushed)
    expect(empty.named('gh pr view https://github.com/octo/demo/pull/1')).toEqual([])
  })

  it('names the change requests of literal simple commands, with a lookup only for a standalone command', () => {
    expect(gh.named(`cd repo && gh pr view ${url}`)).toEqual([{ url, lookup: null, rule: 'gh', kind: 'reference' }])
    expect(gh.named('gh pr view 12 -R octo/demo | head -5')).toEqual([
      { url: null, lookup: 'env gh pr view 12 --repo octo/demo --json url --jq .url', rule: 'gh', kind: 'reference' },
    ])
    expect(gh.named('cd repo && gh pr view 12 -R octo/demo')).toEqual([{ url: null, lookup: null, rule: 'gh', kind: 'reference' }])
    expect(gh.named('gh pr view topic -R octo/demo')).toEqual([])
  })

  it('parses declared options in each form, and names nothing for an undeclared option or a missing value', () => {
    const named = [{ url: 'https://ghe.example/octo/demo/pull/1', lookup: null, rule: 'gh', kind: 'reference' }]
    expect(gh.named('gh pr view 1 --repo ghe.example/octo/demo --web')).toEqual(named)
    expect(gh.named('gh pr view 1 --repo=ghe.example/octo/demo')).toEqual(named)
    expect(gh.named('gh pr view 1 -Rghe.example/octo/demo')).toEqual(named)
    expect(gh.named('gh pr view 1 -R ghe.example/octo/demo --unknown')).toEqual([])
    expect(gh.named('gh pr view 1 -X -R ghe.example/octo/demo')).toEqual([])
    expect(gh.named('gh pr view 1 --repo')).toEqual([])
    expect(gh.named('gh pr view - -R ghe.example/octo/demo')).toEqual([])
  })

  it('binds the change request an API request names, without reading its output', () => {
    const named = 'gh api --hostname github.com repos/octo/demo/pulls/12/files'
    const evidence = gh.evidence(named)
    expect(evidence).toEqual({ urls: 'referenced', pushes: false, named: [url], rules: [] })
    expect(evidence === undefined ? undefined : gh.printed(JSON.stringify({ url: 'https://github.com/octo/demo/pull/3' }), evidence)).toEqual([])
    expect(gh.evidence('gh api --hostname github.com repos/octo/demo/pulls')).toBeUndefined()
    // A reference command in the same line still has its output read.
    expect(gh.evidence(`${named} && gh pr view 3 --repo octo/demo`)).toMatchObject({ urls: 'referenced', named: [url], rules: ['gh'] })
  })

  it('reads every page URL of the matched rules after a creation', () => {
    const text = [
      url,
      'see (https://github.com/octo/demo/pull/3/files) and https://github.com/octo/demo/pull/12',
      '[link](http://ghe.corp.example/team/svc/pull/7)',
      'https://github.com/octo/demo/pull/new/feat https://github.com/octo/demo/pull/12abc',
      'https://tea.example/octo/demo/pulls/4',
    ].join('\n')
    expect(gh.printed(text, created)).toEqual([url, 'https://github.com/octo/demo/pull/3', 'http://ghe.corp.example/team/svc/pull/7'])
    expect(gh.printed(text, { ...created, rules: [] })).toEqual([])
  })

  it('reads the URL a reference command prints for its own change request', () => {
    const pull = (number: number): string => `https://github.com/octo/demo/pull/${number}`
    const view = ['title:\tAdd it', 'state:\tOPEN', `url:\t${pull(7)}`, '--', `Stacked on ${pull(8)}`, pull(9)].join('\n')
    expect(gh.printed(view, referenced)).toEqual([pull(7)])
    expect(gh.printed(`${pull(5)}\n`, referenced)).toEqual([pull(5)])
    const members = JSON.stringify({ number: 6, url: pull(6), body: `see ${pull(8)}`, comments: [{ url: `${pull(6)}#issuecomment-1` }] })
    expect(gh.printed(members, referenced)).toEqual([pull(6)])
    expect(gh.printed(`{\n  "url": "${pull(4)}/"\n}`, referenced)).toEqual([pull(4)])
    expect(gh.printed("Switched to branch 'feat'\n", referenced)).toEqual([])
    expect(gh.printed(`see ${pull(3)} for details`, referenced)).toEqual([])
  })

  it('applies a rule without creations or JSON members only to its references and lines', () => {
    const tea = compileRules([TEA_COMMANDS])
    const page = 'https://tea.example/octo/demo/pulls/4'
    expect(tea.evidence('tea pulls create')).toBeUndefined()
    const evidence = tea.evidence(`tea pulls checkout ${page}`)
    expect(evidence).toEqual({ urls: 'referenced', pushes: false, named: [page], rules: ['tea'] })
    expect(tea.printed(`${page}\n{"url":"${page}"}`, { ...referenced, rules: ['tea'] })).toEqual([page])
  })

  it('accepts lookup output that is one page URL of the lookup rule', () => {
    expect(gh.lookupUrl(`${url}\n`, 'gh')).toBe(url)
    expect(gh.lookupUrl(`${url}/`, 'gh')).toBe(url)
    expect(gh.lookupUrl(`${url}\n${url}`, 'gh')).toBeUndefined()
    expect(gh.lookupUrl(JSON.stringify({ url }), 'gh')).toBeUndefined()
    expect(gh.lookupUrl(url, 'tea')).toBeUndefined()
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
