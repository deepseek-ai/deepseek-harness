import { describe, expect, it } from 'vitest'
import { compileRules } from '@deepseek-ai/dsh-experimental-forge-session/src/commands.ts'
import { GLAB_COMMANDS } from '../src/commands.ts'

const rules = compileRules([GLAB_COMMANDS])

describe('glab command rule', () => {
  const url = 'https://gitlab.example/group/sub/demo/-/merge_requests/42'

  it.each([
    `glab mr view ${url}`,
    `glab mr checkout '${url}/diffs?view=inline'`,
    `glab mr update '${url}#note_7' --ready --label bug`,
    'glab mr view 42 -R https://gitlab.example/group/sub/demo',
    'glab mr view 42 --repo=https://gitlab.example/group/sub/demo.git -F json',
    'glab mr checkout -Rhttps://gitlab.example/group/sub/demo/ 42 --branch review',
    'glab mr update 42 --title "Fix it" --draft -R https://gitlab.example/group/sub/demo',
  ])('names the merge request of %s', (command) => {
    expect(rules.named(command)).toEqual([{ url, lookup: null, rule: 'glab', kind: 'reference' }])
  })

  it('keeps a plain http project URL', () => {
    expect(rules.named('glab mr view 3 -R http://gitlab.local:8080/team/app')).toEqual([
      { url: 'http://gitlab.local:8080/team/app/-/merge_requests/3', lookup: null, rule: 'glab', kind: 'reference' },
    ])
  })

  it('looks up the other repository forms through glab in the same environment', () => {
    expect(rules.named('glab mr view 42 -R group/sub/demo --comments 2>&1 | tail -40')).toEqual([
      { url: null, lookup: 'env glab mr view 42 --repo group/sub/demo --output json --jq .web_url', rule: 'glab', kind: 'reference' },
    ])
    expect(rules.named('GITLAB_HOST=gitlab.example glab mr update 42 -R git@gitlab.example:group/demo.git --ready')).toEqual([
      {
        url: null,
        lookup: String.raw`env GITLAB_HOST\=gitlab.example glab mr view 42 --repo git\@gitlab.example\:group/demo.git --output json --jq .web_url`,
        rule: 'glab', kind: 'reference',
      },
    ])
    expect(rules.named('glab mr view 42 -R https://gitlab.example/group/../demo')).toEqual([
      { url: null, lookup: String.raw`env glab mr view 42 --repo https\://gitlab.example/group/../demo --output json --jq .web_url`, rule: 'glab', kind: 'reference' },
    ])
  })

  it.each([
    'glab mr view 42',
    'glab mr view feature-branch -R group/demo',
    'glab mr view 1 2 -R group/demo',
    'glab mr view 42 --unknown -R group/demo',
    'glab mr list -R group/demo',
    'glab mr view https://gitlab.example/group/demo/-/issues/42',
  ])('names nothing for unsupported or ambiguous input: %s', (command) => {
    expect(rules.named(command)).toEqual([])
  })

  it('reads the merge request URLs that glab prints', () => {
    const evidence = rules.evidence('glab mr create --fill --yes')
    expect(evidence).toEqual({ urls: 'created', pushes: false, named: [], rules: ['glab'] })
    const created = ['Creating merge request for feat into main in group/sub/demo', '', '!42 Fix it (feat)', ` ${url}`].join('\n')
    expect(evidence === undefined ? [] : rules.printed(created, evidence)).toEqual([url])
    const viewed = ['title:\tFix it', 'number:\t42', `url:\t${url}`, '--', 'Follows https://gitlab.example/group/sub/demo/-/merge_requests/41'].join('\n')
    expect(rules.printed(viewed, { urls: 'referenced', pushes: false, named: [], rules: ['glab'] })).toEqual([url])
    const json = JSON.stringify({ iid: 42, web_url: url, author: { web_url: 'https://gitlab.example/octo' } })
    expect(rules.printed(json, { urls: 'referenced', pushes: false, named: [], rules: ['glab'] })).toEqual([url])
    expect(rules.lookupUrl(`${url}\n`, 'glab')).toBe(url)
  })

  describe('glab api', () => {
    const merge = (host: string, number: number) => `https://${host}/LegGasai/jyc-test/-/merge_requests/${number}`

    it.each([
      ['glab api --hostname gitlab.deepseek.com "projects/LegGasai%2Fjyc-test/merge_requests/3" 2>&1 | head -c 6000', merge('gitlab.deepseek.com', 3)],
      ['glab api --hostname gitlab.deepseek.com projects/LegGasai%2Fjyc-test/merge_requests/3/changes', merge('gitlab.deepseek.com', 3)],
      ["glab api '/api/v4/projects/LegGasai%2Fjyc-test/merge_requests/4/notes?per_page=100' --hostname=gitlab.example --paginate", merge('gitlab.example', 4)],
      ['glab api -X POST -f body=LGTM -H "Accept: application/json" --hostname gitlab.example projects/LegGasai%2Fjyc-test/merge_requests/5/notes',
        merge('gitlab.example', 5)],
      ['glab api https://gitlab.example:8443/api/v4/projects/LegGasai%2Fjyc-test/merge_requests/6', merge('gitlab.example:8443', 6)],
    ])('names the merge request a REST path names: %s', (command, url) => {
      expect(rules.named(command)).toEqual([{ url, lookup: null, rule: 'glab', kind: 'api-request' }])
    })

    it('looks up a path without a host through glab, in the current repository for its placeholders', () => {
      expect(rules.named('glab api projects/group%2Fsub%2Fapp/merge_requests/7')).toEqual([
        { url: null, lookup: 'env glab mr view 7 --repo group/sub/app --output json --jq .web_url', rule: 'glab', kind: 'api-request' },
      ])
      expect(rules.named('glab api projects/:fullpath/merge_requests/7/diffs')).toEqual([
        { url: null, lookup: 'env glab mr view 7 --output json --jq .web_url', rule: 'glab', kind: 'api-request' },
      ])
    })

    it.each([
      'glab api --hostname gitlab.example projects/group%2Fapp/merge_requests',
      'glab api --hostname gitlab.example projects/1680/merge_requests/3',
      'glab api --hostname gitlab.example projects/group%E0%2Fapp/merge_requests/3',
      'glab api --hostname gitlab.example projects/group%2F..%2Fapp/merge_requests/3',
      'glab api --hostname https://gitlab.example projects/group%2Fapp/merge_requests/3',
      'glab api --hostname gitlab.example projects/group%2Fapp/issues/3',
      'glab api --hostname gitlab.example projects/group%2Fapp/merge_requests/99999999999999999999',
      'glab api --bogus projects/group%2Fapp/merge_requests/3',
      'glab api graphql -f query=x',
      'glab api projects/group%2Fapp/merge_requests/3 projects/group%2Fapp/merge_requests/4',
    ])('names nothing for %s', (command) => {
      expect(rules.named(command)).toEqual([])
    })

    it('binds the named merge request without reading the output, which can list others', () => {
      const command = 'glab api --hostname gitlab.example projects/LegGasai%2Fjyc-test/merge_requests/3'
      const evidence = rules.evidence(command)
      expect(evidence).toEqual({ urls: 'referenced', pushes: false, named: [merge('gitlab.example', 3)], rules: [] })
      const listed = JSON.stringify([{ iid: 4, web_url: merge('gitlab.example', 4) }])
      expect(evidence === undefined ? undefined : rules.printed(listed, evidence)).toEqual([])
      expect(rules.evidence('glab api --hostname gitlab.example projects/LegGasai%2Fjyc-test/merge_requests')).toBeUndefined()
    })
  })
})
