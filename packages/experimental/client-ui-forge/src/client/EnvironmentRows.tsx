/** Environment section rows: the Session's checkout, its branch changes, and a lost panel stream. */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconBranchOutlineRegular, IconEllipsisOutlineRegular, IconFilesDiffOutlineRegular, IconWarningTriangleOutlineRegular,
  MarqueeText, Menu, StateDot, Tooltip, useHoverMarquee,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
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
  & PropsRenderFactories
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
    return renderFactorySlot('conversation.session.panel.row', {
      className: css.envRow,
      icon: <IconWarningTriangleOutlineRegular size={16} />,
      attributes: { 'data-forge-checkout': '', 'data-failed': '' },
      trailing: <ReasonButton reason={state.checkout.message} label={t('reason.show')} />,
      children: <span className={css.envName}>{t('checkout.failed')}</span>,
    })
  }
  const target = { kind: 'directory', value: { sessionId, path: label.path } } as const
  const icon = label.missing
    ? <IconWarningTriangleOutlineRegular size={16} />
    : <IconBranchOutlineRegular size={16} />
  const name = [label.detached ? t('checkout.detached') : undefined, label.name ?? undefined]
    .filter(part => part !== undefined).join(' · ')
  return renderFactorySlot('conversation.session.panel.row', {
    className: css.envRow,
    icon,
    attributes: {
      ...getTriggerProps(target),
      'data-forge-checkout': '',
      'data-missing': label.missing ? '' : undefined,
      onPointerEnter: marquee.enter,
      onPointerLeave: marquee.leave,
    },
    trailing: (
      <>
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
      </>
    ),
    menu: label.missing ? undefined : renderFactorySlot('contextMenu.button', {
      target,
      label: t(label.worktree ? 'checkout.worktreeActions' : 'checkout.projectActions'),
    }),
    children: (
      <Tooltip label={label.tooltip} side="left" delayMs={500}>
        <MarqueeText ref={nameRef} className={css.envName} tabIndex={0}>{name}</MarqueeText>
      </Tooltip>
    ),
  })
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
  & PropsRenderFactories
  & InjectFace<ConnectionRowInjected>
  & PropsLocale<typeof NS>

/**
 * Say that the Session's panel stream ended, so the Git and change request
 * details may be out of date, whether or not it delivered a state first; Retry
 * opens the stream again. Assistive technology announces the row when it shows.
 * @param props - panel snapshot hook, reconnect action, and copy.
 * @returns the row, or null while the stream is open.
 */
export function ConnectionRow({ usePanel, reconnect, renderFactorySlot, t }: ConnectionRowProps): ReactNode {
  const disconnected = usePanel(snapshot => snapshot.disconnected)
  if (!disconnected) return null
  return renderFactorySlot('conversation.session.panel.row', {
    className: css.envRow,
    icon: <IconWarningTriangleOutlineRegular size={16} />,
    attributes: { role: 'status', 'data-forge-connection': '' },
    detail: t('connection.detail'),
    trailing: <Button size="sm" variant="outline" onClick={reconnect}>{t('retry')}</Button>,
    children: <span className={css.statusTitle}>{t('connection.title')}</span>,
  })
}

/**
 * Render the size of the branch's changes; the row opens the local changes
 * view, and its menu offers the view and, without an open change request for
 * the branch, asking the Agent to create one. Opening the view closes the
 * panel's overlay.
 * @param props - panel snapshot hook, view and create actions, panel owner values, and copy.
 * @returns the row, or null while the branch changes no files.
 */
export function LocalChangesRow({
  usePanel, dismissOverlay, viewLocalChanges, createChangeRequest, renderFactorySlot, t,
}: LocalChangesRowProps): ReactNode {
  const local = usePanel(snapshot => snapshot.state?.local ?? null)
  const creatable = usePanel(snapshot => snapshot.state !== null && snapshot.state.repository !== null
    && openChangeRequestOf(snapshot.state) === undefined)
  const [open, setOpen] = useState(false)
  if (local === null || local.files.length === 0) return null
  let additions = 0
  let deletions = 0
  for (const file of local.files) {
    additions += file.additions
    deletions += file.deletions
  }
  const count = local.files.length
  const view = (): void => {
    viewLocalChanges()
    dismissOverlay()
  }
  return renderFactorySlot('conversation.session.panel.row', {
    className: css.envRow,
    icon: <IconFilesDiffOutlineRegular size={16} />,
    onActivate: view,
    actionLabel: t('changes.local.viewAria', { count, added: additions, deleted: deletions }),
    attributes: { 'data-forge-local': '' },
    trailing: (
      <span className={css.diff}>
        <span className={css.added}>{`+${String(additions)}`}</span>
        <span className={css.deleted}>{`−${String(deletions)}`}</span>
      </span>
    ),
    menu: (
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
    ),
    children: t('changes.local.summary', { count }),
  })
}
