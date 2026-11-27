/**
 * Body of an `enable_official_plugin` card: the plugin's catalog text, its details link, the user's choice and its
 * outcome, and the account connection of an enabled official connector.
 */
import { useCallback, useEffect, useId, useState, useSyncExternalStore } from 'react'
import { z } from 'zod'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ActionCardId } from '@deepseek-ai/dsh-action-cards/types'
import type { ActionCardBodyProps } from '@deepseek-ai/dsh-client-ui-action-cards/client'
import type { PluginDetails, RecommendationDetails } from '@deepseek-ai/dsh-plugin-recommendations/types'
import type { RecommendationKey } from './locales.ts'
import css from './Card.module.css'

/** Catalog text the Host returned for an available plugin. */
export type CatalogDetails = Extract<RecommendationDetails, { readonly status: 'available' }>

/** Plugin-lifetime services the body uses besides the frame's props. */
export interface PluginCardServices {
  /** Catalog text by plugin name, kept for this plugin's lifetime so later cards of the same plugin render it at once. */
  readonly catalog: SnapshotStore<Readonly<Record<string, CatalogDetails>>>
  /**
   * Read the current catalog text of a card's plugin.
   * @param sessionId - the displayed Session.
   * @param cardId - the card's id.
   * @returns the Host's answer, or undefined when the reply was lost.
   */
  readonly describe: (sessionId: SessionId, cardId: ActionCardId) => Promise<RecommendationDetails | undefined>
  /** Open the plugin's details page without enabling it; an official connector's page also connects its account. */
  readonly openDetails: (packageName: string) => void
  /** Pick the interface language's text. */
  readonly resolveText: (text: LocalizedText) => string
}

/** Body props: the frame's card props plus the plugin-lifetime services. */
export type PluginCardProps = ActionCardBodyProps<'pluginRecommendations'> & PluginCardServices

type CardVerb = 'enable' | 'approve' | 'dismiss'

const detailsSchema = z.object({ name: z.string() }) satisfies z.ZodType<PluginDetails>
/** Recorded decision data the body reads; see `PluginData` for its meaning. */
const dataSchema = z.object({
  application: z.literal('restart-required').optional(), errorCode: z.string().optional(), pendingBuilds: z.array(z.string()).min(1).optional(),
})
type CardData = z.infer<typeof dataSchema>

/** Phases that still offer Enable and Not now; any other recorded phase is settled. */
const OPEN_PHASES: readonly string[] = ['failed', 'unconfirmed']
/** Refusal reasons with their own copy; any other reason reads as unavailable. */
const REASON_KEYS: readonly RecommendationKey[] = ['unknown', 'unavailable', 'access-denied', 'not-live-root', 'closing']

function reasonKey(reason: string): RecommendationKey {
  return REASON_KEYS.find(key => key === reason) ?? 'unavailable'
}

/**
 * Status copy of a recorded phase; `restart-required` refines enabled, and a failed connector installation names its
 * blocked install scripts or its own recovery.
 */
function statusKey(phase: string, data: CardData, installable: boolean): RecommendationKey | undefined {
  switch (phase) {
    case 'failed': return !installable ? phase : data.pendingBuilds === undefined ? 'install-failed' : 'builds-blocked'
    case 'dismissed': case 'already-enabled': case 'unconfirmed': return phase
    case 'enabled': return data.application === 'restart-required' ? 'restart-required' : 'enabled'
    default: return undefined
  }
}

/** Alert copy of a failed change's management error; a failed installation's status already names its recovery. */
function failureKey(data: CardData, installable: boolean): RecommendationKey | undefined {
  if (data.errorCode === undefined) return undefined
  if (data.errorCode === 'incompatible-version') return 'version-error'
  return installable ? undefined : 'management-error'
}

/** Copy of the primary action: an official connector installs, or allows its blocked scripts, before it is enabled. */
function primaryKey(installable: boolean, approving: boolean, pending: boolean, phase: string | undefined): RecommendationKey {
  if (installable) return pending ? 'installing' : approving ? 'approveBuilds' : 'install'
  return pending ? 'working' : phase === undefined ? 'enable' : 'retry'
}

/**
 * Display one plugin card: its current catalog title and description, the user's choice and its outcome.
 * Until the plugin's first catalog lookup returns, a placeholder line and the disabled actions hold the final layout;
 * after each action the card looks the plugin up again and keeps its current text until the answer arrives.
 * A refused or lost lookup leaves Not now and a retry of the lookup, but not Enable. A card that names no plugin shows
 * the frame's fallback. An official connector the profile does not hold shows the title and description the Host
 * reads from the connector catalog as plain text, since it has no details page before installation, and installs and
 * enables it; a failed installation that reported blocked install scripts lists them and offers to allow them. An
 * enabled official connector offers its account connection beside the card's status, unless the card was dismissed or
 * its last decision failed.
 * @param props - card, state, actions and plugin-lifetime services.
 * @returns the card body.
 */
