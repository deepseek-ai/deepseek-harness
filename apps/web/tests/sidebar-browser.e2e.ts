/** Keyless Browser-tab coverage through the shipped Web composition. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type {} from '@deepseek-ai/dsh-agent'
import {
  assertFixtureInventory,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/lifecycle-chrome/session.v3.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/sidebar-browser', import.meta.url))
const EXPECTED = join(SNAPSHOT_DIR, 'browser.expected.md')
const MODE = webSnapshotMode()
const PROMPT = 'Reply with the single word LIGHTHOUSE and stop.'

describe.skipIf(MODE === 'record')('web e2e: Sidebar Browser', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE,
      compareReplaySession: false,
      extraOverlayPath: fileURLToPath(new URL('./sidebar-browser.overlay.yml', import.meta.url)),
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.route('https://browser.test/**', async (route) => {
      const name = new URL(route.request().url()).pathname.slice(1) || 'one'
      await route.fulfill({
        contentType: 'text/html',
        body: `<h1>${name}</h1><a href="/inside">Inside navigation</a><p>isolated HTTPS fixture</p>`,
      })
    })
    await page.route('http://127.0.0.1:3080/**', async route => route.fulfill({
      contentType: 'text/html',
      body: '<h1>loopback</h1>',
    }))
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('navigates sandboxed HTTP(S) with application-known history', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-browser'))
    const settled = scaffold.whenTurnSettled()
    const composer = page.locator('[data-composer-input]').first()
    await composer.fill(PROMPT)
    await composer.press('Enter')
    await settled
    await page.getByText('LIGHTHOUSE', { exact: true }).waitFor({ timeout: 15_000 })
    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="browser"]').click()
    const input = column.getByRole('textbox', { name: 'Enter an HTTP(S) address' })
    await input.fill('https://browser.test/one')
    await input.press('Enter')
    const frame = column.locator('[data-sidebar-browser-frame]')
    await frame.waitFor({ state: 'visible' })
    await page.frameLocator('[data-sidebar-browser-frame]').getByRole('heading', { name: 'one' }).waitFor()
    expect(await frame.getAttribute('allow')).toBeNull()
    await column.getByRole('button', { name: 'Disable sandbox restrictions' }).click()
    await expect.poll(() => frame.getAttribute('sandbox')).toBeNull()
    await column.getByText('Sandbox restrictions are disabled; the page can navigate the top-level app and use downloads, modal dialogs, and input locks.', { exact: true }).waitFor()
    await column.getByRole('button', { name: 'Restore sandbox restrictions' }).click()
    await expect.poll(() => frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox')
    await page.frameLocator('[data-sidebar-browser-frame]').getByRole('link', { name: 'Inside navigation' }).click()
    await page.frameLocator('[data-sidebar-browser-frame]').getByRole('heading', { name: 'inside' }).waitFor()
    await column.getByText('URL changed', { exact: true }).waitFor()
    expect(await column.getByRole('button', { name: 'Back', exact: true }).isDisabled()).toBe(true)
    expect(await column.getByRole('button', { name: 'Forward', exact: true }).isDisabled()).toBe(true)
    expect(await column.getByRole('button', { name: 'Open in system browser', exact: true }).isDisabled()).toBe(true)
    await column.getByRole('button', { name: 'Reload' }).click()
    await page.frameLocator('[data-sidebar-browser-frame]').getByRole('heading', { name: 'one' }).waitFor()
    await input.fill('https://browser.test/two')
    await input.press('Enter')
    await page.frameLocator('[data-sidebar-browser-frame]').getByRole('heading', { name: 'two' }).waitFor()
    await column.getByRole('button', { name: 'Back', exact: true }).click()
    await page.frameLocator('[data-sidebar-browser-frame]').getByRole('heading', { name: 'one' }).waitFor()
    await column.getByRole('button', { name: 'Forward', exact: true }).click()
    await page.frameLocator('[data-sidebar-browser-frame]').getByRole('heading', { name: 'two' }).waitFor()

    await input.fill('http://127.0.0.1:3080/preview')
    await input.press('Enter')
    await page.frameLocator('[data-sidebar-browser-frame]').getByRole('heading', { name: 'loopback' }).waitFor()
    expect(await frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox')

    await input.fill('file:///work/index.html')
    await input.press('Enter')
    const blocked = await column.getByRole('alert').innerText()
    expect(blocked).toBe('Only HTTP and HTTPS addresses are supported; use Document Preview for local files.')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await mkdir(SNAPSHOT_DIR, { recursive: true })
    await compareOrRefreshGolden(EXPECTED, [
      '# Sidebar Browser', '',
      '- HTTPS sandbox: allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox',
      '- Permissions Policy: browser defaults',
      '- Sandbox toggle: per-tab and temporary',
      '- Unknown navigation: marker shown; Back, Forward, and external-open disabled',
      '- HTTPS history: one -> two -> one -> two',
      '- Loopback HTTP: loaded under the default sandbox',
      `- Invalid protocol: ${blocked}`,
    ].join('\n'), MODE)
    await assertFixtureInventory(SNAPSHOT_DIR, ['browser.expected.md'])
  })
})
