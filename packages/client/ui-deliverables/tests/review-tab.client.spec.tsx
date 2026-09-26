// @vitest-environment jsdom
/** The review tab type: its addresses, its store, the row pairing of the split view, and the states its body draws. */
import { renderFileActions } from './file-actions.tsx'
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SidebarRightTabActions } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import type { WorkspaceDiffHunk } from '@deepseek-ai/dsh-workspace-changes/types'
import {
  changesDiffUrl, changesReviewAddress, changesSummaryUrl, parseChangesReviewAddress, type ChangesDiff, type ChangesSummary,
} from '../src/changes.ts'
import { ChangesDiffStore } from '../src/client/changes-diff.ts'
import { ChangesSummaryStore } from '../src/client/changes-summary.ts'
import { PresentedOpenController } from '../src/client/present-open.ts'
import {
  ReviewTab, type ReviewInjected, type ReviewTabProps,
} from '../src/client/ReviewTab.tsx'
import { hunkRows, MAX_RENDERED_LINES, renderedHunks, splitRows } from '../src/client/FileDiff.tsx'
import { changesReviewDefinition } from '../src/client/review-definition.ts'
import { createReviewStore } from '../src/client/review-store.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const SESSION = SessionId('viewed')
const TAB = 'tab-1' as TabId
const COORDINATES = { sessionId: SESSION, seq: 5, turn: 2 }
const ADDRESS = changesReviewAddress(COORDINATES)
const SUMMARY_URL = changesSummaryUrl(SESSION, 5)

const summary: ChangesSummary = {
  turn: 2, total: 4, added: 4, deleted: 2,
  files: [
    { path: 'src/app/main.ts', display: 'src/app/main.ts', added: 3, deleted: 1 },
    { path: '/tmp/out/big.bin', display: '~/out/big.bin', added: 0, deleted: 0, oversized: true },
    { path: 'notes.txt', display: 'notes.txt', added: 1, deleted: 1 },
    { path: 'logo.png', display: 'logo.png', added: 0, deleted: 0, binary: true },
  ],
}

const text: ChangesDiff = {
  kind: 'text', path: 'src/app/main.ts', display: 'src/app/main.ts', before: true, after: true, coarse: false,
  hunks: [
    { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' a', '-b', '+B', '+c', ' d'] },
    { oldStart: 10, oldLines: 1, newStart: 11, newLines: 1, lines: ['-x', '+y'] },
    { oldStart: 20, oldLines: 1, newStart: 22, newLines: 0, lines: ['-z'] },
  ],
}

