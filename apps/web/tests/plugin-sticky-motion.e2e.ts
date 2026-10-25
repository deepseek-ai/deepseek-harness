import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'

const EXPECTED = fileURLToPath(new URL('./expected/plugin-manager/header-natural-motion.expected.md', import.meta.url))

/** Measure the accepted resting or compact flex layout without changing the live header. */
async function reference(page: Page, compact: boolean) {
  return page.locator('[data-plugin-bar]').evaluate((bar, compact) => {
    const clone = bar.cloneNode(true) as HTMLElement
    clone.removeAttribute('data-natural')
    clone.toggleAttribute('data-compact', compact)
    clone.setAttribute('data-measuring', '')
    clone.inert = true
    clone.style.width = `${bar.getBoundingClientRect().width}px`
    clone.querySelectorAll('[data-plugin-header-part]').forEach((element) => { element.removeAttribute('style') })
    bar.parentElement!.append(clone)
    try {
      const origin = clone.querySelector('header')!.getBoundingClientRect()
      const box = (selector: string) => {
        const element = clone.querySelector(selector)
        if (element === null) return null
        const rect = element.getBoundingClientRect()
        return { x: rect.x - origin.x, y: rect.y - origin.y, width: rect.width, height: rect.height }
      }
      return {
        height: clone.getBoundingClientRect().height,
        title: box('h1')!, intro: box('[data-plugin-header-part="intro"]')!,
        toolbar: box('[data-plugin-toolbar]')!, tabs: box('[role="tablist"]'),
      }
    } finally { clone.remove() }
  }, compact)
}

/** Wait for scroll delivery before sampling the resulting layout. */
async function scrollTo(page: Page, offset: number): Promise<void> {
  await page.locator('[data-plugin-body]').evaluate(async (body, offset) => {
    body.scrollTop = offset
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
    })
  }, offset)
}

async function geometry(page: Page) {
  return page.locator('[data-plugin-bar]').evaluate((bar) => {
    const origin = bar.querySelector('header')!.getBoundingClientRect()
    const body = bar.parentElement!
    const box = (selector: string) => {
      const element = bar.querySelector(selector)
      if (element === null) return null
      const rect = element.getBoundingClientRect()
      return { x: rect.x - origin.x, y: rect.y - origin.y, width: rect.width, height: rect.height }
    }
    return {
      title: box('h1')!, intro: box('[data-plugin-header-part="intro"]')!,
      toolbar: box('[data-plugin-toolbar]')!, tabs: box('[role="tablist"]'),
      barHeight: bar.getBoundingClientRect().height,
      paintHeight: Number.parseFloat(getComputedStyle(bar, '::before').height),
      travel: Number.parseFloat((bar as HTMLElement).style.getPropertyValue('--plugin-header-travel')),
      range: body.scrollHeight - body.clientHeight, offset: body.scrollTop,
      first: body.querySelector('[data-plugin-group]')!.getBoundingClientRect().top,
    }
  })
}

