/**
 * Renderer invariant companion: the 'slots/changed' emission-order audit —
 * a fired key must already carry a bumped version (emission follows the
 * applied mutation), bogus payloads fail loud, foreign events pass.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as RendererInvariant from '../src/invariant.ts'
import { SlotRegistry } from '../src/client/registry.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(RendererInvariant).await()
  return ctx
}

const emit = (ctx: Context, event: string, ...args: unknown[]): void => {
  Reflect.apply(ctx.emit.bind(ctx), undefined, [event, ...args])
}

describe('renderer slots/changed invariant', () => {
  it('passes foreign events and a legitimate mutation-then-emission sequence', async () => {
    const ctx = await setup()
    expect(() => { emit(ctx, 'unrelated/event', 'x') }).not.toThrow()
    await ctx.plugin(SlotRegistry).await() // fiber must reach ACTIVE — the audit reads strict ctx.get
    // A real registration bumps the version first and re-emits through
    // onMutate — the audit sees version > 0 and stays quiet. (Erased call:
    // the typed register face rides the wave-1 ui-slots types.)
    const slots = ctx.slots as { register(options: object, component: unknown): () => void }
    expect(() => slots.register({ name: 'root' }, () => null)).not.toThrow()
  })

  it('fails loud on a missing key and on an emission with no applied mutation', async () => {
    const ctx = await setup()
    expect(() => { emit(ctx, 'slots/changed', '') }).toThrow(/without a slot key/)
    expect(() => { emit(ctx, 'slots/changed', 42) }).toThrow(/without a slot key/)
    await ctx.plugin(SlotRegistry).await()
    // Hand-emitted key that never saw a mutation: version 0 → violation.
    expect(() => { emit(ctx, 'slots/changed', 'never-mutated') })
      .toThrow(/before any mutation bumped its version/)
  })

  it('stays quiet when no slots service is mounted (nothing to audit against)', async () => {
    const ctx = await setup()
    expect(() => { emit(ctx, 'slots/changed', 'any-key') }).not.toThrow()
  })
})
