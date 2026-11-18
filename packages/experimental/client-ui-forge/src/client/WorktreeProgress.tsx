/**
 * Card above the composer while a Session's worktree is created, while a message
 * waits after a failed or stopped attempt, and when its worktree is gone or
 * being restored.
 */

import { useState, type ReactNode } from 'react'
import {
  Button, IconBranchOutlineRegular, IconCheckOutlineRegular, IconChevronRightOutlineRegular, IconCloseOutlineRegular, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { branchLabel } from '../branch-name.ts'
import type { ForgeMissingWorktree, ForgePanelWorktree, ForgeSessionWorktree, ForgeWorktreeRestoration } from '../types.ts'
import type { ForgePanelKey, NS } from './locales.ts'
import type { PanelSnapshot } from './source.ts'
import { WorktreeNameDialog, type WorktreeRequestResult } from './WorktreeNameDialog.tsx'
import css from './WorktreeProgress.module.css'

/** Business face of the card. */
export interface WorktreeProgressInjected {
  /** Panel snapshot of the Session; the renderer binds it as `usePanel`. */
  readonly hooks: { readonly panel: HostObservable<PanelSnapshot> }
  /** Stop the running attempt a message waits for; the message keeps waiting. */
  readonly stop: () => void
  /**
   * Make another attempt at the worktree a message waits for.
   * @param fetch - false starts from the remote base branch as last fetched, without fetching it.
   */
  readonly retry: (fetch: boolean) => void
  /**
   * Request the worktree again from the same base on another branch name, before another attempt.
   * @param from - base of the open request, or null for HEAD.
   * @param name - new branch name.
   * @returns the outcome; a failure other than a refused name is already reported.
   */
  readonly request: (from: string | null, name: string | null) => Promise<WorktreeRequestResult>
  /** Withdraw the worktree request, so the waiting message goes on without a worktree. */
  readonly withdraw: () => void
  /**
   * Check out the removed worktree again.
   * @returns the failure text, or undefined once it is restored.
   */
  readonly restore: () => Promise<string | undefined>
  /** Move the Session back to the source checkout of its removed worktree. */
  readonly leave: () => void
}

/** Full props of the card. */
export type WorktreeProgressProps = InjectFace<WorktreeProgressInjected> & PropsLocale<typeof NS>

type Translate = WorktreeProgressProps['t']

type StepState = 'done' | 'running' | 'waiting' | 'failed'

type Phase = 'fetch' | 'prepare' | 'checkout'

/** Steps in the order they run, each with its label. */
type StepList = readonly { readonly phase: Phase; readonly label: ReactNode }[]

function stepState(steps: StepList, current: Phase, failed: boolean, phase: Phase): StepState {
  const at = steps.findIndex(step => step.phase === current)
  const index = steps.findIndex(step => step.phase === phase)
  if (index === at) return failed ? 'failed' : 'running'
  return index < at ? 'done' : 'waiting'
}

function Steps({ steps, phase, failed }: {
  readonly steps: StepList
  readonly phase: Phase
  readonly failed: boolean
}): ReactNode {
  return (
    <ul className={css.steps}>
      {steps.map((step) => {
        const state = stepState(steps, phase, failed, step.phase)
        return (
          <li key={step.phase} className={css.step} data-state={state} data-forge-step={step.phase}>
            <StepIcon state={state} />
            <span>{step.label}</span>
          </li>
        )
      })}
    </ul>
  )
}

/** The steps of a creation, which fetches a remote base branch first when it asks to. */
function creationSteps(creation: CreationView, t: Translate): StepList {
  const from = creation.from === null ? null : branchLabel(creation.from)
  return [
    ...creation.fetch && from !== null
      ? [{ phase: 'fetch' as const, label: t('creation.fetch', { branch: from }) }]
      : [],
    { phase: 'prepare', label: t('creation.prepare') },
    { phase: 'checkout', label: t('creation.checkout') },
  ]
}

function restorationSteps(t: Translate): StepList {
  return [
    { phase: 'prepare', label: t('restoration.prepare') },
    { phase: 'checkout', label: t('creation.checkout') },
  ]
}

function StepIcon({ state }: { readonly state: StepState }): ReactNode {
  switch (state) {
    case 'done': return <IconCheckOutlineRegular size={14} className={css.done} />
    case 'running': return <StateDot state="ongoing" size={14} />
    case 'failed': return <IconCloseOutlineRegular size={14} className={css.failed} />
    case 'waiting': return <span className={css.waiting} aria-hidden="true" />
    /* v8 ignore next -- closed StepState union exhaustiveness guard */
    default: return assertNever(state, 'StepState')
  }
}

/** One creation as the card shows it: the running attempt, or the failed or stopped one a message waits after. */
interface CreationView {
  readonly state: 'running' | 'failed' | 'stopped'
  readonly phase: Phase
  readonly branch: string | null
  readonly from: string | null
  /** Whether the attempt fetches its remote base branch first. */
  readonly fetch: boolean
  /** Failure text, or null unless the attempt failed. */
  readonly message: string | null
  /** Whether the failed attempt found its branch or checkout directory taken. */
  readonly exists: boolean
  /** Whether a message waits for the running attempt, which can then be stopped. */
  readonly held: boolean
}

/** The running attempt, else the failed or stopped one a message waits after, or undefined without either. */
function creationOf(worktree: ForgePanelWorktree): CreationView | undefined {
  const { creation, failure, waiting } = worktree
  if (creation !== null) return { ...creation, state: 'running', message: null, exists: false }
  if (waiting !== 'creation') return undefined
  if (failure !== null) return { ...failure, state: 'failed', held: false }
  return {
    state: 'stopped', phase: 'prepare', branch: null, from: worktree.request?.from ?? null, fetch: false, message: null, exists: false, held: false,
  }
}

function Details({ creation, t }: { readonly creation: CreationView; readonly t: Translate }): ReactNode {
  return (
    <dl className={css.details}>
      {creation.branch !== null && (
        <>
          <dt>{t('creation.branch')}</dt>
          <dd className={css.code}>{creation.branch}</dd>
        </>
      )}
      <dt>{t('creation.base')}</dt>
      <dd className={css.code}>{creation.from === null ? t('creation.head') : branchLabel(creation.from)}</dd>
      {creation.message !== null && (
        <>
          <dt>{t('creation.error')}</dt>
          <dd className={css.message}>{creation.message}</dd>
        </>
      )}
    </dl>
  )
}

const CREATION_TITLE: Record<CreationView['state'], ForgePanelKey> = {
  running: 'creation.title',
  failed: 'creation.failed',
  stopped: 'creation.stopped',
}

/** The buttons of a failed or stopped attempt before withdrawing; the first one is the primary action. */
function waitingActions(creation: CreationView, named: boolean, retry: WorktreeProgressInjected['retry'], rename: () => void, t: Translate): ReactNode {
  const again = { key: 'retry', label: t('creation.retry'), act: () => { retry(true) } }
  const actions = creation.state === 'failed' && creation.phase === 'fetch'
    ? [again, { key: 'fetched', label: t('creation.useFetched'), act: () => { retry(false) } }]
    : creation.state === 'failed' && creation.exists && named
      ? [{ key: 'rename', label: t('creation.rename'), act: rename }, again]
      : [again]
  return actions.map((action, index) => (
    <Button key={action.key} size="sm" variant={index === 0 ? 'primary' : 'ghost'} onClick={action.act}>{action.label}</Button>
  ))
}

function CreationCard({ creation, open: openRequest, prefix, stop, retry, withdraw, request, t }: {
  readonly creation: CreationView
  /** The open request, whose base a rename keeps and whose branch name it replaces. */
  readonly open: ForgePanelWorktree['request']
  /** Prefix of generated branch names. */
  readonly prefix: string
  readonly stop: WorktreeProgressInjected['stop']
  readonly retry: WorktreeProgressInjected['retry']
  readonly withdraw: WorktreeProgressInjected['withdraw']
  readonly request: WorktreeProgressInjected['request']
  readonly t: Translate
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const running = creation.state === 'running'
  const failed = creation.state === 'failed'
  const title = t(CREATION_TITLE[creation.state])
  const name = openRequest?.name ?? null
  const from = openRequest?.from ?? null
  return (
    <div className={css.dock} data-forge-creation={running ? creation.phase : creation.state}>
      <section className={css.card} aria-label={title} aria-busy={running}>
        <div className={css.header}>
          <IconBranchOutlineRegular size={14} className={css.glyph} />
          <span className={css.title}>{title}</span>
          {creation.branch !== null && <span className={css.branch}>{creation.branch}</span>}
        </div>
        {creation.state !== 'stopped' && <Steps steps={creationSteps(creation, t)} phase={creation.phase} failed={failed} />}
        {(open || failed) && <Details creation={creation} t={t} />}
        {!running && <p className={css.note}>{t('creation.waiting')}</p>}
        <div className={css.footer}>
          {running && (
            <button type="button" className={css.disclosure} aria-expanded={open} onClick={() => { setOpen(!open) }}>
              <IconChevronRightOutlineRegular size={12} className={open ? css.chevronOpen : css.chevron} />
              {t('creation.details')}
            </button>
          )}
          {!running && (
            <span className={css.actions}>
              {waitingActions(creation, name !== null, retry, () => { setRenaming(true) }, t)}
              <Button size="sm" variant="ghost" onClick={withdraw}>{t('creation.skip')}</Button>
            </span>
          )}
          {creation.held && (
            <span className={css.actions}>
              <Button size="sm" variant="ghost" icon={<IconCloseOutlineRegular size={14} />} onClick={stop}>{t('creation.cancel')}</Button>
            </span>
          )}
        </div>
      </section>
      {renaming && name !== null && (
        <WorktreeNameDialog mode="retry" initial={name} prefix={prefix} from={from} named
          submit={async (next) => {
            const result = await request(from, next)
            if (result === 'accepted') retry(true)
            return result
          }}
          close={() => { setRenaming(false) }} t={t} />
      )}
    </div>
  )
}

function MissingCard({ created, missing, restoration, waiting, restore, leave, t }: {
  readonly created: ForgeSessionWorktree
  readonly missing: ForgeMissingWorktree
  /** The running restoration, from whichever surface started it. */
  readonly restoration: ForgeWorktreeRestoration | null
  /** Whether a message waits for the worktree to be restored or left. */
  readonly waiting: boolean
  readonly restore: WorktreeProgressInjected['restore']
  readonly leave: WorktreeProgressInjected['leave']
  readonly t: Translate
}): ReactNode {
  const [restoring, setRestoring] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const start = (): void => {
    setRestoring(true)
    setError(null)
    void restore().then(
      (failure) => {
        setRestoring(false)
        setError(failure ?? null)
      },
      (failure: unknown) => {
        setRestoring(false)
        setError(failure instanceof Error ? failure.message : String(failure))
      },
    )
  }
  // The restore this card asked for runs before the Host names its first step.
  const phase = restoration?.phase ?? (restoring ? 'prepare' : null)
  if (phase !== null) {
    return (
      <div className={css.dock} data-forge-missing="" data-forge-restoration={phase}>
        <section className={css.card} aria-label={t('restoration.title')} aria-busy={true}>
          <div className={css.header}>
            <IconBranchOutlineRegular size={14} className={css.glyph} />
            <span className={css.title}>{t('restoration.title')}</span>
            <span className={css.branch}>{created.branch}</span>
          </div>
          <Steps steps={restorationSteps(t)} phase={phase} failed={false} />
        </section>
      </div>
    )
  }
  return (
    <div className={css.dock} data-forge-missing="">
      <section className={css.card} aria-label={t('missing.title')}>
        <div className={css.header}>
          <IconBranchOutlineRegular size={14} className={css.warning} />
          <span className={css.title}>{t('missing.title')}</span>
          <span className={css.branch}>{created.branch}</span>
        </div>
        <p className={css.note}>{t(missing.branchExists === null ? 'missing.unknown' : missing.branchExists ? 'missing.kept' : 'missing.recreated', { branch: created.branch })}</p>
        {waiting && <p className={css.note}>{t('missing.waiting')}</p>}
        {error !== null && <p className={css.error}>{error}</p>}
        <div className={css.footer}>
          <span className={css.actions}>
            <Button size="sm" variant="primary" onClick={start}>{t('missing.restore')}</Button>
            <Button size="sm" variant="ghost" onClick={leave}>{t('missing.leave')}</Button>
          </span>
        </div>
      </section>
    </div>
  )
}

/**
 * Render the worktree card of a Session: the running attempt at its
 * requested worktree, which can be stopped while a message waits for it; the
 * failed or stopped attempt a message waits after, with another attempt or
 * withdrawing the request so the message goes on without a worktree; or the
 * removal of the worktree the Session works in, with restoring it, whose
 * steps the card follows, and returning to the source checkout, after which
 * a waiting message goes on.
 * @param props - panel hook, actions, and copy.
 * @returns the card, or nothing while no attempt runs, no message waits, and the worktree exists.
 */
export function WorktreeProgress({ usePanel, stop, retry, withdraw, request, restore, leave, t }: WorktreeProgressProps): ReactNode {
  const worktree = usePanel(snapshot => snapshot.state?.worktree ?? null)
  if (worktree === null) return null
  const creation = creationOf(worktree)
  if (creation !== undefined) {
    return <CreationCard creation={creation} open={worktree.request} prefix={worktree.namePrefix} stop={stop} retry={retry}
      withdraw={withdraw} request={request} t={t} />
  }
  if (worktree.missing === null || worktree.created === null) return null
  return (
    <MissingCard
      created={worktree.created}
      missing={worktree.missing}
      restoration={worktree.restoration}
      waiting={worktree.waiting === 'restoration'}
      restore={restore}
      leave={leave}
      t={t}
    />
  )
}
