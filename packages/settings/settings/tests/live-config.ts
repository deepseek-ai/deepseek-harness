/** Test fixtures using the same Loader updates as profile reconciliation. */
import { Context, resolveConfig, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import { expect, vi } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'

function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const before = result[key]
    result[key] = before && typeof before === 'object' && !Array.isArray(before)
      && value && typeof value === 'object' && !Array.isArray(value)
      ? merge(before as Record<string, unknown>, value as Record<string, unknown>) : value
  }
  return result
}

/** Mount a consumer behind Loader and edit its raw configuration. */
export async function liveConfig(ctx: Context, plugin: Plugin, initial: object = {}) {
  if (ctx.get('loader') === undefined) {
    await ctx.plugin(Loader)
  }
  const name = `live-${Object.keys(ctx.loader.builtins).length}`
  ctx.loader.builtins[name] = plugin
  const options = { id: plugin.name ?? name, name: `cordis:${name}`, config: initial }
  const id = await ctx.loader.create(options)
  const entry = ctx.loader.resolve(id)
  await entry.fiber!.await()
  const replace = async (next: Record<string, unknown>) => {
    const fiber = entry.fiber!
    resolveConfig(fiber.runtime!, fiber.ctx.waterfall(fiber, 'internal/config', next, () => next))
    await entry.update({ config: next })
    await entry.fiber!.await()
    ctx.emit('app-boot/config-reload')
  }
  return {
    entry,
    fiber: entry.fiber!,
    update: (patch: Record<string, unknown>) => replace(merge(entry.options.config as Record<string, unknown>, patch)),
    replace,
  }
}

/** Assert a plugin keeps its own fiber off the generated pages while Settings is mounted and withdraws on disposal.
 * @param mount Starts the plugin under test in the supplied context and returns its fiber.
 */
export async function omitsGeneratedPage(mount: (ctx: Context) => Fiber | Promise<Fiber>): Promise<void> {
  const ctx = new Context()
  const release = vi.fn()
  const configure = vi.fn(() => release)
  ctx.provide('settings', { configure } as never)
  const fiber = await mount(ctx)
  await ctx.fiber.await()
  expect(configure).toHaveBeenCalledOnce()
  const [policy, owner] = configure.mock.calls[0] as unknown[]
  expect(policy).toEqual({ auto: false })
  // Identity only: printing a Fiber walks Context proxies.
  expect(Object.is(owner, fiber)).toBe(true)
  await fiber.dispose()
  expect(release).toHaveBeenCalledOnce()
}
