/** Narrow sidebar geometry, navigation, focus and retained content in the shipped profile. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Locator } from 'playwright'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode } from './scaffold.ts'

/** A returning rail uses its compact layout without wide-content or icon-entry animations. */
async function assertCompactRail(sidebar: Locator): Promise<void> {
  expect(await sidebar.getByRole('button', { name: 'New session', exact: true }).count()).toBe(1)
  expect(await sidebar.evaluate((el) => {
    const root = el.firstElementChild!
    return {
      fits: root.getBoundingClientRect().width <= el.parentElement!.getBoundingClientRect().width,
      animations: root.getAnimations({ subtree: true })
        .filter((animation): animation is CSSAnimation =>
          animation instanceof CSSAnimation && /wide-in|rail-in|rail-fade-in/.test(animation.animationName))
        .map(animation => animation.animationName),
    }
  })).toEqual({ fits: true, animations: [] })
}

it.each(['light', 'dark'] as const)('keeps the macOS drawer opaque and excludes inert content from window drag regions in %s mode', async (colorScheme) => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  try {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 520, height: 680 }, colorScheme, locale: 'en-US' })
      await page.goto(scaffold.authenticatedUrl)
      const opener = page.getByRole('button', { name: 'Open sidebar', exact: true })
      await opener.waitFor()
      await page.evaluate(() => { document.documentElement.dataset.platform = 'darwin' })
      await opener.click()
      const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true })
      await drawer.waitFor()
      const column = page.locator('[data-slot="sidebar"]').locator('..')
      const background = await column.evaluate((el) => {
        const style = getComputedStyle(el)
        return { color: style.backgroundColor, image: style.backgroundImage }
      })
      expect(background.image).toBe('none')
      expect(background.color).toMatch(/^rgb\(/)
      expect(await drawer.getByRole('button', { name: 'New session', exact: true }).last().evaluate((el) => {
        const actual = getComputedStyle(el).backgroundColor
        const root = document.documentElement
        const platform = root.dataset.platform
        delete root.dataset.platform
        try {
          return actual === getComputedStyle(el).backgroundColor
        } finally {
          root.dataset.platform = platform
        }
      })).toBe(true)
      const inactiveContent = page.locator('[inert], [inert] *')
      expect(await inactiveContent.count()).toBeGreaterThan(0)
      expect(await inactiveContent.evaluateAll(elements => elements
        .filter(el => getComputedStyle(el).getPropertyValue('app-region') !== 'none')
        .map(el => `${el.tagName}.${el.getAttribute('class')}: ${getComputedStyle(el).getPropertyValue('app-region')}`)))
        .toEqual([])
      expect(await drawer.locator('[data-window-drag]').first().evaluate(el => getComputedStyle(el).getPropertyValue('app-region')))
        .toBe('drag')
      const collapse = drawer.getByRole('button', { name: 'Collapse sidebar', exact: true })
      await collapse.click()
      await drawer.waitFor({ state: 'hidden' })
      await page.setViewportSize({ width: 1200, height: 800 })
      const sidebar = page.locator('[data-slot="sidebar"]').locator('..')
      await expect.poll(() => sidebar.evaluate(el => getComputedStyle(el).backgroundImage)).not.toBe('none')
      const activeDragRows = page.locator('[data-window-drag]:not([inert] [data-window-drag])')
      expect(await activeDragRows.count()).toBeGreaterThan(0)
      expect(await activeDragRows.evaluateAll(rows => rows.every(row => getComputedStyle(row).getPropertyValue('app-region') === 'drag')))
        .toBe(true)
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})

it('hides a collapsed rail immediately when it becomes a drawer', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  try {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 768, height: 844 }, locale: 'en-US' })
      await page.goto(scaffold.authenticatedUrl)
      await page.getByRole('button', { name: 'Open sidebar', exact: true }).waitFor()
      const sidebar = page.locator('[data-slot="sidebar"]')
      const sidebarColumn = sidebar.locator('..')
      await expect.poll(async () => (await sidebarColumn.boundingBox())?.width).toBe(56)
      await sidebarColumn.evaluate((el) => {
        el.parentElement!.style.setProperty('--ds-transition-duration-slow', '100s')
      })
      await page.setViewportSize({ width: 767, height: 844 })
      await page.locator('[data-sidebar-drawer]').waitFor()
      const state = await sidebarColumn.evaluate(el => ({
        visibility: getComputedStyle(el).visibility,
        transitions: el.getAnimations().filter(animation => animation instanceof CSSTransition)
          .map(animation => animation.transitionProperty),
      }))
      expect(state).toEqual({ visibility: 'hidden', transitions: [] })
      await page.setViewportSize({ width: 768, height: 844 })
      await page.locator('[data-sidebar-drawer]').waitFor({ state: 'detached' })
      await assertCompactRail(sidebar)
      await page.setViewportSize({ width: 767, height: 844 })
      await page.locator('[data-sidebar-drawer]').waitFor()
      await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
      const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true })
      await drawer.waitFor()
      expect(await sidebarColumn.evaluate(el => el.getAnimations().some(animation =>
        animation instanceof CSSTransition && animation.transitionProperty === 'transform'))).toBe(true)
      await sidebarColumn.evaluate((el) => {
        for (const animation of el.parentElement!.getAnimations({ subtree: true })) animation.finish()
      })
      await drawer.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
      expect(await sidebarColumn.evaluate(el => el.getAnimations().some(animation =>
        animation instanceof CSSTransition && animation.transitionProperty === 'transform'))).toBe(true)
      await sidebarColumn.evaluate((el) => {
        for (const animation of el.parentElement!.getAnimations({ subtree: true })) animation.finish()
      })
      await page.setViewportSize({ width: 768, height: 844 })
      await page.locator('[data-sidebar-drawer]').waitFor({ state: 'detached' })
      await assertCompactRail(sidebar)
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})

