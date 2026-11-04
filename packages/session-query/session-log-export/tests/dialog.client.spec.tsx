// @vitest-environment jsdom
import { bindSnapshotSelector, contextMenuHook, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionLogDownloadController } from '../src/client/controller.ts'
import { SessionLogDownloadDialog } from '../src/client/Dialog.tsx'
import type { SessionLogDownloadDialogProps } from '../src/client/Dialog.tsx'
import { en, zh } from '../src/client/locales.ts'

const SID = 'session-export-dialog' as SessionId
const OTHER = 'other-session' as SessionId
const unused = (): never => { throw new Error('Root export dialog does not consume Session hooks') }
const standard: GlobalStandardProps = {
  useSessions: unused, useSessionStatus: unused, useSessionRetainInfo: unused,
  useSessionAccess: () => true, useRemoteAccess: () => true, useWorkspaceAccess: () => true,
  usePanelInfo: unused, useContextMenu: contextMenuHook(), useResource: unused, useWorkspaces: unused,
}

function bench(
  controller = new SessionLogDownloadController(async () => new Response('zip'), vi.fn()),
  releasePending: () => void = () => {},
) {
  onTestFinished(async () => { releasePending(); await controller.dispose() })
  const dismiss = vi.fn((sessionId: SessionId) => { controller.dismiss(sessionId) })
  const props: SessionLogDownloadDialogProps = {
    ...standard, useSessionLogDownload: bindSnapshotSelector(controller.store), dismiss, t: makeTranslate(en),
  }
  const view = render(<SessionLogDownloadDialog {...props} />)
  return { controller, dismiss, props, view }
}

function close(view: ReturnType<typeof render>) {
  const button = view.getAllByRole('button', { name: 'Close' }).at(-1)
  if (button === undefined) throw new Error('Export dialog has no close button')
  fireEvent.click(button)
}

afterEach(cleanup)

describe('SessionLogDownloadDialog', () => {
  it('shows a controller failure with the exported Session identity and closes it', async () => {
    const b = bench(new SessionLogDownloadController(async () => { throw new Error('transport failed') }, vi.fn()))
    await act(() => b.controller.download(SID))
    const dialog = b.view.getByRole('dialog', { name: 'Session export failed' })
    expect(dialog.textContent).toContain(`Session: ${SID}`)
    expect(dialog.textContent).toContain('transport failed')
    fireEvent.click(b.view.getAllByRole('button', { name: 'Close' })[0]!)
    expect(b.dismiss).toHaveBeenCalledWith(SID)
    expect(b.view.queryByRole('dialog')).toBeNull()
  })

  it('keeps one FIFO modal while Sessions download in parallel and settle out of order', async () => {
    const first = Promise.withResolvers<Response>(), second = Promise.withResolvers<Response>()
    const save = vi.fn()
    const fetcher = vi.fn((input: string | URL) => String(input).includes(OTHER) ? second.promise : first.promise)
    const b = bench(new SessionLogDownloadController(fetcher, save), () => {
      first.resolve(new Response('zip'))
      second.resolve(new Response('zip'))
    })
    let a!: Promise<void>, duplicate!: Promise<void>, other!: Promise<void>
    act(() => { a = b.controller.download(SID); other = b.controller.download(OTHER); duplicate = b.controller.download(SID) })
    expect(duplicate).toBe(a)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(b.view.getAllByRole('dialog')).toHaveLength(1)
    expect(b.view.getByRole('dialog').textContent).toContain(SID)
    await act(async () => { second.resolve(new Response('zip')); await other })
    expect(b.view.getByRole('dialog', { name: 'Exporting Session' }).textContent).toContain(SID)
    close(b.view)
    expect(b.view.getByRole('dialog', { name: 'Session download started' }).textContent).toContain(OTHER)
    await act(async () => { first.resolve(new Response('zip')); await a })
    expect(save).toHaveBeenCalledTimes(2)
    expect(b.view.getByRole('dialog').textContent).toContain(OTHER)
    close(b.view)
    expect(b.view.queryByRole('dialog')).toBeNull()
  })

  it('orders a new operation after existing open exports rather than historical Record insertion', async () => {
    const b = bench()
    await act(() => b.controller.download(SID))
    close(b.view)
    await act(() => b.controller.download(OTHER))
    await act(() => b.controller.download(SID))
    expect(b.view.getByRole('dialog').textContent).toContain(OTHER)
    close(b.view)
    expect(b.view.getByRole('dialog').textContent).toContain(SID)
    expect(b.controller.store.getSnapshot().bySession[SID]?.order).toBe(2)
  })

  it('retains the root modal when the displayed conversation changes and identifies errors in FIFO order', async () => {
    const b = bench(new SessionLogDownloadController(async () => { throw new Error('offline') }, vi.fn()))
    b.view.rerender(<><article>{SID}</article><SessionLogDownloadDialog {...b.props} /></>)
    await act(() => b.controller.download(SID))
    const dialog = b.view.getByRole('dialog')
    b.view.rerender(<><article>{OTHER}</article><SessionLogDownloadDialog {...b.props} /></>)
    expect(b.view.getByRole('dialog')).toBe(dialog)
    expect(dialog.textContent).toContain(SID)
    expect(dialog.textContent).not.toContain(OTHER)
    await act(() => b.controller.download(OTHER))
    close(b.view)
    expect(b.view.getByRole('dialog', { name: 'Session export failed' }).textContent).toContain(OTHER)
    expect(b.view.getByRole('dialog').textContent).toContain('offline')
  })

  it('does not reopen a dismissed in-flight operation for repeated requests or failure', async () => {
    const gate = Promise.withResolvers<Response>()
    const b = bench(new SessionLogDownloadController(() => gate.promise, vi.fn()), () => {
      gate.resolve(new Response('zip'))
    })
    let pending!: Promise<void>
    act(() => { pending = b.controller.download(SID) })
    close(b.view)
    expect(b.controller.download(SID)).toBe(pending)
    expect(b.view.queryByRole('dialog')).toBeNull()
    await act(async () => { gate.reject(new Error('offline')); await pending })
    expect(b.view.queryByRole('dialog')).toBeNull()
    expect(b.controller.store.getSnapshot().bySession[SID]).toMatchObject({ status: 'error', open: false })
  })

  it('uses localized fallback copy and ignores absent entries', () => {
    const b = bench()
    act(() => {
      b.controller.store.set({ bySession: {
        missing: undefined,
        [SID]: { order: 0, open: true, status: 'error', error: '' },
      } })
    })
    expect(b.view.getByRole('dialog').textContent).toContain('Could not start the Session export.')
    b.view.rerender(<SessionLogDownloadDialog {...b.props} t={makeTranslate(zh)} />)
    expect(b.view.getByRole('dialog').textContent).toContain(`Session：${SID}`)
    expect(b.view.getByRole('dialog').textContent).toContain(zh['dialog.commandFailed'])
  })
})
