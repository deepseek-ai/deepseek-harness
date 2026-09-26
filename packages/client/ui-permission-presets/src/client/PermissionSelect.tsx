import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconChevronDownOutlineRegular, Menu, PermissionIconFullAccessRegular,
  PermissionIconReadOnlyRegular, PermissionIconWorkspaceWriteRegular, RiskConfirmation,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { PresetOption } from '@deepseek-ai/dsh-permission-presets/client'
// Type-only: pulls the conversation-owned permission slot declaration and
// the standard session projection hook into this package's Client face.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PermissionCatalogState } from './catalog.ts'
import { PERMISSION_ACCESS_NS } from './locales.ts'
import {
  AUTO_REVIEW_PRESET as AUTO_REVIEW,
  displayPermissionPreset,
  FULL_ACCESS_PRESET as FULL_ACCESS,
} from './presentation.ts'
import css from './PermissionSelect.module.css'

/* Permission glyphs follow currentColor so the trigger and menu rows tint the
   shared product artwork with their own text color. */

const permissionGlyphs = new Map<string, ReactNode>([
  ['read-only', <PermissionIconReadOnlyRegular />],
  ['workspace-write', <PermissionIconWorkspaceWriteRegular />],
  [FULL_ACCESS, <PermissionIconFullAccessRegular />],
])

/** Glyph for a permission option value; host-configured names outside the design set get none. */
function permissionGlyph(value: string): ReactNode | undefined {
  return permissionGlyphs.get(value)
}

function permissionLabel(
  value: string,
  name: string,
  t: PermissionSelectProps['t'],
): string {
  if (value === AUTO_REVIEW) return t('auto.label')
  return displayPermissionPreset(value, name, key => t(key))
}

function optionBadge(value: string, t: PermissionSelectProps['t']): string | undefined {
  return value === AUTO_REVIEW ? t('auto.badge') : undefined
}

/** Resolve locale-owned copy for the shipped Auto option; preserve host copy for other presets. */
function optionDescription(
  option: PresetOption,
  t: PermissionSelectProps['t'],
): string | undefined {
  return option.value === AUTO_REVIEW ? t('auto.description') : option.description
}

/** Business face injected by the permission package's slot registration. */
export interface PermissionSelectInjected {
  hooks: {
    /** One process catalog shared with the slash popup. */
    permissionCatalog: HostObservable<PermissionCatalogState>
  }
  /** Submit one current-session preset through the existing command writer. */
  select: (preset: string) => Promise<boolean>
}

/** Complete props derived from the conversation slot, injected hooks, and locale. */
export type PermissionSelectProps =
  PropsRuntime<'conversation.input.permission'>
  & InjectFace<PermissionSelectInjected>
  & PropsLocale<typeof PERMISSION_ACCESS_NS>

export function PermissionSelect({
  locked, select, usePermissionCatalog, useProjection, t,
}: PermissionSelectProps) {
  const selection = useProjection('permissions')
  const catalog = usePermissionCatalog(state => state.value)
  const [pick, setPick] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)

  useEffect(() => {
    if (!locked && selection !== undefined && catalog !== null
      && (confirmation === null || catalog.options.some(option => option.value === confirmation))) return
    setOpen(false)
    setAcknowledged(false)
    setConfirmation(null)
  }, [catalog, confirmation, locked, selection])

  if (selection === undefined || catalog === null) return null

  const currentValue = pick !== null && catalog.options.some(option => option.value === pick)
    ? pick : selection.currentValue
  const current = catalog.options.find(option => option.value === currentValue)
  const currentLabel = current === undefined
    ? permissionLabel(currentValue, currentValue, t)
    : permissionLabel(current.value, current.name, t)
  const busy = pick !== null || confirmation !== null

  const items: MenuEntry[] = catalog.options.map((option) => {
    const icon = permissionGlyph(option.value)
    const label = permissionLabel(option.value, option.name, t)
    const badge = optionBadge(option.value, t)
    return {
      id: option.value,
      label: badge === undefined
        ? label
        : (
          <span className={css.optionLabel} aria-label={`${label} ${badge}`}>
            <span className={css.optionLabelText}>{label}</span>
            <sup className={css.badge}>{badge}</sup>
          </span>
        ),
      ...icon === undefined ? {} : { icon },
    }
  })

  const submit = (id: string): void => {
    setPick(id)
    void select(id)
      .catch(() => false)
      .then(() => { setPick(null) })
  }

  const choose = (id: string): void => {
    setOpen(false)
    if (id === selection.currentValue) return
    if (id === FULL_ACCESS || id === AUTO_REVIEW) {
      setAcknowledged(false)
      setConfirmation(id)
      return
    }
    submit(id)
  }

  const closeConfirmation = (): void => {
    setAcknowledged(false)
    setConfirmation(null)
  }

  const confirmSelection = (id: string): void => {
    closeConfirmation()
    submit(id)
  }

  const confirmationTitle = confirmation === AUTO_REVIEW
    ? t('auto.confirm.title')
    : t('confirm.title')
  const confirmationDescription = confirmation === AUTO_REVIEW
    ? t('auto.confirm.description')
    : t('confirm.description')
  const confirmationAcknowledge = confirmation === AUTO_REVIEW
    ? t('auto.confirm.acknowledge')
    : t('confirm.acknowledge')
  const confirmationEnable = confirmation === AUTO_REVIEW
    ? t('auto.confirm.enable')
    : t('confirm.enable')
  const currentBadge = optionBadge(currentValue, t)
  const currentAccessibleLabel = currentBadge === undefined ? currentLabel : `${currentLabel} ${currentBadge}`

  return (
    <>
      <Menu
        open={open}
        items={items}
        selectedId={currentValue}
        onSelect={choose}
        onClose={() => { setOpen(false) }}
        side="top"
        portal
        anchor={
          <button
            type="button"
            className={css.trigger}
            aria-label={t('mode', { name: currentAccessibleLabel })}
            title={current === undefined ? undefined : optionDescription(current, t)}
            disabled={locked || busy}
            onClick={() => { setOpen(!open) }}
          >
            {permissionGlyph(currentValue) !== undefined && (
              <span className={css.triggerIcon} aria-hidden>{permissionGlyph(currentValue)}</span>
            )}
            <span className={css.triggerLabel}>{currentLabel}</span>
            {currentBadge !== undefined && (
              <sup className={css.badge}>{currentBadge}</sup>
            )}
            <span className={clsx(css.chevron, open && css.chevronOpen)} aria-hidden>
              <IconChevronDownOutlineRegular />
            </span>
          </button>
        }
      />
      {confirmation !== null && (
        <RiskConfirmation
          open
          title={confirmationTitle}
          description={confirmationDescription}
          acknowledgeLabel={confirmationAcknowledge}
          cancelLabel={t('confirm.cancel')}
          closeLabel={t('close')}
          confirmLabel={confirmationEnable}
          acknowledged={acknowledged}
          disabled={locked}
          onAcknowledgedChange={setAcknowledged}
          onCancel={closeConfirmation}
          onConfirm={() => { confirmSelection(confirmation) }}
        />
      )}
    </>
  )
}
