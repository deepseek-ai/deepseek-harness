// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { mergeTurnRailItems } from '../src/client/chat/turn-rail-items.ts'
import type { TurnNavigationItem } from '../src/client/contract/snapshot.ts'

function loadedItem(turn: number, prompt = `p${String(turn)}`, response = `r${String(turn)}`): TurnNavigationItem {
  return { turn, anchorKey: `anchor-${String(turn)}`, prompt, response }
}

describe('mergeTurnRailItems', () => {
  it('returns a stable empty array when both sides are empty', () => {
    expect(mergeTurnRailItems([], undefined)).toBe(mergeTurnRailItems([], []))
  })

  it('maps outline-only turns to unloaded marks with both previews in ascending order', () => {
    const items = mergeTurnRailItems([], [
      { turn: 1, seq: 0, prompt: 'first', response: 'first answer' },
      { turn: 2, seq: 9, prompt: '', response: '' },
    ])
    expect(items).toEqual([
      { turn: 1, prompt: 'first', response: 'first answer', anchor: { kind: 'unloaded', seq: 0 } },
      { turn: 2, prompt: '', response: '', anchor: { kind: 'unloaded', seq: 9 } },
    ])
  })

  it('prefers the loaded side on overlap but fills empty previews from the outline', () => {
    const items = mergeTurnRailItems(
      [loadedItem(2, '', ''), loadedItem(3)],
      [
        { turn: 1, seq: 0, prompt: 'one', response: 'answer one' },
        { turn: 2, seq: 8, prompt: 'two from outline', response: 'answer two from outline' },
        { turn: 3, seq: 16, prompt: 'three from outline', response: 'answer three from outline' },
      ],
    )
    expect(items).toEqual([
      { turn: 1, prompt: 'one', response: 'answer one', anchor: { kind: 'unloaded', seq: 0 } },
      {
        turn: 2,
        prompt: 'two from outline',
        response: 'answer two from outline',
        anchor: { kind: 'loaded', key: 'anchor-2' },
      },
      { turn: 3, prompt: 'p3', response: 'r3', anchor: { kind: 'loaded', key: 'anchor-3' } },
    ])
  })

  it('passes loaded turns through when the outline is absent or lagging', () => {
    expect(mergeTurnRailItems([loadedItem(7)], undefined)).toEqual([
      { turn: 7, prompt: 'p7', response: 'r7', anchor: { kind: 'loaded', key: 'anchor-7' } },
    ])
    expect(mergeTurnRailItems([loadedItem(4)], [{ turn: 3, seq: 1, prompt: 'older', response: '' }])).toEqual([
      { turn: 3, prompt: 'older', response: '', anchor: { kind: 'unloaded', seq: 1 } },
      { turn: 4, prompt: 'p4', response: 'r4', anchor: { kind: 'loaded', key: 'anchor-4' } },
    ])
  })

  it('drops entries with damaged navigation fields but degrades malformed previews to empty', () => {
    expect(mergeTurnRailItems([loadedItem(1)], 'not an outline')).toEqual([
      { turn: 1, prompt: 'p1', response: 'r1', anchor: { kind: 'loaded', key: 'anchor-1' } },
    ])
    const items = mergeTurnRailItems([], [
      { turn: -1, seq: 0, prompt: 'negative turn', response: '' },
      { turn: 2, seq: 0.5, prompt: 'fractional seq', response: '' },
      { turn: 4, seq: -0, prompt: 'negative zero seq', response: '' },
      { turn: 5, seq: Number.MAX_SAFE_INTEGER + 1, prompt: 'unsafe seq', response: '' },
      { turn: 3, seq: 4, prompt: 5, response: 6 },
      { turn: 6, seq: 7, prompt: 'kept', response: 8 },
      null,
    ])
    // turn/seq are load-bearing (drop); previews are decorative (degrade).
    expect(items).toEqual([
      { turn: 3, prompt: '', response: '', anchor: { kind: 'unloaded', seq: 4 } },
      { turn: 6, prompt: 'kept', response: '', anchor: { kind: 'unloaded', seq: 7 } },
    ])
  })
})
