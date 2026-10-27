/**
 * workspaceWriteSid tests: the per-workspace write identity is deterministic
 * (the same canonical path always derives the same SID — the property the
 * cross-session grant reuse rests on), capability-shaped, distinct across
 * workspaces, and byte-sensitive (the canonical path is the caller's
 * contract; an alias spelling derives a second identity, self-healing at
 * the cost of one extra tree propagation).
 */

import { describe, expect, it } from 'vitest'

import { tempWriteSid, workspaceWriteSid } from '../src/index.ts'

describe('workspaceWriteSid', () => {
  it('derives a stable capability-shaped SID per workspace path', () => {
    const first = workspaceWriteSid('C:\\Users\\agent\\repo')
    const second = workspaceWriteSid('C:\\Users\\agent\\repo')
    expect(first).toBe(second)
    expect(first).toMatch(/^S-1-4-\d+-\d+$/u)
  })

  it('uses the same identity for reordered and duplicated writable-directory sets', () => {
    const workspace = 'C:\\repo'
    const memory = 'C:\\memory'
    const cache = 'C:\\cache'
    const sid = workspaceWriteSid(workspace, [memory, cache])
    expect(workspaceWriteSid(workspace, [cache, workspace, memory, cache])).toBe(sid)
    expect(workspaceWriteSid(memory, [workspace, cache])).toBe(sid)
    expect(workspaceWriteSid(workspace, [workspace])).toBe(workspaceWriteSid(workspace))
    expect(sid).not.toBe(workspaceWriteSid(workspace))
    expect(sid).not.toBe(workspaceWriteSid(workspace, [memory]))
  })

  it('keeps path boundaries distinct when their concatenated text matches', () => {
    expect(workspaceWriteSid('C:\\a', ['C:\\bC:\\c']))
      .not.toBe(workspaceWriteSid('C:\\aC:\\b', ['C:\\c']))
  })

  it('derives distinct identities for distinct workspaces', () => {
    expect(workspaceWriteSid('C:\\Users\\agent\\repo-a')).not.toBe(workspaceWriteSid('C:\\Users\\agent\\repo-b'))
  })

  it('is byte-sensitive: the canonical path is the caller\'s contract (an alias spelling derives a second identity)', () => {
    expect(workspaceWriteSid('C:\\Repo')).not.toBe(workspaceWriteSid('c:\\repo'))
    expect(workspaceWriteSid('C:\\Repo\\')).not.toBe(workspaceWriteSid('C:\\Repo'))
  })
})

describe('tempWriteSid', () => {
  it('derives a stable domain-separated SID per private temp path', () => {
    const temp = tempWriteSid('C:\\Users\\agent\\AppData\\Local\\Temp\\dsh-abc123')
    expect(temp).toBe(tempWriteSid('C:\\Users\\agent\\AppData\\Local\\Temp\\dsh-abc123'))
    expect(temp).toMatch(/^S-1-4-\d+-\d+-1$/u)
    expect(temp).not.toBe(workspaceWriteSid('C:\\Users\\agent\\AppData\\Local\\Temp\\dsh-abc123'))
  })

  it('derives distinct capabilities for distinct private temp paths', () => {
    expect(tempWriteSid('C:\\Temp\\dsh-a')).not.toBe(tempWriteSid('C:\\Temp\\dsh-b'))
  })
})
