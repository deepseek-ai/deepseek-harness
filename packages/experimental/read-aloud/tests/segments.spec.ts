/** Spoken-length estimate and the rules that close a segment. */
import { expect, it } from 'vitest'
import { segmentSpeech, speechEstimateMs, type TextRange } from '../src/segments.ts'

const slices = (text: string, ranges: readonly TextRange[]): string[] => ranges.map(range => text.slice(range.start, range.end))

it('estimates letters, digits and pauses by kind', () => {
  expect(speechEstimateMs('你好。')).toBe(700)
  expect(speechEstimateMs('abc')).toBe(210)
  expect(speechEstimateMs('かな한글𠀀')).toBe(1000)
  expect(speechEstimateMs('3.14')).toBe(600)
  expect(speechEstimateMs('a,b')).toBe(140)
  expect(speechEstimateMs('a, b.')).toBe(590)
  expect(speechEstimateMs('甲、乙：丙，丁\n')).toBe(1550)
  expect(speechEstimateMs('😀 — *')).toBe(0)
  expect(speechEstimateMs('')).toBe(0)
})

it('returns no segment for text without a letter or digit and one segment for a short text', () => {
  expect(segmentSpeech('', { targetMs: 1000, maxCharacters: 100 })).toEqual([])
  expect(segmentSpeech('……\n——', { targetMs: 1000, maxCharacters: 100 })).toEqual([])
  expect(segmentSpeech('你好。再见。', { targetMs: 1000, maxCharacters: 100 })).toEqual([{ start: 0, end: 6 }])
})

it('closes a segment at the first sentence end past the target', () => {
  const text = '甲乙。'.repeat(6)
  expect(segmentSpeech(text, { targetMs: 1000, maxCharacters: 100 }))
    .toEqual([{ start: 0, end: 6 }, { start: 6, end: 12 }, { start: 12, end: 18 }])
})

it('keeps a remainder of at most half the target in the segment before it', () => {
  const text = '甲乙。'.repeat(3)
  expect(segmentSpeech(text, { targetMs: 1300, maxCharacters: 100 })).toEqual([{ start: 0, end: 6 }, { start: 6, end: 9 }])
  expect(segmentSpeech(text, { targetMs: 1400, maxCharacters: 100 })).toEqual([{ start: 0, end: 9 }])
})

it('waits for 1.5 times the target at a clause mark or space and for twice the target inside a run', () => {
  const clauses = '甲乙，'.repeat(8)
  expect(segmentSpeech(clauses, { targetMs: 1000, maxCharacters: 100 }))
    .toEqual([{ start: 0, end: 9 }, { start: 9, end: 18 }, { start: 18, end: 24 }])
  const words = 'word '.repeat(50)
  expect(slices(words, segmentSpeech(words, { targetMs: 3000, maxCharacters: 1000 })))
    .toEqual(['word '.repeat(20), 'word '.repeat(20), 'word '.repeat(10)])
  const run = '甲'.repeat(300)
  expect(segmentSpeech(run, { targetMs: 5000, maxCharacters: 1000 }))
    .toEqual([{ start: 0, end: 100 }, { start: 100, end: 200 }, { start: 200, end: 300 }])
  expect(segmentSpeech(run, { targetMs: 15_000, maxCharacters: 1000 })).toEqual([{ start: 0, end: 200 }, { start: 200, end: 300 }])
})

it('never exceeds the provider limit, also when the limit is shorter than a unit', () => {
  const text = '甲乙。'.repeat(100)
  expect(segmentSpeech(text, { targetMs: 1e9, maxCharacters: 150 })).toEqual([{ start: 0, end: 150 }, { start: 150, end: 300 }])
  expect(segmentSpeech('甲'.repeat(25), { targetMs: 1e9, maxCharacters: 10 }))
    .toEqual([{ start: 0, end: 10 }, { start: 10, end: 20 }, { start: 20, end: 25 }])
})

it('leaves text without a letter or digit out of every segment', () => {
  const text = '——\n甲乙。\n***\n丙丁。\n……'
  expect(slices(text, segmentSpeech(text, { targetMs: 100, maxCharacters: 100 }))).toEqual(['甲乙。', '丙丁。'])
  expect(slices(text, segmentSpeech(text, { targetMs: 1e9, maxCharacters: 100 }))).toEqual(['甲乙。\n***\n丙丁。'])
})

it('cuts a run before a surrogate pair instead of through it', () => {
  const text = `a${'𠀀'.repeat(60)}`
  const parts = slices(text, segmentSpeech(text, { targetMs: 1000, maxCharacters: 1000 }))
  expect(parts.map(part => part.length)).toEqual([99, 22])
  expect(parts.every(part => part.isWellFormed())).toBe(true)
  // A limit too small to hold the pair leaves halves that are no letter, so nothing is spoken.
  expect(segmentSpeech('𠀀', { targetMs: 1000, maxCharacters: 1 })).toEqual([])
})
