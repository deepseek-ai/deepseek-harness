import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
// Session-header background jobs driven by a real `ctx.jobs` entry. No model
// call is involved.
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

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v3.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/background-job-list', import.meta.url))
const RUNNING_EXPECTED = join(SNAPSHOT_DIR, 'running.expected.md')
const SETTLED_EXPECTED = join(SNAPSHOT_DIR, 'settled.expected.md')
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
    agent = await liveAgent(scaffold, SessionId(SEED_ID))
  }, 120_000)

  afterAll(async () => {
    if (scaffold !== undefined) await writeFile(join(scaffold.workspaceCwd, RELEASE), '')
    await browser?.close()
    await scaffold?.close()
  })

  it('shows a running background job in the header without a refresh, then kills it from the two-press stop control', async () => {
    let phase = 'running'
    onTestFailed(() => saveFailureShot(page, `web-e2e-background-job-${phase}`))
    // Polling for zero would pass at t=0 before delivery and prove nothing.
    const trigger = page.getByRole('button', { name: '1 background job', exact: true })
    expect(await trigger.count()).toBe(0)

    const started = await executeToolFixture(scaffold.ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('background-job-list-e2e'),
      name: 'bash',
      arguments: { command: COMMAND, description: 'Hold a background slot open', run_in_background: true },
      agent,
    })
    const reported = started.content.map(block => block.type === 'text' ? block.text : '').join('')
    const matched = /\bbash-[0-9a-f]{16}\b/.exec(reported)
    if (matched === null) throw new Error(`background bash reported no job id: ${reported}`)
    const jobId = JobId(matched[0])

    await trigger.waitFor({ timeout: 15_000 })
    expect(await trigger.locator('[data-state="ongoing"]').count()).toBe(1)
    expect(await trigger.locator('[data-icon="dsw-icon-chevron-down-outline-regular"]').count()).toBe(0)
    await trigger.hover()
    const list = page.getByRole('list', { name: 'Background jobs' })
    const row = list.getByRole('listitem').first()
    await row.waitFor({ timeout: 10_000 })
    await expect.poll(() => row.textContent()).toContain(COMMAND)
    expect(await trigger.getAttribute('aria-expanded')).toBe('true')
    await row.hover()
    await row.getByRole('button', { name: /Show live output/ }).focus()
    await page.mouse.move(2, 2)
    // Focusing a menu control pins it beyond the 120ms hover-leave deadline.
    await page.waitForTimeout(180)
    expect(await list.count()).toBe(1)
    await trigger.click()
    await list.waitFor({ state: 'detached' })
    await trigger.click()
    await list.waitFor()
    await page.mouse.move(2, 2)
    await page.waitForTimeout(180)
    expect(await list.count()).toBe(1)
    expect(await trigger.getAttribute('aria-label')).toBe('1 background job')

    const running = await captureStableAria(page, '[class*="menu"]', scaffold.workspaceCwd, { runningJobs: 'keep' })
    await compareOrRefreshGolden(RUNNING_EXPECTED, running, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])

    phase = 'settled'
    // The whole human path: arm, confirm, job.kill, registry kill, jobs
    // frames flipping the row — no registry call from the test.
    const stop = page.locator('[data-kill-state]')
    await stop.waitFor({ timeout: 10_000 })
    await stop.click()
    await expect.poll(() => stop.getAttribute('data-kill-state')).toBe('armed')
    await stop.click()

    expect(await trigger.getAttribute('aria-label')).toBe('1 background job')
    // The unclaimed report's reason lands in the settled row's detail.
    await expect.poll(
      () => page.getByRole('list', { name: 'Background jobs' }).textContent(),
      { timeout: 15_000 },
    ).toContain('cancelled by the user')
    expect(scaffold.ctx.jobs.get(jobId, agent.id).status).toBe('killed')

    const settled = await captureStableAria(page, '[class*="menu"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(SETTLED_EXPECTED, settled, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)

  it('keeps the open list above the expanded right sidebar and in the header Tab order', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-background-job-right-sidebar'))
    const trigger = page.getByRole('button', { name: '1 background job', exact: true })
    if (await trigger.getAttribute('aria-expanded') === 'true') await trigger.click()
    await page.getByRole('button', { name: 'Open right sidebar' }).click()
    const sidebar = page.locator('[data-rightbar-col]')
    // A toggle holds data-animating on the frame until its tracks settle.
    await expect.poll(() => sidebar.evaluate(column => column.parentElement?.hasAttribute('data-animating'))).toBe(false)
    await trigger.click()
    const list = page.getByRole('list', { name: 'Background jobs' })
    await list.waitFor({ timeout: 10_000 })
    // The list crosses into the sidebar column, so the hit test below covers it.
    const [menuBox, sidebarBox] = await Promise.all([list.boundingBox(), sidebar.boundingBox()])
    if (menuBox === null || sidebarBox === null) throw new Error('job list geometry is unavailable')
    expect(menuBox.x + menuBox.width).toBeGreaterThan(sidebarBox.x)
    // Every corner of the list hit-tests to the list itself; the inset clears its rounded corners.
    const covered = await list.evaluate((menu) => {
      const rect = menu.getBoundingClientRect()
      const inset = 20
      const points: Array<[number, number]> = [
        [rect.left + inset, rect.top + inset], [rect.right - inset, rect.top + inset],
        [rect.left + inset, rect.bottom - inset], [rect.right - inset, rect.bottom - inset],
      ]
      return points.filter(([x, y]) => !menu.contains(document.elementFromPoint(x, y)))
    })
    expect(covered).toEqual([])

    // Keyboard order matches the in-place list: the trigger leads into the
    // list, and Tab off its last control reaches the control after the trigger.
    const after = await trigger.evaluate((node) => {
      const all = [...document.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])')]
      const outside = all.filter(el => el.closest('[aria-label="Background jobs"]') === null && el.tabIndex >= 0)
      return outside[outside.indexOf(node as HTMLElement) + 1]?.outerHTML.slice(0, 120)
    })
    expect(after).toMatch(/^<button/)
    await trigger.focus()
    await page.keyboard.press('Tab')
    expect(await list.evaluate(menu => menu.contains(document.activeElement))).toBe(true)
    const controls = await list.evaluate(menu => menu.querySelectorAll('button:not(:disabled)').length)
    for (let i = 1; i < controls; i += 1) await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))).toBe(after)
    await trigger.focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Escape')
    await list.waitFor({ state: 'detached', timeout: 10_000 })
    expect(await trigger.evaluate(node => node === document.activeElement)).toBe(true)
  }, 60_000)

  it('keeps the compact Layers trigger focused and opens jobs only on click or keyboard', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-background-job-compact-trigger'))
    const trigger = page.getByRole('button', { name: '1 background job', exact: true })
    const list = page.getByRole('list', { name: 'Background jobs' })
    const count = trigger.locator('[data-job-count]')
    const viewport = page.viewportSize()!
    await page.getByRole('button', { name: 'Collapse right sidebar', exact: true }).click()
    await expect.poll(() => page.locator('[data-rightbar-col]')
      .evaluate(column => column.parentElement?.hasAttribute('data-animating'))).toBe(false)
    await page.getByRole('button', { name: 'Open right sidebar', exact: true }).waitFor()
    await page.mouse.move(2, 2)
    expect(await count.isVisible()).toBe(true)
    expect(await trigger.locator('[data-icon="dsw-icon-layers-outline-regular"]').count()).toBe(1)
    expect(await trigger.locator('svg').count()).toBe(1)
    expect(await trigger.locator('svg').evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return [bounds.width, bounds.height]
    })).toEqual([14, 14])
    await trigger.focus()
    const original = await trigger.elementHandle()
    if (original === null) throw new Error('Background jobs trigger is missing')
    try {
      await page.setViewportSize({ width: 390, height: 700 })
      await expect.poll(() => count.evaluate(element => getComputedStyle(element).display)).toBe('none')
      expect(await original.evaluate(element => element.isConnected && element === document.activeElement)).toBe(true)
      const expandSidebar = page.locator('[data-sidebar-right-expand]')
      const compactStyles = await Promise.all([trigger, expandSidebar].map(control => control.evaluate((element) => {
        const style = getComputedStyle(element)
        const bounds = element.getBoundingClientRect()
        const icon = element.querySelector('svg')!.getBoundingClientRect()
        return { width: bounds.width, height: bounds.height, padding: style.padding, radius: style.borderRadius,
          color: style.color, iconWidth: icon.width, iconHeight: icon.height }
      })))
      expect(compactStyles[0]).toEqual(compactStyles[1])
      expect(compactStyles[0]).toMatchObject({ width: 28, height: 28, padding: '0px', iconWidth: 15, iconHeight: 15 })
      expect(await trigger.evaluate(element => getComputedStyle(element.closest('[data-slot="conversation.session.header.actions"]')!.parentElement!).gap)).toBe('8px')
      await expandSidebar.hover()
      const expandHover = await expandSidebar.evaluate((element) => {
        const style = getComputedStyle(element)
        return { background: style.backgroundColor, color: style.color }
      })
      await expect.poll(() => trigger.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        return element.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2))
      })).toBe(true)
      await trigger.hover()
      expect(await trigger.evaluate((element) => {
        const style = getComputedStyle(element)
        return { background: style.backgroundColor, color: style.color }
      })).toEqual(expandHover)
      expect(expandHover.background).not.toBe('rgba(0, 0, 0, 0)')
      // Compact hover stays closed beyond the wide trigger's 150ms open deadline.
      await page.waitForTimeout(200)
      expect(await list.count()).toBe(0)
      await trigger.click()
      await list.waitFor()
      await list.getByRole('button', { name: 'Finished 1', exact: true }).waitFor()
      await trigger.click()
      await list.waitFor({ state: 'detached' })
      await trigger.press('ArrowDown')
      await list.waitFor()
      expect(await list.getByRole('button').first().evaluate(element => element === document.activeElement)).toBe(true)
      await page.mouse.move(2, 2)
      // Keyboard activation remains pinned after leaving both trigger and menu.
      await page.waitForTimeout(180)
      expect(await list.count()).toBe(1)
      await page.mouse.click(2, 2)
      await list.waitFor({ state: 'detached' })
      expect(await trigger.getAttribute('aria-expanded')).toBe('false')
    } finally {
      await page.keyboard.press('Escape')
      await page.setViewportSize(viewport)
      await original.dispose()
    }
  })

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['running.expected.md', 'settled.expected.md'])
  })
})
