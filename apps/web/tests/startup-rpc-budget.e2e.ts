// Cold boot bounds shared settings reads and the Web Search credential reads
// caused by their publication waves. No model call or replay fixture is involved.
import type { Browser, Page, Request, Route } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

/** One eager read plus one first-connection reset closes the pre-subscription commit window. */
const DESCRIBE_BUDGET = 2
/** One eager Web Search credential read plus one per settings publication wave. */
const WEB_SEARCH_CREDENTIAL_BUDGET = 3

let scaffold: WebScaffold
let browser: Browser
let page: Page

beforeAll(async () => {
  scaffold = await launchWebScaffold()
  browser = await chromium.launch()
})

afterAll(async () => {
  await page?.close()
  await browser?.close()
  await scaffold?.close()
})

describe('startup RPC budget', () => {
  it('keeps settings and Web Search credential reads at their publication counts', async () => {
    page = await newEnglishPage(browser)
    watchConsole(page)
    const calls: string[] = []
    const credentials: string[][] = []
    const pending = new Set<Request>()
    const webSearchRequests = new Set<Request>()
    const credentialStarted = Promise.withResolvers<undefined>()
    let settingsFinished = 0
    let webSearchFinished = 0
    // Both settings answers must reach the card after it subscribes, regardless
    // of plugin load order. The eager credential request proves that subscription.
    const holdSettings = async (route: Route): Promise<void> => {
      await credentialStarted.promise
      await route.continue()
    }
    await page.route('**/api/settings/describe', holdSettings)
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (!url.pathname.startsWith('/api/')) return
      const method = url.pathname.slice('/api/'.length)
      calls.push(method)
      pending.add(request)
      if (method === 'credentials/describe') {
        const body = request.postDataJSON() as { payload: { args: { refs: string[] } } }
        const refs = body.payload.args.refs
        credentials.push(refs)
        // Models requests batch references; the Web Search card asks for this one key.
        if (refs.length === 1 && refs[0] === 'DEEPSEEK_API_KEY') {
          webSearchRequests.add(request)
          credentialStarted.resolve(undefined)
        }
      }
    })
    page.on('requestfinished', (request) => {
      pending.delete(request)
      if (new URL(request.url()).pathname === '/api/settings/describe') settingsFinished++
      if (webSearchRequests.has(request)) webSearchFinished++
    })
    page.on('requestfailed', request => pending.delete(request))
    try {
      await page.goto(scaffold.authenticatedUrl)
      await page.getByRole('textbox', { name: 'Choose workspace' }).waitFor({ timeout: 30_000 })
      await expect.poll(() => settingsFinished, { timeout: 30_000 }).toBeGreaterThanOrEqual(DESCRIBE_BUDGET)
      await expect.poll(() => webSearchFinished, { timeout: 30_000 }).toBeGreaterThanOrEqual(WEB_SEARCH_CREDENTIAL_BUDGET)
      await expect.poll(() => pending.size, { timeout: 30_000 }).toBe(0)
      const describeCount = calls.filter(method => method === 'settings/describe').length
      expect(describeCount, `startup /api calls:\n${calls.join('\n')}`).toBe(DESCRIBE_BUDGET)
      expect(webSearchRequests.size, `startup credential references:\n${JSON.stringify(credentials)}`).toBe(WEB_SEARCH_CREDENTIAL_BUDGET)
    } finally {
      credentialStarted.resolve(undefined)
      await page.unrouteAll({ behavior: 'wait' })
    }
  })
})
