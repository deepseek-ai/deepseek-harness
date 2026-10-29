// @vitest-environment jsdom
/** New Session worktree option: when it shows, why it is disabled, the optimistic checkbox, the base menu, and a running creation. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import menuCss from '@deepseek-ai/dsh-client-ui-primitives/src/Menu.module.css'
import { en, zh } from '../src/client/locales.ts'
import type { PanelSnapshot } from '../src/client/source.ts'
import { WorktreeToggle } from '../src/client/WorktreeToggle.tsx'
import type { ForgeBranches, ForgeCheckoutState, ForgePanelState, ForgePanelWorktree, ForgeWorktreeBlocker } from '../src/types.ts'
import { creation, failure, ready, worktree } from './client-fixtures.client.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const t = makeTranslate(en)
const BRANCHES: ForgeBranches = { current: 'main', branches: ['main', 'release', 'feat/x'] }

/** Panel state of a Session that can still start in a worktree. */
function editable(overrides: Partial<ForgePanelWorktree> = {}, checkout?: ForgeCheckoutState): ForgePanelState {
  const state = ready({ worktree: worktree({ editable: true, ...overrides }) })
  return checkout === undefined ? state : { ...state, checkout }
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

function option(state: ForgePanelState | null, translate = t) {
  const panel = createSnapshotStore<PanelSnapshot>({ state, disconnected: false })
  const request = vi.fn(async (_from: string | null) => true)
  const cancel = vi.fn(async () => true)
  const branches = vi.fn(async (): Promise<ForgeBranches | undefined> => BRANCHES)
  const view = render(
    <WorktreeToggle
      usePanel={bindSnapshotSelector(panel)}
      request={request}
      cancel={cancel}
      branches={branches}
      t={translate}
    />,
  )
  const checkbox = (): HTMLInputElement => {
    const input = view.getByRole('checkbox', { name: en['worktree.label'] })
    if (!(input instanceof HTMLInputElement)) throw new Error('no checkbox')
    return input
  }
  const base = (): HTMLButtonElement | null => {
    const button = view.container.querySelector('button[aria-haspopup="menu"]')
    return button instanceof HTMLButtonElement ? button : null
  }
  const publish = (next: ForgePanelState): void => {
    act(() => { panel.set({ state: next, disconnected: false }) })
  }
  return { view, panel, request, cancel, branches, checkbox, base, publish }
}

/** Open the base branch menu and wait for its branches. */
async function openMenu(b: ReturnType<typeof option>): Promise<HTMLElement> {
  await act(async () => { fireEvent.click(b.base()!) })
  return screen.getByRole('menu')
}

/** The tooltip of the option after the pointer rests on it. */
function hint(b: ReturnType<typeof option>): string | null {
  vi.useFakeTimers()
  const label = b.checkbox().closest('label')
  if (label === null) throw new Error('no option label')
  fireEvent.pointerEnter(label)
  act(() => { vi.advanceTimersByTime(500) })
  return screen.getByRole('tooltip').textContent
}

describe('WorktreeToggle visibility', () => {
  it.each([
    ['before the first state', null],
    ['once the Session can no longer change its worktree', ready()],
    ['while the first inspection runs', editable({}, { state: 'pending' })],
    ['when the inspection failed', editable({}, { state: 'failed', message: 'git status failed' })],
    ['outside a Git checkout', editable({ blocker: 'not-git' }, { state: 'none' })],
  ])('renders nothing %s', (_label, state) => {
    expect(option(state).view.container.innerHTML).toBe('')
  })

  it('appears and disappears with the editable state', () => {
    const b = option(ready())
    b.publish(editable())
    expect(b.checkbox().checked).toBe(false)
    b.publish(ready({ worktree: worktree({ editable: false, request: { from: 'main' } }) }))
    expect(b.view.container.innerHTML).toBe('')
  })
})

describe('WorktreeToggle checkbox', () => {
  it.each<[ForgeWorktreeBlocker, string]>([
    ['read-only', en['worktree.blocked.read-only']],
    ['outside-writable-root', en['worktree.blocked.outside-writable-root']],
  ])('disables the option of a Git checkout blocked as %s and says why', (blocker, reason) => {
    const b = option(editable({ blocker }))
    expect(b.checkbox().disabled).toBe(true)
    expect(b.checkbox().checked).toBe(false)
    expect(b.checkbox().closest('label')?.hasAttribute('data-disabled')).toBe(true)
    expect(b.base()).toBeNull()
    expect(hint(b)).toBe(reason)
  })

  it.each(['read-only', 'outside-writable-root'] as const)('keeps the selected base visible after %s blocks a request until it is withdrawn', async (blocker) => {
    const b = option(editable({ request: { from: 'release' } }))
    b.publish(editable({ blocker, request: { from: 'release' } }))
    expect(b.checkbox().checked).toBe(true)
    expect(b.checkbox().disabled).toBe(false)
    expect(b.checkbox().closest('label')?.hasAttribute('data-disabled')).toBe(false)
    expect(b.base()).toBeNull()
    expect(b.view.getByRole('button', { name: 'From release' }).textContent).toBe('From release')
    expect(hint(b)).toBe(en[`worktree.blocked.${blocker}`])
    vi.useRealTimers()
    await act(async () => { fireEvent.click(b.checkbox()) })
    expect(b.cancel).toHaveBeenCalledOnce()
    expect(b.request).not.toHaveBeenCalled()
    b.publish(editable({ blocker }))
    expect(b.checkbox().checked).toBe(false)
    expect(b.checkbox().disabled).toBe(true)
    expect(b.view.getByRole('button', { name: 'Current branch: main' })).toBeTruthy()
  })

  it('preserves a HEAD base while blocked and restores the selected branch menu when permission returns', () => {
    const b = option(editable({ blocker: 'read-only', request: { from: null } }))
    expect(b.view.getByRole('button', { name: en['worktree.baseHead'] })).toBeTruthy()
    b.publish(editable({ blocker: 'read-only', request: { from: 'release' } }))
    b.publish(editable({ request: { from: 'release' } }))
    expect(b.base()?.textContent).toBe('From release')
    expect(b.checkbox().checked).toBe(true)
  })

  it.each([
    ['en', en, 'Current branch: main', 'Not on a branch · 0a1b2c3'],
    ['zh', zh, '当前分支：main', '未在分支上 · 0a1b2c3'],
  ] as const)('names the branch and detached checkout in an informational tooltip (%s)', (_locale, copy, branchLabel, detachedLabel) => {
    const b = option(editable(), makeTranslate(copy))
    const chip = b.view.getByRole('button', { name: branchLabel })
    fireEvent.click(chip)
    expect(screen.getByRole('tooltip').textContent).toBe(branchLabel)
    expect(chip.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id)
    fireEvent.click(chip)
    expect(screen.queryByRole('tooltip')).toBeNull()
    b.publish(ready({ worktree: worktree({ editable: true }) }, { branch: null }))
    const detached = b.view.getByRole('button', { name: detachedLabel })
    fireEvent.click(detached)
    expect(screen.getByRole('tooltip').textContent).toBe(detachedLabel)
    fireEvent.click(detached)
    b.publish(ready({ worktree: worktree({ editable: true }) }, { branch: null, commit: null }))
    expect(b.view.getByRole('button', { name: copy['checkout.detached'] })).toBeTruthy()
    expect(b.request).not.toHaveBeenCalled()
    expect(b.branches).not.toHaveBeenCalled()
  })

  it('offers the option again once the blocker clears', () => {
    const b = option(editable({ blocker: 'read-only' }))
    b.publish(editable())
    expect(b.checkbox().disabled).toBe(false)
    expect(b.checkbox().closest('label')?.hasAttribute('data-disabled')).toBe(false)
    expect(hint(b)).toBe(en['worktree.hint'])
  })

  it('shows the current branch without requesting a worktree inside a Git checkout', () => {
    const b = option(editable())
    expect(b.checkbox().disabled).toBe(false)
    expect(b.checkbox().checked).toBe(false)
    expect(b.checkbox().closest('label')?.hasAttribute('data-disabled')).toBe(false)
    expect(b.base()).toBeNull()
    expect(hint(b)).toBe(en['worktree.hint'])
    const current = b.view.getByText('main')
    fireEvent.click(current)
    expect(b.request).not.toHaveBeenCalled()
    expect(b.branches).not.toHaveBeenCalled()
  })

  it('requests a worktree from the current branch and holds the checked state until the Host answers', async () => {
    const b = option(editable())
    const answer = deferred<boolean>()
    b.request.mockReturnValueOnce(answer.promise)

    fireEvent.click(b.checkbox())
    expect(b.request).toHaveBeenCalledWith('main')
    expect(b.checkbox().checked).toBe(true)
    expect(b.checkbox().disabled).toBe(true)
    expect(b.base()?.textContent).toBe('From main')

    b.publish(editable({ request: { from: 'main' } }))
    await act(async () => { answer.resolve(true) })
    expect(b.checkbox().checked).toBe(true)
    expect(b.checkbox().disabled).toBe(false)
    expect(b.base()?.textContent).toBe('From main')
  })

  it('requests a worktree from HEAD on a detached checkout', async () => {
    const b = option(ready({ worktree: worktree({ editable: true }) }, { branch: null }))
    expect(b.view.getByText(`${en['checkout.detached']} · 0a1b2c3`)).toBeTruthy()
    await act(async () => { fireEvent.click(b.checkbox()) })
    expect(b.request).toHaveBeenCalledWith(null)
    b.publish(ready({ worktree: worktree({ editable: true, request: { from: null } }) }, { branch: null }))
    expect(b.base()?.textContent).toBe(en['worktree.baseHead'])
  })

  it('returns to the Host state when the Host refuses the request', async () => {
    const b = option(editable())
    b.request.mockResolvedValueOnce(false)
    await act(async () => { fireEvent.click(b.checkbox()) })
    expect(b.checkbox().checked).toBe(false)
    expect(b.checkbox().disabled).toBe(false)
    expect(b.base()).toBeNull()
  })

  it('withdraws an open request and shows the current branch until the Host answers', async () => {
    const b = option(editable({ request: { from: 'release' } }))
    expect(b.checkbox().checked).toBe(true)
    expect(b.base()?.textContent).toBe('From release')
    const answer = deferred<boolean>()
    b.cancel.mockReturnValueOnce(answer.promise)

    fireEvent.click(b.checkbox())
    expect(b.cancel).toHaveBeenCalledOnce()
    expect(b.request).not.toHaveBeenCalled()
    expect(b.checkbox().checked).toBe(false)
    expect(b.checkbox().disabled).toBe(true)
    expect(b.base()).toBeNull()

    b.publish(editable())
    await act(async () => { answer.resolve(true) })
    expect(b.checkbox().checked).toBe(false)
    expect(b.checkbox().disabled).toBe(false)
  })
})

describe('WorktreeToggle base branch menu', () => {
  it('names the current branch for a request from HEAD', () => {
    const b = option(editable({ request: { from: null } }))
    expect(b.base()?.textContent).toBe('From main')
  })

  it('sits before the checkbox and opens below its anchor, aligned to the anchor\'s right edge', async () => {
    const b = option(editable({ request: { from: 'main' } }))
    const anchor = b.base()
    if (anchor === null) throw new Error('no base branch anchor')
    expect(anchor.compareDocumentPosition(b.checkbox()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const wrapper = anchor.parentElement
    if (wrapper === null) throw new Error('no menu wrapper')
    vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 40, 120, 28))

    const menu = await openMenu(b)
    expect(menu.style.left).toBe('220px')
    expect(menu.style.top).toBe('72px')
  })

  it('lists the local branches, marks the current and the chosen one, and requests another base', async () => {
    const b = option(editable({ request: { from: 'main' } }))
    const answer = deferred<ForgeBranches | undefined>()
    b.branches.mockReturnValueOnce(answer.promise)
    fireEvent.click(b.base()!)
    expect(b.branches).toHaveBeenCalledOnce()
    expect(b.base()?.disabled).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()

    await act(async () => { answer.resolve(BRANCHES) })
    expect(b.base()?.disabled).toBe(false)
    expect(b.base()?.getAttribute('aria-expanded')).toBe('true')
    const menu = screen.getByRole('menu')
    expect(within(menu).getByText(en['worktree.baseMenu'])).toBeTruthy()
    const items = within(menu).getAllByRole('menuitem')
    expect(items.map(item => item.textContent)).toEqual([`main${en['worktree.currentBranch']}`, 'release', 'feat/x'])
    expect(items.map(item => item.matches(`.${menuCss.selected}`))).toEqual([true, false, false])

    fireEvent.click(items[1]!)
    expect(b.request).toHaveBeenCalledWith('release')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('closes without a request when the chosen base is selected again', async () => {
    const b = option(editable({ request: { from: 'release' } }))
    const menu = await openMenu(b)
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'release' }))
    expect(b.request).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('closes from its anchor and on Escape', async () => {
    const b = option(editable({ request: { from: 'main' } }))
    await openMenu(b)
    fireEvent.click(b.base()!)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(b.branches).toHaveBeenCalledOnce()

    await openMenu(b)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(b.request).not.toHaveBeenCalled()
  })

  it('stays closed when the branches cannot be read', async () => {
    const b = option(editable({ request: { from: 'main' } }))
    b.branches.mockResolvedValueOnce(undefined)
    await act(async () => { fireEvent.click(b.base()!) })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(b.base()?.disabled).toBe(false)
    expect(b.base()?.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('WorktreeToggle while the worktree is created', () => {
  it('freezes the checkbox and the base branch until the creation fails, which leaves both open to change', () => {
    const b = option(editable({ request: { from: 'main' }, creation: creation() }))
    expect(b.checkbox().checked).toBe(true)
    expect(b.checkbox().disabled).toBe(true)
    expect(b.checkbox().closest('label')?.hasAttribute('data-disabled')).toBe(true)
    expect(b.base()?.disabled).toBe(true)

    b.publish(editable({ request: { from: 'main' }, failure: failure() }))
    expect(b.checkbox().checked).toBe(true)
    expect(b.checkbox().disabled).toBe(false)
    expect(b.checkbox().closest('label')?.hasAttribute('data-disabled')).toBe(false)
    expect(b.base()?.disabled).toBe(false)
  })
})
