/** Vendor HMR containment of Include refresh rejections. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { expect, it, onTestFinished, vi } from 'vitest'

// A literal import would add vendor HMR's `Context.hmr` declaration to the
// repository type program, where DSH HMR declares the same property.
const vendorHmr: string = '@deepseek-ai/cordis-plugin-hmr'

it('logs a rejected Include refresh instead of leaving it unhandled', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-vendor-hmr-include-')))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(dir).href + '/'
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }) })
  await ctx.plugin(Loader)
  await ctx.plugin(Timer)
  ctx.loader.builtins.include = Include
  const file = join(dir, 'nested.yml')
  writeFileSync(file, '[]\n')
  const id = await ctx.loader.create({ name: 'cordis:include', config: { path: './nested.yml' } })
  await ctx.loader.await()
  const { default: Hmr } = await import(vendorHmr) as { default: Plugin }
  await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
  // The service keeps its chokidar watcher private; the test drives its change listener directly.
  const watcher = Reflect.get(ctx.get('hmr') as object, 'watcher') as { emit(event: 'change', path: string): boolean }
  const include = ctx.loader.resolve(id).subtree as Include
  const failure = new Error('config file has 1 unsaved change(s)')
  const refresh = vi.spyOn(include, 'refresh').mockRejectedValue(failure)
  const warn = vi.spyOn(ctx.logger, 'warn')
  const unhandled = vi.fn()
  process.on('unhandledRejection', unhandled)
  onTestFinished(() => { process.off('unhandledRejection', unhandled) })
  watcher.emit('change', file)
  await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(failure) })
  await new Promise(resolve => setImmediate(resolve))
  expect(refresh).toHaveBeenCalledOnce()
  expect(unhandled).not.toHaveBeenCalled()
})
