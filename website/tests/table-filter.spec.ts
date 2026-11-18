/** @vitest-environment jsdom */
/** Independent table filtering, localized controls, and layout resource ownership. */
import assert from 'node:assert/strict'
import { fireEvent, getByRole, queryAllByRole } from '@testing-library/dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentTables } from '../.vitepress/theme/table-filter.ts'

let tables: DocumentTables | undefined
let article: HTMLElement
let language: string
let frameId: number
const frames = new Map<number, FrameRequestCallback>()
const observers: ResizeObserverFixture[] = []

class ResizeObserverFixture implements ResizeObserver {
  readonly observe = vi.fn<(target: Element) => void>()
  readonly unobserve = vi.fn<(target: Element) => void>()
  readonly disconnect = vi.fn<() => void>()
  constructor(private readonly callback: ResizeObserverCallback) { observers.push(this) }
  notify(): void { this.callback([], this) }
}

beforeEach(() => {
  language = 'en-US'
  frameId = 0
  document.body.innerHTML = '<div id="VPContent" class="VPDoc"><main><div class="vp-doc"></div></main></div>'
  const content = document.querySelector<HTMLElement>('.vp-doc')
  assert(content)
  article = content
  vi.stubGlobal('ResizeObserver', ResizeObserverFixture)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++frameId, callback)
    return frameId
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id) })
})

