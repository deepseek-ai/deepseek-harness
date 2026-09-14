// Web e2e scenario: both current-session permission pickers expose the shipped
// experimental Auto entry and gate it behind the same locale-aware, in-page risk
// confirmation. Full access keeps its existing gate. Zero model calls: the
// scenario boots the shipped Web composition and exercises the real process
// catalog, permission projection, client command path, HTTP RPC, and pushed
// update.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import {
  ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot, writeComposerDraft,
} from './support.ts'

import { AUTO_REVIEW_FIXTURE, captureAutoReviewState } from './auto-review-fixture.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/access-confirmation', import.meta.url))
const CURRENT_SESSION_PICKER_EXPECTED = join(SNAPSHOT_DIR, 'current-session-picker.expected.md')
const SLASH_PICKER_EXPECTED = join(SNAPSHOT_DIR, 'slash-picker.expected.md')
const AUTO_CONFIRMATION_EXPECTED = join(SNAPSHOT_DIR, 'auto-confirmation.expected.md')
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()

describe('web e2e: experimental Auto and Full access confirmation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold(AUTO_REVIEW_FIXTURE)
    // CI uses Playwright's pinned browser. A developer may point this one
    // scenario at an installed Chromium when the matching browser download
    // is temporarily unavailable.
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    // Keep the Chinese surface via {@link ZH_BROWSER_LOCALE}: the golden pins
    // the actual registered dictionary rather than a test-local translation
    // callback.
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE, colorScheme: 'light' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('matches the three confirmed Auto entry states and gates both visible picks', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-auto-review-entry'))
    const access = page.locator('button[aria-label^="访问模式"]').first()
    await access.waitFor({ timeout: 10_000 })
    expect(await access.getAttribute('aria-label')).toBe('访问模式，当前：工作区内修改')

    await access.click()
    const currentMenu = page.getByRole('menu')
    await currentMenu.waitFor({ timeout: 10_000 })
    expect(await currentMenu.getByRole('menuitem').allTextContents())
      .toEqual(['仅可查看', '工作区内修改', '完全权限', 'Auto reviewEXP'])
    await captureAutoReviewState(page, 'experimental-current-session-picker')
    const currentSnapshot = await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(CURRENT_SESSION_PICKER_EXPECTED, currentSnapshot, MODE)

    const currentTriggerBox = await access.boundingBox()
    const currentMenuBox = await currentMenu.boundingBox()
    expect(currentTriggerBox).not.toBeNull()
    expect(currentMenuBox).not.toBeNull()
    expect(Math.abs(currentMenuBox!.width - 218)).toBeLessThan(1)
    expect(currentMenuBox!.width).toBeGreaterThan(currentTriggerBox!.width)
    expect(Math.abs(currentTriggerBox!.y - currentMenuBox!.y - currentMenuBox!.height - 4)).toBeLessThan(1)

    await currentMenu.getByRole('menuitem', { name: 'Auto review EXP' }).click()
    const autoDialog = page.getByRole('dialog', { name: '确认启用 Auto review（实验）？' })
    await autoDialog.waitFor({ timeout: 10_000 })
    const autoEnable = autoDialog.getByRole('button', { name: '启用 Auto review' })
    expect(await autoEnable.isDisabled()).toBe(true)
    expect(await autoDialog.getByText(/不使用沙箱/).count()).toBe(1)
    expect(await autoDialog.getByText(/误放行或误拒绝/).count()).toBe(1)
    expect(await autoDialog.getByText(/额外 token/).count()).toBe(1)
    expect(await autoDialog.evaluate(node => node.parentElement?.parentElement === document.body)).toBe(true)
    await captureAutoReviewState(page, 'experimental-confirmation')
    const confirmationSnapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(AUTO_CONFIRMATION_EXPECTED, confirmationSnapshot, MODE)
    await autoDialog.getByRole('button', { name: '取消' }).click()
    await expect.poll(() => autoDialog.count()).toBe(0)
    expect(await access.getAttribute('aria-label')).toBe('访问模式，当前：工作区内修改')

    const input = page.locator('[data-composer-input]').first()
    await writeComposerDraft(page, input, '/permission')
    const suggestions = page.getByRole('listbox', { name: '触发候选建议' })
    await suggestions.waitFor({ timeout: 10_000 })
    await input.press('Escape')
    await expect.poll(() => suggestions.count()).toBe(0)
    await input.press('Enter')

    const slashPicker = page.locator('[aria-label="/permission 选项"]')
    await slashPicker.waitFor({ timeout: 10_000 })
    const slashRows = slashPicker.getByRole('option')
    expect(await slashRows.count()).toBe(4)
    expect(await slashPicker.getByRole('option', { name: 'Auto review EXP' }).count()).toBe(1)
    await captureAutoReviewState(page, 'experimental-slash-picker')
    const slashSnapshot = await captureStableAria(page, '[aria-label="/permission 选项"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(SLASH_PICKER_EXPECTED, slashSnapshot, MODE)

    const slashPickerBox = await slashPicker.boundingBox()
    const composerBox = await page.locator('[data-composer-card]').first().boundingBox()
    expect(slashPickerBox).not.toBeNull()
    expect(composerBox).not.toBeNull()
    expect(slashPickerBox!.width).toBeGreaterThanOrEqual(220)
    expect(composerBox!.width - slashPickerBox!.width).toBeGreaterThan(1)
    expect(Math.abs(composerBox!.y - slashPickerBox!.y - slashPickerBox!.height - 4)).toBeLessThan(1)

    await slashPicker.getByRole('option', { name: 'Auto review EXP' }).click()
    const slashDialog = page.getByRole('dialog', { name: '确认启用 Auto review（实验）？' })
    await slashDialog.waitFor({ timeout: 10_000 })
    expect(await slashDialog.count()).toBe(1)
    expect(await slashPicker.count()).toBe(0)
    await slashDialog.getByRole('checkbox', { name: '我已了解这些风险，并愿意继续' }).check()
    await slashDialog.getByRole('button', { name: '启用 Auto review' }).click()
    await expect.poll(() => access.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('访问模式，当前：Auto review EXP')
    expect(await slashDialog.count()).toBe(0)
    expect(await input.textContent()).toBe('')
    await captureAutoReviewState(page, 'experimental-current-session')

    // Leave the shared page in the baseline state for the Full-access
    // regression below. An explicitly argued command must not show a second
    // confirmation.
    await writeComposerDraft(page, input, '/permission workspace-write')
    await input.press('Enter')
    await expect.poll(() => access.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('访问模式，当前：工作区内修改')
    expect(await page.getByRole('dialog').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('requires acknowledgement before the composer picker can enable Full access', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-full-access-confirmation'))
    const access = page.locator('button[aria-label^="访问模式"]').first()
    await access.waitFor({ timeout: 10_000 })

    expect(await access.getAttribute('aria-label')).toBe('访问模式，当前：工作区内修改')

    await access.click()
    await page.getByRole('menuitem', { name: '完全权限' }).click()
    const dialog = page.getByRole('dialog', { name: '确认启用完全权限？' })
    await dialog.waitFor({ timeout: 10_000 })
    const enable = dialog.getByRole('button', { name: '启用完全权限' })
    expect(await enable.isDisabled()).toBe(true)

    // The modal is in this page's body (not a native/new window) and escapes
    // the sticky composer's stacking context.
    expect(await dialog.evaluate(node => node.parentElement?.parentElement === document.body)).toBe(true)
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)

    await dialog.getByRole('checkbox', { name: '我已了解风险，并愿意继续' }).check()
    expect(await enable.isEnabled()).toBe(true)
    await enable.click()
    await expect.poll(() => access.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('访问模式，当前：完全权限')
    expect(await dialog.count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps all permission names readable with a collapsed narrow trigger', async () => {
    await page.setViewportSize({ width: 420, height: 1000 })
    const access = page.locator('button[aria-label^="访问模式"]').first()
    const composer = page.locator('[data-composer-card]').first()
    await expect.poll(async () => (await composer.boundingBox())!.width).toBeLessThanOrEqual(460)
    await expect.poll(async () => (await access.boundingBox())!.width).toBeLessThan(60)

    await access.click()
    const menu = page.getByRole('menu')
    await menu.waitFor()
    await captureAutoReviewState(page, 'experimental-narrow-menu')
    const menuBox = (await menu.boundingBox())!
    expect(menuBox.width).toBeGreaterThanOrEqual(218)
    expect(menuBox.width).toBeLessThanOrEqual(360)
    expect(menuBox.x).toBeGreaterThanOrEqual(0)
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(420)
    for (const name of ['仅可查看', '工作区内修改', '完全权限', 'Auto review']) {
      expect(await menu.getByText(name, { exact: true }).evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    }
    await page.keyboard.press('Escape')

    const input = page.locator('[data-composer-input]').first()
    await writeComposerDraft(page, input, '/permission')
    await input.press('Escape')
    await input.press('Enter')
    const slash = page.locator('[aria-label="/permission 选项"]')
    await slash.waitFor()
    await captureAutoReviewState(page, 'experimental-narrow-slash')
    const slashBox = (await slash.boundingBox())!
    expect(slashBox.width).toBeGreaterThanOrEqual(220)
    expect(slashBox.x).toBeGreaterThanOrEqual(0)
    expect(slashBox.x + slashBox.width).toBeLessThanOrEqual(420)
    expect(await slash.evaluate(node => getComputedStyle(node).minWidth)).toBe('min(220px, 100%)')
    expect(await slash.evaluate(node => getComputedStyle(node).maxWidth)).toBe('100%')
    for (const name of ['仅可查看', '工作区内修改', '完全权限', 'Auto review']) {
      expect(await slash.getByText(name, { exact: true }).evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    }
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  })

  it('refreshes both pickers through unload and reinstall without restoring Auto', async () => {
    await page.setViewportSize({ width: 1680, height: 1000 })
    const input = page.locator('[data-composer-input]').first()
    const access = page.locator('button[aria-label^="访问模式"]').first()
    await writeComposerDraft(page, input, '/permission auto')
    await input.press('Enter')
    await expect.poll(() => access.getAttribute('aria-label')).toBe('访问模式，当前：Auto review EXP')
    expect(await page.getByRole('dialog').count()).toBe(0)
    await writeComposerDraft(page, input, '/permission')
    await input.press('Escape')
    await input.press('Enter')
    const slash = page.locator('[aria-label="/permission 选项"]')
    await slash.waitFor()
    expect(await slash.getByRole('option').count()).toBe(4)
    const entry = [...scaffold.ctx.loader.entries()].find(row => row.options.id === 'auto-review')
    if (entry === undefined) throw new Error('experimental Auto integration is absent')
    await entry.update({ disabled: true })
    await scaffold.ctx.loader.await()
    await expect.poll(() => access.getAttribute('aria-label')).toBe('访问模式，当前：完全权限')
    await expect.poll(() => slash.count()).toBe(0)
    expect(await input.textContent()).toBe('/permission')
    await input.press('Enter')
    await slash.waitFor()
    expect(await slash.getByRole('option').count()).toBe(3)
    expect(await slash.getByText('Auto review', { exact: true }).count()).toBe(0)
    await page.keyboard.press('Escape')
    await access.click()
    await expect.poll(() => page.getByRole('menuitem').allTextContents())
      .toEqual(['仅可查看', '工作区内修改', '完全权限'])
    await captureAutoReviewState(page, 'uninstalled-current-session-picker')
    await page.keyboard.press('Escape')
    await entry.update({ disabled: false })
    await scaffold.ctx.loader.await()
    await access.click()
    await expect.poll(() => page.getByRole('menuitem').allTextContents())
      .toEqual(['仅可查看', '工作区内修改', '完全权限', 'Auto reviewEXP'])
    expect(await access.getAttribute('aria-label')).toBe('访问模式，当前：完全权限')
    await captureAutoReviewState(page, 'reinstalled-current-session-picker')
    await page.keyboard.press('Escape')
    await writeComposerDraft(page, input, '/permission')
    await input.press('Escape')
    await input.press('Enter')
    await slash.waitFor()
    expect(await slash.getByRole('option').count()).toBe(4)
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  })

  it('keeps its snapshot inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'auto-confirmation.expected.md',
      'current-session-picker.expected.md',
      'slash-picker.expected.md',
      'ui.expected.md',
    ])
  })
})


describe('web e2e: default permission choices', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE, colorScheme: 'light' })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)
  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })
  it('offers only the three standard modes in both pickers', async () => {
    const access = page.locator('button[aria-label^="访问模式"]').first()
    await access.click()
    await expect.poll(() => page.getByRole('menuitem').allTextContents())
      .toEqual(['仅可查看', '工作区内修改', '完全权限'])
    await captureAutoReviewState(page, 'default-current-session-picker')
    await page.keyboard.press('Escape')
    const input = page.locator('[data-composer-input]').first()
    await writeComposerDraft(page, input, '/permission')
    await input.press('Escape')
    await input.press('Enter')
    const slash = page.locator('[aria-label="/permission 选项"]')
    await slash.waitFor()
    expect(await slash.getByRole('option').count()).toBe(3)
    expect(await slash.getByText('Auto review', { exact: true }).count()).toBe(0)
    await captureAutoReviewState(page, 'default-slash-picker')
  })
})
