// @vitest-environment jsdom
/**
 * Forge tab body: connection states, the checkout row, the local changes card,
 * the sign-in banner, the change request list, and tab visibility.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import type { MergeRequest } from '@deepseek-ai/dsh-experimental-forge/types'
import type { PaneId, SidebarRightTabActions, SidebarRightTabInfo, TabId } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { IconBranchOutlineRegular, IconFolderCloseRegular, IconWarningTriangleOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { changesAddress } from '../src/client/changes-address.ts'
import { ForgeTab, type ForgeTabProps } from '../src/client/ForgeTab.tsx'
import { en } from '../src/client/locales.ts'
import type { PanelSnapshot } from '../src/client/source.ts'
import css from '../src/client/ForgeTab.module.css'
import type { ForgePanelChangeRequest, ForgePanelState } from '../src/types.ts'
import { created, entry, ready, removed, snapshot, worktree } from './client-fixtures.client.ts'

afterEach(cleanup)

const t = makeTranslate(en)
const SESSION = SessionId('s1')
const unused = (): never => { throw new Error('the forge tab does not call this tab action') }

/** Tab information of a forge tab whose visibility the test sets. */
function tabInfo(visible: boolean, openResource: SidebarRightTabActions['openResource']): SidebarRightTabInfo {
  return {
    sidebar: { expanded: true, fullscreen: false },
    panel: { id: 'pane-1' as PaneId },
    tab: {
      id: 'tab-forge' as TabId,
      kind: 'forge-panel',
      contentId: 'sidebar://forge-panel',
      title: en['tab.title'],
      visible,
      navigation: { address: 'sidebar://forge-panel', params: undefined, revision: 0 },
      signal: new AbortController().signal,
      actions: { bindCommands: () => () => {}, openResource, openTab: unused, close: unused },
    },
  }
}

function tab(state: ForgePanelState | null, options: { disconnected?: boolean; visible?: boolean; home?: string } = {}) {
  const panel = createSnapshotStore<PanelSnapshot>({ state, disconnected: options.disconnected ?? false })
  const host = createSnapshotStore<RemoteHostFacts>({ home: options.home, isLoopback: true })
  const visibility = createSnapshotStore<boolean>(options.visible ?? true)
  const useVisibility = bindSnapshotSelector(visibility)
  const reconnect = vi.fn<() => void>()
  const refresh = vi.fn<() => Promise<void>>(async () => {})
  const remove = vi.fn<(entry: ForgePanelChangeRequest) => void>()
  const markReady = vi.fn<(entry: ForgePanelChangeRequest) => Promise<void>>(async () => {})
  const merge = vi.fn<(entry: ForgePanelChangeRequest, request: MergeRequest) => Promise<void>>(async () => {})
  const restore = vi.fn<() => void>()
  const openLink = vi.fn<(url: string) => void>()
  const copyText = vi.fn<(text: string) => void>()
  const copyPath = vi.fn<(path: string) => void>()
  const reportVisible = vi.fn<(visible: boolean) => void>()
  const createChangeRequest = vi.fn<() => void>()
  const openResource = vi.fn<SidebarRightTabActions['openResource']>()
  const props: ForgeTabProps = {
    useTabInfo: () => tabInfo(useVisibility(current => current), openResource),
    sessionId: SESSION,
    usePanel: bindSnapshotSelector(panel),
    useHost: bindSnapshotSelector(host),
    useLocale: bindSnapshotSelector(createSnapshotStore<string>('en')),
    reconnect, refresh, remove, markReady, merge, restore, openLink, copyText, copyPath, reportVisible, createChangeRequest,
    t,
  }
  const view = render(<ForgeTab {...props} />)
  return {
    view, panel, visibility, reconnect, refresh, remove, markReady, merge, restore, openLink, copyText, copyPath, reportVisible,
    createChangeRequest, openResource,
  }
}

