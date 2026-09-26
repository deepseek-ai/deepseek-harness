/** Real profile, Remote, bundle scripts and Cordis slots: page-local client lifecycle without navigation. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cp, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  seedSession, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { openSettings, newEnglishPage, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/plugins/fixture-live-client', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/client-plugin-live', import.meta.url))
const SESSION_ACTION_EXPECTED = join(EXPECTED, 'session-actions.expected.md')
const SESSION_SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const SESSION_TITLE = 'Session action extension'

async function openInventory(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'load' })
  await openSettings(page, 'zh')
  const dialog = page.getByRole('dialog', { name: '设置' })
  await dialog.getByRole('button', { name: '内置插件', exact: true }).click()
  await dialog.getByRole('searchbox', { name: '搜索插件' }).waitFor()
  return dialog
}

it('places dynamic Session menu rows by order among the shipped ones and removes them with their fiber', async () => {
  const scaffold = await launchWebScaffold({ extraInstallAnchors: [join(FIXTURE, 'package.json')] })
  onTestFinished(() => scaffold.close())
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  const sessionId = await seedSession(scaffold, await readFile(SESSION_SEED, 'utf8'), 'session-menu-actions-web-e2e')
  await workspace.attachSession(sessionId)
  await scaffold.ctx.sessionController.rename({ sessionId, title: SESSION_TITLE })
  const entryId = await scaffold.ctx.loader.create({ name: '@fixture/live-client' })
  const browser = await chromium.launch()
  try {
    const page = await newEnglishPage(browser)
    const console = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-menu-actions'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const row = page.getByRole('treeitem').filter({ has: page.getByText(SESSION_TITLE, { exact: true }) })
    await row.waitFor({ timeout: 20_000 })
    const trigger = row.getByRole('button', { name: `Session actions for ${SESSION_TITLE}` })

    await row.hover()
    await trigger.focus()
    await trigger.click()
    const menu = page.getByRole('menu')
    await menu.waitFor()
    expect(await menu.getByRole('separator').count()).toBe(1)
    await compareOrRefreshGolden(
      SESSION_ACTION_EXPECTED,
      await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd),
      webSnapshotMode(),
    )

    await menu.getByRole('menuitem', { name: 'Export session' }).click()
    await expect.poll(() => menu.count()).toBe(0)
    expect(await page.evaluate(() => ({
      action: document.documentElement.dataset.sessionAction,
      id: document.documentElement.dataset.sessionActionId,
      title: document.documentElement.dataset.sessionActionTitle,
    }))).toEqual({ action: 'fixture.export-session', id: sessionId, title: SESSION_TITLE })

    scaffold.ctx.loader.remove(entryId)
    await expect.poll(() => page.evaluate(
      () => document.documentElement.dataset.liveDisposals,
    )).toBe('1')
    await row.hover()
    await trigger.click()
    await menu.waitFor()
    const remainingNames = ['Pin session', 'Rename', 'Fork session', 'Archive session']
    const remainingItems = menu.getByRole('menuitem')
    expect(await remainingItems.count()).toBe(remainingNames.length)
    for (const [index, name] of remainingNames.entries()) {
      expect(await remainingItems.nth(index).and(menu.getByRole('menuitem', { name, exact: true })).count()).toBe(1)
    }
    expect(await menu.getByRole('separator').count()).toBe(0)
    expect(console.pageErrors).toEqual([])
    await assertFixtureInventory(EXPECTED, [
      'bootstrap-rebuild.expected.md', 'enabled.expected.md', 'recovered.expected.md',
      'session-actions.expected.md',
    ])
  } finally {
    await browser.close()
  }
}, 120_000)

it('synchronizes two pages, disposes effects and restores an offline page from the latest graph without navigation', async () => {
  const scaffold = await launchWebScaffold({
    extraInstallAnchors: [join(FIXTURE, 'package.json')],
  })
  const host = scaffold.ctx.loader.ctx.fiber.uid
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const otherContext = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const page = await context.newPage()
    const other = await otherContext.newPage()
    const consoles = [watchConsole(page), watchConsole(other)]
    onTestFailed(() => saveFailureShot(page, 'web-e2e-client-live'))
    await openInventory(page, scaffold.authenticatedUrl)
    const otherInventory = await openInventory(other, scaffold.authenticatedUrl)
    let entryId: string | undefined
    const toggle = async () => {
      if (entryId === undefined) entryId = await scaffold.ctx.loader.create({ name: '@fixture/live-client' })
      else { scaffold.ctx.loader.remove(entryId); entryId = undefined }
    }
    let navigations = 0
    for (const target of [page, other]) target.on('framenavigated', () => { navigations++ })
    const live = (target: Page) => target.locator('[data-live-client]')
    const dataset = (target: Page) => target.evaluate(() => ({
      liveMounts: document.documentElement.dataset.liveMounts,
      liveDisposals: document.documentElement.dataset.liveDisposals,
      liveHits: document.documentElement.dataset.liveHits,
    }))
    const ping = (target: Page) => target.evaluate(() => { window.dispatchEvent(new Event('dsh-fixture-ping')) })
    expect(await live(page).count()).toBe(0)
    expect(scaffold.ctx.clientModules.graph().entries.some(row => row.id === '@fixture/live-client')).toBe(false)

    await toggle()
    for (const target of [page, other]) {
      await live(target).waitFor()
      expect(await live(target).evaluate(el => getComputedStyle(el).color)).toBe('rgb(12, 34, 56)')
      await ping(target)
      expect((await dataset(target)).liveHits).toBe('1')
    }
    await compareOrRefreshGolden(join(EXPECTED, 'enabled.expected.md'), await captureStableAria(page, '[data-live-client]', scaffold.workspaceCwd), webSnapshotMode())

    // The inventory filter is page-owned state that live composition must preserve.
    const draft = otherInventory.getByRole('searchbox', { name: '搜索插件' })
    await draft.fill('unfinished-filter')
    await toggle()
    for (const target of [page, other]) {
      await expect.poll(() => live(target).count()).toBe(0)
      await expect.poll(async () => (await dataset(target)).liveDisposals).toBe('1')
      await ping(target)
      expect((await dataset(target)).liveHits).toBe('1')
      expect(await target.locator('style[data-plugin="@fixture/live-client"]').count()).toBe(0)
    }
    expect(await draft.inputValue()).toBe('unfinished-filter')
    await toggle()
    for (const target of [page, other]) {
      await live(target).waitFor()
      expect(await live(target).count()).toBe(1)
      expect((await dataset(target)).liveMounts).toBe('2')
      expect(await target.locator('style[data-plugin="@fixture/live-client"]').count()).toBe(1)
    }

    const disconnected = other.waitForEvent('requestfailed', request => request.url().includes('/plugins/events'))
    await otherContext.setOffline(true)
    // Chromium offline emulation leaves established SSE sockets open. Cycling this
    // fixture's transport plugin closes them without replacing the Host or profile.
    const transport = [...scaffold.ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-client-hmr')!.fiber!
    const reconnected = page.waitForResponse(response => response.url().includes('/plugins/events') && response.status() === 200)
    await transport.restart()
    await disconnected
    await reconnected
    await toggle()
    await expect.poll(() => live(page).count()).toBe(0)
    expect(await live(other).count()).toBe(1)
    await otherContext.setOffline(false)
    await expect.poll(() => live(other).count(), { timeout: 20_000 }).toBe(0)
    expect(await draft.inputValue()).toBe('unfinished-filter')
    expect(navigations).toBe(0)
    expect(scaffold.ctx.loader.ctx.fiber.uid).toBe(host)
    for (const console of consoles) expect(console.pageErrors).toEqual([])
  } finally {
    await browser.close()
    await scaffold.close()
  }
}, 90_000)

it('keeps a failed client download local and retries without changing Host enablement', async () => {
  const scaffold = await launchWebScaffold({ extraInstallAnchors: [join(FIXTURE, 'package.json')] })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE })
    onTestFailed(() => saveFailureShot(page, 'web-e2e-client-live-retry'))
    await openInventory(page, scaffold.authenticatedUrl)
    const bundle = (url: URL) => url.pathname.startsWith('/plugins/') && url.search.includes('@fixture/live-client/client.js')
    await page.route(bundle, route => route.abort())
    const entryId = await scaffold.ctx.loader.create({ name: '@fixture/live-client' })
    const failure = page.locator('[data-client-sync-failure]')
    await failure.waitFor()
    expect(scaffold.ctx.loader.resolve(entryId).fiber?.state).toBe(2)
    expect(await page.locator('[data-live-client]').count()).toBe(0)
    expect(scaffold.ctx.clientModules.graph().entries.some(row => row.id === '@fixture/live-client')).toBe(true)
    await page.unroute(bundle)
    await failure.getByRole('button', { name: '重试本页面同步' }).click()
    await page.locator('[data-live-client]').waitFor()
    await expect.poll(() => failure.count()).toBe(0)
    expect(scaffold.ctx.loader.resolve(entryId).fiber?.state).toBe(2)
  } finally {
    await browser.close()
    await scaffold.close()
  }
}, 90_000)

it('recovers an uncreated client entry with rebuilt factory code without navigation', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'dsh-client-rebuild-'))
  // Finished hooks unwind in reverse order, so the Host closes before its fixture is removed.
  onTestFinished(() => rm(fixture, { recursive: true, force: true }))
  await cp(FIXTURE, fixture, { recursive: true })
  const file = join(fixture, 'client.js')
  const source = await readFile(file, 'utf8')
  const broken = source.replace("const React = require('react')", "throw new Error('fixture r0 factory failed')")
  expect(broken).not.toBe(source)
  await writeFile(file, broken)
  const scaffold = await launchWebScaffold({ extraInstallAnchors: [join(fixture, 'package.json')] })
  onTestFinished(() => scaffold.close())
  const host = scaffold.ctx.loader.ctx.fiber.uid
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE })
    onTestFailed(() => saveFailureShot(page, 'web-e2e-client-factory-rebuild'))
    const inventory = await openInventory(page, scaffold.authenticatedUrl)
    const draft = inventory.getByRole('searchbox', { name: '搜索插件' })
    await draft.fill('unfinished-filter')
    let navigations = 0
    page.on('framenavigated', () => { navigations++ })
    const entryId = await scaffold.ctx.loader.create({ name: '@fixture/live-client' })
    const failure = page.locator('[data-client-sync-failure]')
    await failure.getByText(/fixture r0 factory failed/).waitFor()
    const rebuilt = source.replace('动态插件已启用', '动态插件 r1 已启用').replace('Live plugin enabled', 'Live plugin r1 enabled')
    await writeFile(file, rebuilt)
    scaffold.ctx.clientModules.rebuilt('@fixture/live-client')
    await page.getByText('动态插件 r1 已启用', { exact: true }).waitFor()
    await expect.poll(() => failure.count()).toBe(0)
    await compareOrRefreshGolden(join(EXPECTED, 'recovered.expected.md'), await captureStableAria(page, '[data-live-client]', scaffold.workspaceCwd), webSnapshotMode())
    expect(await draft.inputValue()).toBe('unfinished-filter')
    expect(await page.locator('style[data-plugin="@fixture/live-client"]').count()).toBe(1)
    expect(await page.evaluate(() => document.documentElement.dataset.liveMounts)).toBe('1')
    expect(scaffold.ctx.loader.resolve(entryId).fiber?.state).toBe(2)
    expect(scaffold.ctx.loader.ctx.fiber.uid).toBe(host)
    expect(navigations).toBe(0)
  } finally {
    await browser.close()
  }
})

it('reports bootstrap rebuilds without remounting the settings page or navigating', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const host = scaffold.ctx.loader.ctx.fiber.uid
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE })
    const console = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-client-bootstrap-rebuild'))
    const inventory = await openInventory(page, scaffold.authenticatedUrl)
    const draft = inventory.getByRole('searchbox', { name: '搜索插件' })
    await draft.fill('unfinished-filter')
    const originalInput = await draft.elementHandle()
    let navigations = 0
    page.on('framenavigated', () => { navigations++ })
    const clientPath = scaffold.ctx.clientModules.clientPath('@deepseek-ai/dsh-client-modules')!
    const originalStat = await stat(clientPath)
    onTestFinished(() => utimes(clientPath, originalStat.atime, originalStat.mtime))
    await utimes(clientPath, originalStat.atime, new Date(originalStat.mtimeMs + 1_000))
    scaffold.ctx.clientModules.rebuilt('@deepseek-ai/dsh-client-modules')
    const failure = page.locator('[data-client-sync-failure]')
    await failure.getByText(/replacing bootstrap module .* requires a page reload/).waitFor()
    await failure.getByRole('button', { name: '重试本页面同步' }).click()
    await failure.getByText(/replacing bootstrap module .* requires a page reload/).waitFor()
    await compareOrRefreshGolden(join(EXPECTED, 'bootstrap-rebuild.expected.md'), await captureStableAria(page, '[data-client-sync-failure]', scaffold.workspaceCwd), webSnapshotMode())
    expect(await originalInput!.evaluate(input => input.isConnected)).toBe(true)
    expect(await draft.inputValue()).toBe('unfinished-filter')
    expect(scaffold.ctx.loader.ctx.fiber.uid).toBe(host)
    expect(navigations).toBe(0)
    expect(console.pageErrors).toEqual([])
  } finally {
    await browser.close()
  }
})

it('removes the client UI and resources while Host cleanup is still pending', async () => {
  const scaffold = await launchWebScaffold({ extraInstallAnchors: [join(FIXTURE, 'package.json')] })
  let release!: () => void
  const cleanup = new Promise<void>((resolve) => { release = resolve })
  onTestFinished(async () => { release(); await scaffold.close() })
  const host = scaffold.ctx.loader.ctx.fiber.uid
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE })
    await openInventory(page, scaffold.authenticatedUrl)
    let navigations = 0
    page.on('framenavigated', () => { navigations++ })
    const entryId = await scaffold.ctx.loader.create({ name: '@fixture/live-client' })
    const live = page.locator('[data-live-client]')
    await live.waitFor()
    const fiber = scaffold.ctx.loader.resolve(entryId).fiber!
    let hostDisposed = false
    fiber.ctx.effect(() => async () => { await cleanup; hostDisposed = true })
    scaffold.ctx.loader.remove(entryId)
    await expect.poll(() => live.count()).toBe(0)
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.liveDisposals)).toBe('1')
    expect(await page.locator('style[data-plugin="@fixture/live-client"]').count()).toBe(0)
    await page.evaluate(() => { window.dispatchEvent(new Event('dsh-fixture-ping')) })
    expect(await page.evaluate(() => document.documentElement.dataset.liveHits)).toBeUndefined()
    expect(hostDisposed).toBe(false)
    expect(scaffold.ctx.loader.ctx.fiber.uid).toBe(host)
    expect(navigations).toBe(0)
    release()
    while (fiber.inertia !== undefined) await fiber.inertia
    expect(hostDisposed).toBe(true)
  } finally {
    await browser.close()
  }
})
