// @vitest-environment jsdom
/** The changes tab: reading each source and scope, the toolbar, file sections, unchanged lines, notices, and failures. */
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneId, SidebarRightTabActions, SidebarRightTabInfo, TabId } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import { CHANGES_KIND, changesAddress, type ChangesParams, type ChangesSource } from '../src/client/changes-address.ts'
import { createChangesStore } from '../src/client/changes-store.ts'
import { ChangesTab, type ChangesTabInjected, type ChangesTabProps } from '../src/client/ChangesTab.tsx'
import { en } from '../src/client/locales.ts'
import type { PanelSnapshot } from '../src/client/source.ts'
import css from '../src/client/ChangesTab.module.css'
import type { ForgeChangeRequestDiff, ForgeDiffFile, ForgeLocalDiff, ForgePanelState } from '../src/types.ts'
import { entry, ready, snapshot } from './client-fixtures.client.ts'

const t = makeTranslate(en)
const SESSION = SessionId('s1')
const TAB = 'tab-changes' as TabId
const URL7 = 'https://github.com/octo/demo/pull/7'
const HEAD = 'a'.repeat(40)
const BASE = 'origin/main'

const scrolled = vi.fn()

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrolled })
})

afterEach(() => {
  cleanup()
  scrolled.mockReset()
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
})

/** Hover the path of a file section past the tooltip delay and read the tooltip, then leave it. */
function hoverPath(section: HTMLElement): string | null {
  const label = section.querySelector('[data-forge-file-label]')
  if (!(label instanceof HTMLElement)) throw new Error('no file label')
  vi.useFakeTimers()
  try {
    fireEvent.pointerEnter(label)
    act(() => { vi.advanceTimersByTime(1000) })
    return within(document.body).getByRole('tooltip').textContent
  } finally {
    fireEvent.pointerLeave(label)
    vi.useRealTimers()
  }
}

function file(path: string, overrides: Partial<ForgeDiffFile> = {}): ForgeDiffFile {
  return {
    path, previousPath: null, status: 'modified', binary: false, oversized: false, untracked: false, additions: 0, deletions: 0, hunks: [],
    ...overrides,
  }
}

