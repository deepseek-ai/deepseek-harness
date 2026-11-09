// @vitest-environment jsdom
/** Diff gestures, browser clipboard output, and retained comments at their captured lines. */
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { DiffFile, type DiffFileProps } from '../src/client/DiffFile.tsx'
import { en } from '../src/client/locales.ts'
import { ReviewQueue } from '../src/client/review-queue.ts'
import { SectionReach } from '../src/client/section-reach.ts'
import { selectReviewLines } from '../src/client/review.ts'
import type { ReviewActions } from '../src/client/ReviewComposer.tsx'
import type { ForgeDiffFile } from '../src/types.ts'

const file: ForgeDiffFile = { path: 'a.txt', previousPath: null, status: 'modified', binary: false, oversized: false, untracked: false, layer: 'implementation', digest: 'digest', additions: 3, deletions: 2,
  hunks: [{ oldStart: 2, oldLines: 3, newStart: 2, newLines: 4, lines: [' same', '-old first', '-old last', '+new first', '+new last', '+'] }] }
const source = { kind: 'local' as const, scope: 'branch', base: 'origin/main', baseRef: null, commits: null }
const t = makeTranslate(en)
afterEach(() => { cleanup(); document.getSelection()?.removeAllRanges(); localStorage.clear(); vi.restoreAllMocks() })

function mount(overrides: Partial<DiffFileProps> = {}) {
  const addToInput = vi.fn().mockReturnValue(true)
  const records = new ReviewQueue('diff-review')
  const review: ReviewActions = { source, addToInput, records, onQuoted: (item) => { records.recordAgent(item) } }
  const handlers = {
    toggle: vi.fn(), reveal: vi.fn(), expand: vi.fn(), view: vi.fn(), actions: () => [], section: vi.fn(), nextThread: vi.fn(),
    reach: new SectionReach(),
  }
  const props: DiffFileProps = { file, visible: true, expanded: true, large: false, revealed: false,
    text: undefined, open: new Set(), split: true, wrap: true, badge: '', tooltip: 'a.txt',
    viewed: 'unviewed', viewedNote: '', viewedDisabled: false, handlers, review, t, ...overrides }
  const view = render(<DiffFile {...props} />)
  const line = (name: string) => view.getByRole('button', { name: `Select line ${name}` })
  const code = (side: 'L' | 'R', no: number): HTMLElement => {
    const element = view.container.querySelector<HTMLElement>(`[data-review-code][data-${side === 'L' ? 'old' : 'new'}-line="${no}"]`)
    if (element === null) throw new Error('missing displayed line')
    return element
  }
  const select = (side: 'L' | 'R', from: number, to: number) => {
    const start = code(side, from), end = code(side, to)
    fireEvent.pointerDown(start, { button: 0, pointerId: 1 })
    act(() => { document.getSelection()!.setBaseAndExtent(start, 0, end, end.childNodes.length) })
    fireEvent.pointerUp(window, { pointerId: 1 })
  }
  return { ...view, props, line, code, select, addToInput, records }
}

it('selects a native range on one side, copies that side, and clears the range when its editor closes', () => {
  const m = mount()
  m.select('R', 3, 4)
  expect(m.getByRole('button', { name: 'Add comment' })).toBeTruthy()
  expect(m.line('R3').getAttribute('aria-pressed')).toBe('true')
  expect(m.line('L3').getAttribute('aria-pressed')).toBe('false')
  const setData = vi.fn()
  const copied = new Event('copy', { bubbles: true, cancelable: true })
  Object.defineProperty(copied, 'clipboardData', { value: { setData } })
  fireEvent(m.code('R', 3), copied)
  expect(copied.defaultPrevented).toBe(true)
  expect(setData).toHaveBeenCalledWith('text/plain', 'new first\nnew last')
  fireEvent(document, new Event('selectionchange'))
  expect(m.getByRole('button', { name: 'Add comment' })).toBeTruthy()
  fireEvent.pointerDown(m.getByRole('button', { name: 'Add comment' }), { button: 0 })
  fireEvent.click(m.getByRole('button', { name: 'Add comment' }))
  const input = m.getByRole('textbox')
  fireEvent.change(input, { target: { value: 'Explain this range' } })
  const inputCopy = new Event('copy', { bubbles: true, cancelable: true })
  Object.defineProperty(inputCopy, 'clipboardData', { value: { setData } })
  fireEvent(input, inputCopy)
  expect(inputCopy.defaultPrevented).toBe(false)
  fireEvent.click(m.getByRole('button', { name: 'Add to input' }))
  expect(m.addToInput.mock.lastCall?.[0]).toMatchObject({ source, comment: { side: 'R', startLine: 3, endLine: 4, body: 'Explain this range' } })
  expect(document.getSelection()!.isCollapsed).toBe(true)
  expect(m.container.querySelector('[data-forge-review-thread="agent"]')).not.toBeNull()
})

