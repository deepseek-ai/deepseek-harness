/** Manual creation reuses the existing Modal and Rules editor controls. */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ScheduleCatalogEntry, ScheduleCreateRequest } from '@deepseek-ai/dsh-schedule/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { TaskEditorFields, draftTarget, newTaskDraft, taskDraftValid } from './TaskEditorFields.tsx'
import type { ProjectChoices } from './TaskEditorFields.tsx'
import { timingFromDraft } from './editor-timing.ts'
import type { HostTaskActions } from './TaskDetail.tsx'
import { NewSessionLimit } from './NewSessionLimit.tsx'
import css from './TaskManagerPage.module.css'

/** Creation outcome retains Host validation and never closes a failed draft. */
export type TaskCreateOutcome = { readonly created: ScheduleCatalogEntry }
  | { readonly failed: 'host.createError' | 'host.notFuture' | 'host.invalidRule' }

/** Create one task without starting an Agent or sending its instruction. */
export function TaskCreateDialog({ projects, onCreate, onClose, onCreated, loadNewSessionInterval, t }: PropsLocale<'schedule.manager'> & {
  readonly projects: ProjectChoices
  readonly loadNewSessionInterval: HostTaskActions['loadNewSessionInterval']
  readonly onCreate: (request: ScheduleCreateRequest) => Promise<TaskCreateOutcome>
  readonly onClose: () => void
  readonly onCreated: (task: ScheduleCatalogEntry) => void
}): ReactNode {
  const [input, setDraft] = useState(newTaskDraft)
  // An unchosen directory follows the starting Workspace, which can arrive after the dialog opens.
  const draft = input.cwd === '' ? { ...input, cwd: projects.defaultCwd } : input
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<Extract<TaskCreateOutcome, { failed: string }>['failed'] | null>(null)
  const save = async (): Promise<void> => {
    setPending(true)
    setFailure(null)
    const outcome = await onCreate({
      title: draft.title, prompt: draft.prompt, timing: timingFromDraft(draft, true), target: draftTarget(draft),
    })
    setPending(false)
    if ('created' in outcome) onCreated(outcome.created)
    else setFailure(outcome.failed)
  }
  return <Modal open className={css.manualDialog as string} title={t('host.manualCreate')}
    closeLabel={t('host.closeCreate')} onClose={() => { if (!pending) onClose() }}
    footer={<div className={css.confirmActions}>
      <Button disabled={pending} onClick={onClose}>{t('delete.cancel')}</Button>
      <Button variant="primary" disabled={pending || !taskDraftValid(draft)} onClick={() => { void save() }}>
        {t(pending ? 'host.creating' : 'host.create')}
      </Button>
    </div>}>
    <TaskEditorFields draft={draft} onChange={setDraft} projects={projects} disabled={pending} t={t} />
    {draft.target === 'new' && <NewSessionLimit load={loadNewSessionInterval} t={t} />}
    {failure !== null && <p className={css.saveFailure} role="alert">{t(failure)}</p>}
  </Modal>
}
