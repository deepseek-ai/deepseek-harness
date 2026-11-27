/** Session panel section listing the Session's change requests, and its title control. */

import { useCallback, useRef, type ReactNode } from 'react'
import {
  Button, HoverCardGroup, IconWarningTriangleOutlineRegular, MarqueeText, useHoverMarquee,
} from '@deepseek-ai/dsh-client-ui-primitives/client'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots/client'
import type { ForgeReadiness, MergeRequest } from '@deepseek-ai/dsh-experimental-forge/types'
import type { PanelDetailsProps } from '@deepseek-ai/dsh-client-ui-session-panel/client'
// Type-only: the `useMediaQuery` standard prop merge.
import type {} from '@deepseek-ai/dsh-client-ui-responsive/client'
import type { ForgePanelState } from '../types.ts'
import { ChangeRequestCard, type ChangeRequestActions } from './ChangeRequestCard.tsx'
import type { createChangeRequestsSectionStore } from './change-requests-store.ts'
import type { NS } from './locales.ts'
import { ReasonButton } from './ReasonButton.tsx'
import type {} from './slots.ts'
import type { PanelSnapshot } from './source.ts'
import { defaultExpanded, type ChangeRequestEntry } from './status.ts'
import css from './Forge.module.css'

/** Business face of the change requests section. */
export interface ChangeRequestsSectionInjected {
  /** Panel snapshot of the Session and the active language; bound as `usePanel` and `useLocale`. */
  readonly hooks: {
    readonly panel: HostObservable<PanelSnapshot>
    readonly locale: HostObservable<string>
  }
  /**
   * Reinspect the checkout, probe sign-in, and poll the change requests;
   * settles once the Host has inspected and probed, after reporting a failure.
   */
  readonly refresh: () => Promise<void>
  /** Remove a change request from the Session, offering to undo it. */
  readonly remove: (entry: ChangeRequestEntry) => void
  /** Mark a draft ready for review; settles once the outcome is reported. */
  readonly markReady: (entry: ChangeRequestEntry) => Promise<void>
  /** Merge a change request as `request` describes; settles once the outcome is reported. */
  readonly merge: (entry: ChangeRequestEntry, request: MergeRequest) => Promise<void>
  /** Turn a change request's automatic merge on or off; settles once the outcome is reported. */
  readonly autoMerge: NonNullable<ChangeRequestActions['autoMerge']>
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
  readonly viewChanges: (entry: ChangeRequestEntry) => void
}

/** Full props of the change requests section. */
export type ChangeRequestsSectionProps =
  PropsRuntime<'conversation.session.panel.section'>
  & Pick<PropsRenderSlots<'forge.change-request.card.actions'>, 'renderSlot'>
  & PropsRenderFactories
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

/** Cards the list shows before its fold control holds the rest back. */
const FOLD_LIMIT = 3

/** Sign-in the repository's host still needs before its change requests show. */
interface SignInNeed {
  readonly host: string
  readonly readiness: ForgeReadiness
}

function signInNeedOf(state: ForgePanelState): SignInNeed | null {
  const { repository, readiness } = state
  if (repository === null || readiness === null || readiness.state === 'ready') return null
  return { host: repository.host, readiness }
}

/**
 * The status row above the cards while the host cannot serve the change
 * requests yet: sign-in, with the command to copy when the provider names
 * one, or a failed sign-in check. A reason the host gave shows from the info button; a clipped
 * title or command crawls into view while the pointer rests on the row.
 */
function SignInRow({ need, copyText, t }: {
  readonly need: SignInNeed
  readonly copyText: (text: string) => void
  readonly t: Translate
}): ReactNode {
  const titleRef = useRef<HTMLSpanElement>(null)
  const commandRef = useRef<HTMLSpanElement>(null)
  const titleMarquee = useHoverMarquee(titleRef)
  const commandMarquee = useHoverMarquee(commandRef)
  const { host, readiness } = need
  const unavailable = readiness.state === 'unavailable'
  const command = unavailable ? undefined : readiness.signIn?.command
  const marquee = command === undefined ? titleMarquee : commandMarquee
  let trailing: ReactNode
  if (command !== undefined) {
    trailing = (
      <Button size="sm" variant="outline" aria-label={t('signin.copy')} onClick={() => { copyText(command) }}>
        {t('signin.copyShort')}
      </Button>
    )
  }
  else if (readiness.message !== null && readiness.message !== '') {
    trailing = <ReasonButton reason={readiness.message} label={t('reason.show')} />
  }
  const title = (
    <span data-row-part="content">
      <MarqueeText ref={titleRef} className={css.statusTitle}>{t(unavailable ? 'signin.unavailable' : 'signin.title', { host })}</MarqueeText>
    </span>
  )
  return (
    <div role="status" data-session-panel-row="" data-forge-signin={readiness.state} {...marquee}>
      <span data-row-part="body">
        <span data-row-part="icon" aria-hidden="true"><IconWarningTriangleOutlineRegular size={16} /></span>
        {command === undefined ? title : (
          <span data-row-part="lines">
            {title}
            <span data-row-part="detail"><MarqueeText ref={commandRef} className={css.signinCommand}>{command}</MarqueeText></span>
          </span>
        )}
      </span>
      {trailing !== undefined && <span data-row-part="trailing">{trailing}</span>}
    </div>
  )
}