it('tracks native selection changes, ignores clipboard events without data, and clears a collapsed range', () => {
  const m = mount()
  const first = m.code('L', 2), last = m.code('L', 4)
  fireEvent.pointerDown(first, { button: 0 })
  act(() => { document.getSelection()!.setBaseAndExtent(first, 0, last, last.childNodes.length) })
  fireEvent(document, new Event('selectionchange'))
  expect(m.queryByRole('button', { name: 'Add comment' })).toBeNull()
  fireEvent.pointerCancel(window)
  expect(m.line('L2').getAttribute('aria-pressed')).toBe('true')
  const noClipboard = new Event('copy', { cancelable: true })
  Object.defineProperty(noClipboard, 'clipboardData', { value: null })
  fireEvent(document, noClipboard)
  expect(noClipboard.defaultPrevented).toBe(false)
  act(() => { document.getSelection()!.setBaseAndExtent(last, 0, last, last.childNodes.length) })
  fireEvent(document, new Event('selectionchange'))
  expect(m.line('L2').getAttribute('aria-pressed')).toBe('false')
  expect(m.line('L4').getAttribute('aria-pressed')).toBe('true')
  act(() => { document.getSelection()!.removeAllRanges() })
  const setData = vi.fn()
  const copy = new Event('copy')
  Object.defineProperty(copy, 'clipboardData', { value: { setData } })
  fireEvent(document, copy)
  expect(setData).not.toHaveBeenCalled()
  fireEvent(document, new Event('selectionchange'))
  expect(m.queryByRole('button', { name: 'Add comment' })).toBeNull()
})

