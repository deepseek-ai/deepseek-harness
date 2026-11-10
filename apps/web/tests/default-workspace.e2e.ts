/** First-use startup prepares a durable Workspace through the shipped Web composition. */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from 'playwright'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  assertFinalWorkspaceSnapshot, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold,
  selectedSessionFixture, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v3.jsonl', import.meta.url))
const EXPECTED = fileURLToPath(new URL('../../../snapshots/web/default-workspace/ui.expected.md', import.meta.url))
const FAILURE_EXPECTED = fileURLToPath(new URL('./expected/default-workspace/failure.expected.md', import.meta.url))
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: default Workspace', () => {
  it('prepares a blank Session on startup, reuses it after reload, and sends through the ordinary composer', async () => {
    const fixture = await selectedSessionFixture(FIXTURE)
    const scaffold = await launchWebScaffold({
      firstUse: true,
      replayFixture: fixture,
      // The shared recording remains read-only; replay compares the complete persisted Session.
      compareReplaySession: MODE === 'replay',
      paceMs: 5,
    })
    onTestFinished(() => scaffold.close())
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      const tripwire = watchConsole(page)
      try {
        await page.goto(scaffold.authenticatedUrl)
        const input = page.locator('[data-composer-input][contenteditable="true"]').first()
        await input.waitFor()
        // Language-neutral on disk, localized in the hero chip. The chip's
        // aria-label is its fixed call to action, so the label is its text.
        await page.getByRole('button', { name: 'Choose workspace', exact: true })
          .getByText('Default workspace', { exact: true }).waitFor()
        expect(scaffold.ctx.workspaceRegistry.list()).toHaveLength(1)
        const initialSession = scaffold.ctx.sessions.list()[0]!
        expect(scaffold.ctx.sessions.list()).toHaveLength(1)
        expect(initialSession.snapshotEvents().some(event => event.type === 'user/message')).toBe(false)
        await page.reload()
        await input.waitFor()
        expect(scaffold.ctx.sessions.list().map(session => session.id)).toEqual([initialSession.id])
        const prompt = fixtureUserPrompts(await readFile(fixture, 'utf8'))[0]!
        await input.fill(prompt)
        const settled = scaffold.whenTurnSettled()
        await input.press('Enter')
        const sessionId = await settled
        const workspace = scaffold.ctx.workspaceRegistry.list()[0]!
        expect(workspace.title).toBe('default-workspace')
        expect(workspace.path).toBe(join(scaffold.workspaceCwd, 'Documents', 'deepseek-harness', 'default-workspace'))
        expect((await stat(workspace.path)).isDirectory()).toBe(true)
        expect(workspace.sessionIds).toContain(sessionId)
        expect(scaffold.ctx.sessions.get(sessionId)?.header.cwd).toBe(workspace.path)
        await assertFinalWorkspaceSnapshot(fileURLToPath(new URL('../../../snapshots/web/default-workspace', import.meta.url)), workspace.path)
        await page.getByText('DONE', { exact: true }).waitFor()
        await compareOrRefreshGolden(EXPECTED, await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd), MODE)
        expect(tripwire.pageErrors).toEqual([])
        expect(tripwire.warnings).toEqual([])
      } catch (error) {
        await saveFailureShot(page, 'web-e2e-default-workspace')
        throw error
      }
    } finally {
      await browser.close()
    }
  })

  it.each([{ name: 'Chromium', engine: chromium }, { name: 'WebKit', engine: webkit }])(
    'opens the default Workspace chooser from its external trigger ($name)', async ({ engine }) => {
      const scaffold = await launchWebScaffold({ firstUse: true })
      onTestFinished(() => scaffold.close())
      const browser = await engine.launch()
      onTestFinished(() => browser.close())
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 }, locale: 'en-US', timezoneId: 'Asia/Shanghai',
        isMobile: true, hasTouch: true,
      })
      await page.goto(scaffold.authenticatedUrl)
      const trigger = page.getByRole('button', { name: 'Choose workspace', exact: true })
      await trigger.getByText('Default workspace', { exact: true }).waitFor()
      await trigger.tap()
      const menu = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Default workspace', exact: true }) })
      await menu.waitFor({ state: 'visible', timeout: 10_000 })
      expect(await trigger.getAttribute('aria-expanded')).toBe('true')
      expect(await trigger.evaluate(node => node.style.anchorName)).toBe(await menu.evaluate(node => node.style.positionAnchor))
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'hidden' })
      expect(await trigger.getAttribute('aria-expanded')).toBe('false')
    },
  )

  it('reports a startup directory conflict and opens the composed folder picker for recovery', async () => {
    const scaffold = await launchWebScaffold({ firstUse: true })
    onTestFinished(() => scaffold.close())
    const parent = join(scaffold.workspaceCwd, 'Documents', 'deepseek-harness')
    await mkdir(parent, { recursive: true })
    // A Chinese reader gets the same fixed directory name, so the same occupant conflicts.
    await writeFile(join(parent, 'default-workspace'), 'occupied')
    const chosen = join(scaffold.workspaceCwd, 'chosen')
    await mkdir(chosen)
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
      const tripwire = watchConsole(page)
      try {
        await page.goto(scaffold.authenticatedUrl)
        const input = page.locator('[data-composer-input][contenteditable="true"]').first()
        const notice = page.getByRole('alert').filter({ hasText: '无法创建默认工作区' })
        await notice.waitFor()
        expect(scaffold.ctx.workspaceRegistry.list()).toEqual([])
        expect(scaffold.ctx.sessions.list()).toEqual([])
        await compareOrRefreshGolden(FAILURE_EXPECTED, await notice.ariaSnapshot(), MODE)
        expect(await page.getByRole('dialog').count()).toBe(0)
        expect(await input.count()).toBe(0)
        await page.getByRole('button', { name: '选择工作区', exact: true }).click()
        const picker = page.getByRole('dialog', { name: '选择工作区目录' })
        await picker.waitFor()
        await picker.getByRole('button', { name: '编辑路径', exact: true }).click()
        await picker.getByRole('textbox', { name: '编辑路径' }).fill(chosen)
        await page.keyboard.press('Enter')
        await picker.getByRole('button', { name: '打开', exact: true }).click()
        await picker.waitFor({ state: 'hidden' })
        await expect.poll(() => scaffold.ctx.workspaceRegistry.list().length).toBe(1)
        await input.waitFor()
        expect(await input.textContent()).toBe('')
        expect(scaffold.ctx.workspaceRegistry.list()[0]?.path).toBe(chosen)
        expect(scaffold.ctx.sessions.list()).toHaveLength(1)
        expect(scaffold.ctx.sessions.list().every(session =>
          session.snapshotEvents().every(event => event.type !== 'user/message'))).toBe(true)
        expect(tripwire.pageErrors).toEqual([])
        expect(tripwire.warnings).toEqual([])
      } catch (error) {
        await saveFailureShot(page, 'web-e2e-default-workspace-failure')
        throw error
      }
    } finally {
      await browser.close()
    }
  })

  it('keeps an explicitly deleted default absent on startup', async () => {
    const scaffold = await launchWebScaffold()
    onTestFinished(() => scaffold.close())
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      const attempted = page.waitForResponse(response => response.url().includes('/api/workspace/initializeDefault'))
      await page.goto(scaffold.authenticatedUrl)
      expect((await attempted).ok()).toBe(true)
      await page.getByRole('button', { name: 'Choose workspace', exact: true }).waitFor()
      expect(await page.getByRole('alert').filter({ hasText: 'Unable to create default workspace' }).count()).toBe(0)
      expect(await page.locator('[data-composer-input][contenteditable="true"]').count()).toBe(0)
      expect(scaffold.ctx.workspaceRegistry.list()).toEqual([])
      expect(scaffold.ctx.sessions.list()).toEqual([])
    } finally {
      await browser.close()
    }
  })
})