/**
 * Fire an animation event under the name React DOM listens for here: jsdom
 * has no `AnimationEvent` but declares `WebkitAnimation`, so React DOM uses the WebKit-prefixed names.
 */
function animation(element: Element, phase: 'Start' | 'Iteration'): void {
  fireEvent(element, new Event(`webkitAnimation${phase}`, { bubbles: true }))
}

/** The checkout row, or null when the tab shows none. */
function checkoutRow(view: ReturnType<typeof render>): HTMLElement | null {
  const row = view.container.querySelector(`.${css.checkout}`)
  return row instanceof HTMLElement ? row : null
}

/** The expansion state of each rendered card, in list order. */
function expansion(view: ReturnType<typeof render>): boolean[] {
  return [...view.container.querySelectorAll('[data-forge-change]')].map(card => card.hasAttribute('data-expanded'))
}

describe('ForgeTab connection', () => {
  it('centers a spinner until the first state arrives', () => {
    const b = tab(null)
    expect(b.view.container.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(b.view.container.querySelector('[data-forge-panel]')).toBeNull()
    expect(b.view.queryByRole('status')).toBeNull()

    act(() => { b.panel.set({ state: ready(), disconnected: false }) })
    expect(b.view.container.querySelector('[data-forge-panel]')).not.toBeNull()
  })

  it('replaces the spinner with a reconnect notice while disconnected', () => {
    const b = tab(null, { disconnected: true })
    expect(b.view.container.querySelector('[data-state="ongoing"]')).toBeNull()
    const status = b.view.getByRole('status')
    expect(within(status).getByText(en['stream.failed'])).toBeTruthy()
    fireEvent.click(within(status).getByRole('button', { name: en.retry }))
    expect(b.reconnect).toHaveBeenCalledOnce()
  })

  it('keeps the last panel state and adds the reconnect notice while disconnected', () => {
    const b = tab(ready(), { disconnected: true })
    const root = b.view.container.querySelector('[data-forge-panel]')
    if (!(root instanceof HTMLElement)) throw new Error('no panel')
    expect(root.firstElementChild?.getAttribute('role')).toBe('status')
    fireEvent.click(within(root).getByRole('button', { name: en.retry }))
    expect(b.reconnect).toHaveBeenCalledOnce()

    act(() => { b.panel.set({ state: ready(), disconnected: false }) })
    expect(b.view.queryByRole('status')).toBeNull()
  })
})

describe('ForgeTab checkout', () => {
  it('shows no checkout row while the first inspection runs', () => {
    const b = tab(ready({ checkout: { state: 'pending' } }))
    expect(checkoutRow(b.view)).toBeNull()
    expect(b.view.getByText('Change requests of this Session · 0')).toBeTruthy()
  })

  it('explains a directory outside a Git checkout', () => {
    const b = tab(ready({ checkout: { state: 'none' } }))
    expect(checkoutRow(b.view)?.textContent).toBe(en['checkout.none'])
  })

  it('shows a failed inspection and its message on hover', () => {
    const b = tab(ready({ checkout: { state: 'failed', message: 'git status failed (128): fatal' } }))
    const row = checkoutRow(b.view)
    if (row === null) throw new Error('no checkout row')
    expect(row.textContent).toBe(en['checkout.failed'])
    fireEvent.pointerEnter(row)
    expect(b.view.getByRole('tooltip').textContent).toBe('git status failed (128): fatal')
  })

  it('names the branch and kind of the project directory and shows its path on hover', () => {
    const b = tab(ready(), { home: '/work' })
    const row = checkoutRow(b.view)
    if (row === null) throw new Error('no checkout row')
    expect(row.textContent).toBe(`main${en['checkout.project']}`)
    fireEvent.pointerEnter(row.querySelector(`.${css.checkoutName}`)!)
    expect(b.view.getByRole('tooltip').textContent).toBe('Project directory: ~/repo')
    // The copied path keeps the home directory the tooltip abbreviates.
    fireEvent.click(within(row).getByRole('button', { name: en['checkout.copyProjectPath'] }))
    expect(b.copyPath).toHaveBeenCalledWith('/work/repo')
  })

  it('names a detached HEAD with its commit', () => {
    const b = tab(ready({}, { branch: null }))
    expect(checkoutRow(b.view)?.textContent).toBe(`${en['checkout.detached']}·0a1b2c3${en['checkout.project']}`)
  })

  it('calls a linked worktree another tool created a worktree', () => {
    const b = tab(ready({}, { linked: true }))
    const row = checkoutRow(b.view)
    if (row === null) throw new Error('no checkout row')
    expect(row.textContent).toBe(`main${en['checkout.worktree']}`)
    fireEvent.click(within(row).getByRole('button', { name: en['checkout.copyWorktreePath'] }))
    expect(b.copyPath).toHaveBeenCalledWith('/work/repo')
  })

  it.each([
    ['its base branch', created({ path: '/work/repo-dsh' }), 'Worktree · from main'],
    ['the commit it started from', created({ path: '/work/repo-dsh', from: null, baseCommit: '0123456789abcdef' }), 'Worktree · from 0123456'],
  ])('names the worktree this Session created with %s', (_label, made, kind) => {
    const b = tab(ready({ directory: '/work/repo-dsh', worktree: worktree({ created: made }) }, { root: '/work/repo-dsh', branch: 'other', linked: true }))
    const row = checkoutRow(b.view)
    if (row === null) throw new Error('no checkout row')
    expect(row.textContent).toBe(`other${kind}`)
    fireEvent.click(within(row).getByRole('button', { name: en['checkout.copyWorktreePath'] }))
    expect(b.copyPath).toHaveBeenCalledWith('/work/repo-dsh')
  })

  it('shows detached HEAD in the worktree the Session created', () => {
    const b = tab(ready({ directory: '/work/repo-dsh', worktree: worktree({ created: created({ path: '/work/repo-dsh' }) }) },
      { root: '/work/repo-dsh', branch: null, commit: 'abc1234', linked: true }))
    expect(checkoutRow(b.view)?.textContent).toBe(`${en['checkout.detached']}·abc1234Worktree · from main`)
  })

  it('names a removed worktree and restores it on request', () => {
    const b = tab(removed())
    const row = checkoutRow(b.view)
    if (row === null) throw new Error('no checkout row')
    expect(row.hasAttribute('data-missing')).toBe(true)
    expect(within(row).getByText('dsh/0a1b2c3d')).toBeTruthy()
    expect(within(row).getByText(en['missing.title'])).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: en['checkout.restore'] }))
    expect(b.restore).toHaveBeenCalledOnce()
    // A removed worktree still offers the path it was created at.
    fireEvent.click(within(row).getByRole('button', { name: en['checkout.copyWorktreePath'] }))
    expect(b.copyPath).toHaveBeenCalledWith('/work/repo-dsh')
  })

  it('turns the restore button into a disabled spinner while a restoration runs', () => {
    const b = tab(removed(true, false, { restoration: { phase: 'prepare' } }))
    const row = checkoutRow(b.view)
    if (row === null) throw new Error('no checkout row')
    const restore = within(row).getByRole('button', { name: en['checkout.restore'] })
    expect(restore instanceof HTMLButtonElement && restore.disabled).toBe(true)
    expect(restore.querySelector('svg[data-state="ongoing"]')).not.toBeNull()
  })

  it.each([
    ['a folder for the project directory', () => ready(), IconFolderCloseRegular],
    ['a branch for a linked worktree', () => ready({}, { linked: true }), IconBranchOutlineRegular],
    ['a branch for the worktree this Session created',
      () => ready({ directory: '/work/repo-dsh', worktree: worktree({ created: created({ path: '/work/repo-dsh' }) }) }, { root: '/work/repo-dsh', branch: 'other', linked: true }),
      IconBranchOutlineRegular],
    ['a warning for a removed worktree', () => removed(), IconWarningTriangleOutlineRegular],
  ])('marks the checkout with %s', (_label, state, Icon) => {
    const b = tab(state())
    const glyph = checkoutRow(b.view)?.querySelector(`.${css.checkoutName} svg`)
    const expected = render(<Icon size={14} className={css.checkoutIcon} />).container.innerHTML
    expect(glyph?.outerHTML).toBe(expected)
  })
})

