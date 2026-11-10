/** Session panel section listing the Session's change requests, and its title control. */

import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { MergeRequest } from '@deepseek-ai/dsh-experimental-forge/types'
import type {} from '@deepseek-ai/dsh-client-ui-session-panel/client'
import type { ForgePanelChangeRequest, ForgePanelState } from '../types.ts'
import { ChangeRequestCard, type ChangeRequestActions } from './ChangeRequestCard.tsx'
import type { createChangeRequestsSectionStore } from './change-requests-store.ts'
import type { NS } from './locales.ts'
import type { PanelSnapshot } from './source.ts'
import { defaultExpanded } from './status.ts'
import css from './Forge.module.css'

/** Business face of the change requests section. */
export interface ChangeRequestsSectionInjected {
  /** Panel snapshot of the Session and the active language; bound as `usePanel` and `useLocale`. */
  readonly hooks: {
    readonly panel: HostObservable<PanelSnapshot>
    readonly locale: HostObservable<string>
  }
  /** Open the stream again after it ended. */
  readonly reconnect: () => void
  /**
   * Reinspect the checkout, probe sign-in, and poll the change requests;
   * settles once the Host has inspected and probed, after reporting a failure.
   */
  readonly refresh: () => Promise<void>
  /** Remove a change request from the Session, offering to undo it. */
  readonly remove: (entry: ForgePanelChangeRequest) => void
  /** Mark a draft ready for review; settles once the outcome is reported. */
  readonly markReady: (entry: ForgePanelChangeRequest) => Promise<void>
  /** Merge a change request as `request` describes; settles once the outcome is reported. */
  readonly merge: (entry: ForgePanelChangeRequest, request: MergeRequest) => Promise<void>
  /** Read the complete checks of an opened change request. */
  readonly readChecks: NonNullable<ChangeRequestActions['readChecks']>
  /** Rerun the failed checks or one check; settles once the outcome is reported. */
  readonly rerunChecks: NonNullable<ChangeRequestActions['rerunChecks']>
  /** Request reviews from more reviewers; settles once the outcome is reported. */
  readonly requestReviews: NonNullable<ChangeRequestActions['requestReviews']>
  /** List accounts a review can be requested from. */
  readonly reviewerCandidates: NonNullable<ChangeRequestActions['reviewerCandidates']>
  /** Bring the base branch's new commits into the head branch; settles once the outcome is reported. */
  readonly updateBranch: NonNullable<ChangeRequestActions['updateBranch']>
  /** Open a URL outside the app. */
  readonly openLink: (url: string) => void
  /** Copy text to the clipboard and report the outcome. */
  readonly copyText: (text: string) => void
  /** Open the changes view of a bound change request in the right sidebar. */
  readonly viewChanges: (entry: ForgePanelChangeRequest) => void
}

/** Full props of the change requests section. */
export type ChangeRequestsSectionProps =
  PropsRuntime<'conversation.session.panel.section'>
  & InjectFace<ChangeRequestsSectionInjected>
  & PropsStore<ReturnType<typeof createChangeRequestsSectionStore>>
  & PropsLocale<typeof NS>

/** Business face of the section's title control. */
export interface ChangeRequestsActionsInjected {
  /** Panel snapshot of the Session; bound as `usePanel`. */
  readonly hooks: { readonly panel: HostObservable<PanelSnapshot> }
}

/** Full props of the section's title control. */
export type ChangeRequestsActionsProps =
  PropsRuntime<'conversation.session.panel.section.actions'>
  & InjectFace<ChangeRequestsActionsInjected>
  & PropsLocale<typeof NS>

type Translate = ChangeRequestsSectionProps['t']

function SignIn({ state, copyText, t }: {
  readonly state: ForgePanelState
  readonly copyText: (text: string) => void
  readonly t: Translate
}): ReactNode {
  const { repository, readiness } = state
  if (repository === null || readiness === null || readiness.state === 'ready') return null
  const host = repository.host
  if (readiness.state === 'unavailable') {
    return <div className={css.banner} role="status">{t('signin.unavailable', { host, message: readiness.message ?? '' })}</div>
  }
  const command = repository.forge === 'github' ? `gh auth login --hostname ${host}` : undefined
  return (
    <div className={css.banner} role="status">
      <span>{t('signin.title', { host })}</span>
      {command === undefined
        ? readiness.message !== null && <span className={css.bannerDetail}>{readiness.message}</span>
        : (
          <>
            <code className={css.bannerCommand}>{command}</code>
            <Button size="sm" variant="outline" className={css.bannerAction} onClick={() => { copyText(command) }}>
              {t('signin.copy')}
            </Button>
          </>
        )}
    </div>
  )
}

/**
 * Render the Session's change request cards. The section shows only while the
 * Session binds at least one change request; the sign-in notice and a lost
 * stream show above the cards. A card starts expanded when the Session binds
 * exactly one change request; a card the user expands or collapses keeps that
 * choice in the Session's store, across updates and while the panel is hidden.
 * Viewing changes closes the panel's overlay.
 * @param props - panel snapshot hooks, card actions, panel owner values, and copy.
 * @returns the cards, or null without bound change requests.
 */
export function ChangeRequestsSection({
  usePanel, useLocale, dismissOverlay, reconnect, refresh, remove, markReady, merge, readChecks,
  rerunChecks, requestReviews, reviewerCandidates, updateBranch, openLink, copyText, viewChanges, useStore, actions: store, t,
}: ChangeRequestsSectionProps): ReactNode {
  const snapshot = usePanel(current => current)
  const locale = useLocale(value => value)
  const chosen = useStore(current => current.expanded)
  const state = snapshot.state
  if (state === null || state.changeRequests.length === 0) return null
  const actions: ChangeRequestActions = {
    openLink, copyLink: copyText, retry: () => { void refresh() }, remove, markReady, merge, readChecks,
    rerunChecks, requestReviews, reviewerCandidates, updateBranch,
    viewChanges: (entry) => {
      viewChanges(entry)
      dismissOverlay()
    },
  }
  const defaults = defaultExpanded(state.changeRequests)
  const expanded = (url: string): boolean => chosen[url] ?? defaults.has(url)
  const toggle = (url: string): void => { store.toggled(url, !expanded(url)) }
  const now = Date.now()
  return (
    <div className={css.cards} data-forge-panel="">
      {snapshot.disconnected && (
        <div className={css.disconnected} role="status">
          <span>{t('stream.failed')}</span>
          <Button size="sm" variant="outline" onClick={reconnect}>{t('retry')}</Button>
        </div>
      )}
      <SignIn state={state} copyText={copyText} t={t} />
      <ul className={css.list}>
        {state.changeRequests.map(entry => (
          <ChangeRequestCard
            key={entry.url}
            entry={entry}
            expanded={expanded(entry.url)}
            onToggle={() => { toggle(entry.url) }}
            now={now}
            actions={actions}
            locale={locale}
            t={t}
          />
        ))}
      </ul>
    </div>
  )
}

/**
 * Render the change request count beside the section title.
 * @param props - panel snapshot hook.
 * @returns the count, or null without bound change requests.
 */
export function ChangeRequestsActions({ usePanel }: ChangeRequestsActionsProps): ReactNode {
  const count = usePanel(snapshot => snapshot.state?.changeRequests.length ?? 0)
  if (count === 0) return null
  return <span className={css.count}>{count}</span>
}
