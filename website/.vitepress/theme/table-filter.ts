/** Client-only filtering and page-scroll headers for original Markdown tables. */
const messages = {
  en: { placeholder: 'Search...', filter: 'Filter table', clear: 'Clear', empty: 'No matching rows.' },
  zh: { placeholder: 'Search...', filter: '筛选表格', clear: '清空', empty: '没有匹配的行。' },
}

class FilterableTable {
  readonly #controls: HTMLDivElement
  readonly #input: HTMLInputElement
  readonly #clear: HTMLButtonElement
  readonly #status: HTMLParagraphElement
  readonly #events = new AbortController()
  readonly #rows: { element: HTMLTableRowElement; text: string; hidden: HTMLTableRowElement['hidden'] }[]
  #empty = ''

  constructor(
    private readonly table: HTMLTableElement,
    private readonly head: HTMLTableSectionElement,
    rows: HTMLTableRowElement[],
    copy: typeof messages.en,
    private readonly changed: () => void,
  ) {
    const doc = table.ownerDocument
    this.#rows = rows.map(element => ({
      element,
      text: Array.from(element.cells, cell => cell.innerText).join(' ').toLowerCase(),
      hidden: element.hidden,
    }))
    this.#controls = doc.createElement('div')
    this.#controls.className = 'dsh-table-controls'
    const toolbar = doc.createElement('div')
    toolbar.className = 'dsh-table-toolbar'
    this.#input = doc.createElement('input')
    this.#input.type = 'search'
    this.#clear = doc.createElement('button')
    this.#clear.type = 'button'
    const clearIcon = doc.createElement('span')
    clearIcon.textContent = '×'
    clearIcon.setAttribute('aria-hidden', 'true')
    this.#clear.append(clearIcon)
    this.#status = doc.createElement('p')
    this.#status.setAttribute('role', 'status')
    toolbar.append(this.#input, this.#clear)
    this.#controls.append(toolbar, this.#status)
    table.before(this.#controls)
    table.classList.add('dsh-filterable-table')
    const options = { signal: this.#events.signal }
    this.#input.addEventListener('input', () => { this.#filter() }, options)
    this.#clear.addEventListener('click', () => {
      this.#input.value = ''
      this.#filter()
      this.#input.focus()
    }, options)
    this.localize(copy)
  }

  matches(head: HTMLTableSectionElement, rows: HTMLTableRowElement[]): boolean {
    return this.head === head && rows.length === this.#rows.length
      && rows.every((row, index) => row === this.#rows[index]?.element)
  }

  localize(copy: typeof messages.en): void {
    this.#input.placeholder = copy.placeholder
    this.#input.setAttribute('aria-label', copy.filter)
    this.#clear.setAttribute('aria-label', copy.clear)
    this.#clear.title = copy.clear
    this.#empty = copy.empty
    this.#filter()
  }

  #filter(): void {
    const query = this.#input.value.trim().toLowerCase()
    let visible = 0
    for (const row of this.#rows) {
      row.element.hidden = row.hidden || !row.text.includes(query)
      if (!row.element.hidden) visible++
    }
    this.#clear.hidden = this.#input.value.length === 0
    this.#status.textContent = visible === 0 ? this.#empty : ''
    this.changed()
  }

  measureHeaderOffset(top: number): number {
    return Math.min(
      Math.max(top - this.table.getBoundingClientRect().top, 0), Math.max(this.table.clientHeight - this.head.offsetHeight, 0),
    )
  }

  positionHeader(offset: number): void {
    // Horizontal overflow makes the table the sticky scroll container; translate its own head to retain column alignment.
    this.head.style.setProperty('--dsh-table-header-offset', `${offset}px`)
  }

  dispose(): void {
    this.#events.abort()
    this.#controls.remove()
    this.table.classList.remove('dsh-filterable-table')
    this.head.style.removeProperty('--dsh-table-header-offset')
    for (const row of this.#rows) row.element.hidden = row.hidden
  }
}

/** Owns long-table controls and layout subscriptions for one mounted documentation theme. */
export class DocumentTables {
  readonly #tables = new Map<HTMLTableElement, FilterableTable>()
  readonly #events = new AbortController()
  readonly #sizes: ResizeObserver
  #frame: number | undefined

  /**
   * @param doc Browser document containing the rendered VitePress article.
   * @param language Current VitePress language, read again on content refresh.
   */
  constructor(private readonly doc: Document, private readonly language: () => string) {
    this.#sizes = new ResizeObserver(() => { this.#schedule() })
    const content = doc.querySelector('#VPContent')
    if (content) this.#sizes.observe(content)
    const options = { passive: true, signal: this.#events.signal }
    window.addEventListener('scroll', () => { this.#schedule() }, options)
    window.addEventListener('resize', () => { this.#schedule() }, options)
    this.refresh()
  }

  /** Reconcile rendered tables after content updates, preserving queries for unchanged rows and headers. */
  refresh(): void {
    const tables = new Set(this.doc.querySelectorAll<HTMLTableElement>('.VPDoc main .vp-doc table'))
    for (const [table, entry] of this.#tables) {
      if (tables.has(table)) continue
      entry.dispose()
      this.#sizes.unobserve(table)
      this.#tables.delete(table)
    }
    const copy = this.language().startsWith('zh') ? messages.zh : messages.en
    for (const table of tables) {
      const rows = Array.from(table.tBodies).flatMap(body => Array.from(body.rows))
      const existing = this.#tables.get(table)
      if (table.tHead && rows.length >= 10 && existing?.matches(table.tHead, rows)) {
        existing.localize(copy)
        continue
      }
      existing?.dispose()
      this.#sizes.unobserve(table)
      this.#tables.delete(table)
      if (!table.tHead || rows.length < 10) continue
      this.#tables.set(table, new FilterableTable(table, table.tHead, rows, copy, () => { this.#schedule() }))
      this.#sizes.observe(table)
    }
    this.#schedule()
  }

  #schedule(): void {
    if (this.#tables.size === 0 || this.#frame !== undefined) return
    this.#frame = window.requestAnimationFrame(() => {
      this.#frame = undefined
      if (this.#tables.size === 0) return
      const navigation = this.doc.querySelectorAll('.VPNav, .VPLocalNav')
      const top = Math.max(0, ...Array.from(navigation, element => element.getBoundingClientRect().bottom))
      const positions = Array.from(this.#tables.values(), table => ({ table, offset: table.measureHeaderOffset(top) }))
      for (const { table, offset } of positions) table.positionHeader(offset)
    })
  }

  /** Remove controls and subscriptions, cancel pending layout work, and restore original row visibility. */
  dispose(): void {
    this.#events.abort()
    this.#sizes.disconnect()
    if (this.#frame !== undefined) window.cancelAnimationFrame(this.#frame)
    for (const table of this.#tables.values()) table.dispose()
    this.#tables.clear()
  }
}
