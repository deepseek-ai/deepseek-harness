/** Session panel geometry with an expanded background job beside the normal Browser dock in the shipped Web composition. */
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
  assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, seedSession,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot, sessionPanelToggle, showSessionPanel } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v3.jsonl', import.meta.url))
const EXPECTED_DIR = fileURLToPath(new URL('./expected/jobs-panel-layering', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = brandString<SessionId>('jobs-panel-layering-web-e2e')
// The private scaffold cwd owns the barrier; the loop bounds an orphan's lifetime.
const RELEASE = '.jobs-panel-layering.release'
const COMMAND = `printf 'jobs-panel-%s\\n' output; for _ in $(seq 1 3000); do [ -e ${RELEASE} ] && break; sleep 0.2; done`

/** Measure actual overlap and hit testing; ARIA alone cannot expose clipping or stacking. */
function placement(page: Page) {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('[data-session-panel]')
    const section = document.querySelector<HTMLElement>('[data-session-panel-section="background-jobs"]')
    const frame = document.querySelector<HTMLElement>('[data-sidebar-browser-frame]')
    const dock = document.querySelector<HTMLElement>('[data-sidebar-right-panel][data-sidebar-right-open]')
    if (panel === null || section === null || frame === null || dock === null) {
      throw new Error('Session panel, jobs section, or Browser dock is missing')
    }
    const body = panel.closest<HTMLElement>('[data-conversation-content]')
    const seat = body?.querySelector<HTMLElement>('[data-composer-seat]') ?? null
    if (body === null || seat === null) throw new Error('conversation body or composer seat is missing')
    const box = panel.getBoundingClientRect()
    const host = body.getBoundingClientRect()
    const browser = frame.getBoundingClientRect()
    const composer = seat.getBoundingClientRect()
    const sectionBox = section.getBoundingClientRect()
    return {
      dockMode: dock.dataset.sidebarRightPanel,
      presentation: panel.dataset.sessionPanel,
      insideBody: box.left >= host.left && box.right <= host.right && box.top >= host.top,
      clearOfBrowser: box.right <= browser.left,
      clearOfComposer: box.bottom <= composer.top,
      viewportBounded: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
      sectionShown: sectionBox.height > 0,
      onTop: [0.25, 0.5, 0.75].every(x => [0.25, 0.5, 0.75].every(y => panel.contains(document.elementFromPoint(
        box.left + box.width * x, box.top + box.height * y,
      )))),
    }
  })
}

