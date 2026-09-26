/** Recorded read metadata and the file preview share syntax highlighting while CSV defaults to Spreadsheet. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold,
  recordFixture, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { connectFreshWorkspace, expandTurnProcesses, newEnglishPage } from './support.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/code-language', import.meta.url))
const FIXTURE = join(DIR, 'session.v4.jsonl')
const MODE = webSnapshotMode()
const FILES = [
  { name: 'sample.pyi', lang: 'py', previewLang: 'python', text: 'from typing import Protocol\n\nclass Greeter(Protocol):\n    def greet(self, name: str) -> str: ...\n' },
  { name: 'deploy.ps1', lang: 'ps1', previewLang: 'powershell', text: 'param([string]$Name = "World")\nWrite-Host "Hello, $Name"\n' },
  { name: 'table.csv', lang: 'csv', previewLang: 'csv', text: 'name,count\napples,12\npears,7\n' },
] as const

it('replays highlighted Python stubs, PowerShell and CSV reads with their document previews', async () => {
  const prompt = MODE === 'record'
    ? 'Use the read tool exactly once per file to read sample.pyi, deploy.ps1 and table.csv in the current directory. Use these relative paths. Do not run commands or change files. Then reply exactly: Read all three files.'
    : fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))[0]!
  const scaffold = await launchWebScaffold({
    ...(MODE === 'record' ? {} : { replayFixture: FIXTURE }),
    compareReplaySession: true,
  })
  let browser: Browser | undefined
  try {
    const cwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(cwd, { recursive: true })
    await Promise.all(FILES.map(file => writeFile(join(cwd, file.name), file.text)))
    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(prompt)
    await input.press('Enter')
    const sessionId = await settled
    const session = scaffold.ctx.agents.get(sessionId)?.session
    if (session === undefined) throw new Error('read turn has no Session')
    const reads = session.snapshotEvents().flatMap(event => event.type === 'tool/result' ? [event.data.meta] : [])
    expect(reads).toHaveLength(FILES.length)
    for (const file of FILES) {
      expect(reads).toContainEqual(expect.objectContaining({ path: join(cwd, file.name), lang: file.lang }))
      expect(await readFile(join(cwd, file.name), 'utf8')).toBe(file.text)
    }
    if (MODE === 'record') await recordFixture(scaffold, sessionId, FIXTURE)

    await expandTurnProcesses(page)
    await page.locator('[data-sidebar-right-expand]').click()
    await page.locator('[data-sidebar-right-guide-entry="files"]').click()
    const filesTab = page.locator('[data-dockkit-tab]').filter({ has: page.getByText('Files', { exact: true }) })
    const preview = page.locator('[data-textpreview-url]')
    const snapshots: string[] = []
    for (const file of FILES) {
      const readSelector = `[data-tool="read"]:has-text("${file.name}")`
      const read = page.locator(readSelector)
      await read.locator('[data-disclosure-row]').click()
      await read.locator('[data-read]').scrollIntoViewIfNeeded()
      await expect.poll(() => read.locator('[data-read] span[style*="color:"]').count()).toBeGreaterThan(0)
      expect(await read.getByText(file.lang, { exact: true }).count()).toBe(1)
      snapshots.push(`## Read ${file.name}\n\n${await captureStableAria(page, readSelector, scaffold.workspaceCwd)}`)
      await filesTab.click()
      await page.locator('[data-files-entry="file"]').getByRole('button', { name: file.name, exact: true }).click()
      const viewer = preview.locator('[data-document-viewer-menu]')
      if (file.name === 'table.csv') {
        await expect.poll(() => viewer.innerText()).toBe('Spreadsheet')
        await preview.locator('[data-excel-preview] canvas').first().waitFor()
        await viewer.click()
        await page.getByRole('menuitem', { name: 'Code', exact: true }).click()
      }
      await expect.poll(() => preview.locator('[data-code-preview] .shiki span[style*="color:"]').count()).toBeGreaterThan(0)
      expect(await preview.getByText(file.previewLang, { exact: true }).count()).toBe(1)
      snapshots.push(`## Preview ${file.name}\n\n${await captureStableAria(page, '[data-code-preview]', scaffold.workspaceCwd)}`)
      await read.locator('[data-disclosure-row]').click()
    }
    if (MODE !== 'record') await compareOrRefreshGolden(join(DIR, 'ui.expected.md'), snapshots.join('\n\n'), MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  } finally {
    try {
      await browser?.close()
    } finally {
      await scaffold.close()
    }
  }
})