it('preserves both header layouts and follows the scroll position without changing the scroll range', async () => {
  const browser = await chromium.launch()
  const facts: string[] = []
  try {
    for (const hasTabs of [false, true]) {
      const scaffold = await launchWebScaffold(hasTabs ? {
        profile: { packages: [], bundles: ['@deepseek-ai/dsh-experimental-plugin-market-bundle'] },
      } : {})
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 480 }, locale: 'en-US' })
        const consoleWatch = watchConsole(page)
        try {
          await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
          await page.getByRole('button', { name: 'Plugins', exact: true }).click()
          await page.locator('[data-plugin-package]').first().waitFor()
          await page.locator('[data-plugin-bar][data-natural]').waitFor()
          await page.evaluate(() => document.fonts.ready)
          // Without tabs, whether the actions fit beside the title at 470px depends on the platform font,
          // so that width is pinned only with tabs.
          for (const width of hasTabs ? [1280, 600, 470, 390] : [1280, 600, 390]) {
            await page.setViewportSize({ width, height: 480 })
            await scrollTo(page, 0)
            const resting = await reference(page, false)
            const compact = await reference(page, true)
            const initial = await geometry(page)
            expect(initial.title).toEqual(resting.title)
            expect(initial.toolbar).toEqual(resting.toolbar)
            expect(initial.tabs).toEqual(resting.tabs)
            if (hasTabs && width <= 600) {
              const tabs = initial.tabs!
              if (width === 390) {
                expect(initial.toolbar.y).toBeGreaterThanOrEqual(tabs.y + tabs.height)
              } else {
                expect(initial.toolbar.x).toBeGreaterThanOrEqual(tabs.x + tabs.width)
                expect(initial.toolbar.y + initial.toolbar.height / 2).toBeCloseTo(tabs.y + tabs.height / 2, 5)
              }
            }
            const refresh = await page.getByRole('button', { name: 'Refresh', exact: true }).elementHandle()
            if (refresh === null) throw new Error('The refresh control is missing')
            const samples: Awaited<ReturnType<typeof geometry>>[] = []
            const offsets = [...new Set([
              0, 1, 4, 8, 9, ...Array.from({ length: Math.ceil(initial.travel / 4) + 1 }, (_, i) => i * 4),
              initial.travel, initial.travel + 16,
            ])].sort((a, b) => a - b)
            for (const offset of offsets) {
              await scrollTo(page, offset)
              const current = await geometry(page)
              expect(current.range).toBe(initial.range)
              expect(current.barHeight).toBe(resting.height)
              if (hasTabs && width <= 600) {
                expect(current.toolbar.y - current.tabs!.y).toBeCloseTo(initial.toolbar.y - initial.tabs!.y, 5)
                expect(current.toolbar.x).toBe(initial.toolbar.x)
                expect(current.tabs!.x).toBe(initial.tabs!.x)
              }
              expect(current.first).toBeCloseTo(initial.first - current.offset, 5)
              const previous = samples.at(-1)
              if (previous !== undefined) {
                expect(current.toolbar.y).toBeLessThanOrEqual(previous.toolbar.y + 0.02)
                if (current.tabs !== null && previous.tabs !== null) expect(current.tabs.y).toBeLessThanOrEqual(previous.tabs.y + 0.02)
              }
              if (offset === 8) {
                expect(current.paintHeight).toBeGreaterThan(compact.height)
                if (hasTabs) expect(current.tabs!.y).toBeCloseTo(resting.tabs!.y - 8, 5)
              }
              samples.push(current)
            }
            const terminal = await geometry(page)
            expect(terminal.toolbar).toEqual(compact.toolbar)
            expect(terminal.tabs).toEqual(compact.tabs)
            expect(terminal.paintHeight).toBe(compact.height)
            if (!hasTabs) expect(terminal.title).toEqual(compact.title)
            expect(await refresh.evaluate(element => element.isConnected)).toBe(true)
            await refresh.focus()
            expect(await refresh.evaluate(element => element === document.activeElement)).toBe(true)
            await scrollTo(page, terminal.offset)
            expect(await geometry(page)).toEqual(terminal)
            for (const sample of samples.toReversed()) {
              await scrollTo(page, sample.offset)
              expect(await geometry(page)).toEqual(sample)
            }
            expect(await page.locator('[data-measuring]').count()).toBe(0)
            facts.push(`- ${hasTabs ? 'Tabs' : 'Title'} / ${width}px: resting title ${resting.title.y}, actions ${resting.toolbar.y}, tabs ${resting.tabs?.y ?? 'none'}; pinned actions ${compact.toolbar.y}, tabs ${compact.tabs?.y ?? 'none'}, bar ${compact.height}; stable range, reversible coordinates, same controls.`)
          }
          expect(consoleWatch.pageErrors).toEqual([])
          expect(consoleWatch.warnings).toEqual([])
        } finally { await page.close() }
      } finally { await scaffold.close() }
    }
  } finally { await browser.close() }
  await compareOrRefreshGolden(EXPECTED, `# Plugin header natural scrolling\n\n${facts.join('\n')}`, webSnapshotMode())
})

it('preserves the full header width when the list reserves a scrollbar gutter', async () => {
  const scaffold = await launchWebScaffold({
    profile: { packages: [], bundles: ['@deepseek-ai/dsh-experimental-plugin-market-bundle'] },
  })
  try {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 480 }, locale: 'en-US' })
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.getByRole('button', { name: 'Plugins', exact: true }).click()
      await page.locator('[data-plugin-package]').first().waitFor()
      await page.locator('[data-plugin-bar][data-natural]').waitFor()
      await scrollTo(page, 0)
      const initial = await geometry(page)
      const compact = await reference(page, true)
      const headerBounds = await page.locator('[data-plugin-bar] > header').boundingBox()
      await page.locator('[data-plugin-body]').evaluate((body) => { body.style.scrollbarGutter = 'stable' })
      await expect.poll(() => page.locator('[data-plugin-body]').evaluate(body => (body as HTMLElement).offsetWidth - body.clientWidth))
        .toBeGreaterThan(0)
      await expect.poll(() => page.locator('[data-plugin-bar] > header').boundingBox()).toEqual(headerBounds)
      const withGutter = await geometry(page)
      expect(withGutter.toolbar).toEqual(initial.toolbar)
      expect(withGutter.tabs).toEqual(initial.tabs)
      await scrollTo(page, 300)
      expect((await geometry(page)).toolbar).toEqual(compact.toolbar)
      expect((await geometry(page)).tabs).toEqual(compact.tabs)
    } finally { await browser.close() }
  } finally { await scaffold.close() }
})

it('does not manufacture extra scroll range or clamp a nearly fitting list while the header moves', async () => {
  const scaffold = await launchWebScaffold()
  try {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 480 }, locale: 'en-US' })
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.getByRole('button', { name: 'Plugins', exact: true }).click()
      await page.locator('[data-plugin-package]').first().waitFor()
      await page.locator('[data-plugin-bar][data-natural]').waitFor()
      await scrollTo(page, 0)
      const initial = await geometry(page)
      await page.setViewportSize({ width: 1000, height: 480 + initial.range - 12 })
      await scrollTo(page, 0)
      const before = await geometry(page)
      expect(before.range).toBe(12)
      await page.mouse.move(500, 300)
      await page.mouse.wheel(0, 200)
      await expect.poll(async () => (await geometry(page)).offset).toBe(12)
      const bottom = await geometry(page)
      expect(bottom.range).toBe(12)
      expect(bottom.barHeight).toBe(before.barHeight)
      expect(bottom.paintHeight).toBe(before.barHeight - 12)
      await page.mouse.wheel(0, -200)
      await expect.poll(async () => (await geometry(page)).offset).toBe(0)
      expect(await geometry(page)).toEqual(before)
    } finally { await browser.close() }
  } finally { await scaffold.close() }
})
