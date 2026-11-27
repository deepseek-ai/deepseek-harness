/** Click-to-record toolbar activity; transcripts remain in the original Session draft. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TranscriptionRequest } from '@deepseek-ai/dsh-experimental-api-speech-to-text/types'
import type {
  SpeechPreparationOptions, SpeechProviderId, SpeechProviderView, SpeechSelection, SpeechSelectionPatch, Transcript,
} from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { audioBase64, type Recording } from './audio.ts'
import { failureText } from './failure-text.ts'
import { canRecord, localProvider, selectedProvider, voiceGuidance } from './guidance.ts'
import type { MicrophoneDevice } from './microphone-device.ts'
import type { SpeechReadiness } from './readiness.ts'
import { Waveform } from './Waveform.tsx'
import { VoiceSetupDialog } from './VoiceSetupDialog.tsx'
import { NS } from './locales.ts'
import { Button, IconCloseOutlineRegular, IconStopFillRegular, IconMicrophoneOutlineRegular, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives/client'
import css from './VoiceInput.module.css'

/** Host calls injected without exposing a Cordis Context to React. */
export interface VoiceInputActions {
  /** Open the voice bundle details without starting preparation. */
  openSettings: () => void
  /** @returns one microphone operation owned by the plugin lifecycle. */
  createRecording: () => Recording
  /** Remember the browser microphone used by previews and subsequent recordings. */
  selectMicrophone: (device: MicrophoneDevice) => void
  transcribe: (request: TranscriptionRequest, signal: AbortSignal) => Promise<RemoteResult<Transcript>>
  prepare: (providerId: SpeechProviderId, options?: SpeechPreparationOptions) => Promise<void>
  cancelPreparation: (providerId: SpeechProviderId) => Promise<void>
  configure: (patch: SpeechSelectionPatch) => Promise<void>
  /** Open account sign-in from the current click; does nothing while the account UI offers no entry. */
  signIn: () => void
}

/** Entry-injected Host readiness and microphone operations. */
export interface VoiceInputInjected extends VoiceInputActions {
  hooks: {
    speechReadiness: HostObservable<SpeechReadiness>
    microphoneDevice: HostObservable<MicrophoneDevice>
    /** Whether the Plugins page navigation service is present; the setup dialog offers the details only while it is. */
    pluginNavigation: HostObservable<boolean>
    /** Whether the account UI offers sign-in; sign-in actions appear only while it does. */
    accountSignIn: HostObservable<boolean>
  }
}

/** Composer-owned expansion and draft actions; preferences stay in plugin settings. */
export type VoiceInputProps = Pick<PropsRuntime<'conversation.input.activity'>, 'sessionId' | 'inputActions' | 'locked' | 'onActiveChange'>
  & PropsLocale<typeof NS> & InjectFace<VoiceInputInjected>

type Phase = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'feedback'
/** Recovery offered beside a classified failure; switching to local recognition names its target. */
type FeedbackAction = { readonly kind: 'sign-in' } | { readonly kind: 'use-local'; readonly provider: SpeechProviderView }
interface ActiveRecording {
  readonly capture: Recording
  readonly abort: AbortController
  readonly span: TokenSpan
  readonly selection: SpeechSelection
  /** Whether the provider this recording was sent to processes audio in the cloud, fixed when recording starts. */
  readonly cloud: boolean
  readonly maxDurationSeconds: number
  readonly maxAudioBytes: number
  phase: 'requesting' | 'recording' | 'transcribing'
  timer?: ReturnType<typeof setTimeout> | undefined
}

async function disposeRecording(capture: Recording): Promise<void> {
  try { await capture.dispose() } catch (_error) {
    // Tracks stop before AudioContext.close(); a close failure must not hide the recording result.
  }
}

