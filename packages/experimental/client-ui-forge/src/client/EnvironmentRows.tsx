/** Environment section entries: the Session's checkout and its branch changes, and the section's refresh. */

import { useState, type ReactNode } from 'react'
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
import { RefreshButton } from './RefreshButton.tsx'
import { openChangeRequestOf } from './status.ts'
import css from './Forge.module.css'

/** Business face of the Environment section's title control. */
export interface EnvironmentActionsInjected {
  /** Panel snapshot of the Session; bound as `usePanel`. */
  readonly hooks: { readonly panel: HostObservable<PanelSnapshot> }
  /** Reinspect the checkout, probe sign-in, and poll the change requests; settles once the Host has inspected and probed. */
  readonly refresh: () => Promise<void>
}

/** Full props of the Environment section's title control. */
export type EnvironmentActionsProps =
  PropsRuntime<'conversation.session.panel.section.actions'>
  & InjectFace<EnvironmentActionsInjected>
  & PropsLocale<typeof NS>

/** Business face of the checkout row. */
export interface CheckoutRowInjected {
  /** Panel snapshot of the Session and the Host facts; bound as `usePanel` and `useHost`. */
  readonly hooks: {
    readonly panel: HostObservable<PanelSnapshot>
    readonly host: HostObservable<RemoteHostFacts>
  }
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
 * Render a refresh button beside the Environment title once the panel state
 * arrived, so a checkout changed outside the Session can be inspected again.
 * @param props - panel snapshot hook, refresh, and copy.
 * @returns the button, or null before the first state.
 */
export function EnvironmentActions({ usePanel, refresh, t }: EnvironmentActionsProps): ReactNode {
  const known = usePanel(snapshot => snapshot.state !== null)
  if (!known) return null
  return <RefreshButton refresh={refresh} label={t('refresh')} />
}

/**
 * Render the branch the Session works on and the kind of its directory. The
 * row and its More button open the shared directory menu on the checkout
 * root; a removed worktree offers Restore instead, and a failed inspection
 * shows a warning whose tooltip carries the failure.
 * @param props - panel snapshot and Host facts hooks, restore, menu bindings, and copy.
 * @returns the row, or null before the first inspection and outside a Git checkout.
 */
export function CheckoutRow({
  sessionId, usePanel, useHost, useContextMenu, renderFactorySlot, restore, t,
}: CheckoutRowProps): ReactNode {
  const state = usePanel(snapshot => snapshot.state)
  const home = useHost(facts => facts.home)
  const { getTriggerProps } = useContextMenu()
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
          {label.missing
            ? (
              <Button
                size="sm"
                variant="outline"
                disabled={state.worktree.restoration !== null}
                icon={state.worktree.restoration === null ? undefined : <StateDot state="ongoing" size={14} />}
                onClick={restore}
              >
                {t('checkout.restore')}
              </Button>
            )
            : renderFactorySlot('contextMenu.button', {
              target,
              label: t(label.worktree ? 'checkout.worktreeActions' : 'checkout.projectActions'),
              className: css.envMore,
              size: 'sm',
            })}
        </>
      )}
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
        <>
          <span className={css.diff}>
            <span className={css.added}>{`+${String(additions)}`}</span>
            <span className={css.deleted}>{`−${String(deletions)}`}</span>
          </span>
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
        </>
      )}
    >
      {t('changes.local.summary', { count })}
    </PanelRow>
  )
}
