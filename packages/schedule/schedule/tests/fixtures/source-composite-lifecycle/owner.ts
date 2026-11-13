/** Loader-owned composite with a controlled pause before its derived output. */
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { bindTaskInput } from '../source/source-owner.ts'
import { AutomationSource } from '@deepseek-ai/dsh-schedule/source'
import type { AutomationCandidate } from '@deepseek-ai/dsh-schedule'
import type LifecycleWorld from './world.ts'

class GatedComposite extends AutomationSource<AutomationCandidate> {
  private readonly world: LifecycleWorld
  readonly connect = this.createInput<string>(async (value) => {
    this.world.events.push('input-entered')
    this.world.entered.resolve(undefined)
    await this.world.release.promise
    this.world.events.push('emit-start')
    await this.emit({ text: value })
    this.world.events.push('emit-done')
  }).connect

  constructor(world: LifecycleWorld) {
    super()
    this.world = world
  }

  override async dispose(): Promise<void> {
    this.world.events.push('composite-draining')
    this.world.draining.resolve(undefined)
    await super.dispose()
    this.world.events.push('composite-drained')
  }
}

/** Test-only Loader composer. */
export const name = 'source-composite-lifecycle-owner'
/** The parent retains the Schedule dependency until its composite drains. */
export const inject = ['schedule', 'sourceCompositeLifecycle']

/** @param ctx - Loader-owned composer context. */
export async function apply(ctx: Context): Promise<void> {
  const world = ctx.sourceCompositeLifecycle
  ctx.effect(function* () {
    const composite = new GatedComposite(world)
    composite.connect(world.producer.output)
    const receiver = bindTaskInput(ctx, world.task.id, composite.output)
    world.receiver = receiver
    yield receiver.dispose
    yield () => composite.dispose()
  }, 'source-composite-lifecycle.owner()')
  const receiver = world.receiver
  assert.ok(receiver)
  await receiver.await()
  receiver.ctx.effect(() => () => { world.events.push('receiver-cleanup') })
}
