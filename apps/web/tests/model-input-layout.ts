/** Model input types stay below both capacity fields across editor widths. */
import type { Locator, Page } from 'playwright'
import { expect } from 'vitest'

/**
 * Verify the expanded row at the current viewport and a narrow viewport.
 * @param page - page with an explicit viewport, restored even when an assertion fails.
 * @param editor - expanded model editor containing the capacity and input-type fields.
 * @returns after checking both widths and restoring the caller's size.
 */
export async function assertModelInputLayout(page: Page, editor: Locator): Promise<void> {
  const original = page.viewportSize()
  if (original === null) throw new Error('Model input layout checks require an explicit viewport')
  try {
    for (const viewport of [original, { width: 760, height: 1000 }]) {
      await page.setViewportSize(viewport)
      const context = await editor.getByLabel('上下文窗口 1', { exact: true }).boundingBox()
      const output = await editor.getByLabel('最大输出 token 数 1', { exact: true }).boundingBox()
      const types = await editor.getByRole('group', { name: '输入类型 1' }).boundingBox()
      expect(context).not.toBeNull()
      expect(output).not.toBeNull()
      expect(types).not.toBeNull()
      if (context === null || output === null || types === null) throw new Error('Expanded model fields are not visible')
      expect(Math.abs(context.y - output.y)).toBeLessThan(1)
      expect(types.y).toBeGreaterThanOrEqual(Math.max(context.y + context.height, output.y + output.height))
      expect(types.width).toBeGreaterThan(context.width)
    }
  } finally {
    await page.setViewportSize(original)
  }
}
