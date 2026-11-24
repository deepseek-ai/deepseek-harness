import { describe, expect, it } from 'vitest'
import type { MenuState, TriggerHit } from '../src/core/contract.ts'
import { exactMatch, MENU_CLOSED, menuReduce, seedGroups } from '../src/core/menu.ts'

const hit = (query = ''): TriggerHit => ({
  trigger: '/',
  query,
  quoted: false,
  position: 'leading',
  span: { start: 0, end: 1 + query.length, draftRev: 1 },
})

function open(sources: readonly string[], h: TriggerHit = hit()): MenuState {
  return menuReduce(seedGroups(MENU_CLOSED, sources.map(name => ({ name }))), { type: 'hit', hit: h })
}

const item = (name: string) => ({ name })

/** Two ready groups: command [goal, model], skill [commit]. */
function ready(): MenuState {
  let s = open(['command', 'skill'])
  s = menuReduce(s, { type: 'source-settled', generation: 1, source: 'command', items: [item('goal'), item('model')] })
  s = menuReduce(s, { type: 'source-settled', generation: 1, source: 'skill', items: [item('commit')] })
  return s
}

describe('menuReduce hit', () => {
  it('opens a new generation with all groups pending', () => {
    const s = open(['command', 'skill'])
    expect(s.open).toBe(true)
    expect(s.generation).toBe(1)
    expect(s.groups).toEqual([
      { source: 'command', status: 'pending', items: [] },
      { source: 'skill', status: 'pending', items: [] },
    ])
    expect(s.highlight).toBeNull()
  })

  it('re-hit resets ready groups to pending under a bumped generation, keeping items and highlight', () => {
    let s = open(['command'])
    s = menuReduce(s, { type: 'source-settled', generation: 1, source: 'command', items: [item('goal')] })
    s = menuReduce(s, { type: 'hit', hit: hit('g') })
    expect(s.generation).toBe(2)
    // Stale-while-revalidate: the previous query's items stay until the new
    // generation settles and replaces them, and the highlight stays parked
    // instead of blinking off between keystrokes.
    expect(s.groups).toEqual([{ source: 'command', status: 'pending', items: [item('goal')] }])
    expect(s.highlight).toEqual({ source: 'command', index: 0 })
    s = menuReduce(s, { type: 'source-settled', generation: 2, source: 'command', items: [item('grep')] })
    expect(s.groups).toEqual([{ source: 'command', status: 'ready', items: [item('grep')] }])
    expect(s.highlight).toEqual({ source: 'command', index: 0 })
  })

  it('preserves a hidden group title through re-hit and settlement', () => {
    let s = menuReduce(seedGroups(MENU_CLOSED, [{ name: 'reference', showGroupTitle: false }]), { type: 'hit', hit: hit() })
    expect(s.groups[0]).toMatchObject({ source: 'reference', showGroupTitle: false, status: 'pending' })
    s = menuReduce(s, { type: 'hit', hit: hit('r') })
    s = menuReduce(s, { type: 'source-settled', generation: 2, source: 'reference', items: [item('README.md')] })
    expect(s.groups[0]).toMatchObject({ source: 'reference', showGroupTitle: false, status: 'ready' })
  })

  it('null hit closes; closing an already-closed state is a no-op reference', () => {
    const s = open(['command'])
    const c = menuReduce(s, { type: 'hit', hit: null })
    expect(c.open).toBe(false)
    expect(c.groups).toEqual([])
    expect(menuReduce(c, { type: 'hit', hit: null })).toBe(c)
  })
})

