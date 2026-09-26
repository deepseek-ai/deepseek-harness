// Session-header job list driven by a real background bash run: the job row
// arrives over the job roster stream, expanding it opens the output
// observation stream, and the panel shows the process's real output while it
// is still running. No model call is involved.
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { JobId } from '@deepseek-ai/dsh-jobs'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v2.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/live-job-stream', import.meta.url))
const STREAMING_EXPECTED = join(SNAPSHOT_DIR, 'streaming.expected.md')
const SETTLED_EXPECTED = join(SNAPSHOT_DIR, 'settled.expected.md')
const MODE = webSnapshotMode()
const SEED_ID = 'live-job-stream-web-e2e'
// One fixed line of early output, then a hold on a barrier file the test owns
// in the job's cwd: the process never exits on its own, so no CI stall can
// settle it before the scenario kills it. The bounded loop only caps an
// orphan's lifetime if the runner dies before `afterAll` releases the barrier.
const RELEASE = '.live-job-stream.release'
const COMMAND = `printf 'streamed-%s\\n' marker-line; for _ in $(seq 1 3000); do [ -e ${RELEASE} ] && break; sleep 0.2; done`

/**
 * Wait for opening a session to publish its live Agent.
 * @param scaffold - the booted web scaffold.
 * @param sessionId - the opened session's identity.
 * @returns the registered Agent instance.
 */
async function liveAgent(scaffold: WebScaffold, sessionId: SessionId): Promise<Agent> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const found = scaffold.ctx.agents.get(sessionId)
    if (found !== undefined) return found
    if (Date.now() > deadline) throw new Error(`opening session "${sessionId}" published no live Agent`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

describe.skipIf(MODE === 'record')('web e2e: live job stream', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let agent: Agent

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, await readFile(FIXTURE, 'utf8'), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()

    // Opening the session drives the Host's ordinary Agent resolution; the
    // job owner must be that exact live instance, never a second one.
    agent = await liveAgent(scaffold, SessionId(SEED_ID))
  }, 120_000)

  afterAll(async () => {
    if (scaffold !== undefined) await writeFile(join(scaffold.workspaceCwd, RELEASE), '')
    await browser?.close()
    await scaffold?.close()
  })

  it('streams a running job\'s real output into the expanded panel, then settles it in place on kill', async () => {
    let phase = 'streaming'
    onTestFailed(() => saveFailureShot(page, `web-e2e-live-job-${phase}`))
    const trigger = page.getByRole('button', { name: '1 background job running' })
    expect(await trigger.count()).toBe(0)

    const started = await scaffold.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('live-job-stream-e2e'),
      name: 'bash',
      arguments: { command: COMMAND, description: 'Emit one live line then hold', run_in_background: true },
      agent,
    })
    const reported = started.content.map(block => block.type === 'text' ? block.text : '').join('')
    const matched = /\bbash-\d+\b/.exec(reported)
    if (matched === null) throw new Error(`background bash reported no job id: ${reported}`)
    const jobId = JobId(matched[0])

    // The job row reaches the header over the job roster stream.
    await trigger.waitFor({ timeout: 15_000 })
    await trigger.click()

    // Expanding the row opens the output observation stream; the panel then renders
    // the command's real stdout while the process is still running.
    const expand = page.getByRole('button', { name: /Show live output/ })
    await expand.waitFor({ timeout: 10_000 })
    await expand.click()
    await page.getByText('streamed-marker-line').waitFor({ timeout: 15_000 })

    const streaming = await captureStableAria(page, '[class*="menu"]', scaffold.workspaceCwd, { runningJobs: 'keep' })
    await compareOrRefreshGolden(STREAMING_EXPECTED, streaming, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])

    phase = 'settled'
    expect(scaffold.ctx.jobs.kill(jobId, agent.id, 'web e2e cancellation')).toBe('requested')

    // Settlement arrives on the observation stream itself, so the open panel
    // flips without any further interaction; the roster trigger follows.
    const idle = page.getByRole('button', { name: '1 background job', exact: true })
    await idle.waitFor({ timeout: 20_000 })
    await page.getByText('streamed-marker-line').waitFor({ timeout: 10_000 })

    const settled = await captureStableAria(page, '[class*="menu"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(SETTLED_EXPECTED, settled, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['settled.expected.md', 'streaming.expected.md'])
  })
})
