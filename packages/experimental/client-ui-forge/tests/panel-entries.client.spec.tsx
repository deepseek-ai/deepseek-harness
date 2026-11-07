// @vitest-environment jsdom
/**
 * Forge entries in the Session panel: the change requests section and its
 * title control, the checkout and local changes rows of the Environment
 * section, and the card actions they wire.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import type { MergeRequest } from '@deepseek-ai/dsh-experimental-forge/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, contextMenuHook, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ContextMenuTarget } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  ChangeRequestsActions, ChangeRequestsSection, type ChangeRequestsActionsProps, type ChangeRequestsSectionProps,
} from '../src/client/ChangeRequestsSection.tsx'
import { CheckoutRow, LocalChangesRow, type CheckoutRowProps, type LocalChangesRowProps } from '../src/client/EnvironmentRows.tsx'
import { en } from '../src/client/locales.ts'
import type { PanelSnapshot } from '../src/client/source.ts'
import type { ForgePanelChangeRequest, ForgePanelState } from '../src/types.ts'
import { created, entry, ready, removed, snapshot, worktree } from './client-fixtures.client.ts'

afterEach(cleanup)

const t = makeTranslate(en)
const SESSION = SessionId('s1')

function panelStore(state: ForgePanelState | null, disconnected = false) {
  return createSnapshotStore<PanelSnapshot>({ state, disconnected })
}

function section(state: ForgePanelState | null, options: { disconnected?: boolean } = {}) {
  const panel = panelStore(state, options.disconnected)
  const handlers = {
    reconnect: vi.fn<() => void>(),
    refresh: vi.fn<() => Promise<void>>(async () => {}),
    remove: vi.fn<(entry: ForgePanelChangeRequest) => void>(),
    markReady: vi.fn<(entry: ForgePanelChangeRequest) => Promise<void>>(async () => {}),
    merge: vi.fn<(entry: ForgePanelChangeRequest, request: MergeRequest) => Promise<void>>(async () => {}),
    readChecks: vi.fn<ChangeRequestsSectionProps['readChecks']>(async () => snapshot(1)),
    openLink: vi.fn<(url: string) => void>(),
    copyText: vi.fn<(text: string) => void>(),
    viewChanges: vi.fn<(entry: ForgePanelChangeRequest) => void>(),
    dismissOverlay: vi.fn<() => void>(),
  }
  const props = {
    sessionId: SESSION,
    presentation: 'docked',
    usePanel: bindSnapshotSelector(panel),
    useLocale: bindSnapshotSelector(createSnapshotStore<string>('en')),
    ...handlers,
    t,
  } as Pick<ChangeRequestsSectionProps,
    'sessionId' | 'presentation' | 'usePanel' | 'useLocale' | 'dismissOverlay' | 'reconnect' | 'refresh' | 'remove' | 'markReady'
    | 'merge' | 'readChecks' | 'openLink' | 'copyText' | 'viewChanges' | 't'> as ChangeRequestsSectionProps
  const view = render(<ChangeRequestsSection {...props} />)
  return { view, panel, ...handlers }
}

/** The expansion state of each rendered card, in list order. */
function expansion(view: ReturnType<typeof render>): boolean[] {
  return [...view.container.querySelectorAll('[data-forge-change]')].map(card => card.hasAttribute('data-expanded'))
}

/** Open one card's actions menu and choose an item. */
function chooseAction(card: HTMLElement, name: string, item: string): void {
  fireEvent.click(within(card).getByRole('button', { name: `Actions for ${name}` }))
  fireEvent.click(screen.getByRole('menuitem', { name: item }))
}

