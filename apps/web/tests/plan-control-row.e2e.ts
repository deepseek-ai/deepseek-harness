// Browser regressions for composer click areas and content-sized model collapse.
// The live /plan command changes mode without a model round; a providers-only
// fixture supplies the model catalog. Real-engine geometry and click actions
// cover the 800×720 layout, same-width model changes, resizing, and Plan toggles.
// Goldens retain visibility, containment, and stability facts rather than pixel
// coordinates, which depend on platform fonts.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
// Type-only: pulls the plan/mode SessionEventMap merge so the discriminant
// filter below types as the plan-mode event in the host aggregate.
import type {} from '@deepseek-ai/dsh-plan-mode'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/plan-narrow-viewport', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v3.jsonl')
const LAYOUT_EXPECTED = fileURLToPath(new URL('./expected/plan-narrow-viewport/layout.expected.md', import.meta.url))
const MODE = webSnapshotMode()

/** The reported viewport: 800×720, where the composer card is 448px wide at 0.0.1. */
const VIEWPORT = { width: 800, height: 720 } as const

/** Chip aria-label on the English page; the seat renders only while plan is the effective target. */
const CHIP_ARIA = 'Plan mode on, press to turn off'
const SHORT_MODEL = 'DeepSeek-V4-Flash'
const LONG_MODEL = 'DeepSeek-V4-Flash-Vision-Exp'

/** Observe painted controls rather than the composer's internal compact flag. */
async function controlLayout(page: Page) {
  return page.getByRole('button', { name: /Select model/ }).evaluate((trigger) => {
    const card = trigger.closest('[data-composer-card]')
    const row = Array.from(card?.children ?? []).find(child => child.contains(trigger))
    if (!(row instanceof HTMLElement)) throw new Error('composer control row is missing')
    const visible = (element: Element): boolean => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    const label = trigger.querySelector(':scope > span')
    const icon = trigger.querySelector(':scope > svg')
    if (label === null || icon === null) throw new Error('model trigger label or icon is missing')
    const rect = row.getBoundingClientRect()
    const controls = Array.from(row.querySelectorAll('button')).filter(visible)
      .map(button => button.getBoundingClientRect())
    return {
      width: rect.width,
      text: visible(label),
      icon: visible(icon),
      singleLine: controls.length > 1
        && Math.max(...controls.map(box => box.top)) < Math.min(...controls.map(box => box.bottom)),
      contained: controls.every(box => box.left >= rect.left && box.right <= rect.right),
    }
  })
}

/** Wait for the responsive column and control row to finish changing width. */
async function resizeControls(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: VIEWPORT.height })
  await page.locator('[data-composer-card]').evaluate(async (card) => {
    let previous = card.getBoundingClientRect().width
    let stable = 0
    const deadline = performance.now() + 5_000
    while (performance.now() < deadline) {
      await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) })
      const current = card.getBoundingClientRect().width
      stable = Math.abs(current - previous) < 0.01 ? stable + 1 : 0
      if (stable >= 5) return
      previous = current
    }
    throw new Error('composer width did not settle')
  })
}

/** Change the real Session selection without starting a model turn. */
async function selectModel(page: Page, name: string): Promise<void> {
  const trigger = page.getByRole('button', { name: /Select model/ })
  await trigger.click()
  await page.getByRole('menuitem', { name: /^Model/ }).click()
  await page.getByRole('menuitemradio', { name, exact: true }).click()
  await expect.poll(() => trigger.getAttribute('title')).toMatch(new RegExp(`^${name}(?: ·|$)`))
}

/** A compact decision must remain stable across observer deliveries and paints. */
async function expectControlLayout(page: Page, compact: boolean): Promise<void> {
  const expected = { text: !compact, icon: compact, singleLine: true, contained: true }
  await expect.poll(() => controlLayout(page), { timeout: 10_000 }).toMatchObject(expected)
  for (let frame = 0; frame < 6; frame += 1) {
    await page.evaluate(() => new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) }))
    expect(await controlLayout(page)).toMatchObject(expected)
  }
}

