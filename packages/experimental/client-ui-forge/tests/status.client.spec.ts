import { describe, expect, it } from 'vitest'
import {
  checkCounts, checkDuration, ciSummary, flagOf, needsAttention, numberOf, toneOf,
} from '../src/client/status.ts'
import { check, entry, ref, snapshot, unserved } from './client-fixtures.client.ts'

describe('toneOf', () => {
  it.each([
    ['no snapshot yet', null, 'unknown'],
    ['an open change request', snapshot(1), 'open'],
    ['an open draft', snapshot(1, { draft: true }), 'draft'],
    ['an open change request with failed checks', snapshot(1, { checksRollup: 'failure' }), 'blocked'],
    ['an open change request with requested changes', snapshot(1, { reviewDecision: 'changes-requested' }), 'blocked'],
    ['an open change request with conflicts', snapshot(1, { mergeability: 'conflicting' }), 'blocked'],
    ['a draft with failed checks', snapshot(1, { draft: true, checksRollup: 'failure' }), 'draft'],
    ['a draft with requested changes and conflicts',
      snapshot(1, { draft: true, reviewDecision: 'changes-requested', mergeability: 'conflicting' }), 'draft'],
    ['an open change request that waits for checks, a review, and its mergeability',
      snapshot(1, { checksRollup: 'pending', reviewDecision: 'review-required', mergeability: 'unknown' }), 'open'],
    ['a merged change request', snapshot(1, { state: 'merged', draft: true }), 'merged'],
    ['a merged change request with failed checks', snapshot(1, { state: 'merged', checksRollup: 'failure' }), 'merged'],
    ['a closed change request', snapshot(1, { state: 'closed' }), 'closed'],
    ['a closed change request with conflicts', snapshot(1, { state: 'closed', mergeability: 'conflicting' }), 'closed'],
  ] as const)('draws %s as %s', (_label, value, tone) => {
    expect(toneOf(value)).toBe(tone)
  })
})

describe('checkCounts', () => {
  it('counts cancellations separately from neutral and skipped checks', () => {
    expect(checkCounts([])).toEqual({ failed: 0, running: 0, passed: 0, cancelled: 0, other: 0 })
    expect(checkCounts([
      check('lint', { state: 'failure' }),
      check('test', { state: 'pending' }),
      check('build'),
      check('docs', { state: 'neutral' }),
      check('e2e', { state: 'skipped' }),
      check('perf', { state: 'cancelled' }),
      check('types', { state: 'failure' }),
    ])).toEqual({ failed: 2, running: 1, passed: 1, cancelled: 1, other: 2 })
  })
})

describe('ciSummary', () => {
  it.each([
    ['no checks', 'none', { kind: 'none' }],
    ['running checks', 'pending', { kind: 'running' }],
    ['passed checks', 'success', { kind: 'passed' }],
  ] as const)('reports %s from the rollup alone', (_label, checksRollup, summary) => {
    expect(ciSummary(snapshot(1, { checksRollup, checks: [check('lint', { state: 'failure' })] }))).toEqual(summary)
  })

  it('names cancellations when no listed check failed, and gives failures precedence', () => {
    const cancelled = check('build', { state: 'cancelled' })
    expect(ciSummary(snapshot(1, { checksRollup: 'failure', checks: [cancelled] }))).toEqual({ kind: 'cancelled', count: 1 })
    expect(ciSummary(snapshot(1, { checksRollup: 'failure', checks: [cancelled, check('lint', { state: 'failure' })] })))
      .toEqual({ kind: 'failed', count: 1 })
  })

  it('counts the listed failures of a failed rollup, which can be none when the list is truncated', () => {
    const failed = snapshot(1, {
      checksRollup: 'failure',
      checks: [check('lint', { state: 'failure' }), check('test'), check('types', { state: 'failure' })],
    })
    expect(ciSummary(failed)).toEqual({ kind: 'failed', count: 2 })
    expect(ciSummary(snapshot(1, { checksRollup: 'failure', checks: [check('test')], checksTruncated: true })))
      .toEqual({ kind: 'failed', count: 0 })
  })
})

