/** The shipped Web profile executes opt-in package scripts in separate same-origin Realms. */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./client-isolation.overlay.yml', import.meta.url))
const FORGE = new URL('../../../packages/experimental/forge-bundle/', import.meta.url)
const FIXTURE = fileURLToPath(new URL('./fixtures/plugins/fixture-live-client', import.meta.url))
const LIVE = '@fixture/live-client'
const SCHEDULE = '@deepseek-ai/dsh-client-ui-schedule'
const FORGE_UI = '@deepseek-ai/dsh-experimental-client-ui-forge'
const SIDEBAR = '@deepseek-ai/dsh-client-ui-sidebar'

it('loads opted-in packages in separate iframe Realms and replaces the iframe of the rebuilt package', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'dsh-client-isolation-'))
  onTestFinished(() => rm(fixture, { recursive: true, force: true }))
  await cp(FIXTURE, fixture, { recursive: true })
  const scaffold = await launchWebScaffold({
    extraOverlayPath: [fileURLToPath(new URL('cordis.patch.yml', FORGE)), OVERLAY],
    extraInstallAnchors: [fileURLToPath(new URL('package.json', FORGE)), join(fixture, 'package.json')],
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const tripwire = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'client-isolation'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: 'Automation tasks', exact: true }).click({ timeout: 60_000 })
  await page.getByRole('heading', { name: 'Automation tasks', exact: true }).waitFor()

  const frame = (id: string) => page.locator(`iframe[data-realm^="${id}#"]`)
  const frameRevision = async (id: string) => {
    const observed = await frame(id).contentFrame().locator('html').evaluate(() => ({
      separate: window !== window.parent,
      facade: '__ModuleLoader__' in window && '__ModuleLoader__' in window.parent
        && window.__ModuleLoader__ === window.parent.__ModuleLoader__,
      scripts: performance.getEntriesByType('resource').map(entry => entry.name)
        .filter(name => new URL(name).pathname.startsWith('/plugins/')),
    }))
    expect(observed).toEqual({ separate: true, facade: true, scripts: [expect.stringContaining(`/plugins/??${id}/client.js&rev=`)] })
    const revision = new URL(observed.scripts[0]!).searchParams.get('rev')
    expect(revision).toBeTruthy()
    return revision
  }
  const boot = await page.evaluate(() => {
    const { entries, batches } = (window as { __DSH_BOOT__?: WebBootGraph }).__DSH_BOOT__!
    return {
      isolated: Object.fromEntries(entries.filter(row => row.isolation !== undefined).map(row => [row.id, row.isolation])),
      batched: batches.flatMap(batch => batch.entries),
      main: performance.getEntriesByType('resource').map(entry => entry.name),
    }
  })
  expect(boot.isolated).toEqual({ [SCHEDULE]: 'script', [FORGE_UI]: 'script' })
  expect(boot.batched).toContain(SIDEBAR)
  expect(boot.main).toContainEqual(expect.stringContaining(`${SIDEBAR}/client.js`))
  for (const id of [SCHEDULE, FORGE_UI]) {
    expect(boot.batched).not.toContain(id)
    expect(boot.main).not.toContainEqual(expect.stringContaining(`${id}/client.js`))
    await frameRevision(id)
  }
  const scheduleFrame = await frame(SCHEDULE).elementHandle()

  const liveId = await scaffold.ctx.loader.create({ name: LIVE, __unstable_enable_client_isolation: 'script' })
  await page.getByText('Live plugin enabled', { exact: true }).waitFor()
  const original = await frame(LIVE).elementHandle()
  const originalRevision = await frameRevision(LIVE)
  const file = join(fixture, 'client.js')
  const source = await readFile(file, 'utf8')
  await writeFile(file, source.replace('Live plugin enabled', 'Rebuilt live plugin enabled'))
  scaffold.ctx.clientModules.rebuilt(LIVE)
  await page.getByText('Rebuilt live plugin enabled', { exact: true }).waitFor()
  expect(await frameRevision(LIVE)).not.toBe(originalRevision)
  expect(await original!.evaluate(node => node.isConnected)).toBe(false)
  expect(await scheduleFrame!.evaluate(node => node.isConnected)).toBe(true)

  scaffold.ctx.loader.remove(liveId)
  await frame(LIVE).waitFor({ state: 'detached' })
  await page.locator('[data-live-client]').waitFor({ state: 'detached' })
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
}, 120_000)
