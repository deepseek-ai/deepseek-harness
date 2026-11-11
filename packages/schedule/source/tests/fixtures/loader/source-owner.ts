/** Loader-owned subscriptions connecting two borrowed source instances to a stored automation task. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-schedule'
import { AutomationSource } from '@deepseek-ai/dsh-source/source'
import type { AutomationCandidate, SourceConnection } from '@deepseek-ai/dsh-source'
import type { ObservationSource } from './world.ts'

class CombinedObservation extends AutomationSource<AutomationCandidate> {
  private left: string | undefined
  private right: string | undefined
  private readonly inputs: SourceConnection[]

  constructor(left: ObservationSource, right: ObservationSource) {
    super()
    this.inputs = [
      left.subscribe(value => this.observeLeft(value)),
      right.subscribe(value => this.observeRight(value)),
    ]
  }

  async observeLeft(value: string): Promise<void> {
    this.left = value
    await this.publishPair()
  }

  async observeRight(value: string): Promise<void> {
    this.right = value
    await this.publishPair()
  }

  private async publishPair(): Promise<void> {
    if (this.left === undefined || this.right === undefined) return
    await this.emit({ text: `Left: ${this.left}\nRight: ${this.right}` })
  }

  override async dispose(): Promise<void> {
    await Promise.all(this.inputs.map(input => input.dispose()))
    await super.dispose()
  }
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
    const connection = ctx.schedule.connectSource(composite, world.task.id)
    yield connection.dispose
    yield () => composite.dispose()
  }, 'source-composition.subscriptions()')
}
