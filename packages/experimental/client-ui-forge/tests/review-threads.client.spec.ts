/** Placement, filters, excerpts, and composer quotes of host review threads. */
import { describe, expect, it } from 'vitest'
import type { ForgeReviewThread } from '@deepseek-ai/dsh-experimental-forge/types'
import {
  anchorRange, formatThreadQuote, gapOf, inFileOrder, hunkExcerpt, passesFilter, placeThread, threadQuoteSummary, THREAD_FILTERS,
} from '../src/client/review-threads.ts'
import { diffFile, reviewComment, reviewThread } from './thread-fixtures.client.ts'

const HEAD = 'a'.repeat(40)
const OLD = 'b'.repeat(40)
const MIDDLE = 'c'.repeat(40)

describe('placeThread', () => {
  const current = reviewThread({ current: { commit: HEAD, startLine: 3, endLine: 5 }, original: { commit: OLD, startLine: 2, endLine: 4 } })

  it('places a thread on the whole change request at its position on the head, else in the outdated section', () => {
    const whole = { head: HEAD, end: HEAD, commits: null }
    expect(placeThread(current, whole)).toEqual({ kind: 'line', side: 'R', startLine: 3, endLine: 5 })
    expect(placeThread(reviewThread({ side: 'L', current: { commit: HEAD, startLine: 1, endLine: 1 } }), whole))
      .toEqual({ kind: 'line', side: 'L', startLine: 1, endLine: 1 })
    expect(placeThread(reviewThread({ current: null }), whole)).toEqual({ kind: 'outdated' })
    expect(placeThread(reviewThread({ subject: 'file', current: null, original: null }), whole)).toEqual({ kind: 'file' })
  })

  it('places a new-side thread in chosen commits only where its lines number the last chosen commit', () => {
    expect(placeThread(current, { head: HEAD, end: HEAD, commits: { from: MIDDLE, to: HEAD } }))
      .toEqual({ kind: 'line', side: 'R', startLine: 3, endLine: 5 })
    expect(placeThread(current, { head: HEAD, end: OLD, commits: { from: OLD, to: OLD } }))
      .toEqual({ kind: 'line', side: 'R', startLine: 2, endLine: 4 })
    expect(placeThread(current, { head: HEAD, end: MIDDLE, commits: { from: MIDDLE, to: MIDDLE } })).toEqual({ kind: 'elsewhere' })
    expect(placeThread(reviewThread({ side: 'L', current: { commit: HEAD, startLine: 1, endLine: 1 } }),
      { head: HEAD, end: HEAD, commits: { from: HEAD, to: HEAD } })).toEqual({ kind: 'elsewhere' })
    expect(placeThread(reviewThread({ current: null, original: null }), { head: HEAD, end: OLD, commits: { from: OLD, to: OLD } }))
      .toEqual({ kind: 'outdated' })
    expect(placeThread(reviewThread({ subject: 'file', current: null, original: null }), { head: HEAD, end: OLD, commits: { from: OLD, to: OLD } }))
      .toEqual({ kind: 'file' })
  })
})

it('names a side and its lines', () => {
  expect(anchorRange('R', { startLine: 12, endLine: 12 })).toBe('R12')
  expect(anchorRange('L', { startLine: 3, endLine: 5 })).toBe('L3–5')
})

it('finds the collapsed unchanged lines that hold a line on either side', () => {
  const file = diffFile('a.ts', [
    { oldStart: 5, oldLines: 3, newStart: 5, newLines: 3, lines: [' a', '-b', '+b', ' c'] },
    { oldStart: 20, oldLines: 2, newStart: 22, newLines: 2, lines: ['-x', '+x', ' y'] },
  ])
  expect(gapOf(file, 'R', 2)).toBe(0)
  expect(gapOf(file, 'R', 6)).toBeUndefined()
  expect(gapOf(file, 'R', 10)).toBe(1)
  expect(gapOf(file, 'L', 21)).toBeUndefined()
  expect(gapOf(file, 'R', 21)).toBe(1)
  expect(gapOf(file, 'R', 40)).toBe(2)
})

it('orders a file\'s threads as its section shows them', () => {
  const file = diffFile('a.ts', [
    { oldStart: 5, oldLines: 3, newStart: 5, newLines: 3, lines: [' a', '-b', '+b', ' c'] },
    { oldStart: 20, oldLines: 2, newStart: 22, newLines: 2, lines: ['-x', '+x', ' y'] },
  ])
  const line = (id: string, side: 'L' | 'R', at: number) => ({ id, place: { kind: 'line', side, startLine: at, endLine: at } as const })
  const items = [
    { id: 'away', place: { kind: 'elsewhere' } as const }, { id: 'gone', place: { kind: 'outdated' } as const },
    line('tail', 'R', 40), line('added', 'R', 6), line('second-hunk', 'L', 20), line('before', 'R', 2), line('deleted', 'L', 6),
    { id: 'whole', place: { kind: 'file' } as const }, line('between', 'L', 10),
  ]
  expect(inFileOrder(items, file).map(item => item.id))
    .toEqual(['whole', 'before', 'deleted', 'added', 'between', 'second-hunk', 'tail', 'gone', 'away'])
  // Without the file's diff, lines sort by their number.
  expect(inFileOrder([line('b', 'R', 9), line('a', 'L', 2)], undefined).map(item => item.id)).toEqual(['a', 'b'])
})