it('extends gutter drags only within their side and requires the plus before editing', () => {
  const m = mount()
  fireEvent.pointerDown(m.line('L3'), { button: 2 })
  expect(m.queryByRole('button', { name: 'Add comment' })).toBeNull()
  fireEvent.pointerDown(m.line('L3'), { button: 0 })
  fireEvent.pointerOver(m.line('L4'), { buttons: 0 })
  fireEvent.pointerOver(m.line('R4'), { buttons: 1 })
  expect(m.line('R4').getAttribute('aria-pressed')).toBe('false')
  fireEvent.pointerOver(m.line('L4'), { buttons: 1 })
  expect(m.line('L4').getAttribute('aria-pressed')).toBe('true')
  fireEvent.pointerUp(window)
  fireEvent.click(m.line('R3'), { detail: 1 })
  expect(m.line('R3').getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(m.getByRole('button', { name: 'Add comment' }))
  fireEvent.pointerDown(m.line('R3'), { button: 0 })
  fireEvent.click(m.line('R3'))
  expect(m.getByRole('region', { name: 'Comment on L3–4' })).toBeTruthy()
  fireEvent.pointerDown(m.code('R', 3), { button: 0 })
  fireEvent.pointerUp(window)
  fireEvent.click(m.getByRole('button', { name: 'Cancel' }))
  expect(m.queryByRole('textbox')).toBeNull()
  fireEvent.click(m.line('R3'), { shiftKey: true })
  expect(m.line('R3').getAttribute('aria-pressed')).toBe('true')
})

it('keeps shift text selection and allows ordinary text selection when review actions are absent', () => {
  const m = mount()
  m.select('R', 3, 3)
  const selected = document.getSelection()!.toString()
  fireEvent.pointerDown(m.code('R', 4), { button: 0, shiftKey: true })
  expect(document.getSelection()!.toString()).toBe(selected)
  fireEvent.pointerUp(window)
  fireEvent.pointerDown(m.code('L', 3), { button: 0, shiftKey: true })
  expect(document.getSelection()!.isCollapsed).toBe(true)
  fireEvent.pointerUp(window)
  const { review: _review, ...withoutReview } = m.props
  m.rerender(<DiffFile {...withoutReview} />)
  m.select('R', 3, 4)
  expect(m.queryByRole('button', { name: 'Add comment' })).toBeNull()
  expect(m.container.querySelector('[data-review-add]')).toBeNull()
})

it('opens the editor from a hover plus in one press, extending the range on its side while dragging', () => {
  const m = mount()
  const plus = (name: string): HTMLElement => {
    const element = m.container.querySelector<HTMLElement>(`[data-review-add="${name}"]`)
    if (element === null) throw new Error(`missing hover plus ${name}`)
    return element
  }
  expect(plus('L3').getAttribute('aria-hidden')).toBe('true')
  fireEvent.pointerDown(plus('R3'), { button: 2 })
  expect(m.line('R3').getAttribute('aria-pressed')).toBe('false')
  fireEvent.pointerDown(plus('R3'), { button: 0 })
  // Crossing a row extends on the starting side, even over the other column.
  fireEvent.pointerOver(m.line('L4'), { buttons: 1 })
  expect(m.line('L4').getAttribute('aria-pressed')).toBe('false')
  expect(m.line('R4').getAttribute('aria-pressed')).toBe('true')
  fireEvent.pointerOver(plus('R4'), { buttons: 0 })
  fireEvent.pointerOver(plus('R5'), { buttons: 1 })
  expect(m.line('R5').getAttribute('aria-pressed')).toBe('true')
  fireEvent.pointerOver(plus('R4'), { buttons: 1 })
  expect(m.line('R5').getAttribute('aria-pressed')).toBe('false')
  fireEvent.pointerUp(window)
  expect(m.getByRole('region', { name: 'Comment on R3–4' })).toBeTruthy()
  // The open editor leaves every hover plus for the next comment, and the range it froze keeps the highlight.
  expect(m.container.querySelectorAll('[data-review-add]').length).toBeGreaterThan(0)
  expect(m.line('R3').getAttribute('aria-pressed')).toBe('false')
  expect(m.code('R', 3).closest('[data-diff-side]')!.className).toContain('selected')
  fireEvent.click(m.getByRole('button', { name: 'Cancel' }))
  fireEvent.pointerDown(plus('L2'), { button: 0 })
  fireEvent.pointerCancel(window)
  expect(m.queryByRole('textbox')).toBeNull()
  expect(m.line('L2').getAttribute('aria-pressed')).toBe('true')
  expect(m.container.querySelector('[data-review-add="L2"]')).toBeNull()
  fireEvent.click(m.getByRole('button', { name: 'Add comment' }))
  expect(m.getByRole('region', { name: 'Comment on L2' })).toBeTruthy()
})

it('extends a unified hover-plus drag through rows with a line on its side and keeps one plus per row', () => {
  // Old 1–4: keep 1, drop 2, keep 3, keep 4; new 1–4: keep 1, keep 3, added, keep 4.
  const mixed: ForgeDiffFile = { ...file, additions: 1, deletions: 1,
    hunks: [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [' keep 1', '-drop 2', ' keep 3', '+added', ' keep 4'] }] }
  const m = mount({ split: false, file: mixed })
  fireEvent.pointerDown(m.container.querySelector('[data-review-add="L2"]')!, { button: 0 })
  // Over the context row the pointer meets its new number, yet the drag extends on the old side.
  fireEvent.pointerOver(m.line('R2'), { buttons: 1 })
  expect(m.line('L3').getAttribute('aria-pressed')).toBe('true')
  // The added row has no old line, so the range stays.
  fireEvent.pointerOver(m.line('R3'), { buttons: 1 })
  expect(m.line('L3').getAttribute('aria-pressed')).toBe('true')
  fireEvent.pointerOver(m.line('R4'), { buttons: 1 })
  fireEvent.pointerUp(window)
  expect(m.getByRole('region', { name: 'Comment on L2–4' })).toBeTruthy()
  fireEvent.click(m.getByRole('button', { name: 'Cancel' }))
  // A gutter drag still extends only over numbers of its own side.
  fireEvent.pointerDown(m.line('L1'), { button: 0 })
  fireEvent.pointerOver(m.line('R2'), { buttons: 1 })
  expect(m.line('L3').getAttribute('aria-pressed')).toBe('false')
  fireEvent.pointerUp(window)
  // The row that shows the labeled plus offers no second hover plus at the same place.
  fireEvent.click(m.line('L3'))
  expect(m.getByRole('button', { name: 'Add comment' })).toBeTruthy()
  expect(m.container.querySelector('[data-review-add="R2"]')).toBeNull()
  expect(m.container.querySelector('[data-review-add="R4"]')).not.toBeNull()
  // Side by side, the deleted line's row has no new line, so a drag on the new side passes over it.
  m.rerender(<DiffFile {...m.props} split />)
  fireEvent.pointerDown(m.container.querySelector('[data-review-add="R1"]')!, { button: 0 })
  fireEvent.pointerOver(m.line('L2'), { buttons: 1 })
  fireEvent.pointerUp(window)
  expect(m.getByRole('region', { name: 'Comment on R1' })).toBeTruthy()
})

