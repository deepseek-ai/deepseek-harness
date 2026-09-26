/** Independent-writer XLSX previews through a replayed Session and the shipped browser Worker. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { excelOpeningCases, excelOpeningFixture } from '../../../packages/client/ui-sidebar-documentpreview/tests/excel-opening-fixture.ts'
import { excelOpcCases, excelOpcFixture } from '../../../packages/client/ui-sidebar-documentpreview/tests/excel-opc-fixture.ts'
import { excelXmlCases, excelXmlFixture } from '../../../packages/client/ui-sidebar-documentpreview/tests/excel-xml-fixture.ts'
import { assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const snapshotDirectory = fileURLToPath(new URL('../../../snapshots/web/excel-opc', import.meta.url))
const mode = webSnapshotMode()

describe.skipIf(mode === 'record')('web e2e: independent-writer Excel previews', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let consoleErrors: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      developerTools: false,
      replayFixture: fileURLToPath(new URL('../../../snapshots/web/lifecycle-chrome/session.v3.jsonl', import.meta.url)),
      compareReplaySession: false,
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    consoleErrors = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  })

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('opens comments, Tables and equivalent OPC encodings without hiding cell data', async () => {
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill('Reply with the single word LIGHTHOUSE and stop.')
    await input.press('Enter')
    const sessionId = await settled
    await page.getByText('LIGHTHOUSE', { exact: true }).waitFor()
    const cwd = scaffold.ctx.agents.get(sessionId)?.session.header.cwd
    if (cwd === undefined) throw new Error('Excel preview Session has no workspace')
    for (const name of excelOpcCases) await writeFile(join(cwd, `${name}.xlsx`), await excelOpcFixture(name))
    for (const name of excelOpeningCases) await writeFile(join(cwd, `${name}.xlsx`), await excelOpeningFixture(name))
    for (const name of excelXmlCases) await writeFile(join(cwd, `${name}.xlsx`), await excelXmlFixture(name))

    const column = page.locator('[data-rightbar-col]')
    await page.locator('[data-sidebar-right-expand]').click()
    await column.locator('[data-sidebar-right-guide-entry="files"]').click()
    await column.locator('[data-files-state="tree"]').waitFor()
    await column.locator('[data-files-reload]').click()
    const files = column.locator('[data-dockkit-tab]').filter({ has: page.getByText('Files', { exact: true }) })
    const preview = column.locator('[data-textpreview-url]')
    const excel = preview.locator('[data-excel-preview]')
    const sheets = excel.locator('.luckysheet-sheets-item-name')
    const notice = excel.locator('[data-excel-unsupported-notice]')
    const rows = ['# Independent-writer Excel previews', '']
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
    for (const name of [...excelOpcCases, ...excelOpeningCases, ...excelXmlCases]) {
      await files.click()
      await column.locator('[data-files-entry="file"]').getByRole('button', { name: `${name}.xlsx`, exact: true }).click()
      await expect.poll(async () => (await preview.getAttribute('data-textpreview-url'))?.endsWith(`/${name}.xlsx`)).toBe(true)
      await sheets.getByText('数据', { exact: true }).waitFor()
      await excel.locator('.fortune-sheet-overlay').click({ position: { x: 70, y: 30 } })
      await expect.poll(() => excel.locator('.fortune-fx-input').innerText()).toBe('Item')
      await page.keyboard.press('ControlOrMeta+C')
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/^Item\r?\n$/)
      const rich = excelXmlCases.some(candidate => candidate === name)
      const opening = excelOpeningCases.some(candidate => candidate === name)
      expect(await notice.count()).toBe(name === 'combined' || rich || opening ? 1 : 0)
      if (name === 'combined' || rich || opening) {
        const features = rich ? 'charts, images, shapes, conditional formatting'
          : name === 'orphan-drawing' ? 'conditional formatting' : 'charts, conditional formatting'
        expect(await notice.innerText()).toBe(`This preview does not support ${features} in this workbook. Open it in a system application for the full experience.`)
      }
      rows.push(`- ${name}.xlsx: 数据 opened; Item copied`)
    }
    expect(await sheets.getByText('隐藏页', { exact: true }).isVisible()).toBe(false)
    const warning = await notice.innerText()
    expect(warning).toBe('This preview does not support charts, images, shapes, conditional formatting in this workbook. Open it in a system application for the full experience.')
    rows.push('- Relocated workbook: hidden sheet omitted', `- Relocated workbook notice: ${warning}`)
    expect(consoleErrors.pageErrors).toEqual([])
    expect(consoleErrors.warnings).toEqual([])
    await compareOrRefreshGolden(join(snapshotDirectory, 'excel.expected.md'), rows.join('\n'), mode)
    await assertFixtureInventory(snapshotDirectory, ['excel.expected.md'])
  })
})