describe('ChangeRequestsSection', () => {
  it.each([
    ['before the first state', null],
    ['without bound change requests', ready()],
  ])('renders nothing %s', (_label, state) => {
    expect(section(state).view.container.innerHTML).toBe('')
  })

  it('keeps the cards and adds a reconnect notice while disconnected', () => {
    const b = section(ready({ changeRequests: [entry(1, snapshot(1))] }), { disconnected: true })
    const root = b.view.container.querySelector('[data-forge-panel]') as HTMLElement
    expect(root.firstElementChild?.getAttribute('role')).toBe('status')
    fireEvent.click(within(root).getByRole('button', { name: en.retry }))
    expect(b.reconnect).toHaveBeenCalledOnce()
    act(() => { b.panel.set({ state: ready({ changeRequests: [entry(1, snapshot(1))] }), disconnected: false }) })
    expect(b.view.queryByRole('status')).toBeNull()
  })

  it.each([
    ['open', snapshot(1)],
    ['draft', snapshot(1, { draft: true })],
  ])('expands the only %s change request by default', (_label, only) => {
    const b = section(ready({ changeRequests: [entry(1, only), entry(2, snapshot(2, { state: 'merged' })), entry(3, null)] }))
    expect(expansion(b.view)).toEqual([true, false, false])
  })

  it('collapses every card while several are open and keeps the user choice across updates', () => {
    const b = section(ready({ changeRequests: [entry(1, snapshot(1)), entry(2, snapshot(2))] }))
    expect(expansion(b.view)).toEqual([false, false])
    fireEvent.click(b.view.getByRole('button', { name: 'Expand #2' }))
    act(() => { b.panel.set({ state: ready({ changeRequests: [entry(1, snapshot(1, { title: 'Renamed' })), entry(2, snapshot(2))] }), disconnected: false }) })
    expect(expansion(b.view)).toEqual([false, true])
    fireEvent.click(b.view.getByRole('button', { name: 'Collapse #2' }))
    expect(expansion(b.view)).toEqual([false, false])
  })

  it('wires the card menu, the changes row, and retry to the section actions', async () => {
    const value = entry(7, snapshot(7))
    const b = section(ready({ changeRequests: [value, entry(8, { code: 'unavailable', message: 'down' })] }))
    const card = b.view.container.querySelector('[data-forge-change="https://github.com/octo/demo/pull/7"]') as HTMLElement
    chooseAction(card, '#7', en['change.view'])
    chooseAction(card, '#7', en['change.copy'])
    chooseAction(card, '#7', en['change.viewChanges'])
    chooseAction(card, '#7', en['change.remove'])
    fireEvent.click(within(card).getByRole('button', { name: 'View the changes of #7: 12 lines added, 3 lines deleted' }))
    fireEvent.click(b.view.getByRole('button', { name: en.retry }))
    expect(b.openLink).toHaveBeenCalledWith('https://github.com/octo/demo/pull/7')
    expect(b.copyText).toHaveBeenCalledWith('https://github.com/octo/demo/pull/7')
    expect(b.viewChanges).toHaveBeenCalledTimes(2)
    expect(b.viewChanges).toHaveBeenCalledWith(value)
    // Viewing changes opens the sidebar, so the panel overlay gives way.
    expect(b.dismissOverlay).toHaveBeenCalledTimes(2)
    expect(b.remove).toHaveBeenCalledWith(value)
    expect(b.refresh).toHaveBeenCalledOnce()
    await act(async () => {})
  })

  it('offers ready for review in the menu of an open draft and merge in the footer of a mergeable card', async () => {
    const draft = entry(7, snapshot(7, { draft: true }))
    const mergeable = entry(8, snapshot(8, { mergeReady: true, headSha: 'b'.repeat(40) }))
    const b = section(ready({ changeRequests: [draft, mergeable] }))
    fireEvent.click(b.view.getByRole('button', { name: 'Expand #8' }))
    const card = b.view.container.querySelector('[data-forge-change="https://github.com/octo/demo/pull/7"]') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: 'Actions for #7' }))
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: en['change.markReady'] })) })
    fireEvent.click(b.view.getByRole('button', { name: en['change.merge'] }))
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: en['change.mergeConfirm'] }))
    })
    expect(b.markReady).toHaveBeenCalledWith(draft)
    expect(b.merge).toHaveBeenCalledWith(mergeable, { method: 'squash', headSha: 'b'.repeat(40) })
    const merged = b.view.container.querySelector('[data-forge-change="https://github.com/octo/demo/pull/8"]') as HTMLElement
    fireEvent.click(within(merged).getByRole('button', { name: 'Actions for #8' }))
    expect(screen.queryByRole('menuitem', { name: en['change.markReady'] })).toBeNull()
  })

  it('shows the sign-in notice above the cards', () => {
    const b = section(ready({
      readiness: { state: 'unauthenticated', message: 'not logged in' },
      changeRequests: [entry(1, snapshot(1))],
    }))
    const banner = b.view.getByRole('status')
    expect(within(banner).getByText('gh auth login --hostname github.com').tagName).toBe('CODE')
    fireEvent.click(within(banner).getByRole('button', { name: en['signin.copy'] }))
    expect(b.copyText).toHaveBeenCalledWith('gh auth login --hostname github.com')
  })

  it.each([
    ['with its message', 'token expired', ['Sign in to gitlab.example.test to show change request status', 'token expired']],
    ['without a message', null, ['Sign in to gitlab.example.test to show change request status']],
  ])('asks to sign in to another code host %s', (_label, message, texts) => {
    const b = section(ready({
      repository: { forge: 'gitlab', host: 'gitlab.example.test', owner: 'octo', name: 'demo' },
      readiness: { state: 'unauthenticated', message },
      changeRequests: [entry(1, snapshot(1))],
    }))
    expect([...b.view.getByRole('status').children].map(child => child.textContent)).toEqual(texts)
  })

  it.each([
    ['with its message', 'spawn gh ENOENT', 'Change requests on github.com could not be read: spawn gh ENOENT'],
    ['without a message', null, 'Change requests on github.com could not be read: '],
  ])('explains an unreachable host %s', (_label, message, text) => {
    const b = section(ready({ readiness: { state: 'unavailable', message }, changeRequests: [entry(1, snapshot(1))] }))
    expect(b.view.getByRole('status').textContent).toBe(text)
  })

  it.each([
    ['sign-in is unknown', { readiness: null }],
    ['the host is signed in', {}],
    ['no provider serves the repository', { repository: null, readiness: { state: 'unauthenticated' as const, message: 'not logged in' } }],
  ])('shows no notice while %s', (_label, over) => {
    const b = section(ready({ ...over, changeRequests: [entry(1, snapshot(1))] }))
    expect(b.view.queryByRole('status')).toBeNull()
  })
})

