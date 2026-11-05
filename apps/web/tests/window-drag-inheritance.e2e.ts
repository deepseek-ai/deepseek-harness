/** App-region inheritance and clipped geometry in an installed Chrome runtime. */
import { readFileSync } from 'node:fs'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { isDraggableAt, type RegionRect } from '@deepseek-ai/dsh-client-web/src/window-drag/regions.ts'

const BASE_STYLES = readFileSync(new URL('../../../packages/client/web/src/base.css', import.meta.url), 'utf8')

/** Read the browser's computed region, which may differ from an authored keyword. */
function computedRegion(element: Locator): Promise<string> {
  return element.evaluate(node => getComputedStyle(node).getPropertyValue('-webkit-app-region'))
}

/** Collect browser boxes and apply the production region model to the header point. */
async function headerPoint(page: Page): Promise<{ hit: string | undefined; draggable: boolean }> {
  const { hit, regions } = await page.evaluate(() => {
    const regions: RegionRect[] = []
    for (const element of document.querySelectorAll('*')) {
      const style = getComputedStyle(element)
      const region = style.getPropertyValue('-webkit-app-region')
      if (region !== 'drag' && region !== 'no-drag') continue
      if (style.display === 'none' || style.visibility !== 'visible') continue
      const rect = element.getBoundingClientRect()
      regions.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, draggable: region === 'drag' })
    }
    return { hit: document.elementFromPoint(20, 20)?.id, regions }
  })
  return { hit, draggable: isDraggableAt(regions, 20, 20) }
}

it('resets inherited app-regions before clipped descendants subtract header pixels', async (context) => {
  let browser: Browser
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true })
  } catch (error) {
    if (error instanceof Error && error.message.includes("Chromium distribution 'chrome' is not found")) {
      context.skip('Google Chrome is not installed; this scenario requires its app-region inheritance support')
    }
    throw error
  }
  onTestFinished(() => browser.close())
  const version = browser.version()
  console.info(`App-region inheritance runtime: Chrome ${version}`)
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
  await page.setContent(`<!doctype html>
    <html data-platform="darwin"><head><style>
      body { margin: 0; }
      #header { height: 50px; }
      #owner { height: 120px; overflow: hidden; }
      #child { height: 80px; }
      #tail { height: 400px; }
    </style></head><body><div id="root">
      <header id="header" data-window-drag style="-webkit-app-region: drag">Header</header>
      <div id="owner" style="-webkit-app-region: no-drag">
        <div id="child">Clipped content</div><div id="tail"></div>
      </div>
      <div style="-webkit-app-region: no-drag">
        <div id="authored-none" style="-webkit-app-region: none">Authored none</div>
        <div id="initial" style="-webkit-app-region: initial">Initial</div>
      </div>
    </div></body></html>`)
  expect(await computedRegion(page.locator('#owner'))).toBe('no-drag')
  const inherited = await computedRegion(page.locator('#child'))
  if (inherited === 'none') {
    context.skip(`Chrome ${version} does not inherit app-region; this environment cannot exercise the inheritance regression`)
  }
  expect(inherited).toBe('no-drag')
  expect(await computedRegion(page.locator('#authored-none'))).toBe('no-drag')
  expect(await computedRegion(page.locator('#initial'))).toBe('none')

  await page.locator('#owner').evaluate((owner) => { owner.scrollTop = 100 })
  expect(await page.locator('#child').evaluate((child) => {
    const bounds = child.getBoundingClientRect()
    const owner = child.parentElement!.getBoundingClientRect()
    return bounds.top < 20 && bounds.bottom > 20 && bounds.bottom < owner.top
  })).toBe(true)
  expect(await headerPoint(page)).toEqual({ hit: 'header', draggable: false })

  const stylesheet = await page.addStyleTag({ content: BASE_STYLES })
  expect(await computedRegion(page.locator('#child'))).toBe('none')
  expect(await computedRegion(page.locator('#authored-none'))).toBe('no-drag')
  expect(await computedRegion(page.locator('#initial'))).toBe('none')
  expect(await headerPoint(page)).toEqual({ hit: 'header', draggable: true })

  // Remove only the production reset: the still-clipped child must erase the same header point.
  await stylesheet.evaluate((element) => {
    if (!(element instanceof HTMLStyleElement) || element.sheet === null) throw new Error('The test stylesheet is unavailable')
    const rules = Array.from(element.sheet.cssRules)
    const reset = rules.find(rule => rule instanceof CSSStyleRule
      && rule.selectorText === ':where(html[data-platform="darwin"] *)')
    if (!(reset instanceof CSSStyleRule)) throw new Error('The app-region inheritance reset is missing')
    reset.style.removeProperty('-webkit-app-region')
  })
  expect(await computedRegion(page.locator('#child'))).toBe('no-drag')
  expect(await headerPoint(page)).toEqual({ hit: 'header', draggable: false })
})