export function PluginCardBody({
  proposal, decision, sessionId, fallback, act, catalog, describe, openDetails, resolveText, t,
}: PluginCardProps) {
  const details = detailsSchema.safeParse(proposal.details)
  const name = details.success ? details.data.name : undefined
  const subscribe = useCallback((listener: () => void) => catalog.subscribe(listener), [catalog])
  const cached = useSyncExternalStore(subscribe, () => {
    const entries = catalog.getSnapshot()
    return name !== undefined && Object.hasOwn(entries, name) ? entries[name] : undefined
  })
  // This card's latest lookup: undefined while loading, null when the reply was lost.
  const [lookup, setLookup] = useState<RecommendationDetails | null>()
  const [attempt, setAttempt] = useState(0)
  const [pending, setPending] = useState<CardVerb>()
  const [error, setError] = useState<RecommendationKey>()
  const descriptionId = useId()
  const phase = decision?.phase
  useEffect(() => {
    if (name === undefined) return undefined
    let current = true
    describe(sessionId, proposal.cardId).then(
      (value) => {
        if (!current) return
        if (value?.status === 'available') catalog.set({ ...catalog.getSnapshot(), [name]: value })
        setLookup(value ?? null)
      },
      () => { if (current) setLookup(null) },
    )
    return () => { current = false }
  }, [catalog, describe, sessionId, proposal.cardId, name, phase, attempt])
  if (name === undefined) return fallback
  // Remembered text shows at once; this card's own refusal, lost reply or missing connector still decides what it offers.
  const current = lookup === null || lookup?.status === 'refused' || lookup?.status === 'installable' ? lookup : cached ?? lookup
  const loading = current === undefined
  const available = current?.status === 'available' ? current : undefined
  const uninstalled = current?.status === 'installable' ? current : undefined
  const installable = uninstalled !== undefined
  const parsed = dataSchema.safeParse(decision?.data ?? {})
  const data: CardData = parsed.success ? parsed.data : {}
  const settled = phase !== undefined && !OPEN_PHASES.includes(phase)
  const status = phase === undefined ? available?.enabled ? 'already-enabled' : undefined : statusKey(phase, data, installable)
  // A settled card keeps its recorded outcome; a later catalog change does not reopen or relabel it.
  const offered = !settled && available?.enabled !== true
  const enable = offered && (available !== undefined || installable || loading)
  // The Host allows only the scripts this card's failed installation recorded.
  const builds = installable && phase === 'failed' ? data.pendingBuilds : undefined
  const primary: CardVerb = builds === undefined ? 'enable' : 'approve'
  // A dismissed card stays closed even when its connector was enabled elsewhere afterwards, and a failed one keeps its
  // failure, since the account belongs to a running connector and this one did not start.
  const connect = available?.connector === true && available.enabled && phase !== 'dismissed' && phase !== 'failed'
  const lookupProblem = settled ? undefined : current === null ? 'lookup-failed' : current?.status === 'refused' ? current.reason : undefined
  const failure = phase === 'failed' ? failureKey(data, installable) : undefined
  const title = available === undefined ? proposal.title : resolveText(available.title)
  const run = async (verb: CardVerb) => {
    setPending(verb)
    setError(undefined)
    try {
      const result = await act(verb)
      if (result === undefined) setError('transport')
      else if (result.status === 'refused' || result.status === 'unconfirmed') setError(reasonKey(result.reason))
    } catch {
      // The Host operation may have committed before a connection loss; retry is idempotent.
      setError('transport')
    } finally {
      setPending(undefined)
      // The recorded phase can stay the same while the plugin changed, as after a second failure of an installation that landed.
      setAttempt(value => value + 1)
    }
  }
  const busy = pending !== undefined
  return <>
    <header className={css.header}><span>{t('heading')}</span><span className={css.badge}>{t('official')}</span></header>
    <div className={css.body} aria-busy={loading || undefined}>
      {uninstalled !== undefined ? <>
        <strong className={css.title}>{resolveText(uninstalled.title)}</strong>
        <p className={css.description}>{resolveText(uninstalled.description)}</p>
      </> : <button type="button" className={css.details} onClick={() => { openDetails(name) }}
        aria-label={t('detailsFor', { title })} aria-describedby={available === undefined ? undefined : descriptionId}>
        <strong className={css.title}>{title}</strong>
        {(loading || available !== undefined) && <span id={descriptionId} className={css.description}>
          {available === undefined ? <span className={css.placeholder} /> : resolveText(available.description)}
        </span>}
      </button>}
      {status !== undefined && !connect && <p role="status" className={css.status}>{t(status)}</p>}
      {builds !== undefined && <ul className={css.builds}>{builds.map(build => <li key={build}><code>{build}</code></li>)}</ul>}
      {failure !== undefined && <p role="alert" className={css.status}>{t(failure)}</p>}
      {lookupProblem !== undefined && <p role="alert" className={css.status}>{t(lookupProblem)}</p>}
      {offered && error !== undefined && <p role="alert" className={css.status}>{t(error)}</p>}
      {offered && <footer className={css.footer}>
        <span className={css.scope}>{t('scope')}</span>
        <div className={css.actions}>
          {lookupProblem !== undefined && <Button variant="ghost" size="sm" disabled={busy} onClick={() => {
            setLookup(undefined)
            setAttempt(value => value + 1)
          }}>{t('retryLookup')}</Button>}
          <Button variant="ghost" size="sm" disabled={busy || loading} onClick={() => { void run('dismiss') }}>
            {t(pending === 'dismiss' ? 'working' : 'dismiss')}
          </Button>
          {enable && <Button variant="primary" size="sm" disabled={busy || loading} onClick={() => { void run(primary) }}>
            {t(primaryKey(installable, primary === 'approve', pending === primary, phase))}
          </Button>}
        </div>
      </footer>}
      {connect && <footer className={css.footer}>
        {status !== undefined && <span role="status" className={css.scope}>{t(status)}</span>}
        <div className={css.actions}>
          <Button variant="primary" size="sm" onClick={() => { openDetails(name) }}>{t('connect')}</Button>
        </div>
      </footer>}
    </div>
  </>
}
