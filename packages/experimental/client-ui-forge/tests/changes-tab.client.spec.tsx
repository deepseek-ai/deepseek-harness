// @vitest-environment jsdom
/** The changes tab: reading each source and scope, the toolbar, file sections, unchanged lines, notices, and failures. */
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './fonts-dom.client.ts'
import type { PaneId, SidebarRightTabActions, SidebarRightTabInfo, TabId } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import { CHANGES_KIND, changesAddress, type ChangesParams, type ChangesSource } from '../src/client/changes-address.ts'
import * as DiffFileModule from '../src/client/DiffFile.tsx'
import type { ReviewActions } from '../src/client/ReviewComposer.tsx'
import { ReviewQueue } from '../src/client/review-queue.ts'
import { ViewedFiles } from '../src/client/viewed-files.ts'
import { createChangesStore } from '../src/client/changes-store.ts'
import { ChangesTab, type ChangesTabInjected, type ChangesTabProps } from '../src/client/ChangesTab.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { PanelSnapshot } from '../src/client/source.ts'
import css from '../src/client/ChangesTab.module.css'
import baseCss from '../src/client/BaseMenu.module.css'
import type {
  ForgeBaseBranch, ForgeBaseBranches, ForgeChangeRequestDiff, ForgeDiffFile, ForgeLocalDiff, ForgePanelChangeRequest, ForgePanelState,
} from '../src/types.ts'
import type {
  ChangeRequestKey, ForgeCommitList, ForgeReviewData, ForgeReviewId, ForgeReviewThread, ForgeReviewWriteResult, ForgeThreadId,
} from '@deepseek-ai/dsh-experimental-forge/types'
import { entry, ready, snapshot } from './client-fixtures.client.ts'
import { reviewComment, reviewThread } from './thread-fixtures.client.ts'

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
  vi.restoreAllMocks()
  scrolled.mockReset()
  localStorage.clear()
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
    path, previousPath: null, status: 'modified', binary: false, oversized: false, untracked: false, layer: 'implementation', digest: 'digest', additions: 0, deletions: 0, hunks: [],
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

/** Three commits, oldest first. */
const COMMITS: ForgeCommitList = {
  headSha: HEAD,
  truncated: false,
  commits: ['1', '2', '3'].map((n, index) => ({
    sha: n.repeat(40), parent: index === 0 ? null : String(index).repeat(40), title: `commit ${n}`, author: 'octo', authoredAt: '2026-10-09T00:00:00Z',
  })),
}

const TOPIC: ForgeBaseBranch = { ref: 'refs/heads/topic', name: 'topic' }
/** Branches the `branch` scope can compare with: `origin/main` automatically, a release branch, and `topic`. */
const BASES: ForgeBaseBranches = {
  automatic: { name: BASE, worktree: false },
  remote: [{ ref: 'refs/remotes/origin/main', name: BASE }, { ref: 'refs/remotes/origin/release/2.4', name: 'origin/release/2.4' }],
  local: [TOPIC],
}

/** Panel state of `/work/repo` on `main` whose `branch` scope changes `src/app.ts` against `origin/main`. */
const LOCAL_STATE = ready({ local: { base: BASE, files: [{ path: 'src/app.ts', additions: 2, deletions: 2, binary: false }] } })
/** Panel state with change request #7 from `feat`. */
const CHANGE_STATE = ready({ changeRequests: [entry(7, snapshot(7))] })

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

/** Threads of #7 at its head, none of them yet, read for `lin`, who may review the change request `octo` opened. */
function reviewData(overrides: Partial<ForgeReviewData> = {}): ForgeReviewData {
  return { headSha: HEAD, viewer: 'lin', threads: [], truncated: false, pendingReview: null, viewerCanReview: true, ...overrides }
}

/** The pending review of `octo` on #7. */
const PENDING_REVIEW = { id: 'review-1' as ForgeReviewId, comments: 1 }

/** Store comment drafts the way an earlier panel kept them in the browser. */
function storeDrafts(...bodies: string[]): void {
  const drafts = bodies.map(body => ({ source: { kind: 'change', url: URL7, headSha: HEAD, commits: null },
    comment: { path: 'src/app.ts', side: 'R', startLine: 4, endLine: 4, body,
      hunk: '@@ -3,3 +3,4 @@\n const a3 = 3\n-const x = 4\n+const y = 4\n+const z = 5\n const a5 = 6' } }))
  localStorage.setItem('test-review', JSON.stringify({ comments: drafts, records: [], body: '', event: 'comment', uncertain: null }))
}

/** Refused Remote reads, by what the Host said. */
const REFUSED = {
  noForkPoint: { ok: false, error: new RemoteError('forgePanel/no-fork-point', 'no fork point', {}) },
  baseMissing: { ok: false, error: new RemoteError('forgePanel/base-missing', 'no base branch', {}) },
  notCheckout: { ok: false, error: new RemoteError('forgePanel/not-a-checkout', 'not a checkout', {}) },
  tooLarge: { ok: false, error: new RemoteError('forgePanel/diff-too-large', 'too large', {}) },
  filterConfig: { ok: false, error: new RemoteError('forgePanel/filter-config-failed', 'filter configuration unavailable', {}) },
  gone: { ok: false, error: new RemoteError('forgePanel/diff-failed', 'gone', {}) },
  staleHead: { ok: false, error: new RemoteError('forgePanel/stale-head', 'the head moved', {}) },
  hostRefused: { ok: false, error: new RemoteError('forgePanel/diff-failed', 'diff too large', {}) },
  failed: { ok: false, error: new RemoteError('gateway/bad-request', 'failed', {}) },
  reviewUnsupported: { ok: false, error: new RemoteError('forgePanel/review-unsupported', 'no review reads', {}) },
  reviewFailed: { ok: false, error: new RemoteError('forgePanel/review-failed', 'GitHub is down', {}) },
  notBound: { ok: false, error: new RemoteError('forgePanel/not-bound', 'not bound', {}) },
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

type Faces = { -readonly [K in Exclude<keyof ChangesTabInjected, 'keyedHooks' | 'viewedFiles'>]: ReturnType<typeof vi.fn<ChangesTabInjected[K]>> }

interface MountOptions {
  readonly translate?: typeof t
  readonly source?: ChangesSource
  readonly state?: ForgePanelState | null
  readonly disconnected?: boolean
  readonly params?: ChangesParams
  readonly contentId?: string
  /** Configure the reads and actions before the first render. */
  readonly setup?: (faces: Faces) => void
  /** Viewed marks; each mount otherwise reads the Session's marks from browser storage. */
  readonly viewedFiles?: ViewedFiles
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
    diffBases: vi.fn<ChangesTabInjected['diffBases']>(async () => ok(BASES)),
    localText: vi.fn<ChangesTabInjected['localText']>(async () => ok(APP_TEXT)),
    changeRequestDiff: vi.fn<ChangesTabInjected['changeRequestDiff']>(async () => ok(CHANGE)),
    changeRequestText: vi.fn<ChangesTabInjected['changeRequestText']>(async () => ok(APP_TEXT)),
    localCommits: vi.fn<ChangesTabInjected['localCommits']>(async () => ok(COMMITS)),
    changeRequestCommits: vi.fn<ChangesTabInjected['changeRequestCommits']>(async () => ok(COMMITS)),
    // Without a host that keeps viewed marks, the browser keeps them, as for local changes.
    changeRequestViewed: vi.fn<ChangesTabInjected['changeRequestViewed']>(async () => ok(null)),
    setFileViewed: vi.fn<ChangesTabInjected['setFileViewed']>(async () => ok(undefined)),
    openLink: vi.fn<ChangesTabInjected['openLink']>(),
    copyPath: vi.fn<ChangesTabInjected['copyPath']>(),
    reviewQueue: vi.fn<ChangesTabInjected['reviewQueue']>().mockReturnValue(new ReviewQueue('test-review')),
    submitReview: vi.fn<ChangesTabInjected['submitReview']>().mockResolvedValue({ ok: true, value: { ok: true, url: URL7 } }),
    addReviewToInput: vi.fn<ChangesTabInjected['addReviewToInput']>().mockReturnValue(true),
    addThreadToInput: vi.fn<ChangesTabInjected['addThreadToInput']>().mockReturnValue(true),
    changeRequestReview: vi.fn<ChangesTabInjected['changeRequestReview']>(async () => REFUSED.reviewUnsupported),
    changeRequestReviewWrite: vi.fn<ChangesTabInjected['changeRequestReviewWrite']>(async () => ok<ForgeReviewWriteResult>({ ok: true })),
    createChangeRequest: vi.fn<ChangesTabInjected['createChangeRequest']>(),
    report: vi.fn<ChangesTabInjected['report']>(),
  }
  options.setup?.(faces)
  const viewedFiles = options.viewedFiles ?? new ViewedFiles(SESSION)
  const props: ChangesTabProps = {
    useTabInfo: () => ({
      sidebar: { expanded: true, fullscreen: false },
      panel: { id: 'pane-1' as PaneId, isFloating: false },
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
    viewedFiles,
    t: options.translate ?? t,
  }
  const view = render(<ChangesTab {...props} />)
  /** The section of one file. */
  const section = (path: string): HTMLElement => {
    const element = view.container.querySelector(`[data-forge-diff-file="${path}"]`)
    if (!(element instanceof HTMLElement)) throw new Error(`no section for ${path}`)
    return element
  }
  const paths = (): (string | null)[] => [...view.container.querySelectorAll('[data-forge-diff-file]')].map(element => element.getAttribute('data-forge-diff-file'))
  return { view, panel, visibility, stops, navigation, store, aborter, tabActions, unbind, faces, viewedFiles, section, paths }
}

/** Visible texts of the rows a section draws, in order. */
function rowTexts(section: HTMLElement): string[] {
  return [...section.querySelectorAll(`.${css.text}`)].map(element => element.textContent ?? '')
}

/** Geometry of 200px sections `gap` pixels apart, with a short final page whose scroll position is clamped by the viewport. */
function fileViewport(m: ReturnType<typeof mount>, gap = 0) {
  const nodes = [...m.view.container.querySelectorAll<HTMLElement>('[data-forge-diff-file]')]
  const viewport = m.view.getByRole('region', { name: `All ${nodes.length} files` })
  const step = 200 + gap
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, 300))
  nodes.forEach((node, index) => {
    vi.spyOn(node, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, index * step - viewport.scrollTop, 600, 200))
  })
  scrolled.mockImplementation(function (this: HTMLElement) {
    viewport.scrollTop = Math.min(nodes.indexOf(this) * step, nodes.length * step - gap - 300)
  })
  return { viewport, nodes }
}

describe('ChangesTab keyboard file navigation', () => {
  it.each([{ kind: 'local' }, { kind: 'change', url: URL7 }] as const)('uses file-tree order for $kind diff sections and keyboard navigation', async (source) => {
    const files = [
      file('README.md'), file('packages/plugin/README.md'), file('packages/plugin/tests/index.spec.ts'),
      file('packages/plugin/src/index.ts'), file('packages/plugin/src/adapter.ts'), file('docs/guide.md'),
    ]
    const expected = [
      'docs/guide.md', 'packages/plugin/src/adapter.ts', 'packages/plugin/src/index.ts',
      'packages/plugin/tests/index.spec.ts', 'packages/plugin/README.md', 'README.md',
    ]
    const m = mount({ source, setup: (faces) => {
      faces.localDiff.mockResolvedValue(ok({ ...LOCAL, files }))
      faces.changeRequestDiff.mockResolvedValue(ok({ ...CHANGE, files }))
    } })
    await settle()
    const tree = within(m.view.getByRole('navigation'))
    const paths = tree.getAllByRole('button').filter(button => !button.hasAttribute('aria-expanded'))
      .map(button => button.getAttribute('aria-label'))
    expect(paths).toEqual(expected)
    expect(m.paths()).toEqual(paths)
    const { viewport } = fileViewport(m)
    for (const path of expected.slice(1)) {
      fireEvent.keyDown(viewport, { key: 'ArrowRight' })
      expect(scrolled.mock.contexts.at(-1)).toBe(m.section(path))
      expect(tree.getByRole('button', { name: path }).getAttribute('aria-current')).toBe('true')
    }
    fireEvent.change(tree.getByRole('textbox'), { target: { value: 'README' } })
    expect(m.paths()).toEqual(expected)
  })

  it.each([
    { source: { kind: 'local' }, label: 'lib/a.txt → lib/b.txt' },
    { source: { kind: 'change', url: URL7 }, label: 'src/app.ts' },
  ] as const)('moves between $source.kind files, expands the destination and keeps focus in the diff', async ({ source, label }) => {
    const m = mount({ source })
    await settle()
    const { viewport, nodes } = fileViewport(m)
    const destination = nodes[2]!
    fireEvent.click(within(destination).getByRole('button', { name: /^Collapse / }))
    viewport.scrollTop = 250
    fireEvent.scroll(viewport)
    expect(fireEvent.keyDown(viewport, { key: 'ArrowRight' })).toBe(false)
    expect(scrolled.mock.contexts.at(-1)).toBe(destination)
    expect(destination.hasAttribute('data-expanded')).toBe(true)
    expect(document.activeElement).toBe(viewport)
    const tree = within(m.view.getByRole('navigation'))
    expect(tree.getByRole('button', { current: true }).getAttribute('aria-label')).toBe(label)
    fireEvent.scroll(viewport)
    fireEvent.keyDown(viewport, { key: 'ArrowLeft' })
    expect(scrolled.mock.contexts.at(-1)).toBe(nodes[1])
    expect(m.faces.localDiff.mock.calls.length + m.faces.changeRequestDiff.mock.calls.length).toBe(1)
  })

  it('stops at the ends, remembers a clamped last file, and follows manual scrolling', async () => {
    const m = mount()
    await settle()
    const { viewport, nodes } = fileViewport(m)
    fireEvent.keyDown(viewport, { key: 'ArrowLeft' })
    expect(scrolled).not.toHaveBeenCalled()
    for (let index = 1; index < nodes.length; index += 1) {
      fireEvent.keyDown(viewport, { key: 'ArrowRight' })
      fireEvent.scroll(viewport)
      expect(scrolled.mock.contexts.at(-1)).toBe(nodes[index])
    }
    const count = scrolled.mock.calls.length
    fireEvent.keyDown(viewport, { key: 'ArrowRight' })
    expect(scrolled).toHaveBeenCalledTimes(count)
    fireEvent.keyDown(viewport, { key: 'ArrowLeft' })
    expect(scrolled.mock.contexts.at(-1)).toBe(nodes.at(-2))
    viewport.scrollTop = 225
    fireEvent.scroll(viewport)
    fireEvent.keyDown(viewport, { key: 'ArrowRight' })
    expect(scrolled.mock.contexts.at(-1)).toBe(nodes[2])
  })

  it('reads the card below a gap at the viewport top, and the last file once every card is above it', async () => {
    const m = mount()
    await settle()
    const { viewport, nodes } = fileViewport(m, 12)
    // The first card ends 5px above the viewport, and the second starts 7px below it.
    viewport.scrollTop = 205
    fireEvent.scroll(viewport)
    fireEvent.keyDown(viewport, { key: 'ArrowRight' })
    expect(scrolled.mock.contexts.at(-1)).toBe(nodes[2])
    viewport.scrollTop = nodes.length * 212
    fireEvent.scroll(viewport)
    fireEvent.keyDown(viewport, { key: 'ArrowLeft' })
    expect(scrolled.mock.contexts.at(-1)).toBe(nodes.at(-2))
  })

  it('leaves vertical arrows, modifiers, composition and handled keys to their owners', async () => {
    const m = mount()
    await settle()
    const { viewport } = fileViewport(m)
    for (const input of [
      { key: 'ArrowDown' }, { key: 'ArrowUp' }, { key: 'ArrowRight', shiftKey: true },
      { key: 'ArrowRight', ctrlKey: true }, { key: 'ArrowRight', metaKey: true },
      { key: 'ArrowRight', altKey: true }, { key: 'ArrowRight', isComposing: true },
    ]) expect(fireEvent.keyDown(viewport, input)).toBe(true)
    const handled = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
    handled.preventDefault()
    fireEvent(viewport, handled)
    act(() => { m.visibility.set(false) })
    fireEvent.keyDown(viewport, { key: 'ArrowRight' })
    expect(scrolled).not.toHaveBeenCalled()
  })

  it('preserves comment editing, native selections, tree controls and portalled menus', async () => {
    const m = mount()
    await settle()
    const { viewport } = fileViewport(m)
    const section = within(m.section('src/app.ts'))
    fireEvent.click(section.getByRole('button', { name: 'Select line R4' }))
    fireEvent.click(section.getByRole('button', { name: 'Add comment' }))
    const input = section.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Keep editing' } })
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    fireEvent.keyDown(section.getByRole('button', { name: 'Add to input' }), { key: 'ArrowLeft' })
    expect(input).toHaveProperty('value', 'Keep editing')
    expect(scrolled).not.toHaveBeenCalled()
    fireEvent.keyDown(m.view.getByRole('separator'), { key: 'ArrowRight' })
    fireEvent.keyDown(within(m.view.getByRole('navigation')).getByRole('textbox'), { key: 'ArrowLeft' })
    fireEvent.click(section.getByRole('button', { name: 'More actions for app.ts' }))
    const menuItem = m.view.getByRole('menuitem', { name: 'Copy path' })
    fireEvent.keyDown(menuItem, { key: 'ArrowRight' })
    fireEvent.keyDown(menuItem, { key: 'Escape' })
    fireEvent.keyDown(m.section('src/app.ts').querySelector('svg')!, { key: 'ArrowRight' })
    expect(scrolled).not.toHaveBeenCalled()
    const selection = window.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(m.section('src/new.ts').querySelector('[data-review-code][data-new-line="1"]')!)
    selection.removeAllRanges()
    selection.addRange(range)
    try {
      expect(selection.toString()).toBe('export const added = 1')
      fireEvent.keyDown(viewport, { key: 'ArrowRight' })
      expect(scrolled).not.toHaveBeenCalled()
    } finally {
      selection.removeAllRanges()
    }
  })
})

