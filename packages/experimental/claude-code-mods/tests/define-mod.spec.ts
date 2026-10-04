import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import ClaudeCodeMods, { defineMod } from '../src/index.ts'

const fibers: Fiber[] = []
afterEach(async () => {
  for (const fiber of fibers.splice(0)) await fiber.dispose()
})

describe('defineMod', () => {
  it('wraps a register function as a plugin whose config becomes the options register receives', async () => {
    const seen: unknown[] = []
    const plugin = defineMod({
      name: 'weather',
      version: '0.1.0',
      root: '/mods/weather',
      userConfig: { history: 12, unit: 'tokens' },
      register(on, options) {
        seen.push(options)
        on('turn.complete', (_$, e, next) => next(e))
      },
    })
    expect(plugin.name).toBe('claude-code-mod-weather')
    expect(plugin.inject).toEqual(['claudeCodeMods'])
    expect(plugin.definition).toMatchObject({ name: 'weather', version: '0.1.0', root: '/mods/weather', options: { history: 12, unit: 'tokens' } })
    expect(typeof plugin.definition.register).toBe('function')
    expect(plugin.Config({})).toEqual({})
    expect(plugin.Config({ history: 3, tags: ['a'] })).toEqual({ history: 3, tags: ['a'] })
    expect(() => plugin.Config({ history: { nested: true } } as never)).toThrow()

    const ctx = new Context()
    fibers.push(ctx.fiber)
    await ctx.plugin(ClaudeCodeMods, {})
    const fiber = await ctx.plugin(plugin, { history: 3 })
    await fiber.await()
    expect(seen).toEqual([{ history: 3, unit: 'tokens' }])
    expect(ctx.claudeCodeMods.mods.map(mod => ({ name: mod.name, version: mod.version, root: mod.root }))).toEqual([
      { name: 'weather', version: '0.1.0', root: '/mods/weather' },
    ])
    await fiber.dispose()
    expect(ctx.claudeCodeMods.mods).toEqual([])
  })

  it('removes a mod whose plugin was disposed while register was still running', async () => {
    let release: (() => void) | undefined
    const slow = defineMod({
      name: 'slow',
      register: () => new Promise<void>((resolve) => { release = resolve }),
    })
    const ctx = new Context()
    fibers.push(ctx.fiber)
    await ctx.plugin(ClaudeCodeMods, {})
    const fiber = ctx.plugin(slow, {})
    await vi.waitFor(() => { expect(release).toBeDefined() })
    const disposing = fiber.dispose()
    release?.()
    await disposing
    await vi.waitFor(() => { expect(ctx.claudeCodeMods.mods).toEqual([]) })
  })

  it('leaves version and root to the host when the spec names none, and fails the mount when register throws', async () => {
    const bare = defineMod({ name: 'bare', register: () => {} })
    expect(bare.definition).toMatchObject({ name: 'bare', options: {} })
    expect(Object.keys(bare.definition).sort()).toEqual(['name', 'options', 'register'])
    const broken = defineMod({ name: 'broken', register: () => { throw new Error('no thanks') } })
    const ctx = new Context()
    fibers.push(ctx.fiber)
    await ctx.plugin(ClaudeCodeMods, {})
    const fiber = await ctx.plugin(bare, {})
    await fiber.await()
    expect(ctx.claudeCodeMods.mods.map(mod => mod.root)).toEqual([process.cwd()])
    const mounting = Promise.resolve(ctx.plugin(broken, {})).then(fiber => fiber.await())
    await expect(mounting).rejects.toThrow(/broken: hooks module did not load: register threw no thanks/)
    expect(ctx.claudeCodeMods.mods.map(mod => mod.name)).toEqual(['bare'])
  })
})
