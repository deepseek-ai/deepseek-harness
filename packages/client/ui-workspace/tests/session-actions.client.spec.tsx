// @vitest-environment jsdom
/**
 * The shipped Session row actions rendered directly with hand-built props:
 * the pin, rename, fork, and archive menu rows, the archive and pin hover
 * buttons, and the two `shell.overlay` surfaces they raise (rename dialog,
 * row notice). Every action reads its own injected hooks and calls its own
 * injected callbacks; what those callbacks do is apply.client.spec's
 * subject. The browser and the slot machinery stay out; the assembled
 * chain lives in rename-assembly.client.spec.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { GlobalStandardProps, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type {
  MenuOpenState, RowToast, RowToastState, SessionArchiveConfirmInjected, SessionArchiveConfirmRequest,
  SessionRenameDialogInjected, SessionRenameTarget,
} from '../src/client/contract/slots.ts'
import {
  ArchiveSessionMenuItem, ArchiveSessionRowButton, SessionArchiveConfirmDialog,
} from '../src/client/session-actions/ArchiveSession.tsx'
import { ForkSessionMenuItem } from '../src/client/session-actions/ForkSession.tsx'
import { PinSessionMenuItem, PinSessionRowButton } from '../src/client/session-actions/PinSession.tsx'
import { RenameSessionMenuItem, SessionRenameDialog } from '../src/client/session-actions/RenameSession.tsx'
import { RowActionToast } from '../src/client/session-actions/RowActionToast.tsx'
import { createWorkspaceViewStore } from '../src/client/stores.ts'
import { en, zh } from '../src/client/locales.ts'
import { ShortcutRegistry } from '../../shortcuts/src/client/registry.ts'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'

afterEach(cleanup)

// The seat's key domain is workspace ∪ common; the stub mirrors the real
// lookup chain (namespace, then common vocabulary, then the key).
const t: PropsLocale<'workspace'>['t'] = makeTranslate(zh, commonZh)
const tEn: PropsLocale<'workspace'>['t'] = makeTranslate(en, commonEn)

const sid = (id: string) => id as SessionId
/** Selector hook over one fixed snapshot: how the renderer binds a standard or injected `hooks` source. */
function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}
/** The Set an injected membership hook selects from. */
const idSet = (...ids: string[]): ReadonlySet<SessionId> => new Set(ids.map(sid))

/** The row every action is rendered for: its owner share as the browser passes it. */
const ROW = { sessionId: sid('one'), displayTitle: 'Session title' }
const one: SessionSummary = {
  id: ROW.sessionId, displayTitle: ROW.displayTitle, running: false, blank: false, updatedAt: 1, retainedBy: {},
}
const sessions: SessionListState = {
  ids: [one.id], byId: { [one.id]: one }, phase: 'ready', projectionsBySession: {},
}
// The Workspace snapshot lists no pins or archives: an action's membership
// arrives through its injected Set hooks, never through this seat.
const workspaces: WorkspaceSnapshot = {
  items: [{
    workspaceId: 'alpha' as WorkspaceId, path: '/projects/alpha', title: 'alpha', sessionIds: [one.id],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }],
  archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
}
const noStatus: SessionStatusSnapshot = new Map()
// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

/** The global standard seat every root-scope entry receives. */
const standard: GlobalStandardProps = {
  useSessions: hook(sessions),
  useSessionStatus: hook(noStatus),
  useSessionRetainInfo: () => undefined,
  usePanelInfo,
  useResource,
  useWorkspaces: hook(workspaces),
}

type MenuRowProps = PropsRuntime<'sidebar.workspaces.session.menu.item'> & PropsLocale<'workspace'>
type ActionRowProps = PropsRuntime<'sidebar.workspaces.session.row.action'> & PropsLocale<'workspace'>
type OverlayProps = PropsRuntime<'shell.overlay'> & PropsLocale<'workspace'>

/** Owner share, standard seat, locale seat, and the bound open-state hook of one menu row. */
function menuRow(menu: MenuOpenState): MenuRowProps {
  return { ...ROW, useMenuOpenState: () => menu, useShortcuts: hook([]), t, ...standard }
}

/** Owner share, standard seat, and locale seat of one hover button. */
const actionRow: ActionRowProps = { ...ROW, t, ...standard }

/** Standard and locale seats of a `shell.overlay` entry (no owner share). */
const overlay: OverlayProps = { t, ...standard }

