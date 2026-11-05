import { describe, expect, it } from 'vitest'
import type { SessionStatsProjection } from '@deepseek-ai/dsh-session-stats/types'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { totalsFromProjections } from '../src/client/stats-totals.ts'

const STATS: SessionStatsProjection = {
  turns: 10,
  steps: 80,
  llmMs: 400_000,
  toolMs: 200_000,
  ttftMs: 1_200,
  ttftSteps: 8,
  decodeMs: 300_000,
  decodeTokens: 60_000,
}

const USAGE: TokenUsageProjection = {
  uncachedInputTokens: 2_000_000,
  outputTokens: 500_000,
  cacheReadTokens: 8_000_000,
  cacheWriteTokens: 0,
}

describe('whole-session totals', () => {
  it('returns null until both projections are present', () => {
    expect(totalsFromProjections(undefined, USAGE)).toBeNull()
    expect(totalsFromProjections(STATS, undefined)).toBeNull()
  })

  it('maps whole-session counts, tokens, cache, and speed', () => {
    const totals = totalsFromProjections(STATS, USAGE)!
    expect(totals.turnCount).toBe(10)
    expect(totals.stepCount).toBe(80)
    expect(totals.context).toBe(10_000_000)
    expect(totals.output).toBe(500_000)
    expect(totals.cacheRead).toBe(8_000_000)
    expect(totals.cacheWrite).toBe(0)
    expect(totals.cacheContext).toBe(10_000_000)
    expect(totals.cacheHit).toBe(0.8)
    expect(totals.ttft).toBe(1_200)
    expect(totals.model).toBe(400_000)
    expect(totals.tool).toBe(200_000)
    expect(totals.toolWall).toBe(200_000)
    expect(totals.tps).toBe(200)
    expect(totals.wall).toBe(600_000)
  })

  it('leaves step-derived cells blank for a session without closed steps', () => {
    const empty = totalsFromProjections({ ...STATS, turns: 0, steps: 0, ttftSteps: 0 }, {
      ...USAGE, uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    })!
    expect(empty.context).toBeNull()
    expect(empty.cacheRead).toBeNull()
    expect(empty.cacheWrite).toBeNull()
    expect(empty.cacheContext).toBeNull()
    expect(empty.output).toBeNull()
    expect(empty.cacheHit).toBeNull()
    expect(empty.ttft).toBeNull()
    expect(empty.model).toBeNull()
    expect(empty.tool).toBeNull()
    expect(empty.toolWall).toBeNull()
    expect(empty.tps).toBeNull()
    expect(empty.wall).toBeNull()
  })

  it('keeps a zero-token step session explicit and drops speed without decode time', () => {
    const totals = totalsFromProjections({ ...STATS, decodeMs: 0, decodeTokens: 0 }, {
      ...USAGE, uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    })!
    expect(totals.context).toBe(0)
    expect(totals.cacheHit).toBeNull()
    expect(totals.tps).toBeNull()
  })
})
