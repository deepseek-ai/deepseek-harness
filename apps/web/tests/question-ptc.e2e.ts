/** PTC answers stay visible through real Web composition, process folding, and reload. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const question = 'Which PTC answer should remain visible?'
const args = JSON.stringify({
  description: 'Ask for a retained answer',
  code: `return await tools.ask_user_question(${JSON.stringify({ questions: [{
    id: 'choice', question, options: [{ label: 'Blue' }, { label: 'Green' }],
  }] })});`,
})
const script: ReplayEntry[] = [
  { kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId('ptc-question'), name: 'run_code', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('ptc-question'), name: 'run_code', arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ] },
  { kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'PTC answer recorded.' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'PTC answer recorded.' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] },
]

describe.skipIf(webSnapshotMode() === 'record')('web e2e: PTC answered question', () => {
  let directory: string | undefined
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const events: SessionEvent[] = []

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-question-ptc-'))
    const replayOverride = join(directory, 'replay.override.json')
    await writeFile(replayOverride, JSON.stringify(script))
    scaffold = await launchWebScaffold({
      agentPresets: { default: 'ptc' },
      replayFixture: join(directory, 'override-only.jsonl'), replayOverride,
    })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (directory !== undefined) await rm(directory, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    if (failures.length > 0) throw new AggregateError(failures, 'PTC question cleanup failed')
  })

  it('records a real subcall answer once and retains its bubble when process rows fold', async () => {
    const settled = scaffold!.whenTurnSettled(60_000)
    const input = page.locator('[data-composer-input]').first()
    await input.fill('Ask me which color to retain.')
    await input.press('Enter')
    const composer = page.locator('[data-question-key]')
    await composer.getByRole('radio', { name: 'Blue', exact: true }).click()
    await composer.getByRole('button', { name: 'Submit', exact: true }).click()
    await settled
    const dispatch = events.find(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'ask_user_question')
    expect(dispatch?.type).toBe('tool/ptc-dispatch')
    if (dispatch?.type !== 'tool/ptc-dispatch') throw new Error('missing PTC question settlement')
    expect(dispatch.data.isError).toBe(false)
    expect(events.filter(event => event.type === 'tool/ptc-dispatch-start' && event.data.subCallId === dispatch.data.subCallId)).toHaveLength(1)
    const bubble = page.locator('[data-question-reply]')
    await bubble.waitFor({ state: 'visible' })
    expect(await bubble.count()).toBe(1)
    expect(await bubble.getAttribute('data-question-reply')).toBe(String(dispatch.data.subCallId))
    expect(await bubble.getByText(question, { exact: true }).isVisible()).toBe(true)
    expect(await bubble.getByText('Blue', { exact: true }).isVisible()).toBe(true)
    expect(await bubble.getByText('Green', { exact: true }).count()).toBe(0)
    const process = page.locator('[data-turn-process]').first()
    await expect.poll(() => process.isEnabled()).toBe(true)
    await expect.poll(() => process.getAttribute('aria-expanded')).toBe('false')
    await process.click()
    await expect.poll(() => process.getAttribute('aria-expanded')).toBe('true')
    await process.click()
    await expect.poll(() => process.getAttribute('aria-expanded')).toBe('false')
    expect(await bubble.isVisible()).toBe(true)
    await page.reload({ waitUntil: 'load' })
    await bubble.waitFor({ state: 'visible' })
    expect(await bubble.count()).toBe(1)
    expect(await bubble.getByText('Blue', { exact: true }).isVisible()).toBe(true)
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      const bounds = await bubble.evaluate((row) => {
        const wrapper = row.firstElementChild!
        return { width: wrapper.getBoundingClientRect().width, limit: row.getBoundingClientRect().width * 0.82,
          overflow: document.documentElement.scrollWidth - window.innerWidth }
      })
      expect(bounds.width).toBeLessThanOrEqual(bounds.limit + 1)
      expect(bounds.overflow).toBeLessThanOrEqual(1)
    }
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)
})
