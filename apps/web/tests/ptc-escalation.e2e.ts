// Real PTC sandbox denial followed by one approved program execution.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import {
  assertFinalWorkspaceSnapshot, assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/ptc-escalation-approved', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v3.jsonl')
const UI_EXPECTED = join(SNAPSHOT_DIR, 'approval.expected.md')
const MODE = webSnapshotMode()
const PROMPT = 'Use run_code with timeoutMs 120000 and direct Node filesystem access to create approved.txt in the working directory containing exactly "approved\\n". '
  + 'Use await import("node:fs/promises") and writeFile; do not call nested tools. First attempt the write under the current read-only sandbox without escalation. '
  + 'In that first program, catch only filesystem errors with code EPERM, EACCES or EROFS and return exactly "EXPECTED_SANDBOX_DENIAL"; rethrow any other error. '
  + 'If the sandbox denies it, explicitly retry the program with sandbox_permissions "workspace-write" and justification "Create the file requested by the user". '
  + 'I will answer the approval prompt. After the file is written, reply DONE and stop.'

describe('web e2e: PTC program sandbox escalation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const events: SessionEvent[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      agentPresets: { roots: [], default: 'ptc' },
      compareReplaySession: true,
      ...(MODE === 'record' ? {} : { replayFixture: FIXTURE, paceMs: 15 }),
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
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps the file absent until approval and records the granted program', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ptc-escalation'))
    if (MODE !== 'record') expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    await page.locator('[aria-label^="Access mode"]').click()
    await page.getByRole('menuitem', { name: 'Read Only' }).click()
    await expect.poll(() => page.locator('[aria-label="Access mode, current: Read Only"]').count()).toBe(1)
    const settled = scaffold.whenTurnSettled(MODE === 'record' ? 240_000 : 60_000)
    await input.fill(PROMPT)
    await input.press('Enter')
    const panel = page.locator('[data-approval-key]')
    await panel.waitFor({ timeout: MODE === 'record' ? 180_000 : 60_000 })
    const calls = events.filter(event => event.type === 'tool/call')
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls.every(event => event.data.name === 'run_code')).toBe(true)
    expect(JSON.stringify(calls[0]?.data)).toContain('node:fs/promises')
    expect(JSON.stringify(calls.at(-1)?.data)).toContain('workspace-write')
    const results = events.filter(event => event.type === 'tool/result')
    expect(JSON.stringify(results[0]?.data)).toContain('EXPECTED_SANDBOX_DENIAL')
    const file = join(scaffold.workspaceCwd, 'workspace', 'approved.txt')
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    if (MODE !== 'record') {
      await compareOrRefreshGolden(UI_EXPECTED, await captureStableAria(page, '[data-approval-key]', scaffold.workspaceCwd), MODE)
    }
    await panel.getByRole('button', { name: 'Allow once' }).click()
    const sessionId = await settled
    expect(await readFile(file, 'utf8')).toBe('approved\n')
    expect(events.filter(event => event.type === 'tool/ptc-dispatch')).toHaveLength(0)
    expect(events.filter(event => event.type === 'approval/decided').map(event => event.data)).toMatchObject([{ outcome: 'allowed-once' }])
    expect(await page.locator('[aria-label="Access mode, current: Read Only"]').count()).toBe(1)
    await expect.poll(() => page.getByText('DONE', { exact: true }).count()).toBeGreaterThanOrEqual(1)
    expect(await panel.count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    if (MODE === 'record') await recordFixture(scaffold, sessionId, FIXTURE)
    await assertFinalWorkspaceSnapshot(SNAPSHOT_DIR, join(scaffold.workspaceCwd, 'workspace'))
  }, 300_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v3.jsonl', 'approval.expected.md', 'workspace.expected'])
  })
})
