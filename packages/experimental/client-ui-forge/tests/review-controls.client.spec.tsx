// @vitest-environment jsdom
/** Review controls of the changes view: the lens in both forms, the test file switch, viewed progress, and the commit picker. */
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ForgeCommitList } from '@deepseek-ai/dsh-experimental-forge/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { CommitMenu, commitsLabel, type CommitMenuProps } from '../src/client/CommitMenu.tsx'
import { en } from '../src/client/locales.ts'
import { HideTestsSwitch, LensControl, LensMenu, SegmentedChoice, ViewedProgress, type LensProps } from '../src/client/ReviewControls.tsx'
import css from '../src/client/ReviewControls.module.css'
import './fonts-dom.client.ts'

const t = makeTranslate(en)
const COUNTS = { all: 6, interface: 1, implementation: 2, test: 3 }
const sha = (n: number): string => String(n).repeat(40)
const COMMITS: ForgeCommitList = {
  headSha: sha(3),
  truncated: false,
  commits: [1, 2, 3].map(n => ({ sha: sha(n), parent: n === 1 ? null : sha(n - 1), title: `commit ${n}`, author: 'octo', authoredAt: '2026-10-07T12:00:00Z' })),
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** Let the reads a control awaits settle. */
async function settle(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

function lensProps(overrides: Partial<LensProps> = {}): LensProps & { readonly choose: ReturnType<typeof vi.fn<LensProps['choose']>> } {
  return { lens: 'all', counts: COUNTS, hideTests: false, t, ...overrides, choose: vi.fn<LensProps['choose']>() }
}

describe('LensControl', () => {
  it('shows each lens with its count, chooses one by click, and walks enabled lenses by key', () => {
    const props = lensProps({ lens: 'interface' })
    const view = render(<LensControl {...props} need={vi.fn()} />)
    const radios = view.getAllByRole('radio')
    expect(radios.map(radio => radio.textContent)).toEqual(['All6', 'Interface1', 'Implementation2', 'Tests3'])
    expect(radios.map(radio => radio.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'false'])
    expect(radios.map(radio => radio.tabIndex)).toEqual([-1, 0, -1, -1])
    expect(view.getByRole('radiogroup', { name: en['lens.aria'] })).toBeDefined()

    fireEvent.click(radios[2]!)
    expect(props.choose).toHaveBeenLastCalledWith('implementation')
    for (const [key, lens] of [['ArrowRight', 'implementation'], ['ArrowDown', 'implementation'], ['ArrowLeft', 'all'], ['ArrowUp', 'all'],
      ['Home', 'all'], ['End', 'test']] as const) {
      fireEvent.keyDown(radios[1]!, { key })
      expect(props.choose).toHaveBeenLastCalledWith(lens)
    }
    const calls = props.choose.mock.calls.length
    fireEvent.keyDown(radios[1]!, { key: 'Enter' })
    expect(props.choose).toHaveBeenCalledTimes(calls)
  })

  it('moves focus with the selection and disables the test lens while test files hide', () => {
    const props = lensProps({ lens: 'implementation', hideTests: true })
    const view = render(<LensControl {...props} need={vi.fn()} />)
    const tests = view.getByRole('radio', { name: /^Tests/ })
    expect((tests as HTMLButtonElement).disabled).toBe(true)
    expect(tests.textContent).toBe('Tests')
    const implementation = view.getByRole('radio', { name: /^Implementation/ })
    implementation.focus()
    fireEvent.keyDown(implementation, { key: 'ArrowRight' })
    expect(props.choose).toHaveBeenLastCalledWith('all')
    expect(document.activeElement).toBe(view.getByRole('radio', { name: /^All/ }))
    fireEvent.keyDown(implementation, { key: 'End' })
    expect(props.choose).toHaveBeenLastCalledWith('implementation')
  })
})

describe('LensControl width', () => {
  /** Render the lens in a cell with 8px padding on each side, the counted and bare forms measuring at the given widths. */
  function fitted(widths: { cell: number; counted: number; labels: number }) {
    let resized: () => void = () => {}
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resized = callback }
      observe = vi.fn()
      disconnect = vi.fn()
    })
    onTestFinished(() => { vi.unstubAllGlobals() })
    const part = (element: HTMLElement): 'cell' | 'root' | 'counted' | 'labels' | null => {
      if (element.dataset.cell !== undefined) return 'cell'
      if (element.parentElement?.dataset.cell !== undefined) return 'root'
      const measures = element.parentElement
      if (measures?.getAttribute('aria-hidden') !== 'true') return null
      return element === measures.firstElementChild ? 'counted' : 'labels'
    }
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const role = part(this)
      const width = role === 'cell' ? widths.cell : role === 'root' ? Math.max(0, widths.cell - 16)
        : role === 'counted' ? widths.counted : role === 'labels' ? widths.labels : 0
      return new DOMRect(0, 0, width, 28)
    })
    const need = vi.fn<(width: number) => void>()
    const view = render(<div data-cell=""><LensControl {...lensProps({ lens: 'interface' })} need={need} /></div>)
    const counts = (): (string | undefined)[] => view.getAllByRole('radio').map(radio => radio.lastElementChild?.className)
    return { view, need, counts, widths, resize: (cell: number) => { widths.cell = cell; act(() => { resized() }) } }
  }

  it('shows the counts while they fit and the labels alone otherwise, keeping each count in its segment\'s name', () => {
    const { view, need, counts, resize } = fitted({ cell: 300, counted: 280, labels: 200.25 })
    expect(counts()).toEqual(Array(4).fill(css.count))
    expect(need).toHaveBeenLastCalledWith(217)
    resize(290)
    expect(counts()).toEqual(Array(4).fill(css.hiddenCount))
    expect(view.getByRole('radio', { name: 'Interface1' }).getAttribute('aria-checked')).toBe('true')
    resize(296)
    expect(counts()).toEqual(Array(4).fill(css.count))
  })

  it('keeps the focused segment mounted while its count shows or hides', () => {
    const { view, counts, resize } = fitted({ cell: 300, counted: 280, labels: 200 })
    const focused = view.getByRole('radio', { name: 'Interface1' })
    focused.focus()
    resize(290)
    expect(counts()).toEqual(Array(4).fill(css.hiddenCount))
    expect(document.activeElement).toBe(focused)
    resize(300)
    expect(counts()).toEqual(Array(4).fill(css.count))
    expect(document.activeElement).toBe(focused)
  })

  it('measures again when fonts load, and stops once unmounted', () => {
    const { view, need, counts, widths } = fitted({ cell: 300, counted: 280, labels: 200 })
    widths.counted = 290
    widths.labels = 230
    act(() => { document.fonts.dispatchEvent(new Event('loadingdone')) })
    expect(counts()).toEqual(Array(4).fill(css.hiddenCount))
    expect(need).toHaveBeenLastCalledWith(246)
    view.unmount()
    need.mockClear()
    document.fonts.dispatchEvent(new Event('loadingdone'))
    expect(need).not.toHaveBeenCalled()
  })

  it('names a hidden count in the hover text of its segment, and nothing for a segment without a count', () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const view = render(<SegmentedChoice label="Filter" value="a" choose={vi.fn()} counted={false} segments={[
      { value: 'a', label: 'Open', count: null, disabledTip: null },
      { value: 'b', label: 'Done', count: 2, disabledTip: null },
    ]} />)
    const hover = (name: RegExp): string | null => {
      const radio = view.getByRole('radio', { name })
      fireEvent.pointerEnter(radio)
      act(() => { vi.advanceTimersByTime(1000) })
      const text = within(document.body).queryByRole('tooltip')?.textContent ?? null
      fireEvent.pointerLeave(radio)
      act(() => { vi.advanceTimersByTime(1000) })
      return text
    }
    expect(hover(/^Done/)).toBe('Done 2')
    expect(hover(/^Open/)).toBeNull()
  })

  it('leaves the form as it is while the cell has no width', () => {
    const { counts, need, resize } = fitted({ cell: 0, counted: 280, labels: 200 })
    expect(counts()).toEqual(Array(4).fill(css.count))
    expect(need).not.toHaveBeenCalled()
    resize(0)
    expect(need).not.toHaveBeenCalled()
  })
})

