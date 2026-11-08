import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { prepareSessionSnapshotFixtureForComparison } from '@deepseek-ai/dsh-llm-replay'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'
import { launchWebScaffold, selectedSessionFixture, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, openSettings, saveFailureShot } from './support.ts'

const BASE_FIXTURE = fileURLToPath(new URL('../../../snapshots/web/live-interactions/session.v3.jsonl', import.meta.url))
const LABEL = 'event-sourcing researcher'
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** Duplicate the base turn so the child owns its own replayed history. */
function childFixture(source: string, fixtureId: string): string {
  const [header, ...eventLines] = source.trimEnd().split('\n')
  if (header === undefined) throw new Error('base replay fixture has no header')
  const value = JSON.parse(header) as Record<string, unknown>
  value.id = fixtureId
  return [JSON.stringify(value), ...eventLines, ''].join('\n')
}

async function waitForAgentToSettle(scaffold: WebScaffold, id: SessionId): Promise<void> {
  const deadline = Date.now() + 30_000
  while (scaffold.ctx.agents.get(id) !== undefined) {
    if (Date.now() >= deadline) throw new Error(`subagent ${id} did not settle`)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}

/** Put one PNG on the system clipboard, confirm the clipboard holds it, then paste it with the platform shortcut. */
async function pasteImage(page: Page): Promise<void> {
  const types = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
    return (await navigator.clipboard.read()).flatMap(item => item.types)
  }, PNG_BASE64)
  expect(types).toContain('image/png')
  await page.keyboard.press('ControlOrMeta+V')
}

/** Leave every control, as after clicking a transcript's empty space. */
async function blurAll(page: Page): Promise<void> {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur() })
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
}

/** Editors of the main Conversation composer and the Sidebar chat composer. */
const MAIN_INPUT = '[data-composer-input][contenteditable="true"]:not([data-sidebar-chat] *)'
const SIDEBAR_INPUT = '[data-sidebar-chat] [data-composer-input][contenteditable="true"]'

/** Image thumbnails currently in each composer's draft rail. */
async function railImages(page: Page): Promise<{ main: number; sidebar: number }> {
  return page.evaluate(() => {
    const count = (root: Element | null): number =>
      root?.querySelectorAll('[data-composer-card] img').length ?? 0
    const sidebar = document.querySelector('[data-sidebar-chat]')
    const main = [...document.querySelectorAll('[data-conversation-content]')]
      .find(element => sidebar === null || !sidebar.contains(element)) ?? null
    return { main: count(main), sidebar: count(sidebar) }
  })
}

describe('web e2e: composer paste routing', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let sidecarRoot: string

  beforeAll(async () => {
    if (webSnapshotMode() === 'record') throw new Error('composer paste routing is a keyless assembled scenario')
    const selectedBaseFixture = await selectedSessionFixture(BASE_FIXTURE)
    const baseFixture = prepareSessionSnapshotFixtureForComparison(await readFile(selectedBaseFixture, 'utf8'))
    sidecarRoot = await mkdtemp(join(tmpdir(), 'dsh-web-paste-'))
    const childFixturePath = join(sidecarRoot, 'child.jsonl')
    await writeFile(childFixturePath, childFixture(baseFixture, 'recorded-subagent'))
    scaffold = await launchWebScaffold({
      replayFixture: selectedBaseFixture,
      compareReplaySession: false,
      replayChildFixtures: [childFixturePath],
      paceMs: 25,
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const parent = scaffold.ctx.agents.list().filter(agent => agent.session.header.origin !== 'subagent')[0]
    if (parent === undefined) throw new Error('fresh workspace did not publish its parent Agent')
    const parentSettled = scaffold.whenTurnSettled()
    const parentInput = page.locator('[data-composer-input][contenteditable="true"]').first()
    await parentInput.fill('Ask a research subagent to explain event sourcing.')
    await parentInput.press('Enter')
    expect(await parentSettled).toBe(parent.id)
    const started = await scaffold.ctx.subagents.startActivation({
      delivery: 'parent', provider: 'spawn', label: LABEL, signal: new AbortController().signal,
      prompt: [{ type: 'text', text: 'Explain event sourcing in one sentence.' }],
      parent,
    })
    await waitForAgentToSettle(scaffold, started.childId)
    await page.getByRole('button', { name: '1 subagent', exact: true }).hover()
    await page.getByRole('treeitem', { name: new RegExp(LABEL) })
      .getByRole('button', { name: `Open ${LABEL} in sidebar`, exact: true }).click()
    await page.locator('[data-sidebar-chat] [data-composer-card]').waitFor({ timeout: 15_000 })
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (sidecarRoot !== undefined) await rm(sidecarRoot, { recursive: true, force: true })
  })

  it('pastes into the focused editor once and an unfocused paste into the last focused composer', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-paste'))
    const before = await railImages(page)
    await page.locator(SIDEBAR_INPUT).click()
    await pasteImage(page)
    await expect.poll(() => railImages(page)).toEqual({ main: before.main, sidebar: before.sidebar + 1 })
    await blurAll(page)
    await pasteImage(page)
    await expect.poll(() => railImages(page)).toEqual({ main: before.main, sidebar: before.sidebar + 2 })
    await page.locator(MAIN_INPUT).click()
    await blurAll(page)
    await pasteImage(page)
    await expect.poll(() => railImages(page)).toEqual({ main: before.main + 1, sidebar: before.sidebar + 2 })
  })

  it('ignores an unfocused paste while Settings is open', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-paste-modal'))
    await page.locator(MAIN_INPUT).click()
    await blurAll(page)
    const before = await railImages(page)
    await openSettings(page, 'en')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.waitFor()
    await pasteImage(page)
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'detached' })
    await blurAll(page)
    // Exactly one image after a paste that would succeed: the paste behind Settings added none.
    await pasteImage(page)
    await expect.poll(() => railImages(page)).toEqual({ main: before.main + 1, sidebar: before.sidebar })
  })

  it('sends an unfocused paste to the main composer once the focused Sidebar collapses', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-paste-collapsed'))
    await page.locator(SIDEBAR_INPUT).click()
    const before = await railImages(page)
    await page.getByRole('button', { name: 'Collapse right sidebar', exact: true }).click()
    await page.getByRole('button', { name: 'Open right sidebar', exact: true }).waitFor()
    // The collapsed Sidebar keeps the chat mounted inside an inert dock section.
    expect(await page.locator('[data-sidebar-chat] [data-composer-card]')
      .evaluate(card => card.closest('[inert]') !== null)).toBe(true)
    await blurAll(page)
    try {
      await pasteImage(page)
      await expect.poll(() => railImages(page)).toEqual({ main: before.main + 1, sidebar: before.sidebar })
    } finally {
      await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
      await page.locator(SIDEBAR_INPUT).waitFor()
    }
  })
})
