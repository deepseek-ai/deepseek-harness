/** Click-to-record toolbar activity; transcripts remain in the original Session draft. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TranscriptionRequest } from '@deepseek-ai/dsh-experimental-api-speech-to-text/types'
import type { SpeechPreparationOptions, SpeechProviderId, SpeechSelection, SpeechSelectionPatch, Transcript } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { RecordingError, audioBase64, type Recording } from './audio.ts'
import type { SpeechReadiness } from './readiness.ts'
import { Waveform } from './Waveform.tsx'
import { VoiceSetupDialog } from './VoiceSetupDialog.tsx'
import { NS } from './locales.ts'
import { Button, IconCloseOutlineRegular, IconStopFillRegular, IconMicrophoneOutlineRegular, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './VoiceInput.module.css'

/** Host calls injected without exposing a Cordis Context to React. */
export interface VoiceInputActions {
  /** Open the voice bundle details without starting preparation. */
  openSettings: () => void
  /** @returns one microphone operation owned by the plugin lifecycle. */
  createRecording: () => Recording
  transcribe: (request: TranscriptionRequest, signal: AbortSignal) => Promise<RemoteResult<Transcript>>
  prepare: (providerId: SpeechProviderId, options?: SpeechPreparationOptions) => Promise<void>
  cancelPreparation: (providerId: SpeechProviderId) => Promise<void>
  configure: (patch: SpeechSelectionPatch) => Promise<void>
}

/** Entry-injected Host readiness and microphone operations. */
export interface VoiceInputInjected extends VoiceInputActions {
  hooks: { speechReadiness: HostObservable<SpeechReadiness> }
}

/** Composer-owned expansion and draft actions; preferences stay in plugin settings. */
export type VoiceInputProps = Pick<PropsRuntime<'conversation.input.activity'>, 'sessionId' | 'inputActions' | 'locked' | 'onActiveChange'>
  & PropsLocale<typeof NS> & InjectFace<VoiceInputInjected>

