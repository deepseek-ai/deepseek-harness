/** The completed answer offers creation through a propose_action card; choosing a location does not start it. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  fixtureUserPrompts, launchWebScaffold, watchConsole, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const directory = fileURLToPath(new URL('../../../snapshots/web/creation-recommendations', import.meta.url))
const fixture = join(directory, 'session.v4.jsonl')

describe('creation recommendation after an explicit wish', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ replayFixture: fixture, compareReplaySession: true,
      profile: { packages: [{ dir: fileURLToPath(new URL('../../../packages/experimental/personalized-recommendations', import.meta.url)), enabled: true }] },
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
  })
  afterAll(async () => { await browser?.close(); await scaffold?.close() })

  it('shows one card below the answer, lets the user change location, and restores a dismissal', async () => {
    const tripwire = watchConsole(page)
    await page.setViewportSize({ width: 620, height: 900 })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const input = page.locator('[data-composer-input]').first()
    const settled = scaffold.whenTurnSettled()
    await input.fill(fixtureUserPrompts(await readFile(fixture, 'utf8'))[0]!)
    await input.press('Enter')
    await settled
    const card = page.locator('[data-action-card]')
    await card.waitFor({ state: 'visible' })
    expect(await card.count()).toBe(1)
    expect(await page.locator('[data-turn-tail] [data-action-card]').count()).toBe(1)
    const answer = page.getByText('I can create a persistent counter with increment and reset controls. Choose its location below.', { exact: true })
    const answerBox = await answer.boundingBox()
    const cardBox = await card.boundingBox()
    expect(answerBox).not.toBeNull()
    expect(cardBox!.y).toBeGreaterThanOrEqual(answerBox!.y + answerBox!.height)
    expect(await card.getByRole('button', { name: 'Create', exact: true }).isEnabled()).toBe(true)
    await compareOrRefreshGolden(join(directory, 'offered.expected.md'), await captureStableAria(page, '[data-action-card]', scaffold.workspaceCwd), scaffold.mode)
    const info = card.getByRole('button', { name: 'How creation works and token usage', exact: true })
    expect(await info.getAttribute('aria-expanded')).toBe('true')
    expect(await card.getByRole('note').innerText()).toContain('large number of tokens')
    await info.focus()
    await info.press('Space')
    expect(await card.getByRole('note').count()).toBe(0)
    const infoWarnings = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await card.waitFor({ state: 'visible' })
    acknowledgeReloadConnectionLoss(tripwire, infoWarnings)
    expect(await info.getAttribute('aria-expanded')).toBe('false')
    await info.focus()
    await info.press('Enter')
    expect(await info.getAttribute('aria-expanded')).toBe('true')
    expect(await card.getByRole('note').innerText()).toContain('large number of tokens')
    expect(await card.getByRole('note').innerText()).toContain('keep chatting here')
    expect(await card.getByRole('button', { name: 'Create', exact: true }).isEnabled()).toBe(true)
    expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await compareOrRefreshGolden(join(directory, 'info.expected.md'), await captureStableAria(page, '[data-action-card]', scaffold.workspaceCwd), scaffold.mode)
    await info.press('Space')
    expect(await info.getAttribute('aria-expanded')).toBe('false')
    expect(await card.getByRole('note').count()).toBe(0)
    const expand = card.getByRole('button', { name: 'Show more', exact: true })
    const plan = page.locator(`[id="${await expand.getAttribute('aria-controls')}"]`)
    const compactHeight = await plan.evaluate(element => element.clientHeight)
    const previewText = await plan.innerText()
    expect(previewText.endsWith('…')).toBe(true)
    // The preview keeps about 260 Latin-letter widths before the ellipsis; a trailing space may be trimmed.
    const previewLength = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(previewText)).length
    expect(previewLength).toBeGreaterThan(200)
    expect(previewLength).toBeLessThanOrEqual(261)
    await expand.click()
    expect(await plan.evaluate(element => element.clientHeight)).toBeGreaterThan(compactHeight)
    expect(await card.getByRole('button', { name: 'Create', exact: true }).isEnabled()).toBe(true)
    await compareOrRefreshGolden(join(directory, 'expanded.expected.md'), await captureStableAria(page, '[data-action-card]', scaffold.workspaceCwd), scaffold.mode)
    await card.getByRole('button', { name: 'Show less', exact: true }).click()
    const location = card.getByRole('button', { name: 'Add to: Right sidebar', exact: true })
    await location.click()
    expect(await page.getByRole('menuitem').count()).toBe(4)
    await compareOrRefreshGolden(join(directory, 'location-menu.expected.md'), await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd), scaffold.mode)
    await page.getByRole('menuitem').first().press('Escape')
    expect(await page.getByRole('menu').count()).toBe(0)
    expect(await location.evaluate(element => element === document.activeElement)).toBe(true)
    await location.click()
    await page.getByRole('menuitem', { name: /Write your own/ }).click()
    const custom = card.getByRole('textbox', { name: 'Where should it appear?', exact: true })
    expect(await card.getByRole('button', { name: 'Create', exact: true }).isEnabled()).toBe(false)
    await custom.fill('A left sidebar entry that opens a full-page calendar')
    expect(await card.getByRole('button', { name: 'Create', exact: true }).isEnabled()).toBe(true)
    await compareOrRefreshGolden(join(directory, 'custom-location.expected.md'), await captureStableAria(page, '[data-action-card]', scaffold.workspaceCwd), scaffold.mode)
    await card.getByRole('button', { name: 'Add to: Write your own', exact: true }).click()
    await page.getByRole('menuitem', { name: /Session tab/ }).click()
    expect(await card.getByRole('button', { name: 'Add to: Session tab', exact: true }).isVisible()).toBe(true)
    expect(await custom.count()).toBe(0)
    await compareOrRefreshGolden(join(directory, 'options.expected.md'), await captureStableAria(page, '[data-action-card]', scaffold.workspaceCwd), scaffold.mode)
    expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await card.getByRole('button', { name: 'Not now', exact: true }).click()
    await card.getByRole('status').getByText('Dismissed', { exact: true }).waitFor()
    const warnings = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await card.getByRole('status').getByText('Dismissed', { exact: true }).waitFor()
    acknowledgeReloadConnectionLoss(tripwire, warnings)
    expect(await card.getByRole('button', { name: 'Create', exact: true }).count()).toBe(0)
    expect(await card.getByRole('button', { name: 'Show more', exact: true }).isVisible()).toBe(true)
    expect((await scaffold.ctx.pluginManager.listBundles()).some(bundle => bundle.name.startsWith('@dsh-local/view-'))).toBe(false)
    await compareOrRefreshGolden(join(directory, 'dismissed.expected.md'), await captureStableAria(page, '[data-action-card]', scaffold.workspaceCwd), scaffold.mode)
    const statusSettled = scaffold.whenTurnSettled()
    await input.fill(fixtureUserPrompts(await readFile(fixture, 'utf8'))[1]!)
    await input.press('Enter')
    await statusSettled
    await page.getByText('The counter proposal was dismissed. Creation never started.', { exact: true }).waitFor()
    expect(await card.count()).toBe(1)
    expect(await card.getByRole('button', { name: 'Create', exact: true }).count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    if (scaffold.mode === 'replay') await assertFixtureInventory(directory, [
      'session.v4.jsonl', 'offered.expected.md', 'info.expected.md', 'expanded.expected.md', 'options.expected.md', 'dismissed.expected.md', 'location-menu.expected.md', 'custom-location.expected.md', 'system-prompt.expected.md', 'tool-schemas.expected.json',
    ])
  })
})
