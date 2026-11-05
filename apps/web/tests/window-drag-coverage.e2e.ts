// Browser coverage for the macOS window drag surface: which chrome rows drag,
// which pixels stay content, and that no control is swallowed by the band.
//
// The lane boots the real composition in Chromium and marks the document root
// darwin — the one platform where these rules exist (ui-web base.css and
// ui-layout AppFrame scope every app-region rule to it). CDP-injected clicks
// cannot decide this class: the swallow happens in Electron's native window, so
// the claims here are geometry claims decided by the shared composition model
// (ui-web window-drag/regions.ts).
//
// Probes are anchored to stable data hooks and derived from live rects, so a
// layout change moves them rather than invalidating them. The ui-theme app-region
// gate holds the other half of the claim: it pins each row's mark, its sheet, and
// its authored height, and refuses a `data-window-drag` mark anywhere else. A
// probe whose expectation is not yet met carries `gap` and fails loudly, so a
// recorded gap shrinks here first and the manifest follows.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { initialShortcutConfig } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  INTERACTIVE_SELECTOR, RECALL_MARK, isDraggableAt, type RegionRect,
} from '@deepseek-ai/dsh-client-web/src/window-drag/regions.ts'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import {
  collectWindowSurface, connectFreshWorkspace, expandOwningTurnProcess, newEnglishPage, saveFailureShot,
  type CollectedWindowSurface,
} from './support.ts'

/** A point the coverage table claims something about. */
interface CoverageProbe {
  /** Row the probe speaks for, for the failure message. */
  readonly row: string
  /** What the point is, for the failure message. */
  readonly what: string
  /** Resolves the point from the live rects captured for the state under test. */
  readonly at: () => readonly [number, number]
  /** Whether the window would drag there. */
  readonly drag: boolean
  /** Set when the expectation is a recorded gap the refactor must close. */
  readonly gap?: string
}

/** A viewport rect. */
interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

const EMPTY: Rect = { x: 0, y: 0, width: 0, height: 0 }

/** A browser-half bundle whose row registers configuration into the plugin page. */
const FIXTURE_PLUGINS = fileURLToPath(new URL('./fixtures/plugins', import.meta.url))

/** Read one hook's viewport rect, or a zero rect while it is not rendered. */
async function rectOf(page: Page, selector: string): Promise<Rect> {
  const locator = page.locator(selector).first()
  if (await locator.count() === 0) return EMPTY
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
}

/**
 * Collect visible native region owners and interactive boxes in DOM order.
 * Controls whose computed region is `none` still need a hit-test probe, but
 * contribute no rectangle to native drag composition.
 * @param page - the page under test.
 * @param selector - the interactive element selector.
 * @returns native region boxes and independently sampled controls.
 */
async function collectedSurface(page: Page, selector: string): Promise<CollectedWindowSurface> {
  return collectWindowSurface(page, {
    selector,
    containersWithDragRows: '[data-dockkit-pane][tabindex="-1"], [data-shortcut-modal="sidebar"][role="dialog"]',
  })
}

/** @param page - the page under test. @param selector - the control selector. @returns native region owners in DOM order. */
async function collectedRegions(page: Page, selector: string): Promise<readonly RegionRect[]> {
  return (await collectedSurface(page, selector)).regions
}

/**
 * Interactive boxes whose press cannot reach the page, as printable descriptions.
 * A sample counts only where the browser's own hit test reaches the control: a
 * box clipped away by its column (the collapsed sidebar's hidden controls sit at
 * negative x) is not hittable anywhere it overlaps a drag row, and a press there
 * belongs to whatever is painted.
 * @param surface - native regions and independent interactive boxes from one frame.
 * @returns one description per interactive box with a hittable sample inside the drag surface.
 */
function swallowedBoxes(surface: CollectedWindowSurface): string[] {
  return surface.controls
    .filter(region => region.hits.some(([x, y]) => isDraggableAt(surface.regions, x, y)))
    .map(region => `${Math.round(region.x)},${Math.round(region.y)} ${Math.round(region.width)}x${Math.round(region.height)}`)
}

/**
 * Settle when the shell first pulses the drag recall mark, or false when 15s pass
 * without one. Start it before the gesture under test and await it after.
 * @param page - the page under test.
 * @returns the pending observation of the first pulse.
 */
function firstRecallPulse(page: Page): Promise<boolean> {
  return page.evaluate((mark: string) => new Promise<boolean>((resolve) => {
    const observer = new MutationObserver((records) => {
      const pulsed = records.some(record => record.attributeName === mark
        && (record.target as Element).hasAttribute(mark))
      if (!pulsed) return
      observer.disconnect()
      resolve(true)
    })
    observer.observe(document.body, { attributes: true, attributeFilter: [mark] })
    setTimeout(() => {
      observer.disconnect()
      resolve(false)
    }, 15_000)
  }), RECALL_MARK)
}

/**
 * Wait until nothing under the page is animating, so a probe measures the settled
 * layout instead of a frame of a column slide.
 * @param page - the page under test.
 */
async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.getAnimations()
    .every(animation => animation.playState === 'finished' || animation.playState === 'idle')),
  { timeout: 20_000 }).toBe(true)
}

/**
 * Scroll a content box above its scrollport while its untrimmed bounds overlap window chrome.
 * @param target - Content whose full bounds can overlap chrome while clipped by its scrollport.
 * @param scrollport - The content's actual scrolling owner.
 * @param chrome - The chrome row that must retain its drag pixels.
 * @returns A point inside the clipped content box and the chrome row.
 */
