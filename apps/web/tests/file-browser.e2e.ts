/**
 * The workspace file browser over the shipped Web composition, a real
 * workspace and the real dock, across docked and floating panes and a
 * phone-width viewport. The package README owns the behavior asserted here.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator, type Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { createLaunchEnvironmentSnapshot, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'

/** Press at the centre of `from`, travel in steps, and release at `to`. */
async function drag(page: Page, from: Locator, to: { x: number; y: number }): Promise<void> {
  const box = await from.boundingBox()
  if (box === null) throw new Error('drag source is not rendered')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.mouse.up()
}

/** Resize through the hit-tested corner, rather than dispatching events through covering content. */
async function resizeFloat(page: Page, panel: Locator, width: number, height: number): Promise<void> {
  const before = await panel.boundingBox()
  const handle = panel.locator('[data-dockkit-float-resize]')
  const grip = await handle.boundingBox()
  if (before === null || grip === null) throw new Error('floating resize geometry is not rendered')
  await expect.poll(() => handle.evaluate((node) => {
    const box = node.getBoundingClientRect()
    return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
  })).toBe(true)
  await drag(page, handle, {
    x: grip.x + grip.width / 2 + width - before.width,
    y: grip.y + grip.height / 2 + height - before.height,
  })
  await expect.poll(async () => {
    const after = await panel.boundingBox()
    return after === null ? Infinity : Math.max(Math.abs(after.width - width), Math.abs(after.height - height))
  }).toBeLessThanOrEqual(1)
}

/** Boot the shipped Web composition into a settled Session whose workspace holds `src/{a,b,c}.txt`, `README.md`, and `focus.html`. */
async function openWorkspace(
  shot: string,
  openInAppEnvironment?: LaunchEnvironmentSnapshot,
): Promise<{ page: Page; input: Locator; errors: ReturnType<typeof watchConsole> }> {
  const scaffold = await launchWebScaffold({
    replayFixture: fileURLToPath(new URL('../../../snapshots/web/lifecycle-chrome/session.v3.jsonl', import.meta.url)),
    paceMs: 5, compareReplaySession: false, ...openInAppEnvironment === undefined ? {} : { openInAppEnvironment },
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1680, height: 1000 } })
  await page.addInitScript(() => { Object.defineProperty(navigator, 'platform', { value: 'Win32' }) })
  onTestFailed(() => saveFailureShot(page, shot))
  const errors = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspace(page, scaffold.workspaceCwd, 'test workspace')
  const settled = scaffold.whenTurnSettled()
  const input = page.locator('[data-composer-input]').first()
  await input.fill('Reply with the single word LIGHTHOUSE and stop.')
  await input.press('Enter')
  const session = await settled
  const cwd = scaffold.ctx.agents.get(session)?.session.header.cwd
  if (cwd === undefined) throw new Error('Session has no workspace')
  await mkdir(join(cwd, 'src'))
  const lines = (name: string): string => Array.from({ length: 300 }, (_, index) => `${name} line ${index}\n`).join('')
  await writeFile(join(cwd, 'src', 'a.txt'), lines('a'))
  await writeFile(join(cwd, 'src', 'b.txt'), lines('b'))
  await writeFile(join(cwd, 'src', 'c.txt'), lines('c'))
  await writeFile(join(cwd, 'README.md'), '# Readme\n')
  await writeFile(join(cwd, 'focus.html'), '<!doctype html><button>Preview focus</button>')
  await page.getByText('LIGHTHOUSE', { exact: true }).waitFor()
  return { page, input, errors }
}

