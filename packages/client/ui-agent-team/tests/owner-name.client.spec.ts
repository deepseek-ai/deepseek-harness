/** Team task owners use the agent names that agent tools report. */
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState, SessionProjectionMap } from '@deepseek-ai/dsh-api-session-controller/client'
import { ownerName } from '../src/client/owner-name.ts'

type Projections = SessionListState['projectionsBySession']
type SubagentCatalogEntry = SessionProjectionMap['subagentCatalog'][number]

const ROOT = 'root-id' as SessionId
const REVIEWER = 'reviewer-id' as SessionId
const CHECKER = 'checker-id' as SessionId
const HISTORICAL = 'historical-id' as SessionId

function catalogs(entries: Readonly<Record<SessionId, readonly SubagentCatalogEntry[]>>): Projections {
  return Object.fromEntries(Object.entries(entries).map(([id, subagentCatalog]) => [
    id, { state: 'ready', error: null, values: { subagentCatalog: [...subagentCatalog] } },
  ]))
}

const tree = catalogs({
  [ROOT]: [
    { id: HISTORICAL, createdAt: 1, mode: 'continuable', label: 'Historical' },
    { id: 'one-shot-id' as SessionId, createdAt: 2, mode: 'one-shot' },
    { id: 'external-id' as SessionId, createdAt: 3, mode: 'external', name: 'outside' },
    { id: REVIEWER, createdAt: 4, mode: 'continuable', label: 'Review', name: 'reviewer' },
  ],
  [REVIEWER]: [{ id: CHECKER, createdAt: 5, mode: 'continuable', label: 'Check', name: 'checker' }],
  [HISTORICAL]: [{ id: 'below-historical-id' as SessionId, createdAt: 6, mode: 'continuable', label: 'Below', name: 'below' }],
})

describe('ownerName', () => {
  it('names the root lead and descendants by their path below the root', () => {
    expect(ownerName(tree, ROOT, ROOT)).toBe('lead')
    expect(ownerName({}, ROOT, ROOT)).toBe('lead')
    expect(ownerName(tree, ROOT, REVIEWER)).toBe('reviewer')
    expect(ownerName(tree, ROOT, CHECKER)).toBe('reviewer/checker')
    expect(ownerName(tree, ROOT, 'external-id' as SessionId)).toBe('outside')
  })

  it('keeps the Session ID when a link is unnamed, unloaded, or absent', () => {
    expect(ownerName(tree, ROOT, HISTORICAL)).toBe(HISTORICAL)
    expect(ownerName(tree, ROOT, 'below-historical-id' as SessionId)).toBe('below-historical-id')
    expect(ownerName(tree, ROOT, 'one-shot-id' as SessionId)).toBe('one-shot-id')
    expect(ownerName({ [ROOT]: tree[ROOT]! }, ROOT, CHECKER)).toBe(CHECKER)
    expect(ownerName({ ...tree, [ROOT]: { state: 'loading', error: null, values: {} } }, ROOT, REVIEWER)).toBe(REVIEWER)
    expect(ownerName(tree, ROOT, 'unknown-id' as SessionId)).toBe('unknown-id')
  })

  it('searches each Session once when catalogs list a member again', () => {
    const repeated = catalogs({
      [ROOT]: [
        { id: REVIEWER, createdAt: 1, mode: 'continuable', label: 'Review', name: 'reviewer' },
        { id: REVIEWER, createdAt: 2, mode: 'continuable', label: 'Review', name: 'again' },
      ],
      [REVIEWER]: [{ id: ROOT, createdAt: 3, mode: 'continuable', label: 'Root', name: 'cycle' }],
    })
    expect(ownerName(repeated, ROOT, REVIEWER)).toBe('reviewer')
    expect(ownerName(repeated, ROOT, CHECKER)).toBe(CHECKER)
  })
})
