// Keyless assembled-browser coverage for the opt-in Statistics view: the
// experimental client plugin is mounted only by the test overlay, so this Web
// composition is the package's user-visible evidence outside the jsdom lane.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import {
  createAssistantMessage, createMessage, createUserMessage, ToolCallId,
  type AssistantStreamRecord, type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import {
  connectFreshWorkspace, newEnglishPage, pinBrowserClock, pinHostClock, saveFailureShot,
} from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/client-ui-stats-panel', import.meta.url))
const PANEL_EXPECTED = join(SNAPSHOT_DIR, 'panel.expected.md')
const OVERLAY = fileURLToPath(new URL('./client-ui-stats-panel.overlay.yml', import.meta.url))
const INSTALL_ANCHORS = [
  fileURLToPath(new URL('../../../packages/experimental/client-ui-stats/package.json', import.meta.url)),
]
const MODE = webSnapshotMode()

/** Overlay layer entries, for the composition guard below. */
function profileEntries(path: string): unknown[] {
  const parsed = yaml.load(readFileSync(path, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new Error(`profile layer at ${path} must be a list`)
  return parsed
}

/** Usage one fixture assistant round reports. */
const USAGE: TokenUsage = {
  inputTokens: 1_200,
  outputTokens: 240,
  cacheReadTokens: 3_600,
  cacheWriteTokens: 400,
}

/** Compact stream whose first token arrives at the absolute Session time `firstTokenAt`. */
function stream(firstTokenAt: number): AssistantStreamRecord[] {
  return [{ type: 'text-chunks', time0: firstTokenAt, index: 0, dt: [200], texts: ['Ready.'] }]
}

describe('Statistics view overlay', () => {
  it('mounts the experimental client plugin over the shipped Web surface', () => {
    expect(profileEntries(OVERLAY)).toEqual([{
      insert: [{ id: 'ui-client-ui-stats', name: '@deepseek-ai/dsh-experimental-client-ui-stats' }],
    }])
  })
})

describe('web e2e: Statistics view', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let clock: ReturnType<typeof pinHostClock>

  beforeAll(async () => {
    clock = pinHostClock()
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, extraInstallAnchors: INSTALL_ANCHORS })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await pinBrowserClock(page)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const agent = scaffold.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('connected workspace did not create an Agent')
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Show the measured round.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('step/start', { turn: 1, step: 1 })
    await new Promise((resolve) => { setTimeout(resolve, 60) })
    // Real timestamps: the compact stream's time0 is an absolute Session time,
    // so the measured first token must sit between this step's start and the
    // settled message, exactly as a live round records them.
    const firstTokenAt = Date.now() - 10
    agent.session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'Ready.' }],
        source: { provider: 'fixture', model: 'fixture' },
      }),
      stream: stream(firstTokenAt),
      usage: USAGE,
    }, { surfaceOp: 'append' })
    agent.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: ToolCallId('call-1'),
      name: 'read',
      arguments: JSON.stringify({ file_path: '/work/notes.md' }),
    })
    agent.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'tool',
        content: [{ type: 'text', text: 'one\ntwo' }],
        source: { kind: 'tool', callId: ToolCallId('call-1') },
        toolCallId: ToolCallId('call-1'),
      }),
    }, { surfaceOp: 'append' })
    agent.session.append('step/end', { turn: 1, step: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(agent.session)
    await page.getByText('Ready.').waitFor({ timeout: 10_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    clock?.mockRestore()
    await scaffold?.close()
  })

  it('renders the measured context, timing, cache, and tool columns', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-client-ui-stats-panel'))
    await page.getByRole('tab', { name: 'Statistics', exact: true }).click()
    const table = page.locator('table[aria-label="Statistics"]')
    await table.waitFor({ timeout: 10_000 })
    expect(await table.getByRole('columnheader', { name: 'Context', exact: true }).count()).toBe(1)
    expect(await table.getByRole('columnheader', { name: 'Output', exact: true }).count()).toBe(1)
    expect(await table.getByRole('columnheader', { name: 'Cache hit', exact: true }).count()).toBe(1)
    expect(await table.getByText('Turn 1', { exact: false }).count()).toBeGreaterThan(0)
    expect(await table.getByText('Step 1', { exact: false }).count()).toBeGreaterThan(0)
    expect(await table.getByText('read ×1', { exact: false }).count()).toBeGreaterThan(0)
    // The measured columns carry the fixture's real accounting, and the timing
    // columns are measured rather than the dash placeholder. Durations and the
    // derived throughput/clock vary with the run, so the golden tokenizes them.
    const cells = await table.locator('tbody tr').first().locator('td').allInnerTexts()
    expect(cells[3]).toBe('5.2K')
    expect(cells[4]).toBe('0.24K')
    expect(cells[5]).toBe('69.23%')
    expect(cells[6]).not.toBe('—')
    expect(cells[8]).not.toBe('—')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    const snapshot = await captureStableAria(page, 'table[aria-label="Statistics"]', scaffold.workspaceCwd, {
      replacements: [[cells[6]!, '{{ttft}}'], [cells[8]!, '{{tps}}']],
    })
    await compareOrRefreshGolden(PANEL_EXPECTED, snapshot, MODE)
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['panel.expected.md'])
  })
})
