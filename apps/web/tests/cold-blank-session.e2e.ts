/** Pending Inbox recovery from detached persistence through the shipped Web profile. */

import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SESSION_ID = SessionId('cold-inbox-web-e2e')
const PENDING_TEXT = 'Accepted before the Host restarted'
const EXPECTED = fileURLToPath(new URL('./expected/cold-blank-session/queue.expected.md', import.meta.url))

describe('web e2e: cold Inbox recovery', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const createdAt = Date.now() - 60_000
    const handle = await scaffold.ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION, id: SESSION_ID, createdAt,
      cwd: scaffold.workspaceCwd, isSeeded: false, delegationDepth: 0,
    })
    try {
      await handle.append([{
        type: 'agent/inbox/spliced', seq: SessionSeq(0), time: createdAt,
        data: { target: 'next-turn', start: 0, inserted: [createUserMessage({
          content: [{ type: 'text', text: PENDING_TEXT }], source: { kind: 'user' },
        })] },
      }])
    } finally {
      await handle.close()
    }
    expect(scaffold.ctx.agents.get(SESSION_ID)).toBeUndefined()
    expect(scaffold.ctx.sessions.get(SESSION_ID)).toBeUndefined()
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

  it('restores a pending row on opening and reload, then edits and removes it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-cold-inbox'))
    const group = page.locator('[role="treeitem"]').first()
    await group.waitFor({ timeout: 15_000 })
    await group.click()
    await page.locator('[role="treeitem"]').nth(1).click()
    const dock = page.locator('[data-queue-dock]')
    await dock.getByText(PENDING_TEXT, { exact: true }).waitFor({ timeout: 15_000 })
    await compareOrRefreshGolden(EXPECTED,
      await captureStableAria(page, '[data-queue-dock]', scaffold.workspaceCwd), webSnapshotMode())
    await page.reload({ waitUntil: 'load' })
    await dock.getByText(PENDING_TEXT, { exact: true }).waitFor({ timeout: 15_000 })
    await dock.getByRole('button', { name: 'Edit queued message', exact: true }).click()
    await dock.getByRole('textbox').fill('Edited after recovery')
    await dock.getByRole('button', { name: 'Save queued message', exact: true }).click()
    await dock.getByText('Edited after recovery', { exact: true }).waitFor()
    await dock.getByRole('button', { name: 'Remove queued message', exact: true }).click()
    await dock.waitFor({ state: 'detached' })
    expect(tripwire.pageErrors).toEqual([])
  })
})
