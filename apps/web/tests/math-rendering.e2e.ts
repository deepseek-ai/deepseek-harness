import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, type SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  seedSession,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot, WEB_FIXTURE_TIME } from './support.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/math-rendering', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./expected/math-rendering/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'math-rendering-web-e2e'
const DONE = 'MATH_RENDERING_DONE'

/** Build a settled assistant reply that exercises every supported math delimiter. */
function mathFixture(): string {
  const session = Session.create(brandString<SessionId>('math-rendering-source'))
  session.append('turn/start', {
    turn: 1,
  })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Render this mathematical proof.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: 'Math rendering',
    messageSeqs: [user.seq],
    source: { kind: 'fallback' },
  })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{
        type: 'text',
        text: [
          '## Math rendering',
          '',
          'Inline dollar $\\theta$ and backslash \\(\\frac{1}{5}\\).',
          '',
          '\\[\\frac{\\pi}{4} < \\theta < \\frac{\\pi}{2}\\]',
          '',
          '$$\\theta \\in \\left(\\frac{\\pi}{4}, \\frac{\\pi}{2}\\right). \\tag{1}$$',
          '',
          '| Symbol | Value |',
          '| --- | --- |',
          '| $\\theta$ | \\(\\frac{1}{5}\\) |',
          '',
          DONE,
        ].join('\n'),
      }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  return [
    JSON.stringify({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: '{{sessionId}}',
      createdAt: 0,
      cwd: '{{cwd}}',
      isSeeded: false,
      delegationDepth: 0,
    }),
    ...session.snapshotEvents().map(event => JSON.stringify({
      ...event,
      time: WEB_FIXTURE_TIME + event.seq * 1_000,
    })),
    '',
  ].join('\n')
}

describe('web e2e: settled Markdown math rendering', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, mathFixture(), SEED_ID, undefined, { createdAt: WEB_FIXTURE_TIME })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.clock.setFixedTime(WEB_FIXTURE_TIME)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await page.getByText(DONE, { exact: true }).waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE === 'record')('renders the settled reply without KaTeX errors', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-math-rendering'))
    await expect.poll(() => page.locator('.katex').count(), { timeout: 10_000 }).toBe(6)
    await expect.poll(() => page.locator('.katex-display').count(), { timeout: 10_000 }).toBe(2)
    expect(await page.locator('.katex-error').count()).toBe(0)
    const fonts = await page.evaluate(async () => {
      const faces = [...document.fonts].filter(face => face.family.includes('KaTeX_'))
      await Promise.all(faces.map(face => face.load()))
      return faces.map(face => face.status)
    })
    expect(fonts).toHaveLength(20)
    expect(fonts.every(status => status === 'loaded')).toBe(true)
    await expect.poll(
      () => page.getByText('1 turns 1 steps', { exact: false }).count(),
      { timeout: 10_000 },
    ).toBe(1)

    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  }, 60_000)

  it.skipIf(MODE === 'record')('copies a selection with formulas as TeX source', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-math-copy'))
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
    const sentinel = 'clipboard-before-copy'
    await page.evaluate(value => navigator.clipboard.writeText(value), sentinel)
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(sentinel)
    await page.evaluate(() => {
      const paragraph = [...document.querySelectorAll('p')].find(item => item.textContent.startsWith('Inline dollar'))!
      const visual = paragraph.parentElement!.querySelector('.katex-display .katex-html')!
      const range = document.createRange()
      range.setStart(paragraph.firstChild!, 0)
      range.setEnd(visual.firstChild!, 1)
      document.getSelection()!.removeAllRanges()
      document.getSelection()!.addRange(range)
    })
    await page.keyboard.press('ControlOrMeta+C')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
      'Inline dollar $\\theta$ and backslash $\\frac{1}{5}$.\n\n$$\\frac{\\pi}{4} < \\theta < \\frac{\\pi}{2}$$',
    )
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 30_000)
})
