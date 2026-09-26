/** Sidebar commands through the shipped Loader, real sidebar/file/terminal owners, and Web keybinding editor. */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace } from './support.ts'

const expected = fileURLToPath(new URL('./expected/shortcuts-panels', import.meta.url))
const mode = webSnapshotMode()

/** Reassign a spare Web combination through the actual editor, leaving browser-reserved defaults untouched. */
async function bind(page: Page, primary: string, label: string, previous?: string): Promise<void> {
  await page.keyboard.press(`${primary}+/`)
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true })
  await dialog.waitFor()
  if (label === 'Split' || label === 'Toggle panel fullscreen') {
    const row = dialog.getByRole('listitem').filter({ has: page.getByRole('button', { name: `Edit shortcut for ${label}`, exact: true }) })
    expect(await row.getByText(label, { exact: true }).count()).toBe(1)
    expect(await row.getByText('Focus a right sidebar pane first', { exact: true }).count()).toBe(0)
    expect(await row.getByText('Unavailable', { exact: true }).count()).toBe(0)
  }
  if (previous !== undefined) {
    await dialog.getByRole('button', { name: `Edit shortcut for ${previous}`, exact: true }).click()
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click()
    await dialog.getByRole('group').waitFor({ state: 'hidden' })
  }
  await dialog.getByRole('button', { name: `Edit shortcut for ${label}`, exact: true }).click()
  const recorder = dialog.getByRole('group', { name: label, exact: true })
  await recorder.waitFor()
  await page.keyboard.press(`${primary}+Shift+,`)
  await recorder.waitFor({ state: 'hidden' })
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
}

