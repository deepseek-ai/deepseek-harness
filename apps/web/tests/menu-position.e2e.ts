/** CSS menu candidates preserve layout-window margins through anchor alignment and flipping. */
import { readFile } from 'node:fs/promises'
import { chromium, webkit, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'

const cases = [
  { name: 'end alignment near the left edge', side: 'bottom', align: 'end', x: 232, y: 100, width: 255, height: 100, left: 12, top: 132, clearance: 12 },
  { name: 'start alignment near the right edge', side: 'bottom', align: 'start', x: 570, y: 100, width: 255, height: 100, left: 333, top: 132, clearance: 12 },
  { name: 'above placement near the desktop titlebar', side: 'top', align: 'start', x: 120, y: 110, width: 160, height: 80, left: 120, top: 142, clearance: 60 },
  { name: 'below placement near the bottom edge', side: 'bottom', align: 'start', x: 120, y: 330, width: 160, height: 100, left: 120, top: 226, clearance: 12 },
  { name: 'right placement near the right edge', side: 'right', align: 'start', x: 540, y: 100, width: 160, height: 100, left: 376, top: 100, clearance: 12 },
  { name: 'window fallback retains horizontal anchoring when neither vertical side fits', side: 'bottom', align: 'start', x: 120, y: 180, width: 300, height: 320, left: 120, top: 60, clearance: 60 },
] as const

type Placement = (typeof cases)[number]

async function showMenu(page: Page, css: string, placement: Placement): Promise<void> {
  await page.setContent(`<style>${css}</style><style>:root{--dsh-frame-overlay-top:${placement.clearance}px}</style>
    <button style="position:fixed;left:${placement.x}px;top:${placement.y}px;width:24px;height:28px;anchor-name:--test-menu">Anchor</button>
    <div role="menu" class="list portal scrollable" data-anchor-side="${placement.side}" data-anchor-align="${placement.align}"
      style="position-anchor:--test-menu;width:${placement.width}px;height:${placement.height}px">Menu</div>`)
}

describe.each([{ name: 'Chromium', engine: chromium }, { name: 'WebKit', engine: webkit }])('menu layout margins ($name)', ({ engine }) => {
  let browser: Browser | undefined
  let css: string
  beforeAll(async () => {
    css = await readFile(new URL('../../../packages/client/ui-primitives/src/Menu.module.css', import.meta.url), 'utf8')
    browser = await engine.launch()
  })
  afterAll(async () => { await browser?.close() })

  it.each(cases)('$name', async (placement) => {
    const page = await browser!.newPage({ viewport: { width: 600, height: 400 } })
    onTestFinished(() => page.close())
    await showMenu(page, css, placement)
    await expect.poll(async () => {
      const rect = await page.getByRole('menu').boundingBox()
      if (rect === null) return null
      return {
        left: Math.round(rect.x), top: Math.round(rect.y),
        bounded: rect.x >= 12 && rect.x + rect.width <= 588
          && rect.y >= placement.clearance && rect.y + rect.height <= 388,
      }
    }).toEqual({ left: placement.left, top: placement.top, bounded: true })
  })

  it.runIf(engine === chromium)('keeps layout bounds while zoom allows visual-viewport overflow', async () => {
    const page = await browser!.newPage({ viewport: { width: 600, height: 400 } })
    onTestFinished(() => page.close())
    await showMenu(page, css, cases[0])
    const menu = page.getByRole('menu')
    const before = await menu.boundingBox()
    const cdp = await page.context().newCDPSession(page)
    try {
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 3 })
      await expect.poll(() => page.evaluate(() => visualViewport!.scale)).toBe(3)
      await expect.poll(() => menu.boundingBox()).toEqual(before)
      expect(await menu.evaluate(node => node.getBoundingClientRect().width > visualViewport!.width)).toBe(true)
    } finally {
      await cdp.detach()
    }
  })
})
