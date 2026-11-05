/** Keyless real-profile checks for the default official-home decoration and native input isolation. */
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const artifacts = fileURLToPath(new URL('../../../.artifacts/home-whale/', import.meta.url))

describe('official home whale in the default web profile', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let consoleState: ReturnType<typeof watchConsole>
  let captureDir: string

  beforeAll(async () => {
    await mkdir(artifacts, { recursive: true })
    captureDir = await mkdtemp(join(artifacts, 'run-'))
    scaffold = await launchWebScaffold({ firstUse: true })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    consoleState = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await page.locator('[data-home-whale]').waitFor()
    await page.locator('[data-composer-input]').waitFor()
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      await scaffold?.close()
    }
  })

  it('alternates grayscale dot and code breaches on click and respects reduced motion', async () => {
    const canvas = page.locator('[data-home-whale]')
    const surface = page.locator('[data-conversation-content]')
    const pixelSummary = () => canvas.evaluate((node: HTMLCanvasElement) => {
      const values = node.getContext('2d')!.getImageData(0, 0, node.width, node.height).data
      let saturated = 0
      let opaque = 0
      let nontransparent = 0
      let contrast = 0
      for (let i = 0; i < values.length; i += 4) {
        const alpha = values[i + 3]! / 255
        if (alpha > 0) nontransparent++
        if (values[i + 3]! > 2) opaque++
        contrast = Math.max(contrast, (255 - Math.min(values[i]!, values[i + 1]!, values[i + 2]!)) * alpha)
        if (values[i + 3]! > 10 && values[i + 2]! - values[i]! > 8 && values[i + 2]! - values[i + 1]! > 4) saturated++
      }
      return { saturated, opaque, nontransparent, contrast }
    })
    expect(await canvas.evaluate(node => getComputedStyle(node).pointerEvents)).toBe('none')
    expect(await canvas.getAttribute('aria-hidden')).toBe('true')
    expect(await canvas.evaluate(node => getComputedStyle(node).filter)).toBe('grayscale(1)')
    await expect.poll(async () => (await pixelSummary()).nontransparent).toBe(0)
    await page.screenshot({ path: `${captureDir}/idle.png` })
    const box = await surface.boundingBox()
    expect(box).not.toBeNull()
    const card = (await page.locator('[data-composer-card]').boundingBox())!
    // The home above the input card, read from the composited page: it changes only if the canvas shows through.
    const homeClip = { x: box!.x, y: box!.y, width: box!.width, height: card.y - box!.y }
    const idleHome = await page.screenshot({ clip: homeClip })
    const marginX = box!.x + 12
    const marginY = card.y + card.height / 2
    expect(await page.evaluate(({ x, y }) =>
      document.elementFromPoint(x, y)?.closest('[data-composer-seat]') !== null,
    { x: marginX, y: marginY })).toBe(true)
    await page.clock.install()
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000))
    try {
      await page.mouse.click(marginX, marginY)
      await expect.poll(async () => {
        await page.clock.runFor(100)
        return (await pixelSummary()).opaque
      }).toBeGreaterThan(300)
      await page.clock.runFor(1500)
      await page.screenshot({ path: `${captureDir}/ripple.png` })
      await page.mouse.click(box!.x + box!.width * 0.78, box!.y + box!.height * 0.72)
      expect((await pixelSummary()).opaque).toBeGreaterThan(0)
      expect((await pixelSummary()).contrast).toBeLessThanOrEqual(100)
      // The last visible pixels disappear before the playback deadline; finish the full timeline before the next click.
      await page.clock.runFor(5700)
      expect((await pixelSummary()).nontransparent).toBe(0)

      await page.mouse.click(box!.x + box!.width * 0.78, box!.y + box!.height * 0.72)
      await page.clock.runFor(1500)
      expect((await pixelSummary()).opaque).toBeGreaterThan(300)
      expect((await page.screenshot({ clip: homeClip })).equals(idleHome)).toBe(false)
      await page.screenshot({ path: `${captureDir}/code.png` })
      await page.clock.runFor(5700)
      expect((await pixelSummary()).nontransparent).toBe(0)

      await page.emulateMedia({ reducedMotion: 'reduce' })
      const staticFrame = await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL())
      await page.mouse.click(box!.x + 100, box!.y + 150)
      await page.clock.runFor(300)
      expect(await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL())).toBe(staticFrame)
    } finally {
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await page.clock.resume()
    }
  })

  it('keeps native draft editing independent of the decoration', async () => {
    const input = page.locator('[data-composer-input]')
    await input.fill('保留这个试用草稿')
    const canvas = page.locator('[data-home-whale]')
    const idleFrame = await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL())
    await input.click()
    // Observe several normal animation frames while focus stays in the composer.
    await page.waitForTimeout(300)
    expect(await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL())).toBe(idleFrame)
    expect(await input.innerText()).toBe('保留这个试用草稿')
    await input.press('ControlOrMeta+A')
    await input.press('Backspace')
  })

  it('paints the decoration between the Conversation background and the home content', async () => {
    const order = await page.locator('[data-home-whale]').evaluate((node) => {
      // The canvas's negative z-index resolves in the nearest ancestor that establishes a stacking context. Walk up to
      // the document root and report the first one, which must be the home Conversation root that paints the background.
      const stacking = (element: Element): boolean => {
        const style = getComputedStyle(element)
        return style.isolation === 'isolate' || (style.zIndex !== 'auto' && style.position !== 'static')
          || style.transform !== 'none' || style.opacity !== '1' || style.filter !== 'none'
      }
      let context: Element | null = node.parentElement
      while (context !== null && context !== document.documentElement && !stacking(context)) context = context.parentElement
      if (context === null || context === document.documentElement) return { found: false }
      return {
        found: true,
        canvasZIndex: getComputedStyle(node).zIndex,
        conversationPhase: context.getAttribute('data-phase'),
        isolation: getComputedStyle(context).isolation,
        paintsBackground: getComputedStyle(context).backgroundColor !== 'rgba(0, 0, 0, 0)',
      }
    })
    expect(order).toEqual({
      found: true, canvasZIndex: '-1', conversationPhase: 'hero', isolation: 'isolate', paintsBackground: true,
    })
  })

  it('loads from the default composition without a separately enabled bundle', async () => {
    await page.reload()
    await page.locator('[data-home-whale]').waitFor()
    const facts = await page.locator('[data-home-whale]').evaluate(node => ({
      count: document.querySelectorAll('[data-home-whale]').length,
      hiddenFromAssistiveTech: node.getAttribute('aria-hidden'),
      pointerEvents: getComputedStyle(node).pointerEvents,
      nativeComposer: document.querySelectorAll('[data-composer-seat]').length,
    }))
    expect(facts).toMatchInlineSnapshot(`
      {
        "count": 1,
        "hiddenFromAssistiveTech": "true",
        "nativeComposer": 1,
        "pointerEvents": "none",
      }
    `)
    expect(consoleState.pageErrors).toEqual([])
    expect(consoleState.warnings).toEqual([])
  })

  it('keeps neutral dots visible in both themes and fits a narrow home', async () => {
    const settings = scaffold.ctx.get('settings')!
    const canvas = page.locator('[data-home-whale]')
    const visibleDots = () => canvas.evaluate((node: HTMLCanvasElement) =>
      node.getContext('2d')!.getImageData(0, 0, node.width, node.height).data.some((value, i) => i % 4 === 3 && value > 10))
    const clickHome = async () => {
      const box = (await page.locator('[data-conversation-content]').boundingBox())!
      await page.mouse.click(box.x + box.width * 0.78, box.y + box.height * 0.18)
    }
    await settings.update('ui-theme', { preference: 'light' })
    await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBeNull()
    const lightInk = await canvas.evaluate(node => getComputedStyle(node).color)
    await clickHome()
    await expect.poll(visibleDots).toBe(true)
    try {
      await settings.update('ui-theme', { preference: 'dark' })
      await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe('')
      await expect.poll(() => canvas.evaluate(node => getComputedStyle(node).color)).not.toBe(lightInk)
      // A click during playback is ignored and a fading breach can already read as blank, so keep clicking until a
      // breach is visible after the theme switch.
      await expect.poll(async () => { await clickHome(); return visibleDots() }, { timeout: 15_000 }).toBe(true)
      await page.screenshot({ path: `${captureDir}/dark.png` })
      await page.setViewportSize({ width: 390, height: 844 })
      const box = (await canvas.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(390)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    } finally {
      await page.setViewportSize({ width: 1440, height: 960 })
      await settings.update('ui-theme', { preference: 'light' })
    }
  })
})
