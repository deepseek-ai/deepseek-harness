/** A parse Worker failure surfaces as a fetch failure of its index. */
import { Context, Service } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'

vi.mock('../src/parse-thread.ts', () => ({ parseIndexInWorker: () => Promise.reject(new Error('parser crashed')) }))

const { default: PluginMarket } = await import('../src/index.ts')

it('reports a parse Worker failure as plugin-market/fetch-failed', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}'))))
  onTestFinished(() => { vi.unstubAllGlobals() })
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  class Manager extends Service {
    constructor(inner: Context) { super(inner, 'pluginManager') }
    listBundles() { return Promise.resolve([]) }
    listVersionExemptions() { return { exemptions: {}, warnings: [] } }
  }
  await ctx.plugin(Manager)
  await ctx.plugin(PluginMarket, { indexes: ['https://market.example/index.json'] })
  const failure = await ctx.pluginMarket.search('https://market.example/index.json', { sort: { kind: 'index' }, offset: 0, limit: 1 })
    .then(() => { throw new Error('resolved') }, (error: unknown) => remoteErrorOf(error))
  expect(failure).toMatchObject({ code: 'plugin-market/fetch-failed', details: { reason: 'parser crashed' } })
})
