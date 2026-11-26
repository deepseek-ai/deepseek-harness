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
import { bindSnapshotSelector, contextMenuHook, makeTranslate, responsiveHooks } from '@deepseek-ai/dsh-client-test-runtime'
import type { ContextMenuTarget } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type { PanelFoldProps } from '@deepseek-ai/dsh-client-ui-session-panel/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  ChangeRequestsActions, ChangeRequestsSection, type ChangeRequestsActionsProps, type ChangeRequestsSectionProps,
} from '../src/client/ChangeRequestsSection.tsx'
import {
  CheckoutRow, ConnectionRow, LocalChangesRow, type CheckoutRowProps, type ConnectionRowProps, type LocalChangesRowProps,
} from '../src/client/EnvironmentRows.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'
import type { PanelSnapshot } from '../src/client/source.ts'
import type { ForgePanelState } from '../src/types.ts'
import { createChangeRequestsSectionStore } from '../src/client/change-requests-store.ts'
import type { ChangeRequestEntry } from '../src/client/status.ts'
import { created, entry, ready, removed, snapshot, worktree } from './client-fixtures.client.ts'

afterEach(cleanup)

const t = makeTranslate(en)
const SESSION = brandString<SessionId>('s1')

function panelStore(state: ForgePanelState | null, disconnected = false) {
  return createSnapshotStore<PanelSnapshot>({ state, disconnected })
}

/**
 * The parts a row marks for the Session panel's row rules, nested as in its
 * markup, with `button:` before a part that is a button.
 * @param row - the row element.
 * @returns the parts, or null when the element is not marked as a panel row.
 */
function rowParts(row: Element): string | null {
  const partsOf = (element: Element): string => [...element.children]
    .filter(child => child.hasAttribute('data-row-part'))
    .map((child) => {
      const name = `${child.tagName === 'BUTTON' ? 'button:' : ''}${child.getAttribute('data-row-part') ?? ''}`
      const inner = partsOf(child)
      return inner === '' ? name : `${name}(${inner})`
    })
    .join(' ')
  return row.hasAttribute('data-session-panel-row') ? partsOf(row) : null
}

/** One Session's section store, as the registration mints it. */
type SectionStore = ReturnType<ReturnType<typeof createChangeRequestsSectionStore>['create']>

