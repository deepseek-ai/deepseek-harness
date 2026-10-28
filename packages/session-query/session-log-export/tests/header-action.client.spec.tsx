// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { GlobalStandardProps, SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { SessionLogDownloadController } from '../src/client/controller.ts'
import { SessionMarkdownCopyController, type SessionMarkdownClipboard } from '../src/client/copy-controller.ts'
import { SessionLogDownloadHeaderAction } from '../src/client/HeaderAction.tsx'
import type { SessionLogDownloadHeaderProps } from '../src/client/HeaderAction.tsx'
import { en } from '../src/client/locales.ts'

const SID = 'session-export-header' as SessionId
const clipboard: SessionMarkdownClipboard = {
  supportsDeferredWrite: () => false,
  writeDeferred: async () => {},
  writeText: async () => true,
}
const dictionary: Record<string, string> = en
const translate: SessionLogDownloadHeaderProps['t'] = key => dictionary[key] ?? key
const unused = (): never => { throw new Error('This isolated component does not consume framework hooks') }
const standard: GlobalStandardProps & SessionStandardProps = {
  sessionId: SID, useSession: unused, useProjection: unused, useAccess: () => true,
  useSessions: unused, useSessionStatus: unused, useSessionRetainInfo: unused,
  useSessionAccess: () => true, useRemoteAccess: () => true, useWorkspaceAccess: () => true,
  useConversation: unused, useInput: unused, useChat: unused, useTrajectory: unused,
  usePanelInfo: unused, useResource: unused, useWorkspaces: unused,
  inputActions: { insertQuote: () => false, captureInsertion: unused, insertText: unused, setDraft: unused, persistDraft: unused,
    addAttachments: unused, removeAttachment: unused, pruneAttachments: unused, submit: unused },
}

function bindSnapshot<State>(store: ObservableSnapshot<State>) {
  return function useSnapshot<T>(selector: (state: State) => T): T {
    return useSyncExternalStore(
      listener => store.subscribe(listener),
      () => selector(store.getSnapshot()),
    )
  }
}

function bench(feedbackAvailable = false, copyController = new SessionMarkdownCopyController(
  async () => new Response('markdown'),
  clipboard,
)) {
  const controller = new SessionLogDownloadController(async () => new Response('zip'), vi.fn())
  const request = vi.fn((sessionId: SessionId) => controller.download(sessionId))
  const copyMarkdown = vi.fn((sessionId: SessionId) => copyController.copy(sessionId))
  const dismiss = vi.fn((sessionId: SessionId) => { controller.dismiss(sessionId) })
  const openFeedback = vi.fn()
  const feedback = createSnapshotStore(feedbackAvailable)
  const useSessionLogDownload = bindSnapshot(controller.store)
  const useSessionMarkdownCopy = bindSnapshot(copyController.store)
  const props: SessionLogDownloadHeaderProps = {
    ...standard,
    useSessionLogDownload,
    useSessionMarkdownCopy,
    useFeedbackAvailable: bindSnapshot(feedback),
    openFeedback,
    request,
    copyMarkdown,
    dismiss,
    t: translate,
  }
  const view = render(<SessionLogDownloadHeaderAction {...props} />)
  return { controller, copyController, request, copyMarkdown, openFeedback, feedback, view }
}

afterEach(cleanup)