it('retains the closing slide when an expanded sidebar becomes a collapsed drawer', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  try {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1024, height: 844 }, locale: 'en-US' })
      await page.goto(scaffold.authenticatedUrl)
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).waitFor()
      const sidebarColumn = page.locator('[data-slot="sidebar"]').locator('..')
      await expect.poll(async () => (await sidebarColumn.boundingBox())?.width).toBe(280)
      await sidebarColumn.evaluate((el) => {
        el.parentElement!.style.setProperty('--ds-transition-duration-slow', '100s')
      })
      await page.setViewportSize({ width: 767, height: 844 })
      await page.locator('[data-sidebar-drawer][data-sidebar-collapsed]').waitFor()
      expect(await sidebarColumn.evaluate(el => el.getAnimations().some(animation =>
        animation instanceof CSSTransition && animation.transitionProperty === 'transform'))).toBe(true)
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})

/** Sample the CSS fade at its midpoint without depending on the host's frame rate. */
async function assertMaskFade(frame: Locator, from: number, to: number): Promise<void> {
  const sample = await frame.locator('[data-sidebar-mask]').evaluate((el) => {
    const fade = el.getAnimations().find(animation => animation instanceof CSSTransition && animation.transitionProperty === 'opacity')
    if (fade === undefined || !(fade.effect instanceof KeyframeEffect)) throw new Error('Drawer mask opacity transition is missing')
    fade.pause()
    fade.currentTime = Number(fade.effect.getComputedTiming().duration) / 2
    return {
      endpoints: fade.effect.getKeyframes().map(keyframe => Number(keyframe.opacity)),
      opacity: Number(getComputedStyle(el).opacity),
    }
  })
  expect(sample.endpoints).toEqual([from, to])
  expect(sample.opacity).toBeGreaterThan(0)
  expect(sample.opacity).toBeLessThan(1)
  await frame.evaluate((el) => {
    for (const animation of el.getAnimations({ subtree: true })) {
      if (animation instanceof CSSTransition) animation.finish()
    }
    el.style.removeProperty('--ds-transition-duration-slow')
  })
}

/** Sample both width transitions on the same clock to detect detached sidebar controls. */
async function assertFoldResize(toggle: Locator, from: number, to: number): Promise<void> {
  await expect.poll(() => toggle.evaluate((button, target) => {
    const frame = button.closest<HTMLElement>('[data-animating]')
    return frame !== null && parseFloat(frame.style.gridTemplateColumns) === target && frame.getAnimations().some(animation =>
      animation instanceof CSSTransition && animation.transitionProperty === 'grid-template-columns')
  }, to)).toBe(true)
  const sample = await toggle.evaluate((button) => {
    const frame = button.closest<HTMLElement>('[data-animating]')!
    const transitions = frame.getAnimations({ subtree: true }).filter((animation): animation is CSSTransition =>
      animation instanceof CSSTransition && ['grid-template-columns', 'width'].includes(animation.transitionProperty))
    const grid = transitions.find(animation => animation.transitionProperty === 'grid-template-columns')
    if (grid === undefined) throw new Error('Fold width transition is missing')
    const at = (progress: number) => {
      for (const transition of transitions) {
        transition.pause()
        transition.currentTime = Number(transition.effect!.getComputedTiming().duration) * progress
      }
      const width = parseFloat(getComputedStyle(frame).gridTemplateColumns)
      return { width, gap: frame.getBoundingClientRect().left + width - button.getBoundingClientRect().right }
    }
    const start = at(0)
    const middle = at(0.5)
    const end = at(1)
    for (const transition of transitions) transition.finish()
    frame.style.removeProperty('--ds-transition-duration-slow')
    return { endpoints: [start.width, end.width], start, middle }
  })
  expect(sample.endpoints).toEqual([from, to])
  expect(sample.middle.width).toBeGreaterThan(Math.min(from, to))
  expect(sample.middle.width).toBeLessThan(Math.max(from, to))
  expect(sample.middle.gap).toBeCloseTo(sample.start.gap, 1)
}