/** Render a compact microphone or an expanded capture, transcription, or retry row. */
export function VoiceInput({ sessionId, inputActions, locked, onActiveChange, createRecording, transcribe, openSettings,
  configure, signIn, useSpeechReadiness, usePluginNavigation, useAccountSignIn, t }: VoiceInputProps) {
  const readiness = useSpeechReadiness(value => value), catalog = readiness.catalog
  const navigable = usePluginNavigation(present => present)
  const signInPresent = useAccountSignIn(present => present)
  const provider = selectedProvider(catalog), local = localProvider(catalog)
  // A provider switch blocks recording until the catalog shows the new selection, so no recording reaches the old one.
  const [switching, setSwitching] = useState<SpeechProviderId>()
  useEffect(() => {
    if (switching !== undefined && catalog?.selection.providerId === switching) setSwitching(undefined)
  }, [switching, catalog])
  const usable = readiness.connected && canRecord(provider) && switching === undefined
  const cloud = provider?.location === 'cloud'
  const [phase, setPhase] = useState<Phase>('idle'), [message, setMessage] = useState(''), [pending, setPending] = useState('')
  const [action, setAction] = useState<FeedbackAction>()
  const [setupOpen, setSetupOpen] = useState(false)
  useEffect(() => { if (usable) setSetupOpen(false) }, [usable])
  const current = useRef<ActiveRecording>(undefined), generation = useRef(0)
  const expanded = phase !== 'idle'
  useLayoutEffect(() => { onActiveChange(expanded); return () => { onActiveChange(false) } }, [expanded, onActiveChange])

  const cancel = (): void => {
    generation.current++
    const active = current.current
    current.current = undefined
    if (active) { clearTimeout(active.timer); active.abort.abort(); void disposeRecording(active.capture) }
    setPending(''); setMessage(''); setAction(undefined); setPhase('idle'); setSetupOpen(false)
  }
  useEffect(() => {
    setPending(''); setMessage(''); setAction(undefined); setPhase('idle'); setSetupOpen(false)
    const blur = (): void => { if (current.current?.phase === 'recording') cancel() }
    const visibility = (): void => {
      if (document.hidden && current.current && current.current.phase !== 'transcribing') cancel()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && current.current) { event.preventDefault(); cancel() }
    }
    window.addEventListener('blur', blur); document.addEventListener('visibilitychange', visibility)
    document.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility)
      document.removeEventListener('keydown', escape)
      generation.current++
      const active = current.current
      current.current = undefined
      if (active) { clearTimeout(active.timer); active.abort.abort(); void disposeRecording(active.capture) }
    }
  }, [sessionId])

  const feedback = (text: string, recovery?: FeedbackAction): void => { setMessage(text); setAction(recovery); setPhase('feedback') }
  const finish = async (): Promise<void> => {
    const active = current.current
    if (!active || active.phase !== 'recording') return
    active.phase = 'transcribing'
    const run = generation.current
    clearTimeout(active.timer); setPhase('transcribing')
    try {
      const audio = await active.capture.stop(active.maxDurationSeconds)
      if (run !== generation.current) return
      if (audio.byteLength > active.maxAudioBytes) { feedback(t('tooLarge')); return }
      const result = await transcribe({ audioBase64: audioBase64(audio), providerId: active.selection.providerId,
        language: active.selection.language }, active.abort.signal)
      if (run !== generation.current) return
      if (!result.ok) {
        const code = result.error.code === 'speech/transcription-failed' ? result.error.details.code : undefined
        if (code === undefined) { feedback(t('failed', { message: result.error.message })); return }
        feedback(t(`failure.${code}`), code === 'sign-in-required' && signInPresent ? { kind: 'sign-in' }
          : (code === 'service-unavailable' || code === 'quota-exceeded') && local !== undefined
            ? { kind: 'use-local', provider: local } : undefined)
        return
      }
      if (result.value.text === '') { feedback(t('empty')); return }
      if (!inputActions.insertText(result.value.text, active.span)) { setPending(result.value.text); feedback(t('conflict')); return }
      setPhase('idle')
    } catch (failure) {
      await disposeRecording(active.capture)
      if (run === generation.current) feedback(failureText(failure, t))
    } finally { if (run === generation.current) current.current = undefined }
  }
  const start = async (): Promise<void> => {
    if (!catalog || !usable || locked || current.current) return
    const run = ++generation.current
    const active: ActiveRecording = { capture: createRecording(), abort: new AbortController(),
      span: inputActions.captureInsertion(), selection: catalog.selection, cloud,
      maxDurationSeconds: catalog.maxDurationSeconds, maxAudioBytes: catalog.maxAudioBytes, phase: 'requesting' }
    current.current = active
    setMessage(''); setPending(''); setAction(undefined); setPhase('requesting')
    try {
      await active.capture.start((failure) => {
        if (run !== generation.current || current.current !== active || active.phase === 'transcribing') return
        current.current = undefined
        clearTimeout(active.timer); active.abort.abort()
        feedback(failureText(failure, t))
      })
      if (run !== generation.current || current.current !== active) return
      active.phase = 'recording'
      setPhase('recording')
      active.timer = setTimeout(() => { void finish() }, active.maxDurationSeconds * 1000)
    } catch (failure) {
      await disposeRecording(active.capture)
      if (run === generation.current) { current.current = undefined; feedback(failureText(failure, t)) }
    }
  }
  const guidance = voiceGuidance(catalog, readiness.connected)
  const useLocal = (target: SpeechProviderView): void => {
    setSetupOpen(false); setAction(undefined); setPhase('idle'); setSwitching(target.id)
    void configure({ providerId: target.id }).then(() => {
      if (target.preparation.phase === 'unprepared' && navigable) openSettings()
    }, (failure: unknown) => { setSwitching(undefined); feedback(failureText(failure, t)) })
  }
  const requestSignIn = (): void => { setSetupOpen(false); setAction(undefined); setPhase('idle'); signIn() }
  if (!expanded) return <>
    <Tooltip label={t(cloud ? 'dictateCloud' : 'dictate')} disabled={!usable} side="top" portal>
      <span className={css.triggerAnchor}><Button className={css.trigger} size="sm" disabled={locked}
        aria-label={t(usable ? 'start' : 'setupPrompt.trigger')} aria-haspopup={usable ? undefined : 'dialog'}
        onMouseDown={(event) => { event.preventDefault() }}
        onClick={() => { if (usable) void start(); else setSetupOpen(true) }}><IconMicrophoneOutlineRegular size={18} /></Button></span>
    </Tooltip>
    <VoiceSetupDialog open={setupOpen && guidance !== null} kind={guidance ?? 'unavailable'}
      onDismiss={() => { setSetupOpen(false) }}
      onOpenDetails={navigable ? () => { setSetupOpen(false); openSettings() } : undefined}
      onSignIn={signInPresent ? requestSignIn : undefined} onUseLocal={local === undefined ? undefined : () => { useLocal(local) }} t={t} />
  </>
  return <div className={css.captureRow} data-voice-activity={phase}>
    <Button type="button" className={css.roundButton} size="sm" aria-label={t(pending ? 'discard' : 'cancel')}
      onClick={cancel}><IconCloseOutlineRegular size={14} /></Button>
    {phase === 'recording' ? <Waveform recording={current.current?.capture} label={t('recording')} />
      : <span className={css.activityMessage} role="status" title={pending || message}>
        {(phase === 'requesting' || phase === 'transcribing') && <StateDot state="ongoing" />}
        {phase === 'feedback' ? message : t(phase === 'requesting' ? 'requesting'
          : provider?.preparation.phase === 'waking' ? 'wakingShort' : current.current?.cloud === true ? 'transcribingCloud' : 'transcribingShort')}</span>}
    {phase === 'recording' && <Button type="button" className={css.roundButton} size="sm" aria-label={t('stop')}
      onClick={() => { void finish() }}><IconStopFillRegular size={14} /></Button>}
    {phase === 'feedback' && action !== undefined && <Button className={css.inlineAction} size="sm" type="button"
      onClick={action.kind === 'sign-in' ? requestSignIn : () => { useLocal(action.provider) }}>
      {t(action.kind === 'sign-in' ? 'signIn' : 'useLocal')}</Button>}
    {phase === 'feedback' && (pending
      ? <Button className={css.inlineAction} size="sm" type="button" onClick={() => {
        if (inputActions.insertText(pending, inputActions.captureInsertion())) { setPending(''); setPhase('idle') }
      }}>{t('insert')}</Button>
      : <Button className={css.roundButton} size="sm" type="button" aria-label={t('retryRecording')} disabled={!usable || locked}
        onClick={() => { void start() }}><IconMicrophoneOutlineRegular size={18} /></Button>)}
  </div>
}
