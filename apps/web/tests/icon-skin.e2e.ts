/** Real profile and Loader: a theme plugin replaces a product icon through the sprite, and removing it restores the default. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/plugins/fixture-icon-skin', import.meta.url))
const ICON = 'svg[data-icon="dsw-icon-search-outline-regular"]'

it.each(['light', 'dark'] as const)('renders a 16px permission trigger and 14px menu icons with fixed 1px strokes in %s mode', async (colorScheme) => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ deviceScaleFactor: 2, locale: 'en-US', colorScheme })
  onTestFailed(() => saveFailureShot(page, `permission-pixel-grid-${colorScheme}`))
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  await page.evaluate(() => document.fonts.ready)
  const trigger = page.getByRole('button', { name: /^Access mode, current:/ })
  const triggerBox = await trigger.locator('svg').first().boundingBox()
  expect(triggerBox && [triggerBox.width, triggerBox.height]).toEqual([16, 16])
  await trigger.click()
  const icon = page.getByRole('menuitem', { name: 'Workspace Write', exact: true }).locator('svg').first()
  // Isolate edge coverage from the menu's translucent material without changing placement.
  await icon.evaluate((svg, dark) => {
    svg.style.color = dark ? 'white' : 'black'
    svg.style.backgroundColor = dark ? 'black' : 'white'
  }, colorScheme === 'dark')
  const box = await icon.boundingBox()
  if (box === null) throw new Error('Permission icon is not visible')
  expect([box.width, box.height]).toEqual([14, 14])
  expect([box.x * 2, box.y * 2]).toEqual([Math.round(box.x * 2), Math.round(box.y * 2)])
  const { data, info } = await sharp(await page.screenshot()).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const ink = (x: number, y: number) => {
    const intensity = data[((Math.round(box.y * 2) + y) * info.width + Math.round(box.x * 2) + x) * info.channels]! / 255
    return colorScheme === 'dark' ? intensity : 1 - intensity
  }
  // Scaling the 16-unit geometry to 14px changes edge coverage; integrated
  // ink must still measure one CSS pixel instead of shrinking to 0.875px.
  const verticalCoverage = Array.from({ length: 7 }, (_, x) => ink(x + 1, 10)).reduce((sum, value) => sum + value, 0)
  const horizontalCoverage = Array.from({ length: 6 }, (_, y) => ink(14, y + 9)).reduce((sum, value) => sum + value, 0)
  expect(verticalCoverage / 2).toBeCloseTo(1, 2)
  expect(horizontalCoverage / 2).toBeCloseTo(1, 2)

  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Account menu', exact: true }).click()
  const accountMenu = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Settings', exact: true }) })
  const accountIcons = accountMenu.getByRole('menuitem').locator('svg')
  await expect.poll(() => accountIcons.count()).toBe(3)
  for (const accountIcon of await accountIcons.all()) {
    const accountBox = await accountIcon.boundingBox()
    expect(accountBox && [accountBox.width, accountBox.height]).toEqual([14, 14])
  }
})

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

it.each([1, 2])('keeps icon stroke widths at device pixel ratio %s', async (deviceScaleFactor) => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ deviceScaleFactor, locale: 'en-US' })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.locator('symbol[id="dsw-icon-plus-outline-regular"]').waitFor({ state: 'attached', timeout: 20_000 })

  for (const dark of [false, true]) {
    for (const [weight, expectedWidth] of [['regular', 1], ['medium', 1.3]] as const) {
      for (const size of [14, 16, 20]) {
        await page.evaluate(({ size, weight, dark }) => {
          document.querySelector('[data-stroke-sample]')?.remove()
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
          svg.setAttribute('data-stroke-sample', '')
          // CSS sizing must work even when the component's width/height attributes remain at 16.
          svg.setAttribute('width', '16')
          svg.setAttribute('height', '16')
          svg.style.cssText = `position:fixed;left:0;top:0;z-index:2147483647;display:block;width:${size}px;height:${size}px;color:${dark ? 'white' : 'black'};background:${dark ? 'black' : 'white'}`
          const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
          use.setAttribute('href', `#dsw-icon-plus-outline-${weight}`)
          svg.append(use)
          document.body.append(svg)
        }, { size, weight, dark })
        const { data, info } = await sharp(await page.locator('[data-stroke-sample]').screenshot()).removeAlpha().raw().toBuffer({ resolveWithObject: true })
        // Integrate coverage across the vertical stem, away from the horizontal bar.
        const row = Math.floor(info.height / 4)
        let coverage = 0
        for (let x = 0; x < info.width; x++) {
          const intensity = data[(row * info.width + x) * info.channels]! / 255
          coverage += dark ? intensity : 1 - intensity
        }
        expect(Math.abs(coverage / deviceScaleFactor - expectedWidth), `${size}px ${weight}, dark=${dark}`).toBeLessThan(0.04)
      }
    }
    for (const size of [12, 14]) {
      await page.evaluate(({ size, dark }) => {
        const svg = document.querySelector<SVGSVGElement>('[data-stroke-sample]')!
        svg.style.width = `${size}px`
        svg.style.height = `${size}px`
        svg.style.color = dark ? 'white' : 'black'
        svg.style.backgroundColor = dark ? 'black' : 'white'
        svg.querySelector('use')!.setAttribute('href', '#dsw-icon-browse-outline-regular')
      }, { size, dark })
      const { data, info } = await sharp(await page.locator('[data-stroke-sample]').screenshot()).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      const ink = (x: number, y: number) => {
        const intensity = data[(y * info.width + x) * info.channels]! / 255
        return dark ? intensity : 1 - intensity
      }
      const scale = size * deviceScaleFactor / 16
      // The mixed glyph's filled side walls scale; its separate inner line does not.
      const row = Math.floor(7.5 * scale)
      const walls = Array.from({ length: info.width }, (_, x) => ink(x, row)).reduce((sum, value) => sum + value, 0)
      expect(Math.abs(walls / deviceScaleFactor / 2 - size / 16)).toBeLessThan(0.04)
      const column = Math.floor(7 * scale)
      let line = 0
      for (let y = Math.ceil(4 * scale); y <= Math.floor(7.5 * scale); y++) line += ink(column, y)
      expect(Math.abs(line / deviceScaleFactor - 1)).toBeLessThan(0.04)
    }
  }
})
