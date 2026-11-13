import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Checkpoint, CHECKPOINT_BYTES } from '../checkpoint.ts'
import type { Tree, TimelineView } from '../records.ts'
import type { ImportRequest } from './actions.ts'
import type { UserEditResult } from '../protocol.ts'
import { measureAll } from '../tasks.ts'
import { formatProgress } from './Progress.tsx'
import type { ProgressPrecision } from '../policy.ts'

export interface TreeTransferActions {
  importTree: (request: ImportRequest) => Promise<Extract<UserEditResult, { action: 'import' }>>
  removeTree: (tree: Tree['id']) => Promise<Extract<UserEditResult, { action: 'remove' }>>
}

/** Download the acknowledged plan; no model request or host filesystem write is needed. */
export function exportTree(tree: Tree, annotations: TimelineView['annotations'], sessionId: string): void {
  const text = Checkpoint.fromTree(tree, annotations, Date.now(), sessionId, process.env.DSH_CLIENT_VERSION).toString()
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${tree.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 80)}.timeline.json`
    anchor.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Review a local checkpoint or confirm deletion through the same user-owned storage path. */
export function TreeTransfer({
  mode,
  sessionId,
  tree,
  view,
  running,
  decimals,
  close,
  imported,
  removed,
  importTree,
  removeTree,
  t,
}: {
  mode: 'import' | 'remove' | null
  sessionId: string
  tree: Tree | undefined
  view: TimelineView
  running: boolean
  decimals: ProgressPrecision
  close: () => void
  imported: (tree: Tree['id'], warning: boolean) => void
  removed: (warning: boolean) => void
} & TreeTransferActions &
  PropsLocale<'timeline'>): ReactNode {
  const input = useRef<HTMLInputElement>(null)
  const version = useRef(0)
  const requestId = useRef(randomUUID())
  const saving = useRef(false)
  const [file, setFile] = useState<{ name: string; content: string; checkpoint: Checkpoint } | null>(null)
  const [proceed, setProceed] = useState(false)
  const [copy, setCopy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => () => { version.current++ }, [])
  const read = async (selected: File) => {
    const current = ++version.current
    setBusy(true)
    setFile(null)
    setError(null)
    try {
      if (selected.size > CHECKPOINT_BYTES) throw new Error('Timeline checkpoint exceeds 2 MiB')
      const content = await selected.text()
      if (version.current !== current) return
      const checkpoint = Checkpoint.fromString(content)
      setFile({ name: selected.name, content, checkpoint })
      requestId.current = randomUUID()
    } catch (error: unknown) {
      if (version.current === current)
        setError(error instanceof Error ? error.message.slice(0, 1000) : t('treeTransferFailed'))
    } finally {
      if (version.current === current) setBusy(false)
    }
  }
  const remove = mode === 'remove' && tree !== undefined
  const submit = remove
    ? async () => {
      const result = await removeTree(tree.id)
      removed(result.removed && !result.notified && !result.draft)
    }
    : mode === 'import' && file !== null
      ? async () => {
        const result = await importTree({ id: requestId.current, content: file.content, copy, continue: proceed })
        imported(result.tree, proceed && !result.notified)
      }
      : undefined
  const perform = async (submit: () => Promise<void>) => {
    if (saving.current) return
    saving.current = true
    setBusy(true)
    setError(null)
    try {
      await submit()
      close()
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message.slice(0, 1000) : t('treeTransferFailed'))
    } finally {
      saving.current = false
      setBusy(false)
    }
  }
  const progress = file === null ? 0 : (measureAll(file.checkpoint.tasks).get(null)?.progress ?? 0)
  return (
    <Modal
      open={mode !== null}
      onClose={() => {
        if (!busy) close()
      }}
      title={t(mode === 'remove' ? 'deleteTree' : 'importTree')}
      closeLabel={t('cancel')}
      className="timeline-transfer"
      description={
        remove ? t('deleteTreeHint', { title: tree.title }) : t('checkpointHint')
      }
      footer={
        <>
          {remove ? (
            <Button
              disabled={busy}
              onClick={() => {
                try {
                  exportTree(tree, view.annotations, sessionId)
                } catch (error: unknown) {
                  setError(error instanceof Error ? error.message : t('treeTransferFailed'))
                }
              }}
            >
              {t('exportTree')}
            </Button>
          ) : null}
          <Button disabled={busy} onClick={close}>
            {t('cancel')}
          </Button>
          <Button
            variant={mode === 'remove' ? 'outline' : 'primary'}
            className={mode === 'remove' ? 'timeline-delete' : undefined}
            disabled={busy || running || submit === undefined}
            onClick={submit === undefined ? undefined : () => { void perform(submit) }}
          >
            {t(busy ? 'saving' : mode === 'remove' ? 'deleteTree' : 'importTree')}
          </Button>
        </>
      }
    >
      {mode === 'import' ? (
        <div className="timeline-transfer-options">
          <input
            ref={input}
            type="file"
            accept=".json,application/json"
            hidden
            aria-label={t('chooseCheckpoint')}
            onChange={(event) => {
              const selected = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (selected !== undefined) void read(selected)
            }}
          />
          <Button
            variant="outline"
            disabled={busy}
            data-modal-autofocus
            onClick={() => input.current?.click()}
          >
            {t('chooseCheckpoint')}
          </Button>
          {file === null ? null : (
            <div>
              <strong>{file.checkpoint.toJson().title}</strong>
              <p className="timeline-muted">{file.name}</p>
              <p>
                {t('taskCount', { count: file.checkpoint.tasks.length })} ·{' '}
                {formatProgress(progress, decimals)}%
              </p>
            </div>
          )}
          <label>
            <input
              type="checkbox"
              disabled={busy}
              checked={proceed}
              onChange={(event) => {
                setProceed(event.currentTarget.checked)
                requestId.current = randomUUID()
              }}
            />
            {t('continueCheckpoint')}
          </label>
          <label>
            <input
              type="checkbox"
              disabled={busy}
              checked={copy}
              onChange={(event) => {
                setCopy(event.currentTarget.checked)
                requestId.current = randomUUID()
              }}
            />
            {t('copyCheckpoint')}
          </label>
        </div>
      ) : null}
      {running ? <p role="status">{t('treeIdleRequired')}</p> : null}
      {error === null ? null : (
        <p className="timeline-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  )
}
