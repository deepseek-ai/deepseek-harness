/** A multi-select question opens with every option marked as recommended already chosen, wherever it sits in the list. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import {
  connectFreshWorkspace, newEnglishPage, pinBrowserClock, pinHostClock, saveFailureShot,
} from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/question-composer-recommended', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v4.jsonl')
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()

const PROMPT = 'Use the ask_user_question tool to ask me exactly one multi-select question with id "checks", question "Which checks should run before merging?", header "Checks", and three options in this order: label "Unit tests (Recommended)", label "Full e2e suite", and label "Type check (Recommended)". Set multi_select to true. After I answer, reply with the single word DONE and stop.'

describe('web e2e: recommended multi-select options', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const sessionEvents: SessionEvent[] = []
  let hostClock: ReturnType<typeof pinHostClock> | undefined

  beforeAll(async () => {
    if (MODE !== 'record') hostClock = pinHostClock()
    scaffold = await launchWebScaffold(MODE === 'record' ? {} : { replayFixture: FIXTURE, paceMs: 15, compareReplaySession: true })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    if (MODE !== 'record') await pinBrowserClock(page)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      try { await scaffold?.close() }
      finally { hostClock?.mockRestore() }
    }
  })

  it('preselects every recommended option and submits them unchanged', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-question-recommended'))
    if (MODE !== 'record') {
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled(MODE === 'record' ? 180_000 : 30_000)
    await input.fill(PROMPT)
    await input.press('Enter')

    const composer = page.locator('[data-question-key]')
    await composer.waitFor({ timeout: MODE === 'record' ? 120_000 : 30_000 })
    await composer.getByRole('heading', { name: 'Which checks should run before merging?' }).waitFor({ timeout: 10_000 })
    const checked = await composer.getByRole('checkbox').evaluateAll(nodes =>
      nodes.map(node => node.getAttribute('aria-checked')))
    expect(checked).toEqual(['true', 'false', 'true'])
    if (MODE !== 'record') {
      const snapshot = await captureStableAria(page, '[data-question-key]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    }

    await composer.getByRole('button', { name: 'Submit', exact: true }).click()
    const sessionId = await settled
    if (MODE === 'record') {
      await recordFixture(scaffold, sessionId, FIXTURE)
      return
    }
    const answerText = sessionEvents.filter(event => event.type === 'tool/result')
      .flatMap(event => event.data.message.content.filter(item => item.type === 'text').map(item => item.text))
      .at(-1)
    expect(JSON.parse(answerText ?? '')).toEqual({
      answers: [{ id: 'checks', selected: ['Unit tests (Recommended)', 'Type check (Recommended)'] }],
    })
    await expect.poll(() => page.getByText('DONE', { exact: true }).count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v4.jsonl', 'ui.expected.md'])
  }, 200_000)
})
