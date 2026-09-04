/** Blank New Session folding through the shipped Web composition. */

import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  seedSession,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const EXPECTED_DIR = fileURLToPath(new URL('./expected/workspace-new-session-folding', import.meta.url))
const SIDEBAR_EXPECTED = join(EXPECTED_DIR, 'sidebar.expected.md')
const SEED = fileURLToPath(new URL('../../../snapshots/web/message-feedback-protocol/session.v2.jsonl', import.meta.url))
const MODE = webSnapshotMode()
const EXISTING_SESSION_COUNT = 6

describe('web e2e: blank New Session folding quota', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const fixture = await readFile(SEED, 'utf8')
    const sessionIds = []
    for (let index = 1; index <= EXISTING_SESSION_COUNT; index += 1) {
      sessionIds.push(await seedSession(
        scaffold,
        fixture,
        `workspace-new-session-folding-${String(index).padStart(2, '0')}`,
      ))
    }
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    for (const sessionId of sessionIds) await workspace.attachSession(sessionId)

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    const workspaceTitle = basename(scaffold.workspaceCwd)
    const workspaceRow = page.getByText(workspaceTitle, { exact: true }).first()
      .locator('xpath=ancestor::*[@role="treeitem"][1]')
    await workspaceRow.waitFor({ timeout: 15_000 })
    if (await workspaceRow.getAttribute('aria-expanded') !== 'true') await workspaceRow.click()
    await workspaceRow.hover()
    await page.getByRole('button', { name: `New session in ${workspaceTitle}` }).click()
    await page.getByRole('tree', { name: 'Sessions' })
      .getByText('New Session', { exact: true }).waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps five established sessions beside the provisional row', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workspace-new-session-folding'))
    const sidebar = page.getByRole('tree', { name: 'Sessions' })
    await expect.poll(() => sidebar.getByRole('treeitem').count(), { timeout: 15_000 }).toBe(7)
    expect(await sidebar.getByText('New Session', { exact: true }).count()).toBe(1)
    expect(await sidebar.getByText(basename(scaffold.workspaceCwd), { exact: true }).count()).toBe(6)
    const showMore = sidebar.getByRole('button', { name: 'Show 1 more sessions' })
    await showMore.waitFor({ timeout: 15_000 })
    await compareOrRefreshGolden(
      SIDEBAR_EXPECTED,
      await captureStableAria(page, '[role="tree"][aria-label="Sessions"]', scaffold.workspaceCwd),
      MODE,
    )

    await showMore.click()
    await expect.poll(() => sidebar.getByRole('treeitem').count(), { timeout: 10_000 }).toBe(8)
    expect(await sidebar.getByText(basename(scaffold.workspaceCwd), { exact: true }).count()).toBe(7)
    await sidebar.getByRole('button', { name: 'Show less' }).click()
    await expect.poll(() => sidebar.getByRole('treeitem').count()).toBe(7)
    await assertFixtureInventory(EXPECTED_DIR, ['sidebar.expected.md'])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