function section(
  state: ForgePanelState | null, options: { disconnected?: boolean; store?: SectionStore; coarsePointer?: boolean } = {},
) {
  const panel = panelStore(state, options.disconnected)
  const store = options.store ?? createChangeRequestsSectionStore().create()
  const handlers = {
    refresh: vi.fn<() => Promise<void>>(async () => {}),
    remove: vi.fn<(entry: ChangeRequestEntry) => void>(),
    markReady: vi.fn<(entry: ChangeRequestEntry) => Promise<void>>(async () => {}),
    merge: vi.fn<(entry: ChangeRequestEntry, request: MergeRequest) => Promise<void>>(async () => {}),
    readChecks: vi.fn<ChangeRequestsSectionProps['readChecks']>(async () => snapshot(1)),
    requestReviews: vi.fn<ChangeRequestsSectionProps['requestReviews']>(async () => {}),
    reviewerCandidates: vi.fn<ChangeRequestsSectionProps['reviewerCandidates']>(async () => []),
    openLink: vi.fn<(url: string) => void>(),
    copyText: vi.fn<(text: string) => void>(),
    viewChanges: vi.fn<(entry: ChangeRequestEntry) => void>(),
    dismissOverlay: vi.fn<() => void>(),
    // Plugins' card actions: a marker naming the change request it was drawn for.
    renderSlot: vi.fn((_name: string, owner: { url: string }) => <span data-plugin-action={owner.url} />),
    // The panel's Component Factories: the fold control as a button, and a row's hover details as a marker.
    renderFactorySlot: vi.fn((name: string, input: object) => {
      if (name !== 'conversation.session.panel.fold') return <span data-panel-details="" />
      const fold = input as PanelFoldProps
      return <button type="button" data-fold="" aria-expanded={fold.expanded} aria-label={fold.name} onClick={fold.onToggle}>{fold.label}</button>
    }),
  }
  const props = {
    sessionId: SESSION,
    presentation: 'docked',
    usePanel: bindSnapshotSelector(panel),
    useLocale: bindSnapshotSelector(createSnapshotStore<string>('en')),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    ...responsiveHooks({ matches: query => options.coarsePointer === true && query === '(pointer: coarse)' }),
    ...handlers,
    t,
  } as Pick<ChangeRequestsSectionProps,
    'sessionId' | 'presentation' | 'usePanel' | 'useLocale' | 'useStore' | 'actions' | 'dismissOverlay' | 'refresh'
    | 'remove' | 'markReady' | 'merge' | 'readChecks' | 'requestReviews' | 'reviewerCandidates' | 'openLink' | 'copyText'
    | 'viewChanges' | 'renderSlot' | 'renderFactorySlot' | 'useMediaQuery' | 't'> as ChangeRequestsSectionProps
  const view = render(<ChangeRequestsSection {...props} />)
  return { view, panel, store, ...handlers }
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

  it('keeps the cards while disconnected and leaves the lost stream to the Environment section', () => {
    const b = section(ready({ changeRequests: [entry(1, snapshot(1))] }), { disconnected: true })
    expect(b.view.queryByRole('status')).toBeNull()
    expect(expansion(b.view)).toEqual([true])
  })

  it.each([false, true])('focuses the reviewer search when it opens only on a fine primary pointer: coarse %s', async (coarsePointer) => {
    const b = section(ready({ changeRequests: [entry(1, snapshot(1, { canRequestReviews: true }))] }), { coarsePointer })
    fireEvent.click(b.view.container.querySelector('[data-forge-review]')!)
    fireEvent.click(screen.getByRole('menuitem', { name: en['reviewers.requestMore'] }))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    const field = screen.getByRole('textbox', { name: en['reviewers.search'] })
    expect(document.activeElement === field).toBe(!coarsePointer)
  })

  it.each([
    ['open', snapshot(1)],
    ['draft', snapshot(1, { draft: true })],
    ['merged', snapshot(1, { state: 'merged' })],
  ])('expands the card of the only bound change request while it is %s', (_label, only) => {
    const b = section(ready({ changeRequests: [entry(1, only)] }))
    expect(expansion(b.view)).toEqual([true])
  })

  it('collapses every card while the Session binds several, even when only one of them is open', () => {
    const b = section(ready({ changeRequests: [entry(1, snapshot(1)), entry(2, snapshot(2, { state: 'merged' })), entry(3, null)] }))
    expect(expansion(b.view)).toEqual([false, false, false])
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

  it('keeps each card the user chose, while later cards follow the default and the panel is hidden and shown again', () => {
    const one = section(ready({ changeRequests: [entry(1, snapshot(1))] }))
    expect(expansion(one.view)).toEqual([true])
    fireEvent.click(one.view.getByRole('button', { name: 'Collapse #1' }))
    const two = ready({ changeRequests: [entry(1, snapshot(1)), entry(2, snapshot(2))] })
    act(() => { one.panel.set({ state: two, disconnected: false }) })
    fireEvent.click(one.view.getByRole('button', { name: 'Expand #2' }))
    const three = ready({ changeRequests: [entry(1, snapshot(1)), entry(2, snapshot(2)), entry(3, snapshot(3))] })
    act(() => { one.panel.set({ state: three, disconnected: false }) })
    expect(expansion(one.view)).toEqual([false, true, false])
    // Hiding the panel unmounts the section; the Session's store keeps the choices for the next mount.
    one.view.unmount()
    const again = section(two, { store: one.store })
    expect(expansion(again.view)).toEqual([false, true])
    expect(expansion(section(ready({ changeRequests: [entry(1, snapshot(1))] })).view)).toEqual([true])
  })

  /** The numbers of the rendered cards, in list order. */
  const numbers = (view: ReturnType<typeof render>): string[] =>
    [...view.container.querySelectorAll('[data-forge-change]')].map(card => card.getAttribute('data-forge-change')?.split('/').at(-1) ?? '')
  const several = (count: number): ForgePanelState =>
    ready({ changeRequests: Array.from({ length: count }, (_unused, index) => entry(index + 1, snapshot(index + 1))) })

  it('shows up to three cards without a fold control', () => {
    const b = section(several(3))
    expect(numbers(b.view)).toEqual(['1', '2', '3'])
    expect(b.view.container.querySelector('[data-fold]')).toBeNull()
  })

  it('shows three cards of four or more and then the fold control, which shows the rest and folds them again', () => {
    const b = section(several(4))
    expect(numbers(b.view)).toEqual(['1', '2', '3'])
    const fold = (): HTMLElement => b.view.container.querySelector('[data-fold]') as HTMLElement
    expect([fold().textContent, fold().getAttribute('aria-label'), fold().getAttribute('aria-expanded')])
      .toEqual(['Show 1 more', 'Show 1 more (change requests)', 'false'])
    // The control is the list's last row, after the cards.
    expect(fold().compareDocumentPosition(b.view.container.querySelector('ul') as HTMLElement) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()

    fireEvent.click(fold())
    expect(numbers(b.view)).toEqual(['1', '2', '3', '4'])
    expect([fold().textContent, fold().getAttribute('aria-label'), fold().getAttribute('aria-expanded')])
      .toEqual(['Show less', 'Show less (change requests)', 'true'])
    act(() => { b.panel.set({ state: several(6), disconnected: false }) })
    expect(numbers(b.view)).toEqual(['1', '2', '3', '4', '5', '6'])

    fireEvent.click(fold())
    expect(numbers(b.view)).toEqual(['1', '2', '3'])
    expect(fold().textContent).toBe('Show 3 more')
  })

  it('keeps the fold choice of the Session while the panel is hidden and shown again', () => {
    const b = section(several(5))
    fireEvent.click(b.view.container.querySelector('[data-fold]') as HTMLElement)
    b.view.unmount()
    expect(numbers(section(several(5), { store: b.store }).view)).toEqual(['1', '2', '3', '4', '5'])
    expect(numbers(section(several(5)).view)).toEqual(['1', '2', '3'])
  })

  it('draws each card\'s hover details through the panel\'s details Factory', () => {
    const b = section(ready({ changeRequests: [entry(7, snapshot(7)), entry(8, null)] }))
    expect(b.renderFactorySlot).toHaveBeenCalledWith('conversation.session.panel.details', {
      title: 'Change 7', lines: ['#7 · feat → main'], status: { state: 'done', label: en['change.ci.passed'] },
    })
    expect(b.renderFactorySlot).toHaveBeenCalledWith('conversation.session.panel.details', { title: 'github.com/octo/demo/pull/8', lines: ['#8'] })
  })

  it('opens the changes of a card from its line and closes the panel\'s overlay', () => {
    const value = entry(7, snapshot(7))
    const b = section(ready({ changeRequests: [value, entry(8, snapshot(8))] }))
    const line = b.view.container.querySelector('[data-forge-change="https://github.com/octo/demo/pull/7"] [data-row-part="body"]') as HTMLElement
    fireEvent.click(line)
    expect(b.viewChanges.mock.calls).toEqual([[value]])
    expect(b.dismissOverlay).toHaveBeenCalledOnce()
    expect(b.openLink).not.toHaveBeenCalled()
  })

  it('draws the actions plugins add to each card before its actions menu', () => {
    const b = section(ready({ changeRequests: [entry(7, snapshot(7)), entry(8, null)] }))
    expect(b.renderSlot).toHaveBeenCalledWith('forge.change-request.card.actions', {
      url: 'https://github.com/octo/demo/pull/7', ref: entry(7, snapshot(7)).ref, headSha: snapshot(7).headSha, state: 'open',
    })
    expect(b.renderSlot).toHaveBeenCalledWith('forge.change-request.card.actions', expect.objectContaining({
      url: 'https://github.com/octo/demo/pull/8', headSha: null, state: null,
    }))
    const card = b.view.container.querySelector('[data-forge-change="https://github.com/octo/demo/pull/7"]') as HTMLElement
    const marker = card.querySelector('[data-plugin-action]') as HTMLElement
    expect(marker.compareDocumentPosition(within(card).getByRole('button', { name: 'Actions for #7' })) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
  })

  it('wires the card menu, the changes row, and retry to the section actions', async () => {
    const value = entry(7, snapshot(7))
    const b = section(ready({ changeRequests: [value, entry(8, { code: 'unavailable', message: 'down' })] }))
    const card = b.view.container.querySelector('[data-forge-change="https://github.com/octo/demo/pull/7"]') as HTMLElement
    chooseAction(card, '#7', 'Open on GitHub')
    chooseAction(card, '#7', en['change.copy'])
    chooseAction(card, '#7', en['change.viewChanges'])
    chooseAction(card, '#7', en['change.remove'])
    fireEvent.click(within(card).getByRole('button', { name: 'Expand #7' }))
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

  it.each([
    ['github', 'github.com', 'gh auth login --hostname github.com'],
    ['gitlab', 'gitlab.example.test', 'glab auth login --hostname gitlab.example.test'],
  ] as const)('asks to sign in to a %s host above the cards with the command its provider names', (forge, host, command) => {
    const b = section(ready({
      repository: { forge, host, owner: 'octo', name: 'demo' },
      readiness: { state: 'unauthenticated', message: 'not logged in', signIn: { command } },
      changeRequests: [entry(1, snapshot(1))],
    }))
    const root = b.view.container.querySelector('[data-forge-panel]') as HTMLElement
    const row = b.view.getByRole('status')
    expect(root.firstElementChild).toBe(row)
    expect(row.getAttribute('data-forge-signin')).toBe('unauthenticated')
    // The command is the row's detail line, and Copy its trailing control.
    expect(rowParts(row)).toBe('body(icon lines(content detail)) trailing')
    expect(row.querySelector('[data-row-part="detail"]')?.textContent).toBe(command)
    expect(within(row).getByText(`Sign in to ${host}`)).toBeTruthy()
    expect(within(row).getByText(command)).toBeTruthy()
    const copy = within(row).getByRole('button', { name: en['signin.copy'] })
    expect(copy.textContent).toBe(en['signin.copyShort'])
    fireEvent.click(copy)
    expect(b.copyText).toHaveBeenCalledWith(command)
    expect(within(row).queryByRole('button', { name: en['reason.show'] })).toBeNull()
  })

  it('shows the section for a sign-in alone, without the card list', () => {
    const b = section(ready({ readiness: { state: 'unauthenticated', message: null, signIn: null } }))
    expect(b.view.getByRole('status').textContent).toContain('Sign in to github.com')
    expect(b.view.queryByRole('list')).toBeNull()
  })

  it.each([
    ['asks to sign in when the provider names no sign-in command', { forge: 'github', state: 'unauthenticated' }, 'Sign in to gitlab.example.test'],
    ['says the host could not be read', { forge: 'github', state: 'unavailable' }, "Can't read change requests on gitlab.example.test"],
  ] as const)('%s and gives the reason from the info button', (_label, { forge, state }, title) => {
    const b = section(ready({
      repository: { forge, host: 'gitlab.example.test', owner: 'octo', name: 'demo' },
      readiness: { state, message: 'token expired', signIn: null },
    }))
    const row = b.view.getByRole('status')
    expect([row.textContent, row.querySelector('code, [data-forge-signin] button:not([data-forge-reason])')]).toEqual([title, null])
    expect(rowParts(row)).toBe('body(icon content) trailing')
    const reason = within(row).getByRole('button', { name: en['reason.show'] })
    fireEvent.click(reason)
    expect(screen.getByRole('tooltip').textContent).toBe('token expired')
    expect(reason.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id)
  })

  it.each([
    ['a provider that names no sign-in command', { forge: 'github', state: 'unauthenticated' }],
    ['an unreachable host', { forge: 'github', state: 'unavailable' }],
  ] as const)('offers no info button for %s that gave no reason', (_label, { forge, state }) => {
    const b = section(ready({
      repository: { forge, host: 'github.com', owner: 'octo', name: 'demo' },
      readiness: { state, message: null, signIn: null },
    }))
    expect(within(b.view.getByRole('status')).queryByRole('button')).toBeNull()
    expect(rowParts(b.view.getByRole('status'))).toBe('body(icon content)')
  })

  it.each([
    ['sign-in is unknown', { readiness: null }],
    ['the host is signed in', {}],
    ['no provider serves the repository', { repository: null, readiness: { state: 'unauthenticated' as const, message: 'not logged in', signIn: null } }],
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

  it('warns that Git could not be read and gives the failure from the info button, without the directory menu', () => {
    const b = row(ready({ checkout: { state: 'failed', message: 'sandbox runner unavailable' } }))
    const element = b.element() as HTMLElement
    expect(element.hasAttribute('data-failed')).toBe(true)
    expect(rowParts(element)).toBe('body(icon content) trailing')
    expect(element.textContent).toBe(en['checkout.failed'])
    expect(within(element).getByText(en['checkout.failed']).hasAttribute('tabindex')).toBe(false)
    const reason = within(element).getByRole('button', { name: en['reason.show'] })
    vi.useFakeTimers()
    fireEvent.pointerEnter(reason)
    act(() => { vi.advanceTimersByTime(499) })
    expect(b.view.queryByRole('tooltip')).toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    vi.useRealTimers()
    expect(b.view.getByRole('tooltip').textContent).toBe('sandbox runner unavailable')
    fireEvent.pointerLeave(reason)
    expect(b.view.queryByRole('tooltip')).toBeNull()
    // A press shows it too, for touch screens that cannot hover.
    fireEvent.click(reason)
    expect(b.view.getByRole('tooltip').textContent).toBe('sandbox runner unavailable')
    expect(b.renderFactorySlot).not.toHaveBeenCalledWith('contextMenu.button', expect.anything())
    fireEvent.contextMenu(element)
    expect(b.opened).toEqual([])
  })

  it('names the branch and kind of the project directory, shows its path on hover, and opens the directory menu', () => {
    const b = row(ready(), '/work')
    const element = b.element() as HTMLElement
    expect(element.textContent).toBe(`main${en['checkout.project']}${en['checkout.projectActions']}`)
    // The kind trails the branch name, and the More button is the row menu.
    expect(rowParts(element)).toBe('body(icon content) trailing menu')
    expect(element.querySelector('[data-row-part="icon"]')?.getAttribute('aria-hidden')).toBe('true')
    expect(element.querySelector('[data-row-part="trailing"]')?.textContent).toBe(en['checkout.project'])
    expect(element.querySelector('[data-row-part="menu"]')?.textContent).toBe(en['checkout.projectActions'])
    vi.useFakeTimers()
    fireEvent.pointerEnter(within(element).getByText('main'))
    act(() => { vi.advanceTimersByTime(499) })
    expect(b.view.queryByRole('tooltip')).toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    vi.useRealTimers()
    expect(b.view.getByRole('tooltip').textContent).toBe('Project directory: ~/repo')
    expect(b.renderFactorySlot).toHaveBeenCalledWith('contextMenu.button', expect.objectContaining({
      target: { kind: 'directory', value: { sessionId: SESSION, path: '/work/repo' } },
    }))
    fireEvent.contextMenu(element)
    expect(b.opened).toEqual([{ kind: 'directory', value: { sessionId: SESSION, path: '/work/repo' } }])
  })

  it('crawls a branch name the row clips while the pointer rests on the row', () => {
    const b = row(ready(), '/work')
    const element = b.element() as HTMLElement
    // The name's text sits in the span that travels; its parent clips it.
    const name = within(element).getByText('main').parentElement as HTMLElement
    Object.defineProperty(name, 'scrollWidth', { value: 240, configurable: true })
    Object.defineProperty(name, 'clientWidth', { value: 120, configurable: true })
    fireEvent.pointerEnter(element)
    expect([name.hasAttribute('data-marquee'), name.style.getPropertyValue('--dsh-marquee-range')]).toEqual([true, '120px'])
    fireEvent.pointerLeave(element)
    expect([name.hasAttribute('data-marquee'), name.style.getPropertyValue('--dsh-marquee-range')]).toEqual([false, ''])
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
    // A removed worktree has no directory to act on, so the row has no menu part.
    expect(rowParts(element)).toBe('body(icon content) trailing')
    expect(within(element).getByText('dsh/0a1b2c3d')).toBeTruthy()
    expect(within(element).getByText(en['missing.title'])).toBeTruthy()
    expect(b.renderFactorySlot).not.toHaveBeenCalledWith('contextMenu.button', expect.anything())
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

describe('ConnectionRow', () => {
  function row(state: ForgePanelState | null, disconnected: boolean) {
    const panel = panelStore(state, disconnected)
    const reconnect = vi.fn<() => void>()
    const props = { sessionId: SESSION, usePanel: bindSnapshotSelector(panel), reconnect, t } as
      Pick<ConnectionRowProps, 'sessionId' | 'usePanel' | 'reconnect' | 't'> as ConnectionRowProps
    return { view: render(<ConnectionRow {...props} />), panel, reconnect }
  }

  it('renders nothing while the stream is open', () => {
    expect(row(ready(), false).view.container.innerHTML).toBe('')
  })

  it.each([
    ['after a state arrived', ready()],
    ['before any state arrived', null],
  ])('says the details may be out of date and reconnects once the stream ended %s', (_label, state) => {
    const b = row(state, true)
    const status = b.view.getByRole('status')
    expect(status.hasAttribute('data-forge-connection')).toBe(true)
    expect(rowParts(status)).toBe('body(icon lines(content detail)) trailing')
    expect(status.querySelector('[data-row-part="detail"]')?.textContent).toBe(en['connection.detail'])
    expect(within(status).getByText(en['connection.title'])).toBeTruthy()
    expect(within(status).getByText(en['connection.detail'])).toBeTruthy()
    fireEvent.click(within(status).getByRole('button', { name: en.retry }))
    expect(b.reconnect).toHaveBeenCalledOnce()
    act(() => { b.panel.set({ state: ready(), disconnected: false }) })
    expect(b.view.queryByRole('status')).toBeNull()
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
    } as Pick<LocalChangesRowProps,
      'sessionId' | 'usePanel' | 'dismissOverlay' | 'viewLocalChanges' | 'createChangeRequest' | 't'> as LocalChangesRowProps
    const view = render(<LocalChangesRow {...props} />)
    return { view, viewLocalChanges, createChangeRequest, dismissOverlay }
  }

  it.each([
    ['before the first state', null],
    ['while the first inspection runs', ready({ checkout: { state: 'pending' } })],
    ['outside a Git checkout', ready({ checkout: { state: 'none' } })],
  ])('renders nothing %s', (_label, state) => {
    expect(row(state).view.container.innerHTML).toBe('')
  })

  it('stays in a checkout whose branch scope changes nothing, showing an empty size', () => {
    const b = row(ready({ local: { base: 'origin/main', files: [] } }))
    const element = b.view.container.querySelector('[data-forge-local]') as HTMLElement
    expect(rowParts(element)).toBe('button:body(icon content) trailing menu')
    expect(element.querySelector('[data-row-part="content"]')?.textContent).toBe(en['changes.local.title'])
    expect(element.querySelector('[data-row-part="trailing"]')?.textContent).toBe('+0−0')
    fireEvent.click(within(element).getByRole('button', { name: 'Local changes · 0 files, 0 lines added, 0 lines deleted' }))
    expect(b.viewLocalChanges).toHaveBeenCalledOnce()
    expect(b.dismissOverlay).toHaveBeenCalledOnce()
  })

  it('stays without a size while the branch scope has no fork point, and still opens the view', () => {
    const b = row(ready())
    const element = b.view.container.querySelector('[data-forge-local]') as HTMLElement
    expect(rowParts(element)).toBe('button:body(icon content) menu')
    fireEvent.click(within(element).getByRole('button', { name: en['changes.local.title'] }))
    expect(b.viewLocalChanges).toHaveBeenCalledOnce()
  })

  it.each(Object.entries({ zh, en, ja, es, fr, de, ru, pt }))('names the row button with its visible text first in %s', (_locale, copy) => {
    const fill = (text: string): string => text.replace('{count}', '2').replace('{added}', '5').replace('{deleted}', '1')
    expect(fill(copy['changes.local.viewAria']).startsWith(fill(copy['changes.local.summary']))).toBe(true)
  })

  it('sums the branch changes, opens them, and asks the Agent for a change request', () => {
    const b = row(ready({ local }))
    const element = b.view.container.querySelector('[data-forge-local]') as HTMLElement
    // The body is the row's button; the diff size and the menu stay separate parts after it.
    expect(rowParts(element)).toBe('button:body(icon content) trailing menu')
    expect(within(element).getByText('Local changes · 2 files')).toBeTruthy()
    expect(within(element).getByText('+5')).toBeTruthy()
    fireEvent.click(within(element).getByRole('button', { name: 'Local changes · 2 files, 5 lines added, 1 lines deleted' }))
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
