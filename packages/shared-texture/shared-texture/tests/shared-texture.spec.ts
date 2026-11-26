/** Host `SharedTexture` registers subclasses as `ctx.sharedTexture`, and the Host Loader entry provides nothing. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SharedTexture, apply, type SharedTextureClaim } from '../src/index.ts'

class StubSharedTexture extends SharedTexture {
  readonly claimed = vi.fn<() => SharedTextureClaim>()

  override claim(): SharedTextureClaim {
    return this.claimed()
  }
}

describe('SharedTexture', () => {
  it('registers subclasses as ctx.sharedTexture and removes them when the owning fiber disposes', async () => {
    const ctx = new Context()
    const claim: SharedTextureClaim = {
      capabilities: async () => ({ supported: false, reason: 'stub' }),
      nativeSink: async () => { throw new Error('stub') },
      adapterLuid: async () => null,
      release: vi.fn(),
    }
    const fiber = ctx.plugin({
      apply(scope: Context) {
        const provider = new StubSharedTexture(scope)
        provider.claimed.mockReturnValue(claim)
      },
    })
    await fiber.await()
    expect(ctx.get('sharedTexture')).toBeInstanceOf(SharedTexture)
    expect(ctx.sharedTexture.claim()).toBe(claim)
    await fiber.dispose()
    expect(ctx.get('sharedTexture')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('mounts the Host Loader entry without providing ctx.sharedTexture', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    expect(ctx.get('sharedTexture')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
