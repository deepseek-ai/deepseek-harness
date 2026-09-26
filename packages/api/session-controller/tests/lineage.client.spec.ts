/**
 * flattenLineage: root ordering, DFS child expansion, orphan degradation, and
 * cycle fail-soft (every entry always emitted, no infinite walk).
 */

import { describe, expect, it, vi } from 'vitest'
import type { SessionId, SessionSummary } from '@deepseek-ai/dsh-api-remotes/client'
import { flattenLineage } from '../src/client/sessions/lineage.ts'

const s = (id: string, updatedAt: number, parent?: string): SessionSummary => ({ agentAvailable: true,
  sessionId: id as SessionId, updatedAt, running: false, blank: false,
  ...(parent !== undefined ? { parentSessionId: parent as SessionId } : {}),
})

describe('Session lineage flattening', () => {
  it('keeps established root and sibling order while expanding children DFS with depth', () => {
    const out = flattenLineage([
      s('old-root', 10),
      s('new-root', 30),
      s('kid-old', 11, 'new-root'),
      s('kid-new', 12, 'new-root'),
      s('grandkid', 5, 'kid-new'),
    ])
    expect(out.map(e => [e.sessionId, e.depth])).toEqual([
      ['old-root', 0], ['new-root', 0], ['kid-old', 1], ['kid-new', 1], ['grandkid', 2],
    ])
  })

  it('degrades an orphan (absent parent) to root level without dropping it', () => {
    const out = flattenLineage([s('orphan', 20, 'ghost-parent'), s('root', 10)])
    expect(out.map(e => [e.sessionId, e.depth])).toEqual([['orphan', 0], ['root', 0]])
  })

  it('fails soft on a two-node cycle: all entries emitted, warn fired, no hang', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const out = flattenLineage([s('a', 20, 'b'), s('b', 10, 'a'), s('root', 30)])
      expect(out.map(e => e.sessionId).sort()).toEqual(['a', 'b', 'root'])
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('handles a self-referencing entry as a cycle member', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const out = flattenLineage([s('self', 10, 'self')])
      expect(out.map(e => e.sessionId)).toEqual(['self'])
      expect(out[0]?.depth).toBe(0)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('keeps lineage rows free of completion presentation state', () => {
    const out = flattenLineage([s('a', 10), s('b', 20)])
    expect(out).toHaveLength(2)
    for (const row of out) expect(row).not.toHaveProperty('completed')
  })
})
