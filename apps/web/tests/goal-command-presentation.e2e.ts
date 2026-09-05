// Web e2e: /goal opts its command input into the human transcript while the
// command remains log-only. The shipped composition runs with no model adapter,
// so an accidental turn fails loud in addition to the event-level assertions.
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-commands/types'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria,
  compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/goal-command-presentation', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL(
  './expected/goal-command-presentation/ui.expected.md', import.meta.url,
))
const MODE = webSnapshotMode()

describe('web e2e: /goal human transcript presentation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const events: SessionEvent[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
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

  it('completes with Tab and shows the bare input and result without a model turn', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-goal-command-presentation'))
    await expect.poll(() => page.getByText('Into the Unknown', { exact: false }).count(), {
      timeout: 15_000,
    }).toBe(1)
    const input = page.locator('[data-composer-input]').first()
    await input.fill('/go')
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })
    await menu.getByRole('option', { name: 'goal set or view the goal for a long-running task' })
      .waitFor({ timeout: 10_000 })
    await input.press('Tab')
    await expect.poll(() => input.textContent()).toBe('/goal ')
    await expect.poll(() => menu.count()).toBe(0)
    await input.press('Enter')

    const commandInput = page.locator('[data-command-input]')
    await commandInput.waitFor({ timeout: 10_000 })
    await expect.poll(() => commandInput.textContent()).toBe('/goal')
    expect(await commandInput.getAttribute('role')).toBe('group')
    expect(await commandInput.getAttribute('aria-label')).toBe('Command input')
    expect(await commandInput.getByRole('button').count()).toBe(0)
    const typography = await commandInput.evaluate((element) => {
      const bubble = element.firstElementChild?.firstElementChild
      if (!(bubble instanceof HTMLElement)) throw new Error('command input bubble is missing')
      const chip = bubble.querySelector('[data-ref-chip="command"]')
      if (!(chip instanceof HTMLElement)) throw new Error('command chip is missing')
      const rootStyle = getComputedStyle(element)
      const bubbleStyle = getComputedStyle(bubble)
      const chipStyle = getComputedStyle(chip)
      return {
        fontFamily: bubbleStyle.fontFamily,
        parentFontFamily: rootStyle.fontFamily,
        fontSize: bubbleStyle.fontSize,
        lineHeight: bubbleStyle.lineHeight,
        chipText: chip.textContent,
        chipFontFamily: chipStyle.fontFamily,
        chipFontSize: chipStyle.fontSize,
      }
    })
    expect(typography).toMatchObject({ fontSize: '14px', lineHeight: '22px', chipText: '/goal', chipFontSize: '14px' })
    // The bubble reads in the body face like a user bubble; only the command
    // chip carries the code face that marks the echoed token as a command.
    expect(typography.fontFamily).toBe(typography.parentFontFamily)
    expect(typography.chipFontFamily).not.toBe(typography.fontFamily)
    const resultRow = page.locator('[data-variant="others"]').filter({ hasText: 'No goal is currently set.' })
    await expect.poll(() => resultRow.count(), { timeout: 10_000 }).toBe(1)
    expect(await resultRow.getByText('goal', { exact: true }).count()).toBe(1)
    await expect.poll(() => page.locator('[data-phase="active"]').count()).toBe(1)
    expect(await page.getByText('Into the Unknown', { exact: false }).count()).toBe(0)

    const run = events.find(event => event.type === 'command/run')
    expect(run).toMatchObject({
      type: 'command/run',
      data: { name: 'goal', args: ' ', source: { kind: 'user' } },
    })
    expect(events.some(event => event.type === 'command/done')).toBe(true)
    expect(events.some(event => event.type === 'user/message')).toBe(false)
    expect(events.some(event => event.type === 'turn/start')).toBe(false)
    expect(events.some(event => event.type === 'step/start')).toBe(false)
    expect(events.some(event => event.type === 'request/header')).toBe(false)

    // The command result can arrive before Lexical clears the submitted claim.
    await expect.poll(() => input.textContent(), { timeout: 10_000 }).toBe('')
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
  }, 60_000)

  it('reloads the same bubble and result from the persisted command lifecycle', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-goal-command-presentation-reload'))
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)

    await expect.poll(() => page.locator('[data-command-input]').textContent(), { timeout: 15_000 }).toBe('/goal')
    const resultRow = page.locator('[data-variant="others"]').filter({ hasText: 'No goal is currently set.' })
    await expect.poll(() => resultRow.count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => page.locator('[data-phase="active"]').count()).toBe(1)

    const sessions = scaffold.ctx.sessions.list()
    expect(sessions).toHaveLength(1)
    const persisted = sessions[0]?.snapshotEvents() ?? []
    expect(persisted.filter(event => event.type === 'command/run' || event.type === 'command/done')
      .map(event => event.type)).toEqual(['command/run', 'command/done'])
    expect(persisted.some(event => event.type === 'user/message')).toBe(false)
    expect(persisted.some(event => event.type === 'turn/start')).toBe(false)
    expect(persisted.some(event => event.type === 'step/start')).toBe(false)
    expect(persisted.some(event => event.type === 'request/header')).toBe(false)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  }, 90_000)
})
