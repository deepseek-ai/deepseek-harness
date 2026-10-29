import { describe, expect, it } from 'vitest'
import { ghReferences } from '../src/references.ts'

describe('explicit CLI references', () => {
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
  ])('recognizes %s', (command) => {
    expect(ghReferences(command)).toEqual([{ url, lookup: null }])
  })

  it('resolves a repo without a host through the same gh configuration and literal environment', () => {
    expect(ghReferences('gh pr view 5960 --repo deepseek-harness/deepseek-harness --json number,title,state,author,baseRefName,headRefName,additions,deletions,changedFiles,labels,body 2>&1 | head -200'))
      .toEqual([{ url: null, lookup: 'env gh pr view 5960 --repo deepseek-harness/deepseek-harness --json url' }])
    expect(ghReferences('GH_CONFIG_DIR="/tmp/gh config" gh pr edit 12 -R octo/demo --title "A title"'))
      .toEqual([{ url: null, lookup: "env 'GH_CONFIG_DIR=/tmp/gh config' gh pr view 12 --repo octo/demo --json url" }])
  })

  it('keeps repository and selector in the same command, and does not resolve a compound shell environment', () => {
    expect(ghReferences('gh pr view 5960 --json number && echo --repo ghe.example/octo/demo')).toEqual([])
    expect(ghReferences('echo --repo ghe.example/octo/demo | gh pr view 5960')).toEqual([])
    expect(ghReferences('cd other && gh pr view 5960 -R octo/demo')).toEqual([{ url: null, lookup: null }])
    expect(ghReferences('gh pr view 5960 -R octo/demo | custom-command')).toEqual([{ url: null, lookup: null }])
    expect(ghReferences('gh pr view 5960 -R octo/demo | (cat)')).toEqual([{ url: null, lookup: null }])
    expect(ghReferences('gh pr view 5960 -R ghe.example/octo/demo && gh pr checkout 12 -R github.com/other/repo'))
      .toEqual([{ url, lookup: null }, { url: 'https://github.com/other/repo/pull/12', lookup: null }])
  })

  it.each([
    'echo "gh pr view 5960 --repo ghe.example/octo/demo"',
    'gh pr view $PR --repo ghe.example/octo/demo',
    'gh pr view 5960 --repo "$REPO"',
    'gh pr view $(cat number) --repo ghe.example/octo/demo',
    'gh pr view `cat number` --repo ghe.example/octo/demo',
    'gh pr view 5960 --repo "ghe.example/octo/demo',
    'gh pr view 5960 -R ghe.example/*/demo',
    'gh pr view 5960 -R ghe.example/octo/demo > output.txt',
    'gh pr view 5960 -R ghe.example/octo/demo # comment',
    'gh pr view 5960\n--repo ghe.example/octo/demo',
    'gh pr view topic -R ghe.example/octo/demo',
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
  ])('leaves unsupported or ambiguous input unbound: %s', (command) => {
    expect(ghReferences(command)).toEqual([])
  })

  it('consumes boolean flags without treating them as selectors', () => {
    expect(ghReferences('gh pr view --comments 5960 -R ghe.example/octo/demo')).toEqual([{ url, lookup: null }])
    expect(ghReferences('gh pr edit 5960 --title=Fixed -R ghe.example/octo/demo')).toEqual([{ url, lookup: null }])
  })
})