describe('ChangeRequestsActions', () => {
  function actions(state: ForgePanelState | null) {
    const panel = panelStore(state)
    const props = { sessionId: SESSION, usePanel: bindSnapshotSelector(panel) } as
      Pick<ChangeRequestsActionsProps, 'sessionId' | 'usePanel'> as ChangeRequestsActionsProps
    return { view: render(<ChangeRequestsActions {...props} />), panel }
  }

  it('renders nothing without bound change requests', () => {
    expect(actions(ready()).view.container.innerHTML).toBe('')
    cleanup()
    expect(actions(null).view.container.innerHTML).toBe('')
  })

  it('counts the change requests, without a refresh control', () => {
    const b = actions(ready({ changeRequests: [entry(1, snapshot(1)), entry(2, snapshot(2))] }))
    expect(b.view.container.textContent).toBe('2')
    expect(b.view.queryByRole('button')).toBeNull()
  })
})

/** The checkout row props a test supplies; the rest come from the slot runtime. */
type CheckoutKeys = 'sessionId' | 'usePanel' | 'useHost' | 'useContextMenu' | 'renderFactorySlot' | 'refreshIfStale' | 'restore' | 't'

describe('CheckoutRow', () => {
  function row(state: ForgePanelState | null, home?: string) {
    const panel = panelStore(state)
    const host = createSnapshotStore<RemoteHostFacts>({ home, isLoopback: true })
    const restore = vi.fn<() => void>()
    const refreshIfStale = vi.fn<() => void>()
    const opened: ContextMenuTarget[] = []
    const renderFactorySlot = vi.fn((_name: string, input: { label: string }) => <button type="button">{input.label}</button>)
    const props = {
      sessionId: SESSION,
      usePanel: bindSnapshotSelector(panel),
      useHost: bindSnapshotSelector(host),
      useContextMenu: contextMenuHook((target: ContextMenuTarget) => { opened.push(target) }),
      renderFactorySlot,
      refreshIfStale,
      restore,
      t,
    } as Pick<CheckoutRowProps, CheckoutKeys> as CheckoutRowProps
    const view = render(<CheckoutRow {...props} />)
    return {
      view, restore, refreshIfStale, opened, renderFactorySlot,
      element: () => view.container.querySelector<HTMLElement>('[data-forge-checkout]'),
    }
  }

  /** Report the document visibility the browser would report. */
  function visibility(state: DocumentVisibilityState): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
    fireEvent(document, new Event('visibilitychange'))
  }

  it('refreshes when the panel shows it, when the window regains focus, and when the page becomes visible, until it unmounts', () => {
    const b = row(null)
    expect(b.refreshIfStale).toHaveBeenCalledOnce()
    fireEvent.focus(window)
    expect(b.refreshIfStale).toHaveBeenCalledTimes(2)
    visibility('hidden')
    expect(b.refreshIfStale).toHaveBeenCalledTimes(2)
    visibility('visible')
    expect(b.refreshIfStale).toHaveBeenCalledTimes(3)
    b.view.unmount()
    fireEvent.focus(window)
    visibility('visible')
    expect(b.refreshIfStale).toHaveBeenCalledTimes(3)
    Reflect.deleteProperty(document, 'visibilityState')
  })

  it.each([
    ['before the first state', null],
    ['while the first inspection runs', ready({ checkout: { state: 'pending' } })],
    ['outside a Git checkout', ready({ checkout: { state: 'none' } })],
  ])('renders nothing %s', (_label, state) => {
    expect(row(state).view.container.innerHTML).toBe('')
  })

  it('warns that Git could not be read and shows the failure on hover, without the directory menu', () => {
    const b = row(ready({ checkout: { state: 'failed', message: 'sandbox runner unavailable' } }))
    const element = b.element() as HTMLElement
    expect(element.hasAttribute('data-failed')).toBe(true)
    expect(element.textContent).toBe(en['checkout.failed'])
    fireEvent.pointerEnter(within(element).getByText(en['checkout.failed']))
    expect(b.view.getByRole('tooltip').textContent).toBe('sandbox runner unavailable')
    expect(b.renderFactorySlot).not.toHaveBeenCalled()
    fireEvent.contextMenu(element)
    expect(b.opened).toEqual([])
  })

  it('names the branch and kind of the project directory, shows its path on hover, and opens the directory menu', () => {
    const b = row(ready(), '/work')
    const element = b.element() as HTMLElement
    expect(element.textContent).toBe(`main${en['checkout.project']}${en['checkout.projectActions']}`)
    fireEvent.pointerEnter(within(element).getByText('main'))
    expect(b.view.getByRole('tooltip').textContent).toBe('Project directory: ~/repo')
    expect(b.renderFactorySlot).toHaveBeenCalledWith('contextMenu.button', expect.objectContaining({
      target: { kind: 'directory', value: { sessionId: SESSION, path: '/work/repo' } },
    }))
    fireEvent.contextMenu(element)
    expect(b.opened).toEqual([{ kind: 'directory', value: { sessionId: SESSION, path: '/work/repo' } }])
  })

  it('names a detached HEAD with its commit and a linked worktree', () => {
    expect(row(ready({}, { branch: null })).element()?.textContent)
      .toBe(`${en['checkout.detached']} · 0a1b2c3${en['checkout.project']}${en['checkout.projectActions']}`)
    cleanup()
    expect(row(ready({}, { linked: true })).element()?.textContent)
      .toBe(`main${en['checkout.worktree']}${en['checkout.worktreeActions']}`)
  })

  it('names the worktree this Session created with its base', () => {
    const b = row(ready({ directory: '/work/repo-dsh', worktree: worktree({ created: created({ path: '/work/repo-dsh' }) }) },
      { root: '/work/repo-dsh', branch: 'other', linked: true }))
    expect(b.element()?.textContent).toBe(`otherWorktree · from main${en['checkout.worktreeActions']}`)
  })

  it('names the base commit of a created worktree without a base branch, and a checkout without a commit', () => {
    const b = row(ready({ directory: '/work/repo-dsh', worktree: worktree({ created: created({ path: '/work/repo-dsh', from: null }) }) },
      { root: '/work/repo-dsh', branch: null, linked: true }))
    expect(b.element()?.textContent).toBe(`${en['checkout.detached']} · 0a1b2c3Worktree · from ccccccc${en['checkout.worktreeActions']}`)
    cleanup()
    expect(row(ready({}, { branch: null, commit: null })).element()?.textContent)
      .toBe(`${en['checkout.detached']}${en['checkout.project']}${en['checkout.projectActions']}`)
  })

  it('names a removed worktree and restores it on request', () => {
    const b = row(removed())
    const element = b.element() as HTMLElement
    expect(element.hasAttribute('data-missing')).toBe(true)
    expect(within(element).getByText('dsh/0a1b2c3d')).toBeTruthy()
    expect(within(element).getByText(en['missing.title'])).toBeTruthy()
    expect(b.renderFactorySlot).not.toHaveBeenCalled()
    fireEvent.click(within(element).getByRole('button', { name: en['checkout.restore'] }))
    expect(b.restore).toHaveBeenCalledOnce()
  })

  it('turns the restore button into a disabled spinner while a restoration runs', () => {
    const b = row(removed(true, false, { restoration: { phase: 'prepare' } }))
    const restore = within(b.element() as HTMLElement).getByRole('button', { name: en['checkout.restore'] })
    expect(restore instanceof HTMLButtonElement && restore.disabled).toBe(true)
    expect(restore.querySelector('svg[data-state="ongoing"]')).not.toBeNull()
  })
})

