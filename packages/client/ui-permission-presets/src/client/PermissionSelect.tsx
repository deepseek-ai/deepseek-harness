import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconChevronDownOutline14, Menu, RiskConfirmation, SHIELD_OUTLINE_PATH, SHIELD_OUTLINE_STROKE,
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

/* Shield glyphs (design set 1556) over the ui-primitives shield contour:
   check = read-only, pencil = workspace write, exclamation = full access.
   currentColor so the trigger and menu rows tint them with their own text
   color. */

const permissionGlyphs = new Map<string, ReactNode>([
  ['read-only', (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d={SHIELD_OUTLINE_PATH} stroke="currentColor" strokeWidth={SHIELD_OUTLINE_STROKE} strokeLinejoin="round" />
      <path d="M12.1654 5.7552L8.9447 9.41475C8.73044 9.65816 8.53628 9.8804 8.35774 10.0423C8.1713 10.2114 7.94235 10.3717 7.64016 10.4254C7.48207 10.4535 7.32 10.4552 7.16151 10.4294C6.85843 10.3801 6.62728 10.2223 6.43836 10.0559C6.25752 9.89653 6.06037 9.67732 5.84264 9.43705L4.72925 8.20897L5.63557 7.38707L6.74897 8.61594C6.98603 8.87755 7.12974 9.03533 7.24673 9.13839C7.31033 9.19443 7.34485 9.21476 7.35823 9.22122C7.38068 9.22484 7.40352 9.22515 7.42593 9.22122C7.40522 9.22502 7.42893 9.23294 7.53583 9.136C7.65132 9.03126 7.79316 8.87139 8.02643 8.60638L11.2479 4.94763L12.1654 5.7552Z" fill="currentColor" />
    </svg>
  )],
  ['workspace-write', (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8.08887 0.251709C8.20479 0.23085 8.32486 0.241168 8.43652 0.282959L15.0215 2.75171C15.2787 2.84819 15.4492 3.09414 15.4492 3.3689V7.0105C15.4492 7.10986 15.4441 7.2081 15.4414 7.30542C15.0285 7.07175 14.5905 6.87695 14.1309 6.73022V3.82495L8.20508 1.60327L2.2793 3.82495V7.0105C2.27936 9.7171 3.4745 11.5379 5.02734 12.7947C5.01025 12.9942 5 13.1962 5 13.4001C5.00001 13.7617 5.02722 14.1169 5.08008 14.4636C2.91555 13.0393 0.961014 10.752 0.960938 7.0105V3.3689C0.960938 3.09417 1.13146 2.84821 1.38867 2.75171L7.97461 0.282959L8.08887 0.251709Z" fill="currentColor" />
      <path d="M11.3525 5.64688V6.85688H5V5.64688H11.3525Z" fill="currentColor" />
      <path d="M9.5824 8.29376V9.50376H5V8.29376H9.5824Z" fill="currentColor" />
      <path d="M14.6647 15.6852H10.0338C10.3878 15.3751 10.7567 15.0517 11.0772 14.7706C11.2531 14.6164 11.4144 14.4746 11.5511 14.3547H14.6647V15.6852Z" fill="currentColor" />
      <path d="M8.14852 14.1308L7.33925 15.4976C7.22458 15.6912 7.42245 15.9194 7.63037 15.8333L9.09785 15.2254L15.0399 10.0719L14.0905 8.97733L8.14852 14.1308Z" fill="currentColor" />
    </svg>
  )],
  [FULL_ACCESS, (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d={SHIELD_OUTLINE_PATH} stroke="currentColor" strokeWidth={SHIELD_OUTLINE_STROKE} strokeLinejoin="round" />
      <path d="M9.10094 4.5V8.75939H7.59888V4.5H9.10094Z" fill="currentColor" />
      <path d="M9.10094 9.8114V11.5H7.59888V9.8114H9.10094Z" fill="currentColor" />
    </svg>
  )],
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
              <IconChevronDownOutline14 />
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
