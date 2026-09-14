// Keyless browser coverage for the goal bar over the shipped Web composition.
// The command creates a real projected goal in a real Host session. The
// goldens pin the active and disarmed strips, while the clear gesture proves
// the acknowledged tombstone leaves neither stale chrome nor a
// duplicate-mutation error.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type {} from '@deepseek-ai/dsh-goal'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/goal-bar', import.meta.url))
const ACTIVE_EXPECTED = join(SNAPSHOT_DIR, 'active.expected.md')
const INACTIVE_EXPECTED = join(SNAPSHOT_DIR, 'inactive.expected.md')
const OVERLAY = fileURLToPath(new URL('./goal-bar.overlay.yml', import.meta.url))
const MODE = webSnapshotMode()

describe('web e2e: goal bar clear convergence', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('renders one active goal and clears it without exposing a stale error', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-goal-bar-clear'))
    const input = page.locator('[data-composer-input][data-placeholder="Describe what you want to build, / commands, @ files or sessions"]')
    await input.waitFor({ timeout: 10_000 })
    await input.fill('/goal guard rapid clear clicks')
    await input.press('Enter')

    const bar = page.locator('[data-goal-bar]')
    await bar.waitFor({ timeout: 10_000 })
    const pause = bar.getByRole('button', { name: 'Pause goal' })
    await expect.poll(() => pause.count(), {
      timeout: 10_000,
    }).toBe(1)
    const snapshot = await captureStableAria(page, '[data-goal-bar]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(ACTIVE_EXPECTED, snapshot, MODE)

    const agents = scaffold.ctx.agents.list()
    expect(agents).toHaveLength(1)
    scaffold.ctx.goals.disarm(agents[0]!)
    await expect.poll(() => bar.getByRole('button', { name: 'Resume goal' }).count(), {
      timeout: 10_000,
    }).toBe(1)
    const inactive = await captureStableAria(page, '[data-goal-bar]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(INACTIVE_EXPECTED, inactive, MODE)

    const clear = bar.getByRole('button', { name: 'Clear goal' })
    await clear.evaluate((button) => {
      const control = button as HTMLButtonElement
      control.click()
      control.click()
    })
    await expect.poll(() => page.locator('[data-goal-bar]').count(), { timeout: 10_000 }).toBe(0)
    expect(await page.getByText(/no current goal/iu).count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['active.expected.md', 'inactive.expected.md'])
  })
})
