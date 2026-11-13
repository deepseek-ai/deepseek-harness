/** Sidebar action that imports a DeepSeek chat export uploaded from the browser into a chosen Workspace. */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Button, fileSizeText, IconChevronDownOutlineRegular, IconFolderCloseRegular, IconUploadOutlineMedium, IconUploadOutlineRegular,
  Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HocShare, InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime, SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { DeepseekChatImportFailureReason, DeepseekChatImportResult } from '../types.ts'
import type { UploadProgress } from './upload.ts'
import css from './ImportSessions.module.css'

/** Outcome of one import request, already reduced for display. */
export type DeepseekChatImportOutcome =
  | { readonly ok: true; readonly result: DeepseekChatImportResult }
  | {
    readonly ok: false
    readonly reason: DeepseekChatImportFailureReason | 'upload-failed' | 'unknown'
    readonly message: string
    /** Byte limit, present when the browser's own size pre-check rejected the file. */
    readonly limit?: number
  }

/** Callbacks injected by the plugin apply closure. */
export interface DeepseekChatImportInjected {
  /**
   * Upload one archive into a Workspace, then refresh the Session list however the attempt ends.
   * @param file - archive chosen in the browser.
   * @param workspaceId - Workspace receiving the Sessions.
   * @param onProgress - upload progress, the reading phase, then Sessions written.
   * @param signal - aborted when the dialog closes.
   * @returns the summary, or the failure category and diagnostic.
   */
  readonly importArchive: (
    file: File, workspaceId: WorkspaceId, onProgress: (progress: UploadProgress) => void, signal: AbortSignal,
  ) => Promise<DeepseekChatImportOutcome>
}

/** Props composed by the `sidebar.session.action` slot, including the New-session row content it wraps. */
export type ImportSessionsActionProps =
  PropsRuntime<'sidebar.session.action'>
  & HocShare<SlotMap['sidebar.session.action']>
  & PropsRenderFactories
  & InjectFace<DeepseekChatImportInjected>
  & PropsLocale<'deepseekChatImport'>

type Translate = ImportSessionsActionProps['t']

/**
 * Wrap the New-session row content with the import trigger after it and, while
 * open, its dialog.
 * @param props - the row content, column width, global hooks, the import callback, and the locale seat.
 * @returns the row content with the trigger and dialog, or only the row content when the Peer may not import.
 */
export function ImportSessionsAction(props: ImportSessionsActionProps) {
  const { wide, useRemoteAccess, t, children } = props
  const allowed = useRemoteAccess('deepseekChatImport/limits')
  const [open, setOpen] = useState(false)
  // A Peer that may not import still gets the New-session button: the layer adds nothing to it.
  if (!allowed) return children
  return (
    <>
      {children}
      <Tooltip label={t('action.label')} delayMs={500} side={wide ? 'bottom' : 'right'}>
        <button
          type="button"
          className={clsx(css.trigger, wide && css.wide)}
          aria-label={t('action.label')}
          onClick={() => { setOpen(true) }}
        >
          {wide ? <IconUploadOutlineMedium size={14} /> : <IconUploadOutlineRegular size={18} />}
        </button>
      </Tooltip>
      {open && <ImportDialog {...props} onClose={() => { setOpen(false) }} />}
    </>
  )
}

type DialogState =
  | { readonly phase: 'editing'; readonly error: string | null }
  | { readonly phase: 'running'; readonly progress: UploadProgress }
  | { readonly phase: 'done'; readonly result: DeepseekChatImportResult; readonly workspace: string }

