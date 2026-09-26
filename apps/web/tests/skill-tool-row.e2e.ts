// Web e2e scenario: the real skill-load recording, seeded cold through the
// persistence seam, renders through ui-skill's keyed toolview without a model
// call. The disclosure proves replay-stable naming and exact durable output.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, seedSession, selectedSessionFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { expandOwningTurnProcess, newEnglishPage, saveFailureShot } from './support.ts'

// Any generation path names the role; the owner's highest committed generation replays.
const FIXTURE = fileURLToPath(new URL('../../../snapshots/session/skill-load/session.v4.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/skill-tool-row', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/skill-tool-row/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'skill-tool-row-web-e2e'
const PROMPT = 'Load the editing-cordis-compositions skill with the skill tool, then reply DONE.'

describe.skipIf(MODE === 'record')('web e2e: dedicated Skill tool row', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    const fixture = await readFile(await selectedSessionFixture(FIXTURE), 'utf8')
    expect(fixtureUserPrompts(fixture)).toEqual([PROMPT])
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, fixture, SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    const skillRow = page.locator('[data-tool="skill"]')
    await expandOwningTurnProcess(page, skillRow)
    await skillRow.waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('expands the loaded skill to its exact recorded instructions', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-skill-tool-row'))
    const call = page.locator('[data-tool="skill"]')
    const row = call.getByRole('button', { name: 'Skill editing-cordis-compositions' })
    await expect.poll(() => row.getAttribute('aria-expanded')).toBe('false')
    expect(await call.getByText('editing-cordis-compositions', { exact: true }).count()).toBe(1)

    await row.click()
    await expect.poll(() => row.getAttribute('aria-expanded')).toBe('true')
    await call.getByText('Instructions', { exact: true }).waitFor()
    const output = call.locator('pre')
    await output.waitFor()
    expect(await output.textContent()).toContain('<skill_content name="editing-cordis-compositions">')
    expect(await output.textContent()).toContain('Agent presets are ordinary `@deepseek-ai/dsh-agent-preset` declarations carried by bundle patches.')
    expect(await output.evaluate(element => getComputedStyle(element.parentElement!).maxHeight)).toBe('260px')

    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .replace(/\b\d{1,2}\/\d{1,2}(?= \{\{clock\}\})/g, '{{date}}')
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps the collapsed Skill line on the global ToolCall font-size axis', async () => {
    const call = page.locator('[data-tool="skill"]')
    const toggle = call.getByRole('button', { name: 'Skill editing-cordis-compositions' })
    if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
    const row = call.locator(':scope > div').first()
    const title = call.getByText('Skill', { exact: true })
    const summary = call.getByText('editing-cordis-compositions', { exact: true })

    expect(await title.evaluate(element => getComputedStyle(element).fontSize)).toBe('13px')

    const previous = await page.evaluate(() => ({
      fontSize: {
        value: document.body.style.getPropertyValue('--dsh-content-font-size-secondary'),
        priority: document.body.style.getPropertyPriority('--dsh-content-font-size-secondary'),
      },
      delta: {
        value: document.body.style.getPropertyValue('--dsh-content-font-delta'),
        priority: document.body.style.getPropertyPriority('--dsh-content-font-delta'),
      },
    }))
    await page.evaluate(() => {
      document.body.style.setProperty('--dsh-content-font-size-secondary', '15px')
      document.body.style.setProperty('--dsh-content-font-delta', '2px')
    })
    try {
      expect(await title.evaluate(element => getComputedStyle(element).fontSize)).toBe('15px')
      expect(await summary.evaluate(element => getComputedStyle(element).fontSize)).toBe('15px')
      expect(await row.evaluate(element => getComputedStyle(element).height)).toBe('26px')
      expect(await row.locator('svg').first().evaluate(element => getComputedStyle(element).width)).toBe('16px')
    } finally {
      await page.evaluate((saved) => {
        const restore = (name: string, entry: { value: string; priority: string }): void => {
          if (entry.value === '') document.body.style.removeProperty(name)
          else document.body.style.setProperty(name, entry.value, entry.priority)
        }
        restore('--dsh-content-font-size-secondary', saved.fontSize)
        restore('--dsh-content-font-delta', saved.delta)
      }, previous)
    }
  })

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
