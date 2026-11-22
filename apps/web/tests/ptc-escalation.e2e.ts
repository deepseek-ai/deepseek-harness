// Real PTC sandbox denial followed by one approved program execution, for each program format.
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
  launchWebScaffold, recordFixture, selectedSessionFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const PROMPT_PREFIX = 'Use run_code with timeoutMs 120000 and direct Node filesystem access to create approved.txt in the working directory containing exactly "approved\\n". '
  + 'Use await import("node:fs/promises") and writeFile; do not call nested tools. First attempt the write under the current read-only sandbox without escalation. '
  + 'In that first program, catch only filesystem errors with code EPERM, EACCES or EROFS and use `inspect(...)` to display exactly "EXPECTED_SANDBOX_DENIAL"; rethrow any other error. '
  + 'If the sandbox denies it, explicitly retry the program with sandbox_permissions "workspace-write" and justification "Create the file requested by the user". '
  + 'I will answer the approval prompt. '

const VARIANTS = [{
  executionMode: 'per-call',
  dir: 'ptc-escalation-approved',
  fixture: 'session.v3.jsonl',
  prompt: `${PROMPT_PREFIX}After the file is written, reply DONE and stop.`,
  followUp: undefined,
}, {
  executionMode: 'persistent-in-memory',
  dir: 'ptc-escalation-approved-scoped',
  fixture: 'session.v4.jsonl',
  prompt: `${PROMPT_PREFIX}In the approved retry, also declare \`const escalationMarker = "ESCALATED"\`. `
    + 'After the file is written, run one more run_code program without escalation that uses `inspect(...)` to display '
    + '`{ escalationMarker: typeof escalationMarker, fs: typeof fs }`. Then reply DONE and stop.',
  // The standing REPL keeps `fs` from the first program; the approved escalation ran in a fresh environment and kept nothing.
  followUp: "{ escalationMarker: 'undefined', fs: 'object' }\n",
}] as const

describe.each(VARIANTS)('web e2e: PTC program sandbox escalation ($executionMode)', ({ executionMode, dir, fixture, prompt, followUp }) => {
  const snapshotDir = fileURLToPath(new URL(`../../../snapshots/web/${dir}`, import.meta.url))
  const fixturePath = join(snapshotDir, fixture)
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const events: SessionEvent[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      agentPresets: { default: 'ptc' },
      // per-call programs are async function bodies; persistent-in-memory programs are scoped REPL statements.
      ptcExecutionMode: executionMode,
      compareReplaySession: true,
      ...(MODE === 'record' ? {} : { replayFixture: fixturePath, paceMs: 15 }),
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
    onTestFailed(() => saveFailureShot(page, `web-e2e-ptc-escalation-${executionMode}`))
    if (MODE !== 'record') expect(fixtureUserPrompts(await readFile(await selectedSessionFixture(fixturePath), 'utf8'))).toEqual([prompt])
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    await page.locator('[aria-label^="Access mode"]').click()
    await page.getByRole('menuitem', { name: 'Read Only' }).click()
    await expect.poll(() => page.locator('[aria-label="Access mode, current: Read Only"]').count()).toBe(1)
    const settled = scaffold.whenTurnSettled(MODE === 'record' ? 240_000 : 60_000)
    await input.fill(prompt)
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
      await compareOrRefreshGolden(join(snapshotDir, 'approval.expected.md'), await captureStableAria(page, '[data-approval-key]', scaffold.workspaceCwd), MODE)
    }
    const escalatedCallId = calls.at(-1)?.data.callId
    await panel.getByRole('button', { name: 'Allow once' }).click()
    const sessionId = await settled
    expect(await readFile(file, 'utf8')).toBe('approved\n')
    expect(events.filter(event => event.type === 'tool/ptc-dispatch')).toHaveLength(0)
    expect(events.filter(event => event.type === 'approval/decided').map(event => event.data)).toMatchObject([{ outcome: 'allowed-once' }])
    if (followUp !== undefined) {
      const allCalls = events.filter(event => event.type === 'tool/call')
      const escalatedIndex = allCalls.findIndex(event => event.data.callId === escalatedCallId)
      const standing = allCalls.slice(escalatedIndex + 1)
      expect(standing).toHaveLength(1)
      expect(standing[0]?.data.arguments).not.toContain('sandbox_permissions')
      const standingResult = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === standing[0]?.data.callId)
      expect(standingResult?.type === 'tool/result' ? standingResult.data.message : undefined).toMatchObject({
        isError: false,
        content: [{ type: 'text', text: followUp }],
      })
    }
    expect(await page.locator('[aria-label="Access mode, current: Read Only"]').count()).toBe(1)
    await expect.poll(() => page.getByText('DONE', { exact: true }).count()).toBeGreaterThanOrEqual(1)
    expect(await panel.count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    if (MODE === 'record') await recordFixture(scaffold, sessionId, fixturePath)
    await assertFinalWorkspaceSnapshot(snapshotDir, join(scaffold.workspaceCwd, 'workspace'))
  }, 300_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(snapshotDir, [fixture, 'approval.expected.md', 'workspace.expected'])
  })
})
