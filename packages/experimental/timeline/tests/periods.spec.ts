import { describe, expect, it } from 'vitest'
import { activeRanges, reportPeriods, reportRanges, savedPeriod } from '../src/periods.ts'
import { reportSchema } from '../src/records.ts'
import type { Activity } from '../src/records.ts'

const report = reportSchema.parse({
  id: 'saved',
  level: 0,
  start: 0,
  end: 3660000,
  policy: '[60000,5,3]',
  children: [],
  source: 'model',
  toolCount: 1,
  covered: 1,
  contextSeq: 1,
  summary: { progress: ['Recovery is verified.'], uncertainties: [], userActions: [] },
})
const activity: Activity = { start: 0, olderWorkMs: 0, ranges: [[0, 24000]], open: 3624000 }

describe('recorded work periods', () => {
  it('keeps closed activity separate from the original configured report period', () => {
    expect(activeRanges({ ...activity, open: null }, 1000, 60000)).toEqual([[1000, 24000]])
    expect(savedPeriod({ ...report, level: 2 })).toBe(900000)
    expect(savedPeriod({ ...report, level: 3 })).toBeUndefined()
    expect(savedPeriod({ ...report, policy: 'legacy-policy' })).toBeUndefined()
    expect(reportPeriods({ intervalMs: 60001, rollupFactors: [2.5, 2] })).toEqual([60001, 150003, 300006])
  })
  it('keeps an hour-long pause out of a one-minute report without changing saved content', () => {
    expect(reportRanges(report, activity)).toEqual([
      [0, 24000],
      [3624000, 3660000],
    ])
    expect(report.ranges).toBeUndefined()
    expect(report.summary.progress).toEqual(['Recovery is verified.'])
  })
  it('retains captured work when crash recovery closes a turn before a saved independent report', () => {
    const saved = reportSchema.parse({ ...report, ranges: [[0, 60000]] })
    const recovered: Activity = { start: 0, olderWorkMs: 0, ranges: [[0, 1000]], open: null }
    expect(reportRanges(saved, recovered)).toEqual([[0, 60000]])
    expect(reportSchema.safeParse({ ...saved, ranges: [[0, saved.end + 1]] }).success).toBe(false)
  })
  it('does not invent idle time without evidence or before creation, and includes unreported live work', () => {
    expect(reportRanges(report, undefined)).toBeUndefined()
    const live: Activity = {
      start: 10000,
      olderWorkMs: 0,
      ranges: [
        [20000, 30000],
        [30000, 40000],
      ],
      open: 50000,
    }
    expect(activeRanges(live, 25000, 60000)).toEqual([
      [25000, 40000],
      [50000, 60000],
    ])
  })
})
