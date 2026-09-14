// Recorded-session Sidebar geometry and per-Session view state through the shipped browser composition.
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, compareOrRefreshGolden,
  fixtureUserPrompts, launchWebScaffold, seedSession, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/details-session-lifecycle', import.meta.url))
const HANDLES_EXPECTED = join(SNAPSHOT_DIR, 'handles.expected.md')
const SIDEBAR_EXPECTED = join(SNAPSHOT_DIR, 'sidebar.expected.md')
const SHOT_DIR = fileURLToPath(new URL('../../../.artifacts/screenshots/0907-sidebar-rules', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/lifecycle-chrome/session.v3.jsonl', import.meta.url))
const SEED_FIXTURE = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const PROMPT = 'Reply with the single word LIGHTHOUSE and stop.'
const MODE = webSnapshotMode()

/** Last AppFrame grid track in CSS pixels. */
async function detailsTrack(page: Page): Promise<number> {
  return await appFrame(page).evaluate((element) => {
    const tracks = getComputedStyle(element).gridTemplateColumns.split(' ')
    return Number.parseFloat(tracks.at(-1) ?? 'NaN')
  })
}

/** First AppFrame grid track in CSS pixels. */
async function sidebarTrack(page: Page): Promise<number> {
  return await appFrame(page).evaluate((element) => {
    const tracks = getComputedStyle(element).gridTemplateColumns.split(' ')
    return Number.parseFloat(tracks[0] ?? 'NaN')
  })
}

/** AppFrame is the only product element with an inline grid track template. */
function appFrame(page: Page) {
  return page.locator('[style*="grid-template-columns"]').first()
}

/** Render the two column-resize handles without platform-dependent coordinates. */
async function handleSnapshot(page: Page): Promise<string> {
  const handles = await page.locator('[class*="handle"]').evaluateAll(elements =>
    elements.map(element => ({
      side: element.getAttribute('data-side'),
      cursor: getComputedStyle(element).cursor,
      pillGenerated: getComputedStyle(element, '::after').content !== 'none',
    })))
  return [
    '# AppFrame drag handles',
    '',
    ...handles.flatMap(handle => [
      `## ${handle.side}`,
      '',
      '- hit strip present: true',
      `- cursor: ${handle.cursor}`,
      `- pill generated: ${String(handle.pillGenerated)}`,
      '',
    ]),
  ].join('\n').trimEnd()
}

/** Rendered frame tracks, rounded only to remove browser subpixel allocation. */
async function columns(page: Page): Promise<number[]> {
  return await appFrame(page).evaluate(element =>
    getComputedStyle(element).gridTemplateColumns.split(' ').map(value => Math.round(Number.parseFloat(value))))
}

/** Tab order and selection inside each docked pane, independent of generated ids. */
async function paneSnapshot(page: Page) {
  return await page.locator('[data-rightbar-col] [data-dockkit-pane]').evaluateAll(panes => panes.map(pane => ({
    active: pane.hasAttribute('data-dockkit-pane-active'),
    tabs: [...pane.querySelectorAll('[data-dockkit-tab]')].map(tab => ({
      title: tab.querySelector('[data-dockkit-tab-title]')?.textContent?.trim(),
      selected: tab.getAttribute('aria-selected') === 'true',
    })),
  })))
}

/** Product-visible geometry, pane state, and expanded Files directories at a settled checkpoint. */
async function sidebarSnapshot(page: Page) {
  const geometry = await appFrame(page).evaluate((frame) => {
    const panel = frame.querySelector<HTMLElement>('[data-sidebar-right-panel]')
    if (panel === null) throw new Error('Sidebar panel is not mounted')
    const expanded = panel.hasAttribute('data-sidebar-right-open')
    const rect = panel.getBoundingClientRect()
    const style = getComputedStyle(panel)
    const handle = frame.querySelector('[data-side="rightbar"]')
    return {
      viewport: [window.innerWidth, window.innerHeight],
      columns: getComputedStyle(frame).gridTemplateColumns.split(' ').map(value => Math.round(Number.parseFloat(value))),
      columnTransition: getComputedStyle(frame).transitionProperty,
      expanded,
      mode: panel.getAttribute('data-sidebar-right-panel'),
      panelContentWidth: expanded ? Math.round(Number.parseFloat(style.width)) : 0,
      panelOuterWidth: expanded ? Math.round(rect.width) : 0,
      coversViewport: expanded && rect.x === 0 && rect.y === 0
        && Math.round(rect.width) === window.innerWidth && Math.round(rect.height) === window.innerHeight,
      resizeHandleWidth: handle === null ? 0 : Math.round(handle.getBoundingClientRect().width),
      expandedDirectories: [...panel.querySelectorAll('[data-files-entry="directory"] > button[aria-expanded="true"]')]
        .map(button => button.textContent?.trim()),
    }
  })
  return { ...geometry, panes: await paneSnapshot(page) }
}

/** The native pointer gesture used for the left column's width preference. */
async function dragSidebar(page: Page, target: number): Promise<void> {
  const grip = await page.locator('[data-side="sidebar"]').boundingBox()
  if (grip === null) throw new Error('Sidebar resize handle is not rendered')
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  try {
    await page.mouse.move(target, grip.y + grip.height / 2, { steps: 6 })
  } finally {
    await page.mouse.up()
  }
  await expect.poll(() => sidebarTrack(page)).toBe(target)
}

describe.skipIf(MODE === 'record')('web e2e: details panel follows the current Session lifecycle', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    const fixture = await readFile(FIXTURE, 'utf8')
    expect(fixtureUserPrompts(fixture)).toEqual([PROMPT])
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE, paceMs: 5, compareReplaySession: false })
    await seedSession(scaffold, await readFile(SEED_FIXTURE, 'utf8'), 'details-session-lifecycle-seed')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await appFrame(page).waitFor({ timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      await scaffold?.close()
    }
  })

  it('retains each Session sidebar and applies normal, fullscreen, and capacity-close geometry', async () => {
    onTestFailed(async () => {
      await mkdir(SHOT_DIR, { recursive: true })
      await saveFailureShot(page, `screenshots/0907-sidebar-rules/details-session-lifecycle-${MODE}-${process.pid}`)
    })
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(PROMPT)
    await input.press('Enter')
    await settled
    await page.getByText('LIGHTHOUSE', { exact: true }).waitFor({ timeout: 15_000 })

    await expect.poll(() => detailsTrack(page), { timeout: 5_000 }).toBe(0)
    expect(await page.getByText('Details', { exact: true }).isVisible()).toBe(false)
    await compareOrRefreshGolden(HANDLES_EXPECTED, await handleSnapshot(page), MODE)

    const sidebarBefore = await sidebarTrack(page)
    const sidebarHandle = page.locator('[data-side="sidebar"]')
    const sidebarBox = await sidebarHandle.boundingBox()
    expect(sidebarBox).not.toBeNull()
    const dragStartX = sidebarBox!.x + sidebarBox!.width / 2
    await page.mouse.move(dragStartX, sidebarBox!.y + 200)
    await page.mouse.down()
    await page.mouse.move(dragStartX + 70, sidebarBox!.y + 200, { steps: 6 })
    await page.mouse.up()
    await expect.poll(() => sidebarTrack(page), { timeout: 5_000 }).toBe(sidebarBefore + 70)

    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await appFrame(page).waitFor({ timeout: 30_000 })
    await page.getByText('LIGHTHOUSE', { exact: true }).waitFor({ timeout: 15_000 })
    await expect.poll(() => detailsTrack(page), { timeout: 5_000 }).toBe(0)
    expect(await page.getByText('Details', { exact: true }).isVisible()).toBe(false)

    await page.getByRole('button', { name: /^(?:New session|新.*会话)$/ }).last().click()
    await page.getByText('Into the Unknown', { exact: false }).waitFor({ timeout: 15_000 })
    await expect.poll(() => detailsTrack(page), { timeout: 5_000 }).toBe(0)
    expect(await page.getByText('Details', { exact: true }).isVisible()).toBe(false)

    const original = page.locator('[role="treeitem"][aria-selected]').filter({ hasText: 'Reply with the single word' }).first()
    await original.click()
    await page.getByText('LIGHTHOUSE', { exact: true }).waitFor({ timeout: 15_000 })
    await expect.poll(() => detailsTrack(page), { timeout: 5_000 }).toBe(0)
    expect(await page.getByText('Details', { exact: true }).isVisible()).toBe(false)

    const ungrouped = page.getByText('Ungrouped', { exact: true })
    const ungroupedRow = ungrouped.locator('..').locator('..')
    if (await ungroupedRow.getAttribute('aria-expanded') !== 'true') await ungrouped.click()
    await expect.poll(() => ungroupedRow.getAttribute('aria-expanded')).toBe('true')
    // A cold Session's row may still show its cwd until its history loads.
    const seeded = ungroupedRow.locator('..').locator('[role="treeitem"][aria-selected]')
    await expect.poll(() => seeded.count()).toBe(1)
    await seeded.click()
    await page.getByText('DONE', { exact: true }).waitFor({ timeout: 15_000 })
    await expect.poll(() => detailsTrack(page), { timeout: 5_000 }).toBe(0)

    const viewport = page.viewportSize()
    if (viewport === null) throw new Error('expected a fixed viewport')
    const column = page.locator('[data-rightbar-col]')
    const panel = column.locator('[data-sidebar-right-panel]')
    const panes = column.locator('[data-dockkit-pane]')
    const normalWidth = Math.round(viewport.width * 0.45)
    const normalColumns = [280, viewport.width - 280 - normalWidth, normalWidth]
    const checkpoints: string[] = ['# Recorded-session Sidebar states']
    const checkpoint = async (label: string): Promise<void> => {
      checkpoints.push(`## ${label}\n\n\`\`\`json\n${JSON.stringify(await sidebarSnapshot(page), null, 2)}\n\`\`\``)
    }
    const select = async (row: Locator, reply: string): Promise<void> => {
      await row.click()
      await expect.poll(() => row.getAttribute('aria-selected')).toBe('true')
      await page.getByText(reply, { exact: true }).waitFor({ timeout: 15_000 })
    }
    const open = async (): Promise<void> => {
      await page.locator('[data-sidebar-right-expand]').click()
      await expect.poll(() => column.locator('[data-sidebar-right-open]').count()).toBe(1)
      await expect.poll(() => columns(page)).toEqual(normalColumns)
      // The panel's slide completes independently of the frame's grid tracks.
      await expect.poll(() => panel.evaluate(element => getComputedStyle(element).transform))
        .toBe('none')
    }
    const close = async (): Promise<void> => {
      await column.locator('[data-sidebar-right-toggle]').click()
      await expect.poll(() => column.locator('[data-sidebar-right-open]').count()).toBe(0)
      // Closing publishes state before the frame's grid transition finishes.
      await appFrame(page).evaluate(async (frame) => {
        await Promise.allSettled(frame.getAnimations().map(animation => animation.finished))
      })
      await expect.poll(() => detailsTrack(page)).toBe(0)
      await panel.waitFor({ state: 'hidden' })
    }

    await select(original, 'LIGHTHOUSE')
    await open()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    // The content-box panel adds its one rendered border pixel outside the
    // CSS width assigned by the grid solver.
    await expect.poll(() => sidebarSnapshot(page), { timeout: 5_000 })
      .toMatchObject({ mode: 'push', panelContentWidth: normalWidth, panelOuterWidth: normalWidth + 1, resizeHandleWidth: 8 })
    await expect.poll(async () => ({
      filesVisible: await column.locator('[data-files-state="tree"]').isVisible(),
      errors: tripwire.pageErrors,
    })).toEqual({ filesVisible: true, errors: [] })
    await column.locator('[data-dockkit-add-tab]').click()
    const split = column.locator('[data-dockkit-split-button]').first()
    await expect.poll(() => split.isDisabled()).toBe(false)
    await split.click()
    await expect.poll(() => panes.count()).toBe(2)
    await panes.last().locator('[data-sidebar-right-guide-entry="files"]').click()
    await panes.first().locator('[data-dockkit-tab]').filter({ hasText: 'Files' }).click()
    await expect.poll(() => panes.first().locator('[data-files-state="tree"]').count()).toBe(1)
    const retainedA = await paneSnapshot(page)
    expect(retainedA.map(pane => pane.tabs.map(tab => tab.title))).toEqual([['Files', 'Start'], ['Files']])
    await checkpoint('A normal: two panes')

    await column.locator('[data-sidebar-right-mode="fullscreen"]').click()
    await expect.poll(() => panel.boundingBox()).toEqual({ x: 0, y: 0, ...viewport })
    expect(await columns(page)).toEqual(normalColumns)
    expect(await sidebarSnapshot(page)).toMatchObject({ mode: 'fullscreen', resizeHandleWidth: 0, coversViewport: true })
    expect(await paneSnapshot(page)).toEqual(retainedA)
    await checkpoint('A manual fullscreen: underlying columns retained')

    // Closing the fullscreen panel exposes Session navigation without changing
    // its manual mode; reopening after the round trip must restore that mode.
    await close()
    expect((await sidebarSnapshot(page)).columnTransition).toBe('none')
    await checkpoint('A closed with manual fullscreen retained')
    await select(seeded, 'DONE')
    await expect.poll(() => detailsTrack(page)).toBe(0)
    await open()
    expect(await panel.getAttribute('data-sidebar-right-panel')).toBe('push')
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ timeout: 15_000 })
    const workspaceDirectory = column.locator('[data-files-entry="directory"] > button').filter({ hasText: /^workspace$/ })
    await workspaceDirectory.waitFor({ timeout: 15_000 })
    await workspaceDirectory.click()
    await expect.poll(() => workspaceDirectory.getAttribute('aria-expanded')).toBe('true')
    // The child listing crosses the same Remote as the root listing above.
    await column.locator('[data-files-row="loading"]').waitFor({ state: 'hidden', timeout: 15_000 })
    expect(await column.locator('[data-files-row="failed"]').count()).toBe(0)
    const retainedB = await paneSnapshot(page)
    expect(retainedB.map(pane => pane.tabs.map(tab => tab.title))).toEqual([['Files']])
    await close()
    await checkpoint('B closed: independent pane and expanded workspace directory')

    await select(original, 'LIGHTHOUSE')
    await expect.poll(() => detailsTrack(page)).toBe(0)
    expect(await panel.getAttribute('data-sidebar-right-panel')).toBe('fullscreen')
    expect(await paneSnapshot(page)).toEqual(retainedA)
    await open()
    await expect.poll(() => panel.boundingBox()).toEqual({ x: 0, y: 0, ...viewport })
    expect(await paneSnapshot(page)).toEqual(retainedA)
    await checkpoint('A restored: manual fullscreen, tabs, and panes')
    await column.locator('[data-sidebar-right-mode="push"]').click()
    await expect.poll(async () => (await sidebarSnapshot(page)).panelContentWidth, { timeout: 5_000 }).toBe(normalWidth)

    await select(seeded, 'DONE')
    await expect.poll(() => detailsTrack(page)).toBe(0)
    expect(await panel.getAttribute('data-sidebar-right-panel')).toBe('push')
    expect(await paneSnapshot(page)).toEqual(retainedB)
    await open()
    await expect.poll(() => workspaceDirectory.getAttribute('aria-expanded')).toBe('true')
    expect(await paneSnapshot(page)).toEqual(retainedB)
    await checkpoint('B restored: normal mode and Files directory state')
    await close()
    await select(original, 'LIGHTHOUSE')
    await expect.poll(() => columns(page)).toEqual(normalColumns)
    expect(await column.locator('[data-sidebar-right-open]').count()).toBe(1)
    expect(await paneSnapshot(page)).toEqual(retainedA)
    await checkpoint('A restored: expanded normal panel')

    try {
      await page.setViewportSize({ width: 1024, height: viewport.height })
      // Frame measurement and the grid transition can finish after setViewportSize returns.
      await expect.poll(() => columns(page), { timeout: 5_000 }).toEqual([280, 400, 344])
      await dragSidebar(page, 420)
      await expect.poll(() => columns(page)).toEqual([420, 604, 0])
      expect(await column.locator('[data-sidebar-right-open]').count()).toBe(0)
      expect(await paneSnapshot(page)).toEqual(retainedA)
      await checkpoint('A capacity-closed: wide left preference protected')
      await page.setViewportSize(viewport)
      await expect.poll(() => columns(page)).toEqual([420, viewport.width - 420, 0])
      expect(await column.locator('[data-sidebar-right-open]').count()).toBe(0)
      await checkpoint('A widened: remains closed')

      await page.locator('[data-sidebar-right-expand]').click()
      await expect.poll(() => columns(page)).toEqual([420, viewport.width - 420 - normalWidth, normalWidth])
      await page.setViewportSize({ width: 767, height: viewport.height })
      await expect.poll(() => panel.boundingBox()).toEqual({ x: 0, y: 0, width: 767, height: viewport.height })
      await expect.poll(() => columns(page)).toEqual([56, 711, 0])
      expect(await sidebarSnapshot(page)).toMatchObject({ mode: 'fullscreen', resizeHandleWidth: 0, coversViewport: true })
      await checkpoint('A automatic fullscreen at 767px')
      await column.locator('[data-sidebar-right-mode="push"]').click()
      await expect.poll(() => column.locator('[data-sidebar-right-open]').count()).toBe(0)
      await page.setViewportSize(viewport)
      await expect.poll(() => columns(page)).toEqual([420, viewport.width - 420, 0])
      expect(await paneSnapshot(page)).toEqual(retainedA)
      expect(await panel.getAttribute('data-sidebar-right-panel')).toBe('push')
      expect(await column.locator('[data-sidebar-right-open]').count()).toBe(0)
      await checkpoint('A automatic fullscreen exited: widening does not reopen')
    } finally {
      await page.setViewportSize(viewport)
    }

    await compareOrRefreshGolden(SIDEBAR_EXPECTED, checkpoints.join('\n\n'), MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['handles.expected.md', 'sidebar.expected.md'])
  })
})
