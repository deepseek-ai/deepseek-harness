/** File headers preserve toolbar axes with available, single-app, and unavailable native opening. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFinished, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { launchWebScaffold } from './scaffold.ts'
import { connectFreshWorkspace } from './support.ts'

const SHOTS = process.env.DSH_UI_REVIEW_OUTPUT
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect x="1" y="1" width="14" height="14" rx="3" fill="#3b82f6"/></svg>'

/** @param page - assembled file or preview page. @returns visible header axes and action-seat geometry. */
async function geometry(page: Page) {
  return page.locator('[data-dockkit-pane-active][data-dockkit-pane]').evaluate((column) => {
    const rect = (selector: string) => {
      const element = column.querySelector(selector)
      if (element === null) throw new Error(`missing toolbar element: ${selector}`)
      return element.getBoundingClientRect()
    }
    const center = (box: DOMRect) => box.x + box.width / 2
    const upper = rect('[data-sidebar-right-toggle] svg')
    const opener = column.querySelector<HTMLElement>('[data-open-target][data-size="compact"]')
    const path = column.querySelector('[data-files-path],[data-textpreview-path]')!
    const header = path.parentElement!
    const seat = header.querySelector<HTMLElement>('[data-slot="sidebar.right.tab.files.actions"],[data-slot="sidebar.right.tab.document.actions"]')!
    const group = seat.parentElement!
    const right = column.getBoundingClientRect()
    const search = column.querySelector('[data-files-search-toggle] svg')
    const searchTarget = column.querySelector('[data-files-search-toggle]')
    const folder = column.querySelector('[data-files-navigator-toggle] svg')
    const refresh = column.querySelector('[data-textpreview-tool="reload"] svg')
    const folderTarget = column.querySelector('[data-files-navigator-toggle]')
    const refreshTarget = column.querySelector('[data-textpreview-tool="reload"]')
    return {
      width: right.width,
      upperRight: center(upper),
      upperSplit: center(rect('[data-dockkit-split-button] svg')),
      upperMode: center(rect('[data-sidebar-right-mode] svg')),
      upperPaintRight: upper.right - (1.5 / 16 * upper.width - 0.5),
      search: search === null ? null : center(search.getBoundingClientRect()),
      folder: folder === null ? null : center(folder.getBoundingClientRect()),
      refresh: refresh === null ? null : center(refresh.getBoundingClientRect()),
      openerRight: opener?.getBoundingClientRect().right ?? null,
      openerWidth: opener?.getBoundingClientRect().width ?? null,
      groupDisplay: getComputedStyle(group).display,
      groupWidth: group.getBoundingClientRect().width,
      searchToOpenerGap: opener === null || searchTarget === null ? null
        : opener.getBoundingClientRect().left - searchTarget.getBoundingClientRect().right,
      gap: folderTarget === null || refreshTarget === null ? null
        : folderTarget.getBoundingClientRect().left - refreshTarget.getBoundingClientRect().right,
      buttonsInside: [...header.querySelectorAll('button')].filter(button => button.getBoundingClientRect().width > 0)
        .every((button) => { const box = button.getBoundingClientRect(); return box.left >= right.left && box.right <= right.right }),
      origin: { x: right.x, y: right.y },
    }
  })
}

it.each([
  { state: 'available', apps: ['finder', 'terminal'], desktop: true },
  { state: 'single', apps: ['finder'], desktop: true },
  { state: 'unavailable', apps: [], desktop: false },
])('aligns native-opening toolbar columns: $state', async ({ state, apps, desktop }) => {
  const scaffold = await launchWebScaffold({ openInAppEnvironment: createLaunchEnvironmentSnapshot([
    { source: 'process', values: { SSH_CONNECTION: '10.0.0.2 55000 10.0.0.9 22' } },
  ]) })
  onTestFinished(() => scaffold.close())
  const capability = vi.spyOn(scaffold.ctx.sessionController, 'canOpenWorkspacePath').mockReturnValue(desktop)
  onTestFinished(() => { capability.mockRestore() })
  const associations = vi.spyOn(scaffold.ctx.sessionController, 'workspacePathApplications').mockResolvedValue([
    { id: 'test-editor', name: 'Test editor', default: true, icon: null },
  ])
  onTestFinished(() => { associations.mockRestore() })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
  await page.route('**/open-in-app/apps', route => route.fulfill({ json: { apps } }))
  await page.route('**/open-in-app/icon/*', route => route.fulfill({ body: ICON, contentType: 'image/svg+xml' }))
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  await writeFile(join(scaffold.workspaceCwd, 'workspace', 'PREVIEW.md'), '# Toolbar alignment\n\nIsolated local review data.\n')
  await page.locator('[data-sidebar-right-expand]').click()
  const column = page.locator('[data-rightbar-col]')
  await column.locator('[data-sidebar-right-guide-entry="files"]').click()
  await column.locator('[data-files-page]').waitFor()
  await column.locator('[data-files-reload]').click()
  await column.getByRole('button', { name: 'PREVIEW.md', exact: true }).waitFor()
  let output: string | undefined
  if (SHOTS !== undefined) {
    await mkdir(SHOTS, { recursive: true })
    output = await mkdtemp(join(SHOTS, `${state}-`))
  }
  const evidence = []
  for (const kind of ['files', 'preview'] as const) {
    if (kind === 'preview') {
      await page.setViewportSize({ width: 1680, height: 1000 })
      await column.getByRole('button', { name: 'PREVIEW.md', exact: true }).click()
      await column.locator('[data-textpreview-path]').waitFor()
      await column.getByRole('heading', { name: 'Toolbar alignment', exact: true }).waitFor()
    }
    for (const theme of ['light', 'dark']) for (const width of [1680, 640]) {
      await page.setViewportSize({ width, height: width === 640 ? 840 : 1000 })
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), theme === 'dark')
      await page.mouse.move(10, 300)
      await expect.poll(async () => {
        const g = await geometry(page)
        if (desktop) return g.openerRight === null ? 100 : kind === 'files'
          ? state === 'single' ? Math.abs(g.searchToOpenerGap! - 4) : Math.abs(g.search! - g.upperSplit) : Math.abs(g.folder! - g.upperRight)
        return g.openerRight !== null ? 100 : kind === 'files'
          ? Math.abs(g.search! - g.upperRight) : Math.max(Math.abs(g.folder! - g.upperRight), Math.abs(g.refresh! - g.upperMode))
      }).toBeLessThan(0.5)
      const g = await geometry(page)
      expect(g.buttonsInside).toBe(true)
      if (desktop && kind === 'files') expect(Math.abs(g.openerRight! - g.upperPaintRight)).toBeLessThan(0.5)
      if (state === 'single' && kind === 'files') {
        expect(g.groupWidth).toBe(g.openerWidth)
        expect(g.openerWidth).toBe(24)
        expect(g.searchToOpenerGap).toBe(4)
      }
      if (!desktop) {
        expect(g.groupDisplay).toBe('none')
        if (kind === 'preview') expect(g.gap).toBe(4)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      const name = `${state}-${kind}-${theme}-${width}`
      const box = await page.locator('[data-dockkit-pane-active][data-dockkit-pane]').boundingBox()
      if (box === null) throw new Error('right pane disappeared')
      if (output !== undefined) {
        await page.screenshot({ path: join(output, `${name}.png`), clip: { ...box, height: Math.min(190, box.height) }, animations: 'disabled' })
      }
      evidence.push({ name, state, kind, theme, viewport: width, ...g })
    }
  }
  if (output !== undefined) await writeFile(join(output, `${state}.json`), JSON.stringify(evidence, null, 2))
})