type Phase = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'feedback'
interface ActiveRecording {
  readonly capture: Recording
  readonly abort: AbortController
  readonly span: TokenSpan
  readonly selection: SpeechSelection
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
export function VoiceInput({ sessionId, inputActions, locked, onActiveChange,
  createRecording, transcribe, openSettings, useSpeechReadiness, t }: VoiceInputProps) {
  const readiness = useSpeechReadiness(value => value), catalog = readiness.catalog
  const provider = catalog?.providers.find(item => item.id === catalog.selection.providerId)
  const usable = readiness.connected && (provider?.preparation.phase === 'ready' || provider?.preparation.phase === 'standby'
    || provider?.preparation.phase === 'waking')
  const [phase, setPhase] = useState<Phase>('idle'), [message, setMessage] = useState(''), [pending, setPending] = useState('')
  const [setupOpen, setSetupOpen] = useState(false)
  useEffect(() => { if (usable) setSetupOpen(false) }, [usable])
  const current = useRef<ActiveRecording>(), generation = useRef(0)
  const expanded = phase !== 'idle'
  useLayoutEffect(() => { onActiveChange(expanded); return () => { onActiveChange(false) } }, [expanded, onActiveChange])

  const cancel = (): void => {
    generation.current++
    const active = current.current
    current.current = undefined
    if (active) { clearTimeout(active.timer); active.abort.abort(); void disposeRecording(active.capture) }
    setPending(''); setMessage(''); setPhase('idle'); setSetupOpen(false)
  }
  useEffect(() => {
    setPending(''); setMessage(''); setPhase('idle'); setSetupOpen(false)
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

  const feedback = (text: string): void => { setMessage(text); setPhase('feedback') }
  const failureText = (failure: unknown): string => failure instanceof RecordingError ? t(failure.kind)
    : t('failed', { message: failure instanceof Error ? failure.message : String(failure) })
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
      const result = await transcribe({ audioBase64: audioBase64(audio), ...active.selection }, active.abort.signal)
      if (run !== generation.current) return
      if (!result.ok) { feedback(t('failed', { message: result.error.message })); return }
      if (result.value.text === '') { feedback(t('empty')); return }
      if (!inputActions.insertText(result.value.text, active.span)) { setPending(result.value.text); feedback(t('conflict')); return }
      setPhase('idle')
    } catch (failure) {
      await disposeRecording(active.capture)
      if (run === generation.current) feedback(failureText(failure))
    } finally { if (run === generation.current) current.current = undefined }
  }
  const start = async (): Promise<void> => {
    if (!catalog || !usable || locked || current.current) return
    const run = ++generation.current
    const active: ActiveRecording = { capture: createRecording(), abort: new AbortController(),
      span: inputActions.captureInsertion(), selection: catalog.selection,
      maxDurationSeconds: catalog.maxDurationSeconds, maxAudioBytes: catalog.maxAudioBytes, phase: 'requesting' }
    current.current = active
    setMessage(''); setPending(''); setPhase('requesting')
    try {
      await active.capture.start((failure) => {
        if (run !== generation.current || current.current !== active || active.phase === 'transcribing') return
        current.current = undefined
        clearTimeout(active.timer); active.abort.abort()
        feedback(failureText(failure))
      })
      if (run !== generation.current || current.current !== active) return
      active.phase = 'recording'
      setPhase('recording')
      active.timer = setTimeout(() => { void finish() }, active.maxDurationSeconds * 1000)
    } catch (failure) {
      await disposeRecording(active.capture)
      if (run === generation.current) { current.current = undefined; feedback(failureText(failure)) }
    }
  }
  if (!expanded) return <>
    <Tooltip label={t('dictate')} disabled={!usable} side="top" portal>
      <span className={css.triggerAnchor}><Button className={css.trigger} size="sm" disabled={locked}
        aria-label={t(usable ? 'start' : 'setupPrompt.trigger')} aria-haspopup={usable ? undefined : 'dialog'}
        onMouseDown={(event) => { event.preventDefault() }}
        onClick={() => { if (usable) void start(); else setSetupOpen(true) }}><IconMicrophoneOutlineRegular size={18} /></Button></span>
    </Tooltip>
    <VoiceSetupDialog open={setupOpen && !usable}
      needsInstallation={readiness.connected && provider?.location === 'host-local' && provider.preparation.phase === 'unprepared'}
      onDismiss={() => { setSetupOpen(false) }} onOpenDetails={() => { setSetupOpen(false); openSettings() }} t={t} />
  </>
  return <div className={css.captureRow} data-voice-activity={phase}>
    <Button type="button" className={css.roundButton} size="sm" aria-label={t(pending ? 'discard' : 'cancel')}
      onClick={cancel}><IconCloseOutlineRegular size={14} /></Button>
    {phase === 'recording' ? <Waveform recording={current.current?.capture} label={t('recording')} />
      : <span className={css.activityMessage} role="status" title={pending || message}>
        {(phase === 'requesting' || phase === 'transcribing') && <StateDot state="ongoing" />}
        {phase === 'feedback' ? message : t(phase === 'requesting' ? 'requesting'
          : provider?.preparation.phase === 'waking' ? 'wakingShort' : 'transcribingShort')}</span>}
    {phase === 'recording' && <Button type="button" className={css.roundButton} size="sm" aria-label={t('stop')}
      onClick={() => { void finish() }}><IconStopFillRegular size={14} /></Button>}
    {phase === 'feedback' && (pending
      ? <Button className={css.inlineAction} size="sm" type="button" onClick={() => {
        if (inputActions.insertText(pending, inputActions.captureInsertion())) { setPending(''); setPhase('idle') }
      }}>{t('insert')}</Button>
      : <Button className={css.roundButton} size="sm" type="button" aria-label={t('retryRecording')} disabled={!usable || locked}
        onClick={() => { void start() }}><IconMicrophoneOutlineRegular size={18} /></Button>)}
  </div>
}