/** New side of `src/app.ts`: 13 lines, of which its hunks change 3–6 and 11. */
const APP_LINES = [
  'const a1 = 1', 'const a2 = 2', 'const a3 = 3', 'const y = 4', 'const z = 5', 'const a5 = 6', 'const a6 = 7',
  'const a7 = 8', 'const a8 = 9', 'const a9 = 10', 'const a10 = 11', 'const t12 = 12', 'const t13 = 13',
]
const APP_TEXT = `${APP_LINES.join('\n')}\n`
const APP = file('src/app.ts', {
  additions: 2,
  deletions: 2,
  hunks: [
    { oldStart: 3, oldLines: 3, newStart: 3, newLines: 4, lines: [' const a3 = 3', '-const x = 4', '+const y = 4', '+const z = 5', ' const a5 = 6'] },
    { oldStart: 10, oldLines: 2, newStart: 11, newLines: 1, lines: [' const a10 = 11', '-const w = 12'] },
  ],
})
const ADDED = file('src/new.ts', {
  status: 'added', untracked: true, additions: 2,
  hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+export const added = 1', '+'] }],
})
const LOGO = file('assets/logo.png', { binary: true })
const GONE = file('docs/gone.txt', { status: 'deleted', deletions: 1, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 0, lines: ['-bye'] }] })
const MOVED = file('lib/b.txt', { status: 'renamed', previousPath: 'lib/a.txt' })
const BIG = file('logs/big.log', { status: 'added', untracked: true, oversized: true })
const NOTES = file('docs/notes.txt', { additions: 1, deletions: 1, hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-old', '+new'] }] })

const LOCAL: ForgeLocalDiff = { base: BASE, files: [APP, ADDED, LOGO, GONE, MOVED, BIG], omitted: 2 }
const CHANGE: ForgeChangeRequestDiff = {
  headSha: HEAD,
  files: [APP, NOTES, GONE],
  localAhead: 1,
  fileUrls: { 'src/app.ts': `https://github.com/octo/demo/blob/${HEAD}/src/app.ts`, 'docs/gone.txt': `https://github.com/octo/demo/blob/${HEAD}/docs/gone.txt` },
}

/** Panel state of `/work/repo` on `main` whose `branch` scope changes `src/app.ts` against `origin/main`. */
const LOCAL_STATE = ready({ local: { base: BASE, files: [{ path: 'src/app.ts', additions: 2, deletions: 2, binary: false }] } })
/** Panel state with change request #7 from `feat`. */
const CHANGE_STATE = ready({ changeRequests: [entry(7, snapshot(7))] })

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

/** Refused Remote reads, by what the Host said. */
const REFUSED = {
  noForkPoint: { ok: false, error: new RemoteError('forgePanel/no-fork-point', 'no fork point', {}) },
  notCheckout: { ok: false, error: new RemoteError('forgePanel/not-a-checkout', 'not a checkout', {}) },
  tooLarge: { ok: false, error: new RemoteError('forgePanel/diff-too-large', 'too large', {}) },
  gone: { ok: false, error: new RemoteError('forgePanel/diff-failed', 'gone', {}) },
  hostRefused: { ok: false, error: new RemoteError('forgePanel/diff-failed', 'diff too large', {}) },
  failed: { ok: false, error: new RemoteError('gateway/bad-request', 'failed', {}) },
} satisfies Record<string, RemoteResult<never>>

/**
 * Carry changes tab parameters in a navigation record. In the aggregate client
 * program, the navigation parameter union lacks the resource parameters that
 * packages declare through the Sidebar's entry point, so the parameters are asserted.
 */
function navigationParams(params: ChangesParams | undefined): SidebarRightTabInfo['tab']['navigation']['params'] {
  return params as SidebarRightTabInfo['tab']['navigation']['params']
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let settle: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => { settle = resolve })
  return { promise, settle }
}

/** Test-local selector hook over a framework-neutral store instance. */
function hookOf<T>(instance: { subscribe: (listener: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(select: (state: T) => S): S {
    return select(useSyncExternalStore(instance.subscribe, instance.getSnapshot))
  }
}

/** Let the Remote reads the view awaits settle. */
async function settle(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

type Faces = { -readonly [K in Exclude<keyof ChangesTabInjected, 'keyedHooks'>]: ReturnType<typeof vi.fn<ChangesTabInjected[K]>> }

interface MountOptions {
  readonly source?: ChangesSource
  readonly state?: ForgePanelState | null
  readonly disconnected?: boolean
  readonly params?: ChangesParams
  readonly contentId?: string
  /** Configure the reads and actions before the first render. */
  readonly setup?: (faces: Faces) => void
}

function mount(options: MountOptions = {}) {
  const source = options.source ?? { kind: 'local' }
  const contentId = options.contentId ?? changesAddress({ sessionId: SESSION, source })
  const panel = createSnapshotStore<PanelSnapshot>({
    state: options.state === undefined ? (source.kind === 'local' ? LOCAL_STATE : CHANGE_STATE) : options.state,
    disconnected: options.disconnected ?? false,
  })
  const navigation = createSnapshotStore<SidebarRightTabInfo['tab']['navigation']>({
    address: contentId, params: navigationParams(options.params), revision: 1,
  })
  const visibility = createSnapshotStore(true)
  const useVisible = bindSnapshotSelector(visibility)
  const stops: ReturnType<typeof vi.fn>[] = []
  const active = bindSnapshotSelector<PanelSnapshot | undefined>({
    getSnapshot: () => panel.getSnapshot(),
    subscribe: (listener) => {
      const stop = vi.fn(panel.subscribe(listener))
      stops.push(stop)
      return stop
    },
  })
  const inactive = bindSnapshotSelector<PanelSnapshot | undefined>({
    getSnapshot: () => undefined,
    subscribe: () => () => {},
  })
  function usePanel(key: string): PanelSnapshot | undefined
  function usePanel<S>(key: string, select: (value: PanelSnapshot | undefined) => S, equal?: (left: S, right: S) => boolean): S
  function usePanel<S>(key: string, select?: (value: PanelSnapshot | undefined) => S,
    equal?: (left: S, right: S) => boolean): S | PanelSnapshot | undefined {
    const useValue = key === 'visible' ? active : inactive
    return select === undefined ? useValue(value => value) : useValue(select, equal)
  }
  const useNavigation = bindSnapshotSelector(navigation)
  const store = createChangesStore().create()
  const aborter = new AbortController()
  const unbind = vi.fn()
  const tabActions = {
    bindCommands: vi.fn<SidebarRightTabActions['bindCommands']>(() => unbind),
    openResource: vi.fn<SidebarRightTabActions['openResource']>(),
    openTab: vi.fn<SidebarRightTabActions['openTab']>(),
    close: vi.fn<SidebarRightTabActions['close']>(),
  }
  const faces: Faces = {
    reconnect: vi.fn<ChangesTabInjected['reconnect']>(),
    localDiff: vi.fn<ChangesTabInjected['localDiff']>(async () => ok(LOCAL)),
    localText: vi.fn<ChangesTabInjected['localText']>(async () => ok(APP_TEXT)),
    changeRequestDiff: vi.fn<ChangesTabInjected['changeRequestDiff']>(async () => ok(CHANGE)),
    changeRequestText: vi.fn<ChangesTabInjected['changeRequestText']>(async () => ok(APP_TEXT)),
    openLink: vi.fn<ChangesTabInjected['openLink']>(),
    copyPath: vi.fn<ChangesTabInjected['copyPath']>(),
    createChangeRequest: vi.fn<ChangesTabInjected['createChangeRequest']>(),
    report: vi.fn<ChangesTabInjected['report']>(),
  }
  options.setup?.(faces)
  const props: ChangesTabProps = {
    useTabInfo: () => ({
      sidebar: { expanded: true, fullscreen: false },
      panel: { id: 'pane-1' as PaneId },
      tab: {
        id: TAB, kind: CHANGES_KIND, contentId, title: 'Changes', visible: useVisible(value => value),
        navigation: useNavigation(value => value), signal: aborter.signal, actions: tabActions,
      },
    }),
    sessionId: SESSION,
    useStore: hookOf(store),
    actions: store.actions,
    usePanel,
    ...faces,
    t,
  }
  const view = render(<ChangesTab {...props} />)
  /** The section of one file. */
  const section = (path: string): HTMLElement => {
    const element = view.container.querySelector(`[data-forge-diff-file="${path}"]`)
    if (!(element instanceof HTMLElement)) throw new Error(`no section for ${path}`)
    return element
  }
  const paths = (): (string | null)[] => [...view.container.querySelectorAll('[data-forge-diff-file]')].map(element => element.getAttribute('data-forge-diff-file'))
  return { view, panel, visibility, stops, navigation, store, aborter, tabActions, unbind, faces, section, paths }
}

/** Visible texts of the rows a section draws, in order. */
function rowTexts(section: HTMLElement): string[] {
  return [...section.querySelectorAll(`.${css.text}`)].map(element => element.textContent ?? '')
}

describe('ChangesTab local reads', () => {
  it('waits for the panel state, then reads the branch scope and draws its files', async () => {
    const m = mount({ state: null })
    expect(m.view.container.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(m.view.queryByRole('button', { name: en['changes.local.create'] })).toBeNull()
    expect(m.faces.localDiff).not.toHaveBeenCalled()

    act(() => { m.panel.set({ state: LOCAL_STATE, disconnected: false }) })
    expect(m.faces.localDiff).toHaveBeenCalledWith({ kind: 'branch' }, expect.any(AbortSignal))
    await settle()

    expect(m.paths()).toEqual(['src/app.ts', 'src/new.ts', 'assets/logo.png', 'docs/gone.txt', 'lib/b.txt', 'logs/big.log'])
    expect(m.view.getByText('Compared with origin/main, including uncommitted changes')).toBeTruthy()
    expect(m.view.getByRole('status').textContent).toBe('2 more untracked files are not listed')
    expect(m.view.getByRole('button', { name: 'All 6 files' })).toBeTruthy()
    expect(m.view.container.querySelector(`.${css.totals}`)?.textContent).toBe('+4−3')
    const badge = (path: string): string | null => m.section(path).querySelector(`.${css.badge}`)?.textContent ?? null
    expect(badge('src/app.ts')).toBeNull()
    expect(badge('src/new.ts')).toBe('New file · Uncommitted')
    expect(badge('docs/gone.txt')).toBe('Deleted')
    expect(badge('lib/b.txt')).toBe('Renamed from a.txt')
    expect(badge('logs/big.log')).toBe('New file · Uncommitted')
    expect(hoverPath(m.section('src/app.ts'))).toBe('src/app.ts')
    expect(hoverPath(m.section('lib/b.txt'))).toBe('lib/a.txt → lib/b.txt')
    expect(within(m.section('assets/logo.png')).getByText(en['diff.binary'])).toBeTruthy()
    expect(m.section('assets/logo.png').querySelector(`.${css.counts}`)).toBeNull()
    expect(within(m.section('logs/big.log')).getByText(en['diff.fileTooLarge'])).toBeTruthy()
    expect(m.section('lib/b.txt').querySelector(`.${css.code}`)).toBeNull()
  })

  it('names the old path of a file that only moved to another directory', async () => {
    const moved = file('src/b.txt', { status: 'renamed', previousPath: 'lib/b.txt' })
    const m = mount({ setup: (faces) => { faces.localDiff.mockResolvedValue(ok({ base: BASE, files: [moved], omitted: 0 })) } })
    await settle()
    expect(m.section('src/b.txt').querySelector(`.${css.badge}`)?.textContent).toBe('Renamed from lib/b.txt')
    expect(hoverPath(m.section('src/b.txt'))).toBe('lib/b.txt → src/b.txt')
  })

  it('reads another scope from the scope menu and marks untracked files only in the branch scope', async () => {
    const m = mount()
    await settle()
    fireEvent.click(m.view.getByRole('button', { name: 'Branch' }))
    expect(m.view.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Uncommitted', 'Unstaged', 'Staged', 'Branch'])
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(m.view.queryAllByRole('menuitem')).toEqual([])

    fireEvent.click(m.view.getByRole('button', { name: 'Branch' }))
    fireEvent.click(m.view.getByRole('menuitem', { name: 'Staged' }))
    expect(m.store.getSnapshot().byTab[TAB]?.scope).toBe('staged')
    expect(m.view.container.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(m.view.getByText('The index compared with HEAD')).toBeTruthy()
    expect(m.faces.localDiff).toHaveBeenLastCalledWith({ kind: 'staged' }, expect.any(AbortSignal))
    await settle()
    expect(m.section('src/new.ts').querySelector(`.${css.badge}`)?.textContent).toBe('New file')

    fireEvent.click(m.view.getByRole('button', { name: 'Staged' }))
    fireEvent.click(m.view.getByRole('menuitem', { name: 'Unstaged' }))
    expect(m.view.getByText('Compared with the index, including untracked files')).toBeTruthy()
    fireEvent.click(m.view.getByRole('button', { name: 'Unstaged' }))
    fireEvent.click(m.view.getByRole('menuitem', { name: 'Uncommitted' }))
    expect(m.view.getByText('Compared with HEAD, including untracked files')).toBeTruthy()
    await settle()
    expect(m.faces.localDiff.mock.calls.map(([scope]) => scope.kind)).toEqual(['branch', 'staged', 'unstaged', 'uncommitted'])
  })

  it('names no base while the panel has no fork point', async () => {
    const m = mount({ state: ready() })
    await settle()
    expect(m.view.container.querySelector(`.${css.headerNote}`)?.textContent).toBe('')
  })

  it.each([
    ['no fork point', REFUSED.noForkPoint, en['diff.noForkPoint']],
    ['a directory outside a checkout', REFUSED.notCheckout, en['checkout.none']],
    ['changes over the size limit', REFUSED.tooLarge, en['diff.tooLarge']],
  ])('explains %s without a retry', async (_label, result, message) => {
    const m = mount({ setup: (faces) => { faces.localDiff.mockResolvedValue(result) } })
    await settle()
    expect(m.view.getByRole('status').textContent).toBe(message)
    expect(m.view.queryByRole('button', { name: en.retry })).toBeNull()
    expect(m.view.getByRole('button', { name: 'All 0 files' }).hasAttribute('disabled')).toBe(true)
  })

  it('offers a retry after any other failure', async () => {
    const m = mount({ setup: (faces) => { faces.localDiff.mockResolvedValueOnce(REFUSED.failed) } })
    await settle()
    expect(m.view.getByRole('status').textContent).toBe(`${en['diff.error']}${en.retry}`)
    fireEvent.click(m.view.getByRole('button', { name: en.retry }))
    await settle()
    expect(m.paths()).toHaveLength(6)
    expect(m.view.queryByText(en['diff.error'])).toBeNull()
  })

  it('names a later failure that has its own message beside the changes, without a retry', async () => {
    const m = mount()
    await settle()
    m.faces.localDiff.mockResolvedValueOnce(REFUSED.tooLarge)
    fireEvent.click(m.view.getByRole('button', { name: en['diff.refresh'] }))
    await settle()
    expect(m.paths()).toHaveLength(6)
    expect(m.view.getAllByRole('status')[0]?.textContent).toBe(en['diff.tooLarge'])
    expect(m.view.queryByRole('button', { name: en.retry })).toBeNull()
  })

  it('keeps the changes on screen when a later read fails and offers a retry beside them', async () => {
    const m = mount()
    await settle()
    m.faces.localDiff.mockResolvedValueOnce(REFUSED.failed)
    fireEvent.click(m.view.getByRole('button', { name: en['diff.refresh'] }))
    await settle()
    expect(m.paths()).toHaveLength(6)
    const notice = m.view.getAllByRole('status')[0]
    if (notice === undefined) throw new Error('no notice')
    expect(notice.textContent).toBe(`${en['diff.error']}${en.retry}`)
    fireEvent.click(within(notice).getByRole('button', { name: en.retry }))
    await settle()
    expect(m.view.queryByText(en['diff.error'])).toBeNull()
    expect(m.faces.localDiff).toHaveBeenCalledTimes(3)
  })

  it('reads again on refresh, on the page refresh command, and when the branch summary moves', async () => {
    const m = mount()
    await settle()
    expect(m.faces.localDiff).toHaveBeenCalledTimes(1)
    fireEvent.click(m.view.getByRole('button', { name: en['diff.refresh'] }))
    await settle()
    expect(m.faces.localDiff).toHaveBeenCalledTimes(2)
    const commands = m.tabActions.bindCommands.mock.calls[0]?.[0]
    act(() => { commands?.refresh?.() })
    await settle()
    expect(m.faces.localDiff).toHaveBeenCalledTimes(3)

    act(() => { m.panel.set({ state: { ...LOCAL_STATE, readiness: null }, disconnected: false }) })
    await settle()
    expect(m.faces.localDiff).toHaveBeenCalledTimes(3)
    act(() => { m.panel.set({ state: { ...LOCAL_STATE, local: { base: BASE, files: [] } }, disconnected: false }) })
    await settle()
    expect(m.faces.localDiff).toHaveBeenCalledTimes(4)

    m.view.unmount()
    expect(m.unbind).toHaveBeenCalledOnce()
  })

  it('releases its hidden panel subscription and coalesces inactive changes into one read on return', async () => {
    const m = mount()
    await settle()
    const section = m.section('src/app.ts')
    act(() => { m.visibility.set(false) })
    expect(m.stops[0]).toHaveBeenCalledOnce()
    act(() => { m.panel.set({ state: ready({ local: { base: BASE, files: [] } }), disconnected: false }) })
    act(() => { m.panel.set({ state: ready({ local: { base: BASE, files: [{ path: 'latest.ts', additions: 1, deletions: 0, binary: false }] } }), disconnected: false }) })
    await settle()
    expect(m.faces.localDiff).toHaveBeenCalledTimes(1)
    expect(m.section('src/app.ts')).toBe(section)
    act(() => { m.visibility.set(true) })
    await settle()
    expect(m.faces.localDiff).toHaveBeenCalledTimes(2)
  })

  it('retains expanded context and the file node when an unchanged tab becomes visible again', async () => {
    const m = mount()
    await settle()
    const section = m.section('src/app.ts')
    fireEvent.click(within(section).getByRole('button', { name: '2 unchanged lines' }))
    await settle()
    const before = rowTexts(section)
    act(() => { m.visibility.set(false) })
    await settle()
    act(() => { m.visibility.set(true) })
    await settle()
    expect(m.faces.localDiff).toHaveBeenCalledTimes(1)
    expect(m.section('src/app.ts')).toBe(section)
    expect(rowTexts(section)).toEqual(before)
  })

  it('aborts an in-flight diff when the tab becomes hidden and retries it on return', async () => {
    const pending = deferred<RemoteResult<ForgeLocalDiff>>()
    const m = mount({ setup: (faces) => { faces.localDiff.mockReturnValueOnce(pending.promise) } })
    const signal = m.faces.localDiff.mock.calls[0]![1]
    act(() => { m.visibility.set(false) })
    expect(signal.aborted).toBe(true)
    pending.settle(ok(LOCAL))
    await settle()
    expect(m.paths()).toEqual([])
    act(() => { m.visibility.set(true) })
    await settle()
    expect(m.faces.localDiff).toHaveBeenCalledTimes(2)
    expect(m.paths()).toContain('src/app.ts')
  })

  it('turns the refresh glyph while shown changes are read again, leaving the first read to the centered loader', async () => {
    const first = deferred<RemoteResult<ForgeLocalDiff>>()
    const again = deferred<RemoteResult<ForgeLocalDiff>>()
    const m = mount({ setup: (faces) => { faces.localDiff.mockReturnValueOnce(first.promise).mockReturnValueOnce(again.promise) } })
    const turning = (): boolean => m.view.getByRole('button', { name: en['diff.refresh'] }).firstElementChild?.hasAttribute('data-turning') === true
    expect(turning()).toBe(false)
    first.settle(ok(LOCAL))
    await settle()

    fireEvent.click(m.view.getByRole('button', { name: en['diff.refresh'] }))
    expect(turning()).toBe(true)
    expect(m.paths()).toHaveLength(6)
    again.settle(ok(LOCAL))
    await settle()
    expect(turning()).toBe(false)
  })

  it('ignores a read that a newer read replaced', async () => {
    const first = deferred<RemoteResult<ForgeLocalDiff>>()
    const m = mount({
      setup: (faces) => {
        faces.localDiff.mockReturnValueOnce(first.promise).mockResolvedValueOnce(ok({ base: BASE, files: [], omitted: 0 }))
      },
    })
    fireEvent.click(m.view.getByRole('button', { name: en['diff.refresh'] }))
    await settle()
    expect(m.view.getByText(en['diff.empty'])).toBeTruthy()
    first.settle(ok(LOCAL))
    await settle()
    expect(m.view.getByText(en['diff.empty'])).toBeTruthy()
    expect(m.view.container.querySelector(`.${css.totals}`)).toBeNull()
  })

  it('centers a reconnect notice when the panel stream ended before its first state', () => {
    const m = mount({ state: null, disconnected: true })
    fireEvent.click(m.view.getByRole('button', { name: en.retry }))
    expect(m.view.getByText(en['stream.failed'])).toBeTruthy()
    expect(m.faces.reconnect).toHaveBeenCalledOnce()
  })

  it('forgets the choices of a tab that ended and rejects an address it did not mint', () => {
    const m = mount()
    expect(m.store.getSnapshot().byTab[TAB]).toBeDefined()
    m.aborter.abort()
    expect(m.store.getSnapshot().byTab[TAB]).toBeUndefined()
    m.view.unmount()

    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => mount({ contentId: 'dsh-resource://forge-changes/s1/remote' })).toThrow('not a changes address')
  })
})

describe('ChangesTab layout', () => {
  it('draws lines side by side, then in one column, and wraps them by choice', async () => {
    const m = mount()
    await settle()
    const app = m.section('src/app.ts')
    const code = app.querySelector(`.${css.code}`)
    expect(code?.hasAttribute('data-split')).toBe(true)
    expect(code?.hasAttribute('data-wrap')).toBe(true)
    expect([...app.querySelectorAll('[data-diff-pair]')].map(pair => pair.getAttribute('data-diff-pair'))).toEqual([
      'context', 'change', 'change', 'context', 'context', 'change',
    ])
    expect(app.querySelectorAll('[data-diff-code]').length).toBeGreaterThan(0)
    expect(m.section('docs/gone.txt').querySelector('[data-diff-code]')).toBeNull()
    expect(rowTexts(m.section('docs/gone.txt'))).toEqual(['bye'])
    expect(rowTexts(m.section('src/new.ts'))).toEqual(['export const added = 1', ''])

    const split = m.view.getByRole('button', { name: en['diff.splitAria'] })
    expect(split.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(split)
    expect(split.getAttribute('aria-pressed')).toBe('false')
    expect(code?.hasAttribute('data-split')).toBe(false)
    const lines = [...app.querySelectorAll('[data-diff-line]')]
    expect(lines.map(line => line.getAttribute('data-diff-line'))).toEqual(['context', 'del', 'add', 'add', 'context', 'context', 'del'])
    expect(lines[1]?.textContent).toBe('4-const x = 4')
    expect(lines[2]?.textContent).toBe('4+const y = 4')
    expect(lines[4]?.textContent).toBe('56const a5 = 6')
    expect(rowTexts(m.section('docs/gone.txt'))).toEqual(['bye'])

    const wrap = m.view.getByRole('button', { name: en['diff.wrapAria'] })
    fireEvent.click(wrap)
    expect(wrap.getAttribute('aria-pressed')).toBe('false')
    expect(code?.hasAttribute('data-wrap')).toBe(false)
    expect(m.store.getSnapshot().byTab[TAB]).toMatchObject({ split: false, wrap: false })
  })

  it('collapses and expands a file, and starts large files behind a notice and files past the line budget collapsed', async () => {
    const huge = (index: number): ForgeDiffFile => file(`data/huge-${index}.txt`, {
      additions: 1001,
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1001, lines: Array.from({ length: 1001 }, (_, line) => `+${line}`) }],
    })
    const files = [APP, ...[1, 2, 3, 4, 5, 6].map(huge)]
    const m = mount({ setup: (faces) => { faces.localDiff.mockResolvedValue(ok({ base: BASE, files, omitted: 0 })) } })
    await settle()
    expect(m.paths().map(path => path === null ? null : m.section(path).hasAttribute('data-expanded'))).toEqual([true, true, true, true, true, true, false])

    const toggle = within(m.section('src/app.ts')).getByRole('button', { name: 'Collapse app.ts' })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(m.section('src/app.ts').querySelector(`.${css.code}`)).toBeNull()
    fireEvent.click(within(m.section('src/app.ts')).getByRole('button', { name: 'Expand app.ts' }))
    expect(m.section('src/app.ts').querySelector(`.${css.code}`)).not.toBeNull()

    const first = m.section('data/huge-1.txt')
    fireEvent.click(within(first).getByRole('button', { name: 'Large file: 1,001 changed lines collapsed' }))
    // A file with additions only keeps one column in the side-by-side layout.
    expect(first.querySelectorAll('[data-diff-line="add"]')).toHaveLength(1001)
    expect(first.querySelector('[data-diff-pair]')).toBeNull()
    fireEvent.click(within(m.section('data/huge-6.txt')).getByRole('button', { name: 'Expand huge-6.txt' }))
    expect(within(m.section('data/huge-6.txt')).getByRole('button', { name: 'Large file: 1,001 changed lines collapsed' })).toBeTruthy()
  })

  it('collapses every file from the toolbar while any is expanded, and expands every file once all are collapsed', async () => {
    const m = mount()
    await settle()
    const states = (): (boolean | null)[] => m.paths().map(path => path === null ? null : m.section(path).hasAttribute('data-expanded'))
    const collapse = (): HTMLElement => m.view.getByRole('button', { name: en['diff.collapseAll'] })
    expect(collapse().hasAttribute('data-expanded')).toBe(true)
    fireEvent.click(collapse())
    expect(states()).toEqual([false, false, false, false, false, false])
    // One expanded file is enough for the toolbar to collapse again.
    fireEvent.click(within(m.section('src/app.ts')).getByRole('button', { name: 'Expand app.ts' }))
    fireEvent.click(collapse())
    expect(states()).toEqual([false, false, false, false, false, false])
    const expand = m.view.getByRole('button', { name: en['diff.expandAll'] })
    expect(expand.hasAttribute('data-expanded')).toBe(false)
    fireEvent.click(expand)
    expect(states()).toEqual([true, true, true, true, true, true])
  })

  it('jumps to a file from the files menu, expanding it', async () => {
    const m = mount()
    await settle()
    fireEvent.click(within(m.section('docs/gone.txt')).getByRole('button', { name: 'Collapse gone.txt' }))
    fireEvent.click(m.view.getByRole('button', { name: 'All 6 files' }))
    // Each row shows the name before its directory; assistive technology reads the complete path.
    expect(m.view.getAllByRole('menuitem')).toEqual([
      'src/app.ts+2−2', 'src/new.ts+2−0', `assets/logo.png${en['diff.binaryLabel']}`, 'docs/gone.txt+0−1', 'lib/b.txt+0−0', 'logs/big.log+0−0',
    ].map(name => m.view.getByRole('menuitem', { name })))
    expect(m.view.getAllByRole('menuitem')[0]?.querySelector('[aria-hidden="true"]')?.textContent).toBe('app.tssrc')
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    fireEvent.click(m.view.getByRole('button', { name: 'All 6 files' }))
    fireEvent.click(m.view.getByRole('menuitem', { name: 'docs/gone.txt+0−1' }))
    expect(m.view.queryAllByRole('menuitem')).toEqual([])
    expect(m.section('docs/gone.txt').hasAttribute('data-expanded')).toBe(true)
    expect(scrolled).toHaveBeenCalledOnce()
    expect(scrolled.mock.contexts[0]).toBe(m.section('docs/gone.txt'))
    expect(scrolled).toHaveBeenCalledWith({ block: 'start' })
  })

  it('scrolls once to the file each navigation names when its changes arrive', async () => {
    const m = mount({ params: { path: 'docs/gone.txt' } })
    expect(scrolled).not.toHaveBeenCalled()
    await settle()
    expect(scrolled).toHaveBeenCalledOnce()
    expect(scrolled.mock.contexts[0]).toBe(m.section('docs/gone.txt'))
    act(() => { m.panel.set({ state: { ...LOCAL_STATE }, disconnected: false }) })
    expect(scrolled).toHaveBeenCalledOnce()

    act(() => { m.navigation.set({ address: m.navigation.getSnapshot().address, params: navigationParams({ path: 'missing.txt' }), revision: 2 }) })
    await settle()
    expect(m.faces.localDiff).toHaveBeenCalledTimes(2)
    act(() => { m.navigation.set({ address: m.navigation.getSnapshot().address, params: navigationParams({}), revision: 3 }) })
    await settle()
    expect(scrolled).toHaveBeenCalledOnce()
    expect(m.store.getSnapshot().byTab[TAB]?.navigated).toBe(3)
  })

  it('says when a scope has no changes', async () => {
    const m = mount({ setup: (faces) => { faces.localDiff.mockResolvedValue(ok({ base: null, files: [], omitted: 0 })) } })
    await settle()
    expect(m.view.getByText(en['diff.empty'])).toBeTruthy()
    expect(m.view.getByRole('button', { name: 'All 0 files' }).hasAttribute('disabled')).toBe(true)
    expect(m.view.getByRole('button', { name: en['diff.expandAll'] }).hasAttribute('disabled')).toBe(true)
    expect(m.view.queryByRole('status')).toBeNull()
  })
})

describe('ChangesTab unchanged lines', () => {
  it('expands collapsed lines from the new side of the scope, reading each file once', async () => {
    const m = mount()
    await settle()
    const app = m.section('src/app.ts')
    const gaps = (): string[] => [...app.querySelectorAll('[data-forge-diff-gap]')].map(gap => gap.textContent ?? '')
    expect(gaps()).toEqual(['2 unchanged lines', '4 unchanged lines', en['diff.unchangedRest']])

    fireEvent.click(within(app).getByRole('button', { name: '2 unchanged lines' }))
    expect(m.faces.localText).toHaveBeenCalledWith({ kind: 'branch' }, 'src/app.ts')
    expect([...app.querySelectorAll('[data-forge-diff-gap]')].every(gap => gap.hasAttribute('disabled'))).toBe(true)
    await settle()
    expect(gaps()).toEqual(['4 unchanged lines', '2 unchanged lines'])
    expect(rowTexts(app).slice(0, 4)).toEqual(['const a1 = 1', 'const a1 = 1', 'const a2 = 2', 'const a2 = 2'])

    fireEvent.click(within(app).getByRole('button', { name: '4 unchanged lines' }))
    fireEvent.click(within(app).getByRole('button', { name: '2 unchanged lines' }))
    await settle()
    expect(gaps()).toEqual([])
    expect(m.faces.localText).toHaveBeenCalledOnce()
    expect(rowTexts(app).slice(-2)).toEqual(['const t13 = 13', 'const t13 = 13'])
  })

  it('reports a read that failed or no longer matches and keeps the lines collapsed', async () => {
    const m = mount({
      setup: (faces) => {
        faces.localText.mockResolvedValueOnce(REFUSED.gone).mockResolvedValueOnce(ok('changed\n'))
      },
    })
    await settle()
    const app = m.section('src/app.ts')
    fireEvent.click(within(app).getByRole('button', { name: '2 unchanged lines' }))
    await settle()
    expect(m.faces.report).toHaveBeenLastCalledWith('toast.expandFailed', { message: 'gone' })
    const gap = within(app).getByRole('button', { name: '2 unchanged lines' })
    expect(gap.hasAttribute('disabled')).toBe(false)

    fireEvent.click(gap)
    await settle()
    expect(m.faces.report).toHaveBeenLastCalledWith('toast.expandStale')
    expect(within(app).getByRole('button', { name: '2 unchanged lines' })).toBeTruthy()
    expect(m.faces.localText).toHaveBeenCalledTimes(2)
  })

  it('drops lines read for changes that a newer read replaced', async () => {
    const text = deferred<RemoteResult<string>>()
    const m = mount({ setup: (faces) => { faces.localText.mockReturnValueOnce(text.promise) } })
    await settle()
    fireEvent.click(within(m.section('src/app.ts')).getByRole('button', { name: '2 unchanged lines' }))
    fireEvent.click(m.view.getByRole('button', { name: en['diff.refresh'] }))
    await settle()
    text.settle(ok(APP_TEXT))
    await settle()
    expect(within(m.section('src/app.ts')).getByRole('button', { name: '2 unchanged lines' }).hasAttribute('disabled')).toBe(false)
    expect(m.faces.report).not.toHaveBeenCalled()
  })
})

describe('ChangesTab actions', () => {
  /** Labels of a file's menu rows after opening it. */
  function menu(m: ReturnType<typeof mount>, path: string): string[] {
    const name = path.slice(path.lastIndexOf('/') + 1)
    fireEvent.click(within(m.section(path)).getByRole('button', { name: `More actions for ${name}` }))
    return m.view.getAllByRole('menuitem').map(item => item.textContent ?? '')
  }

  it.each(['local', 'change'] as const)('copies the full relative path from a %s diff header without folding the file', async (kind) => {
    const m = mount({ source: kind === 'local' ? { kind } : { kind, url: URL7 } })
    await settle()
    fireEvent.click(within(m.section('src/app.ts')).getByRole('button', { name: `${en['diff.copyPath']}: src/app.ts` }))
    expect(m.faces.copyPath).toHaveBeenCalledWith('src/app.ts')
    expect(m.section('src/app.ts').hasAttribute('data-expanded')).toBe(true)
    expect(m.tabActions.openResource).not.toHaveBeenCalled()
    fireEvent.click(within(m.section('docs/gone.txt')).getByRole('button', { name: 'Collapse gone.txt' }))
    fireEvent.click(within(m.section('docs/gone.txt')).getByRole('button', { name: `${en['diff.copyPath']}: docs/gone.txt` }))
    expect(m.faces.copyPath).toHaveBeenLastCalledWith('docs/gone.txt')
    expect(m.section('docs/gone.txt').hasAttribute('data-expanded')).toBe(false)
  })

  it('distinguishes copy targets with the same basename by their complete paths', async () => {
    const m = mount({ setup: (faces) => { faces.localDiff.mockResolvedValue(ok({
      ...LOCAL, files: [file('src/index.ts'), file('tests/index.ts')],
    })) } })
    await settle()
    fireEvent.click(m.view.getByRole('button', { name: 'Copy path: src/index.ts' }))
    expect(m.faces.copyPath).toHaveBeenLastCalledWith('src/index.ts')
    fireEvent.click(m.view.getByRole('button', { name: 'Copy path: tests/index.ts' }))
    expect(m.faces.copyPath).toHaveBeenLastCalledWith('tests/index.ts')
  })

  it.each(['scope', 'files', 'file'] as const)('closes the %s menu on deactivation without reopening it on return', async (kind) => {
    const m = mount()
    await settle()
    const section = m.section('src/app.ts')
    if (kind === 'file') menu(m, 'src/app.ts')
    else fireEvent.click(m.view.getByRole('button', { name: kind === 'scope' ? 'Branch' : 'All 6 files' }))
    expect(within(document.body).getByRole('menu')).toBeTruthy()
    act(() => { m.visibility.set(false) })
    expect(within(document.body).queryByRole('menu')).toBeNull()
    act(() => { m.visibility.set(true) })
    await settle()
    expect(within(document.body).queryByRole('menu')).toBeNull()
    expect(m.section('src/app.ts')).toBe(section)
  })

  it('copies paths and opens a local file in the sidebar', async () => {
    const m = mount()
    await settle()
    expect(menu(m, 'src/app.ts')).toEqual([en['diff.copyPath'], en['diff.openFileInSidebar']])
    fireEvent.click(m.view.getByRole('menuitem', { name: en['diff.openFileInSidebar'] }))
    expect(m.tabActions.openResource).toHaveBeenCalledWith(fileAddressFor(SESSION, undefined, '/work/repo/src/app.ts'))
    expect(m.view.queryAllByRole('menuitem')).toEqual([])

    expect(menu(m, 'docs/gone.txt')).toEqual([en['diff.copyPath']])
    fireEvent.click(m.view.getByRole('menuitem', { name: en['diff.copyPath'] }))
    expect(m.faces.copyPath).toHaveBeenCalledWith('docs/gone.txt')
  })

  it('offers no sidebar file before the checkout is known', async () => {
    const m = mount({ state: ready({ checkout: { state: 'pending' } }) })
    await settle()
    expect(menu(m, 'src/app.ts')).toEqual([en['diff.copyPath']])
  })

  it('asks the Agent for a change request only for a repository without an open one from the checked-out branch', async () => {
    const m = mount()
    fireEvent.click(m.view.getByRole('button', { name: en['changes.local.create'] }))
    expect(m.faces.createChangeRequest).toHaveBeenCalledOnce()
    act(() => { m.panel.set({ state: { ...LOCAL_STATE, repository: null }, disconnected: false }) })
    expect(m.view.queryByRole('button', { name: en['changes.local.create'] })).toBeNull()
    act(() => { m.panel.set({ state: { ...LOCAL_STATE, changeRequests: [entry(7, snapshot(7, { headBranch: 'main' }))] }, disconnected: false }) })
    expect(m.view.queryByRole('button', { name: en['changes.local.create'] })).toBeNull()
    await settle()
  })
})

describe('ChangesTab change requests', () => {
  const source: ChangesSource = { kind: 'change', url: URL7 }

  it('reads the change request at its head and heads the view with its state, title, and number', async () => {
    const m = mount({ source })
    expect(m.faces.changeRequestDiff).toHaveBeenCalledWith(URL7, expect.any(AbortSignal))
    expect(m.view.queryByRole('button', { name: 'Branch' })).toBeNull()
    expect(m.view.getByRole('img', { name: 'Change request state: Open' })).toBeTruthy()
    expect(m.view.getByText('Change 7')).toBeTruthy()
    expect(m.view.getByText('#7')).toBeTruthy()
    fireEvent.click(m.view.getByRole('button', { name: en['change.view'] }))
    expect(m.faces.openLink).toHaveBeenLastCalledWith(URL7)
    await settle()

    expect(m.paths()).toEqual(['src/app.ts', 'docs/notes.txt', 'docs/gone.txt'])
    expect(m.view.getByRole('status').textContent).toBe('The local branch has 1 unpushed commits; these are the changes on the change request')
    expect(m.section('src/app.ts').querySelector(`.${css.badge}`)).toBeNull()
    fireEvent.click(within(m.section('src/app.ts')).getByRole('button', { name: '2 unchanged lines' }))
    expect(m.faces.changeRequestText).toHaveBeenCalledWith(URL7, HEAD, 'src/app.ts')
    await settle()
    expect(rowTexts(m.section('src/app.ts'))[0]).toBe('const a1 = 1')
  })

  it('opens a file at the head in the browser when the host names its page', async () => {
    const m = mount({ source })
    await settle()
    const menu = (path: string): string[] => {
      const name = path.slice(path.lastIndexOf('/') + 1)
      fireEvent.click(within(m.section(path)).getByRole('button', { name: `More actions for ${name}` }))
      const labels = m.view.getAllByRole('menuitem').map(item => item.textContent ?? '')
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
      return labels
    }
    expect(menu('docs/notes.txt')).toEqual([en['diff.copyPath']])
    expect(menu('docs/gone.txt')).toEqual([en['diff.copyPath']])
    expect(menu('src/app.ts')).toEqual([en['diff.copyPath'], en['diff.openFileInBrowser']])
    fireEvent.click(within(m.section('src/app.ts')).getByRole('button', { name: 'More actions for app.ts' }))
    fireEvent.click(m.view.getByRole('menuitem', { name: en['diff.openFileInBrowser'] }))
    expect(m.faces.openLink).toHaveBeenLastCalledWith(CHANGE.fileUrls['src/app.ts'])
  })

  it('shows in place that the host did not provide the diff, offering its web page and a retry', async () => {
    const m = mount({ source, setup: (faces) => { faces.changeRequestDiff.mockResolvedValueOnce(REFUSED.hostRefused) } })
    await settle()
    expect(m.view.getByRole('status').textContent).toBe(`${en['diff.error']}${en.retry}${en['diff.viewInBrowser']}`)
    fireEvent.click(m.view.getByRole('button', { name: en['diff.viewInBrowser'] }))
    expect(m.faces.openLink).toHaveBeenLastCalledWith(URL7)
    fireEvent.click(m.view.getByRole('button', { name: en.retry }))
    await settle()
    expect(m.paths()).toEqual(['src/app.ts', 'docs/notes.txt', 'docs/gone.txt'])
  })

  it('says a diff over a size limit is too large to show and offers only its web page', async () => {
    const m = mount({ source, setup: (faces) => { faces.changeRequestDiff.mockResolvedValue(REFUSED.tooLarge) } })
    await settle()
    expect(m.view.getByRole('status').textContent).toBe(`${en['diff.tooLarge']}${en['diff.viewInBrowser']}`)
    expect(m.view.queryByRole('button', { name: en.retry })).toBeNull()
    fireEvent.click(m.view.getByRole('button', { name: en['diff.viewInBrowser'] }))
    expect(m.faces.openLink).toHaveBeenLastCalledWith(URL7)
  })

  it('reads again when the head moves', async () => {
    const m = mount({ source })
    await settle()
    act(() => { m.panel.set({ state: ready({ changeRequests: [entry(7, snapshot(7, { headSha: 'b'.repeat(40) }))] }), disconnected: false }) })
    await settle()
    expect(m.faces.changeRequestDiff).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['unpushed commits it cannot count', null],
    ['no unpushed commits', 0],
  ])('says nothing about %s', async (_label, localAhead) => {
    const m = mount({ source, setup: (faces) => { faces.changeRequestDiff.mockResolvedValue(ok({ ...CHANGE, localAhead })) } })
    await settle()
    expect(m.view.queryByRole('status')).toBeNull()
  })

  it('waits for the first status of a change request before reading it, unless its first poll failed', async () => {
    const m = mount({ source, state: ready({ changeRequests: [entry(7, null)] }) })
    await settle()
    expect(m.faces.changeRequestDiff).not.toHaveBeenCalled()
    expect(m.view.queryByRole('status')).toBeNull()
    act(() => { m.panel.set({ state: ready({ changeRequests: [entry(7, snapshot(7))] }), disconnected: false }) })
    await settle()
    expect(m.faces.changeRequestDiff).toHaveBeenCalledOnce()

    const failed = mount({
      source,
      state: ready({ changeRequests: [entry(7, { code: 'unavailable', message: 'down' })] }),
      setup: (faces) => { faces.changeRequestDiff.mockResolvedValue(REFUSED.gone) },
    })
    await settle()
    expect(failed.faces.changeRequestDiff).toHaveBeenCalledOnce()
    expect(within(failed.view.container).getByRole('status').textContent).toBe(`${en['diff.error']}${en.retry}${en['diff.viewInBrowser']}`)
  })

  it('names a change request without a snapshot by its URL and the number the URL ends in', async () => {
    const m = mount({ source, state: ready() })
    expect(m.view.getByRole('img', { name: 'Change request state: Unknown' })).toBeTruthy()
    expect(m.view.getByText(URL7)).toBeTruthy()
    expect(m.view.getByText('#7')).toBeTruthy()
    fireEvent.click(m.view.getByRole('button', { name: en['change.view'] }))
    expect(m.faces.openLink).toHaveBeenLastCalledWith(URL7)
    act(() => { m.panel.set({ state: ready({ changeRequests: [entry(7, null)] }), disconnected: false }) })
    expect(m.view.getByText(URL7)).toBeTruthy()
    await settle()

    const other = mount({ source: { kind: 'change', url: 'https://example.com/review' }, state: null })
    expect(within(other.view.container).queryByText(/^#/)).toBeNull()
    expect(other.faces.changeRequestDiff).not.toHaveBeenCalled()
  })
})