describe('ChangesTab local reads', () => {
  it('waits for the panel state, then reads the branch scope and draws its files', async () => {
    const m = mount({ state: null })
    expect(m.view.container.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(m.view.queryByRole('button', { name: en['changes.local.create'] })).toBeNull()
    expect(m.view.container.querySelector('[data-forge-head]')?.textContent).toBe('HEAD')
    expect(m.faces.localDiff).not.toHaveBeenCalled()

    act(() => { m.panel.set({ state: LOCAL_STATE, disconnected: false }) })
    expect(m.faces.localDiff).toHaveBeenCalledWith({ kind: 'branch', base: null, commits: null }, expect.any(AbortSignal))
    await settle()

    expect(m.paths()).toEqual(['assets/logo.png', 'docs/gone.txt', 'lib/b.txt', 'logs/big.log', 'src/app.ts', 'src/new.ts'])
    expect(m.view.container.querySelector('[data-forge-head]')?.textContent).toBe('main')
    expect(m.view.getByRole('button', { name: 'Base branch: origin/main' })).toBeTruthy()
    expect(m.view.getByText(en['diff.base.uncommitted'])).toBeTruthy()
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

  it('names a detached HEAD by its commit, and the automatic choice while the panel has no fork point', async () => {
    const m = mount({ state: ready({}, { branch: null, commit: 'abc1234' }) })
    await settle()
    expect(m.view.container.querySelector('[data-forge-head]')?.textContent).toBe('abc1234')
    expect(m.view.getByRole('button', { name: 'Base branch: Default' })).toBeTruthy()
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

  it.each([['en', en], ['zh', zh]] as const)('explains a filter configuration failure in %s and retries the comparison', async (_locale, dictionary) => {
    const m = mount({
      translate: makeTranslate(dictionary),
      setup: (faces) => { faces.localDiff.mockResolvedValueOnce(REFUSED.filterConfig) },
    })
    await settle()
    expect(m.view.getByRole('status').textContent).toBe(`${dictionary['diff.filterConfigFailed']}${dictionary.retry}`)
    expect(m.view.queryByText(dictionary['diff.tooLarge'])).toBeNull()
    fireEvent.click(m.view.getByRole('button', { name: dictionary.retry }))
    await settle()
    expect(m.paths()).toHaveLength(6)
    expect(m.view.queryByText(dictionary['diff.filterConfigFailed'])).toBeNull()
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

  it('reads changes and commits again on refresh, on the page refresh command, and when the branch summary moves', async () => {
    const m = mount()
    await settle()
    expect(m.faces.localDiff).toHaveBeenCalledTimes(1)
    expect(m.faces.localCommits).toHaveBeenCalledTimes(1)
    fireEvent.click(m.view.getByRole('button', { name: en['diff.refresh'] }))
    await settle()
    expect(m.faces.localDiff).toHaveBeenCalledTimes(2)
    expect(m.faces.localCommits).toHaveBeenCalledTimes(2)
    const commands = m.tabActions.bindCommands.mock.calls[0]?.[0]
    act(() => { commands?.refresh?.() })
    await settle()
    expect(m.faces.localDiff).toHaveBeenCalledTimes(3)
    expect(m.faces.localCommits).toHaveBeenCalledTimes(3)

    act(() => { m.panel.set({ state: { ...LOCAL_STATE, readiness: null }, disconnected: false }) })
    await settle()
    expect(m.faces.localDiff).toHaveBeenCalledTimes(3)
    expect(m.faces.localCommits).toHaveBeenCalledTimes(3)
    act(() => { m.panel.set({ state: { ...LOCAL_STATE, local: { base: BASE, files: [] } }, disconnected: false }) })
    await settle()
    expect(m.faces.localDiff).toHaveBeenCalledTimes(4)
    expect(m.faces.localCommits).toHaveBeenCalledTimes(4)
    // A commit of the staged changes moves HEAD without changing the summary against the fork point.
    act(() => { m.panel.set({ state: ready({ local: { base: BASE, files: [] } }, { commit: 'f'.repeat(40) }), disconnected: false }) })
    await settle()
    expect(m.faces.localDiff).toHaveBeenCalledTimes(4)
    expect(m.faces.localCommits).toHaveBeenCalledTimes(5)

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

describe('ChangesTab base branch', () => {
  const CLEAN: ForgeLocalDiff = { ...LOCAL, omitted: 0 }

  it('compares the branch scope with a chosen branch, and again with the automatic fork point', async () => {
    const m = mount()
    await settle()
    fireEvent.click(m.view.getByRole('button', { name: 'Base branch: origin/main' }))
    await settle()
    expect(m.faces.diffBases).toHaveBeenCalledWith('', expect.any(AbortSignal))
    fireEvent.click(m.view.getByRole('menuitem', { name: 'topic' }))
    expect(m.store.getSnapshot().byTab[TAB]?.base).toEqual(TOPIC)
    expect(m.faces.localDiff).toHaveBeenLastCalledWith({ kind: 'branch', base: TOPIC.ref, commits: null }, expect.any(AbortSignal))
    expect(m.view.container.querySelector('[data-state="ongoing"]')).not.toBeNull()
    await settle()
    expect(m.paths()).toHaveLength(6)

    fireEvent.click(m.view.getByRole('button', { name: 'Base branch: topic' }))
    await settle()
    fireEvent.click(m.view.getByRole('menuitem', { name: /^origin\/main/ }))
    expect(m.store.getSnapshot().byTab[TAB]?.base).toBeNull()
    expect(m.faces.localDiff).toHaveBeenLastCalledWith({ kind: 'branch', base: null, commits: null }, expect.any(AbortSignal))
  })

  it('records review comments under the compared ref and names the base the Host reports', async () => {
    // The memoized section draws through its inner component, which the spy observes.
    const renderDiff = DiffFileModule.DiffFile.type
    let source: ReviewActions['source'] | undefined
    vi.spyOn(DiffFileModule.DiffFile, 'type').mockImplementation((props) => {
      source = props.review?.source
      return renderDiff(props)
    })
    const m = mount({
      setup: (faces) => {
        faces.localDiff.mockImplementation(async scope => ok({ ...CLEAN, base: scope.kind !== 'branch' ? null : scope.base === null ? BASE : 'topic' }))
      },
    })
    await settle()
    expect(source).toEqual({ kind: 'local', scope: 'branch', base: BASE, baseRef: null, commits: null })

    act(() => { m.store.actions.based(TAB, TOPIC) })
    await settle()
    expect(source).toEqual({ kind: 'local', scope: 'branch', base: 'topic', baseRef: TOPIC.ref, commits: null })

    act(() => { m.store.actions.scoped(TAB, 'staged') })
    await settle()
    expect(source).toEqual({ kind: 'local', scope: 'staged', base: null, baseRef: null, commits: null })
  })

  it('keeps the chosen branch while another scope shows, and reads that scope without it', async () => {
    const m = mount()
    await settle()
    act(() => { m.store.actions.based(TAB, TOPIC) })
    act(() => { m.store.actions.scoped(TAB, 'staged') })
    await settle()
    expect(m.faces.localDiff).toHaveBeenLastCalledWith({ kind: 'staged' }, expect.any(AbortSignal))
    expect(m.view.queryByRole('button', { name: 'Base branch: topic' })).toBeNull()
    act(() => { m.store.actions.scoped(TAB, 'branch') })
    expect(m.view.getByRole('button', { name: 'Base branch: topic' })).toBeTruthy()
  })

  it.each([
    ['is gone', REFUSED.baseMissing, 'The base branch topic was not found; it may have been deleted', true],
    ['shares no history with HEAD', REFUSED.noForkPoint, 'topic shares no history with HEAD', false],
  ])('offers the automatic fork point instead of a retry when the chosen branch %s', async (_label, refused, message, missing) => {
    const m = mount({
      setup: (faces) => { faces.localDiff.mockImplementation(async scope => scope.kind === 'branch' && scope.base !== null ? refused : ok(CLEAN)) },
    })
    await settle()
    act(() => { m.store.actions.based(TAB, TOPIC) })
    await settle()
    expect(m.view.getByRole('status').textContent).toBe(`${message}${en['diff.useAutomaticBase']}`)
    expect(m.view.queryByRole('button', { name: en.retry })).toBeNull()
    expect(m.view.getByRole('button', { name: 'Base branch: topic' }).classList.contains(baseCss.missing ?? '')).toBe(missing)

    fireEvent.click(m.view.getByRole('button', { name: en['diff.useAutomaticBase'] }))
    expect(m.store.getSnapshot().byTab[TAB]?.base).toBeNull()
    await settle()
    expect(m.paths()).toHaveLength(6)
  })

  it('names a later failure of the chosen branch beside its changes, and keeps a retry for other failures', async () => {
    const m = mount({ setup: (faces) => { faces.localDiff.mockResolvedValue(ok(CLEAN)) } })
    await settle()
    act(() => { m.store.actions.based(TAB, TOPIC) })
    await settle()
    m.faces.localDiff.mockResolvedValueOnce(REFUSED.failed)
    fireEvent.click(m.view.getByRole('button', { name: en['diff.refresh'] }))
    await settle()
    expect(m.view.getByRole('status').textContent).toBe(`${en['diff.error']}${en.retry}`)

    m.faces.localDiff.mockResolvedValueOnce(REFUSED.baseMissing)
    fireEvent.click(m.view.getByRole('button', { name: en.retry }))
    await settle()
    expect(m.paths()).toHaveLength(6)
    const notice = m.view.getByRole('status')
    expect(notice.textContent).toBe(`The base branch topic was not found; it may have been deleted${en['diff.useAutomaticBase']}`)
    fireEvent.click(within(notice).getByRole('button', { name: en['diff.useAutomaticBase'] }))
    expect(m.store.getSnapshot().byTab[TAB]?.base).toBeNull()
  })
})

describe('ChangesTab drawing work', () => {
  it('draws the lines of an expanded file once its section comes within reach of the scrollport', async () => {
    const watched = new Map<Element, IntersectionObserverCallback>()
    let root: Element | Document | null | undefined
    vi.stubGlobal('IntersectionObserver', class {
      constructor(readonly report: IntersectionObserverCallback, options?: IntersectionObserverInit) { root = options?.root }
      observe(element: Element): void { watched.set(element, this.report) }
      unobserve(element: Element): void { watched.delete(element) }
      disconnect(): void { watched.clear() }
    })
    try {
      const m = mount()
      await settle()
      const app = m.section('src/app.ts')
      expect(root).toBe(m.view.container.querySelector('[data-forge-changes-scroll]'))
      expect(app.querySelector('[data-forge-diff-unreached]')).not.toBeNull()
      expect(rowTexts(app)).toEqual([])

      act(() => {
        // The double reports only the entries, which is all the view reads.
        Reflect.apply(watched.get(app)!, undefined, [[{ target: app, isIntersecting: true }], undefined])
      })
      expect(app.querySelector('[data-forge-diff-unreached]')).toBeNull()
      expect(rowTexts(app).length).toBeGreaterThan(0)
      expect(watched.has(app)).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('leaves file sections undrawn while the reader filters the file list', async () => {
    // The memoized section draws through its inner component, which the spy counts.
    const draw = vi.spyOn(DiffFileModule.DiffFile, 'type')
    const m = mount()
    await settle()
    const drawn = draw.mock.calls.length
    fireEvent.change(m.view.getAllByRole('textbox', { name: 'Filter files…' })[0]!, { target: { value: 'app' } })
    await settle()
    expect(draw.mock.calls.length).toBe(drawn)
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
    expect(m.paths().map(path => path === null ? null : m.section(path).hasAttribute('data-expanded'))).toEqual([true, true, true, true, true, false, false])

    fireEvent.click(within(m.section('src/app.ts')).getByRole('button', { name: 'Expand app.ts' }))
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
    expect(m.view.getAllByRole('menuitem').map(item => item.getAttribute('aria-label'))).toEqual([
      'assets', 'assets/logo.png', 'docs', 'docs/gone.txt', 'lib', 'lib/a.txt → lib/b.txt', 'logs', 'logs/big.log', 'src', 'src/app.ts', 'src/new.ts',
    ])
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    fireEvent.click(m.view.getByRole('button', { name: 'All 6 files' }))
    fireEvent.click(m.view.getByRole('menuitem', { name: 'docs/gone.txt' }))
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

  it('says when a scope has no changes, where a navigation to a file scrolls nothing', async () => {
    const m = mount({ params: { path: 'src/app.ts' }, setup: (faces) => { faces.localDiff.mockResolvedValue(ok({ base: null, files: [], omitted: 0 })) } })
    await settle()
    expect(m.view.getByText(en['diff.empty'])).toBeTruthy()
    expect(scrolled).not.toHaveBeenCalled()
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
    expect(m.faces.localText).toHaveBeenCalledWith({ kind: 'branch', base: null, commits: null }, 'src/app.ts')
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

  it.each(['local', 'change'] as const)('keeps the clipboard unchanged when a %s diff file label is clicked', async (kind) => {
    const m = mount({ source: kind === 'local' ? { kind } : { kind, url: URL7 } })
    await settle()
    fireEvent.click(m.section('src/app.ts').querySelector('[data-forge-file-label]')!)
    expect(m.faces.copyPath).not.toHaveBeenCalled()
    expect(m.section('src/app.ts').hasAttribute('data-expanded')).toBe(true)
    expect(m.tabActions.openResource).not.toHaveBeenCalled()
    fireEvent.click(within(m.section('docs/gone.txt')).getByRole('button', { name: 'Collapse gone.txt' }))
    fireEvent.click(m.section('docs/gone.txt').querySelector('[data-forge-file-label]')!)
    expect(m.faces.copyPath).not.toHaveBeenCalled()
    expect(m.section('docs/gone.txt').hasAttribute('data-expanded')).toBe(false)
  })

  it('distinguishes copy targets with the same basename by their complete paths', async () => {
    const m = mount({ setup: (faces) => { faces.localDiff.mockResolvedValue(ok({
      ...LOCAL, files: [file('src/index.ts'), file('tests/index.ts')],
    })) } })
    await settle()
    menu(m, 'src/index.ts')
    fireEvent.click(m.view.getByRole('menuitem', { name: en['diff.copyPath'] }))
    expect(m.faces.copyPath).toHaveBeenLastCalledWith('src/index.ts')
    menu(m, 'tests/index.ts')
    fireEvent.click(m.view.getByRole('menuitem', { name: en['diff.copyPath'] }))
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
    expect(m.faces.changeRequestDiff).toHaveBeenCalledWith(URL7, null, expect.any(AbortSignal))
    expect(m.view.queryByRole('button', { name: 'Branch' })).toBeNull()
    expect(m.view.getByRole('img', { name: 'Change request state: Open' })).toBeTruthy()
    expect(m.view.getByText('Change 7')).toBeTruthy()
    expect(m.view.getByText('#7')).toBeTruthy()
    fireEvent.click(m.view.getByRole('button', { name: en['change.view'] }))
    expect(m.faces.openLink).toHaveBeenLastCalledWith(URL7)
    await settle()

    expect(m.paths()).toEqual(['docs/gone.txt', 'docs/notes.txt', 'src/app.ts'])
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
    expect(m.paths()).toEqual(['docs/gone.txt', 'docs/notes.txt', 'src/app.ts'])
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

  it('keeps loading after the head moved past its status and reads again once a later status arrives', async () => {
    const m = mount({ source, setup: (faces) => { faces.changeRequestDiff.mockResolvedValueOnce(REFUSED.staleHead) } })
    await settle()
    expect(m.faces.changeRequestDiff).toHaveBeenCalledOnce()
    expect(m.view.queryByRole('status')).toBeNull()
    expect(m.paths()).toEqual([])

    // A later status with the same head reads again, as when the host's answers disagreed for a moment.
    const later = (fetchedAt: number, headSha: string) => {
      const polled = entry(7, snapshot(7, { headSha }))
      return ready({ changeRequests: [{ ...polled, update: { ...polled.update!, fetchedAt } }] })
    }
    m.faces.changeRequestDiff.mockResolvedValueOnce(REFUSED.staleHead)
    act(() => { m.panel.set({ state: later(2, HEAD), disconnected: false }) })
    await settle()
    expect(m.faces.changeRequestDiff).toHaveBeenCalledTimes(2)
    expect(m.view.queryByRole('status')).toBeNull()

    act(() => { m.panel.set({ state: later(3, 'b'.repeat(40)), disconnected: false }) })
    await settle()
    expect(m.faces.changeRequestDiff).toHaveBeenCalledTimes(3)
    expect(m.paths()).toEqual(['docs/gone.txt', 'docs/notes.txt', 'src/app.ts'])
  })

  it.each([
    ['a later poll with the same head', (polled: ForgePanelChangeRequest) => polled],
    ['a failed poll that keeps the earlier status', (polled: ForgePanelChangeRequest) => ({
      ...polled, update: { key: polled.update!.key, fetchedAt: 2, failure: { code: 'unavailable', message: 'down' } },
    } as const)],
  ] as const)('reads again at once when %s arrived while a read the host refused as stale was in flight', async (_label, arrive) => {
    const refused = Promise.withResolvers<typeof REFUSED.staleHead>()
    const m = mount({ source, setup: (faces) => { faces.changeRequestDiff.mockReturnValueOnce(refused.promise) } })
    await settle()
    expect(m.faces.changeRequestDiff).toHaveBeenCalledOnce()

    const polled = entry(7, snapshot(7))
    const later = arrive({ ...polled, update: { ...polled.update!, fetchedAt: 2 } })
    act(() => { m.panel.set({ state: ready({ changeRequests: [later] }), disconnected: false }) })
    await settle()
    expect(m.faces.changeRequestDiff).toHaveBeenCalledOnce()
    refused.resolve(REFUSED.staleHead)
    await settle()

    expect(m.faces.changeRequestDiff).toHaveBeenCalledTimes(2)
    expect(m.paths()).toEqual(['docs/gone.txt', 'docs/notes.txt', 'src/app.ts'])
  })

  it('keeps shown changes while a read waits for a later status, turning the refresh glyph', async () => {
    const m = mount({ source })
    await settle()
    m.faces.changeRequestDiff.mockResolvedValueOnce(REFUSED.staleHead)
    fireEvent.click(m.view.getByRole('button', { name: en['diff.refresh'] }))
    await settle()
    expect(m.paths()).toEqual(['docs/gone.txt', 'docs/notes.txt', 'src/app.ts'])
    expect(m.view.queryByText(en['diff.error'])).toBeNull()
    expect(m.view.getByRole('button', { name: en['diff.refresh'] }).querySelector('[data-turning]')).not.toBeNull()
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

describe('line review actions', () => {
  async function comment(options: MountOptions = {}) {
    const m = mount({ source: { kind: 'change', url: URL7 }, ...options, setup: (faces) => {
      faces.changeRequestReview.mockResolvedValue(ok(reviewData()))
      options.setup?.(faces)
    } })
    await settle()
    const section = within(m.section('src/app.ts'))
    fireEvent.click(section.getByRole('button', { name: 'Select line R4' }))
    fireEvent.click(section.getByRole('button', { name: 'Add comment' }))
    fireEvent.change(section.getByRole('textbox'), { target: { value: 'Check the guard' } })
    const publish = () => {
      fireEvent.click(section.getByRole('button', { name: 'GitHub comment options' }))
      fireEvent.click(m.view.getByRole('menuitem', { name: 'Publish single comment' }))
    }
    return { ...m, sectionQueries: section, publish }
  }
  it.each(['stale', 'unsupported', 'failed'] as const)('retains the draft after a known %s refusal and permits a later deliberate publish', async (code) => {
    const m = await comment({ setup: (faces) => { faces.submitReview.mockResolvedValueOnce(ok({ ok: false, code, message: 'Denied' })) } })
    m.publish()
    await settle()
    expect(m.faces.reviewQueue({ id: TAB, signal: m.aborter.signal }).getSnapshot().uncertain).toBeNull()
    expect(m.sectionQueries.getByRole('alert').textContent).toBe(code === 'failed' ? t('review.failed', { message: 'Denied' }) : t(code === 'stale' ? 'review.stale' : 'review.unsupported'))
    expect(m.sectionQueries.getByRole('textbox')).toHaveProperty('value', 'Check the guard')
    m.publish()
    await settle()
    expect(m.sectionQueries.queryByRole('textbox')).toBeNull()
    expect(m.faces.report).toHaveBeenCalledWith('review.published')
    expect(m.section('src/app.ts').querySelector('[data-forge-review-thread="published"]')).not.toBeNull()
  })
  it.each(['rejected', 'remote-error', 'receipt-storage'] as const)('holds an uncertain %s result for explicit reconciliation', async (kind) => {
    const m = await comment({ setup: (faces) => {
      if (kind === 'rejected') faces.submitReview.mockRejectedValueOnce(new Error('disconnected'))
      else if (kind === 'remote-error') faces.submitReview.mockResolvedValueOnce(REFUSED.failed)
    } })
    const records = m.faces.reviewQueue({ id: TAB, signal: m.aborter.signal })
    if (kind === 'receipt-storage') vi.spyOn(records, 'published').mockReturnValue(false)
    m.publish()
    await settle()
    expect(records.getSnapshot().uncertain).not.toBeNull()
    fireEvent.click(m.view.getByRole('button', { name: en['review.recheck'] }))
    expect(m.faces.openLink).toHaveBeenCalledWith(URL7)
    fireEvent.click(m.view.getByRole('button', { name: 'Submit review' }))
    const dialog = within(m.view.getByRole('dialog'))
    expect(dialog.getByRole('button', { name: 'Submit review' })).toHaveProperty('disabled', true)
    fireEvent.click(dialog.getByRole('button', { name: en['review.recheck'] }))
    fireEvent.click(dialog.getByRole('button', { name: 'Checked; allow resubmission' }))
    expect(records.getSnapshot().uncertain).toBeNull()
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
    expect(m.view.queryByRole('dialog')).toBeNull()
  })
  it('does not dispatch when persisting the outgoing request fails', async () => {
    const m = await comment()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    m.publish()
    await settle()
    expect(m.faces.submitReview).not.toHaveBeenCalled()
    expect(m.sectionQueries.getByRole('alert').textContent).toBe(en['review.saveFailed'])
  })
  it('reports quote-record failure without losing the accepted input reference', async () => {
    const m = await comment({ source: { kind: 'local' } })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    fireEvent.click(m.sectionQueries.getByRole('button', { name: 'Add to input' }))
    expect(m.faces.addReviewToInput).toHaveBeenCalledOnce()
    expect(m.faces.report).toHaveBeenCalledWith('review.saveFailed')
  })
  it('shows malformed persisted data without overwriting it', async () => {
    localStorage.setItem('test-review', 'invalid')
    const m = mount()
    await settle()
    expect(m.view.getByText(en['review.loadFailed'])).toBeTruthy()
    expect(localStorage.getItem('test-review')).toBe('invalid')
  })
  it('filters and folds the tree, preserving its selection while hidden', async () => {
    const m = mount()
    await settle()
    const tree = within(m.view.container.querySelector('[data-forge-file-tree]')!)
    fireEvent.click(tree.getByRole('button', { name: 'src' }))
    fireEvent.change(tree.getByRole('textbox'), { target: { value: 'app.ts' } })
    fireEvent.click(tree.getByRole('button', { name: 'src/app.ts' }))
    expect(tree.getByRole('button', { name: 'src/app.ts' }).getAttribute('aria-current')).toBe('true')
    const toggle = m.view.getByRole('button', { name: en['diff.moveFileTreeRight'] })
    toggle.focus()
    fireEvent.click(toggle)
    expect(m.view.getByRole('button', { name: en['diff.hideFileTree'] })).toBe(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(toggle)
    expect(tree.getByRole('button', { name: 'src/app.ts' }).getAttribute('aria-current')).toBe('true')
    fireEvent.click(toggle)
    expect(m.view.getByRole('button', { name: en['diff.showFileTreeLeft'] })).toBe(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle)
    fireEvent.click(toggle)
    expect(m.view.getByRole('button', { name: en['diff.moveFileTreeRight'] })).toBe(toggle)
    expect(document.activeElement).toBe(toggle)
    expect(tree.getByRole('textbox')).toHaveProperty('value', 'app.ts')
    fireEvent.change(tree.getByRole('textbox'), { target: { value: '' } })
    fireEvent.click(tree.getByRole('button', { name: 'src' }))
    expect(tree.getByRole('button', { name: 'src/app.ts' })).toBeTruthy()
  })
  it('refuses a local reference passed to the PR publication callback', async () => {
    // The memoized section draws through its inner component, which the spy observes.
    const renderDiff = DiffFileModule.DiffFile.type
    let publish: ReviewActions['publish']
    vi.spyOn(DiffFileModule.DiffFile, 'type').mockImplementation((props) => {
      publish = props.review?.publish
      return renderDiff(props)
    })
    const m = mount({ source: { kind: 'change', url: URL7 } })
    await settle()
    expect(publish).toBeDefined()
    expect(await publish!({ source: { kind: 'local', scope: 'branch', base: 'origin/main', baseRef: null, commits: null }, comment: {
      path: 'src/app.ts', side: 'R', startLine: 4, endLine: 4, hunk: '', body: 'Local reference',
    } })).toBe(en['review.stale'])
    expect(m.faces.submitReview).not.toHaveBeenCalled()
  })
  it('extends a range on one side and adds successive frozen references without submitting a message', async () => {
    const m = mount()
    await settle()
    const section = within(m.section('src/app.ts'))
    fireEvent.click(section.getByRole('button', { name: 'Select line R4' }))
    expect(section.queryByRole('textbox')).toBeNull()
    fireEvent.click(section.getByRole('button', { name: 'Select line R5' }), { shiftKey: true })
    fireEvent.click(section.getByRole('button', { name: 'Add comment' }))
    fireEvent.change(section.getByRole('textbox'), { target: { value: 'Explain these lines' } })
    expect(section.getByRole('textbox')).toHaveProperty('value', 'Explain these lines')
    fireEvent.click(within(m.section('src/app.ts').querySelector('[data-forge-comment]')!).getByRole('button', { name: 'Add to input' }))
    expect(m.faces.addReviewToInput.mock.lastCall?.[0]).toMatchObject({ source: { kind: 'local', scope: 'branch', base: 'origin/main', baseRef: null, commits: null },
      comment: { path: 'src/app.ts', side: 'R', startLine: 4, endLine: 5, body: 'Explain these lines' } })
    fireEvent.click(section.getByRole('button', { name: 'Select line L4' }))
    fireEvent.click(section.getByRole('button', { name: 'Add comment' }))
    fireEvent.change(section.getByRole('textbox'), { target: { value: 'Why remove this?' } })
    fireEvent.click(within(m.section('src/app.ts').querySelector('[data-forge-comment]')!).getByRole('button', { name: 'Add to input' }))
    expect(m.faces.addReviewToInput).toHaveBeenCalledTimes(2)
    expect(m.section('src/app.ts').querySelectorAll('[data-forge-review-thread="agent"]')).toHaveLength(2)
    expect(m.faces.submitReview).not.toHaveBeenCalled()
    expect(m.faces.createChangeRequest).not.toHaveBeenCalled()
  })
  it('adds comments to the pending review on the code host and submits it with the selected review decision', async () => {
    const m = mount({ source: { kind: 'change', url: URL7 }, state: ready({ changeRequests: [entry(7, snapshot(7))] }),
      setup: (faces) => { faces.changeRequestReview.mockResolvedValue(ok(reviewData())) } })
    await settle()
    const section = within(m.section('src/app.ts'))
    fireEvent.click(section.getByRole('button', { name: 'Select line R4' }))
    fireEvent.click(section.getByRole('button', { name: 'Add comment' }))
    fireEvent.change(section.getByRole('textbox'), { target: { value: 'Please fix' } })
    m.faces.changeRequestReview.mockResolvedValue(ok(reviewData({ pendingReview: PENDING_REVIEW })))
    fireEvent.click(section.getByRole('button', { name: 'Start review' }))
    await settle()
    expect(m.faces.changeRequestReviewWrite).toHaveBeenCalledWith(URL7, { kind: 'add-pending', headSha: HEAD,
      comment: { path: 'src/app.ts', side: 'R', startLine: 4, endLine: 4, body: 'Please fix' } })
    expect(m.faces.submitReview).not.toHaveBeenCalled()
    expect(m.faces.reviewQueue({ id: TAB, signal: m.aborter.signal }).getSnapshot().comments).toEqual([])
    expect(section.queryByRole('textbox')).toBeNull()
    // The write drops the Host's kept threads, so the view reads them again and finds the pending review.
    expect(m.faces.changeRequestReview).toHaveBeenCalledTimes(2)
    fireEvent.click(section.getByRole('button', { name: 'Select line R5' }))
    fireEvent.click(section.getByRole('button', { name: 'Add comment' }))
    expect(section.getByRole('button', { name: 'Add to review' })).toBeTruthy()
    fireEvent.click(section.getByRole('button', { name: 'Cancel' }))

    fireEvent.click(m.view.getByRole('button', { name: 'Submit review (1)' }))
    const dialog = within(m.view.getByRole('dialog', { name: 'Submit review' }))
    fireEvent.change(dialog.getByRole('textbox', { name: 'Review summary…' }), { target: { value: 'Needs a fix' } })
    fireEvent.click(dialog.getByRole('radio', { name: 'Request changes' }))
    m.faces.changeRequestReview.mockResolvedValue(ok(reviewData()))
    fireEvent.click(dialog.getByRole('button', { name: 'Submit review' }))
    await settle()
    expect(m.faces.changeRequestReviewWrite).toHaveBeenLastCalledWith(URL7,
      { kind: 'submit-pending', headSha: HEAD, review: 'review-1', event: 'request-changes', body: 'Needs a fix' })
    expect(m.faces.report).toHaveBeenCalledWith('review.submitted')
    expect(m.view.queryByRole('dialog')).toBeNull()
    expect(m.faces.reviewQueue({ id: TAB, signal: m.aborter.signal }).getSnapshot()).toMatchObject({ body: '', event: 'comment' })
    expect(m.view.getByRole('button', { name: 'Submit review' })).toBeTruthy()
  })
  it('keeps the dialog and says why the code host did not take the submission or the discard', async () => {
    const m = mount({ source: { kind: 'change', url: URL7 }, setup: (faces) => {
      faces.changeRequestReview.mockResolvedValue(ok(reviewData({ pendingReview: PENDING_REVIEW })))
      faces.changeRequestReviewWrite.mockResolvedValueOnce(ok({ ok: false, code: 'failed', message: 'Review is empty' }))
        .mockResolvedValueOnce(ok({ ok: false, code: 'stale', message: 'moved' }))
    } })
    await settle()
    fireEvent.click(m.view.getByRole('button', { name: 'Submit review (1)' }))
    const dialog = within(m.view.getByRole('dialog', { name: 'Submit review' }))
    fireEvent.click(dialog.getByRole('button', { name: 'Submit review' }))
    await settle()
    expect(dialog.getByRole('alert').textContent).toBe(t('thread.writeFailed', { message: 'Review is empty' }))
    fireEvent.click(dialog.getByRole('button', { name: 'Discard review' }))
    fireEvent.click(within(dialog.getByRole('group', { name: 'Discard review' })).getByRole('button', { name: 'Discard review' }))
    await settle()
    expect(m.faces.changeRequestReviewWrite).toHaveBeenLastCalledWith(URL7, { kind: 'discard-pending', headSha: HEAD, review: 'review-1' })
    expect(dialog.getByRole('alert').textContent).toBe(en['thread.writeStale'])
    expect(m.faces.report).not.toHaveBeenCalled()
    fireEvent.click(within(dialog.getByRole('group', { name: 'Discard review' })).getByRole('button', { name: 'Discard review' }))
    await settle()
    expect(m.faces.report).toHaveBeenCalledWith('review.discarded')
    expect(m.view.queryByRole('dialog')).toBeNull()
  })
  it('submits a pending review once when two activations arrive in the same render batch', async () => {
    const m = mount({ source: { kind: 'change', url: URL7 }, setup: (faces) => {
      faces.changeRequestReview.mockResolvedValue(ok(reviewData({ pendingReview: PENDING_REVIEW })))
    } })
    await settle()
    fireEvent.click(m.view.getByRole('button', { name: 'Submit review (1)' }))
    const button = within(m.view.getByRole('dialog')).getByRole('button', { name: 'Submit review' })
    act(() => { button.click(); button.click() })
    await settle()
    expect(m.faces.changeRequestReviewWrite).toHaveBeenCalledOnce()
  })
  it('refuses a local reference passed to the pending review callback', async () => {
    const renderDiff = DiffFileModule.DiffFile.type
    let queue: ReviewActions['queue']
    vi.spyOn(DiffFileModule.DiffFile, 'type').mockImplementation((props) => {
      queue = props.review?.queue
      return renderDiff(props)
    })
    const m = mount({ source: { kind: 'change', url: URL7 }, setup: (faces) => { faces.changeRequestReview.mockResolvedValue(ok(reviewData())) } })
    await settle()
    expect(queue).toBeDefined()
    expect(await queue!({ source: { kind: 'local', scope: 'branch', base: 'origin/main', baseRef: null, commits: null }, comment: {
      path: 'src/app.ts', side: 'R', startLine: 4, endLine: 4, hunk: '', body: 'Local reference',
    } })).toBe(en['review.stale'])
    expect(m.faces.changeRequestReviewWrite).not.toHaveBeenCalled()
  })
  it('keeps a pending review submission whose outcome is unknown blocked until the reader checks GitHub', async () => {
    const m = mount({ source: { kind: 'change', url: URL7 }, setup: (faces) => {
      faces.changeRequestReview.mockResolvedValue(ok(reviewData({ pendingReview: PENDING_REVIEW })))
      faces.changeRequestReviewWrite.mockResolvedValueOnce(ok({ ok: false, code: 'unknown', message: 'timeout' }))
    } })
    await settle()
    fireEvent.click(m.view.getByRole('button', { name: 'Submit review (1)' }))
    const dialog = within(m.view.getByRole('dialog'))
    fireEvent.change(dialog.getByRole('textbox', { name: 'Review summary…' }), { target: { value: 'Looks good' } })
    // The submission went through: the pending review no longer reads.
    m.faces.changeRequestReview.mockResolvedValue(ok(reviewData()))
    fireEvent.click(dialog.getByRole('button', { name: 'Submit review' }))
    await settle()
    const records = m.faces.reviewQueue({ id: TAB, signal: m.aborter.signal })
    expect(records.getSnapshot().uncertain).toEqual({ kind: 'review', headSha: HEAD, event: 'comment', body: 'Looks good', comments: [] })
    expect(dialog.getByRole('alert').textContent).toBe(en['thread.writeUnknown'])
    expect(dialog.getByRole('button', { name: 'Submit review' })).toHaveProperty('disabled', true)
    expect(m.faces.submitReview).not.toHaveBeenCalled()
    fireEvent.click(dialog.getByRole('button', { name: 'Checked; allow resubmission' }))
    expect(records.getSnapshot().uncertain).toBeNull()
  })
  it('refuses to submit the pending review when the browser cannot keep the submission for reconciliation', async () => {
    const m = mount({ source: { kind: 'change', url: URL7 }, setup: (faces) => {
      faces.changeRequestReview.mockResolvedValue(ok(reviewData({ pendingReview: PENDING_REVIEW })))
    } })
    await settle()
    fireEvent.click(m.view.getByRole('button', { name: 'Submit review (1)' }))
    vi.spyOn(m.faces.reviewQueue({ id: TAB, signal: m.aborter.signal }), 'begin').mockReturnValue(false)
    fireEvent.click(within(m.view.getByRole('dialog')).getByRole('button', { name: 'Submit review' }))
    await settle()
    expect(m.faces.changeRequestReviewWrite).not.toHaveBeenCalled()
    expect(within(m.view.getByRole('dialog')).getByRole('alert').textContent).toBe(en['review.saveFailed'])
  })
  it('reports a summary the browser could not clear after the code host took the submission', async () => {
    const m = mount({ source: { kind: 'change', url: URL7 }, setup: (faces) => {
      faces.changeRequestReview.mockResolvedValue(ok(reviewData({ pendingReview: PENDING_REVIEW })))
    } })
    await settle()
    fireEvent.click(m.view.getByRole('button', { name: 'Submit review (1)' }))
    vi.spyOn(m.faces.reviewQueue({ id: TAB, signal: m.aborter.signal }), 'finish').mockReturnValue(false)
    fireEvent.click(within(m.view.getByRole('dialog')).getByRole('button', { name: 'Submit review' }))
    await settle()
    expect(m.faces.report.mock.calls.map(call => call[0])).toEqual(['review.saveFailed', 'review.submitted'])
  })
  it.each([
    ['an unsupported write', ok<ForgeReviewWriteResult>({ ok: false, code: 'unsupported', message: 'no writes' }), en['thread.writeUnsupported'], 1],
    ['a refused write', ok<ForgeReviewWriteResult>({ ok: false, code: 'failed', message: 'Locked' }), t('thread.writeFailed', { message: 'Locked' }), 2],
    ['a stale write', ok<ForgeReviewWriteResult>({ ok: false, code: 'stale', message: 'moved' }), en['thread.writeStale'], 1],
    ['an unknown write', ok<ForgeReviewWriteResult>({ ok: false, code: 'unknown', message: 'timeout' }), en['thread.writeUnknown'], 2],
    ['an unbound change request', REFUSED.notBound, t('thread.writeFailed', { message: 'not bound' }), 1],
    ['a lost connection', REFUSED.failed, en['thread.writeUnknown'], 2],
  ] as const)('keeps the comment after %s, reading the threads again only when they may have changed', async (_label, answer, message, reads) => {
    const m = await comment({ setup: (faces) => { faces.changeRequestReviewWrite.mockResolvedValueOnce(answer) } })
    fireEvent.click(m.sectionQueries.getByRole('button', { name: 'Start review' }))
    await settle()
    expect(m.sectionQueries.getByRole('alert').textContent).toBe(message)
    expect(m.sectionQueries.getByRole('textbox')).toHaveProperty('value', 'Check the guard')
    expect(m.faces.changeRequestReview).toHaveBeenCalledTimes(reads)
  })
  it('sends writes one at a time, so a second waits for the pending review the first starts', async () => {
    storeDrafts('First', 'Second')
    const first = deferred<RemoteResult<ForgeReviewWriteResult>>()
    const m = mount({ source: { kind: 'change', url: URL7 }, setup: (faces) => {
      faces.changeRequestReview.mockResolvedValue(ok(reviewData()))
      faces.changeRequestReviewWrite.mockReturnValueOnce(first.promise)
    } })
    await settle()
    const drafts = [...m.section('src/app.ts').querySelectorAll<HTMLElement>('[data-forge-review-thread="pending"]')]
    for (const draft of drafts) fireEvent.click(within(draft).getByRole('button', { name: 'Add to review' }))
    await settle()
    expect(m.faces.changeRequestReviewWrite).toHaveBeenCalledTimes(1)
    first.settle(ok({ ok: false, code: 'failed', message: 'Busy' }))
    await settle()
    expect(m.faces.changeRequestReviewWrite.mock.calls.map(call => call[1].kind === 'add-pending' ? call[1].comment.body : null))
      .toEqual(['First', 'Second'])
    expect(m.faces.reviewQueue({ id: TAB, signal: m.aborter.signal }).getSnapshot().comments.map(item => item.comment.body)).toEqual(['First'])
  })
  it('offers no single comment while a pending review exists, which GitHub refuses', async () => {
    const m = mount({ source: { kind: 'change', url: URL7 }, setup: (faces) => {
      faces.changeRequestReview.mockResolvedValue(ok(reviewData({ pendingReview: PENDING_REVIEW })))
    } })
    await settle()
    const section = within(m.section('src/app.ts'))
    fireEvent.click(section.getByRole('button', { name: 'Select line R4' }))
    fireEvent.click(section.getByRole('button', { name: 'Add comment' }))
    expect(section.getByRole('button', { name: 'Add to review' })).toBeTruthy()
    expect(section.queryByRole('button', { name: 'GitHub comment options' })).toBeNull()
  })
  it('lets the author of the change request only comment in the review dialog', async () => {
    const m = mount({ source: { kind: 'change', url: URL7 }, setup: (faces) => {
      faces.changeRequestReview.mockResolvedValue(ok(reviewData({ viewer: 'OCTO', pendingReview: PENDING_REVIEW })))
    } })
    await settle()
    fireEvent.click(m.view.getByRole('button', { name: 'Submit review (1)' }))
    const dialog = within(m.view.getByRole('dialog'))
    expect(dialog.getByText(en['review.ownChangeRequest'])).toBeTruthy()
    expect(dialog.getByRole('radio', { name: 'Approve' })).toHaveProperty('disabled', true)
  })
  it.each([
    ['another reviewer', 'reviewer'],
    ['an unnamed viewer', null],
  ] as const)('lets %s choose every review decision', async (_label, viewer) => {
    const m = mount({ source: { kind: 'change', url: URL7 }, setup: (faces) => {
      faces.changeRequestReview.mockResolvedValue(ok(reviewData({ viewer, pendingReview: PENDING_REVIEW })))
    } })
    await settle()
    fireEvent.click(m.view.getByRole('button', { name: 'Submit review (1)' }))
    const dialog = within(m.view.getByRole('dialog'))
    expect(dialog.queryByText(en['review.ownChangeRequest'])).toBeNull()
    expect(dialog.getByRole('radio', { name: 'Approve' })).toHaveProperty('disabled', false)
  })
  it('offers no pending review action while the threads are unread, the user may not review, or chosen commits show', async () => {
    const unread = mount({ source: { kind: 'change', url: URL7 } })
    await settle()
    const section = within(unread.section('src/app.ts'))
    fireEvent.click(section.getByRole('button', { name: 'Select line R4' }))
    fireEvent.click(section.getByRole('button', { name: 'Add comment' }))
    expect(section.queryByRole('button', { name: 'Start review' })).toBeNull()
    expect(section.getByRole('button', { name: 'Publish single comment' })).toBeTruthy()
    unread.view.unmount()
    const barred = mount({ source: { kind: 'change', url: URL7 }, setup: (faces) => {
      faces.changeRequestReview.mockResolvedValue(ok(reviewData({ viewerCanReview: false })))
    } })
    await settle()
    const barredSection = within(barred.section('src/app.ts'))
    fireEvent.click(barredSection.getByRole('button', { name: 'Select line R4' }))
    fireEvent.click(barredSection.getByRole('button', { name: 'Add comment' }))
    expect(barredSection.queryByRole('button', { name: 'Start review' })).toBeNull()
  })
  it('moves a browser draft into the pending review at the head it was written on', async () => {
    storeDrafts('Kept from before')
    const m = mount({ source: { kind: 'change', url: URL7 }, setup: (faces) => { faces.changeRequestReview.mockResolvedValue(ok(reviewData())) } })
    await settle()
    const draft = within(m.section('src/app.ts').querySelector('[data-forge-review-thread="pending"]')!)
    expect(draft.getByText(en['review.browserDraft'])).toBeTruthy()
    expect(m.view.getByRole('button', { name: 'Submit review (1)' })).toBeTruthy()
    fireEvent.click(draft.getByRole('button', { name: 'Add to review' }))
    await settle()
    expect(m.faces.changeRequestReviewWrite).toHaveBeenCalledWith(URL7, { kind: 'add-pending', headSha: HEAD,
      comment: { path: 'src/app.ts', side: 'R', startLine: 4, endLine: 4, body: 'Kept from before' } })
    expect(m.faces.reviewQueue({ id: TAB, signal: m.aborter.signal }).getSnapshot().comments).toEqual([])
  })
  it('publishes browser drafts as one review while the user has no pending review', async () => {
    storeDrafts('Kept from before')
    const m = mount({ source: { kind: 'change', url: URL7 } })
    await settle()
    fireEvent.click(m.view.getByRole('button', { name: 'Submit review (1)' }))
    fireEvent.click(within(m.view.getByRole('dialog')).getByRole('button', { name: 'Submit review' }))
    await settle()
    expect(m.faces.submitReview).toHaveBeenCalledWith(URL7, expect.objectContaining({ kind: 'review', event: 'comment', body: '',
      comments: [expect.objectContaining({ body: 'Kept from before' })] }))
    expect(m.section('src/app.ts').querySelector('[data-forge-review-thread="published"]')?.textContent).toContain('Kept from before')
  })
  it('keeps a browser draft editable when its file leaves the diff', async () => {
    storeDrafts('Keep this draft')
    const m = mount({ source: { kind: 'change', url: URL7 }, state: ready({ changeRequests: [entry(7, snapshot(7))] }) })
    await settle()
    m.faces.changeRequestDiff.mockResolvedValue(ok({ ...CHANGE, files: [] }))
    fireEvent.click(m.view.getByRole('button', { name: 'Refresh changes' }))
    await settle()
    const record = within(m.view.container.querySelector('[data-forge-review-file="src/app.ts"]')!)
    expect(record.getByText('Keep this draft')).toBeTruthy()
    fireEvent.click(record.getByRole('button', { name: 'Delete' }))
    expect(m.faces.reviewQueue({ id: TAB, signal: m.aborter.signal }).getSnapshot().comments).toHaveLength(0)
  })
  it('retains an uncertain write across tab remount and requires explicit reconciliation', async () => {
    const m = mount({ source: { kind: 'change', url: URL7 }, state: ready({ changeRequests: [entry(7, snapshot(7))] }),
      setup: (faces) => {
        faces.submitReview.mockResolvedValue({ ok: true, value: { ok: false, code: 'unknown', message: 'timeout' } })
        faces.changeRequestReview.mockResolvedValue(ok(reviewData()))
      } })
    await settle()
    const section = within(m.section('src/app.ts'))
    fireEvent.click(section.getByRole('button', { name: 'Select line R4' }))
    fireEvent.click(section.getByRole('button', { name: 'Add comment' }))
    fireEvent.change(section.getByRole('textbox'), { target: { value: 'Comment once' } })
    fireEvent.click(section.getByRole('button', { name: 'GitHub comment options' }))
    fireEvent.click(m.view.getByRole('menuitem', { name: 'Publish single comment' }))
    await settle()
    expect(new ReviewQueue('test-review').getSnapshot().uncertain).toMatchObject({ kind: 'comment', comment: { body: 'Comment once' } })
    expect(section.getByRole('button', { name: 'GitHub comment options' })).toHaveProperty('disabled', true)
    await settle()
    expect(m.faces.submitReview).toHaveBeenCalledTimes(1)
    fireEvent.click(m.view.getByRole('button', { name: 'Checked; allow resubmission' }))
    expect(m.faces.reviewQueue({ id: TAB, signal: m.aborter.signal }).getSnapshot().uncertain).toBeNull()
  })
})

describe('ChangesTab review layers', () => {
  const SPEC = file('src/app.spec.ts', { layer: 'test', digest: 'spec-1' })
  const MANIFEST = file('package.json', { layer: 'interface', digest: 'manifest-1' })
  const LAYERED: ForgeLocalDiff = { base: BASE, files: [APP, SPEC, MANIFEST], omitted: 0 }

  it('counts each lens, keeps the files of the chosen layer in the tree and the diff, and hides test files', async () => {
    const m = mount({ setup: (faces) => { faces.localDiff.mockResolvedValue(ok(LAYERED)) } })
    await settle()
    const lens = m.view.getByRole('radiogroup', { name: en['lens.aria'] })
    expect(within(lens).getAllByRole('radio').map(radio => radio.textContent)).toEqual(['All3', 'Interface1', 'Implementation1', 'Tests1'])
    expect(m.paths()).toEqual(['src/app.spec.ts', 'src/app.ts', 'package.json'])

    fireEvent.click(within(lens).getByRole('radio', { name: /^Interface/ }))
    expect(m.paths()).toEqual(['package.json'])
    expect(within(m.view.getByRole('navigation')).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['package.json'])
    fireEvent.click(within(lens).getByRole('radio', { name: /^Tests/ }))
    expect(m.paths()).toEqual(['src/app.spec.ts'])

    fireEvent.click(m.view.getByRole('switch', { name: en['tests.hide'] }))
    expect(m.store.getSnapshot().byTab[TAB]).toMatchObject({ lens: 'all', hideTests: true })
    expect(m.paths()).toEqual(['src/app.ts', 'package.json'])
    expect(within(lens).getAllByRole('radio').map(radio => radio.textContent)).toEqual(['All2', 'Interface1', 'Implementation1', 'Tests'])
    fireEvent.click(within(lens).getByRole('radio', { name: /^Implementation/ }))
    expect(m.paths()).toEqual(['src/app.ts'])
    expect(m.view.getByRole('button', { name: 'All 1 files' })).toBeDefined()
    fireEvent.click(m.view.getByRole('button', { name: 'Review layer: Implementation' }))
    fireEvent.click(within(document.body).getByRole('menuitem', { name: 'Interface1' }))
    expect(m.paths()).toEqual(['package.json'])
  })

  it('says when no file shows and shows a file a navigation names even when the lens or the switch hides it', async () => {
    const m = mount({ setup: (faces) => { faces.localDiff.mockResolvedValue(ok({ ...LAYERED, files: [SPEC, MANIFEST] })) } })
    await settle()
    fireEvent.click(m.view.getByRole('radio', { name: /^Implementation/ }))
    expect(m.view.getByText(en['lens.empty'])).toBeDefined()
    expect(m.paths()).toEqual([])
    fireEvent.click(m.view.getByRole('switch', { name: en['tests.hide'] }))

    act(() => { m.navigation.set({ ...m.navigation.getSnapshot(), params: navigationParams({ path: 'src/app.spec.ts' }), revision: 2 }) })
    expect(m.store.getSnapshot().byTab[TAB]).toMatchObject({ lens: 'all', hideTests: false })
    expect(m.paths()).toEqual(['src/app.spec.ts', 'package.json'])
    expect(scrolled.mock.contexts.at(-1)).toBe(m.section('src/app.spec.ts'))

    fireEvent.click(m.view.getByRole('switch', { name: en['tests.hide'] }))
    act(() => { m.navigation.set({ ...m.navigation.getSnapshot(), params: navigationParams({ path: 'src/app.spec.ts' }), revision: 3 }) })
    expect(m.store.getSnapshot().byTab[TAB]).toMatchObject({ lens: 'all', hideTests: false })
    fireEvent.click(m.view.getByRole('radio', { name: /^Tests/ }))
    act(() => { m.navigation.set({ ...m.navigation.getSnapshot(), params: navigationParams({ path: 'package.json' }), revision: 4 }) })
    expect(m.store.getSnapshot().byTab[TAB]).toMatchObject({ lens: 'all', hideTests: false })
    expect(scrolled.mock.contexts.at(-1)).toBe(m.section('package.json'))
  })

  it('aligns the lens with the file tree it stands above and moves it into the toolbar without one', async () => {
    const m = mount()
    await settle()
    const toolbar = m.view.container.querySelector<HTMLElement>(`.${css.toolbar}`)!
    expect(toolbar.getAttribute('data-tree')).toBe('left')
    expect(toolbar.style.getPropertyValue('--forge-tree-width')).toBe('240px')
    expect(m.view.queryByRole('radiogroup')).not.toBeNull()
    const treeAction = (): HTMLElement => m.view.getByRole('button', { name: /^(Move file tree to the right|Hide file tree|Show file tree on the left)$/ })
    fireEvent.click(treeAction())
    expect(toolbar.getAttribute('data-tree')).toBe('right')
    fireEvent.click(treeAction())
    expect(toolbar.getAttribute('data-tree')).toBe('hidden')
    expect(m.view.queryByRole('radiogroup')).toBeNull()
    expect(m.view.getByRole('button', { name: 'Review layer: All' })).toBeDefined()
  })
})

describe('ChangesTab viewed marks the host keeps', () => {
  const source = { kind: 'change', url: URL7 } as const
  const marks = (m: ReturnType<typeof mount>): (string | null)[][] => [...m.view.container.querySelectorAll('[data-forge-diff-file]')]
    .map(element => [element.getAttribute('data-forge-diff-file'), element.getAttribute('data-viewed'), element.hasAttribute('data-expanded') ? 'open' : 'closed'])
  const hosted = (files: Record<string, 'viewed' | 'unviewed' | 'dismissed'>, headSha = HEAD) => ok({ headSha, files, truncated: false })
  const box = (m: ReturnType<typeof mount>, path: string, name: string): HTMLInputElement =>
    within(m.section(path)).getByRole('checkbox', { name: `Mark ${name} as viewed` })

  it('reads the marks with the diff, saves each mark on the host at once, and keeps the browser\'s marks apart', async () => {
    const saved = Promise.withResolvers<RemoteResult<void>>()
    const m = mount({ source, setup: (faces) => {
      faces.changeRequestViewed.mockResolvedValue(hosted({ 'src/app.ts': 'viewed', 'docs/notes.txt': 'dismissed' }))
      faces.setFileViewed.mockReturnValueOnce(saved.promise)
    } })
    await settle()
    expect(m.faces.changeRequestViewed).toHaveBeenCalledWith(URL7, HEAD, expect.any(AbortSignal))
    expect(marks(m)).toEqual([['docs/gone.txt', 'unviewed', 'open'], ['docs/notes.txt', 'changed', 'open'], ['src/app.ts', 'viewed', 'closed']])
    expect(m.view.getByRole('progressbar').getAttribute('aria-valuetext')).toBe('1 / 3 viewed')

    const gone = box(m, 'docs/gone.txt', 'gone.txt')
    expect(gone.closest('label')?.title).toBe(en['viewed.hintHost'])
    fireEvent.click(gone)
    expect(m.faces.setFileViewed).toHaveBeenCalledWith(URL7, { path: 'docs/gone.txt', viewed: true, headSha: HEAD })
    expect(marks(m)[0]).toEqual(['docs/gone.txt', 'viewed', 'closed'])
    // While its write is in flight the mark stays put, also for V.
    expect(gone.disabled).toBe(true)
    expect(gone.closest('label')?.title).toBe(en['viewed.saving'])
    fireEvent.keyDown(m.section('docs/gone.txt'), { key: 'v' })
    expect(m.faces.setFileViewed).toHaveBeenCalledOnce()
    await act(async () => { saved.resolve(ok(undefined)); await Promise.resolve() })
    expect(box(m, 'docs/gone.txt', 'gone.txt').disabled).toBe(false)
    expect(marks(m)[0]).toEqual(['docs/gone.txt', 'viewed', 'closed'])
    expect(m.viewedFiles.marksOf(JSON.stringify(['change', URL7, null])).size).toBe(0)
    expect(m.faces.report).not.toHaveBeenCalled()
  })

  it.each([
    ['refused', { ok: false, error: new RemoteError('forgePanel/action-failed', 'Resource not accessible', {}) }, ['viewed.syncFailed', { message: 'Resource not accessible' }]],
    ['stale', REFUSED.staleHead, ['viewed.syncStale']],
  ] as const)('returns a %s mark to what the host keeps and says why', async (_label, result, report) => {
    const m = mount({ source, setup: (faces) => {
      faces.changeRequestViewed.mockResolvedValue(hosted({ 'src/app.ts': 'viewed' }))
      faces.setFileViewed.mockResolvedValue(result)
    } })
    await settle()
    fireEvent.click(box(m, 'src/app.ts', 'app.ts'))
    expect(marks(m)[2]).toEqual(['src/app.ts', 'unviewed', 'open'])
    await settle()
    expect(marks(m)[2]).toEqual(['src/app.ts', 'viewed', 'open'])
    expect(m.faces.report).toHaveBeenCalledWith(...report)
    // A later choice that fails returns to the earlier saved one.
    m.faces.setFileViewed.mockResolvedValueOnce(ok(undefined))
    fireEvent.click(box(m, 'docs/notes.txt', 'notes.txt'))
    await settle()
    expect(marks(m)[1]?.[1]).toBe('viewed')
    fireEvent.click(box(m, 'docs/notes.txt', 'notes.txt'))
    expect(marks(m)[1]?.[1]).toBe('unviewed')
    await settle()
    expect(marks(m)[1]?.[1]).toBe('viewed')
  })

  it('locks every mark and offers to read again when the host\'s marks cannot be read', async () => {
    const m = mount({ source, setup: (faces) => {
      faces.changeRequestViewed.mockResolvedValueOnce({ ok: false, error: new RemoteError('forgePanel/viewed-failed', 'API rate limit exceeded', {}) })
        .mockResolvedValueOnce(hosted({}, 'b'.repeat(40)))
        .mockResolvedValue(hosted({ 'src/app.ts': 'viewed' }))
    } })
    await settle()
    const notice = m.view.getByText('Could not read viewed files from GitHub, so files cannot be marked: API rate limit exceeded')
    const app = box(m, 'src/app.ts', 'app.ts')
    expect(app.disabled).toBe(true)
    expect(app.closest('label')?.title).toBe(en['viewed.unavailable'])
    fireEvent.click(app)
    fireEvent.keyDown(m.section('src/app.ts'), { key: 'v' })
    expect(m.faces.setFileViewed).not.toHaveBeenCalled()
    // Marks read at another head than the diff cannot apply either.
    fireEvent.click(within(notice.closest('[role="status"]') as HTMLElement).getByRole('button', { name: en.retry }))
    await settle()
    const message = /^Could not read viewed files from GitHub, so files cannot be marked: viewed marks were read at b{40}/
    expect(m.view.getByText(message)).toBeDefined()
    fireEvent.click(m.view.getByRole('button', { name: en.retry }))
    await settle()
    expect(m.view.queryByText(/^Could not read viewed files/)).toBeNull()
    expect(marks(m)[2]).toEqual(['src/app.ts', 'viewed', 'closed'])
  })

  it('waits for a later status when the marks were read at a moved head, as for the diff', async () => {
    const m = mount({ source, setup: (faces) => { faces.changeRequestViewed.mockResolvedValueOnce(REFUSED.staleHead) } })
    await settle()
    expect(m.paths()).toEqual([])
    const polled = entry(7, snapshot(7, { headSha: HEAD }))
    const moved = { ...polled, update: { ...polled.update!, fetchedAt: 2 } }
    act(() => { m.panel.set({ state: ready({ changeRequests: [moved] }), disconnected: false }) })
    await settle()
    expect(m.paths()).toEqual(['docs/gone.txt', 'docs/notes.txt', 'src/app.ts'])
  })

  it('keeps the marks of chosen commits in the browser without reading the host', async () => {
    const m = mount({ source, setup: (faces) => { faces.changeRequestViewed.mockResolvedValue(hosted({ 'src/app.ts': 'viewed' })) } })
    await settle()
    m.faces.changeRequestViewed.mockClear()
    fireEvent.click(m.view.getByRole('button', { name: 'Commits shown: All commits' }))
    await settle()
    fireEvent.click(within(document.body).getByRole('menuitem', { name: /^3333333/ }))
    await settle()
    expect(m.faces.changeRequestViewed).not.toHaveBeenCalled()
    fireEvent.click(box(m, 'src/app.ts', 'app.ts'))
    expect(m.faces.setFileViewed).not.toHaveBeenCalled()
    expect(box(m, 'src/app.ts', 'app.ts').closest('label')?.title).toBe(en['viewed.hint'])
  })

  it('keeps a write in flight and its lock across a read at the same head, and the saved choice until the next read', async () => {
    const saved = Promise.withResolvers<RemoteResult<void>>()
    const m = mount({ source, setup: (faces) => {
      faces.changeRequestViewed.mockResolvedValue(hosted({}))
      faces.setFileViewed.mockReturnValueOnce(saved.promise)
    } })
    await settle()
    fireEvent.click(box(m, 'src/app.ts', 'app.ts'))
    // The read the refresh starts predates the write, so it holds no mark for the file.
    fireEvent.click(m.view.getByRole('button', { name: en['diff.refresh'] }))
    await settle()
    expect(m.faces.changeRequestViewed).toHaveBeenCalledTimes(2)
    expect(marks(m)[2]?.[1]).toBe('viewed')
    expect(box(m, 'src/app.ts', 'app.ts').disabled).toBe(true)
    await act(async () => { saved.resolve(ok(undefined)); await Promise.resolve() })
    expect(marks(m)[2]?.[1]).toBe('viewed')
    expect(box(m, 'src/app.ts', 'app.ts').disabled).toBe(false)
    // The next read holds what the host keeps, which wins over the settled choice.
    fireEvent.click(m.view.getByRole('button', { name: en['diff.refresh'] }))
    await settle()
    expect(marks(m)[2]?.[1]).toBe('unviewed')
  })

  it('returns a mark refused after a read at the same head to that read, leaving other writes in flight locked', async () => {
    const saved = Promise.withResolvers<RemoteResult<void>>()
    const m = mount({ source, setup: (faces) => {
      faces.changeRequestViewed.mockResolvedValue(hosted({}))
      faces.setFileViewed.mockReturnValueOnce(saved.promise)
    } })
    await settle()
    fireEvent.click(box(m, 'src/app.ts', 'app.ts'))
    m.faces.changeRequestViewed.mockResolvedValue(hosted({ 'docs/notes.txt': 'viewed' }))
    fireEvent.click(m.view.getByRole('button', { name: en['diff.refresh'] }))
    await settle()
    expect(marks(m).map(row => row[1])).toEqual(['unviewed', 'viewed', 'viewed'])
    const next = Promise.withResolvers<RemoteResult<void>>()
    m.faces.setFileViewed.mockReturnValueOnce(next.promise)
    fireEvent.click(box(m, 'docs/gone.txt', 'gone.txt'))
    await act(async () => { saved.resolve({ ok: false, error: new RemoteError('forgePanel/action-failed', 'late', {}) }); await Promise.resolve() })
    expect(marks(m).map(row => row[1])).toEqual(['viewed', 'viewed', 'unviewed'])
    expect(box(m, 'src/app.ts', 'app.ts').disabled).toBe(false)
    expect(box(m, 'docs/gone.txt', 'gone.txt').disabled).toBe(true)
    expect(m.faces.report).toHaveBeenCalledWith('viewed.syncFailed', { message: 'late' })
    await act(async () => { next.resolve(ok(undefined)); await Promise.resolve() })
    expect(box(m, 'docs/gone.txt', 'gone.txt').disabled).toBe(false)
  })

  it('starts the diff of another head without the earlier choices, which a late write leaves alone', async () => {
    const saved = Promise.withResolvers<RemoteResult<void>>()
    const moved = 'b'.repeat(40)
    const m = mount({ source, setup: (faces) => {
      faces.changeRequestViewed.mockResolvedValue(hosted({}))
      faces.setFileViewed.mockReturnValueOnce(saved.promise)
    } })
    await settle()
    fireEvent.click(box(m, 'src/app.ts', 'app.ts'))
    m.faces.changeRequestDiff.mockResolvedValue(ok({ ...CHANGE, headSha: moved }))
    m.faces.changeRequestViewed.mockResolvedValue(hosted({}, moved))
    const polled = entry(7, snapshot(7, { headSha: moved }))
    const status = { ...polled, update: { ...polled.update!, fetchedAt: 2 } }
    act(() => { m.panel.set({ state: ready({ changeRequests: [status] }), disconnected: false }) })
    await settle()
    expect(m.faces.changeRequestViewed).toHaveBeenLastCalledWith(URL7, moved, expect.any(AbortSignal))
    expect(marks(m)[2]?.[1]).toBe('unviewed')
    expect(box(m, 'src/app.ts', 'app.ts').disabled).toBe(false)
    // A write at the new head is in flight when the earlier one settles, which leaves it and its lock alone.
    const next = Promise.withResolvers<RemoteResult<void>>()
    m.faces.setFileViewed.mockReturnValueOnce(next.promise)
    fireEvent.click(box(m, 'docs/gone.txt', 'gone.txt'))
    await act(async () => { saved.resolve(ok(undefined)); await Promise.resolve() })
    expect(marks(m).map(row => row[1])).toEqual(['viewed', 'unviewed', 'unviewed'])
    expect(box(m, 'docs/gone.txt', 'gone.txt').disabled).toBe(true)
  })

  it('keeps a write that settles while chosen commits show for the read it was made on', async () => {
    const saved = Promise.withResolvers<RemoteResult<void>>()
    const m = mount({ source, setup: (faces) => {
      faces.changeRequestViewed.mockResolvedValue(hosted({}))
      faces.setFileViewed.mockReturnValueOnce(saved.promise)
    } })
    await settle()
    fireEvent.click(box(m, 'src/app.ts', 'app.ts'))
    fireEvent.click(m.view.getByRole('button', { name: 'Commits shown: All commits' }))
    await settle()
    fireEvent.click(within(document.body).getByRole('menuitem', { name: /^3333333/ }))
    await settle()
    await act(async () => { saved.resolve(ok(undefined)); await Promise.resolve() })
    // Returning to all commits reads the host's marks again, which then decide.
    fireEvent.click(m.view.getByRole('button', { name: /^Commits shown: 3333333/ }))
    await settle()
    fireEvent.click(within(document.body).getByRole('menuitem', { name: /^All commits/ }))
    await settle()
    expect(marks(m)[2]?.[1]).toBe('unviewed')
    expect(box(m, 'src/app.ts', 'app.ts').disabled).toBe(false)
  })

  it('keeps a mark the host may have saved and tells the reader to check', async () => {
    const m = mount({ source, setup: (faces) => {
      faces.changeRequestViewed.mockResolvedValue(hosted({}))
      faces.setFileViewed.mockResolvedValue({ ok: false, error: new RemoteError('forgePanel/action-unknown', 'Something went wrong', {}) })
    } })
    await settle()
    fireEvent.click(box(m, 'src/app.ts', 'app.ts'))
    await settle()
    expect(marks(m)[2]?.[1]).toBe('viewed')
    expect(box(m, 'src/app.ts', 'app.ts').disabled).toBe(false)
    expect(m.faces.report).toHaveBeenCalledWith('viewed.syncUnknown', { message: 'Something went wrong' })
  })
})

describe('ChangesTab viewed files', () => {
  const marks = (m: ReturnType<typeof mount>): (string | null)[][] => [...m.view.container.querySelectorAll('[data-forge-diff-file]')]
    .map(element => [element.getAttribute('data-forge-diff-file'), element.getAttribute('data-viewed'), element.hasAttribute('data-expanded') ? 'open' : 'closed'])

  it('marks a file viewed from its header, collapsing it and counting it, and clears the mark, expanding it', async () => {
    const m = mount({ source: { kind: 'change', url: URL7 } })
    await settle()
    const progress = (): string | null => m.view.getByRole('progressbar').getAttribute('aria-valuetext')
    expect(progress()).toBe('0 / 3 viewed')
    fireEvent.click(within(m.section('src/app.ts')).getByRole('checkbox', { name: 'Mark app.ts as viewed' }))
    expect(marks(m)[2]).toEqual(['src/app.ts', 'viewed', 'closed'])
    expect(progress()).toBe('1 / 3 viewed')
    fireEvent.click(within(m.section('src/app.ts')).getByRole('checkbox', { name: 'Mark app.ts as viewed' }))
    expect(marks(m)[2]).toEqual(['src/app.ts', 'unviewed', 'open'])
    fireEvent.click(within(m.section('src/app.ts')).getByRole('checkbox', { name: 'Mark app.ts as viewed' }))

    // A later mount reads the marks; a file whose change moved shows the change and expands again.
    cleanup()
    const again = mount({ source: { kind: 'change', url: URL7 }, viewedFiles: m.viewedFiles, setup: (faces) => {
      faces.changeRequestDiff.mockResolvedValue(ok({ ...CHANGE, files: [{ ...APP, digest: 'moved' }, NOTES, GONE] }))
    } })
    expect(marks(again)).toEqual([])
    await settle()
    expect(marks(again)[2]).toEqual(['src/app.ts', 'changed', 'open'])
    expect(within(again.section('src/app.ts')).getByText(en['viewed.changed'])).toBeDefined()
    cleanup()
    const same = mount({ source: { kind: 'change', url: URL7 }, viewedFiles: m.viewedFiles })
    await settle()
    expect(marks(same)[2]).toEqual(['src/app.ts', 'viewed', 'closed'])
    fireEvent.click(within(same.section('src/app.ts')).getByRole('button', { name: 'Expand app.ts' }))
    expect(marks(same)[2]).toEqual(['src/app.ts', 'viewed', 'open'])
  })

  it('toggles the file being read with V, keeps the header of a collapsed file in view, and leaves fields and modifiers alone', async () => {
    const m = mount()
    await settle()
    const { viewport, nodes } = fileViewport(m)
    viewport.scrollTop = 250
    fireEvent.scroll(viewport)
    fireEvent.keyDown(viewport, { key: 'V' })
    expect(nodes[1]?.getAttribute('data-viewed')).toBe('viewed')
    expect(scrolled.mock.contexts.at(-1)).toBe(nodes[1])
    fireEvent.keyDown(viewport, { key: 'v' })
    expect(nodes[1]?.getAttribute('data-viewed')).toBe('unviewed')
    for (const init of [{ key: 'v', ctrlKey: true }, { key: 'v', metaKey: true }, { key: 'v', altKey: true }, { key: 'x' }, { key: 'v', isComposing: true }]) {
      fireEvent.keyDown(viewport, init)
    }
    fireEvent.keyDown(m.view.getByRole('textbox', { name: en['diff.filterFiles'] }), { key: 'v' })
    expect(nodes.map(node => node.getAttribute('data-viewed'))).not.toContain('viewed')

    act(() => { m.visibility.set(false) })
    fireEvent.keyDown(viewport, { key: 'v' })
    expect(nodes.map(node => node.getAttribute('data-viewed'))).not.toContain('viewed')
  })

  it('toggles with V the file holding the focus, else the file holding the text cursor', async () => {
    const m = mount()
    await settle()
    const { viewport, nodes } = fileViewport(m)
    fireEvent.keyDown(within(nodes[2]!).getByRole('button', { name: /^Collapse / }), { key: 'v' })
    expect(nodes.map(node => node.getAttribute('data-viewed'))).toEqual(['unviewed', 'unviewed', 'viewed', 'unviewed', 'unviewed', 'unviewed'])
    const code = document.createTreeWalker(m.section('src/app.ts').querySelector('[data-review-code]')!, NodeFilter.SHOW_TEXT).nextNode()
    expect(code?.nodeType).toBe(Node.TEXT_NODE)
    window.getSelection()?.collapse(code, 0)
    fireEvent.keyDown(viewport, { key: 'v' })
    expect(m.section('src/app.ts').getAttribute('data-viewed')).toBe('viewed')
    window.getSelection()?.collapse(nodes[3]!, 0)
    fireEvent.keyDown(viewport, { key: 'v' })
    expect(nodes[3]?.getAttribute('data-viewed')).toBe('viewed')
    // Without a cursor, the file at the top of the view toggles.
    window.getSelection()?.removeAllRanges()
    fireEvent.keyDown(viewport, { key: 'v' })
    expect(nodes[0]?.getAttribute('data-viewed')).toBe('viewed')
  })

  it('reports a mark the browser refuses and ignores V without files', async () => {
    const viewedFiles = new ViewedFiles(SESSION)
    vi.spyOn(viewedFiles, 'mark').mockReturnValue(false)
    const m = mount({ viewedFiles })
    await settle()
    fireEvent.click(within(m.section('src/app.ts')).getByRole('checkbox', { name: 'Mark app.ts as viewed' }))
    expect(m.faces.report).toHaveBeenCalledWith('viewed.saveFailed')
    expect(m.section('src/app.ts').getAttribute('data-viewed')).toBe('unviewed')

    cleanup()
    const empty = mount({ setup: (faces) => { faces.localDiff.mockResolvedValue(ok({ ...LOCAL, files: [] })) } })
    await settle()
    fireEvent.keyDown(empty.view.container.firstElementChild!, { key: 'v' })
    expect(empty.faces.report).not.toHaveBeenCalled()
  })
})

describe('ChangesTab commits', () => {
  const one = { from: '2'.repeat(40), to: '2'.repeat(40) }

  it('reads the chosen commits of a change request and submits no review from them', async () => {
    const m = mount({ source: { kind: 'change', url: URL7 } })
    await settle()
    expect(m.faces.changeRequestCommits).toHaveBeenCalledWith(URL7, expect.any(AbortSignal))
    fireEvent.click(m.view.getByRole('button', { name: 'Commits shown: All commits' }))
    await settle()
    fireEvent.click(within(document.body).getByRole('menuitem', { name: /^2222222/ }))
    expect(m.store.getSnapshot().byTab[TAB]?.commits).toEqual(one)
    expect(m.faces.changeRequestDiff).toHaveBeenLastCalledWith(URL7, one, expect.any(AbortSignal))
    await settle()
    expect((m.view.getByRole('button', { name: en['review.submit'] }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('lists the commits of the branch scope only, and offers every commit when chosen ones are gone or not one run', async () => {
    const m = mount({ setup: (faces) => {
      faces.localDiff.mockImplementation(async (scope) => {
        if (scope.kind !== 'branch' || scope.commits === null) return ok(LOCAL)
        const code = scope.commits.from === one.from ? 'forgePanel/commits-missing' : 'forgePanel/commits-not-linear'
        return { ok: false, error: new RemoteError(code, 'refused', {}) }
      })
    } })
    await settle()
    expect(m.faces.localCommits).toHaveBeenCalledWith(null, expect.any(AbortSignal))
    fireEvent.click(m.view.getByRole('button', { name: 'Commits shown: All commits' }))
    await settle()
    fireEvent.click(within(document.body).getByRole('menuitem', { name: /^2222222/ }))
    expect(m.faces.localDiff).toHaveBeenLastCalledWith({ kind: 'branch', base: null, commits: one }, expect.any(AbortSignal))
    await settle()
    expect(m.view.getByText(en['commits.missing'])).toBeDefined()
    fireEvent.click(m.view.getByRole('button', { name: en['commits.showAll'] }))
    expect(m.store.getSnapshot().byTab[TAB]?.commits).toBeNull()
    await settle()
    fireEvent.click(m.view.getByRole('button', { name: 'Commits shown: All commits' }))
    await settle()
    fireEvent.click(within(document.body).getByRole('menuitem', { name: /^3333333/ }))
    await settle()
    expect(m.view.getByText(en['commits.notLinear'])).toBeDefined()
    fireEvent.click(m.view.getByRole('button', { name: en['commits.showAll'] }))
    expect(m.store.getSnapshot().byTab[TAB]?.commits).toBeNull()

    fireEvent.click(m.view.getByRole('button', { name: 'Branch' }))
    fireEvent.click(within(document.body).getByRole('menuitem', { name: en['diff.scope.staged'] }))
    expect(m.view.queryByRole('button', { name: /^Commits shown/ })).toBeNull()
  })
})

describe('ChangesTab review threads', () => {
  const source: ChangesSource = { kind: 'change', url: URL7 }
  const OLD = 'b'.repeat(40)
  const LARGE = file('logs/large.txt', { status: 'added', additions: 1001,
    hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1001, lines: Array.from({ length: 1001 }, (_, index) => `+${index}`) }] })
  const FILES = [APP, NOTES, GONE, LOGO, BIG, MOVED, LARGE]
  const line = (id: string, path: string, side: 'L' | 'R', at: number, overrides: Partial<ForgeReviewThread> = {}): ForgeReviewThread => reviewThread({
    id: id as ForgeThreadId, path, side,
    current: { commit: HEAD, startLine: at, endLine: at }, original: { commit: HEAD, startLine: at, endLine: at },
    comments: [reviewComment({ body: `Comment ${id}` })], ...overrides,
  })
  const THREADS: ForgeReviewThread[] = [
    line('on-row', 'src/app.ts', 'R', 4, { comments: [reviewComment({ body: 'Comment on-row', author: { login: 'octo', avatarUrl: null, bot: false } }),
      reviewComment({ body: 'Reply', author: { login: 'lin', avatarUrl: null, bot: false } })] }),
    line('old-side', 'src/app.ts', 'L', 11),
    line('in-gap', 'src/app.ts', 'R', 8),
    line('resolved', 'src/app.ts', 'R', 5, { resolved: true }),
    line('outdated', 'src/app.ts', 'R', 0, { current: null, original: { commit: OLD, startLine: 9, endLine: 9 } }),
    reviewThread({ id: 'file-thread' as ForgeThreadId, path: 'docs/notes.txt', subject: 'file', current: null, original: null, diffHunk: null,
      comments: [reviewComment({ body: 'Comment file-thread' })] }),
    line('beyond', 'docs/gone.txt', 'L', 3),
    line('binary', 'assets/logo.png', 'R', 1),
    line('oversized', 'logs/big.log', 'R', 1),
    line('renamed', 'lib/b.txt', 'R', 1),
    line('large', 'logs/large.txt', 'R', 1),
    line('missing', 'src/missing.ts', 'R', 1),
    line('missing-no-url', 'src/missing.ts', 'R', 2, { comments: [reviewComment({ url: null })] }),
  ]
  const REVIEW: ForgeReviewData = { headSha: HEAD, viewer: 'octo', threads: THREADS, truncated: false, pendingReview: null, viewerCanReview: false }
  const reviewed = (review: ForgeReviewData = REVIEW) => (faces: Faces): void => {
    faces.changeRequestDiff.mockImplementation(async () => ok({ ...CHANGE, files: FILES }))
    faces.changeRequestReview.mockImplementation(async () => ok(review))
  }
  /** Binding of #7 at the head whose latest status settled at `fetchedAt`. */
  const polledAt = (fetchedAt: number): ForgePanelChangeRequest => {
    const bound = entry(7, snapshot(7))
    return { ...bound, update: { key: 'github:github.com/octo/demo#7' as ChangeRequestKey, fetchedAt, snapshot: snapshot(7) } }
  }
  const card = (m: ReturnType<typeof mount>, id: string): HTMLElement | null => m.view.container.querySelector(`[data-forge-thread="${id}"]`)
  /** The element a thread places among the rows: its card, or side by side, the row of comment cells that holds it. */
  const placed = (m: ReturnType<typeof mount>, id: string): Element | null => {
    const found = card(m, id)
    return found?.closest('[data-forge-notes]') ?? found
  }
  /** Code of the row a thread follows, on the side its lines number. */
  const following = (m: ReturnType<typeof mount>, id: string, side: 'L' | 'R' = 'R'): string | null =>
    placed(m, id)?.previousElementSibling?.querySelector(side === 'L' ? '[data-old-line]' : '[data-new-line]')?.textContent ?? null
  /** The column of a side-by-side row that holds a thread: 0 for the left side, 1 for the right. */
  const column = (m: ReturnType<typeof mount>, id: string): number => {
    const found = card(m, id)!
    return Array.from(found.closest('[data-forge-notes]')!.children).findIndex(cell => cell.contains(found))
  }

  it('writes to a thread at the head of its read and reads the threads again', async () => {
    const writable = line('on-row', 'src/app.ts', 'R', 4, { viewerCanResolve: true })
    const m = mount({ source, setup: reviewed({ ...REVIEW, threads: [writable], pendingReview: { id: 'review-1' as ForgeReviewId, comments: 2 } }) })
    await settle()
    expect(m.view.getByRole('button', { name: 'Submit review (2)' })).toBeTruthy()
    fireEvent.click(within(card(m, 'on-row')!).getByRole('button', { name: 'Resolve thread' }))
    await settle()
    expect(m.faces.changeRequestReviewWrite).toHaveBeenCalledWith(URL7, { kind: 'resolve', thread: 'on-row', resolved: true, headSha: HEAD })
    expect(m.faces.changeRequestReview).toHaveBeenCalledTimes(2)
  })

  it('reads threads at the head of the latest status and places them on rows, gaps, files, and outdated sections', async () => {
    const m = mount({ source, setup: reviewed() })
    await settle()
    expect(m.faces.changeRequestReview).toHaveBeenCalledWith(URL7, HEAD, false, expect.any(AbortSignal))
    const app = m.section('src/app.ts')
    expect(following(m, 'on-row')).toBe('const y = 4')
    expect(following(m, 'old-side', 'L')).toBe('const w = 12')
    // Side by side, each thread sits in the column of the side its lines number.
    expect([column(m, 'on-row'), column(m, 'old-side')]).toEqual([1, 0])
    expect(card(m, 'in-gap')?.previousElementSibling?.getAttribute('data-forge-diff-gap')).toBe('1')
    expect(card(m, 'resolved')?.textContent).toContain('Resolved thread · reviewer')
    // The count alone shows below 480px.
    expect([...within(app).getByRole('button', { name: 'app.ts has 4 unresolved threads; go to the next one' }).children]
      .map(text => text.textContent)).toEqual(['4 unresolved', '4'])
    expect(app.querySelector('[data-forge-outdated-threads]')?.textContent).toContain('1 outdated threads')
    fireEvent.click(within(card(m, 'outdated')!).getByRole('button', { name: en['thread.viewOriginal'] }))
    expect(m.faces.changeRequestText).toHaveBeenLastCalledWith(URL7, OLD, 'src/app.ts')
    expect(m.section('docs/notes.txt').firstElementChild?.nextElementSibling?.getAttribute('data-forge-thread')).toBe('file-thread')
    expect(m.section('docs/gone.txt').querySelector(`.${css.code}`)?.lastElementChild?.getAttribute('data-forge-thread')).toBe('beyond')
    for (const id of ['binary', 'oversized', 'renamed', 'large']) expect(card(m, id)).not.toBeNull()
    expect(within(m.view.getByRole('navigation')).getByTitle('4 unresolved threads').textContent).toBe('4')
    fireEvent.click(within(app).getByRole('button', { name: '4 unchanged lines' }))
    await settle()
    expect(following(m, 'in-gap')).toBe('const a7 = 8')
    fireEvent.click(within(card(m, 'on-row')!).getByRole('button', { name: en['review.addToInput'] }))
    expect(m.faces.addThreadToInput).toHaveBeenCalledWith(THREADS[0], URL7, 'R4')
    m.faces.addThreadToInput.mockReturnValue(false)
    fireEvent.click(within(card(m, 'on-row')!).getByRole('button', { name: en['review.addToInput'] }))
    expect(m.faces.report).toHaveBeenLastCalledWith('thread.inputFailed')
  })

  it('opens the thread list, filters it by resolution, and opens each thread at its place', async () => {
    const m = mount({ source, setup: reviewed({ ...REVIEW, truncated: true }) })
    await settle()
    const toggle = m.view.getByRole('button', { name: 'Review threads, 13 in total' })
    fireEvent.click(toggle)
    const list = m.view.getByRole('complementary', { name: 'Review threads, 13 in total' })
    expect(within(list).getAllByRole('radio').map(radio => `${radio.textContent} ${radio.getAttribute('aria-checked')}`))
      .toEqual(['Unresolved12 true', 'Resolved1 false', 'All13 false'])
    expect(within(list).getByText(/^Too many threads; showing the first 13/)).toBeDefined()
    expect(within(list).getByRole('heading', { name: 'src/app.ts' })).toBeDefined()
    expect([...list.querySelectorAll('[data-forge-thread-group]')].map(group => group.getAttribute('data-forge-thread-group')))
      .toEqual(['assets/logo.png', 'docs/gone.txt', 'docs/notes.txt', 'lib/b.txt', 'logs/big.log', 'logs/large.txt', 'src/app.ts', 'src/missing.ts'])
    expect(list.querySelector('[data-forge-thread-item="resolved"]')).toBeNull()
    scrolled.mockClear()
    fireEvent.click(list.querySelector('[data-forge-thread-item="on-row"]')!)
    expect(scrolled.mock.contexts).toContain(card(m, 'on-row'))
    expect(list.isConnected).toBe(true)
    fireEvent.click(within(list).getByRole('radio', { name: /^Resolved/ }))
    expect([...list.querySelectorAll('[data-forge-thread-item]')].map(item => item.getAttribute('data-forge-thread-item'))).toEqual(['resolved'])
    fireEvent.click(list.querySelector('[data-forge-thread-item="resolved"]')!)
    expect(card(m, 'resolved')?.tagName).toBe('SECTION')
    fireEvent.click(within(list).getByRole('radio', { name: /^All/ }))
    fireEvent.click(list.querySelector('[data-forge-thread-item="missing"]')!)
    expect(m.faces.openLink).toHaveBeenLastCalledWith(THREADS[11]?.comments[0]?.url)
    m.faces.openLink.mockClear()
    fireEvent.click(list.querySelector('[data-forge-thread-item="missing-no-url"]')!)
    expect(m.faces.openLink).not.toHaveBeenCalled()
    fireEvent.click(within(list).getByRole('button', { name: en['thread.openAll'] }))
    expect(m.faces.openLink).toHaveBeenLastCalledWith(URL7)
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(list.isConnected).toBe(true)
    fireEvent.keyDown(list, { key: 'Escape' })
    expect(m.view.queryByRole('complementary')).toBeNull()
    expect(document.activeElement).toBe(toggle)
    fireEvent.click(toggle)
    fireEvent.click(within(m.view.getByRole('complementary')).getByRole('button', { name: en['thread.close'] }))
    expect(m.view.queryByRole('complementary')).toBeNull()
    fireEvent.click(toggle)
    fireEvent.click(within(m.view.getByRole('complementary')).getByRole('button', { name: en['thread.back'] }))
    expect(m.view.queryByRole('complementary')).toBeNull()
    fireEvent.click(toggle)
    fireEvent.click(m.view.getByRole('complementary').previousElementSibling!)
    expect(m.view.queryByRole('complementary')).toBeNull()
  })

  it('steps through a file\'s unresolved threads in display order from the count in its header', async () => {
    const m = mount({ source, setup: reviewed() })
    await settle()
    const shown: (string | undefined)[] = []
    for (let step = 0; step < 5; step += 1) {
      scrolled.mockClear()
      fireEvent.click(within(m.section('src/app.ts')).getByRole('button', { name: 'app.ts has 4 unresolved threads; go to the next one' }))
      await settle()
      shown.push((scrolled.mock.contexts as HTMLElement[]).find(element => element.dataset.forgeThread !== undefined)?.dataset.forgeThread)
    }
    // R4 in the first hunk, R8 in the unchanged lines after it, L11 in the second hunk, then the outdated thread, then R4 again.
    expect(shown).toEqual(['on-row', 'in-gap', 'old-side', 'outdated', 'on-row'])
    expect(m.view.queryByRole('complementary')).toBeNull()
  })

  it('takes the focus where the thread list covers the files, and closes it before opening a thread', async () => {
    // The narrow-view styles float the list; jsdom computes this rule in their place.
    const style = document.createElement('style')
    style.textContent = '[data-forge-thread-list] { position: absolute; }'
    document.head.append(style)
    try {
      const m = mount({ source, setup: reviewed() })
      await settle()
      fireEvent.click(m.view.getByRole('button', { name: 'Review threads, 13 in total' }))
      const list = m.view.getByRole('complementary')
      expect(document.activeElement).toBe(list)
      scrolled.mockClear()
      fireEvent.click(list.querySelector('[data-forge-thread-item="on-row"]')!)
      expect(m.view.queryByRole('complementary')).toBeNull()
      expect(scrolled.mock.contexts).toContain(card(m, 'on-row'))
      expect(document.activeElement).toBe(card(m, 'on-row'))
    } finally {
      style.remove()
    }
  })

  it('places only the threads whose lines number the last chosen commit, and shows the others after choosing all commits', async () => {
    const two = '2'.repeat(40)
    const threads = [line('at-head', 'src/app.ts', 'R', 4), line('written-on-two', 'src/app.ts', 'R', 3, { current: null, original: { commit: two, startLine: 3, endLine: 3 } })]
    const m = mount({ source, setup: (faces) => {
      faces.changeRequestDiff.mockImplementation(async (_url, commits) => ok({ ...CHANGE, headSha: commits?.to ?? HEAD }))
      faces.changeRequestReview.mockImplementation(async () => ok({ ...REVIEW, threads }))
    } })
    await settle()
    m.store.actions.committed(TAB, { from: two, to: two })
    await settle()
    expect(card(m, 'at-head')).toBeNull()
    expect(following(m, 'written-on-two')).toBe('const a3 = 3')
    fireEvent.click(m.view.getByRole('button', { name: 'Review threads, 2 in total' }))
    const list = m.view.getByRole('complementary')
    expect(list.querySelector('[data-forge-thread-item="at-head"]')?.textContent).toContain(en['thread.elsewhereTag'])
    fireEvent.click(list.querySelector('[data-forge-thread-item="at-head"]')!)
    expect(m.store.getSnapshot().byTab[TAB]?.commits).toBeNull()
    await settle()
    expect(following(m, 'at-head')).toBe('const y = 4')
  })

  it('chooses all commits for a thread on a file the chosen commits do not change, rather than opening it on the host', async () => {
    const two = '2'.repeat(40)
    const m = mount({ source, setup: (faces) => {
      faces.changeRequestDiff.mockImplementation(async (_url, commits) =>
        ok(commits === null ? CHANGE : { ...CHANGE, headSha: commits.to, files: [APP] }))
      faces.changeRequestReview.mockImplementation(async () => ok({ ...REVIEW, threads: [line('notes', 'docs/notes.txt', 'R', 2)] }))
    } })
    await settle()
    m.store.actions.committed(TAB, { from: two, to: two })
    await settle()
    expect(m.view.container.querySelector('[data-forge-diff-file="docs/notes.txt"]')).toBeNull()
    fireEvent.click(m.view.getByRole('button', { name: 'Review threads, 1 in total' }))
    fireEvent.click(m.view.getByRole('complementary').querySelector('[data-forge-thread-item="notes"]')!)
    expect(m.store.getSnapshot().byTab[TAB]?.commits).toBeNull()
    expect(m.faces.openLink).not.toHaveBeenCalled()
    scrolled.mockClear()
    await settle()
    expect(scrolled.mock.contexts).toContain(card(m, 'notes'))
  })

  it('draws a file a thread jump targets before its section comes within reach, and keeps it drawn', async () => {
    // A double that never reports a section as reached, as for files far below the scrollport.
    vi.stubGlobal('IntersectionObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    })
    try {
      const m = mount({ source, setup: reviewed() })
      await settle()
      expect(m.section('src/app.ts').querySelector('[data-forge-diff-unreached]')).not.toBeNull()
      scrolled.mockClear()
      fireEvent.click(within(m.section('src/app.ts')).getByRole('button', { name: 'app.ts has 4 unresolved threads; go to the next one' }))
      await settle()
      expect(m.section('src/app.ts').querySelector('[data-forge-diff-unreached]')).toBeNull()
      expect(scrolled.mock.contexts).toContain(card(m, 'on-row'))
      expect(m.section('docs/notes.txt').querySelector('[data-forge-diff-unreached]')).not.toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('stops a later jump to a file at its header once a thread jump there has ended', async () => {
    const m = mount({ source, setup: reviewed() })
    await settle()
    fireEvent.click(within(m.section('src/app.ts')).getByRole('button', { name: 'app.ts has 4 unresolved threads; go to the next one' }))
    await settle()
    scrolled.mockClear()
    fireEvent.click(within(m.view.getByRole('navigation')).getByRole('button', { name: 'src/app.ts' }))
    await settle()
    expect(scrolled.mock.contexts).toEqual([m.section('src/app.ts')])
  })

  it('keeps the thread list for a truncated read that kept no thread, so its note stays reachable', async () => {
    const m = mount({ source, setup: reviewed({ ...REVIEW, threads: [], truncated: true }) })
    await settle()
    fireEvent.click(m.view.getByRole('button', { name: 'Review threads, 0 in total' }))
    expect(within(m.view.getByRole('complementary')).getByText(/^Too many threads; showing the first 0/)).toBeDefined()
  })

  it('shows threads only at the head the diff and the latest status name, and reports a failed read with a retry', async () => {
    const m = mount({ source, setup: (faces) => { faces.changeRequestReview.mockResolvedValue(REFUSED.reviewFailed) } })
    await settle()
    expect(m.view.getByText('Could not read GitHub threads: GitHub is down')).toBeDefined()
    m.faces.changeRequestReview.mockResolvedValue(ok({ ...REVIEW, threads: [line('on-row', 'src/app.ts', 'R', 4)] }))
    fireEvent.click(within(m.view.getByText('Could not read GitHub threads: GitHub is down').closest('[role="status"]')!).getByRole('button', { name: en.retry }))
    await settle()
    // A refresh asks the host to read past the threads it keeps; the next status does not.
    expect(m.faces.changeRequestReview).toHaveBeenLastCalledWith(URL7, HEAD, true, expect.any(AbortSignal))
    expect(card(m, 'on-row')).not.toBeNull()
    m.faces.changeRequestReview.mockResolvedValue(REFUSED.staleHead)
    act(() => { m.panel.set({ state: ready({ changeRequests: [polledAt(2)] }), disconnected: false }) })
    await settle()
    expect(m.faces.changeRequestReview).toHaveBeenLastCalledWith(URL7, HEAD, false, expect.any(AbortSignal))
    expect(card(m, 'on-row')).not.toBeNull()
    m.faces.changeRequestReview.mockResolvedValue(REFUSED.reviewFailed)
    act(() => { m.panel.set({ state: ready({ changeRequests: [polledAt(3)] }), disconnected: false }) })
    await settle()
    expect(card(m, 'on-row')).not.toBeNull()
    expect(m.view.getByText('Could not read GitHub threads: GitHub is down')).toBeDefined()
    act(() => { m.panel.set({ state: ready({ changeRequests: [entry(7, snapshot(7, { headSha: OLD }))] }), disconnected: false }) })
    await settle()
    expect(card(m, 'on-row')).toBeNull()
  })

  it('offers no thread list for a change request without threads', async () => {
    const m = mount({ source, setup: reviewed({ ...REVIEW, threads: [] }) })
    await settle()
    expect(m.faces.changeRequestReview).toHaveBeenCalledOnce()
    expect(m.view.queryByRole('button', { name: /^Review threads/ })).toBeNull()
  })

  it('names no author when the host hides the change request\'s author', async () => {
    const m = mount({ source, state: ready({ changeRequests: [entry(7, snapshot(7, { author: null }))] }), setup: reviewed({ ...REVIEW,
      threads: [line('on-row', 'src/app.ts', 'R', 4, { comments: [reviewComment({ author: { login: 'octo', avatarUrl: null, bot: false } })] })] }) })
    await settle()
    expect(within(card(m, 'on-row')!).queryByText(en['thread.author'])).toBeNull()
  })

  it('reads no threads for local changes or a hidden view, and shows none for a provider without review reads', async () => {
    const local = mount()
    await settle()
    expect(local.faces.changeRequestReview).not.toHaveBeenCalled()
    cleanup()
    const m = mount({ source })
    await settle()
    expect(m.faces.changeRequestReview).toHaveBeenCalledOnce()
    expect(m.view.queryByRole('button', { name: /^Review threads/ })).toBeNull()
    expect(m.view.queryByText(/^Could not read GitHub threads/)).toBeNull()
    let answer: (value: RemoteResult<ForgeReviewData>) => void = () => {}
    m.faces.changeRequestReview.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    act(() => { m.panel.set({ state: ready({ changeRequests: [polledAt(2)] }), disconnected: false }) })
    expect(m.faces.changeRequestReview).toHaveBeenCalledTimes(2)
    act(() => { m.visibility.set(false) })
    await act(async () => { answer(ok(REVIEW)) })
    act(() => { m.panel.set({ state: ready({ changeRequests: [polledAt(3)] }), disconnected: false }) })
    await settle()
    expect(m.faces.changeRequestReview).toHaveBeenCalledTimes(2)
    act(() => { m.visibility.set(true) })
    await settle()
    expect(card(m, 'on-row')).toBeNull()
  })
})
