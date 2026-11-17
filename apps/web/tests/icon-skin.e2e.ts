/** Real profile and Loader: a theme plugin replaces a product icon through the sprite, and removing it restores the default. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/plugins/fixture-icon-skin', import.meta.url))
const ICON = 'svg[data-icon="dsw-icon-search-outline-regular"]'

it('renders product icons from the sprite and swaps in a theme plugin replacement', async () => {
  const scaffold = await launchWebScaffold({ extraInstallAnchors: [join(FIXTURE, 'package.json')] })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-icon-skin'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const icon = page.locator(ICON).first()
  await icon.waitFor({ timeout: 20_000 })
  // getBBox measures the geometry <use> actually resolved: zero without a symbol.
  const geometry = () => icon.evaluate((svg: SVGSVGElement) => {
    const box = svg.querySelector('use')!.getBBox()
    return [box.x, box.y, box.width, box.height].map(value => Math.round(value * 10) / 10)
  })
  const defaults = await geometry()
  expect(defaults[2]).toBeGreaterThan(0)
  expect(await page.locator('svg[data-icon]').evaluateAll(icons => icons.filter(svg => svg.getBoundingClientRect().width > 0)
    .every(svg => (svg.querySelector('use') as SVGUseElement).getBBox().width > 0))).toBe(true)

  const entryId = await scaffold.ctx.loader.create({ name: '@fixture/icon-skin' })
  // The replacement disc spans viewBox units 2..14 of 16 on both axes.
  const width = await icon.evaluate((svg: SVGSVGElement) => svg.getBoundingClientRect().width)
  await expect.poll(geometry).toEqual([2, 2, 12, 12].map(units => Math.round((width * units) / 16 * 10) / 10))
  const disc = page.locator('svg[data-dsh-icon-sprite] symbol[id="dsw-icon-search-outline-regular"] [data-skin-disc]')
  expect(await disc.evaluate(element => getComputedStyle(element).fill)).not.toBe('none')

  scaffold.ctx.loader.remove(entryId)
  await expect.poll(geometry).toEqual(defaults)
  await expect.poll(() => disc.count()).toBe(0)
})
