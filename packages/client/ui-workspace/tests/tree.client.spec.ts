import { describe, expect, it } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {
  SessionPendingInteraction, SessionStatus, SessionStatusSnapshot,
} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  type ArchivedFilter,
  deriveFlat, deriveGroups, deriveSearchResults, orderByRecency, owningGroupKey, owningParentFolder,
  pinCurrentBlank, reconcileManualOrder, sessionMemberIds, visibleSessionIds, workspaceLabel, UNGROUPED_KEY,
} from '../src/client/tree.ts'
import { createWorkspaceViewStore } from '../src/client/stores.ts'

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
const summary = (id: string, updatedAt: number, cwd?: string): SessionSummary => ({
  id: sid(id), title: id, displayTitle: id, running: false, blank: false,
  updatedAt, ...(cwd === undefined ? {} : { cwd }), retainedBy: {},
})
const list = (...items: SessionSummary[]): SessionListState => ({
  ids: items.map(item => item.id),
  byId: Object.fromEntries(items.map(item => [item.id, item])),
  phase: 'ready', projectionsBySession: {},
})
const catalog = (...ids: string[]): SessionProjectionSnapshot => ({
  values: { subagentCatalog: ids.map(id => ({
    id: sid(id), mode: 'continuable', label: id,
    createdAt: 1,
  })) },
  state: 'ready',
  error: null,
})
const withMain = (state: SessionListState, id: SessionId): SessionListState => ({
  ...state,
  byId: {
    ...state.byId,
    [id]: { ...state.byId[id]!, retainedBy: { ...state.byId[id]!.retainedBy, mainView: 1 } },
  },
})
const workspace = (id: string, sessionIds: string[], title = id): WorkspaceView => ({
  workspaceId: wid(id), path: `/projects/${id}`, title,
  sessionIds: sessionIds.map(sid), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
const view = (expandedGroups: readonly string[] = [], ungroupedOrder?: readonly string[]) => ({
  expandedGroups,
  ...(ungroupedOrder === undefined ? {} : { ungroupedOrder }),
})
const noArchive: readonly SessionId[] = []
const noAttention: SessionStatusSnapshot = new Map()
const status = (
  pendingInteraction: SessionPendingInteraction | undefined,
  overrides: Partial<SessionStatus> = {},
): SessionStatus => ({ running: undefined, pendingInteraction, completionUnread: false, ...overrides })
const archived = (...ids: string[]): readonly SessionId[] => ids.map(sid)
const rowState = (options: {
  pinned?: readonly string[]
  archived?: readonly string[]
  archivedFilter?: ArchivedFilter
} = {}) => ({
  pinnedSessionIds: (options.pinned ?? []).map(sid),
  archivedSessionIds: (options.archived ?? []).map(sid),
  archivedFilter: options.archivedFilter ?? 'default' as const,
})
const noRows = rowState()

describe('owningGroupKey', () => {
  it('returns the owning Workspace id or the Ungrouped key', () => {
    const workspaces = [workspace('first', ['owned'])]
    expect(owningGroupKey(workspaces, sid('owned'))).toBe('first')
    expect(owningGroupKey(workspaces, sid('loose'))).toBe(UNGROUPED_KEY)
  })
})

describe('Session ordering', () => {
  it.each(['workspace', 'ungrouped', 'flat'] as const)('keeps the current New Session before pins in %s', (mode) => {
    const sessions = withMain(list(
      summary('pin', 30),
      summary('ordinary', 20),
      { ...summary('blank', 0), blank: true },
    ), sid('blank'))
    const order = pinCurrentBlank(sessions.ids, sid('blank'))
    const state = rowState({ pinned: ['pin'] })
    const rows = mode === 'flat'
      ? deriveFlat(sessions, order, state, noAttention)
      : deriveGroups(
        sessions,
        mode === 'workspace' ? [workspace('alpha', order)] : [],
        state,
        noAttention,
        view([mode === 'workspace' ? 'alpha' : UNGROUPED_KEY], order),
      )[0]!.sessions
    expect(rows.map(row => row.id)).toEqual([sid('blank'), sid('pin'), sid('ordinary')])
  })

  it('orders known members by recency with a stable identity tie-break', () => {
    const summaries = list(summary('tie-b', 20), summary('older', 10), summary('tie-a', 20)).byId
    expect(orderByRecency(
      [sid('unknown'), sid('tie-b'), sid('older'), sid('tie-a')],
      summaries,
    )).toEqual([sid('tie-a'), sid('tie-b'), sid('older')])
  })

  it('orders each partition strictly by Session recency, independent of pin-array order', () => {
    const sessions = list(summary('stale-pin', 10), summary('fresh-pin', 30), summary('plain', 20))
    const state = {
      ...noRows,
      pinnedSessionIds: [
        sid('stale-pin'),
        sid('fresh-pin'),
      ],
    }
    const order = orderByRecency(sessions.ids, sessions.byId)
    expect(deriveFlat(sessions, order, state, noAttention).map(row => row.id))
      .toEqual([sid('fresh-pin'), sid('stale-pin'), sid('plain')])
  })

  it('reconciles retained manual slots and appends newly known members by recency', () => {
    const summaries = list(summary('kept', 1), summary('newer', 30), summary('older', 20)).byId
    expect(reconcileManualOrder(
      [sid('saved-without-summary'), sid('kept'), sid('newer'), sid('older'), sid('new-without-summary')],
      ['departed', 'saved-without-summary', 'kept'],
      summaries,
    )).toEqual([
      sid('saved-without-summary'), sid('kept'), sid('newer'), sid('older'),
    ])
  })

  it('supplements only missing account members with pins first and archives last', () => {
    const sessions = list(
      summary('saved-archive', 80), summary('saved-plain', 1), summary('saved-pin', 2),
      summary('pin-a', 5), summary('pin-b', 6), summary('new-plain', 100),
      summary('archive-newer', 90), summary('archive-older', 10), summary('both', 50),
      summary('outside', 200),
    )
    const members = [...sessions.ids.filter(id => id !== 'outside'), sid('pending-pin')]
    const saved = ['saved-archive', 'saved-plain', 'saved-pin']
    const state = rowState({
      pinned: ['outside', 'pin-b', 'saved-pin', 'both', 'pin-a', 'pending-pin'],
      archived: ['archive-older', 'saved-archive', 'both', 'archive-newer'],
    })
    const complete = reconcileManualOrder(members, saved, sessions.byId, state)
    expect(complete).toEqual([
      'pin-b', 'pin-a', 'saved-archive', 'saved-plain', 'saved-pin', 'new-plain',
      'archive-newer', 'both', 'archive-older',
    ])
    expect(reconcileManualOrder(members, complete, sessions.byId, state)).toEqual(complete)
    expect(saved).toEqual(['saved-archive', 'saved-plain', 'saved-pin'])
  })

  it('inserts new forks before their saved source while preserving saved positions', () => {
    const sessions = list(
      summary('source', 1), summary('other', 2),
      { ...summary('older-fork', 3), parentId: sid('source') },
      { ...summary('newer-fork', 4), parentId: sid('source') },
    )
    const order = reconcileManualOrder(sessions.ids, ['other', 'source'], sessions.byId)
    expect(order).toEqual(['other', 'older-fork', 'newer-fork', 'source'])
    expect(reconcileManualOrder(sessions.ids, ['source', 'other', 'older-fork', 'newer-fork'], sessions.byId))
      .toEqual(['source', 'other', 'older-fork', 'newer-fork'])
  })

  it('places nested new forks before their parents even when catalog recency differs', () => {
    const sessions = list(
      summary('source', 1), summary('other', 2),
      { ...summary('parent', 4), parentId: sid('source') },
      { ...summary('child', 3), parentId: sid('parent') },
    )
    expect(reconcileManualOrder(sessions.ids, ['source', 'other'], sessions.byId))
      .toEqual(['child', 'parent', 'source', 'other'])
  })

  it('appends forks with absent or self-referencing parents without duplicating rows', () => {
    const sessions = list(
      summary('source', 1),
      { ...summary('orphan', 3), parentId: sid('absent') },
      { ...summary('self', 2), parentId: sid('self') },
    )
    expect(reconcileManualOrder(sessions.ids, ['source'], sessions.byId))
      .toEqual(['source', 'orphan', 'self'])
  })

  it.each(['workspace', 'ungrouped', 'flat'] as const)('keeps forks of pinned sources in the ordinary %s section', (mode) => {
    const sessions = list(
      summary('source', 1), summary('other-pin', 2), summary('ordinary', 3),
      { ...summary('fork', 4), parentId: sid('source') },
    )
    const state = rowState({ pinned: ['source', 'other-pin'] })
    const order = reconcileManualOrder(sessions.ids, ['source', 'other-pin', 'ordinary'], sessions.byId, state)
    const rows = mode === 'flat'
      ? deriveFlat(sessions, order, state, noAttention)
      : deriveGroups(
        sessions, mode === 'workspace' ? [workspace('alpha', order)] : [], state, noAttention,
        view([mode === 'workspace' ? 'alpha' : UNGROUPED_KEY], order),
      )[0]!.sessions
    expect(rows.map(row => row.id)).toEqual(['source', 'other-pin', 'fork', 'ordinary'])
  })

  it('keeps archive filtering out of complete flat membership', () => {
    const sessions = list(summary('plain', 1), summary('archived', 2))
    const members = sessionMemberIds(sessions)
    expect(members).toEqual(['plain', 'archived'])
    expect(deriveFlat(sessions, members, rowState({ archived: ['archived'] }), noAttention).map(row => row.id))
      .toEqual(['plain'])
    expect(deriveFlat(sessions, members, rowState({ archived: ['archived'], archivedFilter: 'only' }), noAttention)
      .map(row => row.id)).toEqual(['archived'])
    expect(members).toEqual(['plain', 'archived'])
  })

  it('pins only the selected blank without changing the base order', () => {
    expect(pinCurrentBlank([sid('newer'), sid('blank'), sid('older')], sid('blank')))
      .toEqual([sid('blank'), sid('newer'), sid('older')])
    expect(pinCurrentBlank([sid('newer'), sid('older')], undefined))
      .toEqual([sid('newer'), sid('older')])
  })
})

describe('deriveGroups', () => {
  it('keeps caller-supplied Workspace and sessionIds order', () => {
    const sessions = list(summary('newer', 20), summary('older', 10))
    const workspaces = [workspace('first', ['older', 'newer']), workspace('empty', [])]
    const groups = deriveGroups(sessions, workspaces, noRows, noAttention, view(['first']))
    expect(groups.map(group => group.key)).toEqual(['first', 'empty'])
    expect(groups[0]!.sessions.map(session => session.id)).toEqual([sid('older'), sid('newer')])
  })

  it('projects pending-interaction state into grouped and flat rows', () => {
    const awaiting = { ...summary('awaiting', 10), running: true }
    const sessions = list(awaiting)
    const attention: SessionStatusSnapshot = new Map([[
      awaiting.id,
      status({ key: 'question:1', kind: 'plan-review', sessionId: awaiting.id } as SessionPendingInteraction, { running: true }),
    ]])
    const grouped = deriveGroups(
      sessions, [workspace('project', ['awaiting'])], noRows, attention, view(['project']),
    )
    expect(grouped[0]!.sessions[0]).toMatchObject({ pendingInteraction: 'plan-review', running: true })
    expect(deriveFlat(sessions, visibleSessionIds(sessions, noArchive, 'default'), noRows, attention)[0])
      .toMatchObject({ pendingInteraction: 'plan-review', running: true })
  })

  it.each(['approval', 'question'] as const)(
    'projects the %s pending-interaction kind',
    (kind) => {
      const awaiting = summary(kind, 10)
      const attention: SessionStatusSnapshot = new Map([[
        awaiting.id,
        status({ key: `${kind}:1`, kind, sessionId: awaiting.id } as SessionPendingInteraction),
      ]])

      expect(deriveFlat(list(awaiting), [awaiting.id], noRows, attention)[0]?.pendingInteraction).toBe(kind)
    },
  )

  it('puts only real unaccounted Sessions in the trailing Ungrouped group', () => {
    const sessions = list(summary('owned', 1, '/projects/first'), summary('loose', 9, '/other'))
    const groups = deriveGroups(
      sessions, [workspace('first', ['owned'])], noRows, noAttention, view([UNGROUPED_KEY]),
    )
    expect(groups.map(group => group.key)).toEqual(['first', UNGROUPED_KEY])
    expect(groups[1]!.sessions.map(session => session.id)).toEqual([sid('loose')])
  })

  it('applies stored Ungrouped order and appends new loose Sessions by recency', () => {
    const sessions = list(summary('one', 3), summary('two', 2), summary('new', 4))
    const groups = deriveGroups(
      sessions,
      [],
      noRows,
      noAttention,
      view([UNGROUPED_KEY], ['two', 'stale', 'two']),
    )
    expect(groups[0]!.sessions.map(session => session.id)).toEqual([
      sid('two'), sid('new'), sid('one'),
    ])
  })

  it('shows only the current blank session in its Workspace count and tree', () => {
    const currentBlank = { ...summary('current-blank', 5), blank: true, retainedBy: { mainView: 1 } }
    const staleBlank = { ...summary('stale-blank', 4), blank: true }
    const real = summary('shown', 3)
    const sessions = list(real, currentBlank, staleBlank)
    const groups = deriveGroups(
      sessions, [workspace('first', ['shown', 'current-blank', 'stale-blank'])],
      noRows, noAttention, view(['first']),
    )
    expect(groups[0]!.sessions.map(session => session.id)).toEqual([currentBlank.id, real.id])
    const blankNode = groups[0]!.sessions.find(session => session.id === currentBlank.id)!
    // The stored placeholder title stays canonical; the renderer swaps in
    // the localized New Session label via the blank flag.
    expect(blankNode.title).toBe('')
    expect(blankNode.blank).toBe(true)
    expect(groups[0]!.sessions.find(session => session.id === real.id)!.blank).toBe(false)
    expect(groups[0]!.sessionCount).toBe(2)
    // A non-current blank stray never surfaces an Ungrouped bucket either.
    const strayGroups = deriveGroups(
      list({ ...summary('stray', 2), blank: true }),
      [workspace('first', [])], noRows, noAttention, view(),
    )
    expect(strayGroups.map(group => group.key)).toEqual(['first'])
  })

  it('projects the completion reminder into session and search rows (absent = false)', () => {
    const done = summary('done', 3)
    const plain = summary('plain', 2)
    const sessions = list(done, plain)
    const statuses: SessionStatusSnapshot = new Map([[done.id, status(undefined, { completionUnread: true })]])
    const groups = deriveGroups(
      sessions, [workspace('first', ['done', 'plain'])], noRows, statuses, view(['first']),
    )
    const doneNode = groups[0]!.sessions.find(session => session.id === done.id)!
    const plainNode = groups[0]!.sessions.find(session => session.id === plain.id)!
    expect(doneNode.completed).toBe(true)
    expect(plainNode.completed).toBe(false)
    expect(deriveFlat(sessions, visibleSessionIds(sessions, noArchive, 'default'), noRows, statuses)
      .find(node => node.id === done.id)!.completed).toBe(true)
    const search = deriveSearchResults(
      sessions, [workspace('first', ['done', 'plain'])], 'done', noArchive, 'default',
      statuses, { items: [], hasMore: false }, 10,
    )
    expect(search.items[0]?.completed).toBe(true)
  })

  it('hides subagent-origin sessions and reads direct running counts from catalogs', () => {
    const parent = summary('parent', 1)
    const subagent = {
      ...summary('subagent', 3), parentId: parent.id, origin: 'subagent' as const, running: true,
    }
    const grandchild = {
      ...summary('grandchild', 4), parentId: subagent.id, origin: 'subagent' as const, running: true,
    }
    const fork = { ...summary('fork', 2), parentId: subagent.id }
    const forkChild = {
      ...summary('fork-child', 5), parentId: fork.id, origin: 'subagent' as const, running: true,
    }
    const sessions = {
      ...withMain(list(parent, fork, subagent, grandchild, forkChild), subagent.id),
      projectionsBySession: {
        [parent.id]: catalog(
          'subagent',
          'inactive-child',
        ),
        [fork.id]: catalog('fork-child'),
        [subagent.id]: catalog('grandchild'),
      },
    }
    const groups = deriveGroups(
      sessions,
      [workspace('first', ['parent', 'fork', 'subagent', 'grandchild', 'fork-child'])],
      noRows,
      noAttention,
      view(['first']),
    )

    expect(groups[0]!.sessions.map(node => node.id)).toEqual([parent.id, fork.id])
    expect(groups[0]!.sessionCount).toBe(2)
    expect(groups[0]!.sessions[0]).toMatchObject({ running: false, runningSubagentCount: 1 })
    expect(groups[0]!.sessions[1]).toMatchObject({ running: false, runningSubagentCount: 1 })
    expect(deriveFlat(sessions, visibleSessionIds(sessions, noArchive, 'default'), noRows, noAttention)
      .map(node => [node.id, node.runningSubagentCount])).toEqual([
      [parent.id, 1], [fork.id, 1],
    ])
    expect(deriveSearchResults(
      sessions, [workspace('first', ['parent', 'fork'])], 'parent', noArchive, 'default',
      noAttention, { items: [], hasMore: false }, 10,
    ).items[0]).toMatchObject({ id: parent.id, runningSubagentCount: 1 })
  })

  it('uses current child status only for members of the direct parent catalog', () => {
    const parent = summary('parent', 1)
    const child = { ...summary('child', 2), running: false }
    const stopped = { ...summary('stopped', 3), running: true }
    const unrelated = { ...summary('unrelated', 4), parentId: parent.id, running: true }
    const sessions = {
      ...list(parent, child, stopped, unrelated),
      projectionsBySession: {
        [parent.id]: catalog('child', 'stopped'),
      },
    }
    const statuses = new Map<SessionId, SessionStatus>([
      [child.id, status(undefined, { running: true })],
      [stopped.id, status(undefined, { running: false })],
      [unrelated.id, status(undefined, { running: true })],
    ])
    const counts = (snapshot: SessionStatusSnapshot) => [
      deriveGroups(sessions, [workspace('first', ['parent'])], noRows, snapshot, view(['first']))[0]!.sessions[0]!.runningSubagentCount,
      deriveFlat(sessions, [parent.id], noRows, snapshot)[0]!.runningSubagentCount,
      deriveSearchResults(sessions, [], 'parent', noArchive, 'default', snapshot, { items: [], hasMore: false }, 10).items[0]!.runningSubagentCount,
    ]
    expect(counts(statuses)).toEqual([1, 1, 1])
    statuses.set(child.id, status(undefined, { running: false }))
    expect(counts(statuses)).toEqual([0, 0, 0])
  })

  it('ignores fork lineage and sorts every ungrouped session as a top-level row', () => {
    const parent = summary('parent', 1)
    const oldChild = { ...summary('old-child', 10), parentId: parent.id }
    const newChild = { ...summary('new-child', 20), parentId: parent.id }
    const tieB = { ...summary('tie-b', 20), parentId: parent.id }
    const tieA = { ...summary('tie-a', 20), parentId: parent.id }
    const self = { ...summary('self', 2), parentId: sid('self') }
    const orphan = { ...summary('orphan', 3), parentId: sid('missing') }
    const cycleA = { ...summary('cycle-a', 4), parentId: sid('cycle-b') }
    const cycleB = { ...summary('cycle-b', 5), parentId: sid('cycle-a') }
    const groups = deriveGroups(
      list(parent, oldChild, newChild, tieB, tieA, self, orphan, cycleA, cycleB),
      [],
      noRows,
      noAttention,
      { expandedGroups: [UNGROUPED_KEY] },
    )

    expect(groups).toHaveLength(1)
    expect(groups[0]!.sessions.map(node => node.id)).toEqual([
      newChild.id, tieA.id, tieB.id, oldChild.id,
      cycleB.id, cycleA.id, orphan.id, self.id, parent.id,
    ])

    // Equal timestamps use ids as a deterministic tiebreak in either input order.
    expect(deriveGroups(
      list(summary('tie-a', 1), summary('tie-b', 1)), [], noRows, noAttention, view([UNGROUPED_KEY]),
    )[0]!
      .sessions.map(node => node.id)).toEqual([sid('tie-a'), sid('tie-b')])
  })

  it('tolerates Workspace membership arriving before its Session summary', () => {
    const partial: SessionListState = {
      ...list(),
      ids: [sid('present')],
      byId: { [sid('present')]: summary('present', 1) },
    }
    const groups = deriveGroups(
      partial, [workspace('project', ['missing', 'present'])], noRows, noAttention, view(['project']),
    )
    expect(groups[0]!.sessions.map(node => node.id)).toEqual([sid('present')])
  })

  it('hides archived sessions from workspace groups and Ungrouped', () => {
    const kept = summary('kept', 1, '/projects/first')
    const gone = summary('gone', 2, '/projects/first')
    const looseGone = summary('loose-gone', 3, '/other')
    const sessions = list(kept, gone, looseGone)
    const groups = deriveGroups(
      sessions, [workspace('first', ['kept', 'gone'])], rowState({ archived: ['gone', 'loose-gone'] }),
      noAttention, view(['first', UNGROUPED_KEY]),
    )
    // The archived member drops from its group AND the archived stray never
    // surfaces an Ungrouped bucket; counts follow the visible rows.
    expect(groups.map(group => group.key)).toEqual(['first'])
    expect(groups[0]!.sessions.map(node => node.id)).toEqual([kept.id])
    expect(groups[0]!.sessionCount).toBe(1)
  })

  it('leads expanded groups with pinned rows in the supplied order', () => {
    const sessions = list(summary('a', 4), summary('b', 3), summary('c', 2), summary('d', 1))
    const groups = deriveGroups(
      sessions, [workspace('first', ['a', 'c', 'b', 'd'])],
      rowState({ pinned: ['c', 'b'] }),
      noAttention, view(['first']),
    )
    // c precedes b per the supplied order even though b updated more recently:
    // the pinned block never re-sorts, so manual pinned-to-pinned drags hold.
    expect(groups[0]!.sessions.map(node => [node.id, node.pinned])).toEqual([
      [sid('c'), true],
      [sid('b'), true],
      [sid('a'), false],
      [sid('d'), false],
    ])
  })

  it('keeps shown archived rows in place and never sections an archived pin', () => {
    const sessions = list(summary('top', 3), summary('mid', 2), summary('low', 1))
    const groups = deriveGroups(
      sessions, [workspace('first', ['top', 'mid', 'low'])],
      rowState({ pinned: ['mid'], archived: ['mid'], archivedFilter: 'show' }),
      noAttention, view(['first']),
    )
    expect(groups[0]!.sessions.map(node => [node.id, node.pinned, node.archived])).toEqual([
      [sid('top'), false, false],
      [sid('mid'), false, true],
      [sid('low'), false, false],
    ])
  })

  it('drops Workspaces without visible members under the only filter', () => {
    const sessions = list(summary('stored', 2), summary('live', 1))
    const groups = deriveGroups(
      sessions, [workspace('full', ['stored', 'live']), workspace('empty', ['live'])],
      rowState({ archived: ['stored'], archivedFilter: 'only' }),
      noAttention, view(['full', 'empty']),
    )
    expect(groups.map(group => group.key)).toEqual(['full'])
    expect(groups[0]!.sessions.map(node => node.id)).toEqual([sid('stored')])
  })

  it.each(['default', 'show'] as const)('keeps memberless Workspaces under the %s filter', (archivedFilter) => {
    const sessions = list(summary('stored', 1))
    const groups = deriveGroups(
      sessions, [workspace('empty', ['stored'])],
      rowState({ archived: ['stored'], archivedFilter }),
      noAttention, view(['empty']),
    )
    expect(groups.map(group => [group.key, group.sessionCount])).toEqual([
      ['empty', archivedFilter === 'show' ? 1 : 0],
    ])
  })

  it('marks selected Workspace and Ungrouped sessions without relying on an Intent', () => {
    const owned = summary('owned', 1)
    const loose = summary('loose', 2)
    const ws = workspace('project', ['owned'])
    const ownedGroups = deriveGroups(
      withMain(list(owned, loose), owned.id), [ws], noRows, noAttention, view(),
    )
    expect(ownedGroups.find(group => group.key === 'project')!.containsCurrent).toBe(true)
    const looseGroups = deriveGroups(
      withMain(list(owned, loose), loose.id), [ws], noRows, noAttention, view(),
    )
    expect(looseGroups.find(group => group.key === UNGROUPED_KEY)!.containsCurrent).toBe(true)
  })
})

describe('deriveFlat', () => {
  it('renders ordinary forks in the supplied order regardless of timestamps', () => {
    const parent = summary('parent', 10)
    const child = { ...summary('child', 30), parentId: parent.id }
    const tieB = summary('tie-b', 20)
    const tieA = summary('tie-a', 20)
    const rows = deriveFlat(list(parent, child, tieB, tieA), [parent.id, tieA.id, child.id, tieB.id], noRows, noAttention)
    expect(rows.map(row => row.id)).toEqual([parent.id, tieA.id, child.id, tieB.id])
  })

  it('hides subagent-origin rows but keeps ordinary forks', () => {
    const parent = summary('parent', 1)
    const fork = { ...summary('fork', 2), parentId: parent.id }
    const subagent = { ...summary('subagent', 3), parentId: parent.id, origin: 'subagent' as const }
    const ids = visibleSessionIds(withMain(list(parent, fork, subagent), subagent.id), noArchive, 'default')
    expect(ids).toEqual([parent.id, fork.id])
  })

  it('tolerates ids whose summary has not landed yet', () => {
    const partial: SessionListState = { ...list(summary('present', 1)), ids: [sid('ghost'), sid('present')] }
    expect(visibleSessionIds(partial, noArchive, 'default')).toEqual([sid('present')])
  })

  it('shows only the current blank session and excludes blanks from search', () => {
    const currentBlank = { ...summary('current-blank', 9), blank: true, retainedBy: { mainView: 1 } }
    const staleBlank = { ...summary('stale-blank', 8), blank: true }
    const sessions = list(currentBlank, summary('real', 1), staleBlank)
    const rows = deriveFlat(sessions, visibleSessionIds(sessions, noArchive, 'default'), noRows, noAttention)
    expect(rows.map(row => row.id)).toEqual([currentBlank.id, sid('real')])
    expect(rows.map(row => row.title)).toEqual(['', 'real'])
    expect(rows.map(row => row.blank)).toEqual([true, false])
  })

  it('hides archived sessions in flat mode', () => {
    const kept = summary('kept', 1)
    const gone = summary('gone', 2)
    expect(visibleSessionIds(list(kept, gone), archived('gone'), 'default')).toEqual([kept.id])
  })

  it('keeps archived sessions visible while the view shows them', () => {
    const kept = summary('kept', 1)
    const gone = summary('gone', 2)
    expect(visibleSessionIds(list(kept, gone), archived('gone'), 'show')).toEqual([kept.id, gone.id])
  })

  it('restricts the view to archived sessions under the only filter', () => {
    const kept = summary('kept', 1)
    const gone = summary('gone', 2)
    expect(visibleSessionIds(list(kept, gone), archived('gone'), 'only')).toEqual([gone.id])
  })

  it('leads the flat list with pinned rows in the supplied order', () => {
    const sessions = list(summary('a', 2), summary('b', 2), summary('c', 2), summary('d', 3))
    const rows = deriveFlat(
      sessions, [sid('b'), sid('a'), sid('c'), sid('d')], rowState({ pinned: ['c', 'b', 'a'] }), noAttention,
    )
    expect(rows.map(row => [row.id, row.pinned])).toEqual([
      [sid('b'), true], [sid('a'), true], [sid('c'), true], [sid('d'), false],
    ])
  })
})

describe('deriveSearchResults archive filtering', () => {
  it('archived sessions never match — not by title and not via a backend content hit', () => {
    const hit = summary('hit', 2)
    hit.title = hit.displayTitle = 'Needle row'
    const gone = summary('gone', 1)
    gone.title = gone.displayTitle = 'Needle archived'
    const result = deriveSearchResults(
      list(hit, gone),
      [],
      'needle',
      archived('gone'),
      'default',
      noAttention,
      { items: [{ sessionId: gone.id, snippet: 'needle body' }], hasMore: false },
      10,
    )
    expect(result.items.map(item => item.id)).toEqual([hit.id])
  })

  it('matches archived sessions and flags them while the view shows them', () => {
    const gone = summary('gone', 1)
    gone.title = gone.displayTitle = 'Needle archived'
    const result = deriveSearchResults(
      list(gone), [], 'needle', archived('gone'), 'show', noAttention, { items: [], hasMore: false }, 10,
    )
    expect(result.items.map(item => [item.id, item.archived])).toEqual([[gone.id, true]])
  })

  it('matches only archived sessions under the only filter', () => {
    const hit = summary('hit', 2)
    hit.title = hit.displayTitle = 'Needle row'
    const gone = summary('gone', 1)
    gone.title = gone.displayTitle = 'Needle archived'
    const result = deriveSearchResults(
      list(hit, gone), [], 'needle', archived('gone'), 'only', noAttention, { items: [], hasMore: false }, 10,
    )
    expect(result.items.map(item => [item.id, item.archived])).toEqual([[gone.id, true]])
  })
})

describe('deriveSearchResults', () => {
  it('merges local title/Workspace matches before ranked content hits and enriches duplicates', () => {
    const titleHit = summary('title-hit', 30, '/projects/a')
    titleHit.title = titleHit.displayTitle = 'Needle title'
    const workspaceHit = summary('workspace-hit', 20, '/projects/b')
    workspaceHit.title = workspaceHit.displayTitle = 'Ordinary title'
    const contentHit = summary('content-hit', 10, '/projects/c')
    const sessions = list(titleHit, workspaceHit, contentHit)
    const result = deriveSearchResults(
      sessions,
      [
        workspace('a', ['title-hit'], 'Alpha'),
        workspace('b', ['workspace-hit'], 'Needle Workspace'),
        workspace('duplicate-owner', ['title-hit'], 'Ignored duplicate owner'),
      ],
      ' NEEDLE ',
      noArchive,
      'default',
      new Map([[titleHit.id, status({
        key: 'question:1', kind: 'plan-review', sessionId: titleHit.id,
      } as SessionPendingInteraction)]]),
      {
        items: [
          { sessionId: contentHit.id, snippet: 'body needle excerpt' },
          { sessionId: contentHit.id, snippet: 'ignored duplicate excerpt' },
          { sessionId: titleHit.id, snippet: 'title session body excerpt' },
          { sessionId: sid('unknown'), snippet: 'not in session.list' },
        ],
        hasMore: false,
      },
      10,
    )

    expect(result).toEqual({
      items: [
        {
          id: titleHit.id,
          title: 'Needle title',
          workspace: 'Alpha',
          running: false,
          runningSubagentCount: 0,
          pendingInteraction: 'plan-review',
          completed: false,
          archived: false,
          snippet: 'title session body excerpt',
        },
        {
          id: workspaceHit.id,
          title: 'Ordinary title',
          workspace: 'Needle Workspace',
          running: false,
          runningSubagentCount: 0,
          completed: false,
          archived: false,
        },
        {
          id: contentHit.id,
          title: 'content-hit',
          workspace: 'c',
          running: false,
          runningSubagentCount: 0,
          completed: false,
          archived: false,
          snippet: 'body needle excerpt',
        },
      ],
      hasMore: false,
    })
  })

  it('excludes blank sessions from search regardless of query or content hits', () => {
    const currentBlank = { ...summary('opaque-current', 5), blank: true }
    const staleBlank = { ...summary('new session stale', 4), blank: true }
    const sessions = list(currentBlank, staleBlank)
    // Blank placeholders never match — not their localized-display title, not
    // their id, and not even a backend content hit naming them.
    const result = deriveSearchResults(
      sessions,
      [workspace('first', ['opaque-current', 'new session stale'])],
      'new session',
      noArchive,
      'default',
      noAttention,
      {
        items: [
          { sessionId: staleBlank.id, snippet: 'stale body' },
          { sessionId: currentBlank.id, snippet: 'current body' },
        ],
        hasMore: false,
      },
      10,
    )
    expect(result.items).toEqual([])
  })

  it('uses the supplied cap and preserves either local overflow or backend hasMore', () => {
    const rows = Array.from({ length: 5 }, (_, index) => {
      const item = summary(`s-${String(index).padStart(2, '0')}`, index)
      item.title = item.displayTitle = `Needle ${String(index)}`
      return item
    })
    const overflow = deriveSearchResults(
      list(...rows),
      [],
      'needle',
      noArchive,
      'default',
      noAttention,
      { items: [], hasMore: false },
      3,
    )
    expect(overflow.items).toHaveLength(3)
    expect(overflow.hasMore).toBe(true)

    const backendMore = deriveSearchResults(
      list(summary('body', 1)),
      [],
      'needle',
      noArchive,
      'default',
      noAttention,
      { items: [{ sessionId: sid('body'), snippet: 'needle' }], hasMore: true },
      3,
    )
    expect(backendMore.items).toHaveLength(1)
    expect(backendMore.hasMore).toBe(true)
    expect(deriveSearchResults(list(), [], '  ', noArchive, 'default', noAttention, { items: [], hasMore: true }, 3))
      .toEqual({ items: [], hasMore: false })
  })
})

describe('createWorkspaceViewStore', () => {
  it('stores view preferences and selects Manual when saving a drag order', () => {
    const store = createWorkspaceViewStore().create()
    expect(store.getSnapshot().groupBy).toBe('workspace')
    expect(store.getSnapshot().orderBy).toBe('updated')
    store.actions.setGroupBy('flat')
    store.actions.setOrderBy('updated', {})
    store.actions.setGroupExpanded('alpha', true)
    store.actions.setSessionOrder('alpha', ['one', 'two'], {})
    expect(store.getSnapshot().groupBy).toBe('flat')
    expect(store.getSnapshot()).toMatchObject({
      orderBy: 'manual',
      groupExpansion: { alpha: true },
      sessionOrderByAccount: { alpha: ['one', 'two'] },
    })
  })

  it('retains positions when reselecting Manual and snapshots the supplied order on mode switches', () => {
    const store = createWorkspaceViewStore().create()
    store.actions.setSessionOrder('alpha', ['two', 'one'], {})
    store.actions.setOrderBy('manual', {})
    expect(store.getSnapshot()).toMatchObject({ orderBy: 'manual', sessionOrderByAccount: { alpha: ['two', 'one'] } })
    store.actions.setOrderBy('updated', {})
    expect(store.getSnapshot()).toMatchObject({ orderBy: 'updated', sessionOrderByAccount: {} })
    store.actions.setOrderBy('manual', { alpha: ['one', 'two'] })
    expect(store.getSnapshot().sessionOrderByAccount).toEqual({ alpha: ['one', 'two'] })
  })

  it('snapshots every account when a recency drag selects Manual', () => {
    const store = createWorkspaceViewStore().create()
    store.actions.setSessionOrder('alpha', ['two', 'one'], {
      alpha: ['one', 'two'],
      beta: ['three'],
    })
    expect(store.getSnapshot()).toMatchObject({
      orderBy: 'manual',
      sessionOrderByAccount: { alpha: ['two', 'one'], beta: ['three'] },
    })
  })

  it('ignores reconciliation writes outside Manual', () => {
    const store = createWorkspaceViewStore().create()
    store.actions.syncSessionOrders({ alpha: ['one'] })
    expect(store.getSnapshot().sessionOrderByAccount).toEqual({})
  })

  it('saves Pin positions and complete accounts without changing the selected ordering mode', () => {
    const store = createWorkspaceViewStore().create()
    store.actions.pinSessionOrder('old', ['alpha'], {
      members: {
        alpha: [sid('new'), sid('archive'), sid('old')],
        beta: [sid('other-archive')],
      },
      summaries: list(summary('new', 3), summary('old', 2), summary('archive', 1), summary('other-archive', 0)).byId,
      rowState: rowState({ archived: ['archive', 'other-archive'] }),
    })
    expect(store.getSnapshot()).toMatchObject({
      orderBy: 'updated',
      sessionOrderByAccount: { alpha: ['old', 'new', 'archive'], beta: ['other-archive'] },
    })
    store.actions.setOrderBy('manual', { alpha: ['new', 'old', 'archive'], beta: ['other-archive'] })
    store.actions.setSessionOrder('alpha', ['old', 'new', 'archive'], {
      alpha: ['new', 'old', 'archive'], beta: ['other-archive', 'missing-archive'],
    })
    expect(store.getSnapshot().sessionOrderByAccount)
      .toEqual({ alpha: ['old', 'new', 'archive'], beta: ['other-archive', 'missing-archive'] })
  })

  it('uses current saved positions when a Pin source carries an earlier order', () => {
    const store = createWorkspaceViewStore().create()
    const source = {
      members: { alpha: [sid('a'), sid('b'), sid('c')] },
      summaries: list(summary('a', 3), summary('b', 2), summary('c', 1)).byId,
      rowState: noRows,
    }
    store.actions.setSessionOrder('alpha', ['b', 'a', 'c'], {})
    store.actions.pinSessionOrder('c', ['alpha'], source)
    expect(store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['c', 'b', 'a'])
  })

  it('removes view state outside the retained Workspace key set', () => {
    const store = createWorkspaceViewStore().create()
    store.actions.setGroupExpanded('', true)
    store.actions.setGroupExpanded('alpha', true)
    store.actions.setGroupExpanded('deleted', true)
    store.actions.setSessionOrder('alpha', ['alpha-session'], {})
    store.actions.setSessionOrder('deleted', ['deleted-session'], {})

    store.actions.retainAccountKeys(['', 'alpha'])

    const snapshot = store.getSnapshot()
    expect(snapshot.groupExpansion).toEqual({ '': true, alpha: true })
    expect(snapshot.sessionOrderByAccount).toEqual({ alpha: ['alpha-session'] })
  })
})

describe('workspaceLabel', () => {
  it('uses the Ungrouped fallback and extracts POSIX and Windows basenames', () => {
    expect(workspaceLabel(undefined)).toBe('')
    expect(workspaceLabel('')).toBe('')
    expect(workspaceLabel('/projects/demo/')).toBe('demo')
    expect(workspaceLabel('C:\\projects\\demo\\')).toBe('demo')
    expect(workspaceLabel('/')).toBe('/')
  })
})

describe('parent folder membership', () => {
  it.each([
    ['/git/app', ['/git'], '/git'],
    ['/git', ['/git/'], undefined],
    ['/git-other/app', ['/git'], undefined],
    ['/git/team/app', ['/git', '/git/team'], '/git/team'],
    ['/git/team/app', ['/git/team', '/git'], '/git/team'],
    ['/git/app', ['/'], '/'],
    ['/git/app', [], undefined],
    [String.raw`C:\git\app`, ['C:/git/'], 'C:/git/'],
    [String.raw`\\server\share\app`, [String.raw`\\server\share`], String.raw`\\server\share`],
    [String.raw`/git/a\b`, ['/git/a'], undefined],
    ['/Git/app', ['/git'], undefined],
  ])('groups %s under its nearest registered ancestor', (path, parents, expected) => {
    expect(owningParentFolder(path, parents)).toBe(expected)
  })
})

it('leaves unnamed history titles empty for locale-owned row labels', () => {
  const item = summary('unnamed', 1, '/work/Default workspace')
  delete item.title
  item.displayTitle = 'Default workspace'
  const sessions = list(item)
  expect(deriveFlat(sessions, [item.id], noRows, noAttention)[0]?.title).toBe('')
})