describe('ForgeTab local changes', () => {
  const local = { base: 'origin/main', files: [{ path: 'src/a.ts', additions: 3, deletions: 1, binary: false }] }
  const LOCAL_ADDRESS = changesAddress({ sessionId: SESSION, source: { kind: 'local' } })

  it('shows the changes of the checkout, opens them, and asks for a change request', () => {
    const b = tab(ready({ local }))
    const card = b.view.container.querySelector('[data-forge-local]')
    if (!(card instanceof HTMLElement)) throw new Error('no local changes card')
    expect(within(card).getByText('HEAD → origin/main')).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: 'View the changes of this Session: 1 files, 3 lines added, 1 lines deleted' }))
    expect(b.openResource).toHaveBeenLastCalledWith(LOCAL_ADDRESS, undefined)
    fireEvent.click(within(card).getByRole('button', { name: en['changes.local.title'] }))
    fireEvent.click(within(card).getByRole('button', { name: 'src/a.ts+3−1' }))
    expect(b.openResource).toHaveBeenLastCalledWith(LOCAL_ADDRESS, { params: { path: 'src/a.ts' } })
    fireEvent.click(within(card).getByRole('button', { name: en['changes.local.create'] }))
    expect(b.createChangeRequest).toHaveBeenCalledOnce()
  })

  it('offers no change request for a checkout without a code host repository', () => {
    const b = tab(ready({ local, repository: null }))
    expect(b.view.container.querySelector('[data-forge-local]')).not.toBeNull()
    expect(b.view.queryByRole('button', { name: en['changes.local.create'] })).toBeNull()
  })

  it.each([
    ['before the branch scope is read', ready()],
    ['while the branch scope changes nothing', ready({ local: { base: 'origin/main', files: [] } })],
    ['once an open change request carries the checked-out branch', ready({ local, changeRequests: [entry(7, snapshot(7, { headBranch: 'main' }))] })],
  ])('hides the card %s', (_label, state) => {
    const b = tab(state)
    expect(b.view.container.querySelector('[data-forge-local]')).toBeNull()
  })

  it('keeps the card while the change request of the branch is closed or the HEAD is detached', () => {
    const closed = tab(ready({ local, changeRequests: [entry(7, snapshot(7, { headBranch: 'main', state: 'closed' }))] }))
    expect(closed.view.container.querySelector('[data-forge-local]')).not.toBeNull()
    cleanup()
    const detached = tab(ready({ local, changeRequests: [entry(7, snapshot(7, { headBranch: 'main' }))] }, { branch: null }))
    expect(detached.view.container.querySelector('[data-forge-local]')).not.toBeNull()
  })
})