describe('flagOf', () => {
  it.each([
    ['requested changes before conflicts and draft state', { reviewDecision: 'changes-requested', mergeability: 'conflicting', draft: true },
      'changesRequested'],
    ['merge conflicts before draft state', { mergeability: 'conflicting', draft: true }, 'conflicting'],
    ['draft state', { draft: true }, 'draft'],
    ['nothing for a settled open change request', {}, undefined],
    ['nothing for a merged change request', { state: 'merged', reviewDecision: 'changes-requested' }, undefined],
    ['nothing for a closed change request', { state: 'closed', mergeability: 'conflicting' }, undefined],
  ] as const)('names %s', (_label, overrides, flag) => {
    expect(flagOf(snapshot(1, overrides))).toBe(flag)
  })
})

describe('needsAttention', () => {
  it.each([
    ['failed checks', { checksRollup: 'failure' }],
    ['requested changes', { reviewDecision: 'changes-requested' }],
    ['merge conflicts', { mergeability: 'conflicting' }],
  ] as const)('marks an open change request with %s', (_label, overrides) => {
    expect(needsAttention(entry(1, snapshot(1, overrides)))).toBe(true)
  })

  it.each([
    ['a binding without a snapshot', entry(1, null)],
    ['an unserved URL', unserved('https://example.test/review/1')],
    ['a settled open change request', entry(1, snapshot(1, { checksRollup: 'pending', mergeability: 'unknown', draft: true }))],
    ['a draft with failed checks', entry(1, snapshot(1, { draft: true, checksRollup: 'failure' }))],
    ['a merged change request with failed checks', entry(1, snapshot(1, { state: 'merged', checksRollup: 'failure' }))],
    ['a closed change request with conflicts', entry(1, snapshot(1, { state: 'closed', mergeability: 'conflicting' }))],
  ])('leaves %s unmarked', (_label, value) => {
    expect(needsAttention(value)).toBe(false)
  })

  it('reads the kept snapshot of a binding whose latest poll failed', () => {
    const failed = entry(1, { code: 'unavailable', message: 'down' }, { kept: snapshot(1, { checksRollup: 'failure' }) })
    expect(needsAttention(failed)).toBe(true)
  })
})

describe('numberOf', () => {
  it('prefers the provider reference over the URL', () => {
    expect(numberOf({ ref: ref(42), url: 'https://github.com/octo/demo/pull/7' })).toBe(42)
  })

  it.each([
    ['a plain path', 'https://example.test/review/17', 17],
    ['a trailing slash', 'https://example.test/review/17/', 17],
    ['a query', 'https://example.test/review/17?tab=files', 17],
    ['a fragment', 'https://example.test/review/17#note', 17],
    ['a trailing slash and a fragment spanning lines', 'https://example.test/review/17/#a\nb', 17],
  ])('reads the number at the end of a URL path with %s', (_label, url, number) => {
    expect(numberOf({ ref: null, url })).toBe(number)
  })

  it.each([
    ['no number', 'https://example.test/review/latest'],
    ['digits inside the last segment', 'https://example.test/review/v17'],
    ['a number beyond the safe integer range', 'https://example.test/review/9007199254740993'],
  ])('reads nothing from a URL path with %s', (_label, url) => {
    expect(numberOf({ ref: null, url })).toBeNull()
  })
})

describe('checkDuration', () => {
  it('measures a completed check', () => {
    expect(checkDuration(check('test'))).toBe(65_000)
    expect(checkDuration(check('test', { completedAt: '2026-10-09T10:00:00Z' }))).toBe(0)
  })

  it.each([
    ['a check that has not started', { startedAt: null }],
    ['a running check', { completedAt: null }],
    ['an unparseable start time', { startedAt: 'yesterday' }],
    ['a completion before the start', { completedAt: '2026-10-09T09:59:59Z' }],
  ])('measures nothing for %s', (_label, overrides) => {
    expect(checkDuration(check('test', overrides))).toBeUndefined()
  })
})
