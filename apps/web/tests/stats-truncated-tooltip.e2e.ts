// Web e2e scenario: a composer statistics pill cut off by the narrow composer
// row shows its full reading in a tooltip on hover. The seed is generated, not recorded: no line is model output.
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED_ID = 'stats-truncated-tooltip-web-e2e'
const USAGE_READING = '5.8M tok · Cache hit 98%'

/**
 * Generate one closed single-step turn whose billed usage totals 5.8M tokens at a 98% cache hit.
 * @returns session.jsonl text for {@link seedSession}.
 */
function buildSeed(): string {
  const lines = [JSON.stringify({
    type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}',
    createdAt: 1784974100000, cwd: '{{cwd}}/workspace', isSeeded: false, delegationDepth: 0,
  })]
  let seq = 0
  let time = 1784974100000
  const at = (event: Record<string, unknown>): void => {
    lines.push(JSON.stringify({ ...event, seq: seq++, time: time++ }))
  }
  at({ type: 'turn/start', data: { turn: 1 } })
  at({ type: 'step/start', data: { turn: 1, step: 1 } })
  at({ type: 'system/message', data: { turn: 1, step: 1, message: createSystemMessage('') }, surfaceOp: 'append' })
  at({
    type: 'user/message',
    data: {
      id: '00000000-0000-4000-9000-000000000001',
      role: 'user',
      content: [{ type: 'text', text: 'm1' }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  })
  at({
    type: 'assistant/message',
    data: {
      stream: [],
      turn: 1,
      step: 1,
      message: {
        id: '00000000-0000-4000-8000-000000000001',
        role: 'assistant',
        content: [{ type: 'text', text: 'r1' }],
        source: { kind: 'model', provider: 'snapshot', model: 'snapshot-replier' },
      },
      usage: { inputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 5_680_000 },
    },
    surfaceOp: 'append',
  })
  at({ type: 'step/end', data: { turn: 1, step: 1 } })
  at({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  return `${lines.join('\n')}\n`
}

describe('web e2e: truncated composer statistics', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    if (webSnapshotMode() === 'record') throw new Error('stats-truncated-tooltip is a keyless assembled scenario')
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, buildSeed(), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows the full reading of a pill the narrow composer cuts off', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-stats-truncated-tooltip'))
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
    const usagePill = page.getByRole('button', { name: USAGE_READING, exact: true })
    await usagePill.waitFor({ timeout: 15_000 })
    const tooltip = page.getByRole('tooltip')
    const label = usagePill.locator(':scope > span')
    const cut = () => label.evaluate(element => element.scrollWidth > element.clientWidth)
    expect(await cut()).toBe(false)

    await page.setViewportSize({ width: 390, height: 900 })
    await expect.poll(cut).toBe(true)
    await usagePill.hover()
    await expect.poll(() => tooltip.textContent()).toBe(USAGE_READING)
    await usagePill.click()
    await page.getByRole('dialog', { name: 'Token usage' }).waitFor()
    expect(await tooltip.count()).toBe(0)
  }, 60_000)

  it('stayed clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
