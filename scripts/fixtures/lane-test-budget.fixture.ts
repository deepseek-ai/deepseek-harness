/**
 * Waits that end only through the lane budget in force. Runs only inside the
 * Vitest child that scripts/lane-test-budget.spec.ts spawns.
 */
import { beforeEach, describe, expect, it } from 'vitest'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('lane test budget fixture', () => {
  it('per-test budget', async () => {
    await sleep(600)
  })

  // The predicate counts attempts instead of reading a clock, so a host stall
  // cannot turn a budget-ended poll into a pass: a 10 ms interval fits at most
  // ~20 attempts into a 200 ms budget and ~100 into Vitest's 1000 ms default,
  // both far below the target, and the case's own budget stays above both so
  // the poll budget is what ends the assertion. The reported duration is then
  // the poll budget (or longer under load), which the spawning spec reads.
  it('expect.poll budget', { timeout: 5_000 }, async () => {
    let attempts = 0
    await expect.poll(() => { attempts += 1; return attempts }, { interval: 10 }).toBeGreaterThan(10_000)
  })

  describe('hook budget', () => {
    beforeEach(async () => {
      await sleep(600)
    })

    it('runs after the hook', () => {})
  })
})
