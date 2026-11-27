// @vitest-environment jsdom
/** Calc headings align scaled native boundaries, remain text-only, and replace obsolete labels. */
import { afterEach, expect, test, vi } from 'vitest'
import { headerCells, SheetHeaders } from '../src/client/headers.ts'

afterEach(() => { vi.restoreAllMocks() })

test('renders scaled accessible row and column ranges and follows both scroll axes', () => {
  const rows = document.createElement('div'), columns = document.createElement('div')
  const headers = new SheetHeaders(rows, columns, (row, label) => `${row ? 'Row' : 'Column'} ${label}`)
  headers.update({ rows: [{ size: 0, text: 0 }, { size: 40, text: 1 }],
    columns: [{ size: 0, text: '' }, { size: 100, text: '<script>' }] }, 2)
  expect(rows.firstElementChild?.outerHTML).toContain('aria-label="Row 1"')
  expect(rows.firstElementChild?.getAttribute('data-range')).toBe('1:1')
  expect(rows.firstElementChild?.getAttribute('style')).toBe('top: 0px; height: 20px;')
  expect(columns.textContent).toBe('<script>')
  expect(columns.querySelector('script')).toBeNull()
  expect(columns.firstElementChild?.getAttribute('style')).toBe('left: 0px; width: 50px;')
  headers.scroll(12, 34)
  expect(rows.style.transform).toBe('translateY(-34px)')
  expect(columns.style.transform).toBe('translateX(-12px)')
  headers.update({ rows: [], columns: [] }, 1)
  expect(rows.childElementCount + columns.childElementCount).toBe(0)
})

test('scrolling mutates only the changed header axis and leaves 30 identical frames untouched', () => {
  const rows = document.createElement('div'), columns = document.createElement('div')
  const headers = new SheetHeaders(rows, columns, () => '')
  const observer = new MutationObserver(() => {})
  try {
    headers.scroll(12, 34)
    observer.observe(rows, { attributes: true })
    observer.observe(columns, { attributes: true })
    const rowStyle = vi.spyOn(rows.style, 'transform', 'set'), columnStyle = vi.spyOn(columns.style, 'transform', 'set')
    for (let frame = 0; frame < 30; frame++) headers.scroll(12, 34)
    expect(observer.takeRecords()).toHaveLength(0)
    expect(rowStyle).not.toHaveBeenCalled()
    expect(columnStyle).not.toHaveBeenCalled()
    headers.scroll(12, 35)
    expect(observer.takeRecords().map(record => record.target)).toEqual([rows])
    expect(rows.style.transform).toBe('translateY(-35px)')
    headers.scroll(13, 35)
    expect(observer.takeRecords().map(record => record.target)).toEqual([columns])
    expect(columns.style.transform).toBe('translateX(-13px)')
    for (let frame = 0; frame < 30; frame++) headers.scroll(13, 35)
    expect(observer.takeRecords()).toHaveLength(0)
  } finally { observer.disconnect() }
})

test.each([null, 1, {}, { rows: [] }, { columns: [] }])('rejects a header reply missing native axes: %s', (value) => {
  const headers = new SheetHeaders(document.createElement('div'), document.createElement('div'), () => '')
  expect(() => { headers.update(value, 1) }).toThrow('Invalid Office headers')
})

test.each([null, {}, [null], [1], [{}], [{ size: 1 }], [{ text: 1 }], [{ size: '1', text: 1 }],
  [{ size: Infinity, text: 'A' }], [{ size: 1, text: null }], [{ size: 1, text: {} }], [{ size: -1, text: 'A' }]])('rejects malformed native boundary data: %s', (value) => {
  expect(() => headerCells(value, 1)).toThrow('Invalid Office')
})
