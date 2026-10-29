/**
 * The edge-recovery spring: settling, the inward overshoot bound, frame-rate
 * independence, and determinism, all with fixed frame steps.
 */
import { describe, expect, it } from 'vitest'
import { launchVelocity, SPRING_DEADLINE_MS, SPRING_MAX_VELOCITY, springSettled, stepSpring } from '../src/engine/spring.ts'
import type { SpringAxis } from '../src/engine/spring.ts'

/** Analytic overshoot bound for the shipped damping ratio, exp(-pi*zeta/sqrt(1-zeta^2)). */
const OVERSHOOT_BOUND = Math.exp(-Math.PI * 0.72 / Math.sqrt(1 - 0.72 ** 2))

/** Run a return at a fixed frame rate until it rests; positions sampled once per frame. */
function settle(start: SpringAxis, target: number, hz: number): { readonly ms: number; readonly positions: number[] } {
  let axis = start
  const positions: number[] = []
  for (let frame = 1; frame <= 1000; frame++) {
    axis = stepSpring(axis, target, 1 / hz)
    positions.push(axis.position)
    if (springSettled(axis, target)) return { ms: frame * 1000 / hz, positions }
  }
  throw new Error('spring did not settle')
}

describe('stepSpring', () => {
  it('returns a 200 px overflow inside the deadline with an inward overshoot within the analytic bound', () => {
    const { ms, positions } = settle({ position: -200, velocity: 0 }, 0, 60)
    expect(ms).toBeLessThan(SPRING_DEADLINE_MS)
    expect(ms).toBeCloseTo(366.7, 0)
    const overshoot = Math.max(...positions) / 200
    expect(overshoot).toBeGreaterThan(0)
    expect(Math.abs(overshoot - OVERSHOOT_BOUND)).toBeLessThan(0.01)
  })

  it('moves the same way whatever the frame rate, because it integrates in fixed substeps', () => {
    const reference = settle({ position: 120, velocity: 0 }, 0, 60).ms
    for (const hz of [30, 120]) {
      const { ms } = settle({ position: 120, velocity: 0 }, 0, hz)
      expect(Math.abs(ms - reference)).toBeLessThanOrEqual(1000 / 30)
    }
  })

  it('carries a release velocity: a fling outward travels further before it returns', () => {
    const still = settle({ position: 60, velocity: 0 }, 0, 60).positions
    const flung = settle({ position: 60, velocity: 1500 }, 0, 60).positions
    expect(Math.max(...flung)).toBeGreaterThan(Math.max(...still))
  })

  it('is deterministic for the same inputs', () => {
    expect(settle({ position: -90, velocity: 400 }, 10, 60)).toEqual(settle({ position: -90, velocity: 400 }, 10, 60))
  })

  it('stays put at its target', () => {
    expect(stepSpring({ position: 5, velocity: 0 }, 5, 1 / 60)).toEqual({ position: 5, velocity: 0 })
  })
})

describe('launchVelocity', () => {
  it('keeps an axis that is already at its target still', () => {
    expect(launchVelocity(40, 40, 900, 120)).toBe(0)
  })

  it('passes an inward velocity through unchanged', () => {
    expect(launchVelocity(60, 0, -900, 120)).toBe(-900)
    expect(launchVelocity(-60, 0, 900, 120)).toBe(900)
  })

  it('caps an outward velocity on either side, to nothing once the axis is at the reach', () => {
    expect(launchVelocity(119, 0, 1500, 120)).toBeLessThan(1500)
    expect(launchVelocity(-119, 0, -1500, 120)).toBeGreaterThan(-1500)
    expect(launchVelocity(130, 0, 1500, 120)).toBe(0)
  })

  it('keeps every return within the reach of its target, however fast the fling', () => {
    for (let offset = 1; offset < 120; offset += 1) {
      const velocity = launchVelocity(offset, 0, SPRING_MAX_VELOCITY, 120)
      const { positions } = settle({ position: offset, velocity }, 0, 60)
      expect(Math.max(offset, ...positions)).toBeLessThan(120)
    }
  })
})

describe('springSettled', () => {
  it('needs both closeness and slowness', () => {
    expect(springSettled({ position: 0.5, velocity: 10 }, 0)).toBe(true)
    expect(springSettled({ position: 2, velocity: 0 }, 0)).toBe(false)
    expect(springSettled({ position: 0, velocity: 100 }, 0)).toBe(false)
  })
})