describe('Session export Header action', () => {
  it('opens Session feedback and closes the menu without starting a download', () => {
    const b = bench(true)
    fireEvent.click(b.view.getByRole('button', { name: 'More actions' }))
    fireEvent.click(b.view.getByRole('menuitem', { name: 'Feedback' }))
    expect(b.openFeedback).toHaveBeenCalledWith(SID)
    expect(b.request).not.toHaveBeenCalled()
    expect(b.view.queryByRole('menu')).toBeNull()
  })

  it('keeps export available without the feedback plugin', () => {
    const b = bench()
    fireEvent.click(b.view.getByRole('button', { name: 'More actions' }))
    expect(b.view.queryByRole('menuitem', { name: 'Feedback' })).toBeNull()
    expect(b.view.getByRole('menuitem', { name: 'Copy Session as Markdown' })).toBeTruthy()
    expect(b.view.getByRole('menuitem', { name: 'Download session log' })).toBeTruthy()
  })

  it('updates the open menu when feedback becomes available, unloads, and reloads', () => {
    const b = bench()
    fireEvent.click(b.view.getByRole('button', { name: 'More actions' }))
    expect(b.view.queryByRole('menuitem', { name: 'Feedback' })).toBeNull()

    act(() => { b.feedback.set(true) })
    expect(b.view.getByRole('menuitem', { name: 'Feedback' })).toBeTruthy()
    act(() => { b.feedback.set(false) })
    expect(b.view.queryByRole('menuitem', { name: 'Feedback' })).toBeNull()
    expect(b.view.getByRole('menuitem', { name: 'Download session log' })).toBeTruthy()

    act(() => { b.feedback.set(true) })
    fireEvent.click(b.view.getByRole('menuitem', { name: 'Feedback' }))
    expect(b.openFeedback).toHaveBeenCalledWith(SID)
    expect(b.request).not.toHaveBeenCalled()
    expect(b.view.queryByRole('menu')).toBeNull()
  })

  it('copies Markdown from the menu and closes it without starting a download', async () => {
    const b = bench()
    fireEvent.click(b.view.getByRole('button', { name: 'More actions' }))
    expect(b.view.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Copy Session as Markdown',
      'Download session log',
    ])
    fireEvent.click(b.view.getByRole('menuitem', { name: 'Copy Session as Markdown' }))
    await waitFor(() => { expect(b.copyMarkdown).toHaveBeenCalledWith(SID) })
    expect(b.request).not.toHaveBeenCalled()
    expect(b.view.queryByRole('menu')).toBeNull()
    expect(b.copyController.store.getSnapshot().notice?.kind).toBe('success')
  })

  it('disables only the copy row while a copy is pending', async () => {
    const gate = Promise.withResolvers<Response>()
    const copyController = new SessionMarkdownCopyController(() => gate.promise, clipboard)
    const b = bench(true, copyController)
    const pending = copyController.copy(SID)
    expect(copyController.store.getSnapshot().copying).toBe(true)

    const button = b.view.getByRole('button', { name: 'More actions' })
    await waitFor(() => { expect(button.getAttribute('aria-expanded')).toBe('false') })
    fireEvent.click(button)
    const copyItem = b.view.getByRole('menuitem', { name: 'Copy Session as Markdown' })
    await waitFor(() => { expect((copyItem as HTMLButtonElement).disabled).toBe(true) })
    expect((b.view.getByRole('menuitem', { name: 'Download session log' }) as HTMLButtonElement).disabled).toBe(false)
    expect((b.view.getByRole('menuitem', { name: 'Feedback' }) as HTMLButtonElement).disabled).toBe(false)
    expect(button.getAttribute('aria-busy')).toBe('true')

    gate.resolve(new Response('markdown'))
    await pending
    expect(b.copyController.store.getSnapshot().copying).toBe(false)
    await waitFor(() => { expect((copyItem as HTMLButtonElement).disabled).toBe(false) })
    expect(button.getAttribute('aria-busy')).toBe('false')
  })

  it('opens the more-actions menu and downloads through the shared controller', async () => {
    const b = bench()
    const button = b.view.getByRole('button', { name: 'More actions' })
    expect(button.querySelector('svg')).not.toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(b.view.getByRole('menuitem', { name: 'Download session log' }))
    await waitFor(() => { expect(b.request).toHaveBeenCalledWith(SID) })
    expect(b.view.queryByRole('menuitem', { name: 'Download session log' })).toBeNull()
    expect(await b.view.findByRole('dialog', { name: 'Session download started' })).toBeTruthy()
  })

  it('closes the menu on Escape without downloading', () => {
    const b = bench()
    fireEvent.click(b.view.getByRole('button', { name: 'More actions' }))
    expect(b.view.getByRole('menuitem', { name: 'Download session log' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(b.view.queryByRole('menuitem', { name: 'Download session log' })).toBeNull()
    expect(b.request).not.toHaveBeenCalled()
  })

  it('disables the download row while either entry path downloads this Session', async () => {
    const b = bench(true)
    let release!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { release = resolve })
    const controller = new SessionLogDownloadController(() => pending, vi.fn())
    const useSessionLogDownload = bindSnapshot(controller.store)
    const rerendered: SessionLogDownloadHeaderProps = {
      ...standard,
      useSessionLogDownload,
      useSessionMarkdownCopy: bindSnapshot(b.copyController.store),
      useFeedbackAvailable: bindSnapshot(b.feedback),
      openFeedback: b.openFeedback,
      request: (sessionId: SessionId) => controller.download(sessionId),
      copyMarkdown: b.copyMarkdown,
      dismiss: (sessionId: SessionId) => { controller.dismiss(sessionId) },
      t: translate,
    }
    b.view.rerender(<SessionLogDownloadHeaderAction {...rerendered} />)

    const download = controller.download(SID)
    const button = b.view.getByRole('button', { name: 'More actions' })
    await waitFor(() => { expect(button.getAttribute('aria-busy')).toBe('true') })
    fireEvent.click(button)
    const item = b.view.getByRole('menuitem', { name: 'Download session log' })
    expect((item as HTMLButtonElement).disabled).toBe(true)
    expect((b.view.getByRole('menuitem', { name: 'Copy Session as Markdown' }) as HTMLButtonElement).disabled).toBe(false)
    expect((b.view.getByRole('menuitem', { name: 'Feedback' }) as HTMLButtonElement).disabled).toBe(false)
    release(new Response('zip'))
    await download
    await waitFor(() => { expect(button.getAttribute('aria-busy')).toBe('false') })
    expect((item as HTMLButtonElement).disabled).toBe(false)
  })
})