async function scrollBehindChrome(target: Locator, scrollport: Locator, chrome: Rect): Promise<readonly [number, number]> {
  const bottom = chrome.y + 8
  const bounds = await target.boundingBox()
  if (bounds === null) throw new Error('The scroll fixture has no layout box')
  await scrollport.evaluate((element, delta) => { element.scrollTop += delta }, bounds.y + bounds.height - bottom)
  await expect.poll(() => target.evaluate((element, edge) => Math.abs(element.getBoundingClientRect().bottom - edge), bottom),
    { timeout: 15_000, message: 'the content box reaches the chrome while remaining clipped by its scrollport' }).toBeLessThan(1)
  const rect = await target.boundingBox()
  if (rect === null) throw new Error('The clipped fixture lost its layout box')
  const scrollTop = await scrollport.evaluate(element => element.getBoundingClientRect().top)
  expect(rect.y + rect.height).toBeLessThan(scrollTop)
  const x = rect.x + rect.width / 2
  const y = bottom - Math.min(4, rect.height / 2)
  expect(x).toBeGreaterThan(chrome.x)
  expect(x).toBeLessThan(chrome.x + chrome.width)
  expect(y).toBeGreaterThanOrEqual(rect.y)
  return [x, y]
}

describe('web e2e: macOS window drag coverage', () => {
  let scaffold: WebScaffold
  let browser: Browser

  beforeAll(async () => {
    // A manageable profile: the plugin page draws its card list — and so its
    // detail views — only when the deployment runs a profile it can manage.
    scaffold = await launchWebScaffold({
      profile: { packages: [{ dir: join(FIXTURE_PLUGINS, 'fixture-live-client') }] },
    })
    browser = await chromium.launch()
  }, 180_000)

  afterAll(async () => {
    try { await browser?.close() }
    finally { await scaffold?.close() }
  })

  /**
   * Open a desktop-marked page in the shipped composition.
   * @param platform - Desktop CSS and preload platform to emulate in Chromium.
   * @param host - Managed profile serving this page.
   * @returns the page and its console tripwire.
   */
  async function desktopPage(
    platform: 'darwin' | 'win32' = 'darwin', host: WebScaffold = scaffold,
  ): Promise<{ page: Page; tripwire: ReturnType<typeof watchConsole> }> {
    const page = await newEnglishPage(browser)
    await page.addInitScript(({ value, snapshot }) => {
      // The Desktop platform marker requires the preload's keyboard and preference capabilities.
      Object.assign(window, { dshDesktop: { protocolVersion: 1,
        keyboard: { subscribe: () => () => {}, closeWindow: async () => {} },
        shortcuts: { get: async () => ({ ...snapshot, status: 'ready' }),
          subscribe: () => () => {}, recording: async () => {},
          edit: async () => ({ status: 'not-ready', snapshot }) },
      } })
      const mark = (): void => {
        document.documentElement.setAttribute('data-platform', value)
        if (value === 'win32') {
          document.documentElement.setAttribute('data-windows-titlebar', '')
          document.documentElement.style.setProperty('--dsh-windows-titlebar-height', '40px')
        }
      }
      if (document.documentElement === null) document.addEventListener('DOMContentLoaded', mark, { once: true })
      else mark()
    }, { value: platform, snapshot: initialShortcutConfig() })
    const tripwire = watchConsole(page)
    await page.goto(host.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    return { page, tripwire }
  }

  /** Wait for the workspace's asynchronous Session creation and the browser's selection of that Session. */
  async function connectWorkspaceSession(page: Page, name: string): Promise<Session> {
    await connectFreshWorkspace(page, scaffold.workspaceCwd, name)
    const cwd = join(scaffold.workspaceCwd, name)
    await expect.poll(() => scaffold.ctx.agents.list().find(candidate => candidate.session.header.cwd === cwd),
      { timeout: 15_000 }).toBeDefined()
    const agent = scaffold.ctx.agents.list().find(candidate => candidate.session.header.cwd === cwd)
    if (agent === undefined) throw new Error('The workspace did not create a Session')
    await expect.poll(() => page.locator('[data-conversation-session]').getAttribute('data-conversation-session'), { timeout: 15_000 })
      .toBe(agent.session.id)
    return agent.session
  }

  /** Create a selected, nonblank Session and wait for its right-sidebar seat to mount. */
  async function connectTranscriptWorkspace(page: Page, name: string): Promise<void> {
    const session = await connectWorkspaceSession(page, name)
    const text = `Window drag fixture for ${name}.`
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Inspect window chrome.' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', { stream: [], turn: 1, step: 1, message: createAssistantMessage({
      content: [{ type: 'text', text }], source: { provider: 'fixture', model: 'fixture' },
    }) }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(session)
    await page.locator('[data-conversation-scroll]').getByText(text, { exact: true }).waitFor()
    await page.locator(`[data-sidebar-right-session="${session.id}"]:not([data-sidebar-right-panel]):not([hidden])`)
      .waitFor({ state: 'attached' })
  }

  it('keeps the header draggable when transcript controls scroll above their clip', async () => {
    const { page, tripwire } = await desktopPage()
    try {
      const session = await connectWorkspaceSession(page, 'scrolled-drag-content')
      const callId = ToolCallId('window-drag-scroll-command')
      const args = JSON.stringify({ command: 'printf drag-fixture', description: 'Inspect scroll fixture' })
      session.append('turn/start', { turn: 1 })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Show a table, code, and a reference link.' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('assistant/message', { stream: [], turn: 1, step: 1, message: createAssistantMessage({
        content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: args }],
        source: { provider: 'fixture', model: 'fixture' },
      }) }, { surfaceOp: 'append' })
      const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: args })
      session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
        callId, content: [{ type: 'text', text: 'drag-fixture\n[exit code: 0]' }], isError: false,
      }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
      session.append('step/end', { turn: 1, step: 1 })
      session.append('step/start', { turn: 1, step: 2 })
      const markdown = [
        '| Drag table | Value | Status | Detail |',
        '| --- | --- | --- | --- |',
        ...Array.from({ length: 8 }, (_, index) => `| Row ${String(index)} | Value | Ready | Detail |`),
        '',
        '```typescript',
        ...Array.from({ length: 12 }, (_, index) => `const scrollValue${String(index)} = ${String(index)}`),
        '```',
        '',
        '[Scroll reference](https://example.com/drag-reference)',
        '',
        ...Array.from({ length: 24 }, (_, index) => `Trailing paragraph ${String(index)} leaves room to scroll every control above the transcript.\n`),
        'Drag scroll fixture complete.',
      ].join('\n')
      session.append('assistant/message', { stream: [], turn: 1, step: 2, message: createAssistantMessage({
        content: [{ type: 'text', text: markdown }], source: { provider: 'fixture', model: 'fixture' },
      }) }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step: 2 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await scaffold.ctx.sessions.flush(session)
      await page.getByText('Drag scroll fixture complete.', { exact: true }).waitFor()
      const tool = page.locator('[data-sample="bash"]').first()
      await expandOwningTurnProcess(page, tool)
      await tool.waitFor()
      expect(await tool.getAttribute('role')).toBe('button')
      expect(await tool.getAttribute('tabindex')).toBe('0')
      await page.locator('.md-code-block pre[tabindex="0"]').waitFor()
      await page.evaluate(async () => { await document.fonts.ready })
      await settled(page)

      const scrollport = page.locator('[data-conversation-scroll]').first()
      const header = await rectOf(page, '[data-slot="conversation.header"] > header')
      const controls = [
        ['wide table', page.locator('.md-table-wide[tabindex="0"]')],
        ['code block', page.locator('.md-code-block pre[tabindex="0"]')],
        ['reference link', page.getByRole('link', { name: 'Scroll reference', exact: true })],
        ['code action', page.locator('.md-code-block button').first()],
        ['tool disclosure', tool],
      ] as const
      for (const [name, control] of controls) {
        const [x, y] = await scrollBehindChrome(control, scrollport, header)
        expect(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.closest('[data-window-drag]')
          ?.matches('[data-slot="conversation.header"] > header') ?? false, { x, y }), name).toBe(true)
        const regions = await collectedRegions(page, INTERACTIVE_SELECTOR)
        expect(isDraggableAt(regions, x, y), `${name} cannot subtract clipped pixels from the header`).toBe(true)
        const button = await rectOf(page, '[data-sidebar-right-expand]')
        expect(isDraggableAt(regions, button.x + button.width / 2, button.y + button.height / 2),
          'the header action stays clickable').toBe(false)
      }
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, 'window-drag-scrolled-transcript')
      throw error
    } finally { await page.close() }
  })

  it('keeps no-drag subtraction within panes and horizontally scrolling tab viewports', async () => {
    const { page, tripwire } = await desktopPage()
    try {
      await connectTranscriptWorkspace(page, 'scrolled-drag-pane')
      await page.locator('[data-sidebar-right-expand]').click()
      const panel = page.locator('[data-sidebar-right-panel][data-sidebar-right-open]')
      await panel.waitFor()
      await settled(page)
      const body = panel.locator('[data-dockkit-pane] > [class*="_paneBody_"]').first()
      await body.waitFor()
      // The existing pane supplies the no-drag owner; plain fixture content isolates CSS inheritance from plugin behavior.
      await body.evaluate((element) => {
        const content = document.createElement('div')
        content.dataset.dragScrollFixture = ''
        content.style.height = '240px'
        content.textContent = 'Scrollable pane content'
        const tail = document.createElement('div')
        tail.style.height = '1600px'
        element.append(content, tail)
      })
      const child = body.locator('[data-drag-scroll-fixture]')
      const strip = await rectOf(page, '[data-dockkit-strip]')
      const [x, y] = await scrollBehindChrome(child, body, strip)
      expect(await child.evaluate(element => getComputedStyle(element).getPropertyValue('app-region'))).toBe('none')
      const regions = await collectedRegions(page, INTERACTIVE_SELECTOR)
      const bodyBox = await body.boundingBox()
      if (bodyBox === null) throw new Error('The pane body has no layout box')
      expect(isDraggableAt(regions, bodyBox.x + bodyBox.width / 2, bodyBox.y + bodyBox.height / 2),
        'pane content remains outside the drag surface').toBe(false)
      expect(isDraggableAt(regions, x, y), 'scrolled descendants do not subtract the pane tab strip').toBe(true)

      const tabs = panel.locator('[data-dockkit-strip-tabs]').first()
      const tab = tabs.locator('[data-dockkit-tab]').first()
      await tabs.evaluate((element) => {
        const tail = document.createElement('div')
        tail.style.flex = '0 0 1600px'
        element.append(tail)
        element.scrollTo({ left: 24, behavior: 'instant' })
      })
      await expect.poll(() => tabs.evaluate(element => element.scrollLeft)).toBe(24)
      const viewport = await tabs.boundingBox()
      const tabBounds = await tab.boundingBox()
      if (viewport === null || tabBounds === null) throw new Error('The tab scroll fixture has no layout box')
      const tabPoint = { x: viewport.x - 4, y: tabBounds.y + tabBounds.height / 2 }
      expect(tabBounds.x).toBeLessThan(tabPoint.x)
      expect(tabBounds.x + tabBounds.width).toBeGreaterThan(tabPoint.x)
      expect(tabPoint.x).toBeGreaterThan(strip.x)
      expect(await page.evaluate((point) => {
        const hit = document.elementFromPoint(point.x, point.y)
        return hit !== null && hit.closest('[data-dockkit-strip]') !== null && hit.closest('[data-dockkit-tab]') === null
      }, tabPoint)).toBe(true)
      expect(await tabs.evaluate(element => getComputedStyle(element).getPropertyValue('app-region'))).toBe('no-drag')
      expect(await tab.evaluate(element => getComputedStyle(element).getPropertyValue('app-region'))).toBe('none')
      expect(isDraggableAt(await collectedRegions(page, INTERACTIVE_SELECTOR), tabPoint.x, tabPoint.y),
        'a clipped tab does not subtract the blank run beside its viewport').toBe(true)
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, 'window-drag-scrolled-pane')
      throw error
    } finally { await page.close() }
  })

  it('detects an overlay button that loses its no-drag exclusion', async () => {
    const { page, tripwire } = await desktopPage()
    try {
      await settled(page)
      const header = await rectOf(page, '[data-slot="conversation.header"] > header')
      const point = { x: header.x + header.width / 2, y: header.y + 10 }
      expect(isDraggableAt(await collectedRegions(page, INTERACTIVE_SELECTOR), point.x, point.y)).toBe(true)
      // A root-local overlay must retain its own exclusion even outside a marked controls scope.
      await page.evaluate(({ x, y }) => {
        const root = document.getElementById('root')
        if (root === null) throw new Error('The window drag fixture has no root')
        const button = document.createElement('button')
        button.dataset.dragCoverageOverlay = ''
        button.textContent = 'Overlay control probe'
        Object.assign(button.style, { position: 'fixed', left: `${x - 32}px`, top: `${y - 8}px`,
          width: '64px', height: '16px', zIndex: '2000' })
        button.style.setProperty('-webkit-app-region', 'no-drag')
        root.append(button)
      }, point)
      const button = page.locator('[data-drag-coverage-overlay]')
      expect(await button.evaluate((element, at) => element.contains(document.elementFromPoint(at.x, at.y)), point)).toBe(true)
      expect(swallowedBoxes(await collectedSurface(page, INTERACTIVE_SELECTOR))).toEqual([])

      await button.evaluate((element) => { (element as HTMLElement).style.setProperty('-webkit-app-region', 'initial') })
      expect(await button.evaluate(element => getComputedStyle(element).getPropertyValue('app-region'))).toBe('none')
      const bounds = await rectOf(page, '[data-drag-coverage-overlay]')
      const description = `${Math.round(bounds.x)},${Math.round(bounds.y)} ${Math.round(bounds.width)}x${Math.round(bounds.height)}`
      const unprotected = await collectedSurface(page, INTERACTIVE_SELECTOR)
      expect(isDraggableAt(unprotected.regions, point.x, point.y), 'the overlay declares no exclusion').toBe(true)
      expect(swallowedBoxes(unprotected), 'a hittable control without a region is still checked').toContain(description)

      await button.evaluate((element) => { (element as HTMLElement).style.setProperty('-webkit-app-region', 'no-drag') })
      expect(swallowedBoxes(await collectedSurface(page, INTERACTIVE_SELECTOR))).toEqual([])
      expect(tripwire.pageErrors).toEqual([])
    } finally { await page.close() }
  })

  it('keeps fullscreen panel chrome excluded while another pane floats', async () => {
    const { page, tripwire } = await desktopPage()
    try {
      await connectTranscriptWorkspace(page, 'fullscreen-floating-drag-pane')
      await page.locator('[data-sidebar-right-expand]').click()
      const panel = page.locator('[data-sidebar-right-panel][data-sidebar-right-open]')
      await panel.waitFor()
      await settled(page)
      await panel.locator('[data-dockkit-split-button]').first().click()
      await expect.poll(() => panel.locator('[data-dockkit-pane]').count()).toBe(2)
      const tab = panel.locator('[data-dockkit-tab]').first()
      const tabBounds = await tab.boundingBox()
      const dock = await rectOf(page, '[data-dockkit-surface]')
      if (tabBounds === null) throw new Error('The floating pane fixture has no tab box')
      await page.mouse.move(tabBounds.x + 6, tabBounds.y + tabBounds.height / 2)
      await page.mouse.down()
      try {
        await page.mouse.move(dock.x - 240, dock.y + dock.height / 2, { steps: 8 })
      } finally { await page.mouse.up() }
      const floating = panel.locator('[data-dockkit-float]')
      await floating.waitFor()
      await expect.poll(() => panel.locator('[data-dockkit-pane]').count()).toBe(1)
      await settled(page)
      const header = await rectOf(page, '[data-slot="conversation.header"] > header')
      const point = { x: header.x + header.width / 2, y: header.y + 4 }
      expect(isDraggableAt(await collectedRegions(page, INTERACTIVE_SELECTOR), point.x, point.y)).toBe(true)

      await panel.locator('[data-sidebar-right-mode="fullscreen"]').click()
      await expect.poll(() => panel.getAttribute('data-sidebar-right-panel')).toBe('fullscreen')
      await settled(page)
      expect(await floating.count()).toBe(1)
      expect(await panel.locator('[data-dockkit-strip][data-window-drag]').count()).toBe(0)
      expect(await panel.locator('[data-dockkit-pane]').evaluate(element => getComputedStyle(element).getPropertyValue('app-region')))
        .toBe('no-drag')
      expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('[data-dockkit-strip]')), point)).toBe(true)
      const surface = await collectedSurface(page, INTERACTIVE_SELECTOR)
      expect(isDraggableAt(surface.regions, point.x, point.y), 'fullscreen chrome does not expose the covered conversation drag row').toBe(false)
      expect(swallowedBoxes(surface)).toEqual([])
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, 'window-drag-fullscreen-float')
      throw error
    } finally { await page.close() }
  })

  it('keeps the macOS sidebar toggle stationary as its expanded content starts fading', async () => {
    const { page, tripwire } = await desktopPage()
    try {
      const open = page.getByRole('button', { name: 'Open sidebar', exact: true })
      if (await open.isVisible()) await open.click()
      const toggle = page.getByRole('button', { name: 'Collapse sidebar', exact: true })
      await toggle.waitFor()
      const positions = await toggle.evaluate(async (button) => {
        if (!(button instanceof HTMLButtonElement)) throw new Error('Sidebar toggle is not a button')
        const root = button.closest('[class*="topStrip"]')!.parentElement!
        const position = () => ({
          left: button.getBoundingClientRect().left - root.getBoundingClientRect().left,
          transform: getComputedStyle(button).transform,
        })
        const before = position()
        // Observe the class change before the 150ms fade can settle under host contention.
        const fading = await new Promise<ReturnType<typeof position>>((resolve) => {
          const observer = new MutationObserver(() => {
            if (![...root.classList].some(name => name.includes('fading'))) return
            observer.disconnect()
            resolve(position())
          })
          observer.observe(root, { attributes: true, attributeFilter: ['class'] })
          button.click()
        })
        return { before, fading }
      })
      expect(positions.before.transform).toBe('matrix(1, 0, 0, 1, 4, 0)')
      expect(positions.fading).toEqual(positions.before)
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await page.close()
    }
  })

  it.each(['darwin', 'win32'] as const)('%s keeps compact Plugins controls below native chrome in both sidebar states', async (platform) => {
    const { page, tripwire } = await desktopPage(platform)
    try {
      await page.setViewportSize({ width: 1280, height: 480 })
      await page.getByRole('button', { name: 'Plugins', exact: true }).click()
      await page.locator('[data-plugin-package]').first().waitFor()
      const bar = page.locator('[data-plugin-bar]')
      const body = page.locator('[data-plugin-body]')
      const toolbarGeometry = () => bar.evaluate((element) => {
        const header = element.querySelector('header')!
        const bounds = element.getBoundingClientRect()
        const buttons = Array.from(element.querySelectorAll('button'))
          .filter(button => button.textContent?.trim() === 'Refresh' || button.textContent?.trim() === 'Add plugin')
        return {
          top: bounds.top,
          headingTop: header.querySelector('h1')!.getBoundingClientRect().top - header.getBoundingClientRect().top,
          buttons: buttons.map((button) => { const rect = button.getBoundingClientRect(); return { x: rect.x, y: rect.y } }),
        }
      })
      for (const collapsed of [false, true]) {
        if (collapsed) {
          await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
        }
        await settled(page)
        await body.evaluate((element) => { element.scrollTop = 0 })
        await page.waitForFunction(() => !document.querySelector('[data-plugin-bar]')?.hasAttribute('data-compact'))
        const before = await toolbarGeometry()
        const footprint = (await bar.boundingBox())!.height
        expect(before.top).toBe(platform === 'darwin' ? 0 : 40)
        expect(before.headingTop).toBe(platform === 'darwin' ? 76 : 28)
        expect(before.buttons).toHaveLength(2)
        await body.evaluate((element) => { element.scrollTop = 120 })
        await page.waitForFunction(() => document.querySelector('[data-plugin-bar]')?.hasAttribute('data-compact'))
        const after = await toolbarGeometry()
        // macOS only needs the top strip cleared while the sidebar is collapsed; with it open the
        // native controls live in the sidebar, so the compact bar keeps its own 16px spacing.
        const compactTop = platform === 'darwin' && collapsed ? 56 : 16
        expect(await bar.evaluate(element => Number.parseFloat(getComputedStyle(element, '::before').height))).toBe(compactTop + 48)
        expect(after.buttons).toEqual(before.buttons.map(button => ({ ...button, y: button.y - (before.headingTop - compactTop) })))
        expect(after.buttons.every(button => button.y >= (platform === 'darwin' ? compactTop : 16))).toBe(true)
        expect(await body.evaluate(element => element.getBoundingClientRect().top))
          .toBe(await bar.evaluate(element => element.getBoundingClientRect().top))
        expect((await bar.boundingBox())!.height, 'the compact header preserves its list footprint').toBe(footprint)
        expect(await bar.locator('header').evaluate(element => element.getBoundingClientRect().height))
          .toBe(await bar.evaluate(element => Number.parseFloat(getComputedStyle(element, '::before').height)))
        if (platform === 'darwin' && !collapsed) {
          // A visible card can occupy the bar's reserved footprint below its smaller painted header.
          const card = await page.locator('[data-plugin-group] button').evaluateAll((buttons) => {
            const bar = document.querySelector('[data-plugin-bar]')
            if (bar === null) throw new Error('The plugin drag fixture has no header bar')
            const bounds = bar.getBoundingClientRect()
            const paintBottom = bounds.y + Number.parseFloat(getComputedStyle(bar, '::before').height)
            for (const button of buttons) {
              const box = button.getBoundingClientRect()
              const x = box.x + box.width / 2
              const y = box.y + box.height / 2
              if (y <= paintBottom || y >= bounds.bottom || !button.contains(document.elementFromPoint(x, y))) continue
              return { x, y, region: getComputedStyle(button).getPropertyValue('app-region') }
            }
            return null
          })
          expect(card, 'a real card is hittable inside the header bar footprint').not.toBeNull()
          if (card === null) throw new Error('No card overlapped the plugin header bar footprint')
          expect(card.region, 'ordinary plugin cards declare no native region').toBe('none')
          expect(isDraggableAt(await collectedRegions(page, INTERACTIVE_SELECTOR), card.x, card.y),
            'a clipped header does not swallow a card inside its reserved footprint').toBe(false)
          const header = bar.locator('header')
          const previousStyle = await header.getAttribute('style')
          try {
            // A smaller visible clip does not reduce the owner's native region box.
            await header.evaluate((element) => {
              const style = (element as HTMLElement).style
              style.height = 'var(--plugin-header-rest-height)'
              style.clipPath = 'inset(0 0 calc(var(--plugin-header-rest-height) - var(--plugin-header-paint-height)) 0)'
            })
            expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('[data-plugin-group]')), card))
              .toBe(true)
            const oversized = await collectedSurface(page, INTERACTIVE_SELECTOR)
            expect(isDraggableAt(oversized.regions, card.x, card.y), 'oversized header geometry swallows the still-hittable card').toBe(true)
            expect(swallowedBoxes(oversized), 'the control check detects the oversized owner').not.toEqual([])
          } finally {
            await header.evaluate((element, style) => {
              if (style === null) element.removeAttribute('style')
              else element.setAttribute('style', style)
            }, previousStyle)
          }
        }
        if (platform === 'darwin') expect(swallowedBoxes(await collectedSurface(page, INTERACTIVE_SELECTOR))).toEqual([])
      }
      expect(tripwire.pageErrors).toEqual([])
    } finally { await page.close() }
  })

  it.each([
    ['darwin', false], ['darwin', true], ['win32', false], ['win32', true],
  ] as const)('%s scopes compact spacing with tabs=%s to the collapsed macOS header at every width', async (platform, hasTabs) => {
    const host = hasTabs ? await launchWebScaffold({
      profile: { packages: [], bundles: ['@deepseek-ai/dsh-experimental-plugin-market-bundle'] },
    }) : scaffold
    try {
      const { page, tripwire } = await desktopPage(platform, host)
      try {
        await page.setViewportSize({ width: 1280, height: 480 })
        await page.getByRole('button', { name: 'Plugins', exact: true }).click()
        await page.locator('[data-plugin-package]').first().waitFor()
        const bar = page.locator('[data-plugin-bar]')
        const body = page.locator('[data-plugin-body]')
        const control = bar.locator(hasTabs ? '[role="tablist"]' : '[data-plugin-toolbar]')
        const top = async () => (await control.boundingBox())!.y - (await bar.boundingBox())!.y
        await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
        for (const width of [1280, 801, 520, 1280]) {
          await page.setViewportSize({ width, height: 480 })
          await settled(page)
          await body.evaluate((element) => { element.scrollTop = 0 })
          await page.waitForFunction(() => !document.querySelector('[data-plugin-bar]')?.hasAttribute('data-compact'))
          expect(await bar.locator('h1').evaluate(element => element.getBoundingClientRect().top)
            - (await bar.boundingBox())!.y).toBe(platform === 'darwin' ? 76 : 28)
          await body.evaluate((element) => { element.scrollTop = 500 })
          await page.waitForFunction(() => document.querySelector('[data-plugin-bar]')?.hasAttribute('data-compact'))
          const inset = platform === 'darwin' ? 56 : 16
          expect(await top()).toBe(inset)
          expect(await bar.evaluate(element => Number.parseFloat(getComputedStyle(element, '::before').height)))
            .toBe(inset + (hasTabs ? 34 : 32) + 16)
        }
        await page.getByRole('button', { name: 'Open sidebar', exact: true }).last().click()
        await settled(page)
        await body.evaluate((element) => { element.scrollTop = 500 })
        await expect.poll(top).toBe(16)
        expect(tripwire.pageErrors).toEqual([])
      } finally { await page.close() }
    } finally { if (host !== scaffold) await host.close() }
  })

  it('leaves no interactive box inside the drag surface, and keeps the panel strip row draggable', async () => {
    const { page, tripwire } = await desktopPage()
    try {
      await connectTranscriptWorkspace(page, 'panel-drag-coverage')
      const pulsing = firstRecallPulse(page)
      await page.locator('[data-sidebar-right-expand]').click()
      await page.locator('[data-sidebar-right-panel][data-sidebar-right-open]').waitFor({ timeout: 15_000 })
      // The panel slides in from the frame's right edge; probing before the slide
      // settles measures the hidden position, where the band does not reach.
      await expect.poll(async () => page.locator('[data-sidebar-right-panel]').evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return Math.round(innerWidth - rect.right) === 0
          && element.getAnimations({ subtree: true })
            .every(animation => animation.playState === 'finished' || animation.playState === 'idle')
      }), { timeout: 15_000 }).toBe(true)

      // The shell's watcher, not the panel, is what keeps the native drag rects in
      // step with the slide: it must have pulsed while the panel moved and must be
      // settled now — a mark left set would subtract the whole surface.
      expect(await pulsing, 'the shell pulses the drag recall mark while the panel slides').toBe(true)
      // The watcher clears the mark on the frame after the geometry settles.
      await expect.poll(
        () => page.evaluate((mark: string) => document.body.hasAttribute(mark), RECALL_MARK),
        { timeout: 5_000 },
      ).toBe(false)

      const surface = await collectedSurface(page, INTERACTIVE_SELECTOR)
      const { regions } = surface
      const strip = await rectOf(page, '[data-dockkit-strip]')
      const panel = await rectOf(page, '[data-sidebar-right-panel]')
      const tabs = await rectOf(page, '[data-conversation-tabs]')
      const header = await rectOf(page, '[data-slot="conversation.header"] > header')
      const seat = await rectOf(page, '[data-shell-leading]')
      // The sidebar column drags through its own rows (ui-sidebar), so its
      // coverage is the rows' geometry rather than a frame band's height.
      const toggle = await rectOf(page, 'button[aria-label="Collapse sidebar"]')

      const probes: CoverageProbe[] = [
        {
          row: 'right sidebar panel strip',
          what: 'the strip row top inset, above the controls',
          at: () => [strip.x + strip.width / 2, strip.y + 4],
          drag: true,
        },
        {
          row: 'right sidebar panel strip',
          what: 'the run below the strip row, over the pane body',
          at: () => [panel.x + panel.width / 2, strip.y + strip.height + 4],
          drag: false,
        },
        {
          row: 'conversation header',
          what: 'the blank run right of the view tabs, on the tab strip row',
          // The last tab's press target overhangs the tablist by 10px and the
          // More launcher starts 20px past it; probe the run between them.
          at: () => [tabs.x + tabs.width + 15, tabs.y + tabs.height / 2],
          drag: true,
        },
        {
          row: 'conversation header',
          what: 'the title row blank run',
          at: () => [header.x + header.width / 2, header.y + 4],
          drag: true,
        },
        {
          row: 'conversation header',
          what: 'the transcript run below the header block',
          at: () => [header.x + header.width / 2, header.y + header.height + 4],
          drag: false,
        },
      ]
      if (toggle.width > 0) {
        probes.push(
          {
            row: 'sidebar top strip',
            what: 'the blank run left of the collapse toggle',
            at: () => [toggle.x - 40, toggle.y + toggle.height / 2],
            drag: true,
          },
          {
            row: 'sidebar column',
            what: 'the content run below the chrome rows',
            at: () => [toggle.x - 40, toggle.y + toggle.height + 70],
            drag: false,
          },
        )
      }
      if (seat.width > 0) {
        probes.push({
          row: 'shell.leading seat',
          what: 'the row of window-chrome controls',
          at: () => [seat.x + 4, seat.y + seat.height / 2],
          drag: false,
        })
      }

      for (const probe of probes) {
        const [x, y] = probe.at()
        const expected = `${probe.row}: ${probe.what} at ${Math.round(x)},${Math.round(y)}`
          + (probe.gap === undefined ? '' : ` (recorded gap — ${probe.gap})`)
        expect(isDraggableAt(regions, x, y), expected).toBe(probe.drag)
      }

      // The invariant that has no gap budget: a press inside any control box must
      // reach the page instead of dragging the window.
      expect(swallowedBoxes(surface), 'interactive boxes inside the drag surface').toEqual([])

      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, 'window-drag-coverage')
      throw error
    } finally {
      await page.close()
    }
  }, 180_000)

  it('keeps the Conversation header draggable over the collapsed column, and the seat out of it', async () => {
    const { page, tripwire } = await desktopPage()
    try {
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
      await page.locator('[data-shell-leading]').waitFor({ state: 'visible', timeout: 15_000 })
      await settled(page)
      const surface = await collectedSurface(page, INTERACTIVE_SELECTOR)
      const { regions } = surface
      const header = await rectOf(page, '[data-slot="conversation.header"] > header')
      const seat = await rectOf(page, '[data-shell-leading]')

      // With the column hidden the centre starts at the frame's left edge, where
      // the Conversation header owns the run.
      expect(
        isDraggableAt(regions, header.x + 40, header.y + 4),
        'the Conversation header over the frame’s left edge',
      ).toBe(true)
      expect(
        isDraggableAt(regions, seat.x + seat.width / 2, seat.y + seat.height / 2),
        'the seat holding the reopen controls',
      ).toBe(false)

      expect(swallowedBoxes(surface), 'interactive boxes inside the drag surface').toEqual([])
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, 'window-drag-coverage-collapsed')
      throw error
    } finally {
      await page.close()
    }
  }, 120_000)

  it('keeps the drawer titlebar draggable without swallowing its close button', async () => {
    const { page, tripwire } = await desktopPage()
    try {
      await connectTranscriptWorkspace(page, 'drawer-drag-pane')
      await page.locator('[data-sidebar-right-expand]').click()
      await page.locator('[data-sidebar-right-panel][data-sidebar-right-open] [data-dockkit-pane]').first().waitFor()
      // Retain the mounted pane without letting its narrow fullscreen presentation cover the drawer opener.
      await page.locator('[data-sidebar-right-toggle]').click()
      await page.locator('[data-sidebar-right-panel][data-sidebar-right-open]').waitFor({ state: 'hidden' })
      await page.setViewportSize({ width: 571, height: 696 })
      await page.locator('[data-sidebar-drawer][data-sidebar-collapsed]').waitFor()
      await page.locator('[data-shell-leading]').getByRole('button', { name: 'Open sidebar', exact: true }).click()
      const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true })
      await drawer.waitFor()
      await settled(page)
      expect(await page.locator('[inert] [data-dockkit-pane]').count()).toBeGreaterThan(0)
      expect(await page.locator('[inert], [inert] *').evaluateAll(elements => elements
        .filter(element => getComputedStyle(element).getPropertyValue('app-region') !== 'none')
        .map(element => `${element.tagName}.${element.getAttribute('class')}`))).toEqual([])
      const toggle = drawer.getByRole('button', { name: 'Collapse sidebar', exact: true })
      const button = (await toggle.boundingBox())!
      const seat = await rectOf(page, '[data-shell-leading]')
      const surface = await collectedSurface(page, INTERACTIVE_SELECTOR)
      const { regions } = surface
      const y = button.y + button.height / 2
      expect(isDraggableAt(regions, seat.x + seat.width / 2, y), 'the inactive header controls behind the drawer').toBe(true)
      expect(isDraggableAt(regions, (seat.x + seat.width + button.x) / 2, y), 'the gap before the close button').toBe(true)
      expect(isDraggableAt(regions, button.x + button.width / 2, y), 'the close button').toBe(false)
      expect(swallowedBoxes(surface)).toEqual([])
      await toggle.click()
      await drawer.waitFor({ state: 'hidden' })
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await page.close()
    }
  })

  it('subtracts tooltips and hover cards that cover otherwise draggable header pixels', async () => {
    const { page, tripwire } = await desktopPage()
    try {
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
      const opener = page.locator('[data-sidebar-opener]')
      await opener.waitFor()
      await settled(page)

      /** Check a surface against the drag geometry captured before it opened. */
      const assertOverlay = async (overlay: Locator, before: readonly RegionRect[]): Promise<void> => {
        await overlay.waitFor()
        expect(await overlay.evaluate(element => getComputedStyle(element).getPropertyValue('app-region'))).toBe('no-drag')
        const bounds = await overlay.boundingBox()
        if (bounds === null) throw new Error('The overlay has no layout box')
        const edge = Math.min(4, bounds.height / 4)
        const samples = [0.2, 0.5, 0.8].flatMap(column => [edge, bounds.height / 2, bounds.height - edge]
          .map(row => [bounds.x + bounds.width * column, bounds.y + row] as const))
        const point = samples.find(([x, y]) => isDraggableAt(before, x, y))
        expect(point, 'the real overlay covers a previously draggable point').toBeDefined()
        if (point === undefined) throw new Error('The overlay did not overlap the drag surface')
        expect(isDraggableAt(await collectedRegions(page, INTERACTIVE_SELECTOR), ...point)).toBe(false)
      }

      const beforeTooltip = await collectedRegions(page, INTERACTIVE_SELECTOR)
      await opener.hover()
      await assertOverlay(page.getByRole('tooltip'), beforeTooltip)
      await page.mouse.move(1000, 900)
      await page.getByRole('tooltip').waitFor({ state: 'hidden' })
      await opener.click()
      const workspace = 'drag-overlay-workspace'
      await connectFreshWorkspace(page, scaffold.workspaceCwd, workspace)
      const row = page.locator('[data-row-key^="workspace:"]').filter({ hasText: workspace })
      // Keep the shipped HoverCard and its portal; move only its anchor so the card crosses window chrome.
      await row.locator('..').evaluate((element) => {
        Object.assign((element as HTMLElement).style, { position: 'fixed', left: '320px', top: '12px', width: '260px', zIndex: '2000' })
      })
      await settled(page)
      const beforeCard = await collectedRegions(page, INTERACTIVE_SELECTOR)
      await row.hover()
      const card = page.getByRole('button', { name: `Copy: ${join(scaffold.workspaceCwd, workspace)}`, exact: true })
      await assertOverlay(card, beforeCard)
      expect(await card.evaluate(element => element.parentElement?.parentElement === document.body)).toBe(true)
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, 'window-drag-hover-overlays')
      throw error
    } finally { await page.close() }
  })

  it('keeps an entry page’s chrome row draggable', async () => {
    const { page, tripwire } = await desktopPage()
    try {
      await page.getByRole('button', { name: 'Plugins', exact: true }).click()
      const head = page.locator('[class*="pageHead"]').first()
      await head.waitFor({ timeout: 15_000 })
      await settled(page)
      const rect = await head.evaluate((element) => {
        const box = element.getBoundingClientRect()
        return { x: box.x, y: box.y, width: box.width, height: box.height }
      })

      const surface = await collectedSurface(page, INTERACTIVE_SELECTOR)
      const { regions } = surface
      // The row starts at the window's top edge: a page inset above it would be a strip
      // no drag region covers, which is the dead band at the very top of this page.
      expect(rect.y, 'the page head starts at the window’s top edge').toBeLessThanOrEqual(0.5)
      // The page head owns its run, clearance included: that is the entry page's
      // window strip, with no frame band behind it.
      expect(
        isDraggableAt(regions, rect.x + 40, rect.y + 8),
        'the plugin manager page head',
      ).toBe(true)
      expect(
        isDraggableAt(regions, rect.x + 40, rect.y + rect.height + 40),
        'the page body below the head',
      ).toBe(false)

      expect(swallowedBoxes(surface), 'interactive boxes inside the drag surface').toEqual([])
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, 'window-drag-coverage-entry-page')
      throw error
    } finally {
      await page.close()
    }
  }, 120_000)

  it('keeps a detail page’s head row draggable and its body out of the drag surface', async () => {
    const { page, tripwire } = await desktopPage()
    try {
      await page.getByRole('button', { name: 'Plugins', exact: true }).click()
      const cards = page.locator('[data-plugin-package], [data-plugin-item]')
      await cards.first().waitFor({ timeout: 30_000 })
      await settled(page)
      // The card's head carries the one control that opens its page.
      await cards.first().locator('button').first().click()
      // The mark sits on the head row the detail views share, not on the detail
      // container: marking the container would drag the window over its text and
      // form labels wherever no control covers them.
      const detail = page.locator('[data-plugin-item-detail], [data-plugin-detail], [data-plugin-row-detail]').first()
      await detail.waitFor({ timeout: 15_000 })
      const geometry = await detail.evaluate((element) => {
        const detailBox = element.getBoundingClientRect()
        const headBox = element.firstElementChild?.getBoundingClientRect()
        return {
          detail: { x: detailBox.x, y: detailBox.y, width: detailBox.width, height: detailBox.height },
          head: headBox === undefined
            ? null
            : { x: headBox.x, y: headBox.y, width: headBox.width, height: headBox.height },
          viewport: { width: innerWidth, height: innerHeight },
        }
      })
      if (geometry.head === null) throw new Error('the detail view rendered no head row')
      const { detail: detailRect, head: headRect, viewport } = geometry
      const surface = await collectedSurface(page, INTERACTIVE_SELECTOR)
      const { regions } = surface

      // The head's top inset is the window clearance above the crumb: blank, so
      // it drags like the entry page's head. The row also starts at the window's top
      // edge, or the strip above it belongs to no drag region.
      expect(headRect.y, 'the detail head row starts at the window’s top edge').toBeLessThanOrEqual(0.5)
      expect(
        isDraggableAt(regions, headRect.x + headRect.width / 2, headRect.y + 4),
        'the detail head row’s top inset',
      ).toBe(true)

      // Below the head, a point that no control covers is content: pressing the
      // description, a label, or a gap in the form must reach the page.
      const interactive = surface.controls
      const bodyTop = headRect.y + headRect.height
      const bodyBottom = Math.min(detailRect.y + detailRect.height, viewport.height - 4)
      const dragging: string[] = []
      for (let row = 0; row < 8; row += 1) {
        for (let column = 0; column < 5; column += 1) {
          const x = detailRect.x + (detailRect.width * (column + 0.5)) / 5
          const y = bodyTop + ((bodyBottom - bodyTop) * (row + 0.5)) / 8
          if (y <= bodyTop || y > viewport.height - 4 || x > viewport.width - 4) continue
          if (interactive.some(region => x >= region.x && x < region.x + region.width
            && y >= region.y && y < region.y + region.height)) continue
          if (isDraggableAt(regions, x, y)) dragging.push(`${Math.round(x)},${Math.round(y)}`)
        }
      }
      expect(dragging, 'content points inside the detail body that drag the window').toEqual([])

      expect(swallowedBoxes(surface), 'interactive boxes inside the drag surface').toEqual([])
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, 'window-drag-coverage-detail-page')
      throw error
    } finally {
      await page.close()
    }
  }, 120_000)

  it('keeps a covering overlay out of the drag surface', async () => {
    const { page, tripwire } = await desktopPage()
    try {
      await page.getByRole('button', { name: 'Account menu', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
      const dialog = page.locator('[role="dialog"]').first()
      await dialog.waitFor({ timeout: 15_000 })
      await settled(page)
      const layer = await dialog.evaluate((element) => {
        const overlay = element.parentElement
        const rect = overlay?.getBoundingClientRect()
        return {
          parentIsBody: overlay?.parentElement === document.body,
          coversWindow: rect !== undefined && rect.top <= 0 && rect.bottom >= innerHeight,
        }
      })
      // A covering surface inside #root precedes the columns' chrome, so a drag
      // row declared later would override its subtraction; beside the root,
      // ui-web base.css's body rule subtracts it instead.
      expect(layer.parentIsBody, 'the covering overlay portals beside #root').toBe(true)
      expect(layer.coversWindow).toBe(true)

      const surface = await collectedSurface(page, INTERACTIVE_SELECTOR)
      const { regions } = surface
      const header = await rectOf(page, '[data-slot="conversation.header"] > header')
      expect(
        isDraggableAt(regions, header.x + header.width / 2, 8),
        'the window top behind an open covering overlay',
      ).toBe(false)
      expect(swallowedBoxes(surface), 'interactive boxes inside the drag surface').toEqual([])
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, 'window-drag-coverage-overlay')
      throw error
    } finally {
      await page.close()
    }
  }, 120_000)
})
