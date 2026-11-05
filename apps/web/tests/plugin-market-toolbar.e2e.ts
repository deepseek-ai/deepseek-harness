/** Keyless browser geometry for the Discover toolbar against a local plugin index. */
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-plugin-market'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/plugin-market/toolbar-responsive.expected.md', import.meta.url))
const INDEX = new URL('./fixtures/plugin-market/toolbar.index.json', import.meta.url)

/** Read live control geometry, including the index button's intentional left outset. */
async function measure(toolbar: Locator) {
  return toolbar.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    const panel = element.closest('[data-plugin-panel]')!.getBoundingClientRect()
    const controls = Array.from(element.querySelectorAll('button, input'))
    const rects = controls.map(control => control.getBoundingClientRect())
    const contained = rects.every((rect, index) => {
      // The index button uses an 8px left outset to align its text with the page content.
      const left = index === 0 ? bounds.left - 8 : bounds.left
      return rect.left >= left - 1 && rect.right <= bounds.right + 1
        && rect.left >= panel.left && rect.right <= panel.right
        && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
    })
    const reachable = controls.every((control, index) => {
      const rect = rects[index]!
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return rect.width > 0 && rect.height > 0 && (hit === control || control.contains(hit))
    })
    const separated = rects.every((rect, index) => rects.slice(index + 1).every(other =>
      rect.right <= other.left || other.right <= rect.left || rect.bottom <= other.top || other.bottom <= rect.top))
    const centers = rects.map(rect => rect.top + rect.height / 2)
    return {
      controls: controls.length,
      contained,
      reachable,
      separated,
      overflow: element.scrollWidth > element.clientWidth,
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      singleLine: Math.max(...centers) - Math.min(...centers) < 1,
      focused: document.activeElement === element.querySelector('input'),
    }
  })
}

/** Every toolbar action remains visible, reachable, and separate without losing the search focus. */
function validLayout(layout: Awaited<ReturnType<typeof measure>>): boolean {
  return layout.controls === 5 && layout.contained && layout.reachable && layout.separated
    && !layout.overflow && !layout.pageOverflow && layout.focused
}

it('keeps Discover controls reachable when the toolbar wraps and retains search focus across widths', async () => {
  const body = await readFile(INDEX)
  const source = createServer((request, response) => {
    if (request.url !== '/index.json') {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(body)
  })
  source.listen(0, '127.0.0.1')
  try {
    await once(source, 'listening')
    const address = source.address()
    if (address === null || typeof address === 'string') throw new Error('The plugin index fixture has no TCP port')
    const scaffold = await launchWebScaffold({
      extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
      profile: { packages: [], bundles: ['@deepseek-ai/dsh-experimental-plugin-market-bundle'] },
    })
    try {
      await scaffold.ctx.pluginMarket.setIndexes([`http://127.0.0.1:${address.port}/index.json`])
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 844 }, locale: ZH_BROWSER_LOCALE, reducedMotion: 'reduce' })
        const consoleWatch = watchConsole(page)
        await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
        await page.getByRole('button', { name: '插件', exact: true }).click()
        await page.getByRole('tab', { name: '发现', exact: true }).click()
        await page.locator('[data-market-entry="dsh-toolbar-layout-fixture"]').waitFor()
        await page.getByRole('button', { name: '收起侧边栏', exact: true }).click()
        await page.evaluate(() => document.fonts.ready)
        const toolbar = page.locator('[data-discover-toolbar]')
        const search = toolbar.getByRole('searchbox', { name: '搜索插件' })
        await search.focus()
        const facts: string[] = []
        for (const width of [390, 430, 768, 1280]) {
          await page.setViewportSize({ width, height: 844 })
          await expect.poll(async () => {
            const layout = await measure(toolbar)
            return validLayout(layout) && layout.singleLine === (width >= 768) ? true : layout
          }, { message: `Discover toolbar at ${width}px` }).toBe(true)
          facts.push(`- ${width}px: ${width >= 768 ? 'single row' : 'wrapped rows'}; index, search, labels, sort, and refresh are contained, reachable, and separate; no horizontal overflow; search focus retained.`)
        }
        await page.setViewportSize({ width: 390, height: 844 })
        await expect.poll(async () => validLayout(await measure(toolbar))).toBe(true)
        const previous = await toolbar.evaluate((element) => {
          const previous = { value: element.style.getPropertyValue('flex-wrap'), priority: element.style.getPropertyPriority('flex-wrap') }
          element.style.setProperty('flex-wrap', 'nowrap')
          return previous
        })
        try {
          const noWrap = await measure(toolbar)
          expect(noWrap.overflow).toBe(true)
          expect(validLayout(noWrap)).toBe(false)
        } finally {
          await toolbar.evaluate((element, previous) => {
            if (previous.value === '') element.style.removeProperty('flex-wrap')
            else element.style.setProperty('flex-wrap', previous.value, previous.priority)
          }, previous)
        }
        await expect.poll(async () => validLayout(await measure(toolbar))).toBe(true)
        expect(consoleWatch.pageErrors).toEqual([])
        await compareOrRefreshGolden(EXPECTED,
          `# Discover toolbar responsive layout\n\n${facts.join('\n')}\n\nAt 390px, restoring the previous no-wrap layout causes horizontal overflow and fails the same layout check. Removing that override restores the controls and preserves search focus.`,
          webSnapshotMode())
      } finally {
        await browser.close()
      }
    } finally {
      await scaffold.close()
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      source.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  }
})
