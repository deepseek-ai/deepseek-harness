/** The Client plugin provides the host shell's texture bridge as `ctx.sharedTexture` for as long as it is mounted. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, type SharedTextureClientExport } from '../src/client/index.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('shared-texture Client plugin', () => {
  it('provides dshDesktop.textures as ctx.sharedTexture and withdraws it when the plugin unloads', async () => {
    const textures: SharedTextureClientExport = { onFrame: vi.fn(() => () => {}) }
    vi.stubGlobal('dshDesktop', { textures })
    const ctx = new Context()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    expect(ctx.get('sharedTexture')).toBe(textures)
    await fiber.dispose()
    expect(ctx.get('sharedTexture')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it.each([
    ['without a Desktop product API', undefined],
    ['when the Desktop product API exposes no textures', {}],
  ])('provides nothing %s', async (_case, desktop) => {
    vi.stubGlobal('dshDesktop', desktop)
    const ctx = new Context()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    expect(ctx.get('sharedTexture')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
