/** Environment section rows: the Session's checkout, its branch changes, and a lost panel stream. */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconBranchOutlineRegular, IconEllipsisOutlineRegular, IconFilesDiffOutlineRegular, IconWarningTriangleOutlineRegular,
  MarqueeText, Menu, StateDot, Tooltip, useHoverMarquee,
} from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type {} from '@deepseek-ai/dsh-client-ui-session-panel/client'
import { checkoutLabel } from './checkout.ts'
import type { NS } from './locales.ts'
import type { PanelSnapshot } from './source.ts'
import { ReasonButton } from './ReasonButton.tsx'
import { openChangeRequestOf } from './status.ts'
import css from './Forge.module.css'

/** Business face of the checkout row. */
export interface CheckoutRowInjected {
  /** Panel snapshot of the Session and the Host facts; bound as `usePanel` and `useHost`. */
  readonly hooks: {
    readonly panel: HostObservable<PanelSnapshot>
    readonly host: HostObservable<RemoteHostFacts>
  }
  /**
   * Reinspect the checkout, probe sign-in, and poll the change requests,
   * unless an automatic refresh of this Session ran in the last 10 seconds.
   */
  readonly refreshIfStale: () => void
  /** Check the removed worktree of the Session out again, reporting the outcome. */
  readonly restore: () => void
}

/** Full props of the checkout row. */
export type CheckoutRowProps =
  PropsRuntime<'conversation.session.panel.environment.row'>
  & PropsRenderFactories
  & InjectFace<CheckoutRowInjected>
  & PropsLocale<typeof NS>

/** Business face of the local changes row. */
export interface LocalChangesRowInjected {
  /** Panel snapshot of the Session; bound as `usePanel`. */
  readonly hooks: { readonly panel: HostObservable<PanelSnapshot> }
  /** Open the local changes view in the right sidebar. */
  readonly viewLocalChanges: () => void
  /** Ask the Session's Agent to create a change request for its changes, reporting the outcome. */
  readonly createChangeRequest: () => void
}

/** Full props of the local changes row. */
export type LocalChangesRowProps =
  PropsRuntime<'conversation.session.panel.environment.row'>
  & InjectFace<LocalChangesRowInjected>
  & PropsLocale<typeof NS>

/**
 * Render the branch the Session works on and the kind of its directory. The
 * row and its More button open the shared directory menu on the checkout
 * root; a removed worktree offers Restore instead, and a failed inspection
 * shows a warning whose tooltip carries the failure. Tooltips show after
 * 500ms of hover, and a branch name the row clips crawls into view while the
 * pointer rests on the row. The row is mounted
 * whenever the panel shows, so it refreshes the Session's forge state when
 * the panel opens and when the window regains focus, which picks up changes
 * made outside the Session.
 * @param props - panel snapshot and Host facts hooks, refresh, restore, menu bindings, and copy.
 * @returns the row, or null before the first inspection and outside a Git checkout.
 */