// The fixture owns a POSIX shell; Windows has a separate physical-input acceptance run.
describe.skipIf(process.platform === 'win32')('Web sidebar shortcuts', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  }, 120_000)
  afterAll(async () => { await browser?.close() })

  it.each([
    { platform: 'MacIntel', primary: 'Meta', aria: 'Shift+Meta+,' },
    { platform: 'Win32', primary: 'Control', aria: 'Control+Shift+,' },
  ].flatMap(platform => (['left', 'right'] as const).map(closeFirst => ({ ...platform, closeFirst }))))('targets panes and closes $closeFirst first with $platform bindings', async ({ platform, primary, aria, closeFirst }) => {
    const scaffold: WebScaffold = await launchWebScaffold({
      extraOverlayPath: [
        fileURLToPath(new URL('./fixtures/sidebar-terminal.patch.yml', import.meta.url)),
        fileURLToPath(new URL('./sidebar-browser.overlay.yml', import.meta.url)),
      ],
    })
    const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1680, height: 1000 } })
    try {
      // Device-label/DOM branch evidence only; physical Windows input has its own acceptance checklist.
      await context.addInitScript((value) => { Object.defineProperty(navigator, 'platform', { value }) }, platform)
      const page = await context.newPage()
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      const before = new Set(scaffold.ctx.agents.list().map(agent => agent.id))
      await connectFreshWorkspace(page, scaffold.workspaceCwd)
      const agent = scaffold.ctx.agents.list().find(agent => !before.has(agent.id))
      if (agent === undefined) throw new Error('The workspace did not create a Session')
      // A settled fixture activates the ordinary Session UI; this scenario issues no model requests.
      agent.session.append('turn/start', { turn: 1 })
      agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Prepare panel actions.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      agent.session.append('step/start', { turn: 1, step: 1 })
      agent.session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'Panel actions are ready.' }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' })
      agent.session.append('step/end', { turn: 1, step: 1 })
      agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await scaffold.ctx.sessions.flush(agent.session)
      await page.getByText('Panel actions are ready.', { exact: true }).waitFor()
      const composer = page.locator('[data-composer-input]')
      await composer.click()
      await page.keyboard.insertText('T5 draft remains unsent')
      await page.keyboard.press(`${primary}+Alt+Enter`)
      expect(await composer.innerText()).toContain('T5 draft remains unsent')
      const eventCount = agent.session.seq
      const panel = page.locator('[data-sidebar-right-panel][data-sidebar-right-open]')
      const paneAppearance = () => panel.locator('[data-dockkit-pane]').evaluateAll(panes => panes.map((pane) => {
        const style = getComputedStyle(pane)
        return { outline: style.outlineStyle, shadow: style.boxShadow }
      }))
      const plainPane = { outline: 'none', shadow: 'none' }

      for (const { label, previous } of [
        { label: 'Browser', previous: undefined },
        { label: 'New terminal', previous: 'Browser' },
      ]) {
        await bind(page, primary, label, previous)
        await composer.click()
        await page.keyboard.press(`${primary}+Shift+,`)
        const openedPage = label === 'Browser' ? panel.getByPlaceholder('Enter an HTTP(S) address')
          : panel.locator('[data-sidebar-terminal]')
        await openedPage.waitFor()
        const focusedAfterOpening = await panel.locator('[data-dockkit-pane]').evaluate(pane => pane.contains(document.activeElement))
        expect(await paneAppearance()).toEqual([plainPane])
        await page.keyboard.press(`${primary}+Alt+W`)
        await expect.poll(() => page.locator('[data-sidebar-right-open]').count(), { message: label }).toBe(0)
        expect(focusedAfterOpening, label).toBe(true)
        expect(await composer.innerText()).toBe('T5 draft remains unsent')
      }

      await bind(page, primary, 'Toggle right sidebar', 'New terminal')
      await composer.click()
      await page.keyboard.press(`${primary}+Shift+,`)
      await panel.waitFor()
      expect(await paneAppearance()).toEqual([plainPane])
      expect(await panel.getByRole('button', { name: 'Collapse right sidebar' }).getAttribute('aria-keyshortcuts')).toBe(aria)
      await panel.getByRole('tab').focus()
      await page.keyboard.press(`${primary}+Shift+,`)
      await expect.poll(() => page.locator('[data-sidebar-right-open]').count()).toBe(0)
      await page.keyboard.press(`${primary}+Shift+,`)
      await panel.waitFor()

      const terminalGuide = panel.locator('[data-sidebar-right-guide-entry="terminal"]').getByRole('button').first()
      await terminalGuide.hover()
      expect(await page.getByRole('tooltip').count()).toBe(0)
      await page.mouse.move(10, 10)
      await terminalGuide.focus()
      expect(await page.getByRole('tooltip').count()).toBe(0)

      const terminalEntry = panel.locator('[data-sidebar-right-guide-entry="terminal"]')
      const shellMenu = terminalEntry.getByRole('button', { name: 'Choose shell', exact: true })
      const titleBounds = await terminalEntry.getByText('New terminal', { exact: true }).boundingBox()
      const arrowBounds = await shellMenu.boundingBox()
      expect(arrowBounds!.x).toBeGreaterThanOrEqual(titleBounds!.x + titleBounds!.width)
      expect(arrowBounds!.x - titleBounds!.x - titleBounds!.width).toBeLessThan(8)
      await shellMenu.click()
      await page.getByRole('menu').waitFor()
      expect(await panel.locator('[data-sidebar-terminal]').count()).toBe(0)
      await page.keyboard.press('Escape')
      await page.getByRole('menu').waitFor({ state: 'detached' })
      expect(await shellMenu.evaluate(element => element === document.activeElement)).toBe(true)

      await bind(page, primary, 'Browser', 'Toggle right sidebar')
      const browserGuide = panel.locator('[data-sidebar-right-guide-entry="browser"]')
      await browserGuide.hover()
      await browserGuide.focus()
      expect(await browserGuide.getAttribute('aria-keyshortcuts')).toBe(aria)
      expect(await page.getByRole('tooltip').count()).toBe(0)
      await composer.click()
      const selectedDraft = await composer.evaluate((element) => {
        const text = element.querySelector('[data-lexical-text]')!.firstChild!
        const selection = document.getSelection()!
        selection.setBaseAndExtent(text, 0, text, text.textContent!.length)
        return selection.toString()
      })
      await page.keyboard.press(`${primary}+Shift+,`)
      await panel.getByPlaceholder('Enter an HTTP(S) address').waitFor()
      expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(selectedDraft)
      await panel.getByPlaceholder('Enter an HTTP(S) address').focus()
      await page.keyboard.press(`${primary}+Shift+,`)
      await expect.poll(() => panel.getByRole('tab', { name: /Browser/ }).count()).toBe(2)
      expect(await panel.locator('[data-dockkit-pane]').evaluate(pane => document.activeElement === pane)).toBe(true)
      expect(await paneAppearance()).toEqual([plainPane])
      await page.keyboard.press(`${primary}+Alt+W`)
      await expect.poll(() => panel.getByRole('tab', { name: /Browser/ }).count()).toBe(1)
      await page.keyboard.press(`${primary}+Shift+,`)
      await expect.poll(() => panel.getByRole('tab', { name: /Browser/ }).count()).toBe(2)
      await expect.poll(() => panel.getByRole('button', { name: 'Disable sandbox restrictions', exact: true }).isEnabled()).toBe(true)
      await compareOrRefreshGolden(join(expected, 'browser.expected.md'),
        await captureStableAria(page, '[data-sidebar-right-panel]', scaffold.workspaceCwd), mode)
      await panel.locator('[data-dockkit-tab-close]').last().click()
      await panel.locator('[data-dockkit-tab-close]').click()
      await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
      await bind(page, primary, 'Workspace files', 'Browser')
      await composer.click()
      await page.keyboard.press(`${primary}+Shift+,`)
      await panel.locator('[data-dockkit-tab]').filter({ hasText: 'Files' }).waitFor()
      expect(await panel.locator('[data-dockkit-pane]').evaluate(pane => document.activeElement === pane)).toBe(true)
      expect(await paneAppearance()).toEqual([plainPane])
      await page.keyboard.press(`${primary}+Shift+,`)
      expect(await panel.locator('[data-dockkit-tab]').filter({ hasText: 'Files' }).count()).toBe(1)
      expect(await panel.locator('[data-dockkit-pane]').evaluate(pane => document.activeElement === pane)).toBe(true)
      expect(await paneAppearance()).toEqual([plainPane])

      await bind(page, primary, 'Toggle panel fullscreen', 'Workspace files')
      await composer.click()
      await page.keyboard.press(`${primary}+Shift+,`)
      expect(await page.locator('[data-sidebar-right-panel="fullscreen"]').count()).toBe(0)
      const filesTab = panel.locator('[data-dockkit-tab]').filter({ hasText: 'Files' })
      await filesTab.focus()
      await expect.poll(() => filesTab.evaluate(element => document.activeElement === element)).toBe(true)
      await page.keyboard.press(`${primary}+Shift+,`)
      await page.locator('[data-sidebar-right-panel="fullscreen"]').waitFor()
      expect(await paneAppearance()).toEqual([plainPane])
      expect(await composer.innerText()).toContain('T5 draft remains unsent')
      expect(agent.session.seq).toBe(eventCount)

      await bind(page, primary, 'Split', 'Toggle panel fullscreen')
      await panel.locator('[data-dockkit-tab]').filter({ hasText: 'Files' }).focus()
      await page.keyboard.press(`${primary}+Shift+,`)
      await expect.poll(() => panel.locator('[data-dockkit-pane]').count()).toBe(2)
      const left = panel.locator('[data-dockkit-pane][data-dockkit-column="0"]')
      const right = panel.locator('[data-dockkit-pane][data-dockkit-column="1"]')
      expect(await right.evaluate(pane => document.activeElement === pane)).toBe(true)
      expect(await paneAppearance()).toEqual([plainPane, plainPane])
      const disabled = right.locator('[data-dockkit-split-button]')
      expect(await disabled.isDisabled()).toBe(true)
      await disabled.locator('..').focus()
      const splitKeys = primary === 'Meta' ? '⇧ ⌘ ,' : 'Ctrl + Shift + ,'
      await page.getByRole('tooltip', { name: `Two panes is the limit ${splitKeys}`, exact: true }).waitFor()

      await bind(page, primary, 'Workspace files', 'Split')
      await right.getByRole('tab').focus()
      await page.keyboard.press(`${primary}+Shift+,`)
      await expect.poll(() => panel.locator('[data-dockkit-tab]').filter({ hasText: 'Files' }).count()).toBe(2)
      await page.keyboard.press(`${primary}+Shift+,`)
      expect(await right.locator('[data-dockkit-tab]').filter({ hasText: 'Files' }).count()).toBe(1)

      await bind(page, primary, 'New terminal', 'Workspace files')
      await right.locator('[data-dockkit-tab]').filter({ hasText: 'Files' }).focus()
      await page.keyboard.press(`${primary}+Shift+,`)
      await right.locator('[data-sidebar-terminal]').waitFor()
      await expect.poll(() => right.locator('.xterm-rows').innerText()).toContain('bash-')
      await right.locator('.xterm-helper-textarea').focus()
      await page.keyboard.press(`${primary}+Shift+,`)
      await expect.poll(() => right.getByRole('tab').count()).toBe(3)
      await expect.poll(() => right.locator('.xterm-rows').innerText()).toContain('bash-')
      expect(await left.getByRole('tab').count()).toBe(1)
      await compareOrRefreshGolden(join(expected, 'panels.expected.md'),
        await captureStableAria(page, '[data-sidebar-right-panel]', scaffold.workspaceCwd), mode)
      await bind(page, primary, 'Refresh current page', 'New terminal')
      await right.locator('.xterm-helper-textarea').focus()
      await page.keyboard.press(`${primary}+Shift+,`)
      expect(await right.getByRole('tab').count()).toBe(3)
      await left.getByRole('tab', { name: /Files/ }).click()
      await writeFile(join(scaffold.workspaceCwd, 'workspace', 't6-refresh.txt'), 'page refresh evidence\n')
      await left.getByRole('tab', { name: /Files/ }).focus()
      await page.keyboard.press(`${primary}+Shift+,`)
      await left.getByText('t6-refresh.txt', { exact: true }).waitFor()
      expect(await left.getByRole('button', { name: 'Reload', exact: true }).getAttribute('aria-keyshortcuts')).toBe(aria)
      await bind(page, primary, 'Close current page or window', 'Refresh current page')
      await right.getByRole('tab').last().focus()
      await page.keyboard.press(`${primary}+Shift+,`)
      await expect.poll(() => right.getByRole('tab').count()).toBe(2)
      expect(await left.getByRole('tab').count()).toBe(1)
      await panel.getByRole('button', { name: 'Exit fullscreen', exact: true }).click()
      await composer.click()
      await page.keyboard.press(`${primary}+Shift+,`)
      expect(await right.getByRole('tab').count()).toBe(2)
      await compareOrRefreshGolden(join(expected, 'page-actions.expected.md'),
        await captureStableAria(page, '[data-sidebar-right-panel]', scaffold.workspaceCwd), mode)
      const menuTab = left.getByRole('tab', { name: /Files/ })
      await menuTab.locator('[data-dockkit-tab-close]').focus()
      await page.getByRole('tooltip').filter({ hasText: 'Close' }).waitFor()
      for (let attempt = 0; attempt < 2; attempt++) {
        await menuTab.click({ button: 'right' })
        await page.getByRole('menu').waitFor()
        expect(await page.getByRole('tooltip').count()).toBe(0)
        expect(await page.getByRole('menuitem').getAttribute('aria-keyshortcuts')).toBeNull()
        if (attempt === 0) {
          await compareOrRefreshGolden(join(expected, 'tab-menu.expected.md'),
            await captureStableAria(page, '[data-dockkit-tab-menu]', scaffold.workspaceCwd), mode)
        } else {
          await page.getByRole('menuitem').focus()
        }
        await page.keyboard.press('Escape')
        await page.getByRole('menu').waitFor({ state: 'detached' })
        expect(await left.getByRole('tab').count()).toBe(1)
        expect(await right.getByRole('tab').count()).toBe(2)
      }
      expect(await menuTab.evaluate(tab => tab === document.activeElement)).toBe(true)
      expect(await menuTab.evaluate(tab => getComputedStyle(tab).outlineStyle)).toBe('none')
      await (closeFirst === 'right' ? right : left).getByRole('tab').last().focus()
      await page.keyboard.press(`${primary}+Shift+,`)
      await expect.poll(() => panel.getByRole('tab').count()).toBe(2)
      await page.keyboard.press(`${primary}+Shift+,`)
      await expect.poll(() => panel.getByRole('tab').count()).toBe(1)
      expect(await panel.locator('[data-dockkit-pane]').count()).toBe(1)
      expect(await panel.locator('[data-dockkit-pane]').evaluate(pane => pane === document.activeElement)).toBe(true)
      expect(await paneAppearance()).toEqual([plainPane])
      await page.keyboard.press(`${primary}+Shift+,`)
      await expect.poll(() => page.locator('[data-sidebar-right-open]').count()).toBe(0)
      await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
      await panel.getByRole('button', { name: 'Fullscreen', exact: true }).click()
      await panel.locator('[data-dockkit-split-button]').click()
      await expect.poll(() => panel.locator('[data-dockkit-pane]').count()).toBe(2)
      await (closeFirst === 'left' ? left : right).getByRole('tab').focus()
      await page.keyboard.press(`${primary}+Shift+,`)
      await expect.poll(() => panel.getByRole('tab').count()).toBe(1)
      expect(await panel.locator('[data-dockkit-pane]').evaluate(pane => pane === document.activeElement)).toBe(true)
      expect(await paneAppearance()).toEqual([plainPane])
      await compareOrRefreshGolden(join(expected, 'guide-close.expected.md'),
        await captureStableAria(page, '[data-sidebar-right-panel]', scaffold.workspaceCwd), mode)
      await page.keyboard.press(`${primary}+Shift+,`)
      await expect.poll(() => page.locator('[data-sidebar-right-open]').count()).toBe(0)
      expect(await composer.innerText()).toContain('T5 draft remains unsent')
      expect(agent.session.seq).toBe(eventCount)
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } finally { try { await context.close() } finally { await scaffold.close() } }
  })
})
