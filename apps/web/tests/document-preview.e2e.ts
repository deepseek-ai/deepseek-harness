/** Keyless document-preview smoke through a real Session, Files tab, and shipped renderers. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import { pdfFixture } from '../../../packages/client/ui-sidebar-documentpreview/tests/pdf-fixture.ts'
import { assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/lifecycle-chrome/session.v3.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/document-preview', import.meta.url))
const EXPECTED = join(SNAPSHOT_DIR, 'document.expected.md')
const PAGING_PATCH = join(SNAPSHOT_DIR, 'paging.patch.yml')
const PAGE_LINES = 64
const SHOT_DIR = fileURLToPath(new URL('../../../.artifacts/screenshots/0908-document-preview', import.meta.url))
const PROMPT = 'Reply with the single word LIGHTHOUSE and stop.'
const MODE = webSnapshotMode()
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

/** Successful render evidence stays outside the committed snapshot inventory. */
async function successShot(page: Page, name: string): Promise<void> {
  await mkdir(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: join(SHOT_DIR, `${name}-${MODE}-${process.pid}.png`), fullPage: true })
}

/** Trigger the document owner's native scroll handler after a real first page overflows. */
async function scrollForNextPage(body: Locator): Promise<void> {
  await body.evaluate((node) => {
    if (node.scrollHeight <= node.clientHeight) throw new Error('paging fixture does not overflow the document body')
    node.scrollTop = node.scrollHeight
  })
}

/** Read the solid vector fill away from antialiased page edges. */
async function canvasColor(canvas: Locator): Promise<string> {
  return await canvas.evaluate((node) => {
    const surface = node as HTMLCanvasElement
    const context = surface.getContext('2d')
    if (context === null) throw new Error('PDF canvas has no 2D context')
    const pixel = context.getImageData(Math.floor(surface.width / 2), Math.floor(surface.height / 2), 1, 1).data
    if (Number(pixel[3]) !== 255) return 'transparent'
    if (Number(pixel[0]) - Number(pixel[2]) > 150) return 'red'
    if (Number(pixel[2]) - Number(pixel[0]) > 150) return 'blue'
    return 'other'
  })
}