describe('ForgeTab sign-in banner', () => {
  it('offers the GitHub CLI sign-in command for an unauthenticated GitHub host', () => {
    const b = tab(ready({ readiness: { state: 'unauthenticated', message: 'not logged in' } }))
    const banner = b.view.getByRole('status')
    expect(within(banner).getByText('Sign in to github.com to show change request status')).toBeTruthy()
    expect(within(banner).getByText('gh auth login --hostname github.com').tagName).toBe('CODE')
    expect(within(banner).queryByText('not logged in')).toBeNull()
    fireEvent.click(within(banner).getByRole('button', { name: en['signin.copy'] }))
    expect(b.copyText).toHaveBeenCalledWith('gh auth login --hostname github.com')
  })

  it.each([
    ['with its message', 'token expired', ['Sign in to gitlab.example.test to show change request status', 'token expired']],
    ['without a message', null, ['Sign in to gitlab.example.test to show change request status']],
  ])('asks to sign in to another code host %s', (_label, message, texts) => {
    const b = tab(ready({
      repository: { forge: 'gitlab', host: 'gitlab.example.test', owner: 'octo', name: 'demo' },
      readiness: { state: 'unauthenticated', message },
    }))
    const banner = b.view.getByRole('status')
    expect([...banner.children].map(child => child.textContent)).toEqual(texts)
    expect(within(banner).queryByRole('button')).toBeNull()
  })

  it.each([
    ['with its message', 'spawn gh ENOENT', 'Change requests on github.com could not be read: spawn gh ENOENT'],
    ['without a message', null, 'Change requests on github.com could not be read: '],
  ])('explains an unreachable host %s', (_label, message, text) => {
    const b = tab(ready({ readiness: { state: 'unavailable', message } }))
    expect(b.view.getByRole('status').textContent).toBe(text)
  })

  it.each([
    ['sign-in is unknown', ready({ readiness: null })],
    ['the host is signed in', ready()],
    ['no provider serves the repository', ready({ repository: null, readiness: { state: 'unauthenticated', message: 'not logged in' } })],
  ])('shows no banner while %s', (_label, state) => {
    const b = tab(state)
    expect(b.view.queryByRole('status')).toBeNull()
  })
})

