/**
 * The spring a floating panel follows back inside the viewport after a release
 * past an edge. Pure and clock-free: the caller supplies each frame's elapsed
 * time, so trajectories are deterministic for a given sequence of frames.
 */

/** One axis of a spring: where it is and how fast it moves, in CSS pixels and pixels per second. */
export interface SpringAxis {
  readonly position: number
  readonly velocity: number
}

/** Seconds the spring takes for one undamped period; sets its stiffness. */
const RESPONSE = 0.32
/** Below 1, so the return overshoots slightly inward (about 3.5%), which always stays legal. */
const DAMPING_RATIO = 0.72
const OMEGA = 2 * Math.PI / RESPONSE
/** Fixed integration step, so the motion does not depend on the frame rate. */
const SUBSTEP = 1 / 480
/** Position and speed below which an axis counts as at rest. */
const REST_DISTANCE = 1
const REST_SPEED = 60

/** Fastest release velocity a return starts with, in pixels per second. */
export const SPRING_MAX_VELOCITY = 1500
/** A return ends at its target after this long even if it is still moving. */
export const SPRING_DEADLINE_MS = 900
/** A frame longer than this is clamped, so a slow frame cannot inject a jump. */
export const SPRING_MAX_FRAME_MS = 64
/** A gap longer than this (sleep, a stalled tab) ends the return at its target instead of animating catch-up. */
export const SPRING_STALL_MS = 250

/**
 * Advance one axis by an elapsed time, in equal substeps no longer than `SUBSTEP`
 * (semi-implicit Euler).
 * @param axis - the axis state.
 * @param target - the position the spring pulls toward.
 * @param dtSeconds - elapsed time, already clamped by the caller.
 * @returns the advanced state.
 */
export function stepSpring(axis: SpringAxis, target: number, dtSeconds: number): SpringAxis {
  const steps = Math.max(1, Math.ceil(dtSeconds / SUBSTEP))
  const h = dtSeconds / steps
  let { position, velocity } = axis
  for (let step = 0; step < steps; step++) {
    velocity += (-OMEGA * OMEGA * (position - target) - 2 * DAMPING_RATIO * OMEGA * velocity) * h
    position += velocity * h
  }
  return { position, velocity }
}

/**
 * The velocity an axis starts its return with. An axis already at its target
 * keeps still. Outward speed is capped at `omega0 * (reach - |offset|)`: the
 * spring carries a start offset `d` and speed `v` at most `d + 0.46 * v / omega0`
 * from its target, so the whole return stays within `reach`.
 * @param position - where the axis is drawn at release.
 * @param target - the position the spring pulls toward.
 * @param velocity - the drawn release velocity, in pixels per second.
 * @param reach - the farthest the return may be from the target.
 * @returns the starting velocity.
 */
export function launchVelocity(position: number, target: number, velocity: number, reach: number): number {
  const offset = position - target
  if (offset === 0) return 0
  if (Math.sign(velocity) !== Math.sign(offset)) return velocity
  return Math.sign(offset) * Math.min(Math.abs(velocity), OMEGA * Math.max(0, reach - Math.abs(offset)))
}

/**
 * Whether an axis has come to rest at its target.
 * @param axis - the axis state.
 * @param target - the spring's target.
 * @returns true within `REST_DISTANCE` of the target and slower than `REST_SPEED`.
 */
export function springSettled(axis: SpringAxis, target: number): boolean {
  return Math.abs(axis.position - target) <= REST_DISTANCE && Math.abs(axis.velocity) <= REST_SPEED
}
