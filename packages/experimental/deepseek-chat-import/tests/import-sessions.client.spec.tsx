// @vitest-environment jsdom
import { allowAllAccess, contextMenuHook, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { GlobalStandardProps, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspacePickerInput } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { ImportSessionsAction } from '../src/client/ImportSessions.tsx'
import type { DeepseekChatImportOutcome, ImportSessionsActionProps } from '../src/client/ImportSessions.tsx'
import type { UploadProgress } from '../src/client/upload.ts'
import { en } from '../src/client/locales.ts'
import type { DeepseekChatImportResult } from '../src/types.ts'

const unused = (): never => { throw new Error('the import action reads no other Session hooks') }
const W1 = 'w1' as WorkspaceId
const W2 = 'w2' as WorkspaceId
const sid = (id: string) => id as SessionId

/** Selector hook over one fixed snapshot, as the renderer binds a standard source. */
function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

const view = (id: string, title: string, sessionIds: SessionId[]) => ({
  workspaceId: id as WorkspaceId, title, path: `/home/a/${title}`, sessionIds,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
const workspaces: WorkspaceSnapshot = {
  items: [view('w1', 'project-one', [sid('s-current')]), view('w2', 'project-two', [])],
  archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
}

function sessions(current: string): SessionListState {
  const summary = (id: string, mainView: boolean): SessionSummary => ({
    id: sid(id), displayTitle: id, running: false, blank: false, updatedAt: 1, retainedBy: mainView ? { mainView: 1 } : {},
  })
  return { ids: [sid('other'), sid(current)], byId: { [sid('other')]: summary('other', false), [sid(current)]: summary(current, true) }, phase: 'ready', projectionsBySession: {} }
}

const RESULT: DeepseekChatImportResult = {
  workspaceId: W2, workspacePath: '/home/a/project-two', sessionIds: ['s1', 's2'],
  conversationCount: 4, omittedByLimit: 1, skipped: [{ conversationId: 'c4', title: null, reason: 'conversation has no messages' }],
}

type ImportArchive = ImportSessionsActionProps['importArchive']

function bench(options: { allowed?: boolean; wide?: boolean; current?: string; importArchive?: ImportArchive } = {}) {
  let picker: WorkspacePickerInput | undefined
  const renderFactorySlot: PropsRenderFactories['renderFactorySlot'] = (name, input) => {
    if (name !== 'workspace.picker') throw new Error(`Unexpected Factory: ${name}`)
    const occurrence = input as WorkspacePickerInput
    picker = occurrence
    return occurrence.open ? <div role="menu" aria-label="workspace menu" /> : null
  }
  const useRemoteAccess = vi.fn((_action: string) => options.allowed ?? true)
  const standard: GlobalStandardProps = {
    useSessions: hook(sessions(options.current ?? 's-current')),
    useSessionStatus: unused, useSessionRetainInfo: unused, usePanelInfo: unused, useResource: unused,
    useContextMenu: contextMenuHook(), useWorkspaces: hook(workspaces),
    ...allowAllAccess, useRemoteAccess,
  }
  const importArchive = options.importArchive ?? vi.fn<ImportArchive>()
  const props: ImportSessionsActionProps = {
    ...standard, wide: options.wide ?? true, importArchive, renderFactorySlot, t: makeTranslate(en),
    // The layer wraps the New-session row content the sidebar owner passes in.
    children: <span data-testid="new-session-content">New session</span>,
  }
  const rendered = render(<ImportSessionsAction {...props} />)
  return {
    view: rendered, useRemoteAccess, importArchive,
    picker: () => {
      if (picker === undefined) throw new Error('workspace picker not rendered')
      return picker
    },
  }
}

function open(view: ReturnType<typeof render>) {
  fireEvent.click(view.getByRole('button', { name: 'Import DeepSeek chats' }))
  return view.getByRole('dialog', { name: 'Import DeepSeek chat history' })
}

function choose(view: ReturnType<typeof render>, file = new File([new Uint8Array(2048)], 'deepseek_data-2026-11-11.zip', { type: 'application/zip' })) {
  const input = view.getByLabelText('Export file') as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
  return file
}

afterEach(cleanup)

describe('ImportSessionsAction', () => {
  it('keeps the New-session row content and adds no trigger for a Peer without import access', () => {
    const { view, useRemoteAccess } = bench({ allowed: false })
    expect(view.getByTestId('new-session-content')).toBeTruthy()
    expect(view.queryByRole('button', { name: 'Import DeepSeek chats' })).toBeNull()
    expect(view.queryByRole('dialog')).toBeNull()
    expect(useRemoteAccess).toHaveBeenCalledWith('deepseekChatImport/limits')
  })

  it('renders the row content before its trigger', () => {
    const { view } = bench()
    const content = view.getByTestId('new-session-content')
    expect(content.nextElementSibling).toBe(view.getByRole('button', { name: 'Import DeepSeek chats' }))
  })

  it('uploads the chosen file into the chosen workspace and summarizes the result', async () => {
    const pending = Promise.withResolvers<DeepseekChatImportOutcome>()
    let report: ((progress: UploadProgress) => void) | undefined
    const importArchive = vi.fn<ImportArchive>((_file, _workspace, onProgress) => { report = onProgress; return pending.promise })
    const { view, picker } = bench({ importArchive, wide: false })
    const dialog = open(view)
    const submit = view.getByRole('button', { name: 'Import' })
    expect(submit).toHaveProperty('disabled', true)
    // The current Session's workspace is preselected.
    expect(view.getByRole('button', { name: /project-one/ })).toBeTruthy()
    expect(picker()).toMatchObject({ open: false, selectedId: W1 })
    expect(submit).toHaveProperty('disabled', true)
    const file = choose(view)
    expect(dialog.textContent).toContain('deepseek_data-2026-11-11.zip')
    expect(dialog.textContent).toContain('2.0KB')
    expect(view.getByRole('button', { name: 'Change' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: /project-one/ }))
    expect(picker().open).toBe(true)
    expect(view.getByRole('menu', { name: 'workspace menu' })).toBeTruthy()
    act(() => { picker().onPick(W2) })
    expect(picker()).toMatchObject({ open: false, selectedId: W2 })
    expect(view.getByRole('button', { name: /project-two/ })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Import' }))
    expect(importArchive).toHaveBeenCalledWith(file, W2, expect.any(Function), expect.any(AbortSignal))
    expect(view.getByRole('button', { name: 'Uploading 0%' })).toHaveProperty('disabled', true)
    const bar = () => view.getByRole('progressbar') as HTMLProgressElement
    act(() => { report?.({ phase: 'uploading', fraction: 0.375 }) })
    expect(view.getByRole('button', { name: 'Uploading 37%' })).toBeTruthy()
    expect([bar().getAttribute('value'), bar().getAttribute('max'), bar().getAttribute('aria-label')]).toEqual(['0.375', '1', 'Uploading 37%'])
    act(() => { report?.({ phase: 'reading' }) })
    expect(view.getByRole('button', { name: 'Importing…' })).toBeTruthy()
    expect(bar().hasAttribute('value')).toBe(false)
    act(() => { report?.({ phase: 'importing', done: 1, total: 3 }) })
    expect(view.getByRole('button', { name: 'Importing 1/3' })).toBeTruthy()
    expect([bar().getAttribute('value'), bar().getAttribute('max')]).toEqual(['1', '3'])
    await act(async () => { pending.resolve({ ok: true, result: RESULT }) })
    expect(view.queryByRole('progressbar')).toBeNull()
    expect(view.getByRole('status').textContent).toBe([
      'Imported 2 sessions into the project-two workspace.',
      '1 older conversation exceeded the import limit and was not imported.',
      '1 conversation could not be imported.',
    ].join(''))
    fireEvent.click(view.getByRole('button', { name: 'Done' }))
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('chooses plural forms by count', async () => {
    const skip = { conversationId: 'c', title: null, reason: 'conversation has no messages' }
    const importArchive = vi.fn(() => Promise.resolve<DeepseekChatImportOutcome>({
      ok: true, result: { ...RESULT, sessionIds: ['s1'], omittedByLimit: 2, skipped: [skip, skip] },
    }))
    const { view } = bench({ importArchive })
    open(view)
    choose(view)
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Import' })) })
    expect(view.getByRole('status').textContent).toBe([
      'Imported 1 session into the project-one workspace.',
      '2 older conversations exceeded the import limit and were not imported.',
      '2 conversations could not be imported.',
    ].join(''))
  })

  it('shows a thrown import error and ignores one after the dialog closed', async () => {
    const importArchive = vi.fn<ImportArchive>()
      .mockRejectedValueOnce(new Error('limits unavailable'))
      .mockRejectedValueOnce('offline')
    const { view } = bench({ importArchive })
    open(view)
    choose(view)
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Import' })) })
    expect(view.getByRole('alert').textContent).toBe('Import failed: limits unavailable')
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Import' })) })
    expect(view.getByRole('alert').textContent).toBe('Import failed: offline')
    const pending = Promise.withResolvers<DeepseekChatImportOutcome>()
    importArchive.mockReturnValueOnce(pending.promise)
    fireEvent.click(view.getByRole('button', { name: 'Import' }))
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }))
    await act(async () => { pending.reject(new Error('aborted')) })
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('omits empty summary lines and toggles and closes the workspace menu', async () => {
    const importArchive = vi.fn(() => Promise.resolve<DeepseekChatImportOutcome>({
      ok: true, result: { ...RESULT, omittedByLimit: 0, skipped: [] },
    }))
    const { view, picker } = bench({ importArchive })
    open(view)
    fireEvent.click(view.getByRole('button', { name: /project-one/ }))
    fireEvent.click(view.getByRole('button', { name: /project-one/ }))
    expect(picker().open).toBe(false)
    fireEvent.click(view.getByRole('button', { name: /project-one/ }))
    act(() => { picker().onClose() })
    expect(picker().open).toBe(false)
    choose(view)
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Import' })) })
    expect(view.getByRole('status').textContent).toBe('Imported 2 sessions into the project-one workspace.')
  })

  it('starts without a workspace when the current Session belongs to none', () => {
    const { view, picker } = bench({ current: 'loose' })
    open(view)
    expect(view.getByRole('button', { name: /Choose workspace/ })).toBeTruthy()
    expect(picker().selectedId).toBeUndefined()
    choose(view)
    expect(view.getByRole('button', { name: 'Import' })).toHaveProperty('disabled', true)
  })

  it('opens the browser file chooser and ignores an empty selection', () => {
    const { view } = bench()
    open(view)
    const input = view.getByLabelText('Export file') as HTMLInputElement
    const click = vi.spyOn(input, 'click')
    fireEvent.click(view.getByRole('button', { name: 'Choose file…' }))
    expect(click).toHaveBeenCalledOnce()
    expect(input.accept).toBe('.zip,application/zip')
    fireEvent.change(input, { target: { files: [] } })
    expect(view.getByRole('button', { name: 'Choose file…' })).toBeTruthy()
  })

  it.each([
    [{ reason: 'too-large', limit: 512 * 1024 * 1024 }, 'The file is too large: the limit is 512MB.'],
    // A Host failure knows its own limit, so its message is shown instead of the pre-check one.
    [{ reason: 'too-large' }, 'gateway closed'],
    [{ reason: 'unreadable-archive' }, 'The file is not a readable ZIP archive.'],
    [{ reason: 'missing-manifest' }, 'This is not a DeepSeek export: manifest.json is missing.'],
    [{ reason: 'missing-index' }, 'This is not a DeepSeek export: chat_session_index.json is missing or unreadable.'],
    [{ reason: 'unsupported-version' }, 'This export format version is not supported.'],
    [{ reason: 'no-conversations' }, 'The export contains no conversations that can be imported.'],
    [{ reason: 'workspace-not-found' }, 'The chosen workspace no longer exists. Choose another one.'],
    [{ reason: 'busy' }, 'Another import is running. Try again later.'],
    [{ reason: 'upload-failed' }, 'Upload failed: gateway closed'],
    [{ reason: 'unknown' }, 'Import failed: gateway closed'],
  ] as const)('explains a %o failure and clears it on a new choice', async (failure, text) => {
    const importArchive = vi.fn(() => Promise.resolve<DeepseekChatImportOutcome>({ ok: false, message: 'gateway closed', ...failure }))
    const { view, picker } = bench({ importArchive })
    open(view)
    choose(view)
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Import' })) })
    expect(view.getByRole('alert').textContent).toBe(text)
    expect(view.getByRole('button', { name: 'Import' })).toHaveProperty('disabled', false)
    choose(view)
    expect(view.queryByRole('alert')).toBeNull()
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Import' })) })
    act(() => { picker().onPick(W2) })
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('aborts the running import when the dialog closes and ignores its late progress and outcome', async () => {
    const pending = Promise.withResolvers<DeepseekChatImportOutcome>()
    let report: ((progress: UploadProgress) => void) | undefined
    const importArchive = vi.fn<ImportArchive>((_file, _workspace, onProgress) => { report = onProgress; return pending.promise })
    const { view } = bench({ importArchive })
    open(view)
    choose(view)
    fireEvent.click(view.getByRole('button', { name: 'Import' }))
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }))
    expect(importArchive.mock.calls[0]?.[3].aborted).toBe(true)
    act(() => { report?.({ phase: 'importing', done: 1, total: 2 }) })
    await act(async () => { pending.resolve({ ok: true, result: RESULT }) })
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('aborts the running import when the action unmounts', () => {
    const importArchive = vi.fn<ImportArchive>(() => new Promise(() => {}))
    const { view } = bench({ importArchive })
    open(view)
    choose(view)
    fireEvent.click(view.getByRole('button', { name: 'Import' }))
    view.unmount()
    expect(importArchive.mock.calls[0]?.[3].aborted).toBe(true)
  })
})