describe('LensMenu', () => {
  it('names the lens on its trigger and chooses another from its menu', () => {
    const props = lensProps({ lens: 'test' })
    const view = render(<LensMenu {...props} visible />)
    const trigger = view.getByRole('button', { name: 'Review layer: Tests' })
    fireEvent.click(trigger)
    const menu = within(document.body).getByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['All6', 'Interface1', 'Implementation2', 'Tests3'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Interface1' }))
    expect(props.choose).toHaveBeenCalledWith('interface')
    expect(within(document.body).queryByRole('menu')).toBeNull()
    fireEvent.click(trigger)
    fireEvent.keyDown(within(document.body).getByRole('menu'), { key: 'Escape' })
    expect(within(document.body).queryByRole('menu')).toBeNull()
  })

  it('disables the test lens without its count while test files hide, as the segments do', () => {
    const view = render(<LensMenu {...lensProps({ hideTests: true, counts: { ...COUNTS, test: 0 } })} visible />)
    fireEvent.click(view.getByRole('button', { name: 'Review layer: All' }))
    const tests = within(document.body).getByRole('menuitem', { name: 'Tests' })
    expect(tests.textContent).toBe('Tests')
    expect((tests as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps its menu closed while the tab is hidden', () => {
    const view = render(<LensMenu {...lensProps()} visible={false} />)
    fireEvent.click(view.getByRole('button', { name: 'Review layer: All' }))
    expect(within(document.body).queryByRole('menu')).toBeNull()
  })
})

describe('HideTestsSwitch and ViewedProgress', () => {
  it('toggles from the switch and from its label', () => {
    const toggle = vi.fn()
    const view = render(<HideTestsSwitch hidden={false} toggle={toggle} t={t} />)
    fireEvent.click(view.getByRole('switch', { name: en['tests.hide'] }))
    fireEvent.click(view.getByText(en['tests.hide']))
    expect(toggle).toHaveBeenCalledTimes(2)
  })

  it('shows viewed files out of shown files, and nothing without shown files', () => {
    const view = render(<ViewedProgress viewed={2} total={4} t={t} />)
    const bar = view.getByRole('progressbar', { name: en['viewed.progressAria'] })
    expect([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax'), bar.getAttribute('aria-valuetext')]).toEqual(['2', '4', '2 / 4 viewed'])
    // One ring filled to the viewed share, then the label, or the bare count a narrow toolbar shows instead.
    const [length, gap] = bar.querySelectorAll('circle')[1]!.getAttribute('stroke-dasharray')!.split(' ').map(Number)
    expect(length! / gap!).toBeCloseTo(0.5)
    expect(bar.querySelectorAll('svg')).toHaveLength(1)
    expect([...bar.querySelectorAll('[data-forge-progress]')].map(form => [form.getAttribute('data-forge-progress'), form.textContent]))
      .toEqual([['full', '2 / 4 viewed'], ['compact', '2/4']])
    view.rerender(<ViewedProgress viewed={0} total={0} t={t} />)
    expect(view.queryByRole('progressbar')).toBeNull()
  })
})

describe('CommitMenu', () => {
  // The rows name each commit's age; pin Date so the label does not follow the wall clock.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-09T12:00:00Z') }) })
  afterEach(() => { vi.useRealTimers() })

  function mount(props: Partial<CommitMenuProps> = {}) {
    const list = props.list ?? vi.fn<CommitMenuProps['list']>(async () => ({ ok: true, value: COMMITS }))
    const choose = vi.fn<CommitMenuProps['choose']>()
    const all: CommitMenuProps = { chosen: null, visible: true, kept: 'oldest', version: 'v1', t, ...props, list, choose }
    const view = render(<CommitMenu {...all} />)
    const rerender = (next: Partial<CommitMenuProps>): void => { view.rerender(<CommitMenu {...all} {...next} />) }
    const rows = (): string[] => within(document.body).queryAllByRole('menuitem').map(row => row.textContent ?? '')
    const row = (n: number): HTMLElement => within(document.body).getByRole('menuitem', { name: new RegExp(`^${sha(n).slice(0, 7)}`) })
    return { view, list, choose, rerender, rows, row }
  }

  it('names all commits, one commit, or a run of commits', () => {
    expect(commitsLabel(null, t)).toBe('All commits')
    expect(commitsLabel({ from: sha(1), to: sha(1) }, t)).toBe('1111111')
    expect(commitsLabel({ from: sha(1), to: sha(2) }, t)).toBe('1111111…2222222')
  })

  it('starts a Shift run at the one commit shown, also when it was chosen outside the menu', async () => {
    const shiftTo = async (m: ReturnType<typeof mount>, shown: number, clicked: number): Promise<void> => {
      fireEvent.click(m.view.getByRole('button', { name: `Commits shown: ${sha(shown).slice(0, 7)}` }))
      await settle()
      fireEvent.click(m.row(clicked), { shiftKey: true })
    }
    // No commit was clicked in the menu before its owner showed commit 2.
    const fresh = mount()
    await settle()
    fresh.rerender({ chosen: { from: sha(2), to: sha(2) } })
    await shiftTo(fresh, 2, 3)
    expect(fresh.choose).toHaveBeenLastCalledWith({ from: sha(2), to: sha(3) })
    cleanup()

    // Commit 1 was clicked in the menu before its owner showed commit 2.
    const used = mount()
    await settle()
    fireEvent.click(used.view.getByRole('button', { name: 'Commits shown: All commits' }))
    await settle()
    fireEvent.click(used.row(1))
    used.rerender({ chosen: { from: sha(1), to: sha(1) } })
    used.rerender({ chosen: { from: sha(2), to: sha(2) } })
    await shiftTo(used, 2, 3)
    expect(used.choose).toHaveBeenLastCalledWith({ from: sha(2), to: sha(3) })
  })

  it('reads the commits once per version, keeps them across openings, and chooses one or a Shift run of them', async () => {
    const m = mount()
    await settle()
    expect(m.list).toHaveBeenCalledTimes(1)
    m.rerender({ visible: true })
    await settle()
    expect(m.list).toHaveBeenCalledTimes(1)
    const trigger = m.view.getByRole('button', { name: 'Commits shown: All commits' })
    fireEvent.click(trigger)
    await settle()
    expect(m.list).toHaveBeenCalledTimes(1)
    const rows = m.rows()
    expect(rows[0]).toBe('All commits3 commits')
    expect(rows.slice(1)).toEqual([1, 2, 3].map(n => `${sha(n).slice(0, 7)}commit ${n}${t('time.days', { n: 2 })}`))
    expect(within(document.body).getByText(en['commits.shiftHint'])).toBeDefined()
    expect(within(document.body).getByRole('menuitem', { name: /^All commits/ }).getAttribute('aria-current')).toBe('page')
    fireEvent.click(m.row(2))
    expect(m.choose).toHaveBeenLastCalledWith({ from: sha(2), to: sha(2) })

    m.rerender({ chosen: { from: sha(2), to: sha(2) } })
    fireEvent.click(m.view.getByRole('button', { name: 'Commits shown: 2222222' }))
    await settle()
    expect([1, 2, 3].map(n => m.row(n).getAttribute('aria-current'))).toEqual([null, 'page', null])
    fireEvent.click(m.row(3), { shiftKey: true })
    expect(m.choose).toHaveBeenLastCalledWith({ from: sha(2), to: sha(3) })

    m.rerender({ chosen: { from: sha(2), to: sha(3) } })
    fireEvent.click(m.view.getByRole('button', { name: 'Commits shown: 2222222…3333333' }))
    await settle()
    expect([1, 2, 3].map(n => m.row(n).getAttribute('aria-current'))).toEqual([null, 'page', 'page'])
    fireEvent.click(m.row(1), { shiftKey: true })
    expect(m.choose).toHaveBeenLastCalledWith({ from: sha(1), to: sha(2) })
    const calls = m.choose.mock.calls.length
    fireEvent.click(m.view.getByRole('button', { name: 'Commits shown: 2222222…3333333' }))
    await settle()
    fireEvent.keyDown(m.row(3), { key: 'Enter', shiftKey: true })
    fireEvent.click(m.row(3), { shiftKey: true })
    expect(m.choose).toHaveBeenCalledTimes(calls)
    fireEvent.click(m.view.getByRole('button', { name: 'Commits shown: 2222222…3333333' }))
    await settle()
    fireEvent.click(within(document.body).getByRole('menuitem', { name: /^All commits/ }))
    expect(m.choose).toHaveBeenLastCalledWith(null)

    expect(m.list).toHaveBeenCalledTimes(1)
    m.rerender({ chosen: null, version: 'v2' })
    await settle()
    expect(m.list).toHaveBeenCalledTimes(2)
  })

  it('keeps its menu open and says why for a Shift run that leaves the first-parent line', async () => {
    // The third commit sits on another branch from the first one, after the second in the list.
    const commits = COMMITS.commits.map(commit => commit.sha === sha(3) ? { ...commit, parent: sha(1) } : commit)
    const m = mount({ list: async () => ({ ok: true, value: { ...COMMITS, commits } }) })
    fireEvent.click(m.view.getByRole('button', { name: 'Commits shown: All commits' }))
    await settle()
    fireEvent.click(m.row(2))
    expect(m.choose).toHaveBeenLastCalledWith({ from: sha(2), to: sha(2) })
    m.rerender({ chosen: { from: sha(2), to: sha(2) } })
    fireEvent.click(m.view.getByRole('button', { name: 'Commits shown: 2222222' }))
    await settle()

    fireEvent.click(m.row(3), { shiftKey: true })
    expect(m.choose).toHaveBeenCalledTimes(1)
    expect(within(document.body).getByRole('menu')).toBeDefined()
    expect(within(document.body).getByRole('status').textContent).toBe(en['commits.notLinear'])
    fireEvent.click(m.row(1), { shiftKey: true })
    expect(m.choose).toHaveBeenLastCalledWith({ from: sha(1), to: sha(2) })
    expect(within(document.body).queryByRole('status')).toBeNull()
  })

  it('starts a Shift run at the clicked commit without an earlier choice, and ignores choosing every commit again', async () => {
    const m = mount({ list: async () => ({ ok: true, value: { ...COMMITS, commits: COMMITS.commits.map(commit => ({ ...commit, authoredAt: 'unknown' })) } }) })
    fireEvent.click(m.view.getByRole('button', { name: 'Commits shown: All commits' }))
    await settle()
    expect(m.row(3).textContent).toBe('3333333commit 3')
    fireEvent.click(m.row(3), { shiftKey: true })
    expect(m.choose).toHaveBeenLastCalledWith({ from: sha(3), to: sha(3) })
    fireEvent.click(m.view.getByRole('button', { name: 'Commits shown: All commits' }))
    await settle()
    fireEvent.click(within(document.body).getByRole('menuitem', { name: /^All commits/ }))
    expect(m.choose).toHaveBeenCalledTimes(1)
  })

  it('notes a truncated list, retries a failed read, and disappears for a source without commits', async () => {
    let result: RemoteResult<ForgeCommitList | null> = { ok: false, error: new RemoteError('forgePanel/diff-failed', 'down', {}) }
    const list = vi.fn<CommitMenuProps['list']>(async () => result)
    const m = mount({ list })
    fireEvent.click(m.view.getByRole('button', { name: 'Commits shown: All commits' }))
    expect(within(document.body).getByRole('status').textContent).toBe(en['commits.loading'])
    await settle()
    expect(within(document.body).getByRole('status').textContent).toContain(en['commits.failed'])
    result = { ok: true, value: { ...COMMITS, commits: [], truncated: true } }
    fireEvent.click(within(document.body).getByRole('button', { name: en.retry }))
    await settle()
    expect(m.rows()).toEqual(['All commits0 commits'])
    expect(within(document.body).queryByText(en['commits.shiftHint'])).toBeNull()
    expect(within(document.body).getByText('Only the earliest 0 commits are listed')).toBeDefined()
    m.rerender({ kept: 'newest' })
    expect(within(document.body).getByText('Only the latest 0 commits are listed')).toBeDefined()
    fireEvent.keyDown(within(document.body).getByRole('menu'), { key: 'Escape' })

    result = { ok: true, value: null }
    m.rerender({ version: 'v2' })
    await settle()
    expect(m.view.container.textContent).toBe('')
  })

  it('reads nothing while hidden and drops a read that a newer version replaced', async () => {
    const pending = Promise.withResolvers<RemoteResult<ForgeCommitList | null>>()
    const list = vi.fn<CommitMenuProps['list']>(() => pending.promise)
    const m = mount({ list, visible: false })
    await settle()
    expect(list).not.toHaveBeenCalled()
    m.rerender({ visible: true })
    m.rerender({ visible: true, version: 'v2' })
    pending.resolve({ ok: true, value: null })
    await settle()
    expect(m.view.container.textContent).toBe('')
    expect(list).toHaveBeenCalledTimes(2)
  })
})
