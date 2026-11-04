// @vitest-environment jsdom
/** Submenu layout mode: CSS anchors place the card, so only the side-or-page decision is unit tested. */
import { expect, it } from 'vitest'
import { submenuNeedsPage } from '../src/menu-submenu-position.ts'

it.each([
  { name: 'right side fits', parentX: 100, width: 200, viewport: 1024, page: false },
  { name: 'left side fits', parentX: 780, width: 200, viewport: 1024, page: false },
  { name: 'right side fits exactly at the margin', parentX: 12, width: 188, viewport: 416, page: false },
  { name: 'neither side fits', parentX: 100, width: 200, viewport: 390, page: true },
  { name: 'a wide child fits neither side', parentX: 100, width: 500, viewport: 390, page: true },
])('$name: page=$page', ({ parentX, width, viewport, page }) => {
  expect(submenuNeedsPage(new DOMRect(parentX, 100, 200, 100), width, viewport)).toBe(page)
})
