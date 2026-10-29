/** Context gestures against built plugins, seeded Sessions, and original files. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const GIF = Buffer.from('R0lGODdhMAAgAIEAAEtu5gAAAAAAAAAAACwAAAAAMAAgAEAIQQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmQEBADs=', 'base64')
async function menuLabels(menu: Locator): Promise<string[]> {
  return menu.getByRole('menuitem').evaluateAll(items => items.map((item) => {
    const copy = item.cloneNode(true) as HTMLElement
    for (const decoration of copy.querySelectorAll('[aria-hidden="true"]')) decoration.remove()
    return copy.textContent ?? ''
  }))
}
function fixture(title: string): string {
  const session = Session.create(SessionId('context-menus-source'))
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Show the output.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('session/title', { title, messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', { stream: [], turn: 1, step: 1, message: createAssistantMessage({
    content: [{ type: 'text', text: '[First file](first.txt#L2) [Second file](second.txt) [Website](https://example.com/path?q=1#fragment)\n\n![Original](original.gif) ![Remote](https://images.example/original.gif)\n\nCONTEXT_MENU_READY' }],
    source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }),
    ...session.snapshotEvents().map(event => JSON.stringify({ ...event, time: 1_000 + event.seq * 1_000 })), ''].join('\n')
}

describe.each(['MacIntel', 'Win32', 'Linux x86_64'])('web context menus on %s', (platform) => {
  let scaffold: WebScaffold, browser: Browser, page: Page
  let tripwire: ReturnType<typeof watchConsole>
  beforeAll(async () => {
    scaffold = await launchWebScaffold({ openInAppEnvironment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { SSH_CONNECTION: '10.0.0.2 55000 10.0.0.9 22' } }]) })
    await mkdir(join(scaffold.workspaceCwd, 'folder'))
    await scaffold.ctx.workspaceRegistry.create(join(scaffold.workspaceCwd, 'folder'), 'Menu workspace')
    await writeFile(join(scaffold.workspaceCwd, 'first.txt'), 'FIRST\nSECOND\nTHIRD\n')
    await writeFile(join(scaffold.workspaceCwd, 'second.txt'), 'SECOND FILE\n')
    await writeFile(join(scaffold.workspaceCwd, 'original.gif'), GIF)
    await seedSession(scaffold, fixture('Menu foreground'), 'context-menu-first')
    await seedSession(scaffold, fixture('Menu background'), 'context-menu-other')
    browser = await chromium.launch()
    const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'en-US', timezoneId: 'Asia/Shanghai' })
    await context.addInitScript((value) => { Object.defineProperty(navigator, 'platform', { value }) }, platform)
    page = await context.newPage()
    await page.setViewportSize({ width: 1291, height: 768 })
    tripwire = watchConsole(page)
    await page.route('https://images.example/original.gif', route => route.fulfill({ body: GIF, contentType: 'image/gif', headers: { 'access-control-allow-origin': '*' } }))
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto(scaffold.authenticatedUrl)
    await page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'Ungrouped' }).click()
    await page.locator('[data-row-key="session:context-menu-other"]').click()
    await page.locator('[data-row-key="session:context-menu-other"]').getByText('Menu background', { exact: true }).waitFor()
    await page.locator('[data-row-key="session:context-menu-first"]').click()
    await page.getByText('CONTEXT_MENU_READY', { exact: true }).waitFor()
  })
  afterAll(async () => { await browser?.close(); await scaffold?.close() })

  it('shares Session entries without selecting the background Session, and dismisses at viewport edges', async () => {
    onTestFailed(() => saveFailureShot(page, 'context-menus-session'))
    const background = page.locator('[data-row-key="session:context-menu-other"]')
    await background.click({ button: 'right' })
    const menu = page.getByRole('menu')
    await menu.getByRole('menuitem', { name: /Copy.*[Ii][Dd]/ }).waitFor()
    const names = await menuLabels(menu)
    expect(names.slice(0, 5)).toEqual(['Pin session', 'Rename', 'Fork session', 'Copy Session ID', 'Show in folder'])
    expect(names.at(-1)).toBe('Archive session')
    expect(await menu.getByRole('menuitem').evaluateAll(rows => rows.every(row => row.querySelector('svg[data-icon]')))).toBe(true)
    expect(await menu.getByRole('separator').count()).toBe(2)
    expect(await menu.getByRole('menuitem', { name: 'Archive session', exact: true }).evaluate(row =>
      getComputedStyle(row.parentElement!.parentElement!).borderTopWidth)).toBe('0px')
    const alignedSeparators = async () => {
      const bounds = await menu.evaluate((node) => {
        const row = node.querySelector<HTMLElement>('[role="menuitem"]')!
        const rect = row.getBoundingClientRect()
        const style = getComputedStyle(row)
        return {
          left: rect.left + Number.parseFloat(style.paddingLeft),
          right: rect.right - Number.parseFloat(style.paddingRight),
          lines: [...node.querySelectorAll('[role="separator"]')].map((line) => {
            const rect = line.getBoundingClientRect()
            return { left: rect.left, right: rect.right }
          }),
        }
      })
      for (const line of bounds.lines) {
        expect(line.left).toBeCloseTo(bounds.left, 1)
        expect(line.right).toBeCloseTo(bounds.right, 1)
      }
    }
    await alignedSeparators()
    await expect(names.join('\n') + '\n').toMatchFileSnapshot(join(import.meta.dirname, 'expected/context-menus/session.txt'))
    expect(names.some(name => name.includes('Rename'))).toBe(true)
    expect(await background.getAttribute('aria-selected')).toBe('false')
    await page.keyboard.press('Escape')
    await background.getByRole('button', { name: /actions/i }).click()
    await menu.getByRole('menuitem', { name: /Copy.*[Ii][Dd]/ }).waitFor()
    expect(await menuLabels(menu)).toEqual(names)
    await alignedSeparators()
    await background.getByRole('button', { name: /actions/i }).click()
    expect(await menu.count()).toBe(0)
    expect(await background.getAttribute('aria-selected')).toBe('false')
  })

  it('updates an open Session menu from another window’s shortcut preferences and still renames the captured row', async () => {
    onTestFailed(() => saveFailureShot(page, 'context-menus-live-shortcuts'))
    const other = await page.context().newPage()
    const key = 'dsh.keybindings.v1'
    const original = await page.evaluate(key => localStorage.getItem(key), key)
    try {
      await other.goto(scaffold.authenticatedUrl)
      await other.getByRole('button', { name: 'Search sessions', exact: true }).waitFor()
      const background = page.locator('[data-row-key="session:context-menu-other"]')
      await background.click({ button: 'right' })
      const item = page.getByRole('menuitem', { name: 'Rename', exact: true })
      await item.waitFor()
      const popup = await page.getByRole('menu').elementHandle()
      const initial = await item.getAttribute('aria-keyshortcuts')
      await other.evaluate((key) => {
        localStorage.setItem(key, JSON.stringify({ schemaVersion: 2, profiles: {
          'web:macos': { 'session.rename': { code: 'Comma', modifiers: ['primary', 'shift'] } },
          'web:windows': { 'session.rename': { code: 'Comma', modifiers: ['primary', 'shift'] } },
          'web:linux': { 'session.rename': { code: 'Comma', modifiers: ['primary', 'shift'] } },
        } }))
      }, key)
      await expect.poll(() => item.getAttribute('aria-keyshortcuts')).toBe(platform === 'MacIntel' ? 'Shift+Meta+,' : 'Control+Shift+,')
      expect(await item.getAttribute('aria-keyshortcuts')).not.toBe(initial)
      expect(await popup!.evaluate(element => element.isConnected)).toBe(true)
      expect(await background.getAttribute('aria-selected')).toBe('false')
      await item.click()
      const rename = page.getByRole('dialog', { name: 'Rename session', exact: true })
      expect(await rename.getByLabel('Session name').inputValue()).toBe('Menu background')
      await rename.getByRole('button', { name: 'Cancel', exact: true }).click()
      expect(await background.getAttribute('aria-selected')).toBe('false')
      await background.click({ button: 'right' })
      await item.waitFor()
      await other.evaluate((key) => {
        localStorage.setItem(key, JSON.stringify({ schemaVersion: 2, profiles: {
          'web:macos': { 'session.rename': null }, 'web:windows': { 'session.rename': null }, 'web:linux': { 'session.rename': null },
        } }))
      }, key)
      await expect.poll(() => item.getAttribute('aria-keyshortcuts')).toBeNull()
      await other.evaluate(({ key, original }) => {
        if (original === null) localStorage.removeItem(key)
        else localStorage.setItem(key, original)
      }, { key, original })
      await expect.poll(() => item.getAttribute('aria-keyshortcuts')).toBe(initial)
      await page.keyboard.press('Escape')
    } finally {
      const cancel = page.getByRole('dialog', { name: 'Rename session', exact: true }).getByRole('button', { name: 'Cancel', exact: true })
      if (await cancel.isVisible()) await cancel.click()
      await page.keyboard.press('Escape')
      await other.evaluate(({ key, original }) => {
        if (original === null) localStorage.removeItem(key)
        else localStorage.setItem(key, original)
      }, { key, original })
      await other.close()
    }
  })

  it('shares Workspace menus and keeps folder gestures independent from expansion', async () => {
    onTestFailed(() => saveFailureShot(page, 'context-menus-workspace'))
    const workspace = page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'Menu workspace' })
    const expanded = await workspace.getAttribute('aria-expanded')
    await workspace.click({ button: 'right' })
    const menu = page.getByRole('menu')
    await menu.getByRole('menuitem', { name: 'Rename', exact: true }).waitFor()
    const names = await menuLabels(menu)
    expect(names).toEqual(['Rename', 'Show in folder', 'Delete workspace'])
    expect(await menu.locator('svg[data-icon]').count()).toBe(3)
    expect(await workspace.getAttribute('aria-expanded')).toBe(expanded)
    await page.keyboard.press('Escape')
    await workspace.getByRole('button', { name: /actions/i }).click()
    await menu.getByRole('menuitem', { name: 'Rename', exact: true }).waitFor()
    expect(await menuLabels(menu)).toEqual(names)
    await menu.getByRole('menuitem', { name: 'Rename', exact: true }).click()
    await page.getByRole('dialog').waitFor()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await workspace.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Delete workspace', exact: true }).click()
    await page.getByRole('dialog', { name: 'Delete workspace', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.locator('[data-sidebar-right-expand]').click()
    await page.locator('[data-sidebar-right-guide-entry="files"]').click()
    await page.locator('[data-files-state="tree"]').waitFor()
    const folder = page.locator('[data-files-entry="directory"]').filter({ hasText: 'folder' }).getByRole('button').first()
    await folder.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Copy folder path', exact: true }).waitFor()
    expect(await menuLabels(menu)).toEqual(['Show in folder', 'Copy folder path'])
    expect(await folder.getAttribute('aria-expanded')).toBe('false')
    await menu.getByRole('menuitem', { name: 'Copy folder path', exact: true }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(join(scaffold.workspaceCwd, 'folder'))
    await page.getByText('Copied', { exact: true }).waitFor()
    await expect(names.join('\n') + '\n').toMatchFileSnapshot(join(import.meta.dirname, 'expected/context-menus/workspace.txt'))
  })

  it('prepares complete menus, anchors above the frame inset, and treats repeated gestures as separate occurrences', async () => {
    onTestFailed(() => saveFailureShot(page, 'context-menus-gestures'))
    const file = page.getByRole('button', { name: 'First file', exact: true })
    await file.focus()
    await page.keyboard.press('Shift+F10')
    await page.getByRole('menuitem', { name: 'Copy file path', exact: true }).waitFor()
    await page.keyboard.press('End')
    expect(await page.getByRole('menuitem', { name: 'Save as…', exact: true }).count()).toBe(0)
    expect(await page.getByRole('menuitem', { name: 'Download', exact: true }).evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('ArrowUp')
    expect(await page.getByRole('menuitem', { name: 'Copy file path', exact: true }).evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(join(scaffold.workspaceCwd, 'first.txt'))
    expect(await file.evaluate(element => element === document.activeElement)).toBe(true)
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--dsh-frame-overlay-top', '100px')
      const frames: number[] = []
      const observer = new MutationObserver(() => {
        for (const menu of document.querySelectorAll('[role="menu"]')) frames.push(menu.querySelectorAll('[role="menuitem"]').length)
      })
      observer.observe(document.body, { subtree: true, childList: true })
      Object.assign(window, { menuObservation: { frames, observer } })
    })
    const header = page.locator('[data-session-title]').first()
    const target = await header.count() > 0 ? header : page.getByText('Menu foreground', { exact: true }).last()
    const box = (await target.boundingBox())!
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    await page.mouse.click(point.x, point.y, { button: 'right' })
    await page.getByRole('menuitem', { name: /Copy.*[Ii][Dd]/ }).waitFor()
    expect((await page.getByRole('menu').boundingBox())!.y).toBeLessThan(100)
    await page.mouse.click(point.x + 1, point.y, { button: 'right' })
    expect(await page.getByRole('menu').count()).toBe(0)
    await file.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Copy file path', exact: true }).waitFor()
    const previous = await page.getByRole('menu').elementHandle()
    await page.getByRole('link', { name: 'Website', exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Copy link address', exact: true }).waitFor()
    expect(await previous!.evaluate(element => element.isConnected)).toBe(false)
    await page.keyboard.press('Escape')
    const counts = await page.evaluate(() => {
      const observed = (window as Window & { menuObservation?: { frames: number[]; observer: MutationObserver } }).menuObservation
      if (observed === undefined) throw new Error('Menu observer not installed')
      observed.observer.disconnect()
      document.documentElement.style.removeProperty('--dsh-frame-overlay-top')
      return observed.frames
    })
    expect(counts.length).toBeGreaterThan(0)
    expect(counts.every(count => count > 0)).toBe(true)
  })

  it('preserves file line navigation, URL text, image format, and existing tab close actions', async () => {
    onTestFailed(() => saveFailureShot(page, 'context-menus-content'))
    const file = page.getByRole('button', { name: 'First file', exact: true })
    await file.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Download', exact: true }).waitFor()
    expect(await page.getByRole('menuitem', { name: 'Save as…', exact: true }).count()).toBe(0)
    const fileDownloadPromise = page.waitForEvent('download')
    await page.getByRole('menuitem', { name: 'Download', exact: true }).click()
    const fileDownload = await fileDownloadPromise
    expect(fileDownload.suggestedFilename()).toBe('first.txt')
    expect(await readFile(await fileDownload.path(), 'utf8')).toBe('FIRST\nSECOND\nTHIRD\n')
    const started = page.getByRole('alert').filter({ hasText: 'Download started' })
    await started.waitFor()
    expect(await started.getByRole('button', { name: /Show in/ }).count()).toBe(0)
    await file.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Open in sidebar', exact: true }).click()
    await page.locator('[data-document-preview]').getByText('SECOND', { exact: true }).waitFor()
    // The same link moves that tab into a floating panel and back, delivering its line each time.
    const floating = page.locator('[data-sidebar-right-session]:not([hidden]) [data-dockkit-float]')
    const dockedFirst = page.locator('[data-rightbar-col] [data-dockkit-pane] [data-dockkit-tab]', { hasText: 'first.txt' })
    await file.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Open in floating panel', exact: true }).click()
    await expect.poll(() => floating.count()).toBe(1)
    await floating.locator('[data-textpreview-target="2"]', { hasText: 'SECOND' }).waitFor()
    await expect.poll(() => dockedFirst.count()).toBe(0)
    // The new panel covers the link, so the keyboard raises its menu.
    await file.focus()
    await page.keyboard.press('Shift+F10')
    await page.getByRole('menuitem', { name: 'Open in floating panel', exact: true }).click()
    await floating.locator('[data-textpreview-target="2"]').waitFor()
    expect(await floating.count()).toBe(1)
    await file.focus()
    await page.keyboard.press('Shift+F10')
    await page.getByRole('menuitem', { name: 'Open in sidebar', exact: true }).click()
    await expect.poll(() => floating.count()).toBe(0)
    await expect.poll(() => dockedFirst.count()).toBe(1)
    await page.locator('[data-rightbar-col] [data-textpreview-target="2"]').waitFor()
    await page.getByRole('link', { name: 'Website', exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Copy link address', exact: true }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://example.com/path?q=1#fragment')
    await page.getByRole('img', { name: 'Original', exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Download', exact: true }).waitFor()
    await expect((await menuLabels(page.getByRole('menu'))).join('\n') + '\n')
      .toMatchFileSnapshot(join(import.meta.dirname, 'expected/context-menus/image.txt'))
    expect(await page.getByRole('menuitem', { name: 'Show in folder', exact: true }).count()).toBe(1)
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('menuitem', { name: 'Download', exact: true }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename().endsWith('.gif')).toBe(true)
    await page.getByRole('alert').filter({ hasText: 'Download started' }).waitFor()
    const path = await download.path()
    expect(path).not.toBeNull()
    if (path === null) throw new Error('Browser download unavailable')
    expect(await readFile(path)).toEqual(GIF)
    await page.getByRole('img', { name: 'Original', exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Copy image', exact: true }).click()
    await page.getByText('Copied', { exact: true }).waitFor()
    expect(await page.evaluate(async () => (await navigator.clipboard.read()).some(item => item.types.includes('image/png')))).toBe(true)
    await page.getByRole('img', { name: 'Remote', exact: true }).click({ button: 'right' })
    expect(await page.getByRole('menuitem', { name: 'Show in folder', exact: true }).isDisabled()).toBe(true)
    const remoteDownloadPromise = page.waitForEvent('download')
    await page.getByRole('menuitem', { name: 'Download', exact: true }).click()
    const remoteDownload = await remoteDownloadPromise
    expect(await readFile((await remoteDownload.path()))).toEqual(GIF)
    await page.getByRole('img', { name: 'Remote', exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Copy image', exact: true }).click()
    await page.getByText('Copied', { exact: true }).waitFor()
    expect(await page.evaluate(async () => (await navigator.clipboard.read()).some(item => item.types.includes('image/png')))).toBe(true)
    await page.getByRole('button', { name: 'Second file', exact: true }).click()
    await page.locator('[data-document-preview]').getByText('SECOND FILE', { exact: true }).waitFor()
    const firstTab = page.locator('[role="tab"]').filter({ hasText: 'first.txt' }).first()
    await firstTab.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Close', exact: true }).waitFor()
    expect(await page.getByRole('menuitem', { name: 'Close', exact: true }).locator('svg[data-icon]').count()).toBe(1)
    await page.getByRole('menuitem', { name: 'Close', exact: true }).click()
    expect(await firstTab.count()).toBe(0)
    expect(await page.locator('[data-document-preview]').getByText('SECOND FILE', { exact: true }).count()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
  })
  it('keeps original preview open when dismissing its menu and fits both themes at the viewport edge', async () => {
    onTestFailed(() => saveFailureShot(page, 'context-menus-preview'))
    await page.getByRole('button', { name: 'View full image: Original', exact: true }).click()
    const preview = page.getByRole('dialog')
    await preview.waitFor()
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await preview.getByRole('img').evaluate(element => element.dispatchEvent(new MouseEvent('contextmenu', { clientX: 1270, clientY: 735, bubbles: true })))
      const menu = page.getByRole('menu')
      await menu.getByRole('menuitem', { name: 'Copy image', exact: true }).waitFor()
      expect(await menu.getByRole('menuitem').evaluateAll(rows => rows.every(row => row.querySelector('svg[data-icon]')))).toBe(true)
      const box = await menu.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.x).toBeGreaterThan(1000)
      expect(box!.y).toBeGreaterThan(500)
      expect(box!.x + box!.width).toBeLessThanOrEqual(1291)
      expect(box!.y + box!.height).toBeLessThanOrEqual(768)
      await saveFailureShot(page, `context-menus-${colorScheme}`)
      await page.keyboard.press('Escape')
      expect(await menu.count()).toBe(0)
      expect(await preview.count()).toBe(1)
    }
    await page.keyboard.press('Escape')
    expect(await preview.count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  })

  it('offers completed Desktop destinations as toast text actions without enabling remote-image menu reveal', async () => {
    const native = await browser.newPage({ viewport: { width: 1291, height: 768 }, locale: 'en-US' })
    const opened = vi.spyOn(scaffold.ctx.sessionController, 'openWorkspacePath').mockResolvedValue({ opened: true })
    try {
      const destinations = { download: join(scaffold.workspaceCwd, 'downloaded.gif'), saveAs: join(scaffold.workspaceCwd, 'saved.txt') }
      await native.addInitScript(({ platform, destinations }) => {
        Object.defineProperty(navigator, 'platform', { value: platform })
        Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1, fileActions: {
          save: async ({ mode }: { mode: 'download' | 'saveAs' }) => ({ status: 'saved', path: destinations[mode] }),
        } } })
      }, { platform, destinations })
      await native.route('https://images.example/original.gif', route => route.fulfill({ body: GIF, contentType: 'image/gif' }))
      await native.goto(scaffold.authenticatedUrl)
      await native.evaluate((platform) => {
        document.documentElement.dataset.platform = platform === 'MacIntel' ? 'darwin' : platform === 'Win32' ? 'win32' : 'linux'
      }, platform)
      const group = native.locator('[data-row-key^="workspace:"]').filter({ hasText: 'Ungrouped' })
      if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
      await native.locator('[data-row-key="session:context-menu-first"]').click()
      await native.getByText('CONTEXT_MENU_READY', { exact: true }).waitFor()
      for (const [mode, label, text, theme] of [
        ['download', 'Download', 'Download complete', 'light'],
        ['saveAs', 'Save as…', 'Saved', 'dark'],
      ] as const) {
        await native.emulateMedia({ colorScheme: theme })
        const trigger = mode === 'download'
          ? native.getByRole('img', { name: 'Remote', exact: true })
          : native.getByRole('button', { name: 'First file', exact: true })
        await trigger.click({ button: 'right' })
        await native.getByRole('menuitem', { name: label, exact: true }).click()
        const notice = native.getByRole('alert').filter({ hasText: text })
        const action = notice.getByRole('button', { name: platform === 'MacIntel' ? 'Show in Finder' : 'Show in folder', exact: true })
        await action.click()
        await notice.waitFor({ state: 'hidden' })
        await expect.poll(() => opened.mock.calls.at(-1)?.[0]).toEqual({ path: destinations[mode], action: 'reveal' })
      }
      expect(opened).toHaveBeenCalledTimes(2)
      await native.getByRole('img', { name: 'Remote', exact: true }).click({ button: 'right' })
      const reveal = native.getByRole('menuitem', { name: 'Show in folder', exact: true })
      await reveal.waitFor()
      expect(await reveal.isDisabled()).toBe(true)
    } finally {
      await native.close()
      opened.mockRestore()
    }
  })
})
