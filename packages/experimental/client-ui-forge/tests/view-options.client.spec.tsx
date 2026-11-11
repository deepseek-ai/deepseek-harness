// @vitest-environment jsdom
/** The changes toolbar's More menu: the rows of each fold level, their marks, and their actions. */
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'
import { ViewOptionsMenu, type ViewOptions } from '../src/client/ViewOptionsMenu.tsx'

const t = makeTranslate(en)
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function mount(overrides: Partial<ViewOptions> = {}, visible = true, fold?: string) {
  const options: ViewOptions = {
    anyExpanded: false, hasFiles: true, toggleExpansion: vi.fn(), split: true, toggleSplit: vi.fn(), wrap: false, toggleWrap: vi.fn(),
    hideTests: true, toggleTests: vi.fn(), refresh: vi.fn(), lenses: [], chooseLens: vi.fn(), plugins: vi.fn(() => null), ...overrides,
  }
  const view = render(<div data-fold={fold}><ViewOptionsMenu options={options} visible={visible} t={t} /></div>)
  const trigger = within(view.container).getByRole('button', { name: en['diff.moreOptions'] })
  const rows = (): string[] => view.queryAllByRole('menuitem').map(row => row.textContent ?? '')
  return { view, options, trigger, rows }
}

it('lists every folded control and marks the active toggles outside a measured toolbar', () => {
  const m = mount()
  fireEvent.click(m.trigger)
  expect(m.trigger.getAttribute('aria-expanded')).toBe('true')
  expect(m.rows()).toEqual([en['diff.expandAll'], en['diff.splitAria'], en['diff.wrapAria'], en['tests.hide'], en['diff.refresh']])
  const marked = m.view.getAllByRole('menuitem').map(row => row.querySelector('svg') !== null)
  expect(marked).toEqual([false, true, false, true, false])
  fireEvent.click(m.trigger)
  expect(m.rows()).toEqual([])
})

it.each([
  ['1', [en['diff.collapseAll'], en['diff.splitAria'], en['diff.wrapAria']]],
  ['2', [en['diff.collapseAll'], en['diff.splitAria'], en['diff.wrapAria'], en['tests.hide']]],
  ['3', [en['diff.collapseAll'], en['diff.splitAria'], en['diff.wrapAria'], en['tests.hide'], en['diff.refresh']]],
])('lists the controls folded at level %s', (level, expected) => {
  const m = mount({ anyExpanded: true }, true, level)
  fireEvent.click(m.trigger)
  expect(m.rows()).toEqual(expected)
})

it('runs the chosen control and closes, omits the test switch without one, and stays closed in a hidden tab', () => {
  const m = mount({ hideTests: undefined })
  const choose = (name: string): void => {
    fireEvent.click(m.trigger)
    fireEvent.click(m.view.getByRole('menuitem', { name }))
    expect(m.rows()).toEqual([])
  }
  choose(en['diff.expandAll'])
  choose(en['diff.splitAria'])
  choose(en['diff.wrapAria'])
  choose(en['diff.refresh'])
  const actions = [m.options.toggleExpansion, m.options.toggleSplit, m.options.toggleWrap, m.options.refresh]
  expect(actions.map(action => vi.mocked(action).mock.calls.length))
    .toEqual([1, 1, 1, 1])
  fireEvent.click(m.trigger)
  expect(m.rows()).not.toContain(en['tests.hide'])
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(m.rows()).toEqual([])
  const hidden = mount({ hasFiles: false }, false)
  fireEvent.click(hidden.trigger)
  expect(hidden.trigger.getAttribute('aria-expanded')).toBe('false')
})

it('toggles test files from the menu', () => {
  const m = mount()
  fireEvent.click(m.trigger)
  fireEvent.click(m.view.getByRole('menuitem', { name: en['tests.hide'] }))
  expect(m.options.toggleTests).toHaveBeenCalledTimes(1)
})

it('lists the lenses with the test switch at level 2, chooses one, and draws the plugin rows that close the menu', () => {
  const chooseLens = vi.fn()
  const plugins = vi.fn((close: () => void) => <button type="button" role="menuitem" onClick={close}>Notes 2</button>)
  const m = mount({ lenses: [{ id: 'fixture/exports', title: 'Exports', count: 1 }], chooseLens, plugins }, true, '2')
  fireEvent.click(m.trigger)
  expect(m.rows()).toEqual(['Expand all files', 'Side by side', 'Wrap lines', 'Hide test files', 'No lens', 'Exports1', 'Notes 2'])
  fireEvent.click(within(document.body).getByRole('menuitem', { name: 'Exports1' }))
  expect(chooseLens).toHaveBeenCalledWith('fixture/exports')
  fireEvent.click(m.trigger)
  fireEvent.click(within(document.body).getByRole('menuitem', { name: 'Notes 2' }))
  expect(m.rows()).toEqual([])
})
