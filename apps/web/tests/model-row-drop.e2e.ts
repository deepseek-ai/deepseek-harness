/** Native model reordering accepts the midpoint between adjacent rows. */
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'
import { openSettings, ZH_BROWSER_LOCALE } from './support.ts'

it('drops a model directly into the middle of an inactive row gap', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: ZH_BROWSER_LOCALE })
  await page.goto(scaffold.authenticatedUrl)
  await openSettings(page, 'zh')
  const dialog = page.getByRole('dialog', { name: '设置' })
  await dialog.getByRole('button', { name: '模型', exact: true }).click()
  await dialog.getByRole('button', { name: '添加模型提供商' }).click()
  await dialog.getByLabel('提供商', { exact: true }).selectOption('minimax-cn')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await dialog.getByRole('button', { name: '编辑 minimax-cn' }).click()
  for (let position = 1; position <= 3; position++) {
    await dialog.getByRole('button', { name: '添加模型', exact: true }).click()
    await dialog.getByLabel(`模型 ID ${String(position)}`, { exact: true }).fill(`gap-model-${String(position)}`)
  }
  // An added row starts unfolded, and only a folded row is dragged.
  for (let position = 1; position <= 3; position++) {
    await dialog.getByRole('button', { name: `模型选项 ${String(position)}`, exact: true }).click()
  }
  const rows = dialog.locator('[data-row-key]')
  const source = rows.first().getByText('gap-model-1', { exact: true })
  await source.scrollIntoViewIfNeeded()
  const point = await rows.evaluateAll((rows) => {
    const a = rows[1]!.getBoundingClientRect()
    const b = rows[2]!.getBoundingClientRect()
    const x = a.left + 20
    const y = (a.bottom + b.top) / 2
    return { x, y, outside: a.right + 20, gap: b.top - a.bottom,
      hitsRow: document.elementFromPoint(x, y)?.closest('[data-row-key]') != null }
  })
  expect(point.gap).toBeGreaterThan(0)
  expect(point.hitsRow).toBe(true)
  await source.hover()
  const from = await source.boundingBox()
  if (from === null) throw new Error('Folded model row is not visible')
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 10, { steps: 3 })
  await page.mouse.move(point.outside, point.y)
  await page.mouse.move(point.x, point.y)
  await page.mouse.up()
  await expect.poll(() => rows.evaluateAll(rows => rows.map(row => row.textContent)))
    .toEqual(['gap-model-2', 'gap-model-1', 'gap-model-3'])
})