describe.skipIf(MODE === 'record')('web e2e: document preview through Files', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let outsideRoot: string | undefined

  beforeAll(async () => {
    outsideRoot = await mkdtemp(join(tmpdir(), 'dsh-preview-outside-'))
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE, paceMs: 5, compareReplaySession: false, extraOverlayPath: PAGING_PATCH })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  })

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      try {
        await scaffold?.close()
      } finally {
        if (outsideRoot !== undefined) await rm(outsideRoot, { recursive: true, force: true })
      }
    }
  })

  it('opens text, isolated HTML, width-fitted images, and rendered PDF from the Session workspace', async () => {
    onTestFailed(async () => {
      await mkdir(SHOT_DIR, { recursive: true })
      await saveFailureShot(page, `screenshots/0908-document-preview/smoke-${process.pid}`)
    })
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(PROMPT)
    await input.press('Enter')
    const sessionId = await settled
    await page.getByText('LIGHTHOUSE', { exact: true }).waitFor({ timeout: 15_000 })
    const cwd = scaffold.ctx.agents.get(sessionId)?.session.header.cwd
    if (cwd === undefined) throw new Error('settled Session has no workspace cwd')
    if (outsideRoot === undefined) throw new Error('outside fixture directory is unavailable')
    const outsideScript = join(outsideRoot, 'outside.js')
    const outsideReference = relative(cwd, outsideScript).replace(/\\/g, '/')
    const markdownText = [
      '# Markdown smoke', '', 'Rendered from the workspace.', '',
      ...Array.from({ length: (PAGE_LINES - 4) / 2 }, (_, index) => [`Paragraph ${index + 1}: ${'visible prefix '.repeat(20)}`, '']).flat(),
      '# Markdown tail',
    ].join('\n')
    const codeLines = [
      ...Array.from({ length: PAGE_LINES }, (_, index) => index === 0 ? 'const prefix = "CODE_PREFIX";' : `// prefix line ${index + 1}`),
      'const tail = "CODE_TAIL";',
    ]
    await Promise.all([
      writeFile(join(cwd, 'smoke.md'), markdownText),
      writeFile(join(cwd, 'pages.ts'), codeLines.join('\n')),
      writeFile(join(cwd, 'notes.unknown'), 'UNKNOWN_SUFFIX\nPlain fallback.'),
      writeFile(join(cwd, 'smoke.html'), [
        '<!doctype html><link rel="stylesheet" href="./local.css">',
        '<h1>HTML smoke</h1><p id="result">pending</p><p id="local-result">pending</p><p id="parent-result">pending</p>',
        '<p id="outside-result">pending</p>',
        '<script>document.getElementById("result").textContent="INLINE_OK";',
        'try{parent.document.documentElement.setAttribute("data-document-preview-escape","true");document.getElementById("parent-result").textContent="parent-accessible"}',
        'catch(error){const result=document.getElementById("parent-result");result.textContent="parent-blocked";result.dataset.error=error.name}</script>',
        '<script src="./local.js"></script>',
        `<script src="${outsideReference}"></script>`,
      ].join('\n')),
      writeFile(join(cwd, 'local.js'), 'document.getElementById("local-result").textContent="LOCAL_JS_OK";'),
      writeFile(join(cwd, 'local.css'), '#local-result { color: rgb(12, 34, 56); }'),
      writeFile(outsideScript, 'document.getElementById("outside-result").textContent="OUTSIDE_JS_OK";'),
      writeFile(join(cwd, 'tiny.png'), TINY_PNG),
      writeFile(join(cwd, 'large.svg'), [
        '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600" viewBox="0 0 1200 1600">',
        '<script>parent.document.documentElement.setAttribute("data-image-preview-escape","true")</script>',
        '<rect width="1200" height="1600" fill="#2463eb"/>',
        '</svg>',
      ].join('')),
      writeFile(join(cwd, 'smoke.pdf'), pdfFixture()),
      writeFile(join(cwd, 'clip.mp4'), Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])),
    ])

    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await column.locator('[data-files-reload]').click()
    const filesTab = column.locator('[data-dockkit-tab]').filter({ has: page.getByText('Files', { exact: true }) })
    const addTab = column.locator('[data-dockkit-add-tab]')
    expect(await column.locator('[data-dockkit-tab]').count()).toBe(1)
    const defaultTitle = await filesTab.locator('[data-dockkit-tab-title]').innerText()
    const initialFilesClose = await filesTab.locator('[data-dockkit-tab-close]').count()
    expect(initialFilesClose).toBe(1)
    await filesTab.click({ button: 'right' })
    expect(await page.locator('[data-dockkit-tab-menu]:visible').count()).toBe(1)
    await page.keyboard.press('Escape')
    await addTab.waitFor({ state: 'visible' })
    const initialAdd = await addTab.count()
    expect(initialAdd).toBe(1)
    await addTab.click()
    await column.locator('[data-sidebar-right-guide]').waitFor({ state: 'visible' })
    await expect.poll(() => column.locator('[data-dockkit-tab]').count()).toBe(2)
    const guideTab = column.locator('[data-dockkit-tab]').filter({ hasNot: page.getByText('Files', { exact: true }) })
    const guideClose = await guideTab.locator('[data-dockkit-tab-close]').count()
    const filesCloseWithGuide = await filesTab.locator('[data-dockkit-tab-close]').count()
    expect(guideClose).toBe(1)
    expect(filesCloseWithGuide).toBe(1)
    await expect.poll(() => addTab.count()).toBe(0)
    const addWithGuide = await addTab.count()
    await guideTab.hover()
    await guideTab.locator('[data-dockkit-tab-close]').click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await expect.poll(() => column.locator('[data-sidebar-right-guide]').count()).toBe(0)
    await expect.poll(() => column.locator('[data-dockkit-tab]').count()).toBe(1)
    await addTab.waitFor({ state: 'visible' })
    const restoredFilesClose = await filesTab.locator('[data-dockkit-tab-close]').count()
    const restoredAdd = await addTab.count()
    expect(restoredFilesClose).toBe(1)
    expect(restoredAdd).toBe(1)
    const preview = column.locator('[data-document-preview]')
    const openFile = async (name: string): Promise<void> => {
      await filesTab.click()
      await column.locator('[data-files-entry="file"]').getByRole('button', { name, exact: true }).click()
      await expect.poll(async () => (await preview.getAttribute('data-textpreview-url'))?.endsWith(`/${name}`)).toBe(true)
    }
    // Binary suffixes (bitmaps, PDF) drop the plain-text fallback; a single remaining viewer renders no control.
    const viewer = preview.locator('[data-document-viewer-menu]')
    const body = preview.locator('[data-textpreview-body]')
    const sections = ['# Document preview']
    sections.push([
      '## Sidebar tabs', '',
      `- Default tab: ${defaultTitle}`,
      `- Files close buttons (alone -> with guide -> restored): ${[initialFilesClose, filesCloseWithGuide, restoredFilesClose].join(' -> ')}`,
      `- Manual guide close buttons: ${guideClose}`,
      `- Add buttons (Files -> guide -> Files): ${[initialAdd, addWithGuide, restoredAdd].join(' -> ')}`,
    ].join('\n'))

    await openFile('smoke.md')
    await expect.poll(() => viewer.innerText()).toBe('Markdown')
    await preview.getByRole('heading', { name: 'Markdown smoke', exact: true }).waitFor({ timeout: 15_000 })
    expect(await preview.getByText('Rendered from the workspace.', { exact: true }).isVisible()).toBe(true)
    const heading = await preview.getByRole('heading', { name: 'Markdown smoke', exact: true }).innerText()
    const markdownTail = preview.getByRole('heading', { name: 'Markdown tail', exact: true })
    await expect.poll(() => preview.locator('[data-textpreview-more]').isEnabled()).toBe(true)
    expect(await markdownTail.count()).toBe(0)
    await scrollForNextPage(body)
    await markdownTail.waitFor({ timeout: 15_000 })
    await expect.poll(() => preview.locator('[data-textpreview-more]').count()).toBe(0)
    expect(await preview.getByRole('heading', { name: heading, exact: true }).count()).toBe(1)
    expect(await preview.getByText('Rendered from the workspace.', { exact: true }).count()).toBe(1)
    const tailHeading = await markdownTail.innerText()
    await preview.getByRole('heading', { name: heading, exact: true }).scrollIntoViewIfNeeded()
    await successShot(page, 'markdown')
    const markdownTab = column.locator('[data-dockkit-tab]').filter({ has: page.getByText('smoke.md', { exact: true }) })
    const markdownTabId = await markdownTab.getAttribute('data-dockkit-tab')
    expect(markdownTabId).not.toBeNull()
    const tabCount = await column.locator('[data-dockkit-tab]').count()
    const markdownViewers = [await viewer.innerText()]
    const sourceFonts: Array<{ fontSize: string; lineHeight: string }> = []
    for (const label of ['Code', 'Plain text']) {
      await viewer.click()
      await page.getByRole('menuitem', { name: label, exact: true }).click()
      await expect.poll(() => viewer.innerText()).toBe(label)
      if (label === 'Code') {
        await preview.locator('.shiki').waitFor({ timeout: 15_000 })
        expect(await preview.locator('.shiki').textContent()).toBe(markdownText)
      } else {
        await expect.poll(async () => (await preview.locator('[data-textpreview-line]').first().textContent())?.trim()).toBe('# Markdown smoke')
      }
      const source = label === 'Code' ? preview.locator('.shiki') : preview.locator('[data-textpreview-line]').first()
      sourceFonts.push(await source.evaluate((node) => {
        const style = getComputedStyle(node)
        return { fontSize: style.fontSize, lineHeight: style.lineHeight }
      }))
      expect(await markdownTab.getAttribute('data-dockkit-tab')).toBe(markdownTabId)
      expect(await column.locator('[data-dockkit-tab]').count()).toBe(tabCount)
      markdownViewers.push(await viewer.innerText())
    }
    expect(sourceFonts[1]).toEqual(sourceFonts[0])
    sections.push([
      '## Markdown', '',
      `- Heading: ${heading}`,
      `- Tail loaded by scrolling: ${tailHeading}`,
      `- Viewers: ${markdownViewers.join(' -> ')}`,
      `- Same tab: ${String(await markdownTab.getAttribute('data-dockkit-tab') === markdownTabId)}`,
    ].join('\n'))

    await openFile('smoke.html')
    await expect.poll(() => viewer.innerText()).toBe('HTML')
    const iframe = preview.locator('[data-html-preview]')
    await iframe.waitFor({ timeout: 15_000 })
    expect(await iframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(await iframe.evaluate((node) => {
      const host = node.closest('[data-textpreview-body]')
      if (!(host instanceof HTMLElement)) throw new Error('HTML preview body is unavailable')
      const outer = host.getBoundingClientRect()
      const frame = node.getBoundingClientRect()
      return {
        top: Math.round(frame.top - outer.top),
        right: Math.round(outer.right - frame.right),
        bottom: Math.round(outer.bottom - frame.bottom),
        left: Math.round(frame.left - outer.left),
      }
    })).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
    const html = page.frameLocator('[data-html-preview]')
    await html.getByRole('heading', { name: 'HTML smoke', exact: true }).waitFor({ timeout: 15_000 })
    await expect.poll(() => html.locator('#result').innerText()).toBe('INLINE_OK')
    await expect.poll(() => html.locator('#local-result').innerText()).toBe('LOCAL_JS_OK')
    await expect.poll(() => html.locator('#outside-result').innerText()).toBe('OUTSIDE_JS_OK')
    await expect.poll(() => html.locator('#local-result').evaluate(node => getComputedStyle(node).color)).toBe('rgb(12, 34, 56)')
    await expect.poll(() => html.locator('#parent-result').innerText()).toBe('parent-blocked')
    expect(await html.locator('#parent-result').getAttribute('data-error')).toBe('SecurityError')
    expect(await page.locator('html').getAttribute('data-document-preview-escape')).toBeNull()
    await successShot(page, 'html')
    sections.push([
      '## HTML', '',
      `- Viewer: ${await viewer.innerText()}`,
      `- Sandbox: ${await iframe.getAttribute('sandbox')}`,
      `- Inline script: ${await html.locator('#result').innerText()}`,
      `- Local script: ${await html.locator('#local-result').innerText()}`,
      `- Outside-workspace script: ${await html.locator('#outside-result').innerText()}`,
      `- Local stylesheet: ${await html.locator('#local-result').evaluate(node => getComputedStyle(node).color)}`,
      `- Parent access: ${await html.locator('#parent-result').innerText()} (${await html.locator('#parent-result').getAttribute('data-error')})`,
      `- Parent unchanged: ${String(await page.locator('html').getAttribute('data-document-preview-escape') === null)}`,
    ].join('\n'))

    await openFile('smoke.pdf')
    const canvas = preview.getByRole('img', { name: 'PDF page 1', exact: true })
    await canvas.waitFor({ state: 'visible', timeout: 30_000 })
    expect(await viewer.count()).toBe(0)
    expect(await preview.locator('[role="toolbar"]').count()).toBe(0)
    expect(await preview.locator('[data-pdf-page]').count()).toBe(2)
    await expect.poll(() => canvasColor(canvas), { timeout: 30_000 }).toBe('red')
    const firstColor = await canvasColor(canvas)
    expect(firstColor).toBe('red')
    const workerNames = await Promise.all(page.workers().map(worker => worker.evaluate(() => self.name)))
    expect(workerNames).toContain('dsh-pdf')
    await preview.locator('[data-pdf-page="2"]').scrollIntoViewIfNeeded()
    const secondPage = preview.getByRole('img', { name: 'PDF page 2', exact: true })
    await secondPage.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(() => canvasColor(secondPage), { timeout: 30_000 }).toBe('blue')
    const secondColor = await canvasColor(secondPage)
    expect(secondColor).toBe('blue')
    expect(await body.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    const pdfTab = column.locator('[data-dockkit-tab]').filter({ has: page.getByText('smoke.pdf', { exact: true }) })
    const pdfTabId = await pdfTab.getAttribute('data-dockkit-tab')
    expect(pdfTabId).not.toBeNull()
    await filesTab.click()
    await column.locator('[data-files-state="tree"]').waitFor({ state: 'visible' })
    await pdfTab.click()
    await preview.locator('[data-pdf-page="2"]').scrollIntoViewIfNeeded()
    await secondPage.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(() => canvasColor(secondPage), { timeout: 30_000 }).toBe('blue')
    const restoredColor = await canvasColor(secondPage)
    expect(restoredColor).toBe('blue')
    expect(await pdfTab.getAttribute('data-dockkit-tab')).toBe(pdfTabId)
    await successShot(page, 'pdf')
    sections.push([
      '## PDF', '',
      `- Viewer menu hidden: ${String(await viewer.count() === 0)}`,
      `- Worker: ${workerNames.find(name => name === 'dsh-pdf')}`,
      `- Continuous pages: ${await preview.locator('[data-pdf-page]').count()}`,
      `- Horizontal overflow: ${String(await body.evaluate(node => node.scrollWidth > node.clientWidth))}`,
      `- Canvas fills: ${[firstColor, secondColor, restoredColor].join(' -> ')}`,
      `- Same tab: ${String(await pdfTab.getAttribute('data-dockkit-tab') === pdfTabId)}`,
    ].join('\n'))

    await openFile('tiny.png')
    const tinyImage = preview.getByRole('img', { name: 'Image preview: tiny.png', exact: true })
    await tinyImage.waitFor({ state: 'visible', timeout: 15_000 })
    expect(await viewer.count()).toBe(0)
    expect(await tinyImage.evaluate(node => ({
      width: (node as HTMLImageElement).naturalWidth,
      height: (node as HTMLImageElement).naturalHeight,
      draggable: (node as HTMLImageElement).draggable,
    }))).toEqual({ width: 1, height: 1, draggable: false })
    const centering = await tinyImage.evaluate((node) => {
      const image = node.getBoundingClientRect()
      const scroller = node.closest('[data-textpreview-body]')?.getBoundingClientRect()
      if (scroller === undefined) throw new Error('image document scroller is unavailable')
      return {
        horizontal: Math.abs((image.left + image.width / 2) - (scroller.left + scroller.width / 2)),
        vertical: Math.abs((image.top + image.height / 2) - (scroller.top + scroller.height / 2)),
      }
    })
    expect(centering.horizontal).toBeLessThan(10)
    expect(centering.vertical).toBeLessThan(10)

    await openFile('large.svg')
    await expect.poll(() => viewer.innerText()).toBe('Image')
    await viewer.click()
    await page.getByRole('menuitem', { name: 'Plain text', exact: true }).waitFor({ timeout: 15_000 })
    await page.keyboard.press('Escape')
    const largeImage = preview.getByRole('img', { name: 'Image preview: large.svg', exact: true })
    await largeImage.waitFor({ state: 'visible', timeout: 15_000 })
    const fitted = await largeImage.evaluate((node) => {
      const image = node as HTMLImageElement
      const scroller = image.closest('[data-textpreview-body]')
      if (scroller === null) throw new Error('image document scroller is unavailable')
      const rect = image.getBoundingClientRect()
      return {
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        width: rect.width,
        height: rect.height,
        paneWidth: scroller.clientWidth,
        paneHeight: scroller.clientHeight,
      }
    })
    expect(fitted).toMatchObject({ naturalWidth: 1200, naturalHeight: 1600 })
    expect(fitted.width).toBeLessThan(1200)
    // Width fit: the image fills the frame's 12px-inset box while the aspect ratio holds.
    expect(Math.abs((fitted.paneWidth - 24) - fitted.width)).toBeLessThanOrEqual(1)
    expect(fitted.height / fitted.width).toBeCloseTo(1600 / 1200, 2)
    const scrolled = await body.evaluate((node) => {
      node.scrollLeft = node.scrollWidth
      return { left: node.scrollLeft, horizontalOverflow: node.scrollWidth > node.clientWidth }
    })
    expect(scrolled).toEqual({ left: 0, horizontalOverflow: false })
    expect(await page.locator('html').getAttribute('data-image-preview-escape')).toBeNull()

    const releaseRead = Promise.withResolvers<undefined>()
    let waitingForRead = false
    const readPage = scaffold.ctx.workspaceFiles.read.bind(scaffold.ctx.workspaceFiles)
    const heldRead = vi.spyOn(scaffold.ctx.workspaceFiles, 'read').mockImplementation(async (agent, path, range, signal) => {
      if (path === 'pages.ts' && (range.offset ?? 1) === 1) {
        waitingForRead = true
        await releaseRead.promise
      }
      return readPage(agent, path, range, signal)
    })
    let initialReading = false
    try {
      await openFile('pages.ts')
      await expect.poll(() => waitingForRead).toBe(true)
      const reading = preview.locator('[data-document-loading]')
      initialReading = await reading.isVisible()
      expect(initialReading).toBe(true)
      expect(await preview.locator('[data-code-preview]').count()).toBe(0)
      const indicator = await reading.boundingBox()
      const scroller = await body.boundingBox()
      if (indicator === null || scroller === null) throw new Error('reading indicator or document body is not rendered')
      expect(indicator.y).toBeGreaterThanOrEqual(scroller.y)
      expect(indicator.y + indicator.height).toBeLessThanOrEqual(scroller.y + scroller.height)
      await successShot(page, 'code-reading')
    } finally {
      releaseRead.resolve(undefined)
      heldRead.mockRestore()
    }
    await expect.poll(() => viewer.innerText()).toBe('Code')
    const highlightedLines = preview.locator('.shiki .line')
    await expect.poll(() => highlightedLines.count(), { timeout: 15_000 }).toBe(PAGE_LINES)
    const codeBlock = preview.locator('.md-code-block')
    const codeScrollport = preview.locator('[data-code-block-content]')
    expect(await codeBlock.getAttribute('data-line-numbers')).toBe('true')
    await expect.poll(() => highlightedLines.first().evaluate(node => getComputedStyle(node, '::before').content))
      .not.toMatch(/^(?:none|normal)$/u)
    const numbering = await highlightedLines.first().evaluate((node) => {
      const line = getComputedStyle(node)
      const before = getComputedStyle(node, '::before')
      return {
        counterIncrement: line.counterIncrement,
        gutterWidth: Number.parseFloat(before.width),
        sourceInset: Number.parseFloat(line.paddingInlineStart),
      }
    })
    expect(numbering.counterIncrement).toBe('source-line 1')
    expect(numbering.gutterWidth).toBeGreaterThan(0)
    expect(numbering.sourceInset).toBeGreaterThan(numbering.gutterWidth)
    const prefix = await highlightedLines.allTextContents()
    expect(prefix).toEqual(codeLines.slice(0, PAGE_LINES))
    await expect.poll(() => preview.locator('[data-textpreview-more]').isEnabled()).toBe(true)
    await scrollForNextPage(codeScrollport)
    await expect.poll(() => highlightedLines.count(), { timeout: 15_000 }).toBe(codeLines.length)
    const completed = await highlightedLines.allTextContents()
    expect(completed).toEqual(codeLines)
    await expect.poll(() => preview.locator('[data-textpreview-more]').count()).toBe(0)
    const scrollTop = await codeScrollport.evaluate((node) => {
      const target = Math.floor((node.scrollHeight - node.clientHeight) / 2)
      if (target <= 0) throw new Error('code fixture does not overflow the document body')
      node.scrollTop = target
      return target
    })
    await expect.poll(() => codeScrollport.evaluate((node) => {
      const codeBlock = node.parentElement
      const banner = codeBlock?.firstElementChild
      const firstLine = node.querySelector('.shiki .line')
      if (!(banner instanceof HTMLElement) || firstLine === null) throw new Error('missing rendered code banner or source line')
      const bounds = node.getBoundingClientRect()
      const clipTop = bounds.top + node.clientTop
      const bannerBounds = banner.getBoundingClientRect()
      return {
        scrollTop: node.scrollTop,
        scrollportBelowBanner: Math.abs(bannerBounds.bottom - bounds.top) < 1,
        firstLineAbove: firstLine.getBoundingClientRect().top < clipTop,
      }
    })).toEqual({ scrollTop, scrollportBelowBanner: true, firstLineAbove: true })
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
    await page.evaluate(() => navigator.clipboard.writeText(''))
    await codeBlock.getByRole('button', { name: 'Copy', exact: true }).click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(codeLines.join('\n'))
    sections.push([
      '## Code paging', '',
      `- Viewer: ${await viewer.innerText()}`,
      `- Initial reading indicator: ${initialReading}`,
      `- Lines: ${prefix.length} -> ${completed.length}`,
      `- Prefix retained: ${String(JSON.stringify(completed.slice(0, prefix.length)) === JSON.stringify(prefix))}`,
      `- Tail: ${completed.at(-1)}`,
    ].join('\n'))

    await openFile('notes.unknown')
    const plainLines = preview.locator('[data-textpreview-line]')
    await expect.poll(() => plainLines.count()).toBe(2)
    // Plain text is the only candidate, so no viewer menu renders.
    expect(await viewer.count()).toBe(0)
    const fallback = (await plainLines.allTextContents()).map(line => line.trim())
    expect(fallback).toEqual(['UNKNOWN_SUFFIX', 'Plain fallback.'])
    sections.push(['## Unknown suffix', '', `- Viewer menu hidden: ${String(await viewer.count() === 0)}`, `- Text: ${fallback.join(' | ')}`].join('\n'))

    await filesTab.click()
    await column.locator('[data-files-entry="file"]').getByRole('button', { name: 'clip.mp4', exact: true }).click()
    const unsupported = column.locator('[data-textpreview-state="unsupported"]')
    await unsupported.waitFor({ timeout: 15_000 })
    const unsupportedLine = await unsupported.locator('[data-textpreview-unsupported]').innerText()
    expect(unsupportedLine).toContain('Preview is not available for this file type yet.')
    expect(await unsupported.locator('[data-textpreview-path]').innerText()).toContain('clip.mp4')
    expect(await unsupported.locator('[data-document-viewer-menu]').count()).toBe(0)
    expect(await unsupported.locator('[data-textpreview-tool="reload"]').count()).toBe(0)
    await successShot(page, 'unsupported')
    sections.push(['## Unviewable binary', '', '- State: unsupported', `- Line: ${unsupportedLine.trim()}`].join('\n'))
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await compareOrRefreshGolden(EXPECTED, sections.join('\n\n'), MODE)
    await assertFixtureInventory(SNAPSHOT_DIR, ['document.expected.md', 'paging.patch.yml'])
  })
})