describe('ForgeTab change requests', () => {
  it('shows the empty state and refreshes on request', async () => {
    const b = tab(ready())
    expect(b.view.getByText('Change requests of this Session · 0')).toBeTruthy()
    expect(b.view.getByText(en['changes.empty'])).toBeTruthy()
    expect(b.view.getByText(en['changes.emptyHint'])).toBeTruthy()
    fireEvent.click(b.view.getByRole('button', { name: en.refresh }))
    expect(b.refresh).toHaveBeenCalledOnce()
    await act(async () => {})
  })

  it('turns the refresh glyph until the refresh settles and its turn ends, ignoring clicks meanwhile', async () => {
    const pending = Promise.withResolvers<undefined>()
    const b = tab(ready())
    b.refresh.mockReturnValueOnce(pending.promise)
    const button = b.view.getByRole('button', { name: en.refresh })
    const glyph = button.firstElementChild
    if (!(glyph instanceof HTMLElement)) throw new Error('no refresh glyph')
    expect(glyph.hasAttribute('data-turning')).toBe(false)

    fireEvent.click(button)
    animation(glyph, 'Start')
    fireEvent.click(button)
    expect(b.refresh).toHaveBeenCalledOnce()
    expect(button.getAttribute('aria-disabled')).toBe('true')
    animation(glyph, 'Iteration')
    expect(glyph.hasAttribute('data-turning')).toBe(true)

    await act(async () => { pending.resolve(undefined) })
    expect(button.getAttribute('aria-disabled')).toBe('false')
    expect(glyph.hasAttribute('data-turning')).toBe(true)
    animation(glyph, 'Iteration')
    expect(glyph.hasAttribute('data-turning')).toBe(false)
  })

  it.each([
    ['open', snapshot(1)],
    ['draft', snapshot(1, { draft: true })],
  ])('expands the only %s change request by default', (_label, only) => {
    const b = tab(ready({ changeRequests: [entry(1, only), entry(2, snapshot(2, { state: 'merged' })), entry(3, null)] }))
    expect(b.view.getByText('Change requests of this Session · 3')).toBeTruthy()
    expect(expansion(b.view)).toEqual([true, false, false])
  })

  it('collapses every card while several change requests are open', () => {
    const b = tab(ready({ changeRequests: [entry(1, snapshot(1)), entry(2, snapshot(2))] }))
    expect(expansion(b.view)).toEqual([false, false])
  })

  it('keeps the cards the user expanded and collapsed across later updates', () => {
    const b = tab(ready({ changeRequests: [entry(1, snapshot(1)), entry(2, snapshot(2, { state: 'closed' }))] }))
    expect(expansion(b.view)).toEqual([true, false])
    fireEvent.click(b.view.getByRole('button', { name: 'Collapse #1' }))
    fireEvent.click(b.view.getByRole('button', { name: 'Expand #2' }))
    expect(expansion(b.view)).toEqual([false, true])

    act(() => { b.panel.set({ state: ready({ changeRequests: [entry(1, snapshot(1, { title: 'Renamed' })), entry(2, snapshot(2, { state: 'closed' }))] }), disconnected: false }) })
    expect(expansion(b.view)).toEqual([false, true])
  })

  it('wires the card actions to the tab actions', async () => {
    const value = entry(7, snapshot(7))
    const b = tab(ready({ changeRequests: [value, entry(8, { code: 'unavailable', message: 'down' })] }))
    const card = b.view.container.querySelector('[data-forge-change="https://github.com/octo/demo/pull/7"]')
    if (!(card instanceof HTMLElement)) throw new Error('no card')
    // The only open change request starts expanded.
    fireEvent.click(within(card).getByRole('button', { name: en['change.view'] }))
    fireEvent.click(within(card).getByRole('button', { name: en['change.copy'] }))
    fireEvent.click(within(card).getByRole('button', { name: 'Remove #7 from this Session' }))
    fireEvent.click(within(card).getByRole('button', { name: 'View the changes of #7: 12 lines added, 3 lines deleted' }))
    fireEvent.click(b.view.getByRole('button', { name: en.retry }))
    expect(b.openResource).toHaveBeenCalledWith(
      changesAddress({ sessionId: SESSION, source: { kind: 'change', url: 'https://github.com/octo/demo/pull/7' } }), undefined,
    )
    expect(b.openLink).toHaveBeenCalledWith('https://github.com/octo/demo/pull/7')
    expect(b.copyText).toHaveBeenCalledWith('https://github.com/octo/demo/pull/7')
    expect(b.remove).toHaveBeenCalledWith(value)
    expect(b.refresh).toHaveBeenCalledOnce()
    await act(async () => {})
  })

  it('wires ready for review and merge to the tab actions', async () => {
    const draft = entry(7, snapshot(7, { draft: true }))
    const mergeable = entry(8, snapshot(8, { mergeReady: true, headSha: 'b'.repeat(40) }))
    const b = tab(ready({ changeRequests: [draft, mergeable] }))
    // Two open change requests both start collapsed.
    fireEvent.click(b.view.getByRole('button', { name: 'Expand #7' }))
    fireEvent.click(b.view.getByRole('button', { name: 'Expand #8' }))

    await act(async () => {
      fireEvent.click(b.view.getByRole('button', { name: en['change.markReady'] }))
    })
    fireEvent.click(b.view.getByRole('button', { name: en['change.merge'] }))
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: en['change.mergeConfirm'] }))
    })
    expect(b.markReady).toHaveBeenCalledWith(draft)
    expect(b.merge).toHaveBeenCalledWith(mergeable, { method: 'squash', headSha: 'b'.repeat(40) })
  })

  it('dates a finished change request from the current time', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-09T12:00:00Z') })
    try {
      const b = tab(ready({ changeRequests: [entry(1, snapshot(1, { state: 'merged', closedAt: '2026-10-09T11:00:00Z' }))] }))
      expect(b.view.getByText('Merged into main · 1 h ago')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ForgeTab visibility', () => {
  it('reports the tab visibility as it changes and hidden once unmounted', () => {
    const b = tab(ready())
    expect(b.reportVisible.mock.calls).toEqual([[true]])

    act(() => { b.visibility.set(false) })
    act(() => { b.visibility.set(true) })
    expect(b.reportVisible.mock.calls).toEqual([[true], [false], [true]])

    b.view.unmount()
    expect(b.reportVisible.mock.calls).toEqual([[true], [false], [true], [false]])
  })

  it('reports a tab that mounts hidden, also before the first state', () => {
    const b = tab(null, { visible: false })
    expect(b.reportVisible.mock.calls).toEqual([[false]])
  })
})
