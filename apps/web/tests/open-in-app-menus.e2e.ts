/** Session menu opening over built plugins; only native application discovery and launch are simulated. */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, webkit, type Browser, type BrowserContext, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'

const FIRST = 'open-app-menu-foreground'
const OTHER = 'open-app-menu-background'
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" rx="3" fill="gray"/></svg>'
const devices = [
  { name: 'macOS desktop', platform: 'MacIntel', width: 1280, height: 800, touch: false, mobile: false },
  { name: 'Windows desktop', platform: 'Win32', width: 1280, height: 800, touch: false, mobile: false },
  { name: 'Linux desktop', platform: 'Linux x86_64', width: 1280, height: 800, touch: false, mobile: false },
  { name: 'narrow desktop', platform: 'MacIntel', width: 390, height: 844, touch: false, mobile: false },
  { name: 'iPhone', platform: 'iPhone', width: 390, height: 844, touch: true, mobile: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' },
  { name: 'Android', platform: 'Linux armv8l', width: 412, height: 915, touch: true, mobile: true, userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36' },
  { name: 'iPad portrait', platform: 'MacIntel', width: 820, height: 1180, touch: true, mobile: true },
  { name: 'iPad landscape', platform: 'MacIntel', width: 1180, height: 820, touch: true, mobile: true },
] as const

/** Choose the recorded Session through the real sidebar before testing viewport changes. */
async function openSeed(page: Page, url: string): Promise<void> {
  await page.goto(url)
  const group = page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'Ungrouped' })
  await group.click()
  await page.locator(`[data-row-key="session:${FIRST}"]`).click()
  await page.getByText('DONE', { exact: true }).waitFor()
}

/** Every visible parent and child menu stays inside the viewport, including long lists. */
async function expectMenusInside(page: Page): Promise<void> {
  const bounds = await page.getByRole('menu').evaluateAll(nodes => nodes.map((node) => {
    const rect = node.getBoundingClientRect()
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight }
  }))
  expect(bounds.length).toBeGreaterThan(0)
  for (const rect of bounds) {
    expect(rect.left).toBeGreaterThanOrEqual(0)
    expect(rect.top).toBeGreaterThanOrEqual(0)
    expect(rect.right).toBeLessThanOrEqual(rect.width)
    expect(rect.bottom).toBeLessThanOrEqual(rect.height)
  }
}

/** Install an instance-local native-operation simulation without changing the menu implementation. */
async function nativeRoutes(
  context: BrowserContext,
  catalog: readonly string[],
  launch: (body: { app: string; path: string }) => Promise<number>,
): Promise<void> {
  await context.route('**/open-in-app/apps', route => route.fulfill({ json: { apps: catalog } }))
  await context.route('**/open-in-app/icon/*', route => route.fulfill({ body: ICON, contentType: 'image/svg+xml' }))
  await context.route('**/open-in-app/open', async (route) => {
    const status = await launch(route.request().postDataJSON() as { app: string; path: string })
    await route.fulfill({ status, json: { ok: status === 200 } })
  })
}

