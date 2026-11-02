/** Body of a `create_personalized_page` card: location choice, creation progress, retention, undo and restore. */
import { useCallback, useId, useState, useSyncExternalStore } from 'react'
import { z } from 'zod'
import { Button, IconChevronDownOutlineRegular, IconWarningTriangleOutlineRegular, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ActionCardBodyProps } from '@deepseek-ai/dsh-client-ui-action-cards/client'
import type { CreationSlot, PageData, PageDetails, PageVerb } from '@deepseek-ai/dsh-creation-recommendations/types'
import type { RecommendationKey } from './locales.ts'
import css from './Card.module.css'

/** Body props: the frame's card props plus this browser's cost-notice preference. */
export type PageCardProps = ActionCardBodyProps<'creationRecommendations'> & { readonly infoDismissed: SnapshotStore<boolean> }

type LocationChoice = CreationSlot | 'custom'
type CardVerb = PageVerb | 'dismiss'

const slotSchema = z.enum(['sidebar-right', 'page', 'sidebar-left'])
const detailsSchema = z.object({ slot: slotSchema, initialContent: z.string().optional() }) satisfies z.ZodType<PageDetails>
const dataSchema = z.object({
  slot: slotSchema, customLocation: z.string().optional(), bundleName: z.string().optional(),
  application: z.enum(['applied', 'restart-required', 'overridden', 'failed', 'cancelled']).optional(),
}) satisfies z.ZodType<PageData>

/** Phases with their own status copy. */
const PHASE_KEYS: readonly RecommendationKey[] = [
  'dismissed', 'replaced', 'creating', 'installing', 'cancelled', 'installed', 'kept', 'removed', 'failed', 'interrupted', 'unconfirmed',
]
/** Refusal reasons with their own copy; any other reason reads as unavailable. */
const REASON_KEYS: readonly RecommendationKey[] = [
  'unknown', 'access-denied', 'not-live-root', 'closing', 'unavailable', 'invalid-location', 'read-only', 'source-missing',
]

/** Application outcomes have their own copy; the phase copy of failed and cancelled describes creation instead. */
const APPLICATION_KEYS: Readonly<Record<Exclude<NonNullable<PageData['application']>, 'applied'>, RecommendationKey>> = {
  'restart-required': 'restart-required', overridden: 'overridden', failed: 'applicationFailed', cancelled: 'applicationCancelled',
}

function keyOf(keys: readonly RecommendationKey[], value: string): RecommendationKey | undefined {
  return keys.find(key => key === value)
}

function LocationPicker({ value, disabled, onChange, t }: {
  value: LocationChoice
  disabled: boolean
  onChange: (value: LocationChoice) => void
} & PropsLocale<'creationRecommendations'>) {
  const [open, setOpen] = useState(false)
  return <Menu open={open && !disabled} portal autoFocus compact
    listClassName={css.locationMenu} selectedId={value}
    onClose={() => { setOpen(false) }}
    onSelect={(id) => { onChange(id as LocationChoice); setOpen(false) }}
    items={(['sidebar-right', 'page', 'sidebar-left', 'custom'] as const).map(id => ({
      id, label: <span className={css.locationOption}><span>{t(id)}</span><span>{t(`${id}Hint`)}</span></span>,
    }))}
    anchor={<Button variant="outline" size="sm" disabled={disabled} className={css.locationButton}
      aria-label={`${t('location')}: ${t(value)}`} aria-haspopup="menu" aria-expanded={open && !disabled}
      onClick={() => { setOpen(current => !current) }}>
      {t(value)}<IconChevronDownOutlineRegular size={14} />
    </Button>} />
}

/**
 * Display creation, persistent installation, reversible removal and restoration below the frame's summary.
 * @param props - card, state, actions, folded-text component and notice preference.
 * @returns the card body.
 */
