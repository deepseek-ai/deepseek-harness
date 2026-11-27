/**
 * Bundle details: the voice preference with its audition, what keeps the read-aloud control hidden, how reading is
 * billed, which languages are read, and where the service is documented.
 */
import { useEffect, useId, useState } from 'react'
import { Button, IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { ReadAloudStatus } from '@deepseek-ai/dsh-read-aloud/types'
import type { NS, ReadAloudKey } from './locales.ts'
import { ReadControl } from './ReadControl.tsx'
import type { ReaderState, ReadingNotice, SampleTarget } from './reader.ts'
import css from './ReadAloud.module.css'

/** Entry-injected availability, audition state, and the verbs of the section. */
export interface ReadAloudSettingsInjected {
  hooks: {
    readAloudStatus: HostObservable<ReadAloudStatus>
    reader: HostObservable<ReaderState>
    /** Whether the account sign-in service is present; the sign-in action is offered only while it is. */
    accountSignIn: HostObservable<boolean>
  }
  /** Open the DeepSeek account sign-in. */
  signIn: () => void
  /**
   * Save the voice that later readings use.
   * @param voice - one of the voices the status lists.
   * @returns after the Host saved it; rejects when the Host refuses it or cannot be reached.
   */
  configure: (voice: string) => Promise<void>
  /**
   * Start the audition of one voice, or stop it while it loads or plays.
   * @param sample - voice, sentence language, and audio rate.
   */
  toggleSample: (sample: SampleTarget) => void
  /** Stop the audition in progress. */
  stopSample: () => void
  /**
   * Retire the audition failure the toast finished showing.
   * @param seq - sequence of that failure.
   */
  dismissSampleNotice: (seq: number) => void
}

/** Props of the bundle details section. */
export type ReadAloudSettingsProps = InjectFace<ReadAloudSettingsInjected> & PropsLocale<typeof NS>

/** Display names of the voices this Client knows; another id is shown as written. */
const VOICE_NAMES: ReadonlyMap<string, ReadAloudKey> = new Map<string, ReadAloudKey>([['stella', 'voice.stella'], ['tide', 'voice.tide']])
/** Audition failures that a sign-in, another API key, or a restored balance resolves; any other is a service failure. */
const CREDENTIAL: ReadonlySet<ReadingNotice> = new Set<ReadingNotice>(['sign-in-required', 'api-key-invalid', 'quota-exceeded'])
/** A failure names what to check, so it stays longer than the default three seconds. */
const HOLD_MS = 6000

/**
 * Render the read-aloud section of the bundle's details.
 * @param props - the injected state hooks and verbs, and the translator.
 * @returns the voice preference while the Host reports voices, the availability line while the control is hidden, then
 * the billing and language notes with the guide link.
 */
export function ReadAloudSettings(props: ReadAloudSettingsProps) {
  const { useReadAloudStatus, useReader, useAccountSignIn, signIn, configure, toggleSample, stopSample, dismissSampleNotice, t } = props
  const state = useReadAloudStatus(status => status.state)
  const synthesis = useReadAloudStatus(status => status.synthesis)
  const phase = useReader(reader => reader.sample?.phase)
  const notice = useReader(reader => reader.sampleNotice)
  const canSignIn = useAccountSignIn(present => present)
  const [saving, setSaving] = useState(false)
  const [unsaved, setUnsaved] = useState(false)
  const field = useId()
  // Leaving the details ends the audition: no control for it remains on screen.
  useEffect(() => stopSample, [stopSample])
  const choose = async (voice: string): Promise<void> => {
    setSaving(true)
    setUnsaved(false)
    try {
      await configure(voice)
    } catch (_refused) {
      // The Host kept the earlier voice and the status stream still reports it; the line below says so.
      setUnsaved(true)
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className={css.settings}>
      {state === 'sign-in-required' && (
        <p className={css.status} role="status">
          <span>{t('settings.signInRequired')}</span>
          {canSignIn && <Button size="sm" onClick={signIn}>{t('settings.signIn')}</Button>}
        </p>
      )}
      {state === 'unavailable' && <p className={css.status} role="status">{t('settings.unavailable')}</p>}
      {synthesis !== undefined && (
        <div className={css.voice}>
          <label htmlFor={field}>{t('settings.voice')}</label>
          <select id={field} value={synthesis.voice} disabled={saving} onChange={(event) => { void choose(event.target.value) }}>
            {synthesis.voices.map((voice) => {
              const name = VOICE_NAMES.get(voice)
              return <option key={voice} value={voice}>{name === undefined ? voice : t(name)}</option>
            })}
          </select>
          <ReadControl
            phase={phase}
            idleLabel={t('settings.sample')}
            busyLabel={t('settings.sampleStop')}
            disabled={state !== 'ready'}
            onToggle={() => { toggleSample({ voice: synthesis.voice, language: t('settings.sampleLanguage'), sampleRate: synthesis.sampleRate }) }}
          />
          {unsaved && <p className={css.voiceError} role="alert">{t('settings.voiceFailed')}</p>}
        </div>
      )}
      <p className={css.billing}>
        <span>{t('settings.billing')}</span>
        <span>{t('settings.languages')}</span>
        <a className={css.link} href={t('settings.guideUrl')} target="_blank" rel="noopener noreferrer">{t('settings.guide')}</a>
      </p>
      {notice !== null && (
        <Toast
          key={notice.seq}
          text={t(CREDENTIAL.has(notice.kind) ? 'sample.credential' : 'sample.unavailable')}
          icon={<IconWarningOutlineRegular />}
          holdMs={HOLD_MS}
          onDone={() => { dismissSampleNotice(notice.seq) }}
        />
      )}
    </div>
  )
}
