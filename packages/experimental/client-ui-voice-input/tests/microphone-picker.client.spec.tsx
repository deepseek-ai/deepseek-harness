// @vitest-environment jsdom
/** Page-active capture, selected input routing, and late permissions use real audio ownership. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MicrophonePicker } from '../src/client/MicrophonePicker.tsx'
import { createMicrophoneDeviceStore } from '../src/client/microphone-device.ts'
import { Recording, RecordingError } from '../src/client/audio.ts'
import { en, zh } from '../src/client/locales.ts'
import { captureFixture } from './audio-fixture.client.ts'

const t = makeTranslate(zh, commonZh)
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals() })

function fixture() {
  const audio = captureFixture(), selection = createMicrophoneDeviceStore()
  const enumerateDevices = vi.fn(async () => [
    { kind: 'audioinput', deviceId: 'default', label: 'Default' },
    { kind: 'audioinput', deviceId: 'usb', label: 'USB microphone' },
    { kind: 'audioinput', deviceId: 'internal', label: 'Built-in microphone' },
    { kind: 'audiooutput', deviceId: 'speakers', label: 'Speakers' },
  ])
  const media = Object.assign(new EventTarget(), { getUserMedia: audio.getUserMedia, enumerateDevices })
  vi.stubGlobal('navigator', { mediaDevices: media })
  const recordings: Recording[] = []
  const props = { t, useMicrophoneDevice: bindSnapshotSelector(selection),
    selectMicrophone: (device: { id: string; label: string }) => { selection.set(device) },
    createRecording: () => {
      const capture = new Recording(() => {}, selection.getSnapshot().id)
      recordings.push(capture)
      return capture
    } }
  const view = render(<MicrophonePicker {...props} />)
  return { ...audio, ...view, media, enumerateDevices, recordings, props, selection }
}
function selector(): HTMLSelectElement {
  return screen.getByRole<HTMLSelectElement>('combobox', { name: zh.inputDevice })
}

async function waitForPreview(): Promise<void> {
  await screen.findByRole('img', { name: zh.inputLevel })
}

it('captures while the page is active, keeps the meter through field blur, and remembers the selected input', async () => {
  const b = fixture()
  try {
    await waitForPreview()
    expect(screen.queryByRole('option', { name: 'Speakers' })).toBeNull()
    expect(screen.getByRole('img', { name: zh.inputLevel })).toBeTruthy()
    fireEvent.change(selector(), { target: { value: 'usb' } })
    await waitFor(() => { expect(b.getUserMedia).toHaveBeenLastCalledWith({ audio: {
      echoCancellation: true, noiseSuppression: true, deviceId: { exact: 'usb' },
    }, video: false }) })
    expect(b.trackStop).toHaveBeenCalledOnce()
    await screen.findByRole('img', { name: zh.inputLevel })
    expect(selector().selectedOptions[0]?.textContent).toBe('USB microphone')
    expect(document.querySelectorAll('[data-active="true"]').length).toBeGreaterThan(0)
    const stops = b.trackStop.mock.calls.length
    fireEvent.blur(selector())
    expect(screen.getByRole('img', { name: zh.inputLevel })).toBeTruthy()
    expect(b.trackStop).toHaveBeenCalledTimes(stops)
    expect(createMicrophoneDeviceStore().getSnapshot()).toEqual({ id: 'usb', label: 'USB microphone' })
    b.unmount()
    expect(b.trackStop).toHaveBeenCalledTimes(stops + 1)
    const recording = b.props.createRecording()
    await recording.start()
    expect(b.getUserMedia.mock.calls.at(-1)?.[0].audio).toMatchObject({ deviceId: { exact: 'usb' } })
  } finally { b.unmount(); await Promise.all(b.recordings.map(recording => recording.dispose())) }
})

it('releases a permission grant arriving after the page closes', async () => {
  const b = fixture(), granted = Promise.withResolvers<typeof b.stream>()
  b.getUserMedia.mockReturnValueOnce(granted.promise)
  try {
    await waitFor(() => { expect(b.getUserMedia).toHaveBeenCalledOnce() })
    b.unmount()
    await act(async () => { granted.resolve(b.stream) })
    expect(b.trackStop).toHaveBeenCalledOnce()
    expect(screen.queryByRole('img', { name: zh.inputLevel })).toBeNull()
  } finally { b.unmount(); await Promise.all(b.recordings.map(recording => recording.dispose())) }
})

it('keeps device choices available after permission denial', async () => {
  const b = fixture()
  b.getUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
  try {
    await screen.findByText(zh.permission)
    fireEvent.change(selector(), { target: { value: 'usb' } })
    await screen.findByRole('img', { name: zh.inputLevel })
    expect(screen.queryByText(zh.permission)).toBeNull()
  } finally { b.unmount(); await Promise.all(b.recordings.map(recording => recording.dispose())) }
})

it.each([null, 'usb', { id: 3, label: 'USB' }, { id: 'usb' }])('ignores invalid persisted microphone fields: %j', (saved) => {
  localStorage.setItem('dsh.voice-input.microphone', JSON.stringify(saved))
  expect(createMicrophoneDeviceStore().getSnapshot()).toEqual({ id: '', label: '' })
})

it('stops preview on page hiding and releases tracks even when AudioContext closure fails', async () => {
  const b = fixture()
  const hidden = vi.spyOn(document, 'hidden', 'get')
  try {
    await waitForPreview()
    hidden.mockReturnValue(false)
    fireEvent(document, new Event('visibilitychange'))
    expect(screen.getByRole('img', { name: zh.inputLevel })).toBeTruthy()
    b.close.mockRejectedValueOnce(new Error('device closed'))
    hidden.mockReturnValue(true)
    fireEvent(document, new Event('visibilitychange'))
    await waitFor(() => { expect(screen.queryByRole('img', { name: zh.inputLevel })).toBeNull() })
    expect(b.trackStop).toHaveBeenCalledOnce()
    hidden.mockReturnValue(false)
    fireEvent(document, new Event('visibilitychange'))
    await screen.findByRole('img', { name: zh.inputLevel })
    expect(b.getUserMedia).toHaveBeenCalledTimes(2)
  } finally {
    hidden.mockRestore(); b.unmount()
    await Promise.allSettled(b.recordings.map(recording => recording.dispose()))
  }
})

it.each([new Error('device busy'), 'device busy'])('shows capture failures without preventing another device choice: %s', async (failure) => {
  const b = fixture()
  b.getUserMedia.mockRejectedValueOnce(failure)
  b.enumerateDevices.mockResolvedValue([{ kind: 'audioinput', deviceId: 'unnamed', label: '' }])
  try {
    await act(async () => { b.media.dispatchEvent(new Event('devicechange')) })
    await screen.findByRole('option', { name: '麦克风 1' })
    await screen.findByText('语音识别失败：device busy')
  } finally { b.unmount(); await Promise.all(b.recordings.map(recording => recording.dispose())) }
})

it('reports unavailable browser capture and enumeration failures beside the field', async () => {
  const b = fixture()
  try {
    vi.stubGlobal('navigator', {})
    b.props.createRecording = () => new Recording(() => {}, b.selection.getSnapshot().id)
    b.rerender(<MicrophonePicker {...b.props} />)
    await screen.findByText(zh.unavailable)
    vi.stubGlobal('navigator', { mediaDevices: b.media })
    b.enumerateDevices.mockRejectedValueOnce(new Error('enumeration failed'))
    b.props.createRecording = () => new Recording(() => {}, b.selection.getSnapshot().id)
    b.rerender(<MicrophonePicker {...b.props} />)
    await screen.findByText('语音识别失败：enumeration failed')
  } finally { b.unmount(); await Promise.all(b.recordings.map(recording => recording.dispose())) }
})

it('ignores device enumeration that settles after the page closes', async () => {
  const b = fixture(), result = Promise.withResolvers<Awaited<ReturnType<typeof b.enumerateDevices>>>()
  try {
    await waitForPreview()
    b.enumerateDevices.mockReturnValueOnce(result.promise)
    const enumerations = b.enumerateDevices.mock.calls.length
    act(() => { b.media.dispatchEvent(new Event('devicechange')) })
    await waitFor(() => { expect(b.enumerateDevices).toHaveBeenCalledTimes(enumerations + 1) })
    const acquisitions = b.getUserMedia.mock.calls.length
    b.unmount()
    await act(async () => { result.resolve([{ kind: 'audioinput', deviceId: 'late', label: 'Late microphone' }]) })
    expect(screen.queryByRole('option', { name: 'Late microphone' })).toBeNull()
    expect(b.getUserMedia).toHaveBeenCalledTimes(acquisitions)
  } finally { b.unmount(); await Promise.all(b.recordings.map(recording => recording.dispose())) }
})

it('does not publish a preview when the component unmounts at acquisition completion', async () => {
  const b = fixture(), acquired = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const createRecording = b.props.createRecording
  b.props.createRecording = () => {
    const capture = createRecording(), preview = capture.preview.bind(capture)
    vi.spyOn(capture, 'preview').mockImplementation(async (onError) => { await preview(onError); acquired.resolve(undefined); await release.promise })
    return capture
  }
  b.rerender(<MicrophonePicker {...b.props} />)
  try {
    await act(async () => { await acquired.promise })
    const enumerations = b.enumerateDevices.mock.calls.length
    b.unmount()
    await act(async () => { release.resolve(undefined) })
    expect(b.trackStop).toHaveBeenCalledOnce()
    expect(b.enumerateDevices).toHaveBeenCalledTimes(enumerations)
  } finally { release.resolve(undefined); await Promise.all(b.recordings.map(recording => recording.dispose())) }
})

it('ignores enumeration failure and a queued interruption after unmount', async () => {
  const b = fixture(), pending = Promise.withResolvers<Awaited<ReturnType<typeof b.enumerateDevices>>>()
  let interrupted: ((error: RecordingError) => void) | undefined
  const createRecording = b.props.createRecording
  b.props.createRecording = () => {
    const capture = createRecording(), preview = capture.preview.bind(capture)
    vi.spyOn(capture, 'preview').mockImplementation(async (onError) => { interrupted = onError; await preview(onError) })
    return capture
  }
  b.rerender(<MicrophonePicker {...b.props} />)
  try {
    await waitForPreview()
    b.enumerateDevices.mockReturnValueOnce(pending.promise)
    act(() => { b.media.dispatchEvent(new Event('devicechange')) })
    const acquisitions = b.getUserMedia.mock.calls.length
    b.unmount()
    await act(async () => { pending.reject(new Error('Late enumeration')); interrupted!(new RecordingError('interrupted')) })
    expect(b.getUserMedia).toHaveBeenCalledTimes(acquisitions)
    expect(b.trackStop).toHaveBeenCalledOnce()
  } finally { pending.resolve([]); b.unmount(); await Promise.all(b.recordings.map(recording => recording.dispose())) }
})

async function selectUsb(b: ReturnType<typeof fixture>): Promise<void> {
  await waitForPreview()
  fireEvent.change(selector(), { target: { value: 'usb' } })
  await screen.findByRole('img', { name: zh.inputLevel })
  await act(async () => {})
  expect(b.selection.getSnapshot().id).toBe('usb')
}

it('inserts and removes unused devices without restarting the selected microphone', async () => {
  const b = fixture()
  try {
    await selectUsb(b)
    const existing = await b.enumerateDevices(), acquisitions = b.getUserMedia.mock.calls.length, stops = b.trackStop.mock.calls.length
    b.enumerateDevices.mockResolvedValue([...existing, { kind: 'audioinput', deviceId: 'new', label: 'New microphone' }])
    await act(async () => { b.media.dispatchEvent(new Event('devicechange')) })
    expect(screen.getByRole('option', { name: 'New microphone' })).toBeTruthy()
    b.enumerateDevices.mockResolvedValue(existing.filter(device => device.deviceId !== 'internal'))
    await act(async () => { b.media.dispatchEvent(new Event('devicechange')) })
    expect(screen.queryByRole('option', { name: 'Built-in microphone' })).toBeNull()
    expect(b.getUserMedia).toHaveBeenCalledTimes(acquisitions)
    expect(b.trackStop).toHaveBeenCalledTimes(stops)
    expect(selector().selectedOptions[0]?.textContent).toBe('USB microphone')
    expect(screen.getByRole('img', { name: zh.inputLevel })).toBeTruthy()
  } finally { b.unmount(); await Promise.all(b.recordings.map(recording => recording.dispose())) }
})

it.each(['track-first', 'devices-first'])('retains the disconnected selection and recovers its preview (%s)', async (order) => {
  const b = fixture()
  try {
    await selectUsb(b)
    const existing = await b.enumerateDevices(), acquisitions = b.getUserMedia.mock.calls.length, stops = b.trackStop.mock.calls.length
    const index = screen.getAllByRole('option').findIndex(item => item.textContent?.includes('USB microphone'))
    b.enumerateDevices.mockResolvedValue(existing.filter(device => device.deviceId !== 'usb'))
    await act(async () => {
      if (order === 'track-first') b.track.dispatchEvent(new Event('ended'))
      b.media.dispatchEvent(new Event('devicechange'))
    })
    if (order === 'devices-first') await act(async () => { b.track.dispatchEvent(new Event('ended')) })
    const unavailable = screen.getByRole<HTMLOptionElement>('option', { name: `USB microphone — ${zh.deviceUnavailable}` })
    expect(unavailable.disabled).toBe(true)
    expect(screen.getAllByRole('option')[index]).toBe(unavailable)
    expect(screen.queryByRole('img', { name: zh.inputLevel })).toBeNull()
    expect(b.trackStop).toHaveBeenCalledTimes(stops + 1)
    expect(b.selection.getSnapshot()).toEqual({ id: 'usb', label: 'USB microphone' })
    fireEvent.change(selector(), { target: { value: 'usb' } })
    expect(b.getUserMedia).toHaveBeenCalledTimes(acquisitions)
    b.enumerateDevices.mockResolvedValue(existing)
    await act(async () => { b.media.dispatchEvent(new Event('devicechange')) })
    await screen.findByRole('img', { name: zh.inputLevel })
    expect(b.getUserMedia).toHaveBeenCalledTimes(acquisitions + 1)
    expect(b.getUserMedia.mock.calls.at(-1)?.[0].audio).toMatchObject({ deviceId: { exact: 'usb' } })
  } finally { b.unmount(); await Promise.all(b.recordings.map(recording => recording.dispose())) }
})

it('keeps preview active across blur and reacquires it after reconnect', async () => {
  const b = fixture()
  try {
    await selectUsb(b)
    const existing = await b.enumerateDevices(), acquisitions = b.getUserMedia.mock.calls.length
    fireEvent.blur(selector())
    expect(screen.getByRole('img', { name: zh.inputLevel })).toBeTruthy()
    b.enumerateDevices.mockResolvedValue(existing.filter(device => device.deviceId !== 'usb'))
    await act(async () => { b.media.dispatchEvent(new Event('devicechange')) })
    expect(selector().selectedOptions[0]?.textContent).toContain(zh.deviceUnavailable)
    b.enumerateDevices.mockResolvedValue(existing)
    await act(async () => { b.media.dispatchEvent(new Event('devicechange')) })
    expect(selector().selectedOptions[0]?.textContent).toBe('USB microphone')
    await screen.findByRole('img', { name: zh.inputLevel })
    expect(b.getUserMedia).toHaveBeenCalledTimes(acquisitions + 1)
  } finally { b.unmount(); await Promise.all(b.recordings.map(recording => recording.dispose())) }
})

it('forgets the missing row when another microphone is selected and does not switch back on reconnect', async () => {
  const b = fixture()
  try {
    await selectUsb(b)
    const existing = await b.enumerateDevices()
    b.enumerateDevices.mockResolvedValue(existing.filter(device => device.deviceId !== 'usb'))
    await act(async () => { b.media.dispatchEvent(new Event('devicechange')) })
    fireEvent.change(selector(), { target: { value: 'internal' } })
    await screen.findByRole('img', { name: zh.inputLevel })
    expect(screen.queryByRole('option', { name: /USB microphone/ })).toBeNull()
    const acquisitions = b.getUserMedia.mock.calls.length
    b.enumerateDevices.mockResolvedValue(existing)
    await act(async () => { b.media.dispatchEvent(new Event('devicechange')) })
    expect(screen.getByRole('option', { name: 'USB microphone' })).toBeTruthy()
    expect(b.selection.getSnapshot().id).toBe('internal')
    expect(b.getUserMedia).toHaveBeenCalledTimes(acquisitions)
  } finally { b.unmount(); await Promise.all(b.recordings.map(recording => recording.dispose())) }
})

it.each(['resolve', 'reject'])('ignores an older enumeration after a newer hot-plug result (%s)', async (settle) => {
  const b = fixture(), pending = Promise.withResolvers<Awaited<ReturnType<typeof b.enumerateDevices>>>()
  try {
    await selectUsb(b)
    const existing = await b.enumerateDevices()
    b.enumerateDevices.mockReturnValueOnce(pending.promise)
    act(() => { b.media.dispatchEvent(new Event('devicechange')) })
    b.enumerateDevices.mockResolvedValue(existing.filter(device => device.deviceId !== 'usb'))
    await act(async () => { b.media.dispatchEvent(new Event('devicechange')) })
    await act(async () => { if (settle === 'resolve') pending.resolve(existing); else pending.reject(new Error('Stale failure')) })
    expect(screen.getByRole('option', { name: `USB microphone — ${zh.deviceUnavailable}` })).toBeTruthy()
    expect(screen.queryByRole('img', { name: zh.inputLevel })).toBeNull()
    expect(screen.queryByText('语音识别失败：Stale failure')).toBeNull()
  } finally { pending.resolve([]); b.unmount(); await Promise.all(b.recordings.map(recording => recording.dispose())) }
})

it('releases a late grant after unplugging the requested device and allows a fresh reconnect', async () => {
  const b = fixture(), grant = Promise.withResolvers<typeof b.stream>()
  try {
    await waitForPreview()
    const existing = await b.enumerateDevices()
    b.getUserMedia.mockReturnValueOnce(grant.promise)
    fireEvent.change(selector(), { target: { value: 'usb' } })
    await waitFor(() => { expect(b.getUserMedia).toHaveBeenCalledTimes(2) })
    b.enumerateDevices.mockResolvedValue(existing.filter(device => device.deviceId !== 'usb'))
    await act(async () => { b.media.dispatchEvent(new Event('devicechange')) })
    b.enumerateDevices.mockResolvedValue(existing)
    await act(async () => { b.media.dispatchEvent(new Event('devicechange')) })
    const stops = b.trackStop.mock.calls.length
    await act(async () => { grant.resolve(b.stream) })
    expect(b.trackStop).toHaveBeenCalledTimes(stops + 1)
    await screen.findByRole('img', { name: zh.inputLevel })
  } finally { grant.resolve(b.stream); b.unmount(); await Promise.all(b.recordings.map(recording => recording.dispose())) }
})

it('requests permission for a remembered device when enumeration hides its identity', async () => {
  const b = fixture()
  try {
    b.enumerateDevices.mockResolvedValue([{ kind: 'audioinput', deviceId: '', label: '' }])
    act(() => { b.selection.set({ id: 'usb', label: 'USB microphone' }) })
    await waitForPreview()
    expect(screen.queryByText(zh.deviceUnavailable)).toBeNull()
  } finally { b.unmount(); await Promise.all(b.recordings.map(recording => recording.dispose())) }
})

it('recovers system-default preview after its track ends and shows unavailable when no input remains', async () => {
  const b = fixture()
  try {
    await waitForPreview()
    await act(async () => { b.track.dispatchEvent(new Event('ended')) })
    expect(b.getUserMedia).toHaveBeenCalledTimes(2)
    expect(b.getUserMedia.mock.calls.at(-1)?.[0].audio).not.toHaveProperty('deviceId')
    b.enumerateDevices.mockResolvedValue([])
    await act(async () => { b.media.dispatchEvent(new Event('devicechange')) })
    const unavailable = screen.getByRole<HTMLOptionElement>('option', { name: `系统默认（Fixture microphone） — ${zh.deviceUnavailable}` })
    expect(unavailable.disabled).toBe(true)
    expect(screen.queryByRole('img', { name: zh.inputLevel })).toBeNull()
  } finally { b.unmount(); await Promise.all(b.recordings.map(recording => recording.dispose())) }
})

it('updates locale text without re-enumerating or restarting the active microphone', async () => {
  const b = fixture()
  try {
    await waitForPreview()
    const acquisitions = b.getUserMedia.mock.calls.length, enumerations = b.enumerateDevices.mock.calls.length
    b.rerender(<MicrophonePicker {...b.props} t={makeTranslate(en, commonEn)} />)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: en.inputDevice }).selectedOptions[0]?.textContent)
      .toBe('System default (Fixture microphone)')
    expect(b.getUserMedia).toHaveBeenCalledTimes(acquisitions)
    expect(b.enumerateDevices).toHaveBeenCalledTimes(enumerations)
    expect(b.trackStop).not.toHaveBeenCalled()
  } finally { b.unmount(); await Promise.all(b.recordings.map(recording => recording.dispose())) }
})

it('persists raw unnamed labels and translates a retained permission failure', async () => {
  const b = fixture()
  b.enumerateDevices.mockResolvedValue([{ kind: 'audioinput', deviceId: 'unnamed', label: '' }])
  b.getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
  try {
    await act(async () => { b.media.dispatchEvent(new Event('devicechange')) })
    await screen.findByRole('option', { name: '麦克风 1' })
    fireEvent.change(selector(), { target: { value: 'unnamed' } })
    await screen.findByText(zh.permission)
    expect(b.selection.getSnapshot()).toEqual({ id: 'unnamed', label: '' })
    const acquisitions = b.getUserMedia.mock.calls.length
    b.rerender(<MicrophonePicker {...b.props} t={makeTranslate(en, commonEn)} />)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: en.inputDevice }).selectedOptions[0]?.textContent).toBe('Microphone 1')
    expect(screen.getByText(en.permission)).toBeTruthy()
    expect(b.getUserMedia).toHaveBeenCalledTimes(acquisitions)
  } finally { b.unmount(); await Promise.all(b.recordings.map(recording => recording.dispose())) }
})

it('shows a localized name while a restored unnamed selection awaits enumeration', async () => {
  localStorage.setItem('dsh.voice-input.microphone', JSON.stringify({ id: 'usb', label: '' }))
  const b = fixture()
  try {
    expect(selector().selectedOptions[0]?.textContent).toBe(zh.unnamedSelectedMicrophone)
    await waitFor(() => { expect(selector().selectedOptions[0]?.textContent).toBe('USB microphone') })
    await waitFor(() => { expect(b.getUserMedia).toHaveBeenCalledOnce() })
  } finally { b.unmount(); await Promise.all(b.recordings.map(recording => recording.dispose())) }
})

it('shows refreshed names in the field and retains them on disconnect', async () => {
  const b = fixture()
  try {
    await selectUsb(b)
    const acquisitions = b.getUserMedia.mock.calls.length
    b.enumerateDevices.mockResolvedValue([{ kind: 'audioinput', deviceId: 'usb', label: 'Renamed microphone' }])
    await act(async () => { b.media.dispatchEvent(new Event('devicechange')) })
    expect(selector().selectedOptions[0]?.textContent).toBe('Renamed microphone')
    expect(b.getUserMedia).toHaveBeenCalledTimes(acquisitions)
    b.enumerateDevices.mockResolvedValue([])
    await act(async () => { b.media.dispatchEvent(new Event('devicechange')) })
    expect(selector().selectedOptions[0]?.textContent).toBe(`Renamed microphone — ${zh.deviceUnavailable}`)
  } finally { b.unmount(); await Promise.all(b.recordings.map(recording => recording.dispose())) }
})

it('keeps the active system device name and the communications choice', async () => {
  const b = fixture()
  const inputs = [
    { kind: 'audioinput', deviceId: 'default', groupId: 'internal', label: 'Default alias' },
    { kind: 'audioinput', deviceId: 'internal', groupId: 'internal', label: 'Built-in microphone' },
    { kind: 'audioinput', deviceId: 'communications', groupId: 'headset', label: 'Communications headset' },
  ]
  b.enumerateDevices.mockResolvedValue(inputs)
  try {
    await act(async () => { b.media.dispatchEvent(new Event('devicechange')) })
    expect(selector().selectedOptions[0]?.textContent).toBe('系统默认（Fixture microphone）')
    await waitForPreview()
    await screen.findByRole('option', { name: 'Communications headset' })
    fireEvent.change(selector(), { target: { value: 'communications' } })
    await screen.findByRole('img', { name: zh.inputLevel })
    expect(b.getUserMedia.mock.calls.at(-1)?.[0].audio).toMatchObject({ deviceId: { exact: 'communications' } })
    expect(screen.queryByRole('option', { name: 'Default alias' })).toBeNull()
  } finally { b.unmount(); await Promise.all(b.recordings.map(recording => recording.dispose())) }
})

it('uses the acquired device group to show its physical name without the browser default prefix', async () => {
  const b = fixture()
  b.stream.getAudioTracks()[0]!.label = 'Default - Active microphone'
  const devices = [
    { kind: 'audioinput', deviceId: 'default', groupId: 'other-input', label: 'Default - Other microphone' },
    { kind: 'audioinput', deviceId: 'other', groupId: 'other-input', label: 'Other microphone' },
    { kind: 'audioinput', deviceId: 'active', groupId: 'fixture-input', label: 'Active microphone' },
  ]
  b.enumerateDevices.mockResolvedValue(devices)
  try {
    await act(async () => { b.media.dispatchEvent(new Event('devicechange')) })
    expect(selector().selectedOptions[0]?.textContent).toBe('系统默认（Active microphone）')
    expect(b.getUserMedia).toHaveBeenCalledOnce()
  } finally { b.unmount(); await Promise.all(b.recordings.map(recording => recording.dispose())) }
})

it('does not restore a previous default device name and persists only the system preference', async () => {
  localStorage.setItem('dsh.voice-input.microphone', JSON.stringify({ id: '', label: 'Previous default microphone' }))
  const b = fixture()
  try {
    expect(selector().selectedOptions[0]?.textContent).toBe(zh.systemMicrophone)
    await waitForPreview()
    fireEvent.change(selector(), { target: { value: '' } })
    expect(b.selection.getSnapshot()).toEqual({ id: '', label: '' })
    expect(b.getUserMedia).toHaveBeenCalledOnce()
  } finally { b.unmount(); await Promise.all(b.recordings.map(recording => recording.dispose())) }
})