it('offers one hover plus per unified row, on the side its line belongs to', () => {
  const m = mount({ split: false })
  expect(Array.from(m.container.querySelectorAll('[data-review-add]'), element => element.getAttribute('data-review-add')))
    .toEqual(['R2', 'L3', 'L4', 'R3', 'R4', 'R5'])
  fireEvent.pointerDown(m.container.querySelector('[data-review-add="L3"]')!, { button: 0 })
  fireEvent.pointerUp(window)
  expect(m.getByRole('region', { name: 'Comment on L3' })).toBeTruthy()
})

it('refuses native, gutter, and hover-plus ranges spanning collapsed context between hunks', () => {
  const m = mount({ file: { ...file, hunks: [...file.hunks,
    { oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: ['-before', '+after'] }] } })
  m.select('R', 4, 10)
  expect(m.queryByRole('button', { name: 'Add comment' })).toBeNull()
  fireEvent.click(m.line('R4'))
  fireEvent.click(m.line('R10'), { shiftKey: true })
  expect(m.line('R4').getAttribute('aria-pressed')).toBe('true')
  expect(m.line('R10').getAttribute('aria-pressed')).toBe('false')
  // A refused press keeps the previous selection, and its release opens no editor for it.
  fireEvent.pointerDown(m.container.querySelector('[data-review-add="R10"]')!, { button: 0, shiftKey: true })
  fireEvent.pointerUp(window)
  expect(m.queryByRole('textbox')).toBeNull()
  expect(m.line('R4').getAttribute('aria-pressed')).toBe('true')
  expect(m.line('R10').getAttribute('aria-pressed')).toBe('false')
})

it('places left and right records in unified rows and retains outdated records for hidden hunks', () => {
  const m = mount({ split: false })
  act(() => {
    for (const side of ['L', 'R'] as const) m.records.recordAgent({ source, comment: { ...selectReviewLines(file, side, 3, 4)!, body: side } })
    m.records.recordAgent({ source, comment: { ...selectReviewLines(file, 'R', 3, 4)!, hunk: 'old patch', body: 'Outdated' } })
  })
  expect(m.container.querySelectorAll('[data-forge-review-thread]')).toHaveLength(3)
  expect(m.getByText('Outdated')).toBeTruthy()
  fireEvent.click(m.line('L3'))
  fireEvent.click(m.getByRole('button', { name: 'Add comment' }))
  fireEvent.click(m.getByRole('button', { name: 'Cancel' }))
  for (const overrides of [{ binary: true }, { oversized: true }, { hunks: [] }]) {
    m.rerender(<DiffFile {...m.props} file={{ ...file, ...overrides }} />)
    expect(m.container.querySelectorAll('[data-forge-review-thread]')).toHaveLength(3)
  }
  m.rerender(<DiffFile {...m.props} large />)
  expect(m.container.querySelectorAll('[data-forge-review-thread]')).toHaveLength(3)
  expect(within(m.container).getByRole('button', { name: /changed lines/ })).toBeTruthy()
})

it('draws a file\'s highlighted lines in the same render, so a changed file never shows its previous text', () => {
  const code = (text: string): ForgeDiffFile => ({ ...file, path: 'a.ts', additions: 1, deletions: 0, status: 'added',
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: [`+${text}`] }] })
  const m = mount({ file: code('const value = old()'), split: false })
  const line = (): HTMLElement => m.code('R', 1)
  expect(line().textContent).toBe('const value = old()')
  expect(line().hasAttribute('data-diff-code')).toBe(true)

  m.rerender(<DiffFile {...m.props} file={code('const value = renewed()')} split={false} />)
  expect(line().textContent).toBe('const value = renewed()')
  expect(line().hasAttribute('data-diff-code')).toBe(true)
})

