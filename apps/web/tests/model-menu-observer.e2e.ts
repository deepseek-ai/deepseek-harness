/** Built-profile browser coverage for sticky model groups; counts only their synchronous rect reads, not FPS or latency. */
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium, webkit } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

declare global {
  interface Window {
    /** Test-private count for MenuGroup sections and their direct scroll viewport. */
    __modelMenuRectReads: number
  }
}

const OVERLAY = fileURLToPath(new URL('./default-model.overlay.yml', import.meta.url))
const PROVIDERS = [
  { id: 'origin-gateway', name: 'Origin Gateway', prefix: 'Origin' },
  { id: 'amber-gateway', name: 'Amber Gateway', prefix: 'Amber' },
  { id: 'cedar-gateway', name: 'Cedar Gateway', prefix: 'Cedar' },
  { id: 'quartz-gateway', name: 'Quartz Gateway', prefix: 'Quartz' },
].map((provider, providerIndex) => ({
  ...provider,
  models: Array.from({ length: 7 }, (_, index) => providerIndex === 0 && index === 0
    ? { id: 'origin-large', name: 'Origin Large', reasoningEfforts: {
      off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
    } }
    : { id: `${provider.prefix.toLowerCase()}-model-${index + 1}`, name: `${provider.prefix} Model ${index + 1}${index === 6 ? ' with a long name that exceeds the model card width' : ''}` }),
}))
const EXPECTED_GROUPS = [
  { label: 'DeepSeek', rows: ['DeepSeek-V4-Flash', 'DeepSeek-V4-Flash-Vision-Exp'] },
  ...PROVIDERS.map(provider => ({ label: provider.name, rows: provider.models.map(model => model.name) })),
]

// Native IO/RO callbacks need rendering opportunities, not elapsed-time sleeps.
async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
  }))
}

function readGroups(viewport: Locator) {
  return viewport.locator('[data-menu-group]').evaluateAll(groups => groups.map(group => ({
    label: group.querySelector('[data-menu-group-heading]')!.textContent,
    rows: [...group.querySelectorAll('[role="option"], [role="menuitemradio"]')].map(row => row.textContent),
  })))
}

function readPinned(viewport: Locator) {
  return viewport.locator('[data-menu-group-heading]').evaluateAll(headings =>
    headings.map(heading => heading.hasAttribute('data-stuck')))
}

async function assertNoRectReads(page: Page): Promise<void> {
  await frames(page)
  expect(await page.evaluate(() => window.__modelMenuRectReads)).toBe(0)
}

async function assertPinned(page: Page, viewport: Locator, index: number, count = 5): Promise<void> {
  const expected = Array.from({ length: count }, (_, i) => i === index)
  await expect.poll(() => readPinned(viewport)).toEqual(expected)
  await assertNoRectReads(page)
  expect(await readPinned(viewport)).toEqual(expected)
}

async function scrollToGroup(viewport: Locator, index: number, inside = 1): Promise<void> {
  // Sections share an offset parent. Their normal-flow offsets are test positioning, not rect instrumentation.
  await viewport.evaluate((node, target) => new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      const groups = node.querySelectorAll<HTMLElement>(':scope > [data-menu-group]')
      node.scrollTop = groups[target.index]!.offsetTop - groups[0]!.offsetTop + target.inside
      resolve()
    })
  }), { index, inside })
}

async function headingMaterial(viewport: Locator) {
  return viewport.locator('[data-menu-group-heading]').first().evaluate((heading) => {
    const body = heading.ownerDocument.body
    const theme = body.getAttribute('data-ds-dark-theme')
    try {
      return [false, true].map((dark) => {
        body.toggleAttribute('data-ds-dark-theme', dark)
        const style = getComputedStyle(heading)
        return {
          fill: style.backgroundColor, radius: style.borderRadius, position: style.position,
          font: style.fontSize, weight: style.fontWeight, padding: style.padding,
        }
      })
    } finally {
      if (theme === null) body.removeAttribute('data-ds-dark-theme')
      else body.setAttribute('data-ds-dark-theme', theme)
    }
  })
}