/** Test-local selector hook over a framework-neutral store instance. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S {
    return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot))
  }
}

describe('review addresses', () => {
  it('round-trips coordinates and titles the tab by the turn', () => {
    expect(ADDRESS).toBe('dsh-resource://changes-review/session/viewed/5/2')
    expect(parseChangesReviewAddress(ADDRESS)).toEqual(COORDINATES)
    const definition = changesReviewDefinition(makeTranslate(zh))
    expect(definition).toMatchObject({ kind: 'changes-review', priority: 'builtin', patterns: ['dsh-resource://changes-review/**'] })
    expect(definition.canOpen?.(ADDRESS)).toBe(true)
    expect(definition.title(ADDRESS)).toBe('第 2 轮改动')
    for (const bad of [
      'dsh-resource://file/session/viewed/a.ts', 'dsh-resource://changes-review/session/viewed/5',
      'dsh-resource://changes-review/session//5/2', 'dsh-resource://changes-review/session/viewed/x/2',
      'dsh-resource://changes-review/session/viewed/5/0', 'dsh-resource://changes-review/session/%E0%A4%A/5/2',
    ]) {
      expect(parseChangesReviewAddress(bad)).toBeUndefined()
      expect(definition.canOpen?.(bad)).toBe(false)
      expect(definition.title(bad)).toBe(bad)
    }
  })
})

describe('review store', () => {
  it('seeds a tab on its first navigation, applies later ones, toggles views, and forgets', () => {
    const store = createReviewStore().create()
    store.actions.navigated(TAB, 1, 2)
    expect(store.getSnapshot().byTab[TAB]).toEqual({ index: 2, split: true, wrap: false, navigated: 1 })
    store.actions.toggledSplit(TAB)
    store.actions.toggledWrap(TAB)
    store.actions.selected(TAB, 0)
    store.actions.navigated(TAB, 2, 1)
    expect(store.getSnapshot().byTab[TAB]).toEqual({ index: 1, split: false, wrap: true, navigated: 2 })
    store.actions.forget(TAB)
    expect(store.getSnapshot().byTab[TAB]).toBeUndefined()
    expect(() => { store.actions.selected(TAB, 0) }).toThrow('no review state')
  })
})

describe('hunk rows', () => {
  it('numbers unified rows on the side they belong to and pairs deletions with additions for the split view', () => {
    expect(hunkRows(text.hunks[0]!)).toEqual([
      { kind: 'context', old: 1, new: 1, text: 'a' },
      { kind: 'del', old: 2, new: undefined, text: 'b' },
      { kind: 'add', old: undefined, new: 2, text: 'B' },
      { kind: 'add', old: undefined, new: 3, text: 'c' },
      { kind: 'context', old: 3, new: 4, text: 'd' },
    ])
    expect(splitRows(text.hunks[0]!)).toEqual([
      { left: { no: 1, text: 'a', kind: 'context' }, right: { no: 1, text: 'a', kind: 'context' } },
      { left: { no: 2, text: 'b', kind: 'del' }, right: { no: 2, text: 'B', kind: 'add' } },
      { right: { no: 3, text: 'c', kind: 'add' } },
      { left: { no: 3, text: 'd', kind: 'context' }, right: { no: 4, text: 'd', kind: 'context' } },
    ])
    // A trailing run of deletions with no additions ends the hunk on the left alone.
    expect(splitRows({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 0, lines: ['-p', '-q'] })).toEqual([
      { left: { no: 1, text: 'p', kind: 'del' } }, { left: { no: 2, text: 'q', kind: 'del' } },
    ])
  })

  it('cuts the drawn hunks at the rendered-line cap', () => {
    const long = (count: number): string[] => Array.from({ length: count }, (_, at) => `+line ${at}`)
    const whole: WorkspaceDiffHunk = {
      oldStart: 1, oldLines: 0, newStart: 1, newLines: MAX_RENDERED_LINES + 2, lines: long(MAX_RENDERED_LINES + 2),
    }
    const cut = renderedHunks([whole])
    expect(cut.truncated).toBe(true)
    expect(cut.hunks[0]!.lines).toHaveLength(MAX_RENDERED_LINES)
    const small: WorkspaceDiffHunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }
    expect(renderedHunks([small, small])).toEqual({ hunks: [small, small], truncated: false })
    const two = renderedHunks([{ ...whole, lines: long(MAX_RENDERED_LINES) }, small])
    expect(two.hunks).toHaveLength(1)
    expect(two.truncated).toBe(true)
  })
})

describe('ReviewTab', () => {
  function mount(options: {
    summaries?: ChangesSummaryStore
    diffs?: ChangesDiffStore
    controller?: PresentedOpenController
    locale?: typeof en
    params?: unknown
    revision?: number
    address?: string
    cwd?: string | undefined
  } = {}) {
    const summaries = options.summaries ?? new ChangesSummaryStore()
    const diffs = options.diffs ?? new ChangesDiffStore()
    const controller = options.controller ?? new PresentedOpenController()
    const store = createReviewStore().create()
    const aborter = new AbortController()
    const tabActions = {
      openResource: vi.fn<SidebarRightTabActions['openResource']>(),
      openTab: vi.fn<SidebarRightTabActions['openTab']>(),
      close: vi.fn<SidebarRightTabActions['close']>(),
    }
    const injected = {
      loadChangesSummary: vi.fn<ReviewInjected['loadChangesSummary']>(() => Promise.resolve()),
      loadChangesDiff: vi.fn<ReviewInjected['loadChangesDiff']>(() => Promise.resolve()),
      reloadPresentedHost: vi.fn<ReviewInjected['reloadPresentedHost']>(() => Promise.resolve()),
      openChanged: vi.fn<ReviewInjected['openChanged']>(() => Promise.resolve(null)),
    }
    const sessions: SessionListState = {
      ids: [SESSION],
      byId: { [SESSION]: { id: SESSION, displayTitle: 'Workspace', cwd: options.cwd ?? '/work/app',
        running: false, retainedBy: {}, blank: false, updatedAt: 0 } },
      phase: 'ready', projectionsBySession: {},
    }
    const navigation = { address: options.address ?? ADDRESS, params: options.params, revision: options.revision ?? 1 }
    const runtime = {
      renderSlot: renderFileActions,
      useTabInfo: () => ({
        sidebar: { expanded: true, fullscreen: false }, panel: { id: 'pane-1' },
        tab: { id: TAB, kind: 'changes-review', contentId: options.address ?? ADDRESS, title: 'Review', visible: true, navigation, signal: aborter.signal, actions: tabActions },
      }),
      sessionId: SESSION,
      useSessions: <T,>(select: (state: SessionListState) => T): T => select(sessions),
      useStore: hookOf(store),
      actions: store.actions,
      useChangesSummary: hookOf(summaries.state),
      useChangesDiff: hookOf(diffs.state),
      usePresentedOpen: hookOf(controller.state),
      usePresentedHost: hookOf(controller.host),
      t: makeTranslate(options.locale ?? en),
      ...injected,
    } as ReviewTabProps
    const view = render(<ReviewTab {...runtime} />)
    return {
      view, injected, tabActions, store, aborter, summaries, diffs, controller,
      rerender: () => { view.rerender(<ReviewTab {...runtime} />) },
    }
  }

  it('reads the summary, opens on the navigated file, and switches files through the selector', () => {
    const summaries = new ChangesSummaryStore()
    const diffs = new ChangesDiffStore()
    const { view, injected, store } = mount({ summaries, diffs, params: { index: 2 } })
    expect(injected.loadChangesSummary).toHaveBeenCalledWith('viewed', 5)
    expect(injected.reloadPresentedHost).toHaveBeenCalledTimes(1)
    expect(view.container.querySelector('[data-changes-review]')?.getAttribute('data-review-state')).toBe('loading')
    expect(view.getByText('Review · turn 2')).toBeTruthy()
    act(() => { summaries.state.set({ [SUMMARY_URL]: summary }) })
    expect(store.getSnapshot().byTab[TAB]).toMatchObject({ index: 2, navigated: 1 })
    const selector = view.getByRole('button', { name: en['review.selectFile'] })
    expect(selector.getAttribute('data-review-file')).toBe('notes.txt')
    expect(injected.loadChangesDiff).toHaveBeenLastCalledWith('viewed', 5, 2)
    expect(view.getAllByText('+1')).toHaveLength(1)
    fireEvent.click(selector)
    expect(selector.getAttribute('aria-expanded')).toBe('true')
    // Escape closes the selector without changing the file.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(view.getByRole('button', { name: en['review.selectFile'] }).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(view.getByRole('button', { name: en['review.selectFile'] }))
    const items = view.getAllByRole('menuitem')
    expect(items.map(item => item.textContent)).toEqual([
      'src/app/main.ts+3-1', '~/out/big.bin' + en['changes.oversized'], 'notes.txt+1-1', 'logo.png' + en['changes.binary'],
    ])
    fireEvent.click(items[0]!)
    expect(store.getSnapshot().byTab[TAB]?.index).toBe(0)
    expect(view.getByRole('button', { name: en['review.selectFile'] }).getAttribute('data-review-file')).toBe('src/app/main.ts')
    expect(injected.loadChangesDiff).toHaveBeenLastCalledWith('viewed', 5, 0)
    act(() => { diffs.state.set({ [changesDiffUrl(SESSION, 5, 0)]: text }) })
    expect(view.container.querySelector('[data-review-view]')?.getAttribute('data-review-view')).toBe('split')
    fireEvent.click(view.getByRole('button', { name: en['review.splitAria'] }))
    const lines = [...view.container.querySelectorAll('[data-diff-line]')]
    expect(lines.map(line => line.getAttribute('data-diff-line'))).toEqual(['context', 'del', 'add', 'add', 'context', 'del', 'add', 'del'])
    expect(lines[1]?.textContent).toBe('2-b')
    expect(lines[4]?.textContent).toBe('34 d')
    expect(view.container.querySelector('[data-review-view]')?.getAttribute('data-review-view')).toBe('unified')
  })

  it('draws the split view by default and wraps lines on request, and keeps both choices in the tab store', () => {
    const summaries = new ChangesSummaryStore()
    summaries.state.set({ [SUMMARY_URL]: summary })
    const diffs = new ChangesDiffStore()
    diffs.state.set({ [changesDiffUrl(SESSION, 5, 0)]: text })
    const { view, store } = mount({ summaries, diffs })
    expect(store.getSnapshot().byTab[TAB]?.index).toBe(0)
    expect(store.getSnapshot().byTab[TAB]?.split).toBe(true)
    const body = view.container.querySelector('[data-review-view]')
    expect(body?.getAttribute('data-review-view')).toBe('split')
    expect(body?.hasAttribute('data-review-wrap')).toBe(false)
    // Without wrapping each side is its own column, so a long line scrolls within its side.
    const side = (name: string) => [...view.container.querySelectorAll(`[data-diff-side="${name}"] [data-diff-line]`)]
    expect(side('left').map(line => line.getAttribute('data-diff-line'))).toEqual(['context', 'del', 'add', 'context', 'del', 'del'])
    expect(side('left').map(line => line.textContent)).toEqual(['1a', '2b', '', '3d', '10x', '20z'])
    expect(side('right').map(line => line.textContent)).toEqual(['1a', '2B', '3c', '4d', '11y', ''])
    // The two sides scroll together on both axes, whichever side the reader drags.
    const [left, right] = ['left', 'right'].map(name => view.container.querySelector(`[data-diff-side="${name}"]`) as HTMLDivElement)
    fireEvent.scroll(left!, { target: { scrollLeft: 40, scrollTop: 66 } })
    expect([right!.scrollLeft, right!.scrollTop]).toEqual([40, 66])
    fireEvent.scroll(right!, { target: { scrollLeft: 15 } })
    expect([left!.scrollLeft, left!.scrollTop]).toEqual([15, 66])
    fireEvent.scroll(right!, { target: { scrollTop: 22 } })
    expect([left!.scrollLeft, left!.scrollTop]).toEqual([15, 22])
    fireEvent.scroll(right!, { target: { scrollLeft: 15, scrollTop: 22 } })
    expect([left!.scrollLeft, left!.scrollTop]).toEqual([15, 22])
    // A short peer clamps horizontal writes to zero, including the resulting scroll event.
    Object.defineProperty(right, 'scrollLeft', { configurable: true, get: () => 0, set: () => {} })
    fireEvent.scroll(left!, { target: { scrollLeft: 100 } })
    fireEvent.scroll(right!)
    expect(left!.scrollLeft).toBe(100)
    fireEvent.scroll(left!, { target: { scrollTop: 44 } })
    fireEvent.scroll(right!)
    expect([left!.scrollLeft, right!.scrollTop]).toEqual([100, 44])
    expect(view.getByRole('button', { name: en['review.splitAria'] }).getAttribute('aria-pressed')).toBe('true')
    // Wrapped lines vary in height, so both sides share one row per pair.
    fireEvent.click(view.getByRole('button', { name: en['review.wrapAria'] }))
    expect(view.container.querySelector('[data-review-view]')?.hasAttribute('data-review-wrap')).toBe(true)
    expect(view.container.querySelectorAll('[data-diff-side]')).toHaveLength(0)
    const rows = [...view.container.querySelectorAll('[data-diff-line]')]
    expect(rows.map(row => row.getAttribute('data-diff-line'))).toEqual(['context', 'del', 'add', 'context', 'del', 'del'])
    expect(rows[1]?.textContent).toBe('2b2B')
    expect(rows[2]?.textContent).toBe('3c')
    expect(rows[5]?.textContent).toBe('20z')
    expect(store.getSnapshot().byTab[TAB]).toMatchObject({ split: true, wrap: true })

    const oneSidedHunks: WorkspaceDiffHunk[] = [
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+new'] },
      { oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ['-old'] },
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' context', '+new'] },
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 1, lines: [' context', '-old'] },
    ]
    for (const wrap of [true, false]) {
      if (!wrap) fireEvent.click(view.getByRole('button', { name: en['review.wrapAria'] }))
      for (const hunk of oneSidedHunks) {
        act(() => { diffs.state.set({ [changesDiffUrl(SESSION, 5, 0)]: { ...text, hunks: [hunk] } }) })
        expect(view.container.querySelector('[data-review-view]')?.getAttribute('data-review-view')).toBe('unified')
        expect(view.container.querySelectorAll('[data-diff-line]')).toHaveLength(hunk.lines.length)
        expect(view.getByRole('button', { name: en['review.splitAria'] }).getAttribute('aria-pressed')).toBe('true')
        expect(store.getSnapshot().byTab[TAB]).toMatchObject({ split: true, wrap })
      }
      act(() => { diffs.state.set({ [changesDiffUrl(SESSION, 5, 0)]: { ...text, hunks: oneSidedHunks } }) })
      expect(view.container.querySelector('[data-review-view]')?.getAttribute('data-review-view')).toBe('split')
    }
  })

  it('syntax-highlights recognized source files with the shared code grammar', () => {
    const summaries = new ChangesSummaryStore()
    summaries.state.set({ [SUMMARY_URL]: summary })
    const diffs = new ChangesDiffStore()
    diffs.state.set({
      [changesDiffUrl(SESSION, 5, 0)]: {
        ...text,
        hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-const before = 1', '-', '+const after = 2', '+'] }],
      },
    })
    const { view } = mount({ summaries, diffs })
    const highlighted = [...view.container.querySelectorAll('[data-diff-code]')]
    expect(highlighted.map(line => line.textContent)).toEqual(['const before = 1', '', 'const after = 2', ''])
    expect(view.container.querySelectorAll('[data-diff-code] span[style]').length).toBeGreaterThan(2)
  })

  it('keeps unknown source files as plain text', () => {
    const summaries = new ChangesSummaryStore()
    summaries.state.set({ [SUMMARY_URL]: { ...summary, files: [{ ...summary.files[0]!, path: 'notes.unknown' }] } })
    const diffs = new ChangesDiffStore()
    diffs.state.set({
      [changesDiffUrl(SESSION, 5, 0)]: {
        ...text,
        path: 'notes.unknown',
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-before', '+after'] }],
      },
    })
    const { view } = mount({ summaries, diffs })
    expect(view.container.querySelector('[data-diff-code]')).toBeNull()
    expect(view.getByText('before')).toBeTruthy()
    expect(view.getByText('after')).toBeTruthy()
  })

  it('opens the whole file in the sidebar and the native open only with a desktop', () => {
    const summaries = new ChangesSummaryStore()
    summaries.state.set({ [SUMMARY_URL]: summary })
    const controller = new PresentedOpenController()
    controller.host.set({ name: 'desktop', available: true, fileManager: 'finder' })
    const { view, injected, tabActions } = mount({ summaries, controller, params: { index: 1 } })
    expect(injected.reloadPresentedHost).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-review-tool="open-file"] svg')?.getAttribute('width')).toBe('12')
    fireEvent.click(view.getByRole('button', { name: 'Open ~/out/big.bin in sidebar' }))
    expect(tabActions.openResource).toHaveBeenCalledWith(fileAddressFor(SESSION, '/work/app', '/tmp/out/big.bin'))
    fireEvent.click(view.getByRole('button', { name: 'Native file action' }))
    expect(injected.openChanged).toHaveBeenCalledWith('viewed', 5, 1, 'open', undefined)
    act(() => { controller.state.set({ 'api/changes.open?sessionId=viewed&seq=5&index=1': 'opening' }) })
    expect((view.getByRole('button', { name: 'Native file action' }) as HTMLButtonElement).disabled).toBe(true)
    act(() => { controller.state.set({ 'api/changes.open?sessionId=viewed&seq=5&index=1': 'error' }) })
    act(() => { controller.state.set({ 'api/changes.open?sessionId=viewed&seq=5&index=1': 'nativeUnavailable' }) })
    expect(view.queryByRole('button', { name: 'Native file action' })).toBeNull()
    act(() => {
      controller.state.set({})
      controller.host.set({ name: 'server', available: false, fileManager: null })
    })
    expect(view.queryByRole('button', { name: 'Native file action' })).toBeNull()
    expect(view.getByText(en['changes.oversized'])).toBeTruthy()
  })

  it('states the summary and comparison that stand in for hunks, and retries a failed read', () => {
    const summaries = new ChangesSummaryStore()
    summaries.state.set({ [SUMMARY_URL]: 'missing' })
    const missing = mount({ summaries, locale: zh })
    expect(missing.view.getByText(zh['diff.missing'])).toBeTruthy()
    expect(missing.view.getByText('第 2 轮改动')).toBeTruthy()
    missing.view.unmount()
    summaries.state.set({ [SUMMARY_URL]: summary })
    const diffs = new ChangesDiffStore()
    const { view, injected } = mount({ summaries, diffs, locale: zh })
    const url = changesDiffUrl(SESSION, 5, 0)
    expect(view.getByRole('status').textContent).toBe(zh['diff.loading'])
    act(() => { diffs.state.set({ [url]: 'error' }) })
    fireEvent.click(view.getByRole('button', { name: zh['presented.retry'] }))
    expect(injected.loadChangesDiff).toHaveBeenCalledTimes(2)
    act(() => { diffs.state.set({ [url]: 'missing' }) })
    expect(view.getByText(zh['diff.missing'])).toBeTruthy()
    act(() => { diffs.state.set({ [url]: { kind: 'binary', path: 'p', display: 'p' } }) })
    expect(view.getByText(zh['diff.binary'])).toBeTruthy()
    act(() => { diffs.state.set({ [url]: { kind: 'oversized', path: 'p', display: 'p' } }) })
    expect(view.getByText(zh['diff.oversized'])).toBeTruthy()
    act(() => { diffs.state.set({ [url]: { ...text, before: false, coarse: true } }) })
    expect(view.getByText(zh['diff.created'])).toBeTruthy()
    expect(view.container.querySelector('[data-diff-coarse]')?.textContent).toBe(zh['diff.coarse'])
    act(() => { diffs.state.set({ [url]: { ...text, after: false } }) })
    expect(view.getByText(zh['diff.deleted'])).toBeTruthy()
    act(() => { diffs.state.set({ [url]: { ...text, hunks: [] } }) })
    expect(view.getByText(zh['diff.unchanged'])).toBeTruthy()
    const long = Array.from({ length: MAX_RENDERED_LINES + 1 }, (_, at) => `+line ${at}`)
    act(() => {
      diffs.state.set({ [url]: { ...text, hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: long.length, lines: long }] } })
    })
    expect(view.container.querySelector('[data-review-view]')?.getAttribute('data-review-view')).toBe('unified')
    expect(view.container.querySelectorAll('[data-diff-line]')).toHaveLength(MAX_RENDERED_LINES)
    expect(view.container.querySelector('[data-diff-truncated]')?.textContent).toBe(`只显示前 ${MAX_RENDERED_LINES} 行`)
  })

  it('falls back to the first file for an index the summary does not list, and forgets its state with the tab', () => {
    const summaries = new ChangesSummaryStore()
    summaries.state.set({ [SUMMARY_URL]: summary })
    const { view, store, aborter, injected } = mount({ summaries, params: { index: 9 } })
    expect(view.getByRole('button', { name: en['review.selectFile'] }).getAttribute('data-review-file')).toBe('src/app/main.ts')
    expect(injected.loadChangesDiff).toHaveBeenLastCalledWith('viewed', 5, 0)
    expect(store.getSnapshot().byTab[TAB]).toBeDefined()
    aborter.abort()
    expect(store.getSnapshot().byTab[TAB]).toBeUndefined()
  })

  it('refuses an address it did not mint', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => mount({ address: 'dsh-resource://file/session/viewed/a.ts' })).toThrow('not a review address')
    error.mockRestore()
  })
})