it('overlays the conversation and closes after navigation without losing its sidebar content', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const seed = await readFile(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url), 'utf8')
    const sessionId = await seedSession(scaffold, seed, 'session-c4421b66-252e-44c0-80ed-6e320abeba25')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'Drawer navigation' })
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, locale: 'en-US' })
      const console = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      const opener = page.getByRole('button', { name: 'Open sidebar', exact: true })
      await opener.waitFor()
      const frame = page.locator('[data-sidebar-drawer]')
      expect(await page.locator('[data-shell-leading]').getByRole('button').count()).toBe(1)
      expect(await frame.evaluate(el => getComputedStyle(el).getPropertyValue('--dsh-frame-leading-clearance').trim()))
        .toBe('48px')
      await expect.poll(() => frame.getAttribute('data-sidebar-collapsed')).toBe('true')
      const sidebar = page.locator('[data-slot="sidebar"]')
      const original = await sidebar.elementHandle()
      const main = page.locator('[data-slot="main"]').locator('..')
      const closed = await main.boundingBox()
      // A long test-owned duration keeps the transition available until its
      // animation clock is sampled and finished explicitly.
      await frame.evaluate((el) => { el.style.setProperty('--ds-transition-duration-slow', '100s') })
      await opener.tap()
      const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true })
      await drawer.waitFor()
      await assertMaskFade(frame, 0, 1)
      await expect.poll(() => main.boundingBox()).toEqual(closed)
      expect(closed?.width).toBe(390)
      expect(await main.evaluate(el => el.closest('[inert]') !== null)).toBe(true)
      expect(await page.locator('[data-side="sidebar"]').count()).toBe(0)
      const workspaceRow = drawer.locator('[data-row-key^="workspace:"]').first()
      const workspaceButtons = workspaceRow.getByRole('button', { includeHidden: true })
      expect(await workspaceRow.getAttribute('aria-expanded')).toBe('true')
      expect(await workspaceButtons.count()).toBe(2)
      for (const button of await workspaceButtons.all()) await button.waitFor()
      await workspaceRow.tap()
      expect(await workspaceRow.getAttribute('aria-expanded')).toBe('false')
      for (const button of await workspaceButtons.all()) expect(await button.isVisible()).toBe(false)
      await workspaceRow.tap()
      for (const button of await workspaceButtons.all()) await button.waitFor()
      await drawer.getByRole('button', { name: 'Search sessions', exact: true }).tap()
      const search = drawer.getByPlaceholder('Search session names')
      expect(await search.evaluate(el => getComputedStyle(el).fontSize)).toBe('16px')
      await drawer.getByRole('button', { name: 'Clear search', exact: true }).tap()
      await frame.evaluate((el) => { el.style.setProperty('--ds-transition-duration-slow', '100s') })
      await page.getByRole('treeitem').filter({ has: page.getByText('Drawer navigation', { exact: true }) }).tap()
      await assertMaskFade(frame, 1, 0)
      await drawer.waitFor({ state: 'hidden' })
      await page.getByRole('navigation', { name: 'Session hierarchy' }).getByText('Drawer navigation', { exact: true }).waitFor()
      const chatTab = page.getByRole('tab', { name: 'Chat', exact: true })
      const tabInset = () => chatTab.evaluate((tab) => {
        const label = document.createRange()
        label.selectNodeContents(tab)
        return label.getBoundingClientRect().left - tab.closest('header')!.getBoundingClientRect().left
      })
      expect(await tabInset()).toBeCloseTo(20, 1)
      // Restore CSS-probe markers in the same synchronous task, before rendering.
      const desktopInsets = await chatTab.evaluate((tab) => {
        const root = document.documentElement
        try {
          return ['darwin', 'win32'].map((platform) => {
            root.dataset.platform = platform
            const label = document.createRange()
            label.selectNodeContents(tab)
            return label.getBoundingClientRect().left - tab.closest('header')!.getBoundingClientRect().left
          })
        } finally {
          delete root.dataset.platform
        }
      })
      for (const inset of desktopInsets) expect(inset).toBeCloseTo(28, 1)
      await page.setViewportSize({ width: 768, height: 844 })
      await frame.waitFor({ state: 'detached' })
      expect(await tabInset()).toBeCloseTo(28, 1)
      await page.setViewportSize({ width: 390, height: 844 })
      await frame.waitFor()
      await opener.click()
      const selectedRow = drawer.getByRole('treeitem', { selected: true })
      const more = selectedRow.getByRole('button', { name: 'Session actions for Drawer navigation', exact: true })
      await more.waitFor()
      expect(await selectedRow.getByRole('button', { name: 'Archive session', exact: true }).isVisible()).toBe(false)
      expect(await selectedRow.getByRole('button', { name: 'Pin session', exact: true }).isVisible()).toBe(false)
      expect(await selectedRow.getByRole('button').count()).toBe(1)
      await more.tap()
      const menu = page.getByRole('menu')
      await menu.getByRole('menuitem', { name: 'Archive session', exact: true }).waitFor()
      await menu.getByRole('menuitem', { name: 'Pin session', exact: true }).tap()
      await menu.waitFor({ state: 'hidden' })
      const unpin = selectedRow.getByRole('button', { name: 'Unpin session', exact: true })
      await expect.poll(() => selectedRow.getByLabel('Pinned', { exact: true }).count()).toBe(1)
      expect(await unpin.isVisible()).toBe(true)
      const timestamp = selectedRow.getByText(/^(?:now|\d+min)$/, { exact: true })
      expect(await timestamp.count()).toBe(1)
      expect(await timestamp.textContent()).toMatch(/^(?:now|\d+min)$/)
      expect(await timestamp.isVisible()).toBe(false)
      const unpinBox = (await unpin.boundingBox())!
      const moreBox = (await more.boundingBox())!
      const folderMoreBox = (await workspaceButtons.nth(0).boundingBox())!
      const folderNewBox = (await workspaceButtons.nth(1).boundingBox())!
      expect(moreBox.x - unpinBox.x).toBeCloseTo(folderNewBox.x - folderMoreBox.x, 1)
      await unpin.tap()
      await expect.poll(() => selectedRow.getByLabel('Pinned', { exact: true }).count()).toBe(0)
      expect(await drawer.isVisible()).toBe(true)
      await more.tap()
      await menu.getByRole('menuitem', { name: 'Pin session', exact: true }).tap()
      await menu.waitFor({ state: 'hidden' })
      await unpin.waitFor()
      await more.tap()
      await menu.getByRole('menuitem', { name: 'Unpin session', exact: true }).tap()
      await menu.waitFor({ state: 'hidden' })
      await expect.poll(() => selectedRow.getByLabel('Pinned', { exact: true }).count()).toBe(0)
      await drawer.getByRole('button', { name: 'Plugins', exact: true }).tap()
      await drawer.waitFor({ state: 'hidden' })
      const pluginPanel = page.locator('[data-plugin-panel]')
      await pluginPanel.waitFor()
      for (const width of [390, 767, 768]) {
        await page.setViewportSize({ width, height: 844 })
        expect(await pluginPanel.evaluate(el => Number.parseFloat(getComputedStyle(el).paddingLeft)))
          .toBeCloseTo(width < 768 ? 20 : width * 0.04, 1)
      }
      await page.setViewportSize({ width: 390, height: 844 })
      await frame.waitFor()
      await opener.click()
      await drawer.getByRole('button', { name: 'Automation tasks', exact: true }).tap()
      await drawer.waitFor({ state: 'hidden' })
      const tasksContent = page.getByTestId('task-manager-page').locator('[class*="pageContent"]')
      await tasksContent.waitFor()
      for (const width of [390, 767, 768]) {
        await page.setViewportSize({ width, height: 844 })
        expect(await tasksContent.evaluate(el => Number.parseFloat(getComputedStyle(el).paddingLeft)))
          .toBeCloseTo(width < 768 ? 20 : width * 0.04, 1)
      }
      await page.setViewportSize({ width: 390, height: 844 })
      await frame.waitFor()
      await opener.click()
      await drawer.waitFor()
      await page.touchscreen.tap(370, 420)
      await drawer.waitFor({ state: 'hidden' })
      await opener.click()
      await page.keyboard.press('Escape')
      await drawer.waitFor({ state: 'hidden' })
      expect(await opener.evaluate(el => el === document.activeElement)).toBe(true)
      expect(await sidebar.evaluate((el, previous) => el === previous, original)).toBe(true)
      await original?.dispose()

      await page.setViewportSize({ width: 768, height: 844 })
      await expect.poll(() => frame.count()).toBe(0)
      await expect.poll(async () => Math.round((await main.boundingBox())!.width)).toBe(712)
      await page.setViewportSize({ width: 767, height: 844 })
      await expect.poll(() => frame.count()).toBe(1)

      await page.emulateMedia({ reducedMotion: 'reduce' })
      await opener.tap()
      const mask = frame.locator('[data-sidebar-mask]')
      expect(await mask.evaluate(el => getComputedStyle(el).opacity)).toBe('1')
      expect(await mask.evaluate(el => el.getAnimations().length)).toBe(0)
      await drawer.getByRole('button', { name: 'Collapse sidebar', exact: true }).tap()
      expect(await mask.evaluate(el => getComputedStyle(el).opacity)).toBe('0')
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await expect.poll(async () => Math.round((await main.boundingBox())!.width)).toBe(767)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(767)
      await page.evaluate(() => { document.documentElement.dataset.platform = 'darwin' })
      await expect.poll(() => main.evaluate(el => getComputedStyle(el).paddingTop)).toBe('0px')
      await page.evaluate(() => { delete document.documentElement.dataset.platform })
      await expect.poll(() => main.evaluate(el => getComputedStyle(el).paddingTop)).toBe('48px')

      await page.setViewportSize({ width: 390, height: 844 })
      await drawer.waitFor({ state: 'hidden' })
      await opener.tap()
      await drawer.getByRole('button', { name: 'New session', exact: true }).last().tap()
      await drawer.waitFor({ state: 'hidden' })
      const home = page.locator('[data-phase="hero"]')
      await home.waitFor()
      const editor = home.locator('[contenteditable="true"]')
      await editor.tap()
      const homeEditorBox = await editor.boundingBox()
      // Chromium cannot raise a phone keyboard; simulate document panning
      // before the visual viewport publishes the matching offset.
      const restoreViewport = await page.evaluateHandle(() => {
        const viewport = window.visualViewport!
        const scrollY = Object.getOwnPropertyDescriptor(window, 'scrollY')!
        Object.defineProperty(window, 'scrollY', { configurable: true, value: 80 })
        Object.defineProperties(viewport, {
          height: { configurable: true, value: 360 },
          offsetTop: { configurable: true, value: 0 },
        })
        viewport.dispatchEvent(new Event('resize'))
        viewport.dispatchEvent(new Event('scroll'))
        window.dispatchEvent(new Event('scroll'))
        return () => {
          Object.defineProperty(window, 'scrollY', scrollY)
          Reflect.deleteProperty(viewport, 'height')
          Reflect.deleteProperty(viewport, 'offsetTop')
          window.dispatchEvent(new Event('scroll'))
          viewport.dispatchEvent(new Event('resize'))
        }
      })
      const root = page.locator('#root')
      await expect.poll(() => root.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 })
      expect(await editor.boundingBox()).toEqual(homeEditorBox)
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport!, 'offsetTop', { configurable: true, value: 80 })
        window.visualViewport!.dispatchEvent(new Event('scroll'))
      })
      await expect.poll(() => root.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 })
      await expect.poll(async () => (await main.boundingBox())?.height).toBe(844)
      await opener.tap()
      await expect.poll(async () => (await drawer.boundingBox())?.height).toBe(844)
      const searchWithKeyboard = drawer.getByPlaceholder('Search session names')
      await drawer.getByRole('button', { name: 'Search sessions', exact: true }).tap()
      await searchWithKeyboard.tap()
      await searchWithKeyboard.fill('retained search')
      await drawer.getByRole('button', { name: 'Account menu', exact: true }).tap()
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).tap()
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
      await settings.waitFor()
      const settingsBox = (await settings.boundingBox())!
      expect(settingsBox.x).toBeGreaterThanOrEqual(0)
      expect(settingsBox.y).toBeGreaterThanOrEqual(0)
      expect(settingsBox.x + settingsBox.width).toBeLessThanOrEqual(390)
      expect(settingsBox.y + settingsBox.height).toBeLessThanOrEqual(844)
      const closeSettings = settings.getByRole('button', { name: 'Close', exact: true })
      const closeBox = (await closeSettings.boundingBox())!
      expect(closeBox.y).toBeGreaterThanOrEqual(0)
      expect(closeBox.y + closeBox.height).toBeLessThanOrEqual(844)
      await closeSettings.tap()
      await settings.waitFor({ state: 'hidden' })
      await expect.poll(() => searchWithKeyboard.inputValue()).toBe('retained search')
      await restoreViewport.evaluate((restore) => { restore() })
      await restoreViewport.dispose()
      await expect.poll(() => root.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 })
      await expect.poll(async () => (await drawer.boundingBox())?.height).toBe(844)
      await frame.evaluate((el) => { el.scrollLeft = 10 })
      expect(await frame.evaluate(el => el.scrollLeft)).toBe(0)
      await expect.poll(() => mask.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 })
      await expect.poll(() => drawer.evaluate((el) => {
        const frame = el.closest('[data-sidebar-drawer]')!
        let column = el
        while (column.parentElement !== frame) column = column.parentElement!
        const { y, height } = column.getBoundingClientRect()
        return { y, height }
      })).toEqual({ y: 0, height: 844 })
      await expect.poll(async () => (await drawer.boundingBox())?.height).toBe(844)
      await page.setViewportSize({ width: 844, height: 390 })
      await expect.poll(async () => (await root.boundingBox())?.height).toBe(390)
      await expect.poll(() => frame.count()).toBe(0)
      await page.setViewportSize({ width: 390, height: 844 })
      await expect.poll(async () => (await root.boundingBox())?.height).toBe(844)
      await expect.poll(() => frame.count()).toBe(1)

      const posture = await page.context().newCDPSession(page)
      try {
        await page.setViewportSize({ width: 951, height: 669 })
        await expect.poll(() => frame.count()).toBe(0)
        await posture.send('Emulation.setDevicePostureOverride', { posture: { type: 'folded' } })
        await opener.tap()
        await expect.poll(() => main.boundingBox()).toEqual({ x: 475.5, y: 0, width: 475.5, height: 669 })
        expect(await page.locator('[data-side="sidebar"]').count()).toBe(0)
        const foldSearch = page.getByPlaceholder('Search session names')
        if (!(await foldSearch.isVisible())) await page.getByRole('button', { name: 'Search sessions', exact: true }).tap()
        await foldSearch.fill('fold search')
        const wideFrame = page.locator('[data-rightbar-collapsed]')
        const collapseSidebar = page.getByRole('button', { name: 'Collapse sidebar', exact: true })
        await wideFrame.evaluate((el) => { el.style.setProperty('--ds-transition-duration-slow', '100s') })
        await posture.send('Emulation.clearDevicePostureOverride')
        await assertFoldResize(collapseSidebar, 475.5, 280)
        await expect.poll(() => main.boundingBox()).toEqual({ x: 280, y: 0, width: 671, height: 669 })
        expect(await page.locator('[data-side="sidebar"]').count()).toBe(1)
        expect(await foldSearch.evaluate(el => el === document.activeElement)).toBe(true)
        expect(await foldSearch.inputValue()).toBe('fold search')
        await wideFrame.evaluate((el) => { el.style.setProperty('--ds-transition-duration-slow', '100s') })
        await posture.send('Emulation.setDevicePostureOverride', { posture: { type: 'folded' } })
        await assertFoldResize(collapseSidebar, 280, 475.5)
        await expect.poll(async () => (await main.boundingBox())?.x).toBe(475.5)
        expect(await foldSearch.evaluate(el => el === document.activeElement)).toBe(true)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await posture.send('Emulation.clearDevicePostureOverride')
        await expect.poll(async () => (await main.boundingBox())?.x).toBe(280)
        // Scroll-driven text fades remain registered even with reduced motion.
        expect(await wideFrame.evaluate(el => el.getAnimations({ subtree: true })
          .filter(animation => animation.timeline === document.timeline).length)).toBe(0)
        await posture.send('Emulation.setDevicePostureOverride', { posture: { type: 'folded' } })
        await expect.poll(async () => (await main.boundingBox())?.x).toBe(475.5)
        await page.emulateMedia({ reducedMotion: 'no-preference' })
        await page.setViewportSize({ width: 669, height: 951 })
        await expect.poll(() => frame.getAttribute('data-sidebar-collapsed')).toBe('true')
        await drawer.waitFor({ state: 'hidden' })
        await opener.tap()
        await expect.poll(async () => (await drawer.boundingBox())?.width).toBe(280)
        expect(await main.boundingBox()).toEqual({ x: 0, y: 0, width: 669, height: 951 })
      } finally {
        await posture.detach()
      }

      const pointerPage = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'en-US' })
      try {
        await pointerPage.goto(scaffold.authenticatedUrl)
        await pointerPage.getByRole('button', { name: 'Open sidebar', exact: true }).click()
        expect(await pointerPage.getByPlaceholder('Search session names').evaluate(el => getComputedStyle(el).fontSize)).toBe('13px')
        const pointerWorkspace = pointerPage.locator('[data-row-key^="workspace:"]').first()
        const pointerWorkspaceButtons = pointerWorkspace.getByRole('button', { includeHidden: true })
        await pointerWorkspace.click()
        expect(await pointerWorkspace.getAttribute('aria-expanded')).toBe('false')
        const collapseSidebar = pointerPage.getByRole('button', { name: 'Collapse sidebar', exact: true })
        await collapseSidebar.focus()
        await collapseSidebar.hover()
        for (const button of await pointerWorkspaceButtons.all()) expect(await button.isVisible()).toBe(false)
        await pointerWorkspace.hover()
        for (const button of await pointerWorkspaceButtons.all()) await button.waitFor()
        await pointerWorkspace.click()
        for (const label of ['Collapse sidebar', 'View options']) {
          await pointerPage.getByRole('button', { name: label, exact: true }).hover()
          const tooltip = pointerPage.getByRole('tooltip').filter({ hasText: label })
          await tooltip.waitFor()
          expect(await tooltip.evaluate(el => el.closest('[data-slot="sidebar"]'))).toBeNull()
          const box = (await tooltip.boundingBox())!
          expect(box.x).toBeGreaterThanOrEqual(12)
          expect(box.x + box.width).toBeLessThanOrEqual(378)
        }
        const pointerRow = pointerPage.getByRole('treeitem').filter({ has: pointerPage.getByText('Drawer navigation', { exact: true }) })
        await pointerRow.click()
        await pointerPage.getByRole('dialog', { name: 'Navigation', exact: true }).waitFor({ state: 'hidden' })
        await pointerPage.getByRole('button', { name: 'Open sidebar', exact: true }).click()
        await pointerPage.getByRole('button', { name: 'Collapse sidebar', exact: true }).hover()
        await expect.poll(() => pointerRow.getByRole('button', { name: 'Session actions for Drawer navigation', exact: true }).isVisible()).toBe(false)
        await pointerRow.hover()
        for (const label of ['Session actions for Drawer navigation', 'Archive session', 'Pin session']) {
          await pointerRow.getByRole('button', { name: label, exact: true }).waitFor()
        }
        await pointerPage.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
        const pointerDrawer = pointerPage.getByRole('dialog', { name: 'Navigation', exact: true })
        await pointerDrawer.waitFor({ state: 'hidden' })
        await pointerPage.setViewportSize({ width: 767, height: 844 })
        await pointerPage.getByRole('button', { name: 'Open sidebar', exact: true }).press('Enter')
        await pointerDrawer.waitFor()
        expect(await pointerDrawer.evaluate(el => el.contains(document.activeElement))).toBe(true)
        await pointerPage.getByRole('button', { name: 'Search sessions', exact: true }).click()
        await expect.poll(() => pointerPage.getByPlaceholder('Search session names')
          .evaluate(el => el === document.activeElement)).toBe(true)
        await pointerPage.setViewportSize({ width: 768, height: 844 })
        await pointerPage.locator('[data-sidebar-drawer]').waitFor({ state: 'detached' })
        const pointerSidebar = pointerPage.locator('[data-slot="sidebar"]')
        await expect.poll(() => pointerSidebar.getByRole('button', { name: 'New session', exact: true }).count()).toBe(1)
        const railToggle = pointerSidebar.getByRole('button', { name: 'Open sidebar', exact: true })
        expect(await railToggle.evaluate(el => el === document.activeElement)).toBe(true)
      } finally {
        await pointerPage.close()
      }
      expect(console.pageErrors).toEqual([])
      expect(console.warnings).toEqual([])
      const result = [
        '390px: closed sidebar has no rail; main width 390px',
        'open: main geometry retained; background inert; no resize handle',
        'close: Session navigation, Plugins navigation, mask and Escape',
        'retained: sidebar DOM and opener focus',
        '768px: 56px rail; main width 712px; drawer focus transfers to the rail toggle',
        'breakpoint motion: collapsed rail hides immediately and returns compact without crossfades; expanded sidebar and explicit toggles retain their slides',
        '767px: hidden drawer; main width 767px; no page overflow',
        'global panels: browser top inset 48px; macOS keeps its existing clearance',
        'tooltips: sidebar and workspace controls escape the drawer and fit the viewport',
        'search input: 16px on touch; 13px with a fine pointer',
        'simulated keyboard: homepage and drawer retain 844px layout height without following the 360px visual viewport; Settings stays within the viewport',
        'keyboard close: layout height stays 844px; sidebar search retained; Settings close remains reachable',
        'shell coverage: drawer backing and mask cover 844px without synthetic safe-area insets',
        'rotation: 844x390 then 390x844 restores shell height and sidebar breakpoint',
        'folded landscape: 951px frame splits at 475.5px without a resize handle; unfolding restores 280px and search focus; portrait retains the drawer',
        'fold transitions: sidebar controls follow the divider in both directions; reduced motion changes width without animation',
        'drawer mask: opacity transitions from 0 to 1 on open and 1 to 0 on close',
        'reduced motion: drawer and mask settle without transitions',
        'Web header: only the sidebar opener remains, with 48px leading clearance',
        'below 768px: plugin and automation pages use 20px insets; Web view tabs align at 20px, while Desktop and wider Web tabs retain 28px',
        'touch selected Session: More remains visible; update time is hidden; pinned rows offer Unpin before More with Workspace action spacing',
        'touch Workspace: actions appear only while expanded, including after folding the focused row',
        'fine pointer: folded Workspace actions remain available on hover',
        'fine pointer: selected Session actions stay hidden until hover, including at 390px',
      ].join('\n')
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/sidebar-drawer.expected.md', import.meta.url)), result, webSnapshotMode())
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})

