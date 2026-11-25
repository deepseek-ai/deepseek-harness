/** One-way stylesheet isolation across a sidebar HOC, a Factory and its list row. */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const GLOBAL = '@fixture/style-scope-global'
const ADDON = '@fixture/style-scope-addon'
const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))

const sidebar = (page: Page) => page.locator('[data-slot="sidebar"]')
const counter = (page: Page) => sidebar(page).locator([
  '[data-style-probe="outer"]',
  '[data-slot-factory="fixture.styleScope.panel"] > [data-style-probe="middle"]',
  '[data-slot="fixture.styleScope.rows"]:not([data-plugin]) > [data-slot-item] > button[data-style-probe="inner"]',
].join(' > '))

async function expectStyles(page: Page, scoped: boolean, margin = '23px') {
  // Neither property inherits: every value requires a selector match on the probe itself.
  const sample = () => sidebar(page).locator('[data-style-probe]').evaluateAll(probes => probes.map((probe) => {
    const root = probe.parentElement!
    const { paddingLeft, marginLeft } = getComputedStyle(probe)
    return [root.getAttribute('data-plugin'), paddingLeft, marginLeft]
  }))
  await expect.poll(sample, { timeout: 30_000 }).toEqual([
    [GLOBAL, '7px', scoped ? '0px' : margin],
    [ADDON, '7px', margin],
    [GLOBAL, '7px', scoped ? '0px' : margin],
  ])
  const same = sidebar(page).locator('[data-style-same]')
  expect(await same.evaluate(button => [button.parentElement!.dataset.plugin, getComputedStyle(button).scrollMarginRight]))
    .toEqual([ADDON, scoped ? '9px' : '0px'])
  expect(await page.locator(`style[data-plugin="${ADDON}"][data-path="addon.css"]`).evaluate(sheet => ({
    attributes: sheet.getAttributeNames().sort(), scoped: (sheet as HTMLStyleElement).sheet!.cssRules[0] instanceof CSSScopeRule,
  }))).toEqual({ attributes: ['data-path', 'data-plugin'], scoped })
}

it('scopes actual Slot suppliers and gives rebuilt modules the current package declaration', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'dsh-style-scope-'))
  onTestFinished(() => rm(fixture, { recursive: true, force: true }))
  await cp(here('./fixtures/plugins/fixture-style-scope-addon'), fixture, { recursive: true })
  const scaffold = await launchWebScaffold({
    extraOverlayPath: [here('./pin-browse-picker.overlay.yml'), here('./client-style-scope.overlay.yml')],
    extraInstallAnchors: [here('./fixtures/plugins/fixture-style-scope-global/package.json'), join(fixture, 'package.json')],
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const fresh = await newEnglishPage(browser)
  const consoles = [watchConsole(page), watchConsole(fresh)]
  await page.goto(scaffold.authenticatedUrl)
  await sidebar(page).locator('[data-style-probe="outer"]').waitFor({ state: 'attached' })
  expect(await sidebar(page).getAttribute('data-plugin')).toBe('@deepseek-ai/dsh-client-ui-sidebar')
  expect(await counter(page).count()).toBe(0)

  let entryId = await scaffold.ctx.loader.create({ name: ADDON, __unstable_enable_client_isolation: 'style' })
  await expectStyles(page, true)
  const button = counter(page)
  const original = await button.evaluateHandle(node => ({ button: node, row: node.parentElement }))
  onTestFinished(() => original.dispose())
  await button.click()
  const replaceHostEntry = async (mode: 'style' | null, pages: Page[]) => {
    // Keep the Client package present while the Host composes the replacement entry's options.
    const nextId = await scaffold.ctx.loader.create({ name: ADDON, __unstable_enable_client_isolation: mode })
    scaffold.ctx.loader.remove(entryId)
    entryId = nextId
    await expect.poll(() => scaffold.ctx.clientModules.graph().entries.find(row => row.id === ADDON)?.isolation)
      .toBe(mode ?? undefined)
    const rev = scaffold.ctx.clientModules.graph().rev
    for (const open of pages) await open.waitForFunction(revision => Reflect.get(window, '__styleScopeGraph') === revision, rev)
  }
  await replaceHostEntry(null, [page])
  await expectStyles(page, true)
  expect(await button.evaluate((node, before) => ({
    sameButton: node === before.button, sameRow: node.parentElement === before.row, count: node.textContent,
  }), original)).toEqual({ sameButton: true, sameRow: true, count: '1' })

  await fresh.goto(scaffold.authenticatedUrl)
  await expectStyles(fresh, false)
  for (const [open, scoped] of [[page, true], [fresh, false]] as const) {
    await open.getByRole('button', { name: 'Load details' }).click()
    const sheet = open.locator(`style[data-plugin="${ADDON}"][data-path="details.css"]`)
    expect(await sheet.evaluate(node => (node as HTMLStyleElement).sheet!.cssRules[0] instanceof CSSScopeRule)).toBe(scoped)
    expect(await sidebar(open).locator('[data-style-probe]').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).outlineOffset)))
      .toEqual(scoped ? ['0px', '13px', '0px'] : ['13px', '13px', '13px'])
  }

  const file = join(fixture, 'client.js')
  const source = await readFile(file, 'utf8')
  await writeFile(file, source.replace('23px', '31px'))
  scaffold.ctx.clientModules.rebuilt(ADDON)
  await expectStyles(page, false, '31px')
  await expectStyles(fresh, false, '31px')
  await replaceHostEntry('style', [page, fresh])
  await expectStyles(fresh, false, '31px')
  await fresh.reload()
  await expectStyles(fresh, true, '31px')
  for (const log of consoles) {
    expect(log.pageErrors).toEqual([])
    expect(log.warnings).toEqual([])
  }
})