describe('LocalChangesRow', () => {
  const local = { base: 'origin/main', files: [
    { path: 'src/a.ts', additions: 3, deletions: 1, binary: false },
    { path: 'src/b.ts', additions: 2, deletions: 0, binary: false },
  ] }

  function row(state: ForgePanelState | null) {
    const panel = panelStore(state)
    const viewLocalChanges = vi.fn<() => void>()
    const createChangeRequest = vi.fn<() => void>()
    const dismissOverlay = vi.fn<() => void>()
    const props = {
      sessionId: SESSION, usePanel: bindSnapshotSelector(panel), dismissOverlay, viewLocalChanges, createChangeRequest, t,
    } as Pick<LocalChangesRowProps, 'sessionId' | 'usePanel' | 'dismissOverlay' | 'viewLocalChanges' | 'createChangeRequest' | 't'> as LocalChangesRowProps
    const view = render(<LocalChangesRow {...props} />)
    return { view, viewLocalChanges, createChangeRequest, dismissOverlay }
  }

  it.each([
    ['before the first state', null],
    ['before the branch scope is read', ready()],
    ['while the branch scope changes nothing', ready({ local: { base: 'origin/main', files: [] } })],
  ])('renders nothing %s', (_label, state) => {
    expect(row(state).view.container.innerHTML).toBe('')
  })

  it('sums the branch changes, opens them, and asks the Agent for a change request', () => {
    const b = row(ready({ local }))
    const element = b.view.container.querySelector('[data-forge-local]') as HTMLElement
    expect(within(element).getByText('Local changes · 2 files')).toBeTruthy()
    expect(within(element).getByText('+5')).toBeTruthy()
    fireEvent.click(within(element).getByRole('button', { name: 'View the changes of this Session: 2 files, 5 lines added, 1 lines deleted' }))
    expect(b.viewLocalChanges).toHaveBeenCalledOnce()
    fireEvent.click(within(element).getByRole('button', { name: en['changes.local.actions'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: en['change.viewChanges'] }))
    expect(b.viewLocalChanges).toHaveBeenCalledTimes(2)
    // Opening the view in the sidebar closes the panel overlay.
    expect(b.dismissOverlay).toHaveBeenCalledTimes(2)
    fireEvent.click(within(element).getByRole('button', { name: en['changes.local.actions'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: en['changes.local.create'] }))
    expect(b.createChangeRequest).toHaveBeenCalledOnce()
    expect(b.dismissOverlay).toHaveBeenCalledTimes(2)
    const more = within(element).getByRole('button', { name: en['changes.local.actions'] })
    fireEvent.click(more)
    fireEvent.click(more)
    expect(screen.queryByRole('menuitem')).toBeNull()
    fireEvent.click(more)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(screen.queryByRole('menuitem')).toBeNull()
  })

  it.each([
    ['without a code host repository', ready({ local, repository: null })],
    ['while a change request of the branch is open', ready({ local, changeRequests: [entry(7, snapshot(7, { headBranch: 'main' }))] })],
  ])('offers no change request %s', (_label, state) => {
    const b = row(state)
    fireEvent.click(b.view.getByRole('button', { name: en['changes.local.actions'] }))
    expect(screen.queryByRole('menuitem', { name: en['changes.local.create'] })).toBeNull()
  })
})