it('dismisses retained sidebar menus at the drawer breakpoint and preserves their rows', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const seed = await readFile(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url), 'utf8')
    const sessionId = await seedSession(scaffold, seed, 'session-c4421b66-252e-44c0-80ed-6e320abeba25')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'Menu regression' })
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1024, height: 844 }, locale: 'en-US' })
      await page.goto(scaffold.authenticatedUrl)
      const row = page.locator(`[data-row-key="session:${sessionId}"]`)
      await row.waitFor()
      const original = await row.elementHandle()
      for (const label of ['View options', 'Session actions for Menu regression']) {
        await page.setViewportSize({ width: 1024, height: 844 })
        await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).waitFor()
        if (label.startsWith('Session')) await row.hover()
        await page.getByRole('button', { name: label, exact: true }).click()
        await page.getByRole('menu').waitFor()
        await page.setViewportSize({ width: 767, height: 844 })
        await page.getByRole('menu').waitFor({ state: 'hidden' })
        const opener = page.getByRole('button', { name: 'Open sidebar', exact: true })
        await expect.poll(() => opener.evaluate(element => element === document.activeElement)).toBe(true)
        await opener.click()
        await row.waitFor()
        expect(await row.evaluate((element, before) => element === before, original)).toBe(true)
      }
      await original?.dispose()
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/sidebar-menu-dismissal.expected.md', import.meta.url)), [
        'View options and Session menus close when the sidebar becomes an inert drawer.',
        'Focus returns to the visible sidebar opener; retained Session rows keep their DOM identity.',
      ].join('\n'), webSnapshotMode())
    } finally { await browser.close() }
  } finally { await scaffold.close() }
})