export function CheckoutRow({
  sessionId, usePanel, useHost, useContextMenu, renderFactorySlot, refreshIfStale, restore, t,
}: CheckoutRowProps): ReactNode {
  const state = usePanel(snapshot => snapshot.state)
  const home = useHost(facts => facts.home)
  const { getTriggerProps } = useContextMenu()
  const nameRef = useRef<HTMLSpanElement>(null)
  const marquee = useHoverMarquee(nameRef)
  useEffect(() => {
    refreshIfStale()
    const onVisibility = (): void => { if (document.visibilityState === 'visible') refreshIfStale() }
    window.addEventListener('focus', refreshIfStale)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', refreshIfStale)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refreshIfStale])
  if (state === null) return null
  const label = checkoutLabel(state, home, t)
  if (label === undefined) {
    if (state.checkout.state !== 'failed') return null
    return (
      <div className={css.envRow} data-session-panel-row="" data-forge-checkout="" data-failed="">
        <span data-row-part="body">
          <span data-row-part="icon" aria-hidden="true"><IconWarningTriangleOutlineRegular size={16} /></span>
          <span data-row-part="content"><span className={css.envName}>{t('checkout.failed')}</span></span>
        </span>
        <span data-row-part="trailing"><ReasonButton reason={state.checkout.message} label={t('reason.show')} /></span>
      </div>
    )
  }
  const target = { kind: 'directory', value: { sessionId, path: label.path } } as const
  const name = [label.detached ? t('checkout.detached') : undefined, label.name ?? undefined]
    .filter(part => part !== undefined).join(' · ')
  return (
    <div
      {...getTriggerProps(target)}
      className={css.envRow}
      data-session-panel-row=""
      data-forge-checkout=""
      data-missing={label.missing ? '' : undefined}
      {...marquee}
    >
      <span data-row-part="body">
        <span data-row-part="icon" aria-hidden="true">
          {label.missing ? <IconWarningTriangleOutlineRegular size={16} /> : <IconBranchOutlineRegular size={16} />}
        </span>
        <span data-row-part="content">
          <Tooltip label={label.tooltip} side="left" delayMs={500}>
            <MarqueeText ref={nameRef} className={css.envName} tabIndex={0}>{name}</MarqueeText>
          </Tooltip>
        </span>
      </span>
      <span data-row-part="trailing">
        <span className={css.envNote}>{label.kind}</span>
        {label.missing && (
          <Button
            size="sm"
            variant="outline"
            disabled={state.worktree.restoration !== null}
            icon={state.worktree.restoration === null ? undefined : <StateDot state="ongoing" size={14} />}
            onClick={restore}
          >
            {t('checkout.restore')}
          </Button>
        )}
      </span>
      {!label.missing && (
        <span data-row-part="menu">
          {renderFactorySlot('contextMenu.button', {
            target,
            label: t(label.worktree ? 'checkout.worktreeActions' : 'checkout.projectActions'),
          })}
        </span>
      )}
    </div>
  )
}

/** Business face of the connection row. */
export interface ConnectionRowInjected {
  /** Panel snapshot of the Session; bound as `usePanel`. */
  readonly hooks: { readonly panel: HostObservable<PanelSnapshot> }
  /** Open the stream again after it ended. */
  readonly reconnect: () => void
}

/** Full props of the connection row. */
export type ConnectionRowProps =
  PropsRuntime<'conversation.session.panel.environment.row'>
  & InjectFace<ConnectionRowInjected>
  & PropsLocale<typeof NS>

/**
 * Say that the Session's panel stream ended, so the Git and change request
 * details may be out of date, whether or not it delivered a state first; Retry
 * opens the stream again. Assistive technology announces the row when it shows.
 * @param props - panel snapshot hook, reconnect action, and copy.
 * @returns the row, or null while the stream is open.
 */
export function ConnectionRow({ usePanel, reconnect, t }: ConnectionRowProps): ReactNode {
  const disconnected = usePanel(snapshot => snapshot.disconnected)
  if (!disconnected) return null
  return (
    <div className={css.envRow} role="status" data-session-panel-row="" data-forge-connection="">
      <span data-row-part="body">
        <span data-row-part="icon" aria-hidden="true"><IconWarningTriangleOutlineRegular size={16} /></span>
        <span data-row-part="lines">
          <span data-row-part="content"><span className={css.statusTitle}>{t('connection.title')}</span></span>
          <span data-row-part="detail">{t('connection.detail')}</span>
        </span>
      </span>
      <span data-row-part="trailing"><Button size="sm" variant="outline" onClick={reconnect}>{t('retry')}</Button></span>
    </div>
  )
}

/**
 * Render the size of the branch's changes, zero included, or the row's name alone while the `branch` scope has no fork
 * point; the row opens the local changes view, where another scope or branch can be shown, and its menu offers the
 * view and, without an open change request for the branch, asking the Agent to create one. Opening the view closes
 * the panel's overlay.
 * @param props - panel snapshot hook, view and create actions, panel owner values, and copy.
 * @returns the row, or null outside a Git checkout and before the first inspection ends.
 */
export function LocalChangesRow({
  usePanel, dismissOverlay, viewLocalChanges, createChangeRequest, t,
}: LocalChangesRowProps): ReactNode {
  const local = usePanel(snapshot => snapshot.state?.local ?? null)
  const creatable = usePanel(snapshot => snapshot.state !== null && snapshot.state.repository !== null
    && openChangeRequestOf(snapshot.state) === undefined)
  const inCheckout = usePanel(snapshot => snapshot.state?.checkout.state === 'ready')
  const [open, setOpen] = useState(false)
  if (!inCheckout) return null
  let additions = 0
  let deletions = 0
  for (const file of local?.files ?? []) {
    additions += file.additions
    deletions += file.deletions
  }
  const count = local?.files.length ?? 0
  const view = (): void => {
    viewLocalChanges()
    dismissOverlay()
  }
  return (
    <div className={css.envRow} data-session-panel-row="" data-forge-local="">
      <button
        type="button"
        data-row-part="body"
        aria-label={local === null ? t('changes.local.title') : t('changes.local.viewAria', { count, added: additions, deleted: deletions })}
        onClick={view}
      >
        <span data-row-part="icon" aria-hidden="true"><IconFilesDiffOutlineRegular size={16} /></span>
        <span data-row-part="content">{count === 0 ? t('changes.local.title') : t('changes.local.summary', { count })}</span>
      </button>
      {/* Without a fork point the `branch` scope has no size; the view still shows the other scopes and takes a base. */}
      {local !== null && (
        <span data-row-part="trailing">
          <span className={css.diff}>
            <span className={css.added}>{`+${String(additions)}`}</span>
            <span className={css.deleted}>{`−${String(deletions)}`}</span>
          </span>
        </span>
      )}
      <span data-row-part="menu">
        <Menu
          open={open}
          onClose={() => { setOpen(false) }}
          portal
          align="end"
          anchor={(
            <button
              type="button"
              aria-label={t('changes.local.actions')}
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => { setOpen(!open) }}
            >
              <IconEllipsisOutlineRegular />
            </button>
          )}
          items={[
            { id: 'view', label: t('change.viewChanges') },
            ...creatable ? [{ id: 'create', label: t('changes.local.create') }] : [],
          ]}
          onSelect={(id) => {
            setOpen(false)
            if (id === 'create') createChangeRequest()
            else view()
          }}
        />
      </span>
    </div>
  )
}
