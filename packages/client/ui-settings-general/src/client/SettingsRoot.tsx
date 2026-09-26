/**
 * Settings shell root: the sidebar-foot trigger row plus the centered modal
 * panel (figma 2552:26025, 760x500) with the section nav rail. The shell is
 * a pure composition face — slot-owned text (trigger label, panel title,
 * close label, sections) arrives from registrants through slots; accessible
 * names resolve from localized content (trigger: shell locale; dialog:
 * aria-labelledby the title node; close: visually-hidden slot text). Modal
 * open state and the active section id belong to the declared owner store;
 * the onboarding coordinator mounts exactly one ordered registrant while the
 * sessions-derived empty-Hero fact is active. Visible dialog chrome belongs
 * to the step, so a mounted-but-deciding step paints nothing here.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import {
  ConnectionIndicator, Tooltip, useModalLayer,
  IconAgentPresetOutlineMedium, IconArchiveOutlineMedium, IconCloseOutlineRegular, IconDataOutlineMedium,
  IconPersonalizationOutlineMedium, IconSettingsOutlineMedium, IconUserOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectionIndicatorState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsRootComponentProps, SettingsSectionRow } from './shell-contract.ts'
import css from './SettingsRoot.module.css'
import { DesktopUpdateIndicator } from './DesktopUpdateIndicator.tsx'

const RECOVERY_CONFIRMATION_MS = 2_000

/** Minimum visible time for the connecting pill; shorter attempts read as flicker. */
const CONNECTING_MIN_VISIBLE_MS = 800

/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id: string) {
  if (id === 'account') return <IconUserOutlineMedium className={css.navIcon} size={16} />
  if (id === 'models') return <IconDataOutlineMedium className={css.navIcon} size={16} />
  if (id === 'agent-presets') return <IconAgentPresetOutlineMedium className={css.navIcon} size={16} />
  if (id === 'plugins') return <IconPersonalizationOutlineMedium className={css.navIcon} size={16} />
  if (id === 'archived-sessions') return <IconArchiveOutlineMedium className={css.navIcon} size={16} />
  return <IconSettingsOutlineMedium className={css.navIcon} size={16} />
}

type PanelProps = {
  rows: readonly SettingsSectionRow[]
  renderSlot: SettingsRootComponentProps['renderSlot']
  activeId: string | undefined
  onSelect: (id: string) => void
  onClose: () => void
}

/**
 * Body-portaled modal layer: full-viewport mask + centered panel. Close paths: the
 * header button, a mask click, and document-level Escape (mounted only while
 * open, so the listener lifetime is the panel's).
 */