export function PageCardBody({ proposal, decision, summary, Folded, act, infoDismissed, t }: PageCardProps) {
  const details = detailsSchema.safeParse(proposal.details)
  const parsed = decision === undefined ? undefined : dataSchema.safeParse(decision.data)
  const data = parsed?.success === true ? parsed.data : undefined
  const phase = decision === undefined ? undefined : keyOf(PHASE_KEYS, decision.phase)
  const [selected, setSelected] = useState<LocationChoice>()
  const [custom, setCustom] = useState<string>()
  const [info, setInfo] = useState<boolean>()
  const subscribe = useCallback((listener: () => void) => infoDismissed.subscribe(listener), [infoDismissed])
  const noticeDismissed = useSyncExternalStore(subscribe, () => infoDismissed.getSnapshot())
  const infoId = useId()
  const customId = useId()
  const [pending, setPending] = useState<CardVerb>()
  const [error, setError] = useState<RecommendationKey>()
  if (!details.success) return <div className={css.body}>{summary}</div>
  const busy = pending !== undefined
  const slot = selected !== undefined && selected !== 'custom' ? selected : data?.slot ?? details.data.slot
  const location = selected ?? (data?.customLocation === undefined ? slot : 'custom')
  const customLocation = custom ?? data?.customLocation ?? ''
  const offer = decision === undefined || phase === 'cancelled' || phase === 'failed' || phase === 'interrupted' || phase === 'unconfirmed'
  const infoOpen = info ?? (offer && !noticeDismissed)
  const installed = phase === 'installed' || phase === 'kept'
  const run = async (verb: CardVerb) => {
    setPending(verb)
    setError(undefined)
    if (verb === 'create' || verb === 'dismiss') { infoDismissed.set(true); setInfo(false) }
    const placement = { slot, ...location === 'custom' ? { customLocation: customLocation.trim() } : {} }
    try {
      const result = await act(verb, verb === 'create' || verb === 'dismiss' ? placement : undefined)
      if (result === undefined) setError('transport')
      else if (result.status === 'refused' || result.status === 'unconfirmed') setError(keyOf(REASON_KEYS, result.reason) ?? 'unavailable')
    } catch {
      // A lost reply does not prove failure; replay supplies the durable decision.
      setError('transport')
    } finally { setPending(undefined) }
  }
  return <>
    <header className={css.header}><span className={css.heading}>{t('heading')}
      <Tooltip label={t('creationInfo')} side="top" portal disabled={infoOpen}>
        <Button variant="ghost" size="sm" className={css.infoButton} aria-label={t('creationInfo')}
          aria-expanded={infoOpen} aria-controls={infoId} onClick={() => {
            setInfo(!infoOpen)
            if (infoOpen) infoDismissed.set(true)
          }}>
          <IconWarningTriangleOutlineRegular size={14} />
        </Button>
      </Tooltip>
    </span>
    {phase !== undefined && <span role="status" className={css.phase} data-phase={phase}>{t(phase)}</span>}
    </header>
    {infoOpen && <div id={infoId} role="note" className={css.info}>
      <p>{t('creationMethod')}</p>
      <p><strong>{t('creationCost')}</strong></p>
      <p>{t('creationBackground')}</p>
      {data?.bundleName !== undefined && <p>{t('sourceRetained')}</p>}
    </div>}
    <div className={css.body}>
      {summary}
      {details.data.initialContent !== undefined && <div className={css.content}>
        <span className={css.contentLabel}>{t('initialContent')}</span>
        <Folded text={details.data.initialContent} expandLabel={t('expandContent')} collapseLabel={t('collapseContent')} />
      </div>}
      {data?.application !== undefined && data.application !== 'applied' && phase !== 'failed'
        && <p role="status" className={css.status}>{t(APPLICATION_KEYS[data.application])}</p>}
      {error !== undefined && <p role="alert" className={css.status}>{t(error)}</p>}
      {offer ? <div className={css.controls}>
        <div className={css.locationRow}>
          <span className={css.locationLabel}>{t('location')}</span>
          <LocationPicker value={location} disabled={busy} onChange={setSelected} t={t} />
        </div>
        {location === 'custom' && <div className={css.customLocation}>
          <label htmlFor={customId} className={css.locationLabel}>{t('customLabel')}</label>
          <textarea id={customId} value={customLocation} rows={2} maxLength={1000} disabled={busy}
            placeholder={t('customPlaceholder')} onChange={(event) => { setCustom(event.target.value) }} />
        </div>}
        <footer className={css.footer}>
          <div className={css.actions}>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void run('dismiss') }}>{t('dismiss')}</Button>
            <Button variant="primary" size="sm" disabled={busy || location === 'custom' && customLocation.trim() === ''} onClick={() => { void run('create') }}>
              {t(pending === 'create' ? 'starting' : decision === undefined ? 'create' : 'retry')}
            </Button>
          </div>
        </footer>
      </div> : <p className={css.description}>{t('location')} · {data?.customLocation ?? t(data?.slot ?? details.data.slot)}</p>}
      {phase === 'creating' && <footer className={css.footer}>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void run('cancel') }}>{t(pending === 'cancel' ? 'cancelling' : 'cancel')}</Button>
      </footer>}
      {installed && <footer className={css.footer}>
        <span className={css.scope}>{t('scope')}</span>
        <div className={css.actions}>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void run('undo') }}>{t('undo')}</Button>
          {phase !== 'kept' && <Button variant="primary" size="sm" disabled={busy} onClick={() => { void run('keep') }}>{t('keep')}</Button>}
        </div>
      </footer>}
      {phase === 'removed' && <footer className={css.footer}>
        <div className={css.actions}>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => { void run('restore') }}>{t(pending === 'restore' ? 'restoring' : 'restore')}</Button>
        </div>
      </footer>}
    </div>
  </>
}
