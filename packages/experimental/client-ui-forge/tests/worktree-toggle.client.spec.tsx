// @vitest-environment jsdom
/**
 * New Session worktree option: when it shows, why it is disabled, the optimistic checkbox, the searchable base menu
 * with remote groups, naming the branch, and a running creation.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { en, zh } from '../src/client/locales.ts'
import type { PanelSnapshot } from '../src/client/source.ts'
import type { WorktreeRequestResult } from '../src/client/WorktreeNameDialog.tsx'
import { WorktreeToggle, type WorktreeToggleInjected } from '../src/client/WorktreeToggle.tsx'
import type { ForgeCheckoutState, ForgePanelState, ForgePanelWorktree, ForgeWorktreeBases, ForgeWorktreeBlocker } from '../src/types.ts'
import { creation, failure, ready, worktree } from './client-fixtures.client.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const t = makeTranslate(en)
const BASES: ForgeWorktreeBases = {
  current: { ref: 'refs/heads/main', name: 'main' },
  defaults: [{ ref: 'refs/remotes/upstream/master', name: 'upstream/master', remote: 'upstream' }],
  local: [{ ref: 'refs/heads/release', name: 'release' }, { ref: 'refs/heads/feat/x', name: 'feat/x' }],
  remotes: [
    { name: 'upstream', repository: 'acme/demo', branches: [{ ref: 'refs/remotes/upstream/feat/y', name: 'upstream/feat/y' }] },
    { name: 'team/fork', repository: null, branches: [{ ref: 'refs/remotes/team/fork/idea', name: 'team/fork/idea' }] },
  ],
}

function ok(value: ForgeWorktreeBases): RemoteResult<ForgeWorktreeBases> {
  return { ok: true, value }
}

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

/** Let the listing reads the menu awaits settle, past the search delay when `ms` is given. */
async function settle(ms = 0): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
}