function SettingsPanel({ rows, renderSlot, activeId, onSelect, onClose }: PanelProps) {
  // Entries can unmount underneath the requested id, so the render-time
  // projection falls back to the first row when the id is gone.
  const active = rows.find(r => r.id === activeId)?.id ?? rows[0]?.id
  const titleId = useId()

  const panel = useRef<HTMLDivElement>(null)
  useModalLayer(panel, true, onClose)

  // Portalled beside #root like the Modal primitive: a covering surface mounted
  // inside the root would precede the columns' chrome in document order, so a
  // chrome row that declares window drag after it would override its subtraction.
  // Beside the root, base.css's `body > :not(#root)` rule subtracts it instead.
  return createPortal((
    <div className={css.overlay} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div ref={panel} tabIndex={-1} data-shortcut-modal="settings" className={css.panel} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <nav className={css.nav}>
          <div className={css.navTitle} id={titleId} tabIndex={-1}
            data-modal-autofocus={active === undefined ? '' : undefined}>{renderSlot('settings.header', {})}</div>
          <div className={css.navList}>
            {rows.map(row => (
              <button
                key={row.id}
                type="button"
                className={clsx(css.navCell, row.id === active && css.active)}
                aria-current={row.id === active ? 'true' : undefined}
                data-modal-autofocus={row.id === active ? '' : undefined}
                onClick={() => { onSelect(row.id) }}
              >
                {navIcon(row.id)}
                <span className={css.navLabel}>{row.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className={css.content}>
          <div className={css.header}>
            <div className={css.actions}>{renderSlot('settings.action', {})}</div>
            <button type="button" className={css.close} onClick={onClose}>
              <IconCloseOutlineRegular size={14} />
              <span className={css.hiddenLabel}>{renderSlot('settings.close', {})}</span>
            </button>
          </div>
          <div className={css.options}>
            {active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active })}
          </div>
        </div>
      </div>
    </div>
  ), document.body)
}

/**
 * Render the settings trigger and panel.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the settings shell element tree.
 */
export function SettingsRoot(props: SettingsRootComponentProps) {
  const {
    wide, reconnect, useConnectionState, useSections, useOnboardingSteps, useSessions, renderSlot, t,
    useDesktopUpdate, openDesktopUpdate, useStore, actions, useShortcuts,
  } = props
  const { open, activeId } = useStore(state => state)
  const shortcut = useShortcuts(rows => rows.find(row => row.id === 'settings.open'))
  const { close, openSection } = actions
  const [requestedOnboarding, setRequestedOnboarding] = useState<string | undefined>()
  const [completedOnboarding, setCompletedOnboarding] = useState<ReadonlySet<string>>(() => new Set())
  const [showRecovery, setShowRecovery] = useState(false)
  const [holdConnecting, setHoldConnecting] = useState(false)
  const connectingShownAt = useRef<number | undefined>(undefined)

  // The ledger tick keeps the nav rows fresh: registrants re-register with
  // freshly localized text on locale change, and the trigger/header/close
  // seats re-render through their own outlets' subscriptions.
  const rows = useSections(s => s)
  const desktopUpdate = useDesktopUpdate(state => state)
  const connectionState = useConnectionState(state => state)
  const previousConnectionState = useRef(connectionState)
  const onboardingSteps = useOnboardingSteps(s => s)
  const onboardingActive = useSessions((state) => {
    const main = Object.values(state.byId)
      .find(session => (session.retainedBy.mainView ?? 0) > 0)
    return state.phase === 'ready' && (main === undefined || main.blank)
  })
  const onboardingStep = requestedOnboarding !== undefined
    ? onboardingSteps.find(step => step.id === requestedOnboarding)
    : onboardingActive
      ? onboardingSteps.find(step => !completedOnboarding.has(step.id))
      : undefined

  useEffect(() => {
    if (onboardingActive) return
    setCompletedOnboarding(new Set())
  }, [onboardingActive])

  const onboardingStepSeen = useRef(onboardingStep)
  // An onboarding step owns the viewport and marks `#root` inert. The panel portals
  // beside `#root`, outside that mark, so a step that appears while the panel is open
  // takes the panel down rather than leaving it focusable behind the onboarding mask.
  useEffect(() => {
    const appeared = onboardingStepSeen.current === undefined && onboardingStep !== undefined
    onboardingStepSeen.current = onboardingStep
    if (appeared && open) close()
  }, [onboardingStep, open, close])

  useLayoutEffect(() => {
    const previous = previousConnectionState.current
    previousConnectionState.current = connectionState
    if (connectionState !== 'connected') {
      setShowRecovery(false)
      return
    }
    if (previous !== 'disconnected' && previous !== 'connecting') return
    setShowRecovery(true)
  }, [connectionState])

  // The confirmation window starts when the recovered pill becomes visible,
  // which the connecting minimum-visible hold can delay past the transition.
  useLayoutEffect(() => {
    if (!showRecovery || holdConnecting) return
    const timeout = window.setTimeout(() => { setShowRecovery(false) }, RECOVERY_CONFIRMATION_MS)
    return () => { window.clearTimeout(timeout) }
  }, [showRecovery, holdConnecting])

  useLayoutEffect(() => {
    if (connectionState === 'connecting') {
      connectingShownAt.current = Date.now()
      return
    }
    const shownAt = connectingShownAt.current
    if (shownAt === undefined) return
    connectingShownAt.current = undefined
    const remaining = CONNECTING_MIN_VISIBLE_MS - (Date.now() - shownAt)
    if (remaining <= 0) return
    setHoldConnecting(true)
    const timeout = window.setTimeout(() => { setHoldConnecting(false) }, remaining)
    return () => {
      window.clearTimeout(timeout)
      setHoldConnecting(false)
    }
  }, [connectionState])

  const completeOnboardingStep = useCallback((id: string) => {
    setRequestedOnboarding(undefined)
    setCompletedOnboarding((previous) => {
      if (previous.has(id)) return previous
      return new Set([...previous, id])
    })
  }, [])

  let connectionIndicator: ConnectionIndicatorState | undefined
  if (connectionState === 'connecting' || holdConnecting) {
    connectionIndicator = 'connecting'
  } else if (connectionState === 'disconnected') {
    connectionIndicator = 'disconnected'
  } else if (showRecovery) {
    connectionIndicator = 'recovered'
  }

  return (
    <>
      <div className={clsx(css.triggerRow, !wide && css.railRow)}>
        {renderSlot('settings.launcher', {
          wide, settingsOpen: open, openSettings: actions.open,
          ...(shortcut?.keys.length ? { settingsShortcut: { keys: shortcut.keys, aria: shortcut.aria } } : {}),
          openOnboarding: (id) => { close(); setRequestedOnboarding(id) },
        }, { fallback: <Tooltip disabled={open} label={t('trigger')} shortcutKeys={shortcut?.keys}>
          <button
            type="button"
            className={clsx(css.trigger, !wide && css.rail)}
            aria-label={t('trigger')}
            aria-keyshortcuts={shortcut?.aria}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => { actions.open() }}
          >
            {renderSlot('settings.trigger', { wide })}
          </button>
        </Tooltip> })}
        <ConnectionIndicator
          state={wide && desktopUpdate.presentation?.phase !== 'installing' ? connectionIndicator : undefined}
          disconnectedLabel={t('connection.error')}
          connectingLabel={t('connection.connecting')}
          recoveredLabel={t('connection.connected')}
          reconnectActionLabel={t('connection.reconnect')}
          restartActionLabel={t('connection.restart')}
          onReconnect={reconnect}
        />
        <DesktopUpdateIndicator wide={wide} hidden={connectionIndicator !== undefined && desktopUpdate.presentation?.phase !== 'installing'}
          t={t} view={desktopUpdate} onOpen={openDesktopUpdate} />
      </div>
      {open && (
        <SettingsPanel
          rows={rows}
          renderSlot={renderSlot}
          activeId={activeId}
          onSelect={actions.select}
          onClose={close}
        />
      )}
      {/* Dialog chrome and `#root` inert ownership live inside each step's
          visible branch. A step still deciding (private facts loading)
          renders null, so nothing paints or blocks while it decides. */}
      {onboardingStep !== undefined && renderSlot('settings.onboarding', {
        stepId: onboardingStep.id,
        explicit: requestedOnboarding !== undefined,
        complete: () => { completeOnboardingStep(onboardingStep.id) },
        openSection,
      }, { only: onboardingStep.id })}
    </>
  )
}
