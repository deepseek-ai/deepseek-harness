/** Device selection owns microphone previews while its page is active. */
import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { VoiceInputInjected } from './VoiceInput.tsx'
import { RecordingError, type Recording } from './audio.ts'
import type { MicrophoneDevice } from './microphone-device.ts'
import { failureText } from './failure-text.ts'
import { NS } from './locales.ts'
import css from './VoiceInput.module.css'

interface DeviceChoice extends MicrophoneDevice { unavailable?: boolean }

function InputLevel({ recording, label }: { recording: Recording; label: string }) {
  const meter = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const bars = Array.from((meter.current as HTMLSpanElement).children)
    let frame: number
    const draw = (): void => {
      const decibels = 20 * Math.log10(Math.max(recording.amplitude(), 0.00001))
      const count = Math.ceil(Math.max(0, Math.min(1, (decibels + 60) / 60)) * bars.length)
      for (const [index, bar] of bars.entries()) bar.setAttribute('data-active', String(index < count))
      frame = requestAnimationFrame(draw)
    }
    draw()
    return () => { cancelAnimationFrame(frame) }
  }, [recording])
  return <span ref={meter} className={css.inputLevel} role="img" aria-label={label}>
    {Array.from({ length: 8 }, (_, index) => <span key={index} />)}
  </span>
}

/** Render the selected input and preview its measured level without recording audio. */
export function MicrophonePicker({ useMicrophoneDevice, selectMicrophone, createRecording, t }:
  Pick<InjectFace<VoiceInputInjected>, 'useMicrophoneDevice' | 'selectMicrophone' | 'createRecording'> & PropsLocale<typeof NS>) {
  const selected = useMicrophoneDevice(value => value)
  const [devices, setDevices] = useState<DeviceChoice[]>([
    { id: selected.id, label: selected.id === '' ? '' : selected.label },
  ])
  const [preview, setPreview] = useState<Recording>(), [error, setError] = useState<{ failure: unknown }>()
  useEffect(() => {
    const media = (navigator as Partial<Navigator>).mediaDevices
    const lifetime = new AbortController()
    let capture: Recording | undefined, enumeration = 0
    const release = (): void => {
      if (capture) void capture.dispose().catch(() => undefined)
      capture = undefined
    }
    setPreview(undefined); setError(undefined)
    const fail = (failure: unknown): void => {
      if (lifetime.signal.aborted) return
      setError({ failure })
    }
    const acquire = async (): Promise<void> => {
      const recording = createRecording()
      capture = recording
      const interrupted = (failure: RecordingError): void => {
        if (capture !== recording || lifetime.signal.aborted) return
        release(); setPreview(undefined); fail(failure)
        void refresh()
      }
      try {
        await recording.preview(interrupted)
        if (capture !== recording || lifetime.signal.aborted) return
        setPreview(recording); setError(undefined)
        void refresh()
      } catch (failure) {
        if (capture !== recording || lifetime.signal.aborted) return
        release(); setPreview(undefined); fail(failure)
      }
    }
    const refresh = async (): Promise<void> => {
      const request = ++enumeration
      try {
        if (!media) throw new RecordingError('unavailable')
        const inputs = (await media.enumerateDevices()).filter(device => device.kind === 'audioinput')
        if (lifetime.signal.aborted || request !== enumeration) return
        // Before permission, browsers may hide device ids and labels; absence then does not establish disconnection.
        const known = inputs.length === 0 || inputs.some(device => device.label !== '')
        const missing = selected.id === '' ? inputs.length === 0 : known && !inputs.some(device => device.deviceId === selected.id)
        const system = inputs.find(device => device.deviceId === 'default')
        const activeDefault = selected.id === '' ? capture?.deviceInfo() : undefined
        const groupId = activeDefault?.groupId || system?.groupId
        const physicalDefault = groupId ? inputs.find(device => device.groupId === groupId
          && device.deviceId !== 'default' && device.deviceId !== 'communications') : undefined
        const defaultLabel = physicalDefault?.label || activeDefault?.label || system?.label || ''
        // Our system row replaces default; communications keeps the OS's separate default communications input.
        const choices: DeviceChoice[] = [{ id: '', label: defaultLabel, unavailable: inputs.length === 0 },
          ...inputs.filter(device => device.deviceId !== '' && device.deviceId !== 'default').map(device => ({
            id: device.deviceId, label: device.label,
          }))]
        setDevices((previous) => {
          const next = [...choices]
          if (selected.id !== '' && !next.some(device => device.id === selected.id)) {
            const knownDevice = previous.find(device => device.id === selected.id)
            next.splice(Math.max(1, previous.findIndex(device => device.id === selected.id)), 0,
              { id: selected.id, label: knownDevice?.label ?? '', unavailable: missing })
          }
          return next
        })
        if (missing) { release(); setPreview(undefined); setError(undefined) }
        else if (!document.hidden && !capture) void acquire()
      } catch (failure) { if (request === enumeration) fail(failure) }
    }
    const changed = (): void => { void refresh() }
    const hidden = (): void => {
      if (document.hidden) { release(); setPreview(undefined) }
      else changed()
    }
    media?.addEventListener('devicechange', changed, { signal: lifetime.signal })
    document.addEventListener('visibilitychange', hidden, { signal: lifetime.signal })
    changed()
    return () => {
      lifetime.abort()
      release()
    }
  }, [selected.id, createRecording])
  const choices = devices.filter(device => !device.unavailable || device.id === selected.id || device.id === '')
  const missing = choices.find(device => device.id === selected.id)?.unavailable
  const deviceName = (device: MicrophoneDevice, index: number): string => {
    if (device.id === '') return device.label ? t('systemMicrophoneNamed', { name: device.label }) : t('systemMicrophone')
    return device.label || (device.id === selected.id ? selected.label : '')
      || (index > 0 ? t('unnamedMicrophone', { number: String(index) }) : t('unnamedSelectedMicrophone'))
  }
  return <div className={css.deviceRow} data-voice-input-device>
    <label htmlFor="voice-input-device">{t('inputDevice')}</label>
    <span className={css.deviceField}>
      <select id="voice-input-device" value={selected.id} className={preview ? css.deviceSelectMeter : undefined}
        onChange={(event) => {
          const device = choices.find(item => item.id === event.target.value) as DeviceChoice
          selectMicrophone({ id: device.id, label: device.id === '' ? '' : device.label })
        }}>
        {choices.map((device, index) => <option key={device.id} value={device.id} disabled={device.unavailable}>
          {deviceName(device, index)}{device.unavailable ? ` — ${t('deviceUnavailable')}` : ''}
        </option>)}
      </select>
      {preview && !missing && <span className={css.deviceMeter}><InputLevel recording={preview} label={t('inputLevel')} /></span>}
    </span>
    {error && <span className={css.deviceError} role="alert">{failureText(error.failure, t)}</span>}
  </div>
}