describe('menuReduce source-settled', () => {
  it('marks the group ready and highlights the first item', () => {
    let s = open(['command', 'skill'])
    s = menuReduce(s, { type: 'source-settled', generation: 1, source: 'command', items: [item('goal')] })
    expect(s.groups[0]).toEqual({ source: 'command', status: 'ready', items: [item('goal')] })
    expect(s.groups[1]!.status).toBe('pending')
    expect(s.highlight).toEqual({ source: 'command', index: 0 })
  })

  it('withholds the default highlight from a later group until every earlier group settles', () => {
    let s = open(['command', 'skill'])
    s = menuReduce(s, { type: 'source-settled', generation: 1, source: 'skill', items: [item('commit')] })
    expect(s.groups[1]).toEqual({ source: 'skill', status: 'ready', items: [item('commit')] })
    expect(s.highlight).toBeNull()
    s = menuReduce(s, { type: 'source-settled', generation: 1, source: 'command', items: [item('goal')] })
    expect(s.highlight).toEqual({ source: 'command', index: 0 })
  })

  it('passes the default highlight to a later group when every earlier group settles empty', () => {
    let s = open(['command', 'skill'])
    s = menuReduce(s, { type: 'source-settled', generation: 1, source: 'skill', items: [item('commit')] })
    s = menuReduce(s, { type: 'source-settled', generation: 1, source: 'command', items: [] })
    expect(s.highlight).toEqual({ source: 'skill', index: 0 })
  })

  it('keeps an existing valid highlight when a later group settles', () => {
    let s = open(['command', 'skill'])
    s = menuReduce(s, { type: 'source-settled', generation: 1, source: 'command', items: [item('goal'), item('model')] })
    s = menuReduce(s, { type: 'move', dir: 1 })
    s = menuReduce(s, { type: 'source-settled', generation: 1, source: 'skill', items: [item('commit')] })
    expect(s.highlight).toEqual({ source: 'command', index: 1 })
  })

  it('keeps a highlight parked on a revalidating group while a later group settles first', () => {
    let s = ready()
    s = menuReduce(s, { type: 'move', dir: 1 })
    s = menuReduce(s, { type: 'hit', hit: hit('g') })
    s = menuReduce(s, { type: 'source-settled', generation: 2, source: 'skill', items: [item('git')] })
    expect(s.highlight).toEqual({ source: 'command', index: 1 })
    s = menuReduce(s, { type: 'source-settled', generation: 2, source: 'command', items: [item('goal'), item('grep')] })
    expect(s.highlight).toEqual({ source: 'command', index: 1 })
  })

  it('drops settlements from a stale generation by reference', () => {
    let s = open(['command'])
    s = menuReduce(s, { type: 'hit', hit: hit('g') }) // generation 2
    const next = menuReduce(s, { type: 'source-settled', generation: 1, source: 'command', items: [item('goal')] })
    expect(next).toBe(s)
  })

  it('drops settlements while closed and for unknown sources by reference', () => {
    const closed = menuReduce(open(['command']), { type: 'close' })
    expect(menuReduce(closed, { type: 'source-settled', generation: 1, source: 'command', items: [] })).toBe(closed)
    const s = open(['command'])
    expect(menuReduce(s, { type: 'source-settled', generation: 1, source: 'ghost', items: [] })).toBe(s)
  })

  it('treats omitted items as empty', () => {
    let s = open(['command', 'skill'])
    s = menuReduce(s, { type: 'source-settled', generation: 1, source: 'command' })
    expect(s.groups[0]).toEqual({ source: 'command', status: 'ready', items: [] })
    expect(s.open).toBe(true) // skill still pending
  })

  it('auto-closes when every group settles ready and empty', () => {
    let s = open(['command', 'skill'])
    s = menuReduce(s, { type: 'source-settled', generation: 1, source: 'command', items: [] })
    s = menuReduce(s, { type: 'source-settled', generation: 1, source: 'skill', items: [] })
    expect(s.open).toBe(false)
    expect(s.groups).toEqual([])
  })

  it('stays open when one group is empty but another has items', () => {
    let s = open(['command', 'skill'])
    s = menuReduce(s, { type: 'source-settled', generation: 1, source: 'command', items: [] })
    s = menuReduce(s, { type: 'source-settled', generation: 1, source: 'skill', items: [item('commit')] })
    expect(s.open).toBe(true)
    expect(s.highlight).toEqual({ source: 'skill', index: 0 })
  })
})

describe('menuReduce source-failed', () => {
  it('silently removes the failed group', () => {
    let s = open(['command', 'skill'])
    s = menuReduce(s, { type: 'source-settled', generation: 1, source: 'skill', items: [item('commit')] })
    s = menuReduce(s, { type: 'source-failed', generation: 1, source: 'command' })
    expect(s.groups.map(g => g.source)).toEqual(['skill'])
    expect(s.open).toBe(true)
  })

  it('closes when the last group fails', () => {
    let s = open(['command'])
    s = menuReduce(s, { type: 'source-failed', generation: 1, source: 'command' })
    expect(s.open).toBe(false)
  })

  it('closes when the surviving groups are all ready and empty', () => {
    let s = open(['command', 'skill'])
    s = menuReduce(s, { type: 'source-settled', generation: 1, source: 'skill', items: [] })
    s = menuReduce(s, { type: 'source-failed', generation: 1, source: 'command' })
    expect(s.open).toBe(false)
  })

  it('moves the highlight off the failed group', () => {
    let s = open(['command', 'skill'])
    s = menuReduce(s, { type: 'source-settled', generation: 1, source: 'command', items: [item('goal')] })
    s = menuReduce(s, { type: 'source-settled', generation: 1, source: 'skill', items: [item('commit')] })
    expect(s.highlight).toEqual({ source: 'command', index: 0 })
    s = menuReduce(s, { type: 'source-failed', generation: 1, source: 'command' })
    expect(s.highlight).toEqual({ source: 'skill', index: 0 })
  })

  it('drops stale-generation and unknown-source failures by reference', () => {
    const s = open(['command'])
    expect(menuReduce(s, { type: 'source-failed', generation: 0, source: 'command' })).toBe(s)
    expect(menuReduce(s, { type: 'source-failed', generation: 1, source: 'ghost' })).toBe(s)
  })
})

