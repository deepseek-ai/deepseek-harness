/** Background-job menu geometry over the normal Browser dock in the shipped Web composition. */
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
  assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, seedSession,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v3.jsonl', import.meta.url))
const EXPECTED_DIR = fileURLToPath(new URL('./expected/jobs-menu-layering', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = SessionId('jobs-menu-layering-web-e2e')
// The private scaffold cwd owns the barrier; the loop bounds an orphan's lifetime.
const RELEASE = '.jobs-menu-layering.release'
const COMMAND = `printf 'jobs-menu-%s\\n' output; for _ in $(seq 1 3000); do [ -e ${RELEASE} ] && break; sleep 0.2; done`

/** Measure actual overlap and hit testing; ARIA alone cannot expose clipping or stacking. */
function placement(page: Page) {
  return page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('ul[aria-label="Background jobs"]')
    const anchor = document.querySelector<HTMLElement>('button[aria-label="1 background job running"]')
    const frame = document.querySelector<HTMLElement>('[data-sidebar-browser-frame]')
    const dock = document.querySelector<HTMLElement>('[data-sidebar-right-panel][data-sidebar-right-open]')
    if (list === null || anchor === null || frame === null || dock === null) {
      throw new Error('job menu, trigger, or Browser dock is missing')
    }
    const menu = list.closest<HTMLElement>('[data-menu-material]') ?? list
    const box = menu.getBoundingClientRect()
    const trigger = anchor.getBoundingClientRect()
    const browser = frame.getBoundingClientRect()
    const left = Math.max(box.left, browser.left)
    const right = Math.min(box.right, browser.right)
    const top = Math.max(box.top, browser.top)
    const bottom = Math.min(box.bottom, browser.bottom)
    const overlapsBrowser = right - left > 8 && bottom - top > 8
    const aboveBrowser = overlapsBrowser && [0.25, 0.5, 0.75].every(x =>
      [0.25, 0.5, 0.75].every(y => menu.contains(document.elementFromPoint(
        left + (right - left) * x, top + (bottom - top) * y,
      ))))
    const expectedLeft = Math.min(Math.max(trigger.left, 12), innerWidth - box.width - 12)
    const expectedTop = Math.min(Math.max(trigger.bottom + 5, 12), innerHeight - box.height - 12)
    return {
      dockMode: dock.dataset.sidebarRightPanel,
      bodyMounted: menu.parentElement === document.body,
      fixed: getComputedStyle(menu).position === 'fixed',
      anchored: Math.abs(box.left - expectedLeft) <= 1 && Math.abs(box.top - expectedTop) <= 1,
      viewportBounded: box.left >= 11 && box.top >= 11
        && box.right <= innerWidth - 11 && box.bottom <= innerHeight - 11,
      overlapsBrowser,
      aboveBrowser,
    }
  })
}

describe.skipIf(MODE === 'record')('web e2e: jobs menu layering', () => {
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
      contentType: 'text/html', body: '<h1>Jobs menu browser fixture</h1>',
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
            throw new Error('jobs menu fixture did not settle after releasing its barrier')
          }
        }
      } catch (error) { failures.push(error) }
    }
    try { await browser?.close() } catch (error) { failures.push(error) }
    try { await scaffold?.close() } catch (error) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError(failures, 'jobs menu layering teardown failed')
  })

  it('keeps the list and live output above the Browser dock while anchored and dismissable', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-jobs-menu-layering'))
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
      callId: ToolCallId('jobs-menu-layering-e2e'),
      name: 'bash',
      arguments: { command: COMMAND, description: 'Emit output and hold the jobs menu fixture', run_in_background: true },
      agent,
    })
    const reported = started.content.map(block => block.type === 'text' ? block.text : '').join('')
    const matched = /\bbash-[0-9a-f]{16}\b/.exec(reported)
    if (matched === null) throw new Error(`background bash reported no job id: ${reported}`)
    const startedJobId = JobId(matched[0])
    jobId = startedJobId
    // Registration precedes shell startup; inspect its output before depending on a live row.
    await expect.poll(() => {
      const job = scaffold.ctx.jobs.get(startedJobId, agent.id)
      const output = scaffold.ctx.jobs.readAt(startedJobId, 0, agent.id).chunks.map(chunk => chunk.text).join('')
      return job.status !== 'running' || output.includes('jobs-menu-output')
    }, { timeout: 15_000 }).toBe(true)
    const readyJob = scaffold.ctx.jobs.get(startedJobId, agent.id)
    const readyOutput = scaffold.ctx.jobs.readAt(startedJobId, 0, agent.id).chunks.map(chunk => chunk.text).join('')
    expect(readyJob.status, `${readyJob.detail ?? ''}\n${readyOutput}`).toBe('running')

    await page.locator('[data-sidebar-right-expand]').click()
    const column = page.locator('[data-rightbar-col]')
    await column.locator('[data-sidebar-right-guide-entry="browser"]').click()
    const address = column.getByRole('textbox', { name: 'Enter an HTTP(S) address' })
    await address.fill('https://browser.test/jobs-menu')
    await address.press('Enter')
    await page.frameLocator('[data-sidebar-browser-frame]')
      .getByRole('heading', { name: 'Jobs menu browser fixture' }).waitFor()

    const trigger = page.getByRole('button', { name: '1 background job running', exact: true })
    await trigger.waitFor({ timeout: 15_000 })
    await trigger.focus()
    await page.keyboard.press('Enter')
    const list = page.getByRole('list', { name: 'Background jobs' })
    await list.waitFor()
    await page.keyboard.press('Tab')
    expect(await list.getByRole('button', { name: /Show live output/ })
      .evaluate(element => element === document.activeElement)).toBe(true)
    const expectedPlacement = {
      dockMode: 'push', bodyMounted: true, fixed: true, anchored: true,
      viewportBounded: true, overlapsBrowser: true, aboveBrowser: true,
    }
    await expect.poll(() => placement(page)).toEqual(expectedPlacement)
    const collapsed = await placement(page)

    await list.getByRole('button', { name: /Show live output/ }).click()
    await list.getByText('jobs-menu-output', { exact: true }).waitFor({ timeout: 15_000 })
    await expect.poll(() => placement(page)).toEqual(expectedPlacement)
    const expanded = await placement(page)

    await page.setViewportSize({ width: 1280, height: 760 })
    await expect.poll(() => placement(page)).toEqual(expectedPlacement)
    const resized = await placement(page)
    await list.getByRole('button', { name: /Hide live output/ }).focus()
    await page.keyboard.press('Escape')
    await list.waitFor({ state: 'detached' })
    const escapeRestoresFocus = await trigger.evaluate(node => node === document.activeElement)
    expect(escapeRestoresFocus).toBe(true)

    await trigger.click()
    await list.waitFor()
    await address.click()
    await list.waitFor({ state: 'detached' })
    const outsideDismisses = await trigger.getAttribute('aria-expanded') === 'false'
    expect(outsideDismisses).toBe(true)
    expect(scaffold.ctx.jobs.get(jobId, agent.id).status).toBe('running')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])

    await mkdir(EXPECTED_DIR, { recursive: true })
    await compareOrRefreshGolden(join(EXPECTED_DIR, 'geometry.expected.md'), [
      '# Background jobs above the Browser dock', '',
      '```json',
      JSON.stringify({ collapsed, expanded, resized, escapeRestoresFocus, outsideDismisses }, null, 2),
      '```',
    ].join('\n'), MODE)
    await assertFixtureInventory(EXPECTED_DIR, ['geometry.expected.md'])
  })
})
