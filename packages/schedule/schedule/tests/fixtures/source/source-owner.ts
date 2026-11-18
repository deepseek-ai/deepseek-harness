/** Loader-owned ordinary producers submitting observations to their stored automation tasks. */
import type { Context } from '@deepseek-ai/cordis'
import { ObservationSource } from './world.ts'

/** Test producer owner name. */
export const name = 'source-composition-owner'
/** The task runtime and persisted fixture world must exist before producing observations. */
export const inject = ['schedule', 'sourceComposition']

/**
 * Own two instances of the same producer class, each submitting directly to its task.
 * @param ctx - Context whose activity controls new submissions and whose cleanup drains accepted work.
 */
export function apply(ctx: Context): void {
  const world = ctx.sourceComposition
  ctx.effect(() => {
    const schedule = ctx.schedule
    const first = world.first = new ObservationSource(candidate => schedule.submit(world.firstTask.id, candidate))
    const second = world.second = new ObservationSource(candidate => schedule.submit(world.secondTask.id, candidate))
    return async () => { await Promise.all([first.drain(), second.drain()]) }
  })
}
