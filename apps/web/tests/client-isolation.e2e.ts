/** The shipped Web profile executes opt-in package scripts in separate same-origin Realms. */
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./client-isolation.overlay.yml', import.meta.url))
const FORGE = new URL('../../../packages/experimental/forge-bundle/', import.meta.url)
const ISOLATED: Readonly<Record<string, string>> = {
  '@deepseek-ai/dsh-client-ui-schedule': 'script',
  '@deepseek-ai/dsh-experimental-client-ui-forge': 'script',
}

let scaffold: WebScaffold
let browser: Browser
let page: Page
let tripwire: ReturnType<typeof watchConsole>

beforeAll(async () => {
  scaffold = await launchWebScaffold({
    extraOverlayPath: [fileURLToPath(new URL('cordis.patch.yml', FORGE)), OVERLAY],
    extraInstallAnchors: [fileURLToPath(new URL('package.json', FORGE))],
  })
  browser = await chromium.launch()
  page = await newEnglishPage(browser)
  tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await scaffold?.close()
})

it('executes each isolated package bundle in its own iframe Realm sharing the page registration facade', async () => {
  onTestFailed(async () => { await saveFailureShot(page, 'client-isolation') })
  await page.waitForFunction(count => document.querySelectorAll('iframe[data-realm]').length >= count, Object.keys(ISOLATED).length, { timeout: 60_000 })
  await page.getByRole('button', { name: 'Automation tasks', exact: true }).click()
  await page.getByRole('heading', { name: 'Automation tasks', exact: true }).waitFor()
  const observed = await page.evaluate(() => {
    type Graph = { entries: { id: string; isolation?: string }[]; batches: { entries: string[] }[] }
    const page = window as { __DSH_BOOT__?: Graph; __ModuleLoader__?: unknown }
    const boot = page.__DSH_BOOT__!
    const resources = (target: Window): string[] => target.performance.getEntriesByType('resource')
      .map(entry => new URL(entry.name).pathname + new URL(entry.name).search)
    return {
      isolated: boot.entries.filter(entry => entry.isolation !== undefined).map(entry => [entry.id, entry.isolation]),
      batched: boot.batches.flatMap(batch => batch.entries),
      main: resources(window),
      frames: [...document.querySelectorAll<HTMLIFrameElement>('iframe[data-realm]')].map(frame => ({
        realm: frame.dataset.realm,
        separate: frame.contentWindow !== window,
        facade: (frame.contentWindow as { __ModuleLoader__?: unknown } | null)?.__ModuleLoader__ === page.__ModuleLoader__,
        scripts: resources(frame.contentWindow!).filter(name => name.startsWith('/plugins/')),
      })),
    }
  })
  expect(Object.fromEntries(observed.isolated)).toEqual(ISOLATED)
  for (const id of Object.keys(ISOLATED)) {
    expect(observed.batched).not.toContain(id)
    expect(observed.main.some(name => name.includes(`${id}/client.js`))).toBe(false)
    const frames = observed.frames.filter(frame => frame.realm?.startsWith(`${id}#`) === true)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ separate: true, facade: true })
    expect(frames[0]!.scripts).toEqual([expect.stringMatching(new RegExp(`^/plugins/\\?\\?${id.replace(/[/@-]/g, '\\$&')}/client\\.js&rev=`))])
  }
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
}, 120_000)
