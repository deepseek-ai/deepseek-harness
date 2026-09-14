/** Chromium acceptance of the shipped Web profile's actual Client plugin and module registries. */

import { FiberState } from '@deepseek-ai/cordis'
import type { Context, Plugin, RegistryService } from '@deepseek-ai/cordis'
import type { ClientModuleLoader, ClientModuleLoaderTarget } from '@deepseek-ai/dsh-client-modules/client'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { withDefaultWeb } from '../../cli/tests/profiles/web/tests/default-web-process.ts'
import { newEnglishPage } from './support.ts'

interface ClientObservation {
  ctx?: Context
  modules?: ClientModuleLoader
}

async function readClientRoster() {
  const observation = Reflect.get(globalThis, '__dshIsolationObservation') as ClientObservation
  const { ctx, modules } = observation
  if (ctx === undefined || modules === undefined) throw new Error('Real Client registry was not observed')
  await ctx.loader.await()
  const callbacks = new Map<object, string[]>()
  for (const [id, record] of modules.loadCache) {
    if (typeof record.exports !== 'object' || record.exports === null) continue
    for (const value of Object.values(record.exports)) {
      if (typeof value !== 'function' && (typeof value !== 'object' || value === null)) continue
      const callback = ctx.registry.resolve(value as Plugin)
      if (callback !== undefined) callbacks.set(callback, [...callbacks.get(callback) ?? [], id])
    }
  }
  return {
    entries: [...ctx.loader.entries()].map(entry => ({ name: entry.options.name, state: entry.fiber?.state })),
    plugins: [...ctx.registry.values()].flatMap(runtime => [...runtime.fibers].map(fiber => ({
      name: runtime.name ?? runtime.callback.name,
      owner: fiber.entry?.options.name,
      state: fiber.state,
      modules: callbacks.get(runtime.callback) ?? [],
    }))),
    modules: [...modules.loadCache].flatMap(([id, record]) => [id, ...record.edges]),
  }
}

function experimentalClientReferences(roster: Awaited<ReturnType<typeof readClientRoster>>): string[] {
  return [
    ...roster.entries.map(entry => entry.name),
    ...roster.plugins.flatMap(plugin => [plugin.owner ?? '', ...plugin.modules]),
    ...roster.modules,
  ].filter(name => name.startsWith('@deepseek-ai/dsh-experimental-'))
}

it('activates the actual default Client registry without experimental packages', async (test) => {
  await withDefaultWeb(test, async ({ url, request }) => {
    const browser = await chromium.launch({ timeout: test.task.timeout })
    test.onTestFinished(async () => { await browser.close() })
    try {
      const page = await newEnglishPage(browser)
      page.setDefaultTimeout(test.task.timeout)
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.addInitScript(() => {
        const observation: ClientObservation = {}
        Reflect.set(globalThis, '__dshIsolationObservation', observation)
        Object.defineProperty(globalThis, '__ModuleLoader__', {
          configurable: true,
          set(target: ClientModuleLoaderTarget) {
            Object.defineProperty(globalThis, '__ModuleLoader__', { configurable: true, writable: true, value: target })
            const create = target.create.bind(target)
            target.create = function (options) {
              const cordis = options.staticModules['@deepseek-ai/cordis'] as { RegistryService: typeof RegistryService }
              const prototype = cordis.RegistryService.prototype
              // eslint-disable-next-line @typescript-eslint/unbound-method -- apply() preserves the runtime registry receiver.
              const plugin = prototype.plugin
              // Capture the first real root and immediately restore the registry method.
              prototype.plugin = function (...args: Parameters<RegistryService['plugin']>) {
                prototype.plugin = plugin
                observation.ctx = this.ctx.root
                return plugin.apply(this, args)
              }
              const modules = create(options)
              observation.modules = modules
              return modules
            }
          },
        })
      })
      const navigation = await page.goto(url)
      expect(navigation?.status()).toBe(200)
      await page.getByRole('tree', { name: 'Sessions' }).waitFor({ state: 'visible' })
      const roster = await page.evaluate(readClientRoster)
      const host = await request('roster')
      expect(roster.entries.map(entry => entry.name).sort()).toEqual(host.client.entries.map(entry => entry.id).sort())
      expect(roster.entries.every(entry => entry.state === FiberState.ACTIVE)).toBe(true)
      expect(roster.plugins.length).toBeGreaterThan(roster.entries.length)
      expect(roster.plugins.some(plugin => plugin.modules.includes('@deepseek-ai/dsh-client-ui-layout'))).toBe(true)
      expect(experimentalClientReferences(roster)).toEqual([])
      const contaminatedHost = await request('mount-experimental-entry')
      const experimentalName = '@deepseek-ai/dsh-experimental-client-ui-agent-team'
      expect(contaminatedHost.client.entries.map(entry => entry.id)).toContain(experimentalName)
      await page.reload()
      await expect.poll(async () => {
        const current = await page.evaluate(readClientRoster)
        return current.entries.some(entry => entry.name === experimentalName && entry.state === FiberState.ACTIVE)
      }, { timeout: test.task.timeout }).toBe(true)
      const contaminated = await page.evaluate(readClientRoster)
      expect(contaminated.plugins.some(plugin => plugin.modules.includes(experimentalName)
        && plugin.state === FiberState.ACTIVE)).toBe(true)
      expect(experimentalClientReferences(contaminated)).toContain(experimentalName)
      expect(errors).toEqual([])
    } finally {
      await browser.close()
    }
  })
})