describe.skipIf(webSnapshotMode() === 'record').each([
  { name: 'Chromium', engine: chromium },
  { name: 'WebKit', engine: webkit },
])('web e2e: model menu observers ($name)', ({ engine }) => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let crashed = false

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    // Catalog-only settings traffic: no prompt, selection, replay fixture, or model request.
    await scaffold.ctx.settings.update('llm-pi-ai', {
      providers: Object.fromEntries(PROVIDERS.map(provider => [provider.id, {
        displayName: provider.name,
        api: 'openai-completions',
        baseURL: `https://${provider.id}.example/v1`,
        models: provider.models,
      }])),
    })
    browser = await engine.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    await page.addInitScript(() => {
      window.__modelMenuRectReads = 0
      // oxlint-disable-next-line typescript/unbound-method -- The wrapper supplies the original Element receiver below.
      const original = Element.prototype.getBoundingClientRect
      Element.prototype.getBoundingClientRect = function (): DOMRect {
        if (this.hasAttribute('data-menu-group') || [...this.children].some(child => child.hasAttribute('data-menu-group'))) {
          window.__modelMenuRectReads++
        }
        return original.call(this)
      }
    })
    page.on('crash', () => { crashed = true; console.error('observer test page crashed') })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  })

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      await scaffold?.close()
    }
  })

  // FIXME: WebKit 26.5 crashes while filtering the grouped model rows in this scenario.
  it.skipIf(engine === webkit)('keeps both pickers ordered, sticky and keyboard-operable without synchronous group rect reads', async () => {
    onTestFailed(() => saveFailureShot(page, `web-e2e-model-menu-observer-${engine.name()}`))
    let buttonMaterial: Awaited<ReturnType<typeof headingMaterial>> | undefined
    for (const entry of ['button', 'command'] as const) {
      const composer = page.locator('[data-composer-input]').first()
      const surface = entry === 'button'
        ? page.getByRole('group', { name: '模型与推理等级', exact: true })
        : page.locator('[aria-label="/model 选项"]')
      const viewport = entry === 'button'
        ? surface.getByRole('menu', { name: '模型', exact: true })
        : surface.getByRole('listbox')
      const search = entry === 'button'
        ? page.getByRole('searchbox', { name: '搜索模型…', exact: true })
        : page.getByRole('textbox', { name: '筛选选项', exact: true })
      const open = async (): Promise<void> => {
        if (entry === 'button') {
          await page.getByRole('button', { name: /^选择模型/ }).click()
          await page.getByRole('menuitem', { name: /^模型/ }).click()
        } else {
          await page.getByRole('button', { name: '添加文件或调用指令', exact: true }).click()
          await page.getByRole('option', { name: /^模型/ }).click()
        }
        await expect.poll(() => readGroups(viewport)).toEqual(EXPECTED_GROUPS)
        await expect.poll(() => search.evaluate(node => node === node.ownerDocument.activeElement)).toBe(true)
        await assertNoRectReads(page)
        await page.mouse.move(0, 0)
        await viewport.evaluate((node) => { node.style.maxHeight = '80px'; node.scrollTop = 0 })
        await assertPinned(page, viewport, -1)
      }
      const close = async (): Promise<void> => {
        if (crashed || page.isClosed() || await surface.count() === 0) return
        await search.press('Escape')
        if (entry === 'button') await page.keyboard.press('Escape')
        await surface.waitFor({ state: 'detached' })
        await composer.fill('')
      }

      await open()
      try {
        expect(await viewport.locator('[role="option"], [role="menuitemradio"]').count()).toBe(30)
        expect(await viewport.evaluate(node => node.scrollTop)).toBe(0)
        expect(await viewport.locator('[data-menu-group-heading]').evaluateAll(headings =>
          [...new Set(headings.map(heading => getComputedStyle(heading).backgroundColor))]))
          .toEqual(['rgba(0, 0, 0, 0)'])
        await scrollToGroup(viewport, 0)
        await assertPinned(page, viewport, 0)
        const material = await headingMaterial(viewport)
        expect(material.map(style => style.fill)).toEqual(['rgba(248, 249, 250, 0.94)', 'rgba(48, 49, 54, 0.94)'])
        for (const style of material) {
          expect(style).toMatchObject({ position: 'sticky', font: '11px', weight: '500', padding: '4px 7px 2px' })
        }
        if (entry === 'button') buttonMaterial = material
        else expect(material).toEqual(buttonMaterial)

        for (const index of [2, 4, 1]) {
          await scrollToGroup(viewport, index)
          await assertPinned(page, viewport, index)
          const height = await viewport.evaluate(node => node.clientHeight)
          expect(height).toBeGreaterThan(0)
          expect(height).toBeLessThanOrEqual(80)
          expect(await viewport.locator('[data-menu-group]').nth(index).evaluate(node => node.clientHeight))
            .toBeGreaterThan(height * 2)
          await scrollToGroup(viewport, index, height + 1)
          await assertPinned(page, viewport, index)
          expect(await viewport.evaluate((node, groupIndex) => {
            const headings = node.querySelectorAll('[data-menu-group-heading]')
            const firstStart = node.querySelector('[data-menu-group-start]')!
            const viewportTop = firstStart.getBoundingClientRect().top + node.scrollTop
            return Math.abs(headings[groupIndex]!.getBoundingClientRect().top - viewportTop)
          }, index)).toBeLessThan(1)
        }
        await scrollToGroup(viewport, 0, 0)
        await assertPinned(page, viewport, -1)

        for (const [key, steps] of [['ArrowDown', 18], ['ArrowUp', 10]] as const) {
          const visited = new Set<number>()
          let observedPinnedHighlight = false
          for (let step = 0; step < steps; step++) {
            const rows = viewport.locator('[role="option"], [role="menuitemradio"]')
            const before = await rows.evaluateAll(nodes => nodes.findIndex(node =>
              node.hasAttribute('data-highlighted') || node.getAttribute('aria-selected') === 'true'))
            await search.press(key)
            const expected = (before + (key === 'ArrowDown' ? 1 : -1) + 30) % 30
            await expect.poll(() => rows.evaluateAll(nodes => nodes.findIndex(node =>
              node.hasAttribute('data-highlighted') || node.getAttribute('aria-selected') === 'true'))).toBe(expected)
            await frames(page)
            await expect.poll(() => viewport.evaluate((node) => {
              const groups = [...node.querySelectorAll<HTMLElement>(':scope > [data-menu-group]')]
              const base = groups[0]!.offsetTop
              return groups.every((group) => {
                const top = group.offsetTop - base
                const shouldStick = top < node.scrollTop && top + group.offsetHeight > node.scrollTop
                return group.querySelector('[data-menu-group-heading]')!.hasAttribute('data-stuck') === shouldStick
              })
            })).toBe(true)
            const highlight = await viewport.evaluate((node) => {
              const groups = [...node.querySelectorAll<HTMLElement>(':scope > [data-menu-group]')]
              const index = groups.findIndex(group => group.querySelector('[data-highlighted], [aria-selected="true"]') !== null)
              const group = groups[index]!
              return { index, above: group.offsetTop - groups[0]!.offsetTop < node.scrollTop,
                stuck: group.querySelector('[data-menu-group-heading]')!.hasAttribute('data-stuck') }
            })
            visited.add(highlight.index)
            if (highlight.above) {
              expect(highlight.stuck).toBe(true)
              observedPinnedHighlight = true
            }
            expect(await search.evaluate(node => node === node.ownerDocument.activeElement)).toBe(true)
            await assertNoRectReads(page)
          }
          expect(visited.size).toBeGreaterThan(1)
          expect(observedPinnedHighlight).toBe(true)
        }

        await scrollToGroup(viewport, 0)
        await assertPinned(page, viewport, 0)
        await search.fill('Quartz Model 1')
        await expect.poll(() => readGroups(viewport)).toEqual([{ label: 'Quartz Gateway', rows: ['Quartz Model 1'] }])
        await assertPinned(page, viewport, -1, 1)
        expect(await viewport.evaluate(node => node.scrollTop)).toBe(0)
        await search.fill('')
        await expect.poll(() => readGroups(viewport)).toEqual(EXPECTED_GROUPS)
        await assertPinned(page, viewport, -1)
        await close()
        await open()
        expect(await search.inputValue()).toBe('')

        await scrollToGroup(viewport, 3, 90)
        await assertPinned(page, viewport, 3)
        await viewport.evaluate((node) => { node.style.maxHeight = '64px' })
        await expect.poll(() => viewport.evaluate(node => node.clientHeight)).toBeLessThanOrEqual(64)
        await assertPinned(page, viewport, 3)
        await scrollToGroup(viewport, 4, 100)
        await assertPinned(page, viewport, 4)
        await scrollToGroup(viewport, 1, 100)
        await assertPinned(page, viewport, 1)
        await scrollToGroup(viewport, 0, 0)
        await assertPinned(page, viewport, -1)
      } finally {
        await close()
      }
    }
    expect(scaffold.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'origin-gateway', model: 'origin-large' })
    expect(tripwire.pageErrors).toEqual([])
  })
  it.runIf(engine === chromium)('keeps the model card at layout size when zooming beyond the visual viewport', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-model-menu-zoom'))
    const cdp = await page.context().newCDPSession(page)
    try {
      await page.setViewportSize({ width: 402, height: 874 })
      await page.getByRole('button', { name: /^选择模型/ }).click()
      await page.getByRole('menuitem', { name: /^模型/ }).click()
      const panel = page.getByRole('group', { name: '模型与推理等级', exact: true })
      for (const height of [874, 500]) {
        await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
        await page.setViewportSize({ width: 402, height })
        await frames(page)
        const unzoomed = await panel.evaluate((node) => {
          const rect = node.getBoundingClientRect()
          const anchor = document.querySelector(`[aria-controls="${node.id}"]`)!.getBoundingClientRect()
          return { width: rect.width, height: rect.height, rightGap: rect.right - anchor.right,
            bottomGap: anchor.top - rect.bottom }
        })
        await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2.5 })
        await expect.poll(() => page.evaluate(() => window.visualViewport!.scale)).toBe(2.5)
        await expect.poll(() => panel.evaluate((node, before) => {
          const rect = node.getBoundingClientRect()
          const anchor = document.querySelector(`[aria-controls="${node.id}"]`)!.getBoundingClientRect()
          return Math.max(Math.abs(rect.width - before.width), Math.abs(rect.height - before.height),
            Math.abs(rect.right - anchor.right - before.rightGap), Math.abs(anchor.top - rect.bottom - before.bottomGap))
        }, unzoomed)).toBeLessThan(1)
        expect(await panel.evaluate(node => node.getBoundingClientRect().width > window.visualViewport!.width)).toBe(true)
        const models = page.getByRole('menu', { name: '模型', exact: true })
        const names = models.locator('[data-model-id]').locator('..')
        expect(await names.evaluateAll(labels => labels.every(label =>
          getComputedStyle(label).textOverflow === 'ellipsis'))).toBe(true)
        expect(await names.evaluateAll(labels => labels.some(label =>
          label.scrollWidth > label.clientWidth))).toBe(true)
        expect(await models.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
        const widths = await models.locator('[role="menuitemradio"]').evaluateAll(rows => rows.map(row => ({
          right: row.lastElementChild!.getBoundingClientRect().right,
          width: row.getBoundingClientRect().width,
        })))
        expect(Math.max(...widths.map(row => row.right)) - Math.min(...widths.map(row => row.right))).toBeLessThan(1)
        expect(Math.max(...widths.map(row => row.width)) - Math.min(...widths.map(row => row.width))).toBeLessThan(1)
        await scrollToGroup(models, 1, 10)
        await expect.poll(() => models.locator('[data-menu-group-heading]').nth(1).getAttribute('data-stuck')).not.toBeNull()
        const coversViewport = await models.evaluate((node) => {
          const viewport = node.getBoundingClientRect()
          const heading = node.querySelector('[data-menu-group-heading][data-stuck]')!.getBoundingClientRect()
          return heading.left <= viewport.left + 1 && heading.right >= viewport.right - 1
        })
        expect(coversViewport).toBe(true)
      }
    } finally {
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
      await cdp.detach()
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await page.setViewportSize({ width: 1680, height: 1000 })
    }
  })

  it.runIf(engine === chromium)('aligns the menu with its anchor after zooming and panning both viewport axes', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-model-menu-pan'))
    const cdp = await page.context().newCDPSession(page)
    try {
      await page.setViewportSize({ width: 1440, height: 1000 })
      const trigger = page.getByRole('button', { name: /^选择模型/ })
      await trigger.click()
      const menu = page.getByRole('menu', { name: '模型与推理等级', exact: true })
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.5 })
      await expect.poll(() => page.evaluate(() => window.visualViewport!.scale)).toBe(1.5)
      await frames(page)
      const target = await menu.evaluate((panel) => {
        const viewport = window.visualViewport!
        const anchor = document.querySelector(`[aria-controls="${panel.id}"]`)!.getBoundingClientRect()
        const rect = panel.getBoundingClientRect()
        // Keep the preferred placement away from clamps so adding an offset twice cannot pass.
        const left = Math.max(1, anchor.right - viewport.width + 12)
        const right = Math.min(window.innerWidth - viewport.width, anchor.right - rect.width - 12)
        const top = Math.max(1, anchor.top - 8 + 12 - viewport.height)
        const bottom = Math.min(window.innerHeight - viewport.height, anchor.top - 8 - rect.height - 12)
        const dx = (left + right) / 2 - viewport.offsetLeft
        const dy = (top + bottom) / 2 - viewport.offsetTop
        return { left, right, top, bottom, dx, dy,
          x: viewport.width / 2, y: viewport.height / 2 }
      })
      expect(target.right).toBeGreaterThan(target.left)
      expect(target.bottom).toBeGreaterThan(target.top)
      // Use native wheel scrolling; Linux headless synthetic touch can deliver events without scrolling.
      await cdp.send('Input.synthesizeScrollGesture', {
        x: target.x, y: target.y, xDistance: -target.dx, yDistance: 0, gestureSourceType: 'mouse', speed: 800,
      })
      await expect.poll(() => page.evaluate(() => window.visualViewport!.offsetLeft)).toBeGreaterThan(0)
      await frames(page)
      await cdp.send('Input.synthesizeScrollGesture', {
        x: target.x, y: target.y, yDistance: -target.dy, gestureSourceType: 'mouse', speed: 800,
      })
      await expect.poll(() => page.evaluate(() => Math.min(window.visualViewport!.offsetLeft,
        window.visualViewport!.offsetTop))).toBeGreaterThan(0)
      await expect.poll(() => menu.evaluate((panel) => {
        const anchor = document.querySelector(`[aria-controls="${panel.id}"]`)!.getBoundingClientRect()
        const rect = panel.getBoundingClientRect()
        return Math.max(Math.abs(rect.right - anchor.right), Math.abs(anchor.top - rect.bottom - 8))
      })).toBeLessThan(1)
    } finally {
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
      await cdp.detach()
      await page.keyboard.press('Escape')
      await page.setViewportSize({ width: 1680, height: 1000 })
    }
  })

  it.runIf(engine === chromium)('keeps reasoning efforts selectable after zooming with and without list overflow', async () => {
    const cdp = await page.context().newCDPSession(page)
    try {
      for (const { height, scrolls } of [{ height: 500, scrolls: false }, { height: 350, scrolls: true }]) {
        await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
        await page.setViewportSize({ width: 402, height })
        await page.getByRole('button', { name: /^选择模型/ }).click()
        await page.getByRole('menuitem', { name: /^推理等级/ }).click()
        const menu = page.getByRole('menu', { name: '模型与推理等级', exact: true })
        await menu.getByRole('menuitemradio').first().click()
        await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection().reasoningEffort).toBeUndefined()
        await page.getByRole('button', { name: /^选择模型/ }).click()
        await page.getByRole('menuitem', { name: /^推理等级/ }).click()
        const last = menu.getByRole('menuitemradio').last()
        await expect.poll(() => last.getAttribute('aria-checked')).toBe('false')
        await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2.5 })
        await expect.poll(() => page.evaluate(() => window.visualViewport!.scale)).toBe(2.5)
        expect(await menu.getByRole('menuitemradio').count()).toBeGreaterThanOrEqual(7)
        await expect.poll(() => last.evaluate((row) => {
          const scroller = row.parentElement!
          scroller.scrollTop = scroller.scrollHeight
          return { overflow: getComputedStyle(scroller).overflowY,
            overflows: scroller.scrollHeight > scroller.clientHeight, moved: scroller.scrollTop > 0 }
        })).toEqual({ overflow: 'auto', overflows: scrolls, moved: scrolls })
        await expect.poll(() => last.evaluate((row) => {
          const rect = row.getBoundingClientRect()
          const viewport = row.parentElement!.getBoundingClientRect()
          return rect.top >= viewport.top - 1 && rect.bottom <= viewport.bottom + 1
        })).toBe(true)
        const target = await last.evaluate((row) => {
          const rect = row.getBoundingClientRect()
          const viewport = window.visualViewport!
          return {
            left: Math.max(0, Math.min(window.innerWidth - viewport.width, rect.left + rect.width / 2 - viewport.width / 2)),
            top: Math.max(0, Math.min(window.innerHeight - viewport.height, rect.top + rect.height / 2 - viewport.height / 2)),
            offsetLeft: viewport.offsetLeft, offsetTop: viewport.offsetTop,
          }
        })
        // Pan from the page margin so wheel input cannot scroll the list instead.
        await cdp.send('Input.synthesizeScrollGesture', {
          x: 1, y: 1, xDistance: target.offsetLeft - target.left, yDistance: target.offsetTop - target.top,
          gestureSourceType: 'mouse', speed: 800,
        })
        await expect.poll(() => last.evaluate((row) => {
          const rect = row.getBoundingClientRect()
          const viewport = window.visualViewport!
          const x = rect.left + rect.width / 2 - viewport.offsetLeft
          const y = rect.top + rect.height / 2 - viewport.offsetTop
          return x >= 0 && x < viewport.width && y >= 0 && y < viewport.height
        })).toBe(true)
        // Dispatch touch without locator auto-scrolling the last row into view.
        const point = await last.evaluate((row) => {
          const rect = row.getBoundingClientRect()
          const viewport = window.visualViewport!
          return { x: rect.left + rect.width / 2 - viewport.offsetLeft,
            y: rect.top + rect.height / 2 - viewport.offsetTop }
        })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection()).toMatchObject({ reasoningEffort: 'max' })
        await menu.waitFor({ state: 'detached' })
      }
    } finally {
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
      await cdp.detach()
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await page.setViewportSize({ width: 1680, height: 1000 })
    }
  })
})