describe('menuReduce move', () => {
  it('cycles forward across groups and wraps', () => {
    let s = ready()
    s = menuReduce(s, { type: 'move', dir: 1 })
    expect(s.highlight).toEqual({ source: 'command', index: 1 })
    s = menuReduce(s, { type: 'move', dir: 1 })
    expect(s.highlight).toEqual({ source: 'skill', index: 0 })
    s = menuReduce(s, { type: 'move', dir: 1 })
    expect(s.highlight).toEqual({ source: 'command', index: 0 })
  })

  it('cycles backward and wraps to the last item', () => {
    let s = ready()
    s = menuReduce(s, { type: 'move', dir: -1 })
    expect(s.highlight).toEqual({ source: 'skill', index: 0 })
  })

  it('skips pending groups', () => {
    let s = open(['command', 'skill'])
    s = menuReduce(s, { type: 'source-settled', generation: 1, source: 'skill', items: [item('commit')] })
    s = menuReduce(s, { type: 'move', dir: 1 })
    expect(s.highlight).toEqual({ source: 'skill', index: 0 })
  })

  it('enters from null highlight at either end', () => {
    const base = { ...ready(), highlight: null }
    expect(menuReduce(base, { type: 'move', dir: 1 }).highlight).toEqual({ source: 'command', index: 0 })
    expect(menuReduce(base, { type: 'move', dir: -1 }).highlight).toEqual({ source: 'skill', index: 0 })
  })

  it('is a no-op reference when closed, without positions, or single-item', () => {
    const closed = menuReduce(ready(), { type: 'close' })
    expect(menuReduce(closed, { type: 'move', dir: 1 })).toBe(closed)
    const pending = open(['command'])
    expect(menuReduce(pending, { type: 'move', dir: 1 })).toBe(pending)
    let single = open(['command'])
    single = menuReduce(single, { type: 'source-settled', generation: 1, source: 'command', items: [item('goal')] })
    expect(menuReduce(single, { type: 'move', dir: 1 })).toBe(single)
  })
})

describe('menuReduce hover', () => {
  it('parks the highlight on the hovered ready item', () => {
    const s = menuReduce(ready(), { type: 'hover', source: 'skill', index: 0 })
    expect(s.highlight).toEqual({ source: 'skill', index: 0 })
  })

  it('is a no-op reference when closed, on invalid targets, and on the current highlight', () => {
    const closed = menuReduce(ready(), { type: 'close' })
    expect(menuReduce(closed, { type: 'hover', source: 'command', index: 0 })).toBe(closed)
    const s = ready()
    expect(menuReduce(s, { type: 'hover', source: 'ghost', index: 0 })).toBe(s)
    expect(menuReduce(s, { type: 'hover', source: 'command', index: 5 })).toBe(s)
    expect(menuReduce(s, { type: 'hover', source: 'command', index: 0 })).toBe(s)
  })

  it('ignores a hover into a still-pending group', () => {
    let s = open(['command', 'skill'])
    s = menuReduce(s, { type: 'source-settled', generation: 1, source: 'command', items: [item('goal')] })
    expect(menuReduce(s, { type: 'hover', source: 'skill', index: 0 })).toBe(s)
  })
})

describe('menuReduce close', () => {
  it('clears everything but keeps the generation for stale-drop', () => {
    let s = open(['command'])
    s = menuReduce(s, { type: 'close' })
    expect(s).toMatchObject({ open: false, hit: null, groups: [], highlight: null, generation: 1 })
  })
})

describe('exactMatch', () => {
  const groups: MenuState['groups'] = [
    { source: 'command', status: 'ready', items: [item('goal'), item('model')] },
    { source: 'skill', status: 'pending', items: [] },
  ]

  it('finds an exact name in a ready group', () => {
    expect(exactMatch(groups, 'command', 'model')).toEqual(item('model'))
  })

  it('returns null on name miss, non-ready group, and unknown source', () => {
    expect(exactMatch(groups, 'command', 'goa')).toBeNull()
    expect(exactMatch(groups, 'skill', 'commit')).toBeNull()
    expect(exactMatch(groups, 'ghost', 'goal')).toBeNull()
  })
})