describe.skipIf(MODE === 'record')('web e2e: jobs panel layering', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let agent: Agent
  let jobId: JobId | undefined

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: fileURLToPath(new URL('./sidebar-browser.overlay.yml', import.meta.url)),
    })
    await seedSession(scaffold, await readFile(FIXTURE, 'utf8'), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.route('https://browser.test/**', async route => route.fulfill({
      contentType: 'text/html', body: '<h1>Jobs panel browser fixture</h1>',
    }))
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  })

  afterAll(async () => {
    const failures: unknown[] = []
    if (scaffold !== undefined) {
      try {
        await writeFile(join(scaffold.workspaceCwd, RELEASE), '')
        if (jobId !== undefined) {
          const settled = await scaffold.ctx.jobs.wait(jobId, 15_000, agent.id)
          if (settled.status === 'running' || settled.status === 'stopping') {
            throw new Error('jobs panel fixture did not settle after releasing its barrier')
          }
        }
      } catch (error) { failures.push(error) }
    }
    try { await browser?.close() } catch (error) { failures.push(error) }
    try { await scaffold?.close() } catch (error) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError(failures, 'jobs panel layering teardown failed')
  })

  it('keeps the section and its live output in the conversation body beside the Browser dock and dismissable', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-jobs-panel-layering'))
    const initialViewport = page.viewportSize()!
    const session = page.locator(`[data-row-key="session:${SEED_ID}"]`)
    await expect.poll(async () => {
      if (await session.isVisible()) return true
      const group = page.locator('[role="treeitem"][aria-expanded]').first()
      if (await group.count() > 0 && await group.getAttribute('aria-expanded') === 'false') await group.click()
      return session.isVisible()
    }, { timeout: 15_000 }).toBe(true)
    await session.click()
    await expect.poll(() => scaffold.ctx.agents.get(SEED_ID), { timeout: 30_000 }).toBeDefined()
    const opened = scaffold.ctx.agents.get(SEED_ID)
    if (opened === undefined) throw new Error('opened session has no live Agent')
    agent = opened
    const started = await executeToolFixture(scaffold.ctx, {
      signal: new AbortController().signal,
      callId: brandString<ToolCallId>('jobs-panel-layering-e2e'),
      name: 'bash',
      arguments: { command: COMMAND, description: 'Emit output and hold the jobs panel fixture', run_in_background: true },
      agent,
    })
    const reported = started.content.map(block => block.type === 'text' ? block.text : '').join('')
    const matched = /\bbash-[0-9a-f]{16}\b/.exec(reported)
    if (matched === null) throw new Error(`background bash reported no job id: ${reported}`)
    const startedJobId = brandString<JobId>(matched[0])
    jobId = startedJobId
    // Registration precedes shell startup; inspect its output before depending on a live row.
    await expect.poll(() => {
      const job = scaffold.ctx.jobs.get(startedJobId, agent.id)
      const output = scaffold.ctx.jobs.readAt(startedJobId, 0, agent.id).chunks.map(chunk => chunk.text).join('')
      return job.status !== 'running' || output.includes('jobs-panel-output')
    }, { timeout: 15_000 }).toBe(true)
    const readyJob = scaffold.ctx.jobs.get(startedJobId, agent.id)
    const readyOutput = scaffold.ctx.jobs.readAt(startedJobId, 0, agent.id).chunks.map(chunk => chunk.text).join('')
    expect(readyJob.status, `${readyJob.detail ?? ''}\n${readyOutput}`).toBe('running')

    await page.locator('[data-sidebar-right-expand]').click()
    const column = page.locator('[data-rightbar-col]')
    await column.locator('[data-sidebar-right-guide-entry="browser"]').click()
    const address = column.getByRole('textbox', { name: 'Enter an HTTP(S) address' })
    await address.fill('https://browser.test/jobs-panel')
    await address.press('Enter')
    await page.frameLocator('[data-sidebar-browser-frame]')
      .getByRole('heading', { name: 'Jobs panel browser fixture' }).waitFor()

    const toggle = sessionPanelToggle(page)
    await toggle.focus()
    await page.keyboard.press('Enter')
    const panel = page.locator('[data-session-panel]')
    await panel.waitFor()
    const list = panel.locator('[data-session-panel-section="background-jobs"]').getByRole('list')
    await list.getByRole('button', { name: /Show live output/ }).waitFor({ timeout: 15_000 })
    const expectedPlacement = {
      dockMode: 'push', presentation: 'overlay', insideBody: true, clearOfBrowser: true,
      clearOfComposer: true, viewportBounded: true, sectionShown: true, onTop: true,
    }
    await expect.poll(() => placement(page)).toEqual(expectedPlacement)
    const collapsed = await placement(page)

    await list.getByRole('button', { name: /Show live output/ }).click()
    await list.getByText('jobs-panel-output', { exact: true }).waitFor({ timeout: 15_000 })
    await expect.poll(() => placement(page)).toEqual(expectedPlacement)
    const expanded = await placement(page)

    await page.setViewportSize({ width: 1280, height: 760 })
    await showSessionPanel(page)
    await expect.poll(() => placement(page)).toEqual(expectedPlacement)
    const resized = await placement(page)
    await list.getByRole('button', { name: /Hide live output/ }).focus()
    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'detached' })
    const escapeRestoresFocus = await toggle.evaluate(node => node === document.activeElement)
    expect(escapeRestoresFocus).toBe(true)

    await showSessionPanel(page)
    await address.click()
    await panel.waitFor({ state: 'detached' })
    const outsideDismisses = await toggle.getAttribute('aria-expanded') === 'false'
    expect(outsideDismisses).toBe(true)
    expect(await address.evaluate(element => element === document.activeElement)).toBe(true)
    await page.setViewportSize(initialViewport)
    expect(scaffold.ctx.jobs.get(jobId, agent.id).status).toBe('running')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])

    await mkdir(EXPECTED_DIR, { recursive: true })
    await compareOrRefreshGolden(join(EXPECTED_DIR, 'geometry.expected.md'), [
      '# Background jobs beside the Browser dock', '',
      '```json',
      JSON.stringify({ collapsed, expanded, resized, escapeRestoresFocus, outsideDismisses }, null, 2),
      '```',
    ].join('\n'), MODE)
    await assertFixtureInventory(EXPECTED_DIR, ['geometry.expected.md'])
  })
})