function option(state: ForgePanelState | null, translate = t) {
  const panel = createSnapshotStore<PanelSnapshot>({ state, disconnected: false })
  const request = vi.fn<WorktreeToggleInjected['request']>(async () => 'accepted')
  const cancel = vi.fn(async () => true)
  const bases = vi.fn<WorktreeToggleInjected['bases']>(async () => ok(BASES))
  const view = render(
    <WorktreeToggle
      usePanel={bindSnapshotSelector(panel)}
      request={request}
      cancel={cancel}
      bases={bases}
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
  const rows = (): string[] => screen.queryAllByRole('menuitem').map(row => row.textContent ?? '')
  const search = (): HTMLElement => screen.getByRole('textbox', { name: en['diff.base.search'] })
  return { view, panel, request, cancel, bases, checkbox, base, publish, rows, search }
}

/** Open the base menu and wait for its branches. */
async function openMenu(b: ReturnType<typeof option>): Promise<HTMLElement> {
  fireEvent.click(b.base()!)
  await settle()
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
    b.publish(ready({ worktree: worktree({ editable: false, request: { from: 'main', name: null } }) }))
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
    const b = option(editable({ request: { from: 'release', name: null } }))
    b.publish(editable({ blocker, request: { from: 'release', name: null } }))
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
    const b = option(editable({ blocker: 'read-only', request: { from: null, name: null } }))
    expect(b.view.getByRole('button', { name: en['worktree.baseHead'] })).toBeTruthy()
    b.publish(editable({ blocker: 'read-only', request: { from: 'release', name: null } }))
    b.publish(editable({ request: { from: 'release', name: null } }))
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
    expect(b.bases).not.toHaveBeenCalled()
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
    expect(b.bases).not.toHaveBeenCalled()
  })

  it('requests a worktree from the current branch and holds the checked state until the Host answers', async () => {
    const b = option(editable())
    const answer = deferred<WorktreeRequestResult>()
    b.request.mockReturnValueOnce(answer.promise)

    fireEvent.click(b.checkbox())
    expect(b.request).toHaveBeenCalledWith('refs/heads/main', null)
    expect(b.checkbox().checked).toBe(true)
    expect(b.checkbox().disabled).toBe(true)
    expect(b.base()?.textContent).toBe('From main')

    b.publish(editable({ request: { from: 'main', name: null } }))
    await act(async () => { answer.resolve('accepted') })
    expect(b.checkbox().checked).toBe(true)
    expect(b.checkbox().disabled).toBe(false)
    expect(b.base()?.textContent).toBe('From main')
  })

  it('requests a worktree from HEAD on a detached checkout', async () => {
    const b = option(ready({ worktree: worktree({ editable: true }) }, { branch: null }))
    expect(b.view.getByText(`${en['checkout.detached']} · 0a1b2c3`)).toBeTruthy()
    await act(async () => { fireEvent.click(b.checkbox()) })
    expect(b.request).toHaveBeenCalledWith(null, null)
    b.publish(ready({ worktree: worktree({ editable: true, request: { from: null, name: null } }) }, { branch: null }))
    expect(b.base()?.textContent).toBe(en['worktree.baseHead'])
  })

  it('returns to the Host state when the Host refuses the request', async () => {
    const b = option(editable())
    b.request.mockResolvedValueOnce('failed')
    await act(async () => { fireEvent.click(b.checkbox()) })
    expect(b.checkbox().checked).toBe(false)
    expect(b.checkbox().disabled).toBe(false)
    expect(b.base()).toBeNull()
  })

  it('withdraws an open request and shows the current branch until the Host answers', async () => {
    const b = option(editable({ request: { from: 'release', name: null } }))
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


describe('WorktreeToggle base menu', () => {
  it('names the current branch for a request from HEAD and the short name of a requested branch', () => {
    expect(option(editable({ request: { from: null, name: null } })).base()?.textContent).toBe('From the current HEAD')
    cleanup()
    expect(option(editable({ request: { from: 'refs/remotes/upstream/master', name: null } })).base()?.textContent).toBe('From upstream/master')
  })

  it('sits before the checkbox and opens below its anchor, aligned to the anchor\'s right edge', async () => {
    const b = option(editable({ request: { from: 'refs/heads/main', name: null } }))
    const anchor = b.base()
    if (anchor === null) throw new Error('no base branch anchor')
    expect(anchor.compareDocumentPosition(b.checkbox()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const menu = await openMenu(b)
    expect(anchor.getAttribute('aria-expanded')).toBe('true')
    expect(menu.dataset.anchorSide).toBe('bottom')
    expect(menu.dataset.anchorAlign).toBe('end')
  })

  it('pins the current branch and remote defaults, then lists local branches and each remote with its repository', async () => {
    const b = option(editable({ request: { from: 'main', name: null } }))
    fireEvent.click(b.base()!)
    expect(screen.getByRole('status').textContent).toBe(en['diff.base.loading'])
    await settle()
    expect(b.bases).toHaveBeenCalledWith('', expect.any(AbortSignal))
    expect(b.rows()).toEqual([
      `main${en['worktree.currentBranch']}`, `upstream/master${en['worktree.remoteDefault']}`, 'release', 'feat/x', 'upstream/feat/y',
      'team/fork/idea', `${en['worktree.name.add']}${en['worktree.name.auto']}`,
    ])
    expect(screen.getAllByRole('group').map(group => group.getAttribute('aria-label'))).toEqual([
      en['worktree.pinned'], en['diff.base.local'], 'Remote · upstream', 'Remote · team/fork',
    ])
    expect(screen.getByRole('group', { name: 'Remote · upstream' }).textContent).toContain('acme/demo')
    // The short name that earlier panels recorded for a local branch selects that branch.
    expect(screen.getByRole('menuitem', { name: /^main/ }).getAttribute('aria-current')).toBe('page')

    fireEvent.click(screen.getByRole('menuitem', { name: 'team/fork/idea' }))
    expect(b.request).toHaveBeenCalledWith('refs/remotes/team/fork/idea', null)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('closes without a request when the chosen base is chosen again, from its anchor, and on Escape', async () => {
    const b = option(editable({ request: { from: 'refs/heads/release', name: 'fix/x' } }))
    await openMenu(b)
    fireEvent.click(screen.getByRole('menuitem', { name: 'release' }))
    expect(screen.queryByRole('menu')).toBeNull()
    await openMenu(b)
    fireEvent.click(b.base()!)
    expect(screen.queryByRole('menu')).toBeNull()
    await openMenu(b)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(b.request).not.toHaveBeenCalled()
  })

  it('keeps the chosen name when the base changes', async () => {
    const b = option(editable({ request: { from: 'refs/heads/main', name: 'fix/x' } }))
    await openMenu(b)
    fireEvent.click(screen.getByRole('menuitem', { name: /^upstream\/master/ }))
    expect(b.request).toHaveBeenCalledWith('refs/remotes/upstream/master', 'fix/x')
  })

  it('filters the listed rows at once, reads the search after a pause, and chooses the first match with Enter', async () => {
    const b = option(editable({ request: { from: 'refs/heads/main', name: null } }))
    b.bases.mockImplementation(async query => ok(query === '' ? BASES : { ...BASES, current: null, defaults: [], local: [] }))
    await openMenu(b)
    fireEvent.change(b.search(), { target: { value: 'IDEA' } })
    expect(b.rows()).toEqual(['team/fork/idea', `${en['worktree.name.add']}${en['worktree.name.auto']}`])
    await settle(200)
    expect(b.bases).toHaveBeenLastCalledWith('IDEA', expect.any(AbortSignal))
    fireEvent.keyDown(b.search(), { key: 'Enter' })
    expect(b.request).toHaveBeenCalledWith('refs/remotes/team/fork/idea', null)
  })

  it('says when no branch matches, keeps Enter from choosing, and still offers to name the branch', async () => {
    const b = option(editable({ request: { from: 'refs/heads/main', name: null } }))
    await openMenu(b)
    fireEvent.change(b.search(), { target: { value: 'hotfix' } })
    expect(screen.getByText(en['diff.base.empty'])).toBeTruthy()
    fireEvent.keyDown(b.search(), { key: 'Enter' })
    expect(b.request).not.toHaveBeenCalled()
    expect(b.rows()).toEqual([`${en['worktree.name.add']}${en['worktree.name.auto']}`])
  })

  it('reports a failed listing with a retry', async () => {
    const b = option(editable({ request: { from: 'refs/heads/main', name: null } }))
    b.bases.mockResolvedValueOnce({ ok: false, error: new RemoteError('forgePanel/not-a-checkout', 'gone', {}) })
    await openMenu(b)
    const status = screen.getByRole('status')
    expect(status.textContent).toBe(`${en['toast.branchesFailed']}${en.retry}`)
    fireEvent.click(within(status).getByRole('button', { name: en.retry }))
    await settle()
    expect(b.bases).toHaveBeenCalledTimes(2)
    expect(b.rows()).toHaveLength(7)
  })

  it('stays fixed while the worktree is being created, and opens again once the attempt failed', () => {
    const b = option(editable({ request: { from: 'main', name: null }, creation: creation() }))
    expect(b.checkbox().disabled).toBe(true)
    expect(b.base()?.disabled).toBe(true)
    b.publish(editable({ request: { from: 'main', name: null }, failure: failure() }))
    expect(b.checkbox().disabled).toBe(false)
    expect(b.base()?.disabled).toBe(false)
  })
})

describe('WorktreeToggle branch name', () => {
  /** Open the naming dialog from the menu's last row. */
  async function nameDialog(b: ReturnType<typeof option>): Promise<HTMLElement> {
    await openMenu(b)
    fireEvent.click(screen.getByRole('menuitem', { name: /^(Name the new branch|New branch name)/ }))
    return screen.getByRole('dialog', { name: en['nameDialog.title'] })
  }

  it('starts the name from the prefix of generated names and requests the worktree on the typed name', async () => {
    const b = option(editable({ request: { from: 'refs/remotes/upstream/master', name: null }, namePrefix: 'agent/' }))
    const dialog = await nameDialog(b)
    const field = within(dialog).getByRole('textbox', { name: en['nameDialog.field'] })
    expect((field as HTMLInputElement).value).toBe('agent/')
    expect(within(dialog).getByText(en['nameDialog.prefixOnly'])).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: en['nameDialog.confirm'] }).hasAttribute('disabled')).toBe(true)
    expect(within(dialog).queryByRole('button', { name: en['nameDialog.auto'] })).toBeNull()

    fireEvent.change(field, { target: { value: 'agent/fix-login' } })
    expect(within(dialog).getByText(en['nameDialog.hint'].replace('{branch}', 'upstream/master'))).toBeTruthy()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: en['nameDialog.confirm'] })) })
    expect(b.request).toHaveBeenCalledWith('refs/remotes/upstream/master', 'agent/fix-login')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows a chosen name before its base and offers generated names again', async () => {
    const b = option(editable({ request: { from: 'refs/heads/main', name: 'fix/login' } }))
    const trigger = b.base()!
    expect(trigger.textContent).toBe('fix/login · From main')
    expect(trigger.getAttribute('aria-label')).toBe('New branch fix/login from main')
    const dialog = await nameDialog(b)
    expect(within(dialog).getByRole<HTMLInputElement>('textbox').value).toBe('fix/login')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: en['nameDialog.auto'] })) })
    expect(b.request).toHaveBeenCalledWith('refs/heads/main', null)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('names the current HEAD for a named request without a base', () => {
    const b = option(editable({ request: { from: null, name: 'fix/login' } }))
    expect(b.base()?.getAttribute('aria-label')).toBe('New branch fix/login from the current HEAD')
  })

  it('keeps the dialog open with the reason when the Host refuses the name, and closes it on Cancel', async () => {
    const b = option(editable({ request: { from: 'refs/heads/main', name: null } }))
    const dialog = await nameDialog(b)
    const field = within(dialog).getByRole('textbox')
    fireEvent.change(field, { target: { value: 'taken' } })
    b.request.mockResolvedValueOnce('branch-exists')
    await act(async () => { fireEvent.keyDown(field, { key: 'Enter' }) })
    expect(within(dialog).getByRole('alert').textContent).toBe('A branch named taken already exists')
    fireEvent.change(field, { target: { value: 'taken-2' } })
    expect(within(dialog).queryByRole('alert')).toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: en['nameDialog.cancel'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.request).toHaveBeenCalledTimes(1)
  })

  it('shows a chosen name in Chinese copy', () => {
    const b = option(editable({ request: { from: 'refs/heads/main', name: 'fix/login' } }), makeTranslate(zh))
    expect(b.base()?.textContent).toBe('fix/login · 基于 main')
  })
})
