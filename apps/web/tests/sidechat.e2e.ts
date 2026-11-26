/** Side conversations: `/side` opens the child in the right Sidebar as a sidebar chat, and the tab survives a reload. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { acknowledgeReloadConnectionLoss, launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const SIDECHAT = fileURLToPath(new URL('../../../packages/experimental/client-ui-sidechat', import.meta.url))
const TITLE = 'Release checklist'
const SIDE_TITLE = `${TITLE} (1)`

describe('web e2e: side conversations', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    // No replay fixture: a bare `/side` forks without a model call, so a stray stream fails loud.
    scaffold = await launchWebScaffold({ profile: { packages: [{ dir: SIDECHAT, enabled: true }] } })
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const id = await seedSession(scaffold, await readFile(SEED, 'utf8'), 'sidechat')
    await workspace.attachSession(id)
    await scaffold.ctx.sessionController.rename({ sessionId: id, title: TITLE })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.setViewportSize({ width: 1600, height: 900 })
    tripwire = watchConsole(page)
    await page.addInitScript((sessionId) => {
      localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId }))
    }, id)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('opens /side as a sidebar chat beside the main composer and restores the tab after reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidechat'))
    // The main composer excludes sidebar chats, as the other Web specs select it.
    const mainInput = page.locator('[data-composer-input]:not([data-sidebar-chat] [data-composer-input])')
    // Until the stored Session is restored, the same surface is the read-only workspace-picker trigger.
    const mainEditable = mainInput.and(page.locator('[contenteditable="true"]'))
    const sideInput = page.locator('[data-sidechat][data-sidebar-chat] [data-composer-input]')
    const sideTab = page.getByRole('tab', { name: SIDE_TITLE })

    await mainEditable.waitFor()
    await mainEditable.fill('/side')
    await mainEditable.press('Enter')
    await sideTab.waitFor()
    await sideInput.waitFor()
    expect(await mainInput.count()).toBe(1)
    await expect.poll(() => mainInput.textContent()).toBe('')

    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await sideTab.waitFor()
    await sideInput.waitFor()

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