describe('thread filters', () => {
  it('keeps the threads each filter names', () => {
    const outdated = reviewThread({ current: null })
    const resolved = reviewThread({ resolved: true })
    const file = reviewThread({ subject: 'file', current: null, original: null })
    expect(THREAD_FILTERS).toEqual(['unresolved', 'resolved', 'all'])
    expect([outdated, resolved, file].map(thread => passesFilter(thread, 'unresolved'))).toEqual([true, false, true])
    expect([outdated, resolved, file].map(thread => passesFilter(thread, 'resolved'))).toEqual([false, true, false])
    expect([outdated, resolved, file].map(thread => passesFilter(thread, 'all'))).toEqual([true, true, true])
  })
})

describe('hunkExcerpt', () => {
  const hunk = '@@ -1,8 +1,9 @@\n a\n b\n-c\n+C\n+D\n d\n e'

  it('keeps the header and the thread\'s lines on its side with three before them', () => {
    expect(hunkExcerpt(hunk, 'R', 1)).toEqual({ header: '@@ -1,8 +1,9 @@', lines: ['+C', '+D', ' d', ' e'] })
    expect(hunkExcerpt(hunk, 'L', 2)).toEqual({ header: '@@ -1,8 +1,9 @@', lines: [' a', ' b', '-c', '+C', '+D', ' d', ' e'] })
  })

  it('keeps every line of a short hunk without a header', () => {
    expect(hunkExcerpt(' a\n+b', 'R', 1)).toEqual({ header: null, lines: [' a', '+b'] })
  })
})

describe('thread quotes', () => {
  it('summarizes a quote by file name, range, and first comment', () => {
    expect(threadQuoteSummary(reviewThread({ path: 'src/a.ts' }), 'R3')).toEqual({ label: 'a.ts R3', title: 'src/a.ts', detail: 'R3', body: 'First comment' })
    expect(threadQuoteSummary(reviewThread({ path: 'a.ts', comments: [] }), null)).toEqual({ label: 'a.ts', title: 'a.ts', detail: 'a.ts', body: '' })
  })

  it('formats a line thread with its hunk, state, and every comment quoted line by line', () => {
    const thread: ForgeReviewThread = reviewThread({
      current: { commit: HEAD, startLine: 3, endLine: 5 }, diffHunk: '@@ -1 +1 @@\n-```\n+````',
      comments: [reviewComment({ body: '# Heading\n\nsecond line', url: 'https://github.com/octo/demo/pull/7#discussion_r1' }),
        reviewComment({ author: null, body: 'reply' })],
    })
    expect(formatThreadQuote(thread, 'https://github.com/octo/demo/pull/7', 2)).toBe([
      '## Review Thread 2', 'File: src/a.ts', 'Side: R', 'Lines: 3-5', `Commit: ${HEAD}`, 'State: unresolved',
      'Source: https://github.com/octo/demo/pull/7#discussion_r1', 'Diff hunk:', '`````diff', '@@ -1 +1 @@\n-```\n+````', '`````',
      'Comments:', '@reviewer (2026-11-05T08:00:00Z):', '> # Heading', '>', '> second line', 'Unknown author (2026-11-05T08:00:00Z):', '> reply',
    ].join('\n'))
  })

  it('names an old-side thread\'s lines as the file before the change and its commit as where the diff ends', () => {
    const old = reviewThread({ side: 'L', current: { commit: HEAD, startLine: 15, endLine: 15 }, diffHunk: null })
    expect(formatThreadQuote(old, 'https://github.com/octo/demo/pull/7', 1)).toBe([
      '## Review Thread 1', 'File: src/a.ts', 'Side: L (old side: the lines number the file before the pull request\'s changes)', 'Lines: 15',
      `Diff head: ${HEAD}`, 'State: unresolved', `Source: ${old.comments[0]?.url}`,
      'Comments:', '@reviewer (2026-11-05T08:00:00Z):', '> First comment',
    ].join('\n'))
  })

  it('formats an outdated single line at the lines it was written on, and a file thread without lines or hunk', () => {
    const outdated = reviewThread({ current: null, resolved: true, original: { commit: OLD, startLine: 9, endLine: 9 }, diffHunk: null,
      comments: [reviewComment({ url: null })] })
    expect(formatThreadQuote(outdated, 'https://github.com/octo/demo/pull/7', 1)).toBe([
      '## Review Thread 1', 'File: src/a.ts', 'Side: R', 'Lines: 9', `Commit: ${OLD}`, 'State: resolved, outdated',
      'Source: https://github.com/octo/demo/pull/7', 'Comments:', '@reviewer (2026-11-05T08:00:00Z):', '> First comment',
    ].join('\n'))
    const file = reviewThread({ subject: 'file', current: null, original: null, diffHunk: null })
    expect(formatThreadQuote(file, 'https://github.com/octo/demo/pull/7', 1)).toContain('File: src/a.ts\nLines: whole file\nState: unresolved\n')
  })
})