afterEach(() => {
  tables?.dispose()
  tables = undefined
  frames.clear()
  observers.length = 0
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderTable(count = 10) {
  const section = document.createElement('section')
  const table = document.createElement('table')
  table.innerHTML = '<thead><tr><th>Service</th><th>Package</th><th>Description</th></tr></thead><tbody></tbody>'
  const body = table.tBodies[0]
  assert(body)
  for (let index = 0; index < count; index++) {
    const row = body.insertRow()
    row.innerHTML = index === 0
      ? '<td><code>ctx.llm</code></td><td><a href="/reference/llm">llm-deepseek</a></td><td>Streams completions</td>'
      : `<td>service-${index}</td><td>package-${index}</td><td>说明 ${index}</td>`
    for (const cell of row.cells) {
      // jsdom has no layout-backed innerText; these fixtures contain only visible text.
      Object.defineProperty(cell, 'innerText', { get: () => cell.textContent })
    }
  }
  section.append(table)
  article.append(section)
  const rows = Array.from(body.rows)
  return { section, table, body, rows }
}

function install(): DocumentTables {
  tables = new DocumentTables(document, () => language)
  return tables
}

function filter(section: HTMLElement, value: string): HTMLInputElement {
  const input = getByRole<HTMLInputElement>(section, 'searchbox')
  fireEvent.input(input, { target: { value } })
  return input
}

function visible(table: HTMLTableElement): HTMLTableRowElement[] {
  return Array.from(table.rows).filter(row => row.parentElement === table.tBodies[0] && !row.hidden)
}

function paint(): void {
  const callbacks = Array.from(frames.values())
  frames.clear()
  for (const callback of callbacks) callback(0)
}

describe('documentation table filtering', () => {
  it('enhances article tables from ten data rows, excluding short tables and search excerpts', () => {
    const short = renderTable(9)
    const long = renderTable(10)
    const longer = renderTable(11)
    const excerpt = long.section.cloneNode(true)
    document.body.append(excerpt)
    install()
    expect(queryAllByRole(short.section, 'searchbox')).toHaveLength(0)
    expect(queryAllByRole(long.section, 'searchbox')).toHaveLength(1)
    expect(queryAllByRole(longer.section, 'searchbox')).toHaveLength(1)
    expect(queryAllByRole(document.body, 'searchbox')).toHaveLength(2)
    expect(visible(long.table)).toEqual(long.rows)
  })

  it.each([
    ['  CTX.LLM  ', 0], ['LLM-DEEPSEEK', 0], ['streams', 0], ['说明 9', 9],
  ])('matches visible text across columns for %s', (query, index) => {
    const fixture = renderTable()
    install()
    filter(fixture.section, query)
    expect(visible(fixture.table)).toEqual([fixture.rows[index]])
    expect(fixture.body.rows).toHaveLength(10)
  })

  it('retains cell content and links and restores row order and input focus on clear', () => {
    const fixture = renderTable()
    const content = fixture.table.textContent
    const link = getByRole(fixture.table, 'link', { name: 'llm-deepseek' })
    install()
    expect(queryAllByRole(fixture.section, 'button')).toHaveLength(0)
    const input = filter(fixture.section, 'unmatched')
    expect(visible(fixture.table)).toHaveLength(0)
    expect(getByRole(fixture.section, 'status').textContent).toBe('No matching rows.')
    expect(fixture.table.textContent).toBe(content)
    const clear = getByRole<HTMLButtonElement>(fixture.section, 'button', { name: 'Clear' })
    expect(clear.textContent).toBe('×')
    clear.focus()
    clear.click()
    expect(visible(fixture.table)).toEqual(fixture.rows)
    expect(getByRole(fixture.table, 'link', { name: 'llm-deepseek' })).toBe(link)
    expect(link.getAttribute('href')).toBe('/reference/llm')
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('')
    expect(clear.hidden).toBe(true)
    expect(getByRole(fixture.section, 'status').textContent).toBe('')
    filter(fixture.section, '   ')
    expect(visible(fixture.table)).toEqual(fixture.rows)
    expect(clear.hidden).toBe(false)
  })

  it.each(['en-US', 'zh-CN'])('renders accessible controls and an empty result in %s', async (locale) => {
    language = locale
    const { section } = renderTable()
    install()
    filter(section, 'unmatched')
    const controls = section.firstElementChild
    assert(controls)
    await expect(`${controls.outerHTML}\n`).toMatchFileSnapshot(`./expected/table-filter.${locale}.html`)
  })

  it('keeps queries isolated across tables and preserves them through repeated content and locale refreshes', () => {
    const first = renderTable()
    const second = renderTable()
    const owner = install()
    const input = filter(first.section, 'unmatched')
    filter(second.section, 'package-9')
    language = 'zh-CN'
    owner.refresh()
    owner.refresh()
    expect(getByRole(first.section, 'searchbox', { name: '筛选表格' })).toBe(input)
    expect(getByRole(first.section, 'status').textContent).toBe('没有匹配的行。')
    expect(queryAllByRole(article, 'searchbox')).toHaveLength(2)
    getByRole(first.section, 'button', { name: '清空' }).click()
    expect(visible(first.table)).toEqual(first.rows)
    expect(visible(second.table)).toEqual([second.rows[9]])
  })

  it('drops removed-page controls and starts replacement-page tables without a query', () => {
    const previous = renderTable()
    const owner = install()
    const input = filter(previous.section, 'package-9')
    article.replaceChildren()
    const next = renderTable()
    owner.refresh()
    expect(queryAllByRole(previous.section, 'searchbox')).toHaveLength(0)
    expect(visible(previous.table)).toEqual(previous.rows)
    expect(getByRole<HTMLInputElement>(next.section, 'searchbox').value).toBe('')
    expect(visible(next.table)).toEqual(next.rows)
    fireEvent.input(input, { target: { value: 'unmatched' } })
    expect(visible(previous.table)).toEqual(previous.rows)
  })

  it('skips layout work on pages without long tables', () => {
    renderTable(9)
    install()
    fireEvent.scroll(window)
    fireEvent.resize(window)
    observers[0]?.notify()
    expect(frames.size).toBe(0)
  })

  it('keeps the header below navigation and above the horizontal scrollbar after scroll, resize, and filtering', () => {
    const { table, section } = renderTable()
    const head = table.tHead
    assert(head)
    const nav = document.createElement('header')
    nav.className = 'VPNav'
    document.body.prepend(nav)
    const layout = { top: 200, height: 500, nav: 64 }
    vi.spyOn(nav, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 800, layout.nav))
    vi.spyOn(table, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, layout.top, 600, layout.height + 15))
    vi.spyOn(table, 'clientHeight', 'get').mockImplementation(() => layout.height)
    vi.spyOn(head, 'offsetHeight', 'get').mockReturnValue(40)
    install()
    paint()
    expect(head.style.getPropertyValue('--dsh-table-header-offset')).toBe('0px')
    layout.top = -120
    fireEvent.scroll(window)
    fireEvent.scroll(window)
    expect(frames.size).toBe(1)
    paint()
    expect(head.style.getPropertyValue('--dsh-table-header-offset')).toBe('184px')
    layout.nav = 48
    fireEvent.resize(window)
    paint()
    expect(head.style.getPropertyValue('--dsh-table-header-offset')).toBe('168px')
    layout.top = -450
    observers[0]?.notify()
    paint()
    expect(head.style.getPropertyValue('--dsh-table-header-offset')).toBe('460px')
    layout.height = 40
    filter(section, 'unmatched')
    paint()
    expect(head.style.getPropertyValue('--dsh-table-header-offset')).toBe('0px')
  })

  it('restores initial visibility and stops pending frames, input handlers, and layout subscriptions on disposal', () => {
    const { section, table, rows } = renderTable()
    const first = rows[0]
    assert(first)
    first.hidden = true
    const owner = install()
    const input = filter(section, 'unmatched')
    expect(frames.size).toBe(1)
    owner.dispose()
    expect(frames.size).toBe(0)
    expect(queryAllByRole(section, 'searchbox')).toHaveLength(0)
    expect(table.className).toBe('')
    expect(table.tHead?.style.getPropertyValue('--dsh-table-header-offset')).toBe('')
    expect(visible(table)).toEqual(rows.slice(1))
    expect(observers[0]?.disconnect).toHaveBeenCalledOnce()
    fireEvent.input(input, { target: { value: 'unmatched' } })
    fireEvent.scroll(window)
    fireEvent.resize(window)
    expect(frames.size).toBe(0)
    expect(visible(table)).toEqual(rows.slice(1))
  })
})
