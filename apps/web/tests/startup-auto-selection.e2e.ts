/** Web acceptance that startup Session opening preserves the resident Hero tree. */
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, launchWebScaffold, watchConsole, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

/**
 * The conversation root's own phase attribute. `div` disambiguates it from the
 * composer textarea, which carries an unrelated `data-phase` of its own.
 */
const ROOT_PHASE = 'div[data-phase]'

/** Every distinct conversation-root phase observed during one page load. */
function recordedPhases(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __conversationPhases: string[] }).__conversationPhases)
}

describe('web e2e: startup auto-selection', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps the resident Hero and composer nodes when the first Workspace session appears', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-first-workspace-stable-tree'))
    await page.locator(`${ROOT_PHASE}[data-phase="hero"]`).waitFor({ timeout: 15_000 })
    const headline = page.getByText('Into the Unknown', { exact: true })
    // The headline text sits in its own span inside the title group; the fish
    // hitbox precedes the group, not the text span.
    const fishHitbox = headline.locator('xpath=../preceding-sibling::span[1]')
    const fish = fishHitbox.locator('svg')
    expect(await fish.evaluate(node => getComputedStyle(node).color))
      .toBe(await headline.evaluate(node => getComputedStyle(node).color))
    await fishHitbox.hover()
    expect(await fish.evaluate(node => getComputedStyle(node).animationName)).not.toBe('none')
    await page.evaluate(() => {
      const refs = {
        root: document.querySelector('div[data-phase="hero"]'),
        workspaceChip: document.querySelector('[aria-label="Choose workspace"]'),
        scrollBody: document.querySelector('[data-conversation-scroll]'),
        composerSeat: document.querySelector('[data-composer-seat]'),
        composer: document.querySelector('[data-composer-input]'),
      }
      if (Object.values(refs).some(node => node === null)) throw new Error('incomplete initial Hero tree')
      ;(window as unknown as { __heroTree: typeof refs }).__heroTree = refs
    })

    // A registered Workspace is the precondition for the reload case below;
    // this first connection is also the no-Workspace → Workspace path.
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'startup-auto-selection')

    expect(await page.evaluate(() => {
      const before = (window as unknown as { __heroTree: Record<string, Element> }).__heroTree
      return {
        phase: document.querySelector('div[data-phase]')?.getAttribute('data-phase'),
        root: document.querySelector('div[data-phase="hero"]') === before.root,
        workspaceChip: document.querySelector('[aria-label="Choose workspace"]') === before.workspaceChip,
        scrollBody: document.querySelector('[data-conversation-scroll]') === before.scrollBody,
        composerSeat: document.querySelector('[data-composer-seat]') === before.composerSeat,
        composer: document.querySelector('[data-composer-input]') === before.composer,
        composerEnabled: document.querySelector('[data-composer-input]')?.getAttribute('aria-disabled') !== 'true',
      }
    })).toEqual({
      phase: 'hero',
      root: true,
      workspaceChip: true,
      scrollBody: true,
      composerSeat: true,
      composer: true,
      composerEnabled: true,
    })
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)

  it('keeps the hero and composer visible while the opening follow snapshot is pending', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-startup-auto-selection'))
    await page.addInitScript(() => {
      const phases: string[] = []
      ;(window as unknown as { __conversationPhases: string[] }).__conversationPhases = phases
      setInterval(() => {
        const phase = document.querySelector('div[data-phase]')?.getAttribute('data-phase')
        if (phase === null || phase === undefined) return
        if (phases[phases.length - 1] !== phase) phases.push(phase)
      }, 8)
    })

    let releaseOpening = (): void => {}
    const openingHeld = new Promise<void>((resolve) => { releaseOpening = resolve })
    let openingRequested = (): void => {}
    const openingInFlight = new Promise<void>((resolve) => { openingRequested = resolve })
    let gated = false
    const readObservation = scaffold.ctx.sessionQuery.observeSession
      .bind(scaffold.ctx.sessionQuery)
    const observe = vi.spyOn(scaffold.ctx.sessionQuery, 'observeSession')
      .mockImplementation(async (sessionId, options) => {
        const observation = await readObservation(sessionId, options)
        if (gated) return observation
        gated = true
        openingRequested()
        await openingHeld
        return observation
      })

    const warningsBefore = tripwire.warnings.length
    try {
      await page.reload({ waitUntil: 'commit' })
      await openingInFlight

      // The frame a user sees while the session is still opening: hero phase, the
      // hero title, and a composer that is actually painted (`settling` hides the
      // seat with `visibility:hidden`, which Playwright reports as not visible).
      await page.waitForSelector(ROOT_PHASE, { timeout: 15_000 })
      expect(await page.locator(ROOT_PHASE).first().getAttribute('data-phase')).toBe('hero')
      expect(await page.getByText('Into the Unknown').isVisible()).toBe(true)
      expect(await page.locator('[data-composer-input]').first().isVisible()).toBe(true)

      releaseOpening()
      await page.locator('[data-composer-input][contenteditable="true"][data-placeholder="Describe what you want to build, / commands, @ files or sessions"]')
        .waitFor({ timeout: 15_000 })
      acknowledgeReloadConnectionLoss(tripwire, warningsBefore)

      // Settling is not merely absent from the frame sampled above: the root
      // never entered it at any point of the load.
      expect(await recordedPhases(page)).toEqual(['hero'])
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      releaseOpening()
      observe.mockRestore()
    }
  }, 120_000)
})