describe('Open in Session menus', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let otherDirectory: string
  beforeAll(async () => {
    // The real Host receives SSH facts to avoid probing or starting this runner's native applications.
    scaffold = await launchWebScaffold({ openInAppEnvironment: createLaunchEnvironmentSnapshot([
      { source: 'process', values: { SSH_CONNECTION: '10.0.0.2 55000 10.0.0.9 22' } },
    ]) })
    const recorded = await readFile(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url), 'utf8')
    otherDirectory = join(scaffold.workspaceCwd, 'background-directory')
    await mkdir(otherDirectory)
    await seedSession(scaffold, recorded, FIRST)
    await seedSession({ ...scaffold, workspaceCwd: otherDirectory }, recorded, OTHER)
    browser = await chromium.launch()
  })
  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it.each([true, false])('owns Header More without export, with Open in enabled=%s', async (enabled) => {
    const isolated = await launchWebScaffold({
      extraOverlayPath: fileURLToPath(new URL('./open-in-app-no-export.overlay.yml', import.meta.url)),
      ...(enabled ? { openInAppEnvironment: createLaunchEnvironmentSnapshot([
        { source: 'process', values: { SSH_CONNECTION: '10.0.0.2 55000 10.0.0.9 22' } },
      ]) } : {}),
    })
    onTestFinished(() => isolated.close())
    const recorded = await readFile(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url), 'utf8')
    await seedSession(isolated, recorded, FIRST)
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' })
    onTestFinished(() => context.close())
    const launches: { app: string; path: string }[] = []
    await nativeRoutes(context, ['finder'], async (body) => { launches.push(body); return 200 })
    const page = await context.newPage()
    await openSeed(page, isolated.authenticatedUrl)
    const more = page.getByRole('button', { name: 'More actions', exact: true })
    if (!enabled) {
      expect(await more.count()).toBe(0)
      return
    }
    await more.click()
    await page.getByRole('menuitem', { name: 'Open in', exact: true }).waitFor()
    expect(await page.getByRole('menuitem', { name: 'Download session log', exact: true }).count()).toBe(0)
    expect(await page.getByRole('menuitem', { name: 'Copy Session as Markdown', exact: true }).count()).toBe(0)
    await more.click()
    await expect.poll(() => page.getByRole('menu').count()).toBe(0)
    await more.click()
    await page.getByRole('menuitem', { name: 'Open in', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Finder', exact: true }).click()
    await expect.poll(() => launches.length).toBe(1)
    expect(launches[0]).toEqual({ app: 'finder', path: isolated.workspaceCwd })
  })

  it('keeps export feedback across Session navigation and dismissal does not cancel the download', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' })
    const gate = Promise.withResolvers<undefined>()
    const settled = Promise.withResolvers<undefined>()
    let requested = false
    onTestFinished(async () => {
      gate.resolve(undefined)
      if (requested) await settled.promise
      await context.close()
    })
    await nativeRoutes(context, ['finder'], async () => 200)
    await context.route('**/api/session.export?*', async (route) => {
      if (route.request().method() === 'HEAD') {
        requested = true
        try {
          await gate.promise
          await route.fulfill({ status: 200 })
        } finally { settled.resolve(undefined) }
      } else await route.fulfill({ status: 200, contentType: 'application/zip', body: 'controlled download response' })
    })
    const page = await context.newPage()
    await openSeed(page, scaffold.authenticatedUrl)
    await page.getByRole('button', { name: 'More actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Download session log', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Exporting Session', exact: true })
    await dialog.waitFor()
    expect(await dialog.textContent()).toContain(`Session: ${FIRST} `)
    const other = page.locator(`[data-row-key="session:${OTHER}"]`)
    // Exercise navigation's real handler while the modal owns pointer hit-testing.
    await other.dispatchEvent('click')
    await expect.poll(() => other.getAttribute('aria-selected')).toBe('true')
    expect(await dialog.textContent()).toContain(`Session: ${FIRST} `)
    await compareOrRefreshGolden(
      fileURLToPath(new URL('./expected/open-in-app-menus/global-export.expected.md', import.meta.url)),
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode(),
    )
    await dialog.getByText('Close', { exact: true }).click()
    const downloaded = page.waitForEvent('download')
    gate.resolve(undefined)
    const download = await downloaded
    expect(download.suggestedFilename()).toContain(FIRST)
    expect(await page.getByRole('dialog').count()).toBe(0)
  })

  it.each(devices)('opens through Header More on $name with device-specific feedback', async (device) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 }, locale: 'en-US', hasTouch: device.touch,
      ...('userAgent' in device ? { userAgent: device.userAgent } : {}),
    })
    onTestFinished(() => context.close())
    await context.addInitScript(({ platform, touch }) => {
      Object.defineProperty(navigator, 'platform', { value: platform })
      Object.defineProperty(navigator, 'maxTouchPoints', { value: touch ? 5 : 0 })
    }, device)
    const launches: { app: string; path: string }[] = []
    await nativeRoutes(context, ['vscode', 'cursor', 'finder'], async (body) => { launches.push(body); return 200 })
    const page = await context.newPage()
    await openSeed(page, scaffold.authenticatedUrl)
    await page.setViewportSize({ width: device.width, height: device.height })
    const more = page.getByRole('button', { name: 'More actions', exact: true })
    expect(await page.getByRole('banner').locator('[data-open-target="directory"]').count()).toBe(0)
    if (device.touch) await more.tap(); else await more.click()
    const parent = page.getByRole('menuitem', { name: 'Open in', exact: true })
    await parent.waitFor()
    if (device.touch) await more.tap(); else await more.click()
    await expect.poll(() => page.getByRole('menu').count()).toBe(0)
    expect(await more.getAttribute('aria-expanded')).toBe('false')
    if (device.touch) await more.tap(); else await more.click()
    await parent.waitFor()
    expect(await page.getByRole('menuitem', { name: 'Copy Session as Markdown', exact: true }).count()).toBe(1)
    expect(await page.getByRole('menuitem', { name: 'Pin session', exact: true }).count()).toBe(0)
    if (device.touch) await parent.tap(); else await parent.click()
    await page.getByRole('menuitem', { name: 'Cursor', exact: true }).waitFor()
    await expectMenusInside(page)
    if (device.width === 390) {
      expect(await page.getByRole('menuitem', { name: 'Back', exact: true }).count()).toBe(1)
    }
    const choice = page.getByRole('menuitem', { name: 'Cursor', exact: true })
    if (device.touch) await choice.tap(); else await choice.click()
    await expect.poll(() => launches).toEqual([{ app: 'cursor', path: scaffold.workspaceCwd }])
    await expect.poll(() => page.getByRole('menu').count()).toBe(0)
    await expect.poll(() => page.evaluate(() => localStorage.getItem('dsh.open-in-app.choice'))).toBe('"cursor"')
    if (device.mobile) await page.getByText('Opened on another device', { exact: true }).waitFor()
    else expect(await page.getByText('Opened on another device', { exact: true }).count()).toBe(0)
  })

  it('captures a background Session, remembers only success, and prevents a second launch while busy', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' })
    onTestFinished(() => context.close())
    const response = Promise.withResolvers<number>()
    onTestFinished(() => { response.resolve(502) })
    const launches: { app: string; path: string }[] = []
    await nativeRoutes(context, ['vscode', 'cursor', 'finder'], async (body) => { launches.push(body); return response.promise })
    const page = await context.newPage()
    await openSeed(page, scaffold.authenticatedUrl)
    const background = page.locator(`[data-row-key="session:${OTHER}"]`)
    await background.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Open in', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Cursor', exact: true }).click()
    await expect.poll(() => launches).toEqual([{ app: 'cursor', path: otherDirectory }])
    expect(await background.getAttribute('aria-selected')).toBe('false')
    await page.getByRole('button', { name: 'More actions', exact: true }).click()
    const disabled = page.getByRole('menuitem', { name: 'Open in', exact: true })
    await expect.poll(() => disabled.isDisabled()).toBe(true)
    expect(launches).toHaveLength(1)
    await page.keyboard.press('Escape')
    response.resolve(502)
    await page.getByText('Could not open. Try again.', { exact: true }).waitFor()
    expect(await page.evaluate(() => localStorage.getItem('dsh.open-in-app.choice'))).toBeNull()
    await background.hover()
    await background.getByRole('button', { name: /actions/i }).click()
    await expect.poll(() => page.getByRole('menuitem', { name: 'Open in', exact: true }).isEnabled()).toBe(true)
    expect(await page.getByRole('menuitem', { name: 'Show in Finder', exact: true }).count()).toBe(0)
  })

  it.each([{ name: 'Chromium', engine: chromium }, { name: 'WebKit', engine: webkit }])(
    'tracks real geometry and ignores unrelated portals in $name', async ({ engine }) => {
      const isolated = await engine.launch()
      onTestFinished(() => isolated.close())
      const context = await isolated.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
      await nativeRoutes(context, ['vscode', 'cursor', 'finder', 'windowsterminal'], async () => 200)
      const page = await context.newPage()
      await openSeed(page, scaffold.authenticatedUrl)
      await page.getByRole('button', { name: 'More actions', exact: true }).click()
      const parent = page.getByRole('menuitem', { name: 'Open in', exact: true })
      await page.mouse.move(20, 750)
      await parent.focus()
      await page.keyboard.press('ArrowRight')
      const root = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Copy Session as Markdown', exact: true }) })
      const child = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Windows Terminal', exact: true }) })
      await child.waitFor()
      const rootElement = await root.elementHandle()
      const childElement = await child.elementHandle()
      const parentElement = await parent.elementHandle()
      if (rootElement === null || childElement === null || parentElement === null) throw new Error('Both menu panels and the parent row must be mounted')
      const alignment = async () => {
        const [outer, nested, row] = await Promise.all([rootElement.boundingBox(), childElement.boundingBox(), parentElement.boundingBox()])
        return outer === null || nested === null || row === null ? Infinity : Math.max(
          Math.abs(outer.x - nested.x - nested.width - 4), Math.abs(nested.y - row.y),
        )
      }
      // offsetWidth is integer-valued while browser rectangles retain fractional pixels.
      await expect.poll(alignment).toBeLessThanOrEqual(1)

      // Browser layout changes are real; no observer callback or rectangle is mocked.
      await parent.evaluate((node) => { node.style.marginTop = '24px' })
      await expect.poll(alignment).toBeLessThanOrEqual(1)
      const before = await child.boundingBox()
      await page.getByRole('menuitem', { name: 'Windows Terminal', exact: true }).getByText('Windows Terminal', { exact: true })
        .evaluate((node) => { node.style.fontSize = '30px' })
      await expect.poll(async () => (await child.boundingBox())?.width ?? 0).toBeGreaterThan(before?.width ?? 0)
      await expect.poll(alignment).toBeLessThanOrEqual(1)

      await rootElement.evaluate((node) => {
        node.style.maxHeight = '130px'
        const viewport = node.querySelector<HTMLElement>(':scope > [role="presentation"]')
        if (viewport === null || viewport.scrollHeight <= viewport.clientHeight) throw new Error('The parent must scroll')
        viewport.scrollTop = viewport.scrollHeight
      })
      await expect.poll(alignment).toBeLessThanOrEqual(1)
      await page.setViewportSize({ width: 390, height: 844 })
      await page.getByRole('menuitem', { name: 'Back', exact: true }).waitFor()
      await expectMenusInside(page)
      expect(await childElement.evaluate(node => node.isConnected)).toBe(true)
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
      }))
      const writes = await childElement.evaluate(async (node) => {
        let count = 0
        const observer = new MutationObserver((records) => { count += records.length })
        observer.observe(node, { attributes: true, attributeFilter: ['style'] })
        const unrelated = document.createElement('div')
        unrelated.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none'
        try {
          document.body.append(unrelated)
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
          })
          return count
        } finally { observer.disconnect(); unrelated.remove() }
      })
      expect(writes).toBe(0)
      await page.getByRole('menuitem', { name: 'Back', exact: true }).click()
      await parent.waitFor()
      await page.keyboard.press('Escape')
      await expect.poll(() => page.getByRole('menu').count()).toBe(0)
    },
  )

  it.each([{ catalog: [] }, { catalog: ['unnameable'] }, { catalog: ['finder'] }])('keeps empty and single-application catalogs consistent: $catalog', async ({ catalog }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' })
    onTestFinished(() => context.close())
    await nativeRoutes(context, catalog, async () => 200)
    const page = await context.newPage()
    await openSeed(page, scaffold.authenticatedUrl)
    await page.getByRole('button', { name: 'More actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Copy Session as Markdown', exact: true }).waitFor()
    const open = page.getByRole('menuitem', { name: 'Open in', exact: true })
    if (catalog[0] !== 'finder') expect(await open.count()).toBe(0)
    else {
      await open.click()
      await page.getByRole('menuitem', { name: 'Finder', exact: true }).waitFor()
      expect(await page.getByRole('menuitem', { name: /^Finder/ }).count()).toBe(1)
      await expectMenusInside(page)
    }
  })
})