/**
 * Render the Session's change request cards. The section shows while the
 * Session binds a change request or the repository's host needs sign-in, which
 * a status row above the cards says; a lost stream shows in the Environment
 * section instead. The list shows three cards and then the panel's fold
 * control, which shows the rest; the choice is kept per Session. A card starts
 * expanded when the Session binds exactly one change request; a card the user
 * expands or collapses keeps that choice in the Session's store, across
 * updates and while the panel is hidden. Viewing changes closes the panel's
 * overlay.
 * @param props - panel snapshot hooks, card actions, panel owner values, the media query hook, the store, and copy.
 * @returns the cards, or null with neither bound change requests nor a sign-in to complete.
 */
export function ChangeRequestsSection({
  usePanel, useLocale, dismissOverlay, refresh, remove, markReady, merge, autoMerge, readChecks,
  rerunChecks, requestReviews, reviewerCandidates, updateBranch, openLink, copyText, viewChanges, useStore, actions: store, renderSlot,
  renderFactorySlot, useMediaQuery, t,
}: ChangeRequestsSectionProps): ReactNode {
  const snapshot = usePanel(current => current)
  const locale = useLocale(value => value)
  const coarsePointer = useMediaQuery('(pointer: coarse)')
  const chosen = useStore(current => current.expanded)
  const unfolded = useStore(current => current.unfolded)
  const renderDetails = useCallback(
    (details: PanelDetailsProps) => renderFactorySlot('conversation.session.panel.details', details), [renderFactorySlot],
  )
  const state = snapshot.state
  if (state === null) return null
  const signIn = signInNeedOf(state)
  if (signIn === null && state.changeRequests.length === 0) return null
  const actions: ChangeRequestActions = {
    openLink, copyLink: copyText, retry: () => { void refresh() }, remove, markReady, merge, autoMerge, readChecks,
    rerunChecks, requestReviews, reviewerCandidates, updateBranch,
    viewChanges: (entry) => {
      viewChanges(entry)
      dismissOverlay()
    },
    renderActions: owner => renderSlot('forge.change-request.card.actions', owner),
    renderDetails,
  }
  const defaults = defaultExpanded(state.changeRequests)
  const expanded = (url: string): boolean => chosen[url] ?? defaults.has(url)
  const toggle = (url: string): void => { store.toggled(url, !expanded(url)) }
  const now = Date.now()
  const foldable = state.changeRequests.length > FOLD_LIMIT
  const shown = foldable && !unfolded ? state.changeRequests.slice(0, FOLD_LIMIT) : state.changeRequests
  const label = unfolded ? t('fold.less') : t('fold.more', { count: state.changeRequests.length - FOLD_LIMIT })
  return (
    <div className={css.cards} data-forge-panel="">
      {signIn !== null && <SignInRow need={signIn} copyText={copyText} t={t} />}
      {shown.length > 0 && (
        // Moving between cards swaps their hover cards without another dwell.
        <HoverCardGroup>
          <ul className={css.list}>
            {shown.map(entry => (
              <ChangeRequestCard
                key={entry.url}
                entry={entry}
                expanded={expanded(entry.url)}
                onToggle={() => { toggle(entry.url) }}
                now={now}
                actions={actions}
                locale={locale}
                coarsePointer={coarsePointer}
                t={t}
              />
            ))}
          </ul>
        </HoverCardGroup>
      )}
      {foldable && renderFactorySlot('conversation.session.panel.fold', {
        expanded: unfolded,
        label,
        name: t('fold.name', { label }),
        onToggle: () => { store.unfoldedSet(!unfolded) },
      })}
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
