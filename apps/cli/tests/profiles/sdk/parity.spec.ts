/** Diagnostics and exact exception consumption for the SDK/Desktop model context comparison. */
import { expect, it } from 'vitest'
import { parityExceptions } from './parity-exceptions.ts'
import { assertParity, compareEntries, compareOrder, jsonDifferences, type ParityException } from './parity.ts'

const toolOnly: ParityException = {
  kind: 'tool', key: 'desktop_only', side: 'desktop', reason: 'Requires a graphical client.',
}

it('reports the deepest differing JSON pointers', () => {
  expect(jsonDifferences({ a: 1, b: { c: [1, 2], 'x/y': 1 } }, { a: 1, b: { c: [1, 3], 'x/y': 2, d: true } }))
    .toEqual(['/b/c/1', '/b/d', '/b/x~1y'])
  expect(jsonDifferences([1, 2], [1])).toEqual([''])
  expect(jsonDifferences('same', 'same')).toEqual([])
})

it('separates one-sided entries from differing shared entries', () => {
  const sdk = new Map<string, unknown>([['read', { description: 'a' }], ['sdk_extra', {}]])
  const desktop = new Map<string, unknown>([['read', { description: 'b' }], ['present', {}]])
  expect(compareEntries('tool', 'schema', sdk, desktop)).toEqual([
    { kind: 'tool', key: 'present', side: 'desktop' },
    { kind: 'schema', key: 'read:/description' },
    { kind: 'tool', key: 'sdk_extra', side: 'sdk' },
  ])
  expect(compareEntries('section', 'section', new Map([['plan', 'a']]), new Map([['plan', 'b']])))
    .toEqual([{ kind: 'section', key: 'plan' }])
})

it('compares the relative order of shared entries only', () => {
  expect(compareOrder('section', ['a', 'sdk_only', 'b'], ['desktop_only', 'a', 'b'])).toEqual([])
  expect(compareOrder('section', ['a', 'b'], ['b', 'a'])).toEqual([{ kind: 'order', key: 'section' }])
})

it('accepts an exact exception and rejects it after the profiles converge', () => {
  const difference = { kind: 'tool' as const, key: 'desktop_only', side: 'desktop' as const }
  expect(() => { assertParity(['tool'], [difference], [toolOnly]) }).not.toThrow()
  expect(() => { assertParity(['tool'], [], [toolOnly]) })
    .toThrow('Stale exceptions: tool desktop_only (desktop only)')
  expect(() => { assertParity(['tool'], [{ ...difference, side: 'sdk' }], [toolOnly]) })
    .toThrow('tool desktop_only (sdk only)')
})

it('consults only exceptions of the compared layers', () => {
  expect(() => { assertParity(['config'], [], [toolOnly]) }).not.toThrow()
})

it('reports every unrecorded difference with the remedy', () => {
  expect(() => {
    assertParity(['schema', 'section'], [{ kind: 'schema', key: 'read:/description' }, { kind: 'section', key: 'plan' }], [])
  }).toThrow(/schema read:\/description \(differs\)\n {2}section plan \(differs\)\nStale exceptions: \(none\)\nAlign both profiles/)
})

it('rejects undocumented, untracked and duplicate exceptions', () => {
  const difference = { kind: 'section' as const, key: 'plan' }
  expect(() => { assertParity(['section'], [difference], [{ ...difference, reason: ' ' }]) })
    .toThrow('requires a reason')
  expect(() => {
    assertParity(['section'], [difference], [{ ...difference, reason: 'Old text.', debt: { issue: '' } }])
  }).toThrow('requires an issue')
  const exception = { ...difference, reason: 'Intentional.' }
  expect(() => { assertParity(['section'], [difference], [exception, exception]) })
    .toThrow('Stale exceptions: section plan (differs)')
})

it('records each shipped exception once with a reason', () => {
  const keys = parityExceptions.map(exception => `${exception.kind} ${exception.key} ${exception.side ?? ''}`)
  expect(new Set(keys).size).toBe(keys.length)
  for (const exception of parityExceptions) {
    expect(exception.reason.trim()).not.toBe('')
  }
})
