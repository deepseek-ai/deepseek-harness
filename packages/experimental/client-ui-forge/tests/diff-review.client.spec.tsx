// @vitest-environment jsdom
/** Diff gestures, browser clipboard output, and retained comments at their captured lines. */
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { DiffFile, type DiffFileProps } from '../src/client/DiffFile.tsx'
import { en } from '../src/client/locales.ts'
import { ReviewQueue } from '../src/client/review-queue.ts'
import { selectReviewLines } from '../src/client/review.ts'
import type { ReviewActions } from '../src/client/ReviewComposer.tsx'
import type { ForgeDiffFile } from '../src/types.ts'

const file: ForgeDiffFile = { path: 'a.txt', previousPath: null, status: 'modified', binary: false, oversized: false, untracked: false, additions: 3, deletions: 2,
  hunks: [{ oldStart: 2, oldLines: 3, newStart: 2, newLines: 4, lines: [' same', '-old first', '-old last', '+new first', '+new last', '+'] }] }
const source = { kind: 'local' as const, scope: 'branch' }
const t = makeTranslate(en)
afterEach(() => { cleanup(); document.getSelection()?.removeAllRanges(); localStorage.clear(); vi.restoreAllMocks() })

function mount(overrides: Partial<DiffFileProps> = {}) {
  const addToInput = vi.fn().mockReturnValue(true)
  const records = new ReviewQueue('diff-review')
  const review: ReviewActions = { source, addToInput, records, onQuoted: (item) => { records.recordAgent(item) } }
  const props: DiffFileProps = { file, visible: true, expanded: true, onToggle: vi.fn(), large: false, revealed: false, onReveal: vi.fn(),
    text: undefined, open: new Set(), onExpand: vi.fn(), split: true, wrap: true, badge: '', tooltip: 'a.txt', actions: [],
    sectionRef: vi.fn(), review, t, ...overrides }
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
})

it('refuses native and gutter ranges spanning collapsed context between hunks', () => {
  const m = mount({ file: { ...file, hunks: [...file.hunks,
    { oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: ['-before', '+after'] }] } })
  m.select('R', 4, 10)
  expect(m.queryByRole('button', { name: 'Add comment' })).toBeNull()
  fireEvent.click(m.line('R4'))
  fireEvent.click(m.line('R10'), { shiftKey: true })
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
