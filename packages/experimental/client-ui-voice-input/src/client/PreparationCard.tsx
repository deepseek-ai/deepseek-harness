/** Provider-owned preparation steps and persisted recognition preferences. */
import { useEffect, useState } from 'react'
import { Button, DisclosureRow, IconChevronDownOutlineRegular, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SpeechPreparationState, SpeechProviderId, SpeechProviderView, SpeechSelectionPatch } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type { VoiceInputInjected } from './VoiceInput.tsx'
import { NS } from './locales.ts'
import css from './VoiceInput.module.css'

/** One recognizer's resource readiness and explicit preparation controls. */
export type PreparationCardProps = Pick<InjectFace<VoiceInputInjected>, 'prepare' | 'cancelPreparation'>
  & PropsLocale<typeof NS> & { readonly provider: SpeechProviderView; readonly connected: boolean }

function preparationTone(state: SpeechPreparationState): StateDotState {
  if (state.phase === 'ready' || state.phase === 'standby') return 'done'
  if (state.phase === 'failed') return 'error'
  if (state.phase === 'unprepared' || state.phase === 'cancelled') return 'idle'
  return 'ongoing'
}

function byteText(state: Extract<SpeechPreparationState, { phase: 'downloading' }>, t: PropsLocale<typeof NS>['t']): string {
  return state.totalBytes === undefined ? t('downloadUnknown', { completed: (state.completedBytes / 1_000_000).toFixed(1) })
    : t('downloadBytes', { completed: (state.completedBytes / 1_000_000).toFixed(1),
      total: (state.totalBytes / 1_000_000).toFixed(1), percent: String(Math.floor(state.completedBytes / state.totalBytes * 100)) })
}

function DownloadProgress({ state, t }: { state: SpeechPreparationState } & PropsLocale<typeof NS>) {
  return state.phase === 'downloading' && state.totalBytes !== undefined
    ? <progress className={css.progress} aria-label={t('downloadProgress')} value={state.completedBytes} max={state.totalBytes} /> : null
}

function PreparationFailure({ state, t }: { state: Extract<SpeechPreparationState, { phase: 'failed' }> } & PropsLocale<typeof NS>) {
  const failure = state.download
  if (!failure) return <p className={css.preparationError} role="alert">{t('preparationFailed', { message: state.message })}</p>
  return <div className={css.downloadFailure} role="alert">
    <p className={css.preparationError}>{t(`download.${failure.reason}`, { resource: failure.resource, status: String(failure.status) })}</p>
    <p>{t(`downloadAdvice.${failure.reason}`)}</p>
    <small className={css.metric}>{t('downloadSource', { source: failure.source })}</small>
    {failure.code && <small className={css.metric}>{t('downloadCode', { code: failure.code })}</small>}
  </div>
}

