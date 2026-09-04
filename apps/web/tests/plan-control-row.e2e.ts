// Web e2e scenario: at the 800×720 viewport the plan chip and the model
// trigger keep disjoint click areas, and clicking the chip at its center
// leaves plan mode through the real command channel. This is the browser
// regression the external report asked for (dsh-external/issues#107 →
// deepseek-harness#1406): "increase an 800×720 browser regression test and
// assert that the plan center hits the plan button".
//
// Plan mode is entered through the real /plan command with no argument:
// the command handler commits plan/mode active on the live agent without a
// model round (the lifecycle-chrome precedent), so the test needs no model
// call in any mode and no API key in replay/refresh; a providers-only
// fixture mounts the model catalog without a script to consume. Plan state
// folds from the session log (`plan/mode`, last one wins); the chip executes
// /plan off through commands.execute, which needs the live agent
// connectFreshWorkspace keeps.
//
// The geometry golden records stable facts — viewport membership on both
// axes for the chip and the trigger, and disjoint click areas — never
// absolute coordinates, whose pixel values depend on installed fonts and
// differ between macOS and Linux. The center hit-test is Playwright's
// actionability check: clicking the chip fails in a real engine when the
// element center does not receive pointer events. jsdom resolves no layout,
// so only a real engine can answer any of these facts.
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
const FIXTURE = join(SNAPSHOT_DIR, 'session.v2.jsonl')
const LAYOUT_EXPECTED = join(SNAPSHOT_DIR, 'layout.expected.md')
const MODE = webSnapshotMode()

/** The reported viewport: 800×720, where the composer card is 448px wide at 0.0.1. */
const VIEWPORT = { width: 800, height: 720 } as const

/** Chip aria-label on the English page; the seat renders only while plan is the effective target. */
const CHIP_ARIA = 'Plan mode on, press to turn off'

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

  it('keeps the plan chip and model trigger disjoint and exits plan mode by click', async () => {
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

    const golden = [
      '# Plan chip and model trigger at the 800×720 viewport',
      '',
      '- Plan chip fully in viewport: ' + (chipInViewport ? 'true' : 'false'),
      '- Model trigger fully in viewport: ' + (triggerInViewport ? 'true' : 'false'),
      '- Click areas disjoint: ' + (overlapArea === 0 ? 'true' : 'false'),
    ].join('\n').trimEnd()
    await compareOrRefreshGolden(LAYOUT_EXPECTED, golden, MODE)
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
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 200_000)

  it('keeps the snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v2.jsonl', 'layout.expected.md'])
  })
})
