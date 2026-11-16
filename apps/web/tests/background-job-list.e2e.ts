import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
// The Session panel's background-jobs section driven by a real `ctx.jobs`
// entry. No model call is involved.
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { foldControlLayout, newEnglishPage, saveFailureShot, sessionPanelToggle, showSessionPanel } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v3.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/background-job-list', import.meta.url))
const RUNNING_EXPECTED = join(SNAPSHOT_DIR, 'running.expected.md')
const SETTLED_EXPECTED = join(SNAPSHOT_DIR, 'settled.expected.md')
const SECTION = '[data-session-panel-section="background-jobs"]'
const MODE = webSnapshotMode()
const SEED_ID = 'background-job-list-web-e2e'
// A hold on a barrier file the test owns in the job's cwd: the process never
// exits on its own, so no CI stall can settle it before the scenario kills it.
// The bounded loop only caps an orphan's lifetime if the runner dies before
// `afterAll` releases the barrier.
const RELEASE = '.background-job-list.release'
const COMMAND = `for _ in $(seq 1 3000); do [ -e ${RELEASE} ] && break; sleep 0.2; done`

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

describe.skipIf(MODE === 'record')('web e2e: background job list', () => {
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
    // `expect.poll` is test-scoped, so this hook polls by hand.
    agent = await liveAgent(scaffold, brandString<SessionId>(SEED_ID))
  }, 120_000)

  afterAll(async () => {
    if (scaffold !== undefined) await writeFile(join(scaffold.workspaceCwd, RELEASE), '')
    await browser?.close()
    await scaffold?.close()
  })

  it('shows a running background job in the Session panel without a refresh, then kills it from the two-press stop control', async () => {
    let phase = 'running'
    onTestFailed(() => saveFailureShot(page, `web-e2e-background-job-${phase}`))
    const toggle = sessionPanelToggle(page)
    const section = (await showSessionPanel(page)).locator(SECTION)
    const list = section.getByRole('list')
    // The mounted section keeps the roster stream open but renders no rows
    // yet, so the panel hides it with its title. A one-shot check: polling for
    // zero would pass at t=0 before delivery and prove nothing.
    expect(await section.count()).toBe(1)
    expect(await section.isVisible()).toBe(false)
    expect(await list.count()).toBe(0)

    const started = await executeToolFixture(scaffold.ctx, {
      signal: new AbortController().signal,
      callId: brandString<ToolCallId>('background-job-list-e2e'),
      name: 'bash',
      arguments: { command: COMMAND, description: 'Hold a background slot open', run_in_background: true },
      agent,
    })
    const reported = started.content.map(block => block.type === 'text' ? block.text : '').join('')
    const matched = /\bbash-[0-9a-f]{16}\b/.exec(reported)
    if (matched === null) throw new Error(`background bash reported no job id: ${reported}`)
    const jobId = brandString<JobId>(matched[0])

    const row = list.getByRole('listitem').first()
    await row.waitFor({ timeout: 15_000 })
    await expect.poll(() => row.textContent()).toContain(COMMAND)
    expect(await section.getByRole('heading', { name: 'Background jobs', level: 2 }).isVisible()).toBe(true)
    expect(await row.locator('[data-state="ongoing"]').count()).toBe(1)
    expect(await page.locator('[data-jobs-running]').count()).toBe(0)
    // Hiding the panel unmounts the section, and a blue dot on the toggle reports the running job.
    await toggle.click()
    await list.waitFor({ state: 'detached' })
    const dot = page.locator('[data-jobs-running]')
    await dot.waitFor()
    await page.getByRole('button', { name: 'Session panel Background jobs running: 1', exact: true }).waitFor()
    expect(await dot.evaluate(element => getComputedStyle(element).width)).toBe('6px')
    // Showing it again lists the live job, and the dot goes away.
    await showSessionPanel(page)
    await row.waitFor({ timeout: 10_000 })
    expect(await toggle.getAttribute('aria-expanded')).toBe('true')
    await dot.waitFor({ state: 'detached' })

    const running = await captureStableAria(page, SECTION, scaffold.workspaceCwd)
    await compareOrRefreshGolden(RUNNING_EXPECTED, running, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])

    phase = 'settled'
    // The whole human path: arm, confirm, job.kill, registry kill, jobs
    // frames flipping the row — no registry call from the test.
    const stop = section.locator('[data-kill-state]')
    await stop.waitFor({ timeout: 10_000 })
    await stop.click()
    await expect.poll(() => stop.getAttribute('data-kill-state')).toBe('armed')
    await stop.click()

    // The unclaimed report's reason lands in the settled row's detail; presses
    // inside the overlay leave it open.
    await expect.poll(() => list.textContent(), { timeout: 15_000 }).toContain('cancelled by the user')
    expect(await toggle.getAttribute('aria-expanded')).toBe('true')
    expect(scaffold.ctx.jobs.get(jobId, agent.id).status).toBe('killed')

    const settled = await captureStableAria(page, SECTION, scaffold.workspaceCwd)
    await compareOrRefreshGolden(SETTLED_EXPECTED, settled, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)

  it('opens the section over the conversation beside the expanded right sidebar and closes it with Escape', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-background-job-right-sidebar'))
    const toggle = sessionPanelToggle(page)
    await page.getByRole('button', { name: 'Open right sidebar' }).click()
    const sidebar = page.locator('[data-rightbar-col]')
    // A toggle holds data-animating on the frame until its tracks settle.
    await expect.poll(() => sidebar.evaluate(column => column.parentElement?.hasAttribute('data-animating'))).toBe(false)
    const panel = await showSessionPanel(page)
    expect(await panel.getAttribute('data-session-panel')).toBe('overlay')
    const section = panel.locator(SECTION)
    const settledToggle = section.getByRole('button', { name: 'Finished 1', exact: true })
    await settledToggle.waitFor({ timeout: 10_000 })
    // The overlay stays in the conversation body, clear of the sidebar column.
    const [panelBox, sidebarBox] = await Promise.all([panel.boundingBox(), sidebar.boundingBox()])
    if (panelBox === null || sidebarBox === null) throw new Error('Session panel geometry is unavailable')
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(sidebarBox.x)
    // Every corner of the panel hit-tests to the panel itself; the inset clears its rounded corners.
    const covered = await panel.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const inset = 20
      const points: Array<[number, number]> = [
        [rect.left + inset, rect.top + inset], [rect.right - inset, rect.top + inset],
        [rect.left + inset, rect.bottom - inset], [rect.right - inset, rect.bottom - inset],
      ]
      return points.filter(([x, y]) => !element.contains(document.elementFromPoint(x, y)))
    })
    expect(covered).toEqual([])

    // Escape from a control in the section closes the overlay and returns focus to the toggle.
    await settledToggle.focus()
    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'detached', timeout: 10_000 })
    expect(await toggle.getAttribute('aria-expanded')).toBe('false')
    expect(await toggle.evaluate(node => node === document.activeElement)).toBe(true)
  }, 60_000)

  it('fits the section into the narrow overlay and closes it on a press outside', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-background-job-narrow-overlay'))
    const toggle = sessionPanelToggle(page)
    const viewport = page.viewportSize()!
    await page.getByRole('button', { name: 'Collapse right sidebar', exact: true }).click()
    await expect.poll(() => page.locator('[data-rightbar-col]')
      .evaluate(column => column.parentElement?.hasAttribute('data-animating'))).toBe(false)
    await page.getByRole('button', { name: 'Open right sidebar', exact: true }).waitFor()
    await toggle.focus()
    const original = await toggle.elementHandle()
    if (original === null) throw new Error('Session panel toggle is missing')
    try {
      await page.setViewportSize({ width: 390, height: 700 })
      expect(await original.evaluate(element => element.isConnected && element === document.activeElement)).toBe(true)
      const panel = await showSessionPanel(page)
      expect(await panel.getAttribute('data-session-panel')).toBe('overlay')
      const list = panel.locator(SECTION).getByRole('list')
      await list.getByRole('button', { name: 'Finished 1', exact: true }).waitFor()
      // The long command truncates inside its row instead of widening the panel past the viewport.
      const fit = await panel.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const rows = [...element.querySelectorAll<HTMLElement>('[data-jobs-section] li')]
        return {
          inViewport: rect.left >= 0 && rect.right <= innerWidth,
          panelOverflow: element.scrollWidth > element.clientWidth,
          rowOverflow: rows.some(row => row.getBoundingClientRect().right > rect.right),
        }
      })
      expect(fit).toEqual({ inViewport: true, panelOverflow: false, rowOverflow: false })
      // The overlay's inline margin is transcript: a press there is outside the panel.
      const box = await panel.boundingBox()
      if (box === null) throw new Error('Session panel geometry is unavailable')
      expect(box.x).toBeGreaterThan(4)
      await page.mouse.click(box.x / 2, box.y + box.height / 2)
      await panel.waitFor({ state: 'detached' })
      expect(await toggle.getAttribute('aria-expanded')).toBe('false')
    } finally {
      await page.setViewportSize(viewport)
      await original.dispose()
    }
  })

  it('marks a job that finished with a nonzero exit code with the warning dot', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-background-job-nonzero-exit'))
    await executeToolFixture(scaffold.ctx, {
      signal: new AbortController().signal,
      callId: brandString<ToolCallId>('background-job-list-nonzero-e2e'),
      name: 'bash',
      arguments: { command: 'exit 3', description: 'Exit with a failure', run_in_background: true },
      agent: scaffold.ctx.agents.list()[0]!,
    })
    const panel = await showSessionPanel(page)
    const row = panel.locator(SECTION).getByRole('listitem').filter({ hasText: 'exit 3' })
    await row.getByText('bash · exit code: 3', { exact: true }).waitFor({ timeout: 15_000 })
    expect(await row.locator('[data-state]').getAttribute('data-state')).toBe('warning')
  })

  it('holds back the rows past five in each group behind its fold control and keeps the choice while the panel is hidden', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-background-job-folds'))
    // Seven jobs on the suite's barrier file: they run until this case, or `afterAll`, releases it.
    for (let index = 0; index < 7; index++) {
      await executeToolFixture(scaffold.ctx, {
        signal: new AbortController().signal,
        callId: brandString<ToolCallId>(`background-job-list-fold-${String(index)}`),
        name: 'bash',
        arguments: { command: `: fold-${String(index)}; ${COMMAND}`, description: 'Hold a slot for the fold', run_in_background: true },
        agent,
      })
    }
    const section = (await showSessionPanel(page)).locator(SECTION)
    const rows = section.locator('[data-job-row]')
    const liveRows = section.locator('[data-job-row]:has([data-state="ongoing"])')
    const folds = section.locator('[data-session-panel-row="fold"]')
    const names = async (): Promise<(string | undefined)[]> => (await liveRows.allTextContents()).map(text => /fold-\d/.exec(text)?.[0])
    // The five jobs started last show, the most recent first, and the group's fold control follows them.
    await expect.poll(names, { timeout: 20_000 }).toEqual(['fold-6', 'fold-5', 'fold-4', 'fold-3', 'fold-2'])
    expect(await folds.allTextContents()).toEqual(['Show 2 more running'])
    expect(await section.locator('li:has([data-session-panel-row="fold"])').count()).toBe(1)
    // The control is one more row: the row height, its chevron under the state marks, its text under the commands.
    expect(await foldControlLayout(folds.first(), liveRows.first(), '[data-job-label]'))
      .toEqual({ heights: [28, 28], chevronOffset: 0, textOffset: 0, fontSize: '12px', expanded: 'false' })
    const more = section.getByRole('button', { name: 'Show 2 more running (running background jobs)', exact: true })
    await more.click()
    await expect.poll(names).toEqual(['fold-6', 'fold-5', 'fold-4', 'fold-3', 'fold-2', 'fold-1', 'fold-0'])
    const less = section.getByRole('button', { name: 'Show less (running background jobs)', exact: true })
    expect([await less.textContent(), await less.getAttribute('aria-expanded')]).toEqual(['Show less', 'true'])
    // The same button stays under the pointer's focus across the change.
    expect(await less.evaluate(element => element === document.activeElement)).toBe(true)
    // The choice is the Session's: hiding the panel unmounts the section, and showing it again lists every live row.
    await sessionPanelToggle(page).click()
    await section.getByRole('list').waitFor({ state: 'detached' })
    await showSessionPanel(page)
    await expect.poll(() => liveRows.count(), { timeout: 10_000 }).toBe(7)

    // Released, the jobs settle. With nothing live the settled group opens, with its five latest rows and its own control.
    await writeFile(join(scaffold.workspaceCwd, RELEASE), '')
    await expect.poll(() => liveRows.count(), { timeout: 30_000 }).toBe(0)
    const header = section.getByRole('button', { name: /^Finished \d+$/ })
    await expect.poll(async () => Number(/\d+/.exec(await header.textContent() ?? '')?.[0]), { timeout: 15_000 }).toBeGreaterThanOrEqual(7)
    const settled = Number(/\d+/.exec(await header.textContent() ?? '')?.[0])
    expect(await header.getAttribute('aria-expanded')).toBe('true')
    await expect.poll(() => rows.count()).toBe(5)
    expect(await folds.allTextContents()).toEqual([`Show ${String(settled - 5)} more finished`])
    expect(await foldControlLayout(folds.first(), rows.first(), '[data-job-label]'))
      .toEqual({ heights: [28, 28], chevronOffset: 0, textOffset: 0, fontSize: '12px', expanded: 'false' })
    await folds.first().getByRole('button').click()
    await expect.poll(() => rows.count()).toBe(settled)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['running.expected.md', 'settled.expected.md'])
  })
})
