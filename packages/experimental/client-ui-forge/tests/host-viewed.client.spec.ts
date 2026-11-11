/** The host's viewed marks of a diff as digests, with the reader's choices taking their place. */
import { describe, expect, it } from 'vitest'
import type { ForgeViewedState } from '@deepseek-ai/dsh-experimental-forge/types'
import { hostMarksOf } from '../src/client/host-viewed.ts'
import type { ForgeDiffFile } from '../src/types.ts'

function file(path: string): ForgeDiffFile {
  return { path, previousPath: null, status: 'modified', binary: false, oversized: false, untracked: false, layer: 'implementation',
    digest: `digest-${path}`, additions: 1, deletions: 0, hunks: [] }
}

describe('hostMarksOf', () => {
  it('reads only the host\'s own entries and the reader\'s choices for paths named after object properties', () => {
    const files = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'].map(file)
    // Parsed as the transport does, so `__proto__` is the host's own entry.
    const host = JSON.parse('{"__proto__":"viewed","toString":"dismissed"}') as Record<string, ForgeViewedState>
    expect([...hostMarksOf(files, host, new Map())]).toEqual([['__proto__', 'digest-__proto__'], ['toString', '']])
    expect([...hostMarksOf(files, host, new Map([['constructor', true], ['__proto__', false]]))])
      .toEqual([['constructor', 'digest-constructor'], ['toString', '']])
  })
})
