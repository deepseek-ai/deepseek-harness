// Web e2e scenario: the single-line produced-files summary a finished turn
// ends with. Cold-seeds ten writes (zero model calls), then verifies the real
// assembled lane adapts from a coarse width budget and offers no folder
// handoff: chips open in the right Sidebar's text preview, which has no
// directory form, so the row shows nothing rather than a dead button.
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import {
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const OVERLAY = fileURLToPath(new URL('./produced-files.overlay.yml', import.meta.url))
const SEED_ID = 'produced-files-web-e2e'
const DONE = 'PRODUCED_FILES_DONE'

/** Ten varied names exercise estimated prefix selection and CSS shrinking. */
const PRODUCED = [
  '关于我.md',
  'index.html',
  'long-generated-experience-specification-for-produced-files-overflow.md',
  'styles.css',
  'app.ts',
  'schema.json',
  'README.md',
  'preview.svg',
  'notes.txt',
  'manifest.yaml',
] as const

/** Build one settled turn whose successful write calls carry ten locations. */
function producedFixture(): string {
  const session = Session.create(SessionId('produced-files-source'))
  const eventTimeOrigin = new Date().setHours(12, 0, 0, 0)
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Create the site files.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: 'Produced files overflow', messageSeqs: [user.seq], source: { kind: 'fallback' },
  })
  session.append('step/start', { turn: 1, step: 1 })
  const calls = PRODUCED.map((path, index) => ({
    path,
    callId: ToolCallId(`produced-files-${String(index)}`),
    args: JSON.stringify({ file_path: path, content: `content of ${path}\n` }),
  }))
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: calls.map(call => ({
        type: 'tool-call' as const,
        id: call.callId,
        name: 'write',
        arguments: call.args,
      })),
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  for (const call of calls) {
    const source = session.append('tool/call', {
      turn: 1, step: 1, callId: call.callId, name: 'write', arguments: call.args,
    })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: call.callId,
        content: [{ type: 'text', text: `Created ${call.path}` }],
        isError: false,
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
  }
  session.append('step/end', { turn: 1, step: 1 })
  session.append('step/start', { turn: 1, step: 2 })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 2,
    message: createAssistantMessage({
      content: [{ type: 'text', text: `Created the site.\n\n${DONE}` }],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 2 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  return [
    JSON.stringify({
      type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}',
      createdAt: 0, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0,
    }),
    ...session.snapshotEvents().map(event => JSON.stringify({
      ...event, time: eventTimeOrigin + event.seq * 1_000,
    })),
    '',
  ].join('\n')
}

describe('web e2e: a finished turn ends with the files it produced', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    await seedSession(scaffold, producedFixture(), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    // Keep the responsive sidebar available while selecting the cold seed;
    // the assertion itself narrows the conversation after navigation.
    await page.setViewportSize({ width: 1800, height: 900 })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE === 'record')('adapts a ten-file summary without leaving one line', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-produced-files'))
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    if (await groupRow.getAttribute('aria-expanded') !== 'true') await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()

    await expect.poll(() => page.getByText(DONE, { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    const row = page.locator('[data-produced-files-row]')
    await row.waitFor({ timeout: 15_000 })
    const chips = row.getByRole('button')
    await expect.poll(() => chips.count()).toBe(6)
    await expect.poll(() => row.getByText('+ 4 files', { exact: true }).isVisible()).toBe(true)

    await page.setViewportSize({ width: 750, height: 900 })
    await page.evaluate(async () => { await document.fonts.ready })
    await page.waitForFunction(() => {
      const frame = document.querySelector('[data-sidebar-collapsed][data-rightbar-collapsed]')
      if (frame === null) return false
      const tracks = getComputedStyle(frame).gridTemplateColumns.split(' ').map(Number.parseFloat)
      // The responsive sidebar's settled collapsed track is 56px.
      return tracks[0] === 56 && tracks.at(-1) === 0
        && frame.getAnimations().every(animation =>
          animation.playState === 'finished' || animation.playState === 'idle')
    }, undefined, { timeout: 10_000 })
    await expect.poll(() => chips.count()).toBe(4)
    const laneWidth = await row.evaluate(element => element.clientWidth)
    // Keep font-metric differences away from the 479px and 583px container-query edges.
    expect(laneWidth).toBeGreaterThan(503)
    expect(laneWidth).toBeLessThan(559)
    expect(await chips.nth(0).innerText()).toBe('关于我.md')
    expect(await chips.nth(1).innerText()).toBe('index.html')
    expect(await chips.nth(3).innerText()).toBe('styles.css')
    await expect.poll(() => row.getByText('+ 6 files', { exact: true }).isVisible()).toBe(true)
    // Chips open in the right Sidebar's text preview, and a directory is not
    // something that preview can show, so the row offers no folder action.
    expect(await page.getByRole('button', { name: /folder/i }).count()).toBe(0)
    expect(await page.getByText('Files changed', { exact: true }).count()).toBe(1)

    const turnSpacing = await page.evaluate((done) => {
      const requiredElement = <T extends Element>(value: T | null | undefined, name: string): T => {
        if (value === null || value === undefined) throw new Error(`produced-file layout is missing ${name}`)
        return value
      }
      const answer = requiredElement(
        [...document.querySelectorAll<HTMLElement>('[data-chat-flow-kind="assistant-step"]')]
          .find(element => element.textContent?.includes(done)),
        'final answer',
      )
      const producedRow = requiredElement(
        document.querySelector<HTMLElement>('[data-produced-files-row]'),
        'produced row',
      )
      const producedRoot = requiredElement(producedRow.parentElement?.parentElement, 'produced root')
      const turnTail = requiredElement(producedRoot.closest<HTMLElement>('[data-turn-tail]'), 'turn tail')
      const actions = requiredElement(
        turnTail.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')?.parentElement,
        'action row',
      )
      const answerRect = answer.getBoundingClientRect()
      const producedRect = producedRoot.getBoundingClientRect()
      const actionsRect = actions.getBoundingClientRect()
      return {
        answerToProduced: producedRect.top - answerRect.bottom,
        producedToActions: actionsRect.top - producedRect.bottom,
      }
    }, DONE)
    expect(turnSpacing.answerToProduced).toBeCloseTo(20, 1)
    expect(turnSpacing.producedToActions).toBeCloseTo(20, 1)

    const tops = await row.locator(':scope > *:visible').evaluateAll(elements =>
      elements.map(element => element.getBoundingClientRect().top))
    expect(new Set(tops.map(top => Math.round(top))).size).toBe(1)
    const geometry = await row.evaluate(element => ({
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
    }))
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth)

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)
})