/** An open menu whose setter records the entries' dismissal. */
function openMenu() {
  const setMenuOpen = vi.fn()
  const state: MenuOpenState = [true, setMenuOpen]
  return { state, setMenuOpen }
}

/** Position of a mock's `nth` call in the global call sequence (a call that never happened sorts last). */
function callOrder(fn: { mock: { invocationCallOrder: readonly number[] } }, nth = 0): number {
  return fn.mock.invocationCallOrder[nth] ?? Number.POSITIVE_INFINITY
}

describe('pin action', () => {
  /** The pin share over fixed membership: the bound Set hooks and the two callbacks the entries call. */
  const pinShare = (pinned: readonly string[] = [], archived: readonly string[] = []) => ({
    usePinned: hook(idSet(...pinned)),
    useArchived: hook(idSet(...archived)),
    pinSession: vi.fn(),
    unpinSession: vi.fn(),
  })

  it('menu row closes the menu, then pins an unpinned Session', () => {
    const { state, setMenuOpen } = openMenu()
    const pin = pinShare()
    render(<PinSessionMenuItem {...menuRow(state)} {...pin} />)
    fireEvent.click(screen.getByRole('menuitem', { name: '置顶会话' }))
    expect(pin.pinSession).toHaveBeenCalledWith(sid('one'))
    expect(pin.unpinSession).not.toHaveBeenCalled()
    expect(setMenuOpen).toHaveBeenCalledWith(false)
    expect(callOrder(setMenuOpen)).toBeLessThan(callOrder(pin.pinSession))
  })

  it('menu row closes the menu, then unpins a pinned Session', () => {
    const { state, setMenuOpen } = openMenu()
    const pin = pinShare(['one'])
    render(<PinSessionMenuItem {...menuRow(state)} {...pin} />)
    fireEvent.click(screen.getByRole('menuitem', { name: '取消置顶' }))
    expect(pin.unpinSession).toHaveBeenCalledWith(sid('one'))
    expect(pin.pinSession).not.toHaveBeenCalled()
    expect(setMenuOpen).toHaveBeenCalledWith(false)
    expect(callOrder(setMenuOpen)).toBeLessThan(callOrder(pin.unpinSession))
  })

  it('row button toggles the pin', () => {
    const pin = pinShare()
    const view = render(<PinSessionRowButton {...actionRow} {...pin} />)
    fireEvent.click(screen.getByRole('button', { name: '置顶会话' }))
    expect(pin.pinSession).toHaveBeenCalledWith(sid('one'))
    expect(pin.unpinSession).not.toHaveBeenCalled()

    view.rerender(<PinSessionRowButton {...actionRow} {...pin} usePinned={hook(idSet('one'))} />)
    fireEvent.click(screen.getByRole('button', { name: '取消置顶' }))
    expect(pin.unpinSession).toHaveBeenCalledWith(sid('one'))
    expect(pin.pinSession).toHaveBeenCalledOnce()
  })

  it('offers nothing on an archived Session', () => {
    const { state } = openMenu()
    const pin = pinShare(['one'], ['one'])
    const menu = render(<PinSessionMenuItem {...menuRow(state)} {...pin} />)
    expect(menu.container.childElementCount).toBe(0)
    const button = render(<PinSessionRowButton {...actionRow} {...pin} />)
    expect(button.container.childElementCount).toBe(0)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('archive action', () => {
  /** The archive share over fixed membership: the bound Set hook and the two callbacks the entries call. */
  const archiveShare = (archived: readonly string[] = []) => ({
    useArchived: hook(idSet(...archived)),
    archiveSession: vi.fn(),
    unarchiveSession: vi.fn(),
  })

  it('menu row closes the menu, then archives', () => {
    const { state, setMenuOpen } = openMenu()
    const archive = archiveShare()
    render(<ArchiveSessionMenuItem {...menuRow(state)} {...archive} />)
    const row = screen.getByRole('menuitem', { name: '归档会话' })
    // Archive is not destructive (log and accounting slot remain): no danger styling.
    expect(row.className).not.toMatch(/danger/)
    fireEvent.click(row)
    expect(archive.archiveSession).toHaveBeenCalledWith(sid('one'))
    expect(archive.unarchiveSession).not.toHaveBeenCalled()
    expect(setMenuOpen).toHaveBeenCalledWith(false)
    expect(callOrder(setMenuOpen)).toBeLessThan(callOrder(archive.archiveSession))
  })

  it('menu row closes the menu, then restores an archived Session', () => {
    const { state, setMenuOpen } = openMenu()
    const archive = archiveShare(['one'])
    render(<ArchiveSessionMenuItem {...menuRow(state)} {...archive} />)
    fireEvent.click(screen.getByRole('menuitem', { name: '取消归档' }))
    expect(archive.unarchiveSession).toHaveBeenCalledWith(sid('one'))
    expect(archive.archiveSession).not.toHaveBeenCalled()
    expect(setMenuOpen).toHaveBeenCalledWith(false)
    expect(callOrder(setMenuOpen)).toBeLessThan(callOrder(archive.unarchiveSession))
  })

  it('row button archives and restores', () => {
    const archive = archiveShare()
    const view = render(<ArchiveSessionRowButton {...actionRow} {...archive} />)
    fireEvent.click(screen.getByRole('button', { name: '归档会话' }))
    expect(archive.archiveSession).toHaveBeenCalledWith(sid('one'))
    view.rerender(<ArchiveSessionRowButton {...actionRow} {...archive} useArchived={hook(idSet('one'))} />)
    fireEvent.click(screen.getByRole('button', { name: '取消归档' }))
    expect(archive.unarchiveSession).toHaveBeenCalledWith(sid('one'))
    expect(archive.archiveSession).toHaveBeenCalledOnce()
  })
})

describe('fork and rename rows', () => {
  it('fork closes the menu, then forks the Session', () => {
    const { state, setMenuOpen } = openMenu()
    const forkSession = vi.fn()
    render(<ForkSessionMenuItem {...menuRow(state)} forkSession={forkSession} />)
    fireEvent.click(screen.getByRole('menuitem', { name: '分叉会话' }))
    expect(forkSession).toHaveBeenCalledWith(sid('one'))
    expect(setMenuOpen).toHaveBeenCalledWith(false)
    expect(callOrder(setMenuOpen)).toBeLessThan(callOrder(forkSession))
  })

  it('rename closes the menu, then asks for the dialog with the row title', () => {
    const { state, setMenuOpen } = openMenu()
    const requestSessionRename = vi.fn()
    render(<RenameSessionMenuItem {...menuRow(state)} requestSessionRename={requestSessionRename} />)
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    expect(requestSessionRename).toHaveBeenCalledWith(sid('one'), 'Session title')
    expect(setMenuOpen).toHaveBeenCalledWith(false)
    expect(callOrder(setMenuOpen)).toBeLessThan(callOrder(requestSessionRename))
  })
})

describe('SessionRenameDialog', () => {
  /** The dialog over a test-owned request source; settling clears the request the way apply does. */
  function renameDialog(renameSession: SessionRenameDialogInjected['renameSession']) {
    const request = createSnapshotStore<SessionRenameTarget | null>(null)
    const settleSessionRename = vi.fn(() => { request.set(null) })
    render(
      <SessionRenameDialog
        {...overlay}
        useRenameRequest={bindSnapshotSelector(request)}
        settleSessionRename={settleSessionRename}
        renameSession={renameSession}
      />,
    )
    const ask = (sessionId: string, currentTitle: string): void => {
      act(() => { request.set({ sessionId: sid(sessionId), currentTitle }) })
    }
    return { settleSessionRename, ask }
  }

  it('renders nothing until a rename is requested', () => {
    renameDialog(vi.fn(async () => {}))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.textContent).toBe('')
  })

  it('restores composer focus and selection after cancelling and accepting a rename', async () => {
    const renameSession = vi.fn(async () => {})
    const { ask } = renameDialog(renameSession)
    render(<textarea aria-label="Composer" defaultValue="Keep this draft" />)
    const composer = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Composer' })
    composer.focus()
    composer.setSelectionRange(5, 9)

    ask('one', 'Session title')
    const firstInput = screen.getByLabelText<HTMLInputElement>('会话名称')
    expect(document.activeElement).toBe(firstInput)
    expect([firstInput.selectionStart, firstInput.selectionEnd]).toEqual([0, 'Session title'.length])
    fireEvent.keyDown(firstInput, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(composer)
    expect([composer.selectionStart, composer.selectionEnd]).toEqual([5, 9])
    expect(renameSession).not.toHaveBeenCalled()

    ask('one', 'Session title')
    const secondInput = screen.getByLabelText<HTMLInputElement>('会话名称')
    expect(document.activeElement).toBe(secondInput)
    fireEvent.change(secondInput, { target: { value: 'Renamed session' } })
    await act(async () => { fireEvent.keyDown(secondInput, { key: 'Enter' }) })
    expect(renameSession).toHaveBeenCalledWith(sid('one'), 'Renamed session')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(composer)
    expect(composer.value).toBe('Keep this draft')
    expect([composer.selectionStart, composer.selectionEnd]).toEqual([5, 9])
  })

  it('seeds the draft from the request, renames with the trimmed title, and settles on acceptance', async () => {
    const pending = Promise.withResolvers<undefined>()
    const renameSession = vi.fn(() => pending.promise)
    const { settleSessionRename, ask } = renameDialog(renameSession)
    ask('one', '旧标题')
    expect(screen.getByRole('dialog', { name: '重命名会话' })).toBeTruthy()
    const input = screen.getByLabelText<HTMLInputElement>('会话名称')
    expect(input.value).toBe('旧标题')
    // Confirming the current title is allowed (that gesture pins an automatic
    // title); a blank draft is not, by button or by Enter.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重命名' }).disabled).toBe(false)
    fireEvent.change(input, { target: { value: '   ' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重命名' }).disabled).toBe(true)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameSession).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '  新标题  ' } })
    fireEvent.click(screen.getByRole('button', { name: '重命名' }))
    expect(renameSession).toHaveBeenCalledWith(sid('one'), '新标题')
    // While the Host call is pending the input locks and closing is blocked.
    expect(input.disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(settleSessionRename).not.toHaveBeenCalled()
    await act(async () => { pending.resolve(undefined) })
    expect(settleSessionRename).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Enter confirms only outside an IME composition', () => {
    const renameSession = vi.fn(async () => {})
    const { ask } = renameDialog(renameSession)
    ask('one', 'Old')
    const input = screen.getByLabelText<HTMLInputElement>('会话名称')
    fireEvent.change(input, { target: { value: 'New' } })
    // Enter that commits a composition must not submit.
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameSession).not.toHaveBeenCalled()
    fireEvent.compositionEnd(input)
    fireEvent.keyDown(input, { key: 'a' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameSession).toHaveBeenCalledWith(sid('one'), 'New')
  })

  it('keeps the dialog open with the rejection surfaced, clears it on edit, and reports a non-Error reason as text', async () => {
    const renameSession = vi.fn<SessionRenameDialogInjected['renameSession']>()
      .mockRejectedValueOnce(new Error('title write failed'))
      .mockRejectedValueOnce('denied')
    const { settleSessionRename, ask } = renameDialog(renameSession)
    ask('one', 'Old')
    const input = screen.getByLabelText<HTMLInputElement>('会话名称')
    fireEvent.change(input, { target: { value: 'New' } })
    fireEvent.click(screen.getByRole('button', { name: '重命名' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('title write failed') })
    expect(input.disabled).toBe(false)
    expect(settleSessionRename).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'Newer' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重命名' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('denied') })
    expect(screen.getByRole('dialog', { name: '重命名会话' })).toBeTruthy()
  })

  it('Cancel, Escape, and Close settle without renaming; a request for another Session starts a fresh draft', () => {
    const renameSession = vi.fn(async () => {})
    const { settleSessionRename, ask } = renameDialog(renameSession)
    ask('one', 'Old')
    fireEvent.change(screen.getByLabelText('会话名称'), { target: { value: 'Draft' } })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(settleSessionRename).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
    ask('one', 'Old')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(settleSessionRename).toHaveBeenCalledTimes(2)
    ask('one', 'Old')
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(settleSessionRename).toHaveBeenCalledTimes(3)
    expect(renameSession).not.toHaveBeenCalled()

    ask('one', 'First')
    fireEvent.change(screen.getByLabelText('会话名称'), { target: { value: 'Edited' } })
    ask('two', 'Second')
    expect(screen.getByLabelText<HTMLInputElement>('会话名称').value).toBe('Second')
  })
})

describe('SessionArchiveConfirmDialog', () => {
  /** The dialog over a test-owned request source; settling clears the request the way apply does. */
  function archiveDialog(stopAndArchiveSession: SessionArchiveConfirmInjected['stopAndArchiveSession'], translate = t) {
    const request = createSnapshotStore<SessionArchiveConfirmRequest | null>(null)
    const settleSessionArchive = vi.fn(() => { request.set(null) })
    render(
      <SessionArchiveConfirmDialog
        {...overlay}
        t={translate}
        useArchiveRequest={bindSnapshotSelector(request)}
        settleSessionArchive={settleSessionArchive}
        stopAndArchiveSession={stopAndArchiveSession}
      />,
    )
    const ask = (activity: SessionArchiveConfirmRequest['activity']): void => {
      act(() => { request.set({ sessionId: sid('one'), displayTitle: 'Busy session', activity }) })
    }
    return { settleSessionArchive, ask }
  }

  it('renders nothing until a confirmation is requested', () => {
    archiveDialog(vi.fn(async () => {}))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('names the session and lists every reported family with its items, then stops and archives on confirm', async () => {
    const pending = Promise.withResolvers<undefined>()
    const stopAndArchiveSession = vi.fn(() => pending.promise)
    const { settleSessionArchive, ask } = archiveDialog(stopAndArchiveSession)
    ask([
      { kind: 'turn' },
      { kind: 'subagent', items: [{ id: 'child-1', label: 'reviewer' }, { id: 'child-2' }] },
      { kind: 'job', items: [{ id: 'bash-1', label: 'pnpm run build' }] },
      { kind: 'schedule', items: [{ id: 'schedule-1', label: 'check the build' }] },
    ])
    const dialog = screen.getByRole('dialog', { name: '停止并归档此会话？' })
    expect(dialog.textContent).toContain('“Busy session”仍有正在进行的工作')
    const lines = [...screen.getByRole('list', { name: '将被停止的工作' }).querySelectorAll('li')].map(li => li.textContent)
    expect(lines).toEqual([
      '进行中的回合',
      '2 个运行中的子智能体：reviewer、child-2',
      '1 个后台任务：pnpm run build',
      '1 条定时提醒：check the build',
    ])
    fireEvent.click(screen.getByRole('button', { name: '停止并归档' }))
    expect(stopAndArchiveSession).toHaveBeenCalledWith(sid('one'))
    // While the Host call is pending, closing is blocked and the status shows.
    expect(screen.getByRole('status').textContent).toBe('正在停止并归档…')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(settleSessionArchive).not.toHaveBeenCalled()
    await act(async () => { pending.resolve(undefined) })
    expect(settleSessionArchive).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps the dialog open with a rejection surfaced, and Cancel settles without archiving', async () => {
    const stopAndArchiveSession = vi.fn<SessionArchiveConfirmInjected['stopAndArchiveSession']>()
      .mockRejectedValueOnce(new Error('stop exploded'))
    const { settleSessionArchive, ask } = archiveDialog(stopAndArchiveSession)
    ask([{ kind: 'turn' }])
    fireEvent.click(screen.getByRole('button', { name: '停止并归档' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('stop exploded') })
    expect(settleSessionArchive).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(settleSessionArchive).toHaveBeenCalledOnce()
    expect(stopAndArchiveSession).toHaveBeenCalledOnce()
  })

  it('ignores Escape while the Host call is pending and reports a non-Error reason as text', async () => {
    const pending = Promise.withResolvers<undefined>()
    const stopAndArchiveSession = vi.fn<SessionArchiveConfirmInjected['stopAndArchiveSession']>()
      .mockReturnValueOnce(pending.promise)
    const { settleSessionArchive, ask } = archiveDialog(stopAndArchiveSession)
    ask([{ kind: 'turn' }])
    fireEvent.click(screen.getByRole('button', { name: '停止并归档' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(settleSessionArchive).not.toHaveBeenCalled()
    await act(async () => { pending.reject('plain failure') })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('plain failure') })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(settleSessionArchive).toHaveBeenCalledOnce()
  })

  it('describes a family merged by another provider with the generic line', () => {
    const { ask } = archiveDialog(vi.fn(async () => {}))
    ask([{ kind: 'probe', items: [{ id: 'probe-1' }] }])
    const lines = [...screen.getByRole('list', { name: '将被停止的工作' }).querySelectorAll('li')].map(li => li.textContent)
    expect(lines).toEqual(['1 项其他工作（probe）'])
  })

  it('selects the singular or plural English line by item count', () => {
    const { ask } = archiveDialog(vi.fn(async () => {}), tEn)
    ask([
      { kind: 'subagent', items: [{ id: 'child-1', label: 'reviewer' }] },
      { kind: 'job', items: [{ id: 'bash-1' }, { id: 'bash-2' }] },
      { kind: 'schedule', items: [{ id: 'schedule-1', label: 'check the build' }, { id: 'schedule-2', label: 'stand-up' }] },
      { kind: 'probe', items: [{ id: 'probe-1' }] },
    ])
    const lines = [...screen.getByRole('list', { name: 'Work that will be stopped' }).querySelectorAll('li')].map(li => li.textContent)
    expect(lines).toEqual([
      '1 running subagent: reviewer',
      '2 background jobs: bash-1, bash-2',
      '2 scheduled reminders: check the build, stand-up',
      '1 other item of work (probe)',
    ])
  })
})

// A provider outside this package may merge its own family into the kind map;
// the dialog must describe it without knowing its copy.
declare module '@deepseek-ai/dsh-workspace/types' {
  interface SessionActivityKindMap {
    probe: true
  }
}

describe('RowActionToast', () => {
  /** The notice surface over a test-owned notice source; dismissal clears the notice the way apply does. */
  function toastSurface(viewState: { archivedFilter?: 'default' | 'show' | 'only' } = { archivedFilter: 'default' }) {
    const toast = createSnapshotStore<RowToastState | null>(null)
    const instance = createWorkspaceViewStore().create()
    // A v5 snapshot hydrates without the filter key; mirror it by dropping the
    // fresh store's default rather than writing an explicit undefined.
    const state = { ...instance.store.getSnapshot() }
    if (viewState.archivedFilter === undefined) delete state.archivedFilter
    else state.archivedFilter = viewState.archivedFilter
    const view = createSnapshotStore(state)
    const dismissToast = vi.fn(() => { toast.set(null) })
    const undoArchive = vi.fn()
    const showArchived = vi.fn()
    render(
      <RowActionToast
        {...overlay}
        useToast={bindSnapshotSelector(toast)}
        useStore={bindSnapshotSelector(view)}
        actions={instance.actions}
        dismissToast={dismissToast}
        undoArchive={undoArchive}
        showArchived={showArchived}
      />,
    )
    let seq = 0
    const notify = (notice: RowToast): void => {
      act(() => { toast.set({ ...notice, seq: ++seq }) })
    }
    return { dismissToast, undoArchive, showArchived, notify }
  }

  it('renders nothing without a notice', () => {
    toastSurface()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.body.textContent).toBe('')
  })

  it('the stopped-and-archived notice offers the same undo and filter actions under its own wording', () => {
    const { undoArchive, notify } = toastSurface()
    notify({ kind: 'stoppedAndArchived', sessionId: sid('one') })
    expect(screen.getByRole('alert').textContent).toBe('已停止并归档，可撤销或筛选已归档会话')
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(undoArchive).toHaveBeenCalledWith(sid('one'))
  })

  it('the archived notice takes itself down, then undoes the archive or shows the archived rows', () => {
    const { dismissToast, undoArchive, showArchived, notify } = toastSurface()
    notify({ kind: 'archived', sessionId: sid('one') })
    expect(screen.getByRole('alert').textContent).toBe('会话已归档，可撤销或筛选已归档会话')
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(dismissToast).toHaveBeenCalledOnce()
    expect(undoArchive).toHaveBeenCalledWith(sid('one'))
    expect(callOrder(dismissToast)).toBeLessThan(callOrder(undoArchive))
    expect(showArchived).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()

    notify({ kind: 'archived', sessionId: sid('two') })
    fireEvent.click(screen.getByRole('button', { name: '筛选已归档会话' }))
    expect(dismissToast).toHaveBeenCalledTimes(2)
    expect(showArchived).toHaveBeenCalledOnce()
    expect(callOrder(dismissToast, 1)).toBeLessThan(callOrder(showArchived))
    expect(undoArchive).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('treats a view without a persisted filter as the hidden default and keeps the filter action', () => {
    const { notify } = toastSurface({})
    notify({ kind: 'archived', sessionId: sid('one') })
    expect(screen.getByRole('alert').textContent).toBe('会话已归档，可撤销或筛选已归档会话')
  })

  it.each(['show', 'only'] as const)('omits the filter action while the %s filter already shows archived rows', (archivedFilter) => {
    const { notify } = toastSurface({ archivedFilter })
    notify({ kind: 'archived', sessionId: sid('one') })
    expect(screen.getByRole('alert').textContent).toBe('会话已归档，可撤销')
    expect(screen.queryByRole('button', { name: '筛选已归档会话' })).toBeNull()
    expect(screen.getByRole('button', { name: '撤销' })).toBeTruthy()
  })

  it.each([
    ['pinFailed', '置顶失败，请稍后重试'],
    ['unpinFailed', '取消置顶失败，请稍后重试'],
    ['archivedNotOpenable', '已归档对话暂时无法查看，请取消归档后查看'],
    ['defaultWorkspaceFailed', '无法创建默认工作区，请通过“选择工作区”选择文件夹'],
  ] as const)('shows the %s warning and takes it down when its hold ends', (kind, text) => {
    vi.useFakeTimers()
    try {
      const { dismissToast, notify } = toastSurface()
      notify({ kind })
      const alert = screen.getByRole('alert')
      expect(alert.textContent).toBe(text)
      expect(alert.querySelector('button')).toBeNull()
      act(() => { vi.advanceTimersByTime(4000) })
      expect(dismissToast).toHaveBeenCalledOnce()
      expect(screen.queryByRole('alert')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows a refused creation with the Host reason and holds it as long as the archived notice', () => {
    vi.useFakeTimers()
    try {
      const { dismissToast, notify } = toastSurface()
      notify({ kind: 'createFailed', message: 'agent-preset/invalid: agent-presets: preset "broken" failed to mount' })
      const alert = screen.getByRole('alert')
      expect(alert.textContent).toBe('新建会话失败：agent-preset/invalid: agent-presets: preset "broken" failed to mount')
      expect(alert.querySelector('button')).toBeNull()
      act(() => { vi.advanceTimersByTime(4000) })
      expect(dismissToast).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(3000) })
      expect(dismissToast).toHaveBeenCalledOnce()
      expect(screen.queryByRole('alert')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the archived notice holds longer than a plain notice, and a repeat restarts its hold', () => {
    vi.useFakeTimers()
    try {
      const { dismissToast, notify } = toastSurface()
      notify({ kind: 'archived', sessionId: sid('one') })
      act(() => { vi.advanceTimersByTime(4000) })
      expect(screen.getByRole('alert')).toBeTruthy()
      notify({ kind: 'archived', sessionId: sid('two') })
      act(() => { vi.advanceTimersByTime(6999) })
      expect(dismissToast).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(1) })
      expect(dismissToast).toHaveBeenCalledOnce()
      expect(screen.queryByRole('alert')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

it('shows effective Session shortcuts while menu clicks keep the row target', () => {
  const shortcuts = new ShortcutRegistry('desktop', 'macos')
  for (const [action, code] of [['rename', 'KeyR'], ['fork', 'KeyF'], ['archive', 'KeyA']] as const) {
    shortcuts.register({ id: `session.${action}` as ShortcutCommandId, label: () => action, aliases: [],
      defaults: {
        'desktop:macos': { code, modifiers: ['primary', action === 'archive' ? 'shift' : 'alt'] },
        'desktop:windows': { code, modifiers: ['primary', action === 'archive' ? 'shift' : 'alt'] },
        'desktop:linux': { code, modifiers: ['primary', action === 'archive' ? 'shift' : 'alt'] },
      },
      regions: ['page'], modals: [], resolve: () => ({ status: 'pass' }) })
  }
  const requestSessionRename = vi.fn()
  const forkSession = vi.fn()
  const archiveSession = vi.fn()
  const props = { ...menuRow([true, vi.fn()]), useShortcuts: hook(shortcuts.catalog.getSnapshot()) }
  render(<>
    <RenameSessionMenuItem {...props} requestSessionRename={requestSessionRename} />
    <ForkSessionMenuItem {...props} forkSession={forkSession} />
    <ArchiveSessionMenuItem {...props} useArchived={hook(idSet())} archiveSession={archiveSession} unarchiveSession={vi.fn()} />
  </>)
  expect(screen.getAllByRole('menuitem').map(item => item.getAttribute('aria-keyshortcuts')))
    .toEqual(['Alt+Meta+R', 'Alt+Meta+F', 'Shift+Meta+A'])
  fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '分叉会话' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '归档会话' }))
  expect(requestSessionRename).toHaveBeenCalledWith(ROW.sessionId, ROW.displayTitle)
  expect(forkSession).toHaveBeenCalledWith(ROW.sessionId)
  expect(archiveSession).toHaveBeenCalledWith(ROW.sessionId)
})