/** Render a collapsed current-step summary or all Host-owned preparation steps. */
export function PreparationCard({ provider, connected, prepare, cancelPreparation, t }: PreparationCardProps) {
  const state = provider.preparation
  const [expanded, setExpanded] = useState(false), [now, setNow] = useState(Date.now), [error, setError] = useState('')
  const [source, setSource] = useState(''), [submitting, setSubmitting] = useState(false)
  const sources = provider.downloadSources ?? []
  const [firstSource = ''] = sources
  const selectedSource = sources.includes(source) ? source : sources.length === 1 ? firstSource : ''
  const canPrepare = ['unprepared', 'cancelled', 'failed'].includes(state.phase)
  const current = state.steps?.find(step => step.status === 'running' || step.status === 'failed' || step.status === 'cancelled')
  const preparing = preparationTone(state) === 'ongoing'
  const startedAt = current?.startedAt ?? ('startedAt' in state ? state.startedAt : undefined)
  useEffect(() => {
    if (!preparing || startedAt === undefined) return
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [preparing, startedAt])
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setError(''); setSubmitting(true)
    try { await action() } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setSubmitting(false) }
  }
  const metric = state.phase === 'downloading' ? byteText(state, t)
    : preparing && startedAt !== undefined ? t('elapsed', { seconds: String(Math.max(0, Math.floor((now - startedAt) / 1000))) }) : ''
  const summary = !connected ? t('reconnecting') : preparing && current ? t(`step.${current.kind}`, { name: provider.name })
    : state.phase === 'downloading' ? t('short.downloading')
      : state.phase === 'failed' ? t('short.failed')
        : state.phase === 'ready' && provider.location === 'cloud' ? t('cloudReady')
          : t(`preparation.${state.phase}`, { name: provider.name })
  return <section className={css.preparation} data-speech-provider={provider.id}>
    <strong>{provider.name}</strong>
    {state.phase === 'unprepared' && provider.location === 'host-local' && provider.setupEstimate && <div className={css.setupEstimate}>
      <p>{t('setup.local')}</p>
      <dl>
        <div><dt>{t('setup.disk')}</dt><dd>{t('setup.diskValue', {
          gb: String(provider.setupEstimate.recommendedDiskBytes / 1_000_000_000),
        })}</dd></div>
        <div><dt>{t('setup.memory')}</dt><dd>{t('setup.memoryValue', {
          gb: String(provider.setupEstimate.expectedMemoryBytes / 1_000_000_000),
        })}</dd></div>
        <div><dt>{t('setup.time')}</dt><dd>{t('setup.timeValue', {
          min: String(provider.setupEstimate.minimumMinutes), max: String(provider.setupEstimate.maximumMinutes),
        })}</dd></div>
      </dl>
      <small>{t('setup.estimateNote')}</small>
    </div>}
    <DisclosureRow icon={<StateDot state={preparationTone(state)} size={16} appearance="step" />}
      title={expanded ? t('preparationSteps') : summary} open={expanded} expandable={(state.steps?.length ?? 0) > 0} expandOnRowClick previewChevron={false}
      onToggle={() => { setExpanded(value => !value) }} rowClassName={css.summaryRow} titleClassName={css.summaryTitle}
      collapsedContent={<><span className={css.metric} role="status">{metric}</span>{state.steps && <IconChevronDownOutlineRegular />}</>}>
      <ol className={css.steps}>
        {state.steps?.map(step => <li key={step.kind} data-step={step.kind} data-step-state={step.status}
          aria-label={`${t(`step.${step.kind}`, { name: provider.name })} · ${t(`stepStatus.${step.status}`)}`}>
          <StateDot appearance="step" size={16} state={step.status === 'complete' ? 'done' : step.status === 'running' ? 'ongoing'
            : step.status === 'failed' ? 'error' : 'idle'} />
          <div className={css.stepBody}><span>{t(`step.${step.kind}`, { name: provider.name })}</span>
            {step.status === 'running' && <div className={css.stepProgress}>
              <span className={css.metric} role="status">{metric}</span><DownloadProgress state={state} t={t} />
              {state.phase === 'downloading' && <small>{state.resource}</small>}
            </div>}
          </div>
        </li>)}
      </ol>
    </DisclosureRow>
    {!expanded && <DownloadProgress state={state} t={t} />}
    {state.phase === 'failed' && <PreparationFailure state={state} t={t} />}
    {canPrepare && sources.length > 0 && <div className={css.sourceChoice}>
      <label>{t('sourceChoice')}<select aria-label={t('sourceChoice')} value={selectedSource} disabled={!connected || submitting || sources.length === 1}
        onChange={(event) => { setSource(event.target.value) }}>
        {sources.length > 1 && <option value="">{t('sourceAuto')}</option>}
        {sources.map(origin => <option key={origin} value={origin}>
          {origin === 'https://huggingface.co' ? t('sourceHuggingFace')
            : origin === 'https://hf-mirror.com' ? t('sourceMirror') : origin}
        </option>)}
      </select></label>
      <small className={css.metric}>{t(selectedSource === '' ? 'sourceAutoHelp' : 'sourceManualHelp')}</small>
    </div>}
    <div className={css.preparationActions}>
      {canPrepare && <Button variant="outline" size="sm" disabled={!connected || submitting}
        onClick={() => { void run(() => selectedSource === '' ? prepare(provider.id) : prepare(provider.id, { downloadSource: selectedSource })) }}>{t(state.phase === 'unprepared' ? 'prepare' : 'retryPrepare')}</Button>}
      {preparing && state.phase !== 'waking' && <Button variant="ghost" size="sm" disabled={!connected || submitting || state.phase === 'cancelling'}
        onClick={() => { void run(() => cancelPreparation(provider.id)) }}>{t('cancelPrepare')}</Button>}
    </div>
    {error && <p className={css.preparationError} role="alert">{t('failed', { message: error })}</p>}
  </section>
}

/** Recognition preferences and preparation cards shared by plugin details and Settings. */
export function VoicePreparation({ useSpeechReadiness, ...props }: Pick<InjectFace<VoiceInputInjected>,
  'useSpeechReadiness' | 'configure' | 'prepare' | 'cancelPreparation'> & PropsLocale<typeof NS>) {
  const readiness = useSpeechReadiness(value => value), catalog = readiness.catalog
  const [saving, setSaving] = useState(false), [error, setError] = useState('')
  const configure = async (patch: SpeechSelectionPatch): Promise<void> => {
    setSaving(true); setError('')
    try { await props.configure(patch) } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setSaving(false) }
  }
  const selected = catalog?.providers.find(provider => provider.id === catalog.selection.providerId)
  const languageNames: Readonly<Record<string, string>> = {
    auto: props.t('auto'), zh: props.t('zh'), en: props.t('en'), yue: props.t('yue'), ja: props.t('ja'), ko: props.t('ko'),
  }
  return <div>
    {catalog && <div className={css.preferences}>
      <label>{props.t('provider')}<select value={catalog.selection.providerId} disabled={!readiness.connected || saving}
        onChange={(event) => { void configure({ providerId: event.target.value as SpeechProviderId }) }}>
        {catalog.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
      </select></label>
      <label>{props.t('language')}<select value={catalog.selection.language} disabled={!readiness.connected || saving}
        onChange={(event) => { void configure({ language: event.target.value }) }}>
        {selected?.languages.map(language =>
          <option key={language} value={language}>{languageNames[language] ?? language}</option>)}
      </select></label>
      <p>{props.t(selected?.location === 'cloud' ? 'cloud' : 'local')}</p>
      {error && <p role="alert">{props.t('failed', { message: error })}</p>}
    </div>}
    {catalog?.providers.map(provider =>
      <PreparationCard key={provider.id} provider={provider} connected={readiness.connected} {...props} />)}
    {!catalog && <p role="status">{props.t('loading')}</p>}
    {readiness.error && <p role="alert">{props.t('failed', { message: readiness.error })}</p>}
  </div>
}