it('browses workspace files in tabs that share one pane tree', async () => {
  const { page, input, errors } = await openWorkspace('web-e2e-file-browser')
  await page.locator('[data-sidebar-right-expand]').click()
  const column = page.locator('[data-rightbar-col]')
  const layout = await page.addStyleTag({ content: '[data-sidebar-right-panel] { width: 960px !important; }' })
  await column.locator('[data-sidebar-right-guide-entry="files"]').click()
  const tabs = column.locator('[data-dockkit-tab]')
  const navigator = column.locator('[data-files-navigator]:visible')
  const toggle = column.locator('[data-files-navigator-toggle]:visible')
  const body = column.locator('[data-textpreview-state]:visible [data-textpreview-body]')
  const path = column.locator('[data-textpreview-path]:visible')
  const current = navigator.locator('[aria-current="true"]')
  await column.locator('[data-files-page]').waitFor()
  // The page's tree fills the page and stays shown: no toggle, no resize edge, and Escape leaves it.
  await navigator.waitFor()
  expect(await toggle.count()).toBe(0)
  expect(await navigator.getByRole('separator').count()).toBe(0)
  const pageContent = await column.locator('[data-files-content]').boundingBox()
  const pageTree = await navigator.boundingBox()
  if (pageContent === null || pageTree === null) throw new Error('files page geometry is not rendered')
  expect(Math.abs(pageTree.width - pageContent.width)).toBeLessThanOrEqual(1)
  await navigator.getByRole('button', { name: 'src', exact: true }).focus()
  await page.keyboard.press('Escape')
  expect(await navigator.count()).toBe(1)
  const pageTab = await tabs.last().getAttribute('data-dockkit-tab')
  const tabCount = await tabs.count()

  // The page stays and opens the first file in a new tab after it in its pane, where the file's tree starts hidden.
  await navigator.getByRole('button', { name: 'src', exact: true }).click()
  await navigator.getByRole('button', { name: 'a.txt', exact: true }).click()
  await expect.poll(() => path.textContent()).toContain('a.txt')
  expect(await tabs.count()).toBe(tabCount + 1)
  expect(await column.locator(`[data-dockkit-tab="${pageTab}"]`).count()).toBe(1)
  expect(await column.locator('[data-dockkit-pane]').count()).toBe(1)
  expect(await toggle.getAttribute('aria-expanded')).toBe('false')
  // Picking the open file again from the page switches back to its tab, which is the visible change, so nothing glows.
  const flash = column.locator('[data-sidebar-right-flash]')
  await column.locator(`[data-dockkit-tab="${pageTab}"]`).click()
  await navigator.getByRole('button', { name: 'a.txt', exact: true }).click()
  await expect.poll(() => path.textContent()).toContain('a.txt')
  expect(await flash.count()).toBe(0)
  expect(await tabs.count()).toBe(tabCount + 1)
  // The preview's toggle shows the pane's tree without changing the files page.
  await toggle.click()
  await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
  await expect.poll(() => current.textContent()).toBe('a.txt')
  // Picking the open file again while its glow plays restarts the glow, which then lasts its whole 600ms animation.
  const openFile = navigator.getByRole('button', { name: 'a.txt', exact: true })
  await openFile.click()
  // A glow replaced before it starts is dropped without a cancellation, so the repeat waits until the first one plays.
  await expect.poll(() => flash.evaluate(pane => pane.getAnimations({ subtree: true })
    .some(glow => Number(glow.currentTime) > 100))).toBe(true)
  const first = await flash.getAttribute('data-sidebar-right-flash')
  const repeat = await openFile.evaluate((button) => {
    const pane = button.closest<HTMLElement>('[data-sidebar-right-flash]')
    if (pane === null) throw new Error('the open file is outside the glowing pane')
    const since = performance.now()
    return new Promise<{ mark: string | undefined; lasted: number }>((resolve) => {
      let mark: string | undefined
      new MutationObserver((_, observer) => {
        mark = pane.dataset.sidebarRightFlash ?? mark
        if (pane.dataset.sidebarRightFlash !== undefined) return
        observer.disconnect()
        resolve({ mark, lasted: performance.now() - since })
      }).observe(pane, { attributes: true, attributeFilter: ['data-sidebar-right-flash'] })
      ;(button as HTMLElement).click()
    })
  })
  expect(repeat.mark).toBe(first === 'odd' ? 'even' : 'odd')
  expect(repeat.lasted).toBeGreaterThan(450)

  // In a wide row the tree is a card beside the preview: the body narrows by the card and its 8px margins, and still scrolls.
  await column.locator('[data-files-navigator-mode="push"]:visible').waitFor()
  const wideRow = await body.locator('..').boundingBox()
  const wideBody = await body.boundingBox()
  const wideTree = await navigator.boundingBox()
  if (wideRow === null || wideBody === null || wideTree === null) throw new Error('preview row is not rendered')
  expect(Math.abs(wideBody.width - (wideRow.width - wideTree.width - 16))).toBeLessThanOrEqual(1)
  expect(wideTree.x).toBeGreaterThanOrEqual(wideBody.x + wideBody.width + 7)
  await expect.poll(() => body.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
  await page.mouse.move(wideBody.x + 40, wideBody.y + 80)
  await page.mouse.wheel(0, 400)
  await expect.poll(() => body.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
  // A press on the preview leaves the tree shown.
  await page.mouse.click(wideBody.x + 40, wideBody.y + 80)
  expect(await toggle.getAttribute('aria-expanded')).toBe('true')

  await toggle.focus()
  // In dark mode the card takes the filled tree's background, with a soft white shadow.
  const theme = await page.locator('body').getAttribute('data-ds-dark-theme')
  try {
    await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', '') })
    const cardPaint = await navigator.evaluate(node => ({
      background: getComputedStyle(node).backgroundColor,
      shadow: getComputedStyle(node).boxShadow,
    }))
    expect(cardPaint.shadow).toContain('color(srgb 1 1 1 / 0.08)')
    await layout.evaluate((node) => { node.textContent = '[data-sidebar-right-panel] { width: 360px !important; }' })
    await column.locator('[data-files-navigator-mode="fill"]:visible').waitFor()
    expect(await navigator.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(cardPaint.background)
    await layout.evaluate((node) => { node.textContent = '[data-sidebar-right-panel] { width: 960px !important; }' })
    await navigator.getByRole('separator').waitFor()
  } finally {
    await page.evaluate((value) => {
      if (value === null) document.body.removeAttribute('data-ds-dark-theme')
      else document.body.setAttribute('data-ds-dark-theme', value)
    }, theme)
  }

  // The reader scrolls the preview and widens the tree.
  await body.evaluate((node) => { node.scrollTop = 900 })
  const edge = navigator.getByRole('separator', { name: 'Resize file tree' })
  const grip = await edge.boundingBox()
  if (grip === null) throw new Error('resize edge is not rendered')
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 120)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2 - 40, grip.y + 120, { steps: 4 })
  await page.mouse.up()
  await expect.poll(() => edge.getAttribute('aria-valuenow')).toBe('300')

  // The files page appends another preview; it shares the pane's tree choice and width.
  await column.locator(`[data-dockkit-tab="${pageTab}"]`).click()
  await navigator.getByRole('button', { name: 'b.txt', exact: true }).click()
  await column.locator(`[data-dockkit-tab="${pageTab}"]`).hover()
  await column.locator(`[data-dockkit-tab-close="${pageTab}"]`).click()
  await expect.poll(() => path.textContent()).toContain('b.txt')
  expect(await tabs.count()).toBe(tabCount + 1)
  await expect.poll(() => current.textContent()).toBe('b.txt')
  expect(await navigator.getByRole('button', { name: 'src', exact: true }).getAttribute('aria-expanded')).toBe('true')
  expect(await edge.getAttribute('aria-valuenow')).toBe('300')

  // Clicking an open file returns to its tab, where the reader left off.
  await navigator.getByRole('button', { name: 'a.txt', exact: true }).click()
  await expect.poll(() => path.textContent()).toContain('a.txt')
  expect(await tabs.count()).toBe(tabCount + 1)
  await expect.poll(() => body.evaluate(node => node.scrollTop)).toBe(900)
  await expect.poll(() => current.textContent()).toBe('a.txt')

  // Workspace navigation has one open action; the row's shared context menu does not offer a second new-tab route.
  await navigator.getByRole('button', { name: 'a.txt', exact: true }).click({ button: 'right' })
  const rowMenu = page.locator('[data-context-menu][role="menu"]')
  await rowMenu.waitFor()
  expect(await page.getByRole('menuitem', { name: 'Open in new tab', exact: true }).count()).toBe(0)
  await page.keyboard.press('Escape')
  await rowMenu.waitFor({ state: 'detached' })

  // A narrower pane floats the tree over the preview below its header; the body keeps the row's width and still scrolls.
  await layout.evaluate((node) => { node.textContent = '[data-sidebar-right-panel] { width: 460px !important; }' })
  await column.locator('[data-files-navigator-mode="overlay"]:visible').waitFor()
  const header = await path.locator('..').boundingBox()
  const tree = await navigator.boundingBox()
  if (header === null || tree === null) throw new Error('browser geometry is not rendered')
  expect(tree.y).toBeGreaterThanOrEqual(header.y + header.height - 1)
  const middleRow = await body.locator('..').boundingBox()
  const preview = await body.boundingBox()
  if (middleRow === null || preview === null) throw new Error('preview body is not rendered')
  expect(preview.width).toBeGreaterThan(middleRow.width - 1)
  await body.evaluate((node) => { node.scrollTop = 0 })
  await page.mouse.move(preview.x + 20, preview.y + 80)
  await page.mouse.wheel(0, 400)
  await expect.poll(() => body.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
  await navigator.getByRole('button', { name: 'b.txt', exact: true }).click()
  await expect.poll(() => current.textContent()).toBe('b.txt')
  // The keyboard stays in the tree the revealed tab draws, so Escape reaches the row.
  await expect.poll(() => current.evaluate(node => node === document.activeElement)).toBe(true)
  await page.keyboard.press('Escape')
  await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
  expect(await navigator.count()).toBe(0)
  expect(await toggle.evaluate(node => node === document.activeElement)).toBe(true)

  // A row narrower than 400px is filled by the tree, without the resize edge; Escape still closes it.
  await layout.evaluate((node) => { node.textContent = '[data-sidebar-right-panel] { width: 360px !important; }' })
  await toggle.click()
  await column.locator('[data-files-navigator-mode="fill"]:visible').waitFor()
  const narrowRow = await body.locator('..').boundingBox()
  const narrowTree = await navigator.boundingBox()
  if (narrowRow === null || narrowTree === null) throw new Error('narrow geometry is not rendered')
  expect(Math.abs(narrowTree.width - narrowRow.width)).toBeLessThanOrEqual(1)
  expect(await navigator.getByRole('separator').count()).toBe(0)
  expect(await body.evaluate(node => getComputedStyle(node).visibility)).toBe('hidden')
  await toggle.focus()
  await page.keyboard.press('Tab')
  expect(await body.evaluate(node => node.contains(document.activeElement))).toBe(false)
  expect(await navigator.evaluate(node => node.contains(document.activeElement))).toBe(true)
  await navigator.getByRole('button', { name: 'b.txt', exact: true }).focus()
  await page.keyboard.press('Escape')
  await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')

  // A phone-width viewport fills the row below the header with the tree, without the resize edge, and opening a file hides it.
  // The resize edge holding the keyboard when the viewport narrows hands it to the tree.
  await layout.evaluate((node) => { node.textContent = '' })
  await toggle.click()
  const resizeEdge = navigator.getByRole('separator', { name: 'Resize file tree' })
  await resizeEdge.focus()
  expect(await resizeEdge.evaluate(node => node === document.activeElement)).toBe(true)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => navigator.evaluate(node => node.contains(document.activeElement)
    && !document.activeElement?.hasAttribute('data-files-navigator-resize'))).toBe(true)
  // The panel slides into its fullscreen place, so the geometry is read once it settles.
  await expect.poll(async () => {
    const row = await body.locator('..').boundingBox()
    const filled = await navigator.boundingBox()
    return row === null || filled === null ? Number.POSITIVE_INFINITY : Math.abs(filled.width - row.width)
  }).toBeLessThanOrEqual(1)
  expect(await navigator.getByRole('separator').count()).toBe(0)
  await navigator.getByRole('button', { name: 'a.txt', exact: true }).click()
  await expect.poll(() => path.textContent()).toContain('a.txt')
  await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
  expect(await navigator.count()).toBe(0)
  await page.setViewportSize({ width: 1680, height: 1000 })
  await layout.evaluate((node) => { node.textContent = '[data-sidebar-right-panel] { width: 460px !important; }' })

  // The workspace command shows the pane's tree, moves the keyboard into it, and keeps the file.
  await input.focus()
  await page.keyboard.press('Control+Alt+p')
  await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
  await expect.poll(() => current.evaluate(node => node === document.activeElement)).toBe(true)
  await expect.poll(() => path.textContent()).toContain('a.txt')
  expect(await tabs.count()).toBe(tabCount + 1)
  await layout.evaluate((node) => { node.textContent = '[data-sidebar-right-panel] { width: 960px !important; }' })

  await column.locator('[data-dockkit-add-tab]').click()
  await column.locator('[data-sidebar-right-guide-entry="files"]').click()
  const htmlFilesTab = await tabs.filter({ hasText: 'Files' }).getAttribute('data-dockkit-tab')
  await navigator.getByRole('button', { name: 'focus.html', exact: true }).click()
  await column.locator(`[data-dockkit-tab="${htmlFilesTab}"]`).hover()
  await column.locator(`[data-dockkit-tab-close="${htmlFilesTab}"]`).click()
  await expect.poll(() => path.textContent()).toContain('focus.html')
  const frame = body.locator('[data-html-preview]')
  await frame.waitFor()
  for (const narrow of ['row', 'viewport'] as const) {
    await toggle.focus()
    if (narrow === 'row') await layout.evaluate((node) => { node.textContent = '[data-sidebar-right-panel] { width: 360px !important; }' })
    else await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => body.evaluate(node => getComputedStyle(node).visibility)).toBe('hidden')
    await page.keyboard.press('Tab')
    expect(await navigator.evaluate(node => node.contains(document.activeElement))).toBe(true)
    expect(await body.evaluate(node => node.contains(document.activeElement))).toBe(false)
    await layout.evaluate((node) => { node.textContent = '[data-sidebar-right-panel] { width: 960px !important; }' })
    await page.setViewportSize({ width: 1680, height: 1000 })
    await expect.poll(() => body.evaluate(node => getComputedStyle(node).visibility)).toBe('visible')
    await frame.focus()
    if (narrow === 'row') await layout.evaluate((node) => { node.textContent = '[data-sidebar-right-panel] { width: 360px !important; }' })
    else await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => body.evaluate(node => getComputedStyle(node).visibility)).toBe('hidden')
    expect(await toggle.getAttribute('aria-expanded')).toBe('true')
    await expect.poll(() => navigator.evaluate(node => node.contains(document.activeElement))).toBe(true)
    expect(await frame.evaluate(node => document.activeElement === node)).toBe(false)
    await layout.evaluate((node) => { node.textContent = '[data-sidebar-right-panel] { width: 960px !important; }' })
    await page.setViewportSize({ width: 1680, height: 1000 })
    await expect.poll(() => body.evaluate(node => getComputedStyle(node).visibility)).toBe('visible')
  }

  // A preview dragged out into a floating panel keeps where the reader was in it.
  await tabs.filter({ hasText: 'b.txt' }).click()
  await expect.poll(() => path.textContent()).toContain('b.txt')
  await body.evaluate((node) => { node.scrollTop = 600 })
  await expect.poll(() => body.evaluate(node => node.scrollTop)).toBe(600)
  const surface = await page.locator('[data-dockkit-surface]').first().boundingBox()
  if (surface === null) throw new Error('surface is not rendered')
  await drag(page, tabs.filter({ hasText: 'b.txt' }), { x: surface.x - 240, y: surface.y + surface.height / 2 })
  const float = page.locator('[data-sidebar-right-session]:not([hidden]) [data-dockkit-float]')
  await expect.poll(() => float.count()).toBe(1)
  const floatPath = float.locator('[data-textpreview-path]')
  await floatPath.waitFor()
  const floatBody = float.locator('[data-textpreview-state] [data-textpreview-body]')
  await expect.poll(() => floatBody.evaluate(node => node.scrollTop)).toBe(600)
  // The panel is a new pane, so its tree starts hidden; shown, it draws there too, and the panel keeps its resize handle.
  const floatToggle = float.locator('[data-files-navigator-toggle]')
  expect(await floatToggle.getAttribute('aria-expanded')).toBe('false')
  expect(await float.locator('[data-files-navigator]').count()).toBe(0)
  await floatToggle.click()
  const before = await float.boundingBox()
  if (before === null) throw new Error('float is not rendered')
  const resize = float.locator('[data-dockkit-float-resize]')
  await drag(page, resize, { x: before.x + Math.max(before.width + 80, 560), y: before.y + before.height + 60 })
  await expect.poll(async () => (await float.boundingBox())?.width ?? before.width).toBeGreaterThan(before.width)
  // Wide enough that the tree does not fill the panel.
  expect((await float.boundingBox())!.width).toBeGreaterThanOrEqual(440)
  const floatTree = float.locator('[data-files-navigator]')
  await floatTree.waitFor()
  expect(await floatToggle.getAttribute('aria-expanded')).toBe('true')
  // Resize while the tree is open, through both sides of its fill breakpoint.
  const openBox = await float.boundingBox()
  if (openBox === null) throw new Error('floating preview is not rendered')
  await resizeFloat(page, float, 360, openBox.height - 20)
  await float.locator('[data-files-navigator-mode="fill"]').waitFor()
  await resizeFloat(page, float, 560, openBox.height)
  expect(await floatTree.count()).toBe(1)
  const floatPane = await float.getAttribute('data-dockkit-float')
  // A file nothing shows replaces the preview in its panel, which keeps its pane and its tree.
  await floatTree.getByRole('button', { name: 'README.md', exact: true }).click()
  await expect.poll(() => floatPath.textContent()).toContain('README.md')
  expect(await float.count()).toBe(1)
  expect(await float.getAttribute('data-dockkit-float')).toBe(floatPane)
  expect(await float.locator('[data-files-navigator] [aria-current="true"]').textContent()).toBe('README.md')
  // Navigating to the floating preview itself exposes its file when its tree fills the row.
  const previewHeight = (await float.boundingBox())!.height
  await resizeFloat(page, float, 360, previewHeight)
  await float.locator('[data-files-navigator-mode="fill"]').waitFor()
  await floatTree.getByRole('button', { name: 'README.md', exact: true }).click()
  await expect.poll(() => floatToggle.getAttribute('aria-expanded')).toBe('false')
  await expect.poll(() => floatToggle.evaluate(node => node === document.activeElement)).toBe(true)
  await floatToggle.click()
  await floatTree.waitFor()

  // A file already shown is revealed in the column, which first shows another tab; the panel keeps its file.
  // Revealing b.txt opened `src`.
  const shown = column.locator('[data-dockkit-tab][aria-selected="true"]')
  await column.locator('[data-dockkit-add-tab]').click()
  await expect.poll(() => shown.textContent()).not.toContain('a.txt')
  const guide = await shown.getAttribute('data-dockkit-tab')
  const dockedTabs = await tabs.count()
  await layout.evaluate((node) => { node.textContent = '[data-sidebar-right-panel] { width: 360px !important; }' })
  const sourceFile = floatTree.getByRole('button', { name: 'a.txt', exact: true })
  await sourceFile.click()
  await expect.poll(() => shown.textContent()).toContain('a.txt')
  const dockPreview = column.locator('[data-dockkit-pane] [data-textpreview-state]:visible')
  await expect.poll(() => dockPreview.locator('[data-files-navigator-toggle]').getAttribute('aria-expanded')).toBe('false')
  expect(await dockPreview.locator('[data-textpreview-body]').evaluate(node => getComputedStyle(node).visibility)).toBe('visible')
  expect(await floatToggle.getAttribute('aria-expanded')).toBe('true')
  expect(await sourceFile.evaluate(node => node === document.activeElement)).toBe(true)
  await layout.evaluate((node) => { node.textContent = '[data-sidebar-right-panel] { width: 960px !important; }' })
  await resizeFloat(page, float, 560, previewHeight)
  expect(await tabs.count()).toBe(dockedTabs)
  expect(await floatPath.textContent()).toContain('README.md')
  expect(await float.count()).toBe(1)
  expect(await tabs.filter({ hasText: 'a.txt' }).count()).toBe(1)
  // The column offers a new tab again only once its guide closes.
  await column.locator(`[data-dockkit-tab="${guide}"]`).hover()
  await column.locator(`[data-dockkit-tab-close="${guide}"]`).click()
  await expect.poll(() => column.locator(`[data-dockkit-tab="${guide}"]`).count()).toBe(0)

  // A floating files page stays and opens a file nothing shows in the active docked pane.
  await column.locator('[data-dockkit-add-tab]').click()
  await column.locator('[data-sidebar-right-guide-entry="files"]').click()
  await column.locator('[data-files-page]').waitFor()
  await drag(page, tabs.filter({ hasText: 'Files' }), { x: surface.x - 240, y: surface.y + 120 })
  await expect.poll(() => float.count()).toBe(2)
  const pageFloat = float.filter({ has: page.locator('[data-files-page]') })
  const filePageBox = await pageFloat.boundingBox()
  if (filePageBox === null) throw new Error('floating files page is not rendered')
  await resizeFloat(page, pageFloat, 360, filePageBox.height - 20)
  await page.setViewportSize({ width: 390, height: 844 })
  const phoneBox = await pageFloat.boundingBox()
  if (phoneBox === null) throw new Error('phone-width files page is not rendered')
  await resizeFloat(page, pageFloat, 340, phoneBox.height - 20)
  expect(await pageFloat.locator('[data-files-navigator]').count()).toBe(1)
  await page.setViewportSize({ width: 1680, height: 1000 })
  const docked = await tabs.count()
  await pageFloat.getByRole('button', { name: 'src', exact: true }).click()
  await pageFloat.getByRole('button', { name: 'c.txt', exact: true }).click()
  await column.locator('[data-textpreview-path]:visible', { hasText: 'c.txt' }).waitFor()
  expect(await pageFloat.count()).toBe(1)
  expect(await float.count()).toBe(2)
  expect(await column.locator('[data-dockkit-pane]').count()).toBe(1)
  expect(await tabs.count()).toBe(docked + 1)
  // A file already shown is revealed in the column, and the floating page stays with its tree.
  await pageFloat.getByRole('button', { name: 'a.txt', exact: true }).click()
  await expect.poll(() => column.locator('[data-dockkit-pane-active] [data-dockkit-tab][aria-selected="true"]').textContent()).toContain('a.txt')
  expect(await pageFloat.count()).toBe(1)
  expect(await pageFloat.locator('[data-files-navigator]').count()).toBe(1)
  expect(await float.count()).toBe(2)
  expect(await tabs.count()).toBe(docked + 1)

  // With the docked area emptied and the column collapsed, a file from the floating page gets a docked pane in the expanded column.
  const dockTabs = column.locator('[data-dockkit-pane] [data-dockkit-tab]')
  while (await dockTabs.count() > 0) {
    const id = await dockTabs.first().getAttribute('data-dockkit-tab')
    await dockTabs.first().hover()
    await column.locator(`[data-dockkit-tab-close="${id}"]`).click()
    await expect.poll(() => column.locator(`[data-dockkit-tab="${id}"]`).count()).toBe(0)
  }
  const expand = page.locator('[data-sidebar-right-expand]')
  await expand.waitFor()
  expect(await pageFloat.count()).toBe(1)
  await pageFloat.getByRole('button', { name: 'b.txt', exact: true }).click()
  await column.locator('[data-textpreview-path]:visible', { hasText: 'b.txt' }).waitFor()
  // Past the column's slide, it stays open with the file's tab alone: no default page beside it.
  await expect.poll(() => column.evaluate(node => node.getAnimations({ subtree: true })
    .filter(animation => animation.playState === 'running').length)).toBe(0)
  expect(await expand.count()).toBe(0)
  expect(await column.locator('[data-dockkit-pane]').count()).toBe(1)
  expect(await dockTabs.count()).toBe(1)
  expect(await dockTabs.first().textContent()).toContain('b.txt')
  expect(await column.locator('[data-sidebar-right-guide-entry]').count()).toBe(0)
  expect((await column.boundingBox())?.width ?? 0).toBeGreaterThan(200)
  expect(errors).toEqual({ warnings: [], pageErrors: [] })
})

