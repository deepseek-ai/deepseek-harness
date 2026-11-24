/** The shipped Web profile executes opt-in package scripts in separate same-origin Realms. */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { acknowledgeReloadConnectionLoss, launchWebScaffold, watchConsole } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./client-isolation.overlay.yml', import.meta.url))
const FORGE = new URL('../../../packages/experimental/forge-bundle/', import.meta.url)
const ISOLATED: Readonly<Record<string, string>> = {
  '@deepseek-ai/dsh-client-ui-schedule': 'script',
  '@deepseek-ai/dsh-experimental-client-ui-forge': 'script',
}

const FIXTURE = fileURLToPath(new URL('./fixtures/plugins/fixture-live-client', import.meta.url))
const LIVE = '@fixture/live-client'
const SCHEDULE = '@deepseek-ai/dsh-client-ui-schedule'
const FORGE_UI = '@deepseek-ai/dsh-experimental-client-ui-forge'

it('uses the first row for each package until reload and replaces rebuilt code in that mode', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'dsh-client-isolation-'))
  onTestFinished(() => rm(fixture, { recursive: true, force: true }))
  await cp(FIXTURE, fixture, { recursive: true })
  const scaffold = await launchWebScaffold({
    extraOverlayPath: [fileURLToPath(new URL('cordis.patch.yml', FORGE)), OVERLAY],
    extraInstallAnchors: [fileURLToPath(new URL('package.json', FORGE)), join(fixture, 'package.json')],
  })
  onTestFinished(() => scaffold.close())
  const liveId = await scaffold.ctx.loader.create({ name: LIVE })
  const live = scaffold.ctx.loader.resolve(liveId)
  const schedule = [...scaffold.ctx.loader.entries()].find(entry => entry.options.name === SCHEDULE)!
  const forge = [...scaffold.ctx.loader.entries()].find(entry => entry.options.name === FORGE_UI)!
  const hostFibers = [live.fiber, schedule.fiber]
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
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
  const frame = (id: string) => page.locator(`iframe[data-realm^="${id}#"]`)
  const original = await frame(SCHEDULE).elementHandle()
  await page.getByText('Live plugin enabled', { exact: true }).waitFor()
  expect(await page.evaluate(() => document.documentElement.dataset.liveMounts)).toBe('1')
  await schedule.update({ __unstable_enable_client_isolation: null })
  await live.update({ __unstable_enable_client_isolation: 'script' })
  expect(scaffold.ctx.clientModules.graph().entries.filter(row => row.isolation).map(row => row.id).sort()).toEqual([LIVE, FORGE_UI].sort())
  expect(live.fiber).toBe(hostFibers[0])
  expect(schedule.fiber).toBe(hostFibers[1])
  // Removal of an unrelated package acknowledges a graph containing both edits on this page.
  await forge.update({ disabled: true })
  await frame(FORGE_UI).waitFor({ state: 'detached' })
  expect(await original!.evaluate(node => node.isConnected)).toBe(true)
  expect(await frame(LIVE).count()).toBe(0)
  expect(await page.evaluate(() => document.documentElement.dataset.liveMounts)).toBe('1')

  const warningStart = tripwire.warnings.length
  await page.reload({ waitUntil: 'load' })
  await page.getByText('Live plugin enabled', { exact: true }).waitFor()
  acknowledgeReloadConnectionLoss(tripwire, warningStart)
  expect(await frame(SCHEDULE).count()).toBe(0)
  expect(await frame(LIVE).count()).toBe(1)
  expect(await page.evaluate(() => document.documentElement.dataset.liveMounts)).toBeUndefined()
  const beforeRebuild = await frame(LIVE).elementHandle()
  await live.update({ __unstable_enable_client_isolation: null })
  const file = join(fixture, 'client.js')
  const source = await readFile(file, 'utf8')
  await writeFile(file, source.replace('Live plugin enabled', 'Rebuilt live plugin enabled'))
  scaffold.ctx.clientModules.rebuilt(LIVE)
  await page.getByText('Rebuilt live plugin enabled', { exact: true }).waitFor()
  expect(await beforeRebuild!.evaluate(node => node.isConnected)).toBe(false)
  expect(await frame(LIVE).count()).toBe(1)
  expect(await page.evaluate(() => document.documentElement.dataset.liveMounts)).toBeUndefined()
  expect(live.fiber).toBe(hostFibers[0])
  scaffold.ctx.loader.remove(liveId)
  await frame(LIVE).waitFor({ state: 'detached' })
  await page.locator('[data-live-client]').waitFor({ state: 'detached' })
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
}, 120_000)