it('keeps drawer shortcuts and hit targets above fullscreen and floating right panels', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const seed = await readFile(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url), 'utf8')
    const sessionId = await seedSession(scaffold, seed, 'session-c4421b66-252e-44c0-80ed-6e320abeba25')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'Drawer overlay checks' })
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 844 }, locale: 'en-US' })
      await page.addInitScript(() => { Object.defineProperty(navigator, 'platform', { value: 'MacIntel' }) })
      await page.goto(scaffold.authenticatedUrl)
      const row = page.getByRole('treeitem').filter({ has: page.getByText('Drawer overlay checks', { exact: true }) })
      await row.click()
      await page.locator('[data-sidebar-right-expand]').click()
      await page.locator('[data-sidebar-right-guide-entry="files"]').click()
      const panel = page.locator('[data-sidebar-right-open]')
      const primary = await page.evaluate(() => /mac/i.test(navigator.platform) ? 'Meta' : 'Control')
      const toggle = `${primary}+Alt+b`
      await row.hover()
      const card = page.getByRole('button', { name: 'Copy: Drawer overlay checks', exact: true })
      await card.waitFor()
      await page.setViewportSize({ width: 390, height: 844 })
      await card.waitFor({ state: 'hidden' })
      expect(await row.count()).toBe(1)
      const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true })
      await expect.poll(() => panel.getAttribute('data-sidebar-right-panel')).toBe('fullscreen')
      const assertAboveRightPanel = async (coveredPoint?: { x: number; y: number }) => {
        await page.locator('[data-sidebar-drawer][data-sidebar-collapsed]').waitFor()
        await page.keyboard.press(toggle)
        await drawer.waitFor()
        const collapse = drawer.getByRole('button', { name: 'Collapse sidebar', exact: true })
        await expect.poll(() => collapse.evaluate(el => document.activeElement === el)).toBe(true)
        await expect.poll(() => drawer.evaluate((el) => {
          const box = el.getBoundingClientRect()
          return el.contains(document.elementFromPoint(box.left + 140, 30))
        })).toBe(true)
        expect(await page.evaluate(() => document.elementFromPoint(380, 420)?.hasAttribute('data-sidebar-mask'))).toBe(true)
        if (coveredPoint !== undefined) {
          expect(await drawer.evaluate((el, point) => {
            const hit = document.elementFromPoint(point.x, point.y)
            return el.contains(hit) || hit?.hasAttribute('data-sidebar-mask')
          }, coveredPoint)).toBe(true)
        }
        await page.keyboard.press(`${primary}+Alt+k`)
        await expect.poll(() => drawer.getByPlaceholder('Search session names').evaluate(el => document.activeElement === el)).toBe(true)
        await page.keyboard.press(toggle)
        await drawer.waitFor({ state: 'hidden' })
        expect(await panel.evaluate(el => el.closest('[inert]') === null)).toBe(true)
      }
      await page.keyboard.press(`${primary}+Alt+k`)
      await drawer.waitFor()
      await expect.poll(() => drawer.getByPlaceholder('Search session names')
        .evaluate(el => el === document.activeElement)).toBe(true)
      await page.keyboard.press(toggle)
      await drawer.waitFor({ state: 'hidden' })
      await assertAboveRightPanel()
      await page.setViewportSize({ width: 1280, height: 844 })
      await expect.poll(() => panel.getAttribute('data-sidebar-right-panel')).toBe('push')
      const tab = panel.locator('[data-dockkit-tab]').filter({ hasText: 'Files' })
      const bounds = (await tab.boundingBox())!
      await page.mouse.move(bounds.x + 6, bounds.y + bounds.height / 2)
      await page.mouse.down()
      try {
        await page.mouse.move(190, 400, { steps: 8 })
      } finally { await page.mouse.up() }
      const floating = page.locator('[data-dockkit-float]')
      await floating.waitFor()
      await page.setViewportSize({ width: 390, height: 844 })
      const box = (await floating.boundingBox())!
      expect(box.x).toBeLessThan(390)
      expect(box.x + box.width).toBeGreaterThan(0)
      const point = { x: (Math.max(0, box.x) + Math.min(390, box.x + box.width)) / 2, y: box.y + 40 }
      await expect.poll(() => floating.evaluate((el, at) => el.contains(document.elementFromPoint(at.x, at.y)), point)).toBe(true)
      await assertAboveRightPanel(point)
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})