it('keeps a text selection across a render that leaves the file unchanged', () => {
  const m = mount({ file: { ...file, path: 'a.ts' } })
  const start = m.code('R', 3)
  const node = start.firstChild
  act(() => { document.getSelection()!.setBaseAndExtent(start, 0, start, start.childNodes.length) })
  const selected = document.getSelection()?.toString()
  expect(selected).toBe('new first')
  m.rerender(<DiffFile {...m.props} file={{ ...file, path: 'a.ts' }} wrap={false} />)
  expect(m.code('R', 3).firstChild).toBe(node)
  expect(document.getSelection()?.toString()).toBe(selected)
})

it('writes a left and a right comment at once, each under its own column of the row, and focuses an open range again', () => {
  const m = mount()
  const open = (name: string) => {
    fireEvent.click(m.line(name))
    fireEvent.click(m.getByRole('button', { name: 'Add comment' }))
    return m.getByRole('region', { name: `Comment on ${name}` })
  }
  const left = open('L3')
  const right = open('R3')
  const row = left.closest<HTMLElement>('[data-forge-notes]')!
  expect(right.closest('[data-forge-notes]')).toBe(row)
  const [leftCell, rightCell] = Array.from(row.children)
  expect(leftCell!.contains(left)).toBe(true)
  expect(rightCell!.contains(right)).toBe(true)
  // Each cell continues the background of its side's line.
  expect(leftCell!.className).toContain('del')
  expect(rightCell!.className).toContain('add')
  expect(m.line('L3').getAttribute('aria-pressed')).toBe('false')
  fireEvent.change(within(right).getByRole('textbox'), { target: { value: 'Draft' } })
  open('R3')
  expect(m.getAllByRole('region', { name: 'Comment on R3' })).toHaveLength(1)
  expect(document.activeElement).toBe(within(right).getByRole('textbox'))
  expect(within(right).getByRole<HTMLTextAreaElement>('textbox').value).toBe('Draft')
  fireEvent.click(within(left).getByRole('button', { name: 'Cancel' }))
  expect(m.queryByRole('region', { name: 'Comment on L3' })).toBeNull()
  expect(m.getByRole('region', { name: 'Comment on R3' })).toBe(right)
})

it('places side-by-side records in their columns and keeps an editor whose line stops drawing after the lines', () => {
  const m = mount()
  act(() => {
    for (const side of ['L', 'R'] as const) m.records.recordAgent({ source, comment: { ...selectReviewLines(file, side, 3, 4)!, body: side } })
  })
  const threads = Array.from(m.container.querySelectorAll<HTMLElement>('[data-forge-review-thread]'))
  expect(threads.map(thread => thread.closest('[data-forge-notes]'))).toEqual([threads[0]!.closest('[data-forge-notes]'), threads[0]!.closest('[data-forge-notes]')])
  const cells = Array.from(threads[0]!.closest('[data-forge-notes]')!.children)
  expect(threads.map(thread => cells.findIndex(cell => cell.contains(thread)))).toEqual([0, 1])
  // The added blank line has no old line, so the left cell of its row is empty.
  fireEvent.click(m.line('R5'))
  fireEvent.click(m.getByRole('button', { name: 'Add comment' }))
  const editor = m.getByRole('region', { name: 'Comment on R5' })
  const [emptyCell] = Array.from(editor.closest('[data-forge-notes]')!.children)
  expect(emptyCell!.className).toContain('empty')
  expect(emptyCell!.querySelector('[data-forge-comments]')!.childElementCount).toBe(0)
  const shorter = { ...file.hunks[0]!, newLines: 3, lines: file.hunks[0]!.lines.slice(0, -1) }
  m.rerender(<DiffFile {...m.props} file={{ ...file, hunks: [shorter] }} />)
  const code = m.container.querySelector('[data-review]')!
  const rows = Array.from(code.children)
  const moved = m.getByRole('region', { name: 'Comment on R5' })
  expect(moved.parentElement).toBe(code)
  expect(rows.indexOf(moved)).toBeGreaterThan(rows.findLastIndex(row => row.hasAttribute('data-diff-pair')))
})

it('labels the plus on the unified row that ends a right-side range', () => {
  const m = mount({ split: false })
  fireEvent.click(m.line('R4'))
  expect(m.getByRole('button', { name: 'Add comment' })).toBeTruthy()
  expect(m.container.querySelector('[data-review-add="R4"]')).toBeNull()
  expect(m.container.querySelector('[data-review-add="R3"]')).not.toBeNull()
})
