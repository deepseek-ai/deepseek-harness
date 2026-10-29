// @vitest-environment jsdom
import { contextMenuHook, bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { GlobalStandardProps, SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContextMenuTarget } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionLogDownloadController } from '../src/client/controller.ts'
import { SessionMarkdownCopyController } from '../src/client/copy-controller.ts'
import { SessionLogDownloadHeaderAction } from '../src/client/HeaderAction.tsx'
import type { SessionLogDownloadHeaderProps } from '../src/client/HeaderAction.tsx'
import { en } from '../src/client/locales.ts'

const SID = 'session-export-header' as SessionId
const translate: SessionLogDownloadHeaderProps['t'] = makeTranslate(en)
const unused = (): never => { throw new Error('This isolated component does not consume framework hooks') }
const standard: GlobalStandardProps & SessionStandardProps = {
  sessionId: SID, useSession: unused, useProjection: unused, useAccess: () => true,
  useSessions: unused, useSessionStatus: unused, useSessionRetainInfo: unused,
  useSessionAccess: () => true, useRemoteAccess: () => true, useWorkspaceAccess: () => true,
  useConversation: unused, useInput: unused, useChat: unused, useTrajectory: unused,
  usePanelInfo: unused, useContextMenu: contextMenuHook(), useResource: unused, useWorkspaces: unused,
  inputActions: { insertQuote: () => false, captureInsertion: unused, insertText: unused, setDraft: unused, persistDraft: unused,
    addAttachments: unused, removeAttachment: unused, pruneAttachments: unused, submit: unused },
}

function bench() {
  const gate = Promise.withResolvers<Response>()
  const controller = new SessionLogDownloadController(() => gate.promise, vi.fn())
  const copyController = new SessionMarkdownCopyController(async () => new Response('markdown'))
  const active = createSnapshotStore<ContextMenuTarget | null>(null)
  const openMenu = vi.fn()
  const props: SessionLogDownloadHeaderProps = {
    ...standard,
    useSessionLogDownload: bindSnapshotSelector(controller.store),
    useSessionMarkdownCopy: bindSnapshotSelector(copyController.store),
    useHeaderMenu: bindSnapshotSelector(active),
    openMenu,
    request: sessionId => controller.download(sessionId),
    dismiss: (sessionId) => { controller.dismiss(sessionId) },
    t: translate,
  }
  const view = render(<SessionLogDownloadHeaderAction {...props} />)
  return { controller, copyController, active, openMenu, props, view, gate }
}

afterEach(cleanup)

describe('Session export Header trigger', () => {
  it('captures its Session and button anchor for the shared menu and restores a focusable trigger', () => {
    const b = bench()
    const button = b.view.getByRole('button', { name: 'More actions' })
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 50, 28, 28))
    fireEvent.click(button)
    expect(b.openMenu).toHaveBeenCalledExactlyOnceWith(SID, { x: 40, y: 78 })
    expect(document.activeElement).toBe(button)
    expect(button.getAttribute('aria-haspopup')).toBe('menu')
    expect(button.hasAttribute('data-context-menu-trigger')).toBe(true)
    expect(b.view.queryByRole('menu')).toBeNull()
  })

  it('derives expanded state from only the matching Header target and preserves the button across changes', () => {
    const b = bench()
    const button = b.view.getByRole('button', { name: 'More actions' })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    act(() => { b.active.set({ kind: 'sessionHeader', value: { sessionId: SID } }) })
    expect(button.getAttribute('aria-expanded')).toBe('true')
    act(() => { b.active.set({ kind: 'session', value: { sessionId: SID, displayTitle: 'Same Session' } }) })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    act(() => { b.active.set({ kind: 'sessionHeader', value: { sessionId: 'another' as SessionId } }) })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    b.view.rerender(<SessionLogDownloadHeaderAction {...b.props} sessionId={'another' as SessionId} />)
    expect(b.view.getByRole('button', { name: 'More actions' })).toBe(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    act(() => { b.active.set(null) })
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('retains the Session-scoped download dialog and busy state after the shared menu closes', async () => {
    const b = bench()
    const button = b.view.getByRole('button', { name: 'More actions' })
    let pending!: Promise<void>
    act(() => { pending = b.controller.download(SID) })
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(b.view.getByRole('dialog')).toBeTruthy()
    await act(async () => { b.gate.resolve(new Response('zip')); await pending })
    await waitFor(() => { expect(button.getAttribute('aria-busy')).toBe('false') })
    expect(b.view.getByRole('dialog', { name: 'Session download started' })).toBeTruthy()
    act(() => { b.controller.dismiss(SID) })
    expect(b.view.queryByRole('dialog')).toBeNull()
    act(() => { b.copyController.store.set({ ...b.copyController.store.getSnapshot(), copying: true }) })
    expect(button.getAttribute('aria-busy')).toBe('true')
    act(() => { b.copyController.store.set({ ...b.copyController.store.getSnapshot(), copying: false }) })
    expect(button.getAttribute('aria-busy')).toBe('false')
  })
})