function ImportDialog(
  { importArchive, renderFactorySlot, useSessions, useWorkspaces, onClose, t }: ImportSessionsActionProps & { onClose: () => void },
) {
  const workspaces = useWorkspaces(state => state.items)
  const currentSessionId = useSessions(state => Object.values(state.byId)
    .find(session => (session.retainedBy.mainView ?? 0) > 0)?.id)
  const [file, setFile] = useState<File | null>(null)
  const [workspaceId, setWorkspaceId] = useState<WorkspaceId | undefined>(
    () => workspaces.find(workspace => currentSessionId !== undefined && workspace.sessionIds.includes(currentSessionId))?.workspaceId,
  )
  const [pickerOpen, setPickerOpen] = useState(false)
  const [state, setState] = useState<DialogState>({ phase: 'editing', error: null })
  const fileInput = useRef<HTMLInputElement>(null)
  const workspaceButton = useRef<HTMLButtonElement>(null)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => { request.current?.abort() }, [])
  const workspace = workspaces.find(item => item.workspaceId === workspaceId)
  const running = state.phase === 'running'
  const close = () => {
    request.current?.abort()
    onClose()
  }
  const submit = (chosen: File, target: (typeof workspaces)[number]) => {
    const controller = new AbortController()
    request.current = controller
    setState({ phase: 'running', progress: { phase: 'uploading', fraction: 0 } })
    void importArchive(chosen, target.workspaceId, (progress) => {
      if (!controller.signal.aborted) setState({ phase: 'running', progress })
    }, controller.signal).then((outcome) => {
      if (controller.signal.aborted) return
      setState(outcome.ok
        ? { phase: 'done', result: outcome.result, workspace: target.title }
        : { phase: 'editing', error: failureText(outcome, t) })
    }, (error: unknown) => {
      if (controller.signal.aborted) return
      setState({ phase: 'editing', error: t('error.unknown', { message: error instanceof Error ? error.message : String(error) }) })
    })
  }
  if (state.phase === 'done') {
    const { result } = state
    return (
      <Modal
        open
        onClose={close}
        closeLabel={t('dialog.close')}
        title={t('dialog.title')}
        footer={<Button variant="primary" onClick={close}>{t('dialog.done')}</Button>}
      >
        <div className={css.summary} role="status">
          <p>{t(plural('result.imported', result.sessionIds.length), { count: String(result.sessionIds.length), name: state.workspace })}</p>
          {result.omittedByLimit > 0 && <p>{t(plural('result.omitted', result.omittedByLimit), { count: String(result.omittedByLimit) })}</p>}
          {result.skipped.length > 0 && <p>{t(plural('result.skipped', result.skipped.length), { count: String(result.skipped.length) })}</p>}
        </div>
      </Modal>
    )
  }
  const progressText = state.phase === 'running' ? runningText(state.progress, t) : t('dialog.import')
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('dialog.close')}
      title={t('dialog.title')}
      description={t('dialog.description')}
      footer={(
        <>
          <Button variant="outline" onClick={close}>{t('dialog.cancel')}</Button>
          <Button
            variant="primary"
            disabled={running || file === null || workspace === undefined}
            onClick={!running && file !== null && workspace !== undefined ? () => { submit(file, workspace) } : undefined}
          >
            {progressText}
          </Button>
        </>
      )}
    >
      <div className={css.fields}>
        <div className={css.field}>
          <span className={css.label}>{t('dialog.file')}</span>
          <div className={css.value}>
            {file !== null && <span className={css.fileName} title={file.name}>{file.name}</span>}
            {file !== null && <span className={css.fileSize}>{fileSizeText(file.size)}</span>}
            <Button
              className={css.fileButton}
              variant="outline"
              size="sm"
              disabled={running}
              data-modal-autofocus
              onClick={() => { fileInput.current?.click() }}
            >
              {file === null ? t('dialog.chooseFile') : t('dialog.changeFile')}
            </Button>
            <input
              ref={fileInput}
              className={css.hiddenInput}
              type="file"
              accept=".zip,application/zip"
              aria-label={t('dialog.file')}
              tabIndex={-1}
              onChange={(event) => {
                const chosen = event.target.files?.[0]
                if (chosen !== undefined) {
                  setFile(chosen)
                  setState({ phase: 'editing', error: null })
                }
                event.target.value = ''
              }}
            />
          </div>
        </div>
        <div className={css.field}>
          <span className={css.label}>{t('dialog.workspace')}</span>
          <div className={css.value}>
            <button
              ref={workspaceButton}
              type="button"
              className={css.workspaceButton}
              disabled={running}
              aria-haspopup="menu"
              aria-expanded={pickerOpen}
              title={workspace?.path}
              onClick={() => { setPickerOpen(open => !open) }}
            >
              <IconFolderCloseRegular size={16} />
              <span className={css.workspaceTitle}>{workspace?.title ?? t('dialog.chooseWorkspace')}</span>
              <IconChevronDownOutlineRegular size={14} />
            </button>
            {renderFactorySlot('workspace.picker', {
              open: pickerOpen,
              anchorRef: workspaceButton,
              selectedId: workspaceId,
              onPick: (id) => {
                setWorkspaceId(id)
                setPickerOpen(false)
                setState({ phase: 'editing', error: null })
              },
              onClose: () => { setPickerOpen(false) },
            })}
          </div>
        </div>
      </div>
      {state.phase === 'running' && <ProgressBar progress={state.progress} label={progressText} />}
      {state.phase === 'editing' && state.error !== null && <div className={css.error} role="alert">{state.error}</div>}
    </Modal>
  )
}

/** Pick the `.one` or `.other` form of a summary line. */
function plural<K extends 'result.imported' | 'result.omitted' | 'result.skipped'>(key: K, count: number): `${K}.one` | `${K}.other` {
  return count === 1 ? `${key}.one` : `${key}.other`
}

function runningText(progress: UploadProgress, t: Translate): string {
  switch (progress.phase) {
    case 'uploading': return t('dialog.uploading', { percent: String(Math.floor(progress.fraction * 100)) })
    case 'reading': return t('dialog.importing')
    case 'importing': return t('dialog.importingCount', { done: String(progress.done), total: String(progress.total) })
  }
}

/** Upload fraction, an indeterminate bar while the Host reads the archive, then Sessions written of the target. */
function ProgressBar({ progress, label }: { progress: UploadProgress; label: string }) {
  const value = progress.phase === 'uploading'
    ? { value: progress.fraction, max: 1 }
    : progress.phase === 'importing' ? { value: progress.done, max: progress.total } : {}
  return <progress className={css.progress} aria-label={label} {...value} />
}

function failureText(outcome: Extract<DeepseekChatImportOutcome, { ok: false }>, t: Translate): string {
  switch (outcome.reason) {
    case 'too-large': return outcome.limit === undefined
      // The Host names the exact limit it rejected, which is not the pre-check one.
      ? outcome.message
      : t('error.too-large', { limit: fileSizeText(outcome.limit) })
    case 'unreadable-archive': return t('error.unreadable-archive')
    case 'missing-manifest': return t('error.missing-manifest')
    case 'missing-index': return t('error.missing-index')
    case 'unsupported-version': return t('error.unsupported-version')
    case 'no-conversations': return t('error.no-conversations')
    case 'workspace-not-found': return t('error.workspace-not-found')
    case 'busy': return t('error.busy')
    case 'upload-failed': return t('error.upload-failed', { message: outcome.message })
    case 'unknown': return t('error.unknown', { message: outcome.message })
  }
}
