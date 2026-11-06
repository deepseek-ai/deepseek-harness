/** Environment section rows: the Session's checkout and its branch changes. */

import { useEffect, useState, type ReactNode } from 'react'
import {
  Button, IconBranchOutlineRegular, IconEllipsisOutlineRegular, IconListPenOutlineRegular, IconWarningTriangleOutlineRegular,
  Menu, PanelRow, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type {} from '@deepseek-ai/dsh-client-ui-session-panel/client'
import { checkoutLabel } from './checkout.ts'
import type { NS } from './locales.ts'
import type { PanelSnapshot } from './source.ts'
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
 * shows a warning whose tooltip carries the failure. The row is mounted
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
      <PanelRow className={css.envRow} icon={<IconWarningTriangleOutlineRegular size={16} />} data-forge-checkout="" data-failed="">
        <Tooltip label={state.checkout.message} side="left">
          <span className={css.envName} tabIndex={0}>{t('checkout.failed')}</span>
        </Tooltip>
      </PanelRow>
    )
  }
  const target = { kind: 'directory', value: { sessionId, path: label.path } } as const
  const icon = label.missing
    ? <IconWarningTriangleOutlineRegular size={16} />
    : <IconBranchOutlineRegular size={16} />
  const name = [label.detached ? t('checkout.detached') : undefined, label.name ?? undefined]
    .filter(part => part !== undefined).join(' · ')
  return (
    <PanelRow
      {...getTriggerProps(target)}
      className={css.envRow}
      icon={icon}
      data-forge-checkout=""
      data-missing={label.missing ? '' : undefined}
      trailing={(
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
      )}
      menu={label.missing ? undefined : renderFactorySlot('contextMenu.button', {
        target,
        label: t(label.worktree ? 'checkout.worktreeActions' : 'checkout.projectActions'),
        size: 'sm',
      })}
    >
      <Tooltip label={label.tooltip} side="left">
        <span className={css.envName} tabIndex={0}>{name}</span>
      </Tooltip>
    </PanelRow>
  )
}

/**
 * Render the size of the branch's changes; the row opens the local changes
 * view, and its menu offers the view and, without an open change request for
 * the branch, asking the Agent to create one. Opening the view closes the
 * panel's overlay.
 * @param props - panel snapshot hook, view and create actions, panel owner values, and copy.
 * @returns the row, or null while the branch changes no files.
 */
export function LocalChangesRow({ usePanel, dismissOverlay, viewLocalChanges, createChangeRequest, t }: LocalChangesRowProps): ReactNode {
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
  return (
    <PanelRow
      className={css.envRow}
      icon={<IconListPenOutlineRegular size={16} />}
      onActivate={view}
      actionLabel={t('changes.local.viewAria', { count, added: additions, deleted: deletions })}
      data-forge-local=""
      trailing={(
        <span className={css.diff}>
          <span className={css.added}>{`+${String(additions)}`}</span>
          <span className={css.deleted}>{`−${String(deletions)}`}</span>
        </span>
      )}
      menu={(
        <Menu
          open={open}
          onClose={() => { setOpen(false) }}
          portal
          align="end"
          anchor={(
            <button
              type="button"
              className={`${css.iconButton} ${css.envMore}`}
              aria-label={t('changes.local.actions')}
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => { setOpen(!open) }}
            >
              <IconEllipsisOutlineRegular size={14} />
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
      )}
    >
      {t('changes.local.summary', { count })}
    </PanelRow>
  )
}
