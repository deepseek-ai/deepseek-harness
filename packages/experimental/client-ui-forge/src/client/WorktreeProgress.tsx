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
import type { ForgeMissingWorktree, ForgePanelWorktree, ForgeSessionWorktree, ForgeWorktreeRestoration } from '../types.ts'
import type { ForgePanelKey, NS } from './locales.ts'
import type { PanelSnapshot } from './source.ts'
import css from './WorktreeProgress.module.css'

/** Business face of the card. */
export interface WorktreeProgressInjected {
  /** Panel snapshot of the Session; the renderer binds it as `usePanel`. */
  readonly hooks: { readonly panel: HostObservable<PanelSnapshot> }
  /** Stop the running attempt a message waits for; the message keeps waiting. */
  readonly stop: () => void
  /** Make another attempt at the worktree a message waits for. */
  readonly retry: () => void
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

type Phase = 'prepare' | 'checkout'

type StepList = readonly { readonly phase: Phase; readonly label: ForgePanelKey }[]

const CREATION_STEPS: StepList = [
  { phase: 'prepare', label: 'creation.prepare' },
  { phase: 'checkout', label: 'creation.checkout' },
]

const RESTORATION_STEPS: StepList = [
  { phase: 'prepare', label: 'restoration.prepare' },
  { phase: 'checkout', label: 'creation.checkout' },
]

function stepState(current: 'prepare' | 'checkout', failed: boolean, phase: 'prepare' | 'checkout'): StepState {
  if (phase === current) return failed ? 'failed' : 'running'
  return phase === 'prepare' ? 'done' : 'waiting'
}

function Steps({ steps, phase, failed, t }: {
  readonly steps: StepList
  readonly phase: Phase
  readonly failed: boolean
  readonly t: Translate
}): ReactNode {
  return (
    <ul className={css.steps}>
      {steps.map(step => (
        <li key={step.phase} className={css.step} data-state={stepState(phase, failed, step.phase)}>
          <StepIcon state={stepState(phase, failed, step.phase)} />
          <span>{t(step.label)}</span>
        </li>
      ))}
    </ul>
  )
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
  readonly phase: 'prepare' | 'checkout'
  readonly branch: string | null
  readonly from: string | null
  /** Failure text, or null unless the attempt failed. */
  readonly message: string | null
  /** Whether a message waits for the running attempt, which can then be stopped. */
  readonly held: boolean
}

/** The running attempt, else the failed or stopped one a message waits after, or undefined without either. */
function creationOf(worktree: ForgePanelWorktree): CreationView | undefined {
  const { creation, failure, waiting } = worktree
  if (creation !== null) return { ...creation, state: 'running', message: null }
  if (waiting !== 'creation') return undefined
  if (failure !== null) return { ...failure, state: 'failed', held: false }
  return { state: 'stopped', phase: 'prepare', branch: null, from: worktree.request?.from ?? null, message: null, held: false }
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
      <dd className={css.code}>{creation.from ?? t('creation.head')}</dd>
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

function CreationCard({ creation, stop, retry, withdraw, t }: {
  readonly creation: CreationView
  readonly stop: WorktreeProgressInjected['stop']
  readonly retry: WorktreeProgressInjected['retry']
  readonly withdraw: WorktreeProgressInjected['withdraw']
  readonly t: Translate
}): ReactNode {
  const [open, setOpen] = useState(false)
  const running = creation.state === 'running'
  const failed = creation.state === 'failed'
  const title = t(CREATION_TITLE[creation.state])
  return (
    <div className={css.dock} data-forge-creation={running ? creation.phase : creation.state}>
      <section className={css.card} aria-label={title} aria-busy={running}>
        <div className={css.header}>
          <IconBranchOutlineRegular size={14} className={css.glyph} />
          <span className={css.title}>{title}</span>
          {creation.branch !== null && <span className={css.branch}>{creation.branch}</span>}
        </div>
        {creation.state !== 'stopped' && <Steps steps={CREATION_STEPS} phase={creation.phase} failed={failed} t={t} />}
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
              <Button size="sm" variant="primary" onClick={retry}>{t('creation.retry')}</Button>
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
          <Steps steps={RESTORATION_STEPS} phase={phase} failed={false} t={t} />
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
export function WorktreeProgress({ usePanel, stop, retry, withdraw, restore, leave, t }: WorktreeProgressProps): ReactNode {
  const worktree = usePanel(snapshot => snapshot.state?.worktree ?? null)
  if (worktree === null) return null
  const creation = creationOf(worktree)
  if (creation !== undefined) return <CreationCard creation={creation} stop={stop} retry={retry} withdraw={withdraw} t={t} />
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
