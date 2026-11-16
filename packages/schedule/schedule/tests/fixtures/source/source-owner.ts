/** Loader-owned subscriptions connecting two borrowed source instances to a stored automation task. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { AutomationSource } from '@deepseek-ai/dsh-schedule/source'
import type { AutomationCandidate, SourceOutput } from '@deepseek-ai/dsh-schedule'
import type { ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import type { ObservationSource } from './world.ts'

class CombinedObservation extends AutomationSource<AutomationCandidate> {
  private left: string | undefined
  private right: string | undefined
  readonly connectLeft = this.createInput<string>(async (value) => {
    this.left = value
    await this.publishPair()
  }).connect

  readonly connectRight = this.createInput<string>(async (value) => {
    this.right = value
    await this.publishPair()
  }).connect

  constructor(left: ObservationSource, right: ObservationSource) {
    super()
    this.connectLeft(left.output)
    this.connectRight(right.output)
  }

  private async publishPair(): Promise<void> {
    if (this.left === undefined || this.right === undefined) return
    await this.emit({ text: `Left: ${this.left}\nRight: ${this.right}` })
  }
}

/**
 * Bind a task input in a child whose disposal the composer orders after its source drains.
 * @param ctx - Composer context that already declares the required Schedule dependency.
 * @param id - Stored task receiving candidate text.
 * @param output - Composite output, kept usable until its accepted inputs settle.
 * @returns The native child; its original disposer transfers into the composer's ordered effect.
 */
export function bindTaskInput(
  ctx: Context, id: ScheduleId, output: SourceOutput<AutomationCandidate>,
): Fiber & PromiseLike<Fiber> {
  return ctx.inject([], (scope) => {
    scope.schedule.input(id).connect(output)
  })
}

/** Test composition name. */
export const name = 'source-composition-owner'
/** Schedule and borrowed producer instances must exist before connecting. */
export const inject = ['schedule', 'sourceComposition']

/**
 * Bind the two concrete instances through a composite to their stored task.
 * @param ctx - Context whose Loader entry owns the subscriptions, not the borrowed producers.
 */
export function apply(ctx: Context): void {
  const world = ctx.sourceComposition
  ctx.effect(function* () {
    const composite = new CombinedObservation(world.left, world.right)
    const receiver = bindTaskInput(ctx, world.task.id, composite.output)
    yield receiver.dispose
    yield () => composite.dispose()
  }, 'source-composition.subscriptions()')
}
