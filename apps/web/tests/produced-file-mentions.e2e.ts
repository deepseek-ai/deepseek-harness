// Web e2e scenario: inline-code file mentions in the closing prose. Cold-seeds
// a built write turn (zero model calls) whose closing message names the written
// file three ways: by unique basename (links), ambiguously (stays inert), and
// as a file the turn never touched (stays inert). Package tests cover the
// resolver in isolation; only the assembled application shows a real write's
// locations reaching the prose as an opener. The click itself is not driven
// here: it hands the path to the Host's opener, which would launch a real
// application on the machine running the suite (the produced-files restraint).
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
const SEED_ID = 'produced-file-mentions-web-e2e'
const DONE = 'FILE_MENTION_DONE'

/** One-part text content for a built message. */
function text(value: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: value }]
}

/** The files the built turn writes; `notes.md` is named in prose but never written. */
const WRITES = ['site/report.html', 'a/style.css', 'b/style.css']

/** Build a settled write turn whose closing prose mentions files in inline code. */
function mentionFixture(): string {
  const session = Session.create(SessionId('produced-file-mentions-source'))
  const eventTimeOrigin = new Date().setHours(12, 0, 0, 0)
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Write the report page and both stylesheets.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: 'Produced file mentions',
    messageSeqs: [user.seq],
    source: { kind: 'fallback' },
  })
  session.append('step/start', { turn: 1, step: 1 })
  const calls = WRITES.map((path, index) => ({
    path,
    callId: ToolCallId(`file-mention-${String(index)}`),
    args: JSON.stringify({ file_path: path, content: `content of ${path}\n` }),
  }))
  session.append('assistant/message', {
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
      turn: 1,
      step: 1,
      callId: call.callId,
      name: 'write',
      arguments: call.args,
    })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: call.callId,
        content: text(`Created ${call.path}`),
        isError: false,
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
  }
  session.append('step/start', { turn: 1, step: 2 })
  session.append('assistant/message', {
    turn: 1,
    step: 2,
    message: createAssistantMessage({
      content: [{
        type: 'text',
        text: [
          'Wrote `report.html` plus two `style.css` copies; `notes.md` untouched.',
          '',
          DONE,
        ].join('\n'),
      }],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 2 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  return [
    JSON.stringify({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: '{{sessionId}}',
      createdAt: 0,
      cwd: '{{cwd}}',
    }),
    ...session.snapshotEvents().map(event => JSON.stringify({
      ...event,
      time: eventTimeOrigin + event.seq * 1_000,
    })),
    '',
  ].join('\n')
}

describe('web e2e: inline-code mentions of produced files', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, mentionFixture(), SEED_ID)
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

  it.skipIf(MODE === 'record')('links the unique mention and leaves ambiguous and unknown code inert', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-produced-file-mentions'))
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await expect.poll(() => page.getByText(DONE, { exact: true }).count(), { timeout: 15_000 }).toBe(1)

    // Exactly one prose mention links: `report.html` resolves to the written
    // path; the shared `style.css` basename and unwritten `notes.md` stay code.
    const mentions = page.locator('[class*="markdown"] code button')
    await expect.poll(() => mentions.count(), { timeout: 10_000 }).toBe(1)
    expect(await mentions.first().innerText()).toBe('report.html')
    expect(await mentions.first().getAttribute('aria-label')).toBe('Open site/report.html')
    expect(await mentions.first().getAttribute('title')).toBe('site/report.html')
    // The turn still ends with its produced-files row (all three writes).
    expect(await page.getByText('Produced', { exact: true }).count()).toBe(1)

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)
})