describe('web e2e: plan chip click area at the narrow viewport', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    // replayProvidersOnly mounts the provider catalog without any recorded
    // script to consume (no model call happens — the /plan command never
    // steers a message), so the model trigger renders its real long label,
    // which is what made the reported overlap measurable.
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE, replayProvidersOnly: true })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser, VIEWPORT.height)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await page.setViewportSize(VIEWPORT)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps controls clickable and collapses model text only when the row needs space', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plan-narrow-viewport'))
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    await input.fill('/plan ')
    await input.press('Enter')

    // The command handler commits plan/mode active immediately (no model
    // round), so the chip renders and the composer control row — the surface
    // under test — is the one visible.
    const chip = page.getByRole('button', { name: CHIP_ARIA })
    const trigger = page.getByRole('button', { name: /Select model/ })
    await chip.waitFor({ timeout: 30_000 })
    await trigger.waitFor({ timeout: 10_000 })
    // The regression depends on the real model label width: a bare fallback
    // trigger would fit beside the chip even on the pre-fix layout. The
    // directory loads asynchronously, so poll for the real label.
    await expect.poll(() => trigger.getAttribute('aria-label'), { timeout: 10_000 }).toContain('DeepSeek-V4-Flash')
    const chipBox = await chip.boundingBox()
    const triggerBox = await trigger.boundingBox()
    expect(chipBox).not.toBeNull()
    expect(triggerBox).not.toBeNull()

    // The reported acceptance as numbers: both controls in viewport and
    // disjoint click areas (a non-zero overlap would fail), and — in the
    // click below — the chip center receiving the pointer.
    const chipInViewport = chipBox!.x >= 0 && chipBox!.x + chipBox!.width <= VIEWPORT.width
      && chipBox!.y >= 0 && chipBox!.y + chipBox!.height <= VIEWPORT.height
    const triggerInViewport = triggerBox!.x >= 0 && triggerBox!.x + triggerBox!.width <= VIEWPORT.width
      && triggerBox!.y >= 0 && triggerBox!.y + triggerBox!.height <= VIEWPORT.height
    const overlapLeft = Math.max(chipBox!.x, triggerBox!.x)
    const overlapTop = Math.max(chipBox!.y, triggerBox!.y)
    const overlapRight = Math.min(chipBox!.x + chipBox!.width, triggerBox!.x + triggerBox!.width)
    const overlapBottom = Math.min(chipBox!.y + chipBox!.height, triggerBox!.y + triggerBox!.height)
    const overlapArea = Math.max(0, overlapRight - overlapLeft) * Math.max(0, overlapBottom - overlapTop)

    const layoutGolden = [
      '# Composer control layout',
      '',
      '## Click areas at the 800×720 viewport',
      '',
      '- Plan chip fully in viewport: ' + (chipInViewport ? 'true' : 'false'),
      '- Model trigger fully in viewport: ' + (triggerInViewport ? 'true' : 'false'),
      '- Click areas disjoint: ' + (overlapArea === 0 ? 'true' : 'false'),
    ]
    expect(overlapArea).toBe(0)
    expect(chipInViewport).toBe(true)
    expect(triggerInViewport).toBe(true)

    // Exit through the real command channel: the click at the chip's center
    // executes /plan off and the folded projection flips inactive, so the chip
    // unmounts. Playwright's click() targets the element center by default and
    // its actionability check fails the click when that point is covered by
    // the model trigger — the reported bug as a failing click rather than a
    // coordinate probe.
    await chip.click()
    await expect.poll(() => page.getByRole('button', { name: CHIP_ARIA }).count(), { timeout: 15_000 }).toBe(0)
    // The click must have committed the exit: the last plan/mode event flips
    // inactive (the /plan command's entry event stays active:true earlier in
    // the log, so the pair proves the exit and not just the entry).
    const planModes = sessionEvents.filter(
      (event): event is SessionEvent<'plan/mode'> => event.type === 'plan/mode',
    )
    expect(planModes.at(-1)?.data.active).toBe(false)

    await page.evaluate(async () => { await document.fonts.ready })
    await resizeControls(page, 1680)
    await input.fill('/plan ')
    await input.press('Enter')
    await chip.waitFor({ timeout: 15_000 })
    await selectModel(page, LONG_MODEL)
    await expectControlLayout(page, false)

    // Find the content-dependent transition on this platform's fonts, never a
    // committed pixel threshold. The old 360px rule cannot satisfy this case.
    let narrowViewport: number | undefined
    for (let width = 1100; width >= 650; width -= 10) {
      await resizeControls(page, width)
      const layout = await controlLayout(page)
      if (layout.width > 360 && layout.icon && !layout.text) {
        narrowViewport = width
        break
      }
    }
    expect(narrowViewport, 'long model collapses while the row is wider than 360px').toBeDefined()
    if (narrowViewport === undefined) throw new Error('no content-driven collapse above 360px')
    await expectControlLayout(page, true)
    const collapsed = await controlLayout(page)
    const narrowRowWidth = collapsed.width
    expect(await trigger.getAttribute('aria-label')).toContain(LONG_MODEL)
    expect(await trigger.getAttribute('title')).toContain(LONG_MODEL)
    expect(await trigger.getAttribute('aria-label')).toMatch(/high/i)

    await selectModel(page, SHORT_MODEL)
    await expectControlLayout(page, false)
    const shorter = await controlLayout(page)
    expect(shorter.width).toBe(narrowRowWidth)
    await selectModel(page, LONG_MODEL)
    await expectControlLayout(page, true)

    await resizeControls(page, 1680)
    await expectControlLayout(page, false)
    const widened = await controlLayout(page)
    await resizeControls(page, narrowViewport)
    await expectControlLayout(page, true)
    await chip.click()
    await expect.poll(() => chip.count()).toBe(0)
    await expectControlLayout(page, false)
    const withoutPlan = await controlLayout(page)
    await input.fill('/plan ')
    await input.press('Enter')
    await chip.waitFor({ timeout: 15_000 })
    await expectControlLayout(page, true)
    await chip.click()
    await selectModel(page, SHORT_MODEL)
    const golden = [
      ...layoutGolden,
      '',
      '## Content-driven model collapse',
      '',
      `- Model icon replaces text above a 360px row: ${String(collapsed.width > 360 && collapsed.icon && !collapsed.text)}`,
      `- Compact controls share a line and stay within the row: ${String(collapsed.singleLine && collapsed.contained)}`,
      `- Shorter model restores text at the same width: ${String(shorter.width === collapsed.width && shorter.text && !shorter.icon)}`,
      `- Widening restores model text: ${String(widened.text && !widened.icon)}`,
      `- Removing the plan chip restores model text: ${String(withoutPlan.text && !withoutPlan.icon)}`,
    ].join('\n').trimEnd()
    await compareOrRefreshGolden(LAYOUT_EXPECTED, golden, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 200_000)

  it('keeps the snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v3.jsonl'])
  })
})
