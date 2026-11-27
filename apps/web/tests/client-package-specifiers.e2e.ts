/**
 * Compatibility commitment for Client plugins compiled outside this repository: in the browser module table,
 * `require('<package>')` of a dynamic Client package returns the same exports as `require('<package>/client')`. The
 * fixture plugin is hand-written JavaScript that no repository build preset compiles.
 */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'

/** What the fixture plugin publishes for each package it requires. */
interface SpecifierResult {
  readonly name: string
  readonly sameExports: boolean
  readonly exported: string
  readonly rootExportType: string
  readonly clientExportType: string
}

const required = (name: string, exported: string, type: string): SpecifierResult =>
  ({ name, sameExports: true, exported, rootExportType: type, clientExportType: type })

it('gives a prebuilt plugin the same exports for require(<package>) and require(<package>/client) of three Client packages', async () => {
  const scaffold = await launchWebScaffold({
    extraInstallAnchors: [fileURLToPath(new URL('./fixtures/plugins/fixture-package-specifiers/package.json', import.meta.url))],
  })
  try {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ locale: 'en-US' })
      const console = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      await page.getByRole('button', { name: 'New session', exact: true }).first().waitFor()
      const entryId = await scaffold.ctx.loader.create({ name: '@fixture/package-specifiers' })
      const read = (): Promise<unknown> => page.evaluate(() =>
        (window as Window & { __fixturePackageSpecifiers?: unknown }).__fixturePackageSpecifiers ?? null)
      await expect.poll(read).not.toBeNull()
      expect(await read()).toEqual([
        required('@deepseek-ai/dsh-client-ui-slots', 'resolveSlotLabel', 'function'),
        required('@deepseek-ai/dsh-client-ui-primitives', 'Button', 'object'),
        required('@deepseek-ai/dsh-client-ui-dockkit', 'DockController', 'function'),
      ])
      scaffold.ctx.loader.remove(entryId)
      await expect.poll(read).toBeNull()
      expect(console.pageErrors).toEqual([])
      expect(console.warnings).toEqual([])
    } finally { await browser.close() }
  } finally { await scaffold.close() }
})
