/** Branch-name rules and branch labels shared by the Host and the Client. */
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { branchLabel, branchNameProblem, isRemoteRef } from '../src/branch-name.ts'

/** Whether Git accepts `name` as a new branch, as the worktree service checks it at creation. */
function gitAccepts(name: string): boolean {
  try {
    execFileSync('git', ['check-ref-format', `refs/heads/${name}`], { stdio: 'ignore' })
    return true
  } catch (error) {
    void error // A nonzero exit is Git's refusal.
    return false
  }
}

describe('branchNameProblem', () => {
  it.each([
    ['', 'empty'],
    ['fix login', 'space'],
    ['fix\tlogin', 'space'],
    ['fix\u007flogin', 'character'],
    ['fix~1', 'character'],
    ['fix^', 'character'],
    ['a:b', 'character'],
    ['a?b', 'character'],
    ['a*b', 'character'],
    ['a[b', 'character'],
    ['a\\b', 'character'],
    ['-fix', 'leading-dash'],
    ['/fix', 'leading-slash'],
    ['fix/', 'trailing-slash'],
    ['fix//login', 'double-slash'],
    ['fix..login', 'double-dot'],
    ['fix.', 'trailing-dot'],
    ['@', 'at'],
    ['fix@{1}', 'at-brace'],
    ['fix/.login', 'dot-segment'],
    ['.fix', 'dot-segment'],
    ['fix.lock/login', 'lock-segment'],
    ['fix.lock', 'lock-segment'],
  ] as const)('refuses %j as %s', (name, problem) => {
    expect(branchNameProblem(name)).toBe(problem)
  })

  it.each(['fix-login', 'dsh-0a1b2c3d-9f3e', 'fix/login', 'a./b', 'a/@/b', 'é', 'HEAD'])('accepts %j', (name) => {
    expect(branchNameProblem(name)).toBeNull()
  })

  it('refuses every name that Git refuses among these', () => {
    for (const name of ['fix login', 'a..b', 'x@{y', 'a/.b', 'a/b.', 'aa.lock', 'fix//x', '/x', 'x/', 'a~b', 'a\\b', 'a[b']) {
      expect(gitAccepts(name)).toBe(false)
      expect(branchNameProblem(name)).not.toBeNull()
    }
  })
})

describe('branchLabel', () => {
  it('drops the prefix of a full local or remote-tracking branch name and keeps any other revision', () => {
    expect(branchLabel('refs/heads/fix/login')).toBe('fix/login')
    expect(branchLabel('refs/remotes/origin/main')).toBe('origin/main')
    expect(branchLabel('main')).toBe('main')
    expect(branchLabel('refs/heads/')).toBe('refs/heads/')
    expect(branchLabel('refs/tags/v1')).toBe('refs/tags/v1')
  })
})

describe('isRemoteRef', () => {
  it('recognizes the full name of a remote-tracking branch', () => {
    expect(isRemoteRef('refs/remotes/origin/main')).toBe(true)
    expect(isRemoteRef('refs/remotes/')).toBe(false)
    expect(isRemoteRef('refs/heads/main')).toBe(false)
    expect(isRemoteRef('origin/main')).toBe(false)
    expect(isRemoteRef(null)).toBe(false)
  })
})
