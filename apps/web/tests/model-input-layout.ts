/** Model identity, capacity and input-type fields follow the model row's available width. */
import type { Locator, Page } from 'playwright'
import { expect } from 'vitest'

/**
 * Verify expanded identity fields, capacity fields and input types across viewport and row-width boundaries.
 * @param page - page with an explicit viewport, restored even when an assertion fails.
 * @param editor - expanded model editor containing the first model's identity, capacity and input-type fields.
 * @returns after checking all widths and restoring the caller's size.
 */
export async function assertModelInputLayout(page: Page, editor: Locator): Promise<void> {
  const original = page.viewportSize()
  if (original === null) throw new Error('Model input layout checks require an explicit viewport')
  const drawerCount = await page.locator('[data-sidebar-drawer]').count()
  const entry = editor.locator('[data-row-key]').first()
  const originalStyle = await entry.getAttribute('style')
  const check = async (): Promise<void> => {
    const id = await editor.getByLabel('模型 ID 1', { exact: true }).boundingBox()
    const name = await editor.getByRole('textbox', { name: '显示名称 1', exact: true }).boundingBox()
    const context = await editor.getByLabel('上下文窗口 1', { exact: true }).boundingBox()
    const output = await editor.getByLabel('最大输出 token 数 1', { exact: true }).boundingBox()
    const types = await editor.getByRole('group', { name: '输入类型 1' }).boundingBox()
    if (id === null || name === null || context === null || output === null || types === null) {
      throw new Error('Expanded model fields are not visible')
    }
    const geometry = await entry.evaluate((element) => {
      const style = getComputedStyle(element)
      const row = element.firstElementChild!
      return {
        contentWidth: element.getBoundingClientRect().width - Number.parseFloat(style.paddingLeft)
          - Number.parseFloat(style.paddingRight) - Number.parseFloat(style.borderLeftWidth) - Number.parseFloat(style.borderRightWidth),
        rowWidth: row.getBoundingClientRect().width,
        gap: Number.parseFloat(getComputedStyle(row).columnGap),
        buttons: [...row.querySelectorAll(':scope > button')].map(button => button.getBoundingClientRect().width),
      }
    })
    expect(Math.abs(context.y - output.y)).toBeLessThan(1)
    expect(types.y).toBeGreaterThanOrEqual(Math.max(context.y + context.height, output.y + output.height))
    expect(types.width).toBeGreaterThan(context.width)
    if (geometry.contentWidth <= 440) {
      expect(name.y).toBeGreaterThanOrEqual(id.y + id.height)
      expect(name.width).toBeGreaterThan(id.width)
      expect(context.y).toBeGreaterThanOrEqual(name.y + name.height)
      expect(geometry.buttons).toHaveLength(3)
      const available = geometry.rowWidth - geometry.buttons.reduce((sum, width) => sum + width, 0) - 3 * geometry.gap
      expect(Math.abs(id.width - available)).toBeLessThan(1)
    } else {
      expect(Math.abs(id.y - name.y)).toBeLessThan(1)
      expect(name.x).toBeGreaterThanOrEqual(id.x + id.width)
    }
    const overflowing = await editor.getByRole('region', { name: '模型目录', exact: true }).evaluate((region) => {
      const widths = []
      for (let element: Element | null = region; element !== null; element = element.parentElement) {
        if (element === region || /auto|scroll/.test(getComputedStyle(element).overflowY)) {
          widths.push({ width: element.clientWidth, scroll: element.scrollWidth })
        }
        if (element.getAttribute('role') === 'dialog') break
      }
      return widths.filter(({ width, scroll }) => scroll > width)
    })
    expect(overflowing).toEqual([])
  }
  try {
    for (const viewport of [original, { width: 760, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      await check()
    }
    await page.setViewportSize({ width: 1680, height: 1000 })
    for (const width of [440, 441]) {
      await entry.evaluate((element, width) => {
        element.style.boxSizing = 'content-box'
        element.style.width = `${String(width)}px`
      }, width)
      await check()
    }
  } finally {
    try {
      await entry.evaluate((element, originalStyle) => {
        if (originalStyle === null) element.removeAttribute('style')
        else element.setAttribute('style', originalStyle)
      }, originalStyle)
    } finally {
      await page.setViewportSize(original)
      // The shell's ResizeObserver must restore its original drawer posture before the next capture.
      await expect.poll(async () => page.locator('[data-sidebar-drawer]').count(), { timeout: 5_000 }).toBe(drawerCount)
    }
  }
}
