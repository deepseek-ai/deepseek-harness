import { describe, expect, it } from 'vitest'
import { compileRules } from '@deepseek-ai/dsh-experimental-forge-session/src/commands.ts'
import { GH_COMMANDS } from '../src/commands.ts'

const rules = compileRules([GH_COMMANDS])

describe('gh command rule', () => {
  const url = 'https://ghe.example/octo/demo/pull/5960'

  it.each([
    'gh pr view 5960 --repo ghe.example/octo/demo --json number,title,body 2>&1 | head -200',
    'gh -R ghe.example/octo/demo pr view --json number 5960',
    'gh pr edit --repo="ghe.example/octo/demo" --title "New title" 5960',
    "gh pr checkout -Rghe.example/octo/demo '5960'",
    'GH_HOST=ghe.example gh pr view 5960 -R octo/demo',
    'env GH_HOST=ghe.example gh pr view 5960 -R octo/demo',
    'GH_HOST=other.example gh pr view 5960 -R ghe.example/octo/demo',
    'gh pr view 5960 -R https://ghe.example/octo/demo.git',
    `gh pr view --json title '${url}/files'`,
    'gh pr view --comments 5960 -R ghe.example/octo/demo',
    'gh pr edit 5960 --title=Fixed -R ghe.example/octo/demo',
  ])('names the pull request of %s', (command) => {
    expect(rules.named(command)).toEqual([{ url, lookup: null, rule: 'gh', kind: 'reference' }])
  })

  it('looks up a repository without a host through gh in the same environment', () => {
    expect(rules.named('gh pr view 5960 --repo deepseek-harness/deepseek-harness --json number,title,body 2>&1 | head -200')).toEqual([
      { url: null, lookup: 'env gh pr view 5960 --repo deepseek-harness/deepseek-harness --json url --jq .url', rule: 'gh', kind: 'reference' },
    ])
    expect(rules.named('GH_CONFIG_DIR="/tmp/gh config" gh pr edit 12 -R octo/demo --title "A title"')).toEqual([
      { url: null, lookup: "env 'GH_CONFIG_DIR=/tmp/gh config' gh pr view 12 --repo octo/demo --json url --jq .url", rule: 'gh', kind: 'reference' },
    ])
    expect(rules.named('GH_HOST= gh pr view 12 -R octo/demo')).toEqual([
      { url: null, lookup: String.raw`env GH_HOST\= gh pr view 12 --repo octo/demo --json url --jq .url`, rule: 'gh', kind: 'reference' },
    ])
  })

  it('keeps repository and selector in the same command, and does not look up in a compound shell environment', () => {
    expect(rules.named('gh pr view 5960 --json number && echo --repo ghe.example/octo/demo')).toEqual([])
    expect(rules.named('echo --repo ghe.example/octo/demo | gh pr view 5960')).toEqual([])
    expect(rules.named('cd other && gh pr view 5960 -R octo/demo')).toEqual([{ url: null, lookup: null, rule: 'gh', kind: 'reference' }])
    expect(rules.named('gh pr view 5960 -R octo/demo | custom-command')).toEqual([{ url: null, lookup: null, rule: 'gh', kind: 'reference' }])
    expect(rules.named('gh pr view 5960 -R ghe.example/octo/demo && gh pr checkout 12 -R github.com/other/repo')).toEqual([
      { url, lookup: null, rule: 'gh', kind: 'reference' },
      { url: 'https://github.com/other/repo/pull/12', lookup: null, rule: 'gh', kind: 'reference' },
    ])
  })

  it.each([
    'echo "gh pr view 5960 --repo ghe.example/octo/demo"',
    'gh pr view 5960 --repo "$REPO"',
    'gh pr view 5960 -R ghe.example/*/demo',
    'gh pr view 5960 -R ghe.example/octo/demo > output.txt',
    'gh pr view 5960 -R ghe.example/octo/demo # comment',
    'gh pr view topic -R ghe.example/octo/demo',
    'gh pr view - -R ghe.example/octo/demo',
    'gh pr edit --title 5960 --repo ghe.example/octo/demo',
    'gh pr view 5960 --unknown 42 --repo ghe.example/octo/demo',
    'gh pr view 5960 --repo',
    'gh pr view 5960 --repo=',
    'gh pr view 5960 -R bad/repo/extra/path',
    'gh pr view 5960 -R ghe.example/octo/..',
    'gh pr view 99999999999999999999 -R ghe.example/octo/demo',
    'gh pr view 1 2 -R ghe.example/octo/demo',
    'gh pr view --json',
    'gh pr view --help -R ghe.example/octo/demo',
    'gh pr edit --title --repo ghe.example/octo/demo 5960',
    'gh pr list -R ghe.example/octo/demo',
    'gh pr view',
  ])('names nothing for unsupported or ambiguous input: %s', (command) => {
    expect(rules.named(command)).toEqual([])
  })

  describe('gh api', () => {
    it.each([
      ['gh api --hostname ghe.example repos/octo/demo/pulls/5960', 'https://ghe.example/octo/demo/pull/5960'],
      ['GH_HOST=ghe.example gh api repos/octo/demo/pulls/5960/files --paginate', 'https://ghe.example/octo/demo/pull/5960'],
      ['gh api -f body=LGTM -X POST /repos/octo/demo/pulls/5960/reviews --hostname=github.com --jq .id', 'https://github.com/octo/demo/pull/5960'],
    ])('names the pull request a REST path names: %s', (command, url) => {
      expect(rules.named(command)).toEqual([{ url, lookup: null, rule: 'gh', kind: 'api-request' }])
    })

    it('looks up a path without a host through gh, in the current repository for its placeholders', () => {
      expect(rules.named('gh api repos/octo/demo/pulls/12')).toEqual([
        { url: null, lookup: 'env gh pr view 12 --repo octo/demo --json url --jq .url', rule: 'gh', kind: 'api-request' },
      ])
      expect(rules.named("gh api 'repos/{owner}/{repo}/pulls/12/comments'")).toEqual([
        { url: null, lookup: 'env gh pr view 12 --json url --jq .url', rule: 'gh', kind: 'api-request' },
      ])
      expect(rules.named('gh api repos/:owner/:repo/pulls/12')).toEqual([
        { url: null, lookup: 'env gh pr view 12 --json url --jq .url', rule: 'gh', kind: 'api-request' },
      ])
    })

    it.each([
      'gh api --hostname ghe.example repos/octo/demo/pulls',
      'gh api --hostname ghe.example repos/octo/demo/issues/7',
      'gh api --hostname ghe.example repos/octo/../pulls/7',
      'gh api --hostname ghe.example repos/oc%20to/demo/pulls/7',
      'gh api --hostname https://ghe.example repos/octo/demo/pulls/7',
      'gh api --hostname ghe.example repos/octo/demo/pulls/99999999999999999999',
      'gh api --bogus repos/octo/demo/pulls/7',
      'gh api graphql -f query=x',
      'gh api repos/octo/demo/pulls/7 repos/octo/demo/pulls/8',
      'gh api --hostname ghe.example',
    ])('names nothing for %s', (command) => {
      expect(rules.named(command)).toEqual([])
    })

    it('reads -f as a value of gh api and as a flag of gh pr checkout', () => {
      expect(rules.named('gh pr checkout -f 5960 -R ghe.example/octo/demo')).toEqual([{ url, lookup: null, rule: 'gh', kind: 'reference' }])
    })
  })
})