it('moves a file between the docked column and a floating panel from the file menu, keeping its reading position', async () => {
  // The file menu's open actions belong to Open In, which ordinary scenarios leave out; remote launch facts suppress native probes.
  const { page, errors } = await openWorkspace('web-e2e-file-browser-destination',
    createLaunchEnvironmentSnapshot([{ source: 'process', values: { SSH_CONNECTION: '10.0.0.2 55000 10.0.0.9 22' } }]))
  const column = page.locator('[data-rightbar-col]')
  const expand = page.locator('[data-sidebar-right-expand]')
  const float = page.locator('[data-sidebar-right-session]:not([hidden]) [data-dockkit-float]')
  const docked = (name: string) => column.locator('[data-dockkit-pane] [data-dockkit-tab]', { hasText: name })
  const menu = page.locator('[data-context-menu][role="menu"]')
  // The files page floats and the column collapses, so every later open starts from a floating source pane.
  await expand.click()
  await column.locator('[data-sidebar-right-guide-entry="files"]').click()
  await column.locator('[data-files-page]').waitFor()
  const surface = await page.locator('[data-dockkit-surface]').first().boundingBox()
  if (surface === null) throw new Error('surface is not rendered')
  await drag(page, column.locator('[data-dockkit-tab]', { hasText: 'Files' }), { x: surface.x - 240, y: surface.y + 120 })
  await expect.poll(() => float.count()).toBe(1)
  await column.locator('[data-sidebar-right-toggle]').click()
  await expand.waitFor()
  const pageFloat = float.filter({ has: page.locator('[data-files-page]') })
  await pageFloat.getByRole('button', { name: 'src', exact: true }).click()
  const row = pageFloat.getByRole('button', { name: 'a.txt', exact: true })
  const choose = async (item: string): Promise<void> => {
    await row.click({ button: 'right' })
    await menu.waitFor()
    await menu.getByRole('menuitem', { name: item, exact: true }).click()
    await menu.waitFor({ state: 'detached' })
  }
  await row.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Open in floating panel', exact: true }).waitFor()
  expect(await menu.getByRole('menuitem', { name: 'Open in sidebar', exact: true }).count()).toBe(1)
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'detached' })

  // A file nothing shows opens in its own floating panel; the collapsed column stays collapsed.
  await choose('Open in floating panel')
  await expect.poll(() => float.count()).toBe(2)
  const fileFloat = float.filter({ has: page.locator('[data-textpreview-path]', { hasText: 'a.txt' }) })
  const floatBody = fileFloat.locator('[data-textpreview-state] [data-textpreview-body]')
  await floatBody.waitFor()
  expect(await expand.count()).toBe(1)
  expect(await docked('a.txt').count()).toBe(0)
  await expect.poll(() => floatBody.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
  await floatBody.evaluate((node) => { node.scrollTop = 600 })
  await expect.poll(() => floatBody.evaluate(node => node.scrollTop)).toBe(600)
  // Asking again reveals that panel rather than adding one.
  await choose('Open in floating panel')
  expect(await float.count()).toBe(2)
  expect(await fileFloat.count()).toBe(1)
  expect(await expand.count()).toBe(1)

  // The floating file moves into the expanded column, where the reader left off.
  await choose('Open in sidebar')
  await expect.poll(() => fileFloat.count()).toBe(0)
  expect(await float.count()).toBe(1)
  await expect.poll(() => expand.count()).toBe(0)
  await expect.poll(() => docked('a.txt').count()).toBe(1)
  const dockBody = column.locator('[data-dockkit-pane] [data-textpreview-state]:visible [data-textpreview-body]')
  await expect.poll(() => dockBody.evaluate(node => node.scrollTop)).toBe(600)

  // And back out into a floating panel, leaving the column open and its strip without the file.
  await choose('Open in floating panel')
  await expect.poll(() => fileFloat.count()).toBe(1)
  expect(await float.count()).toBe(2)
  await expect.poll(() => docked('a.txt').count()).toBe(0)
  expect(await expand.count()).toBe(0)
  await expect.poll(() => floatBody.evaluate(node => node.scrollTop)).toBe(600)
  expect(errors).toEqual({ warnings: [], pageErrors: [] })
})
