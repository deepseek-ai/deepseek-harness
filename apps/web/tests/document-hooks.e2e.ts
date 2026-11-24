/** Document hook standard props in the assembled Client, with a separate mount document. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

it('portals into the rendered body with source scope and document key listeners, and measures its layout viewport', async () => {
  const dir = fileURLToPath(new URL('./fixtures/plugins/fixture-document-hooks', import.meta.url))
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir, enabled: true }] } })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const errors = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl)

  const frame = page.locator('iframe[title="Rendered document"]')
  const display = frame.contentFrame()
  const probes = display.locator('[data-scope-probe]')
  await display.locator('[data-scope-probe="nested"]').waitFor({ state: 'attached' })
  expect(await probes.count()).toBe(3)
  expect(await page.locator('[data-scope-probe]').count()).toBe(0)
  const placements = await probes.evaluateAll(nodes => Object.fromEntries(nodes.map(node => [
    node.getAttribute('data-scope-probe')!, {
      inBodyOutsideApp: document.body.contains(node) && !document.getElementById('root')!.contains(node),
      owner: node.closest('[data-plugin]')?.getAttribute('data-plugin'),
      scope: getComputedStyle(node).getPropertyValue('--scope-answer').trim(),
    },
  ] as const)))
  expect(placements).toEqual({
    owned: { inBodyOutsideApp: true, owner: 'inner', scope: 'inner' },
    nested: { inBodyOutsideApp: true, owner: 'inner', scope: 'inner' },
    empty: { inBodyOutsideApp: true, owner: '', scope: 'none' },
  })

  const viewport = display.locator('[data-viewport]')
  const layoutSize = () => display.locator('html').evaluate(root => `${root.clientWidth}x${root.clientHeight}`)
  const initial = await layoutSize()
  expect(initial).not.toBe(await page.locator('html').evaluate(root => `${root.clientWidth}x${root.clientHeight}`))
  expect(await viewport.textContent()).toBe(initial)
  await display.getByRole('button', { name: 'Remember viewport' }).click()
  await expect.poll(() => viewport.getAttribute('data-saved')).toBe('true')
  await frame.evaluate((element) => { element.setAttribute('width', '736'); element.setAttribute('height', '528') })
  const resized = await layoutSize()
  expect(resized).not.toBe(initial)
  await expect.poll(() => viewport.textContent()).toBe(resized)
  expect(await viewport.getAttribute('data-saved')).toBe('false')

  const outside = display.getByRole('button', { name: 'Outside portal' })
  const log = display.locator('[data-key-log]')
  await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', bubbles: true })))
  expect(await log.textContent()).toBe('')
  await outside.press('q')
  const phases = 'capture:1:document:keyboard;target;bubble:3:document:keyboard;'
  expect(await log.textContent()).toBe(phases)
  await display.getByRole('button', { name: 'Close portal' }).click()
  await expect.poll(() => probes.count()).toBe(0)
  await outside.press('q')
  expect(await log.textContent()).toBe(`${phases}target;`)
  expect(errors.warnings).toEqual([])
  expect(errors.pageErrors).toEqual([])
})
