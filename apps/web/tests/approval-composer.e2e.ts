// Browser geometry for a pending approval whose model-supplied command would
// push the actions outside the viewport without a capped text region.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Empty type import: carries the approval package's session-event merge, so
// the decided-outcome assertion below type-checks against the real union.
import type {} from '@deepseek-ai/dsh-user-approval'
import {
  assertFinalWorkspaceSnapshot, assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/approval-composer', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v2.jsonl')
// The golden covers the stable waiting panel; direct assertions cover its answer.
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()

// Unrelated tokens keep the recorded model from compressing the payload into a
// short shell loop that would not overflow the card.
const TOKENS = Array.from({ length: 220 }, (_, index) => `tok${((index + 1) * 7919 % 99991).toString(36)}`).join(' ')
const PROMPT = `Write a file named notes.txt in the workspace containing exactly this text on one line: ${TOKENS}. Use one bash command with the literal text inline. Then reply with the single word DONE and stop.`

/** Draft used to measure the composer's own text cap: enough lines to pass it. */
const CAP_PROBE = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n')

describe('web e2e: approval takeover keeps its actions reachable', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold(MODE === 'record' ? {} : { replayFixture: FIXTURE, paceMs: 15, compareReplaySession: true })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
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

  it('caps the long command, answers through the panel, and runs the escalated command', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-approval'))
    if (MODE !== 'record') {
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })

    // Derive the expected cap from the live composer instead of duplicating its pixel value.
    await input.fill(CAP_PROBE)
    const composerCap = await input.evaluate(el => el.closest('[data-input-scroll]')?.clientHeight ?? 0)
    expect(composerCap).toBeGreaterThan(0)
    await input.fill('')

    await page.locator('[aria-label^="Access mode"]').click()
    await page.getByRole('menuitem', { name: 'Read Only' }).click()
    await expect.poll(
      () => page.locator('[aria-label="Access mode, current: Read Only"]').count(),
      { timeout: 15_000 },
    ).toBe(1)

    const settled = scaffold.whenTurnSettled(MODE === 'record' ? 240_000 : 60_000)
    await input.fill(PROMPT)
    await input.press('Enter')

    const panel = page.locator('[data-approval-key]')
    await panel.waitFor({ timeout: MODE === 'record' ? 180_000 : 60_000 })
    const scroll = panel.locator('[data-approval-scroll]')
    await expect.poll(() => scroll.getByText(/tok/).count(), { timeout: 15_000 }).toBeGreaterThan(0)

    if (MODE !== 'record') {
      const snapshot = await captureStableAria(page, '[data-approval-key]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)

      const original = page.viewportSize() ?? { width: 1680, height: 1000 }
      for (const height of [1000, 700]) {
        await page.setViewportSize({ width: 900, height })
        const geometry = await panel.evaluate((root) => {
          const region = root.querySelector<HTMLElement>('[data-approval-scroll]')
          const card = region?.parentElement ?? null
          // Role/text, not the CSS-module class names: the built client hashes those.
          const buttons = [...root.querySelectorAll<HTMLElement>('button')]
          const rows = buttons.map(button => button.getBoundingClientRect())
          return {
            buttons: buttons.length,
            capped: region === null ? 0 : region.clientHeight,
            // A scrolling region proves the cap is genuinely engaged; without
            // it every assertion below would hold vacuously.
            scrolls: region === null ? false : region.scrollHeight > region.clientHeight,
            cardBottom: card === null ? Number.NaN : card.getBoundingClientRect().bottom,
            actionsTop: Math.min(...rows.map(rect => rect.top)),
            actionsBottom: Math.max(...rows.map(rect => rect.bottom)),
            viewport: window.innerHeight,
          }
        })
        expect(geometry.buttons).toBe(2)
        expect(geometry.scrolls).toBe(true)
        // The panel and composer share one cap; allow sub-pixel layout variance.
        expect(Math.abs(geometry.capped - composerCap)).toBeLessThan(1)
        expect(geometry.actionsTop).toBeGreaterThan(0)
        expect(geometry.actionsBottom).toBeLessThanOrEqual(geometry.viewport)
        expect(geometry.actionsBottom).toBeLessThanOrEqual(geometry.cardBottom)
      }
      await page.setViewportSize(original)
    }

    await panel.getByRole('button', { name: 'Allow once' }).click()

    const sessionId = await settled
    if (MODE === 'record') {
      await recordFixture(scaffold, sessionId, FIXTURE)
      await assertFinalWorkspaceSnapshot(SNAPSHOT_DIR, join(scaffold.workspaceCwd, 'workspace'))
      return
    }
    // Direct state and DOM assertions cover the answered outcome beyond the
    // pending panel's expected output.
    expect(JSON.stringify(sessionEvents.filter(e => e.type === 'approval/decided').at(-1)))
      .toContain('allowed-once')
    const written = await readFile(join(scaffold.workspaceCwd, 'workspace', 'notes.txt'), 'utf8')
    expect(written).toContain(TOKENS.slice(0, 64))
    await assertFinalWorkspaceSnapshot(SNAPSHOT_DIR, join(scaffold.workspaceCwd, 'workspace'))
    await expect.poll(() => page.getByText('DONE', { exact: true }).count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(1)
    expect(await page.locator('[data-approval-key]').count()).toBe(0)
    await expect.poll(() => page.locator('[data-composer-input]').first().isEnabled(), { timeout: 10_000 }).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 300_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v2.jsonl', 'ui.expected.md', 'workspace.expected'])
  })
})
