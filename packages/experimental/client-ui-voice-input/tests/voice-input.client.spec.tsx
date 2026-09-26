// @vitest-environment jsdom
/** Click capture preserves draft edits and Session ownership without composer banners. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SpeechPreparationState, SpeechProviderId, Transcript } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { VoiceInput, type VoiceInputProps } from '../src/client/VoiceInput.tsx'
import { RecordingError, Recording } from '../src/client/audio.ts'
import type { SpeechReadiness } from '../src/client/readiness.ts'
import { zh } from '../src/client/locales.ts'
import { captureFixture } from './audio-fixture.client.ts'

beforeEach(() => { vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn()) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
const id = 'sensevoice-local' as SpeechProviderId
const transcript: Transcript = { text: '检查 TypeScript 类型', audioSeconds: 2, inferenceSeconds: 0.4 }
function fixture(recording?: Recording) {
  const capture = Object.assign(new Recording(() => {}), { start: vi.fn<Recording['start']>(async () => {}), stop: vi.fn(async () => new Uint8Array(48)),
    amplitude: () => 0, dispose: vi.fn(async () => {}) })
  const inputActions = { notify: vi.fn(), captureInsertion: vi.fn(() => ({ start: 3, end: 3, draftRev: 1 })), insertText: vi.fn(() => true),
    setDraft: vi.fn(), addAttachments: vi.fn(() => true), removeAttachment: vi.fn(), pruneAttachments: vi.fn(), submit: vi.fn() }
  const readiness = createSnapshotStore<SpeechReadiness>({ connected: true, error: null, catalog: {
    providers: [{ id, name: 'SenseVoiceSmall', location: 'host-local', languages: ['auto', 'zh', 'en', 'ja'], preparation: { phase: 'ready' } }],
    selection: { providerId: id, language: 'auto' }, maxAudioBytes: 100, maxDurationSeconds: 120,
  } })
  const transcribe = vi.fn<(request: unknown, signal: AbortSignal) => Promise<RemoteResult<Transcript>>>(
    async () => ({ ok: true, value: transcript }))
  const props: VoiceInputProps = { sessionId: 'one' as SessionId, inputActions, transcribe, locked: false, onActiveChange: vi.fn(),
    openSettings: vi.fn(), prepare: vi.fn(async () => {}), cancelPreparation: vi.fn(async () => {}), configure: vi.fn(async () => {}),
    useSpeechReadiness: bindSnapshotSelector(readiness), createRecording: () => recording ?? capture,
    t: makeTranslate(zh, commonZh) }
  const view = render(<VoiceInput {...props} />)
  return { props, capture, inputActions, readiness, transcribe, view }
}
async function start(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: zh.start }))
  await screen.findByRole('button', { name: zh.stop })
}
function stop(): void { fireEvent.click(screen.getByRole('button', { name: zh.stop })) }

it('clicks to record, shows measured audio, and stops to insert without sending or a popup', async () => {
  const b = fixture()
  fireEvent.mouseEnter(screen.getByRole('button', { name: zh.start }).parentElement!)
  expect(screen.getByRole('tooltip').textContent).toBe('听写')
  fireEvent.mouseDown(screen.getByRole('button', { name: zh.start }))
  await start()
  expect(b.props.onActiveChange).toHaveBeenLastCalledWith(true)
  expect(screen.getByRole('img', { name: zh.recording })).toBeTruthy()
  expect(b.transcribe).not.toHaveBeenCalled()
  stop()
  await waitFor(() => { expect(b.inputActions.insertText).toHaveBeenCalledWith(transcript.text, { start: 3, end: 3, draftRev: 1 }) })
  expect(b.inputActions.submit).not.toHaveBeenCalled()
  expect(b.inputActions.notify).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(b.props.onActiveChange).toHaveBeenLastCalledWith(false)
})

it.each(['cancel', 'escape', 'blur', 'hidden'])('releases a recording without transcription on %s', async (how) => {
  const b = fixture(); await start()
  if (how === 'cancel') fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
  if (how === 'escape') fireEvent.keyDown(document, { key: 'Escape' })
  if (how === 'blur') fireEvent.blur(window)
  if (how === 'hidden') {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    try { fireEvent(document, new Event('visibilitychange')) } finally { delete (document as { hidden?: boolean }).hidden }
  }
  await screen.findByRole('button', { name: zh.start })
  expect(b.capture.dispose).toHaveBeenCalled()
  expect(b.transcribe).not.toHaveBeenCalled()
})

it.each([false, true])('invalidates permission settlement after cancel (failure=%s)', async (failure) => {
  const b = fixture(), permission = Promise.withResolvers<undefined>()
  b.capture.start.mockReturnValueOnce(permission.promise)
  fireEvent.click(screen.getByRole('button', { name: zh.start }))
  expect(screen.getByRole('status').textContent).toBe(zh.requesting)
  fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
  if (failure) permission.reject(new Error('permission closed'))
  else permission.resolve(undefined)
  await act(async () => {})
  expect(b.capture.dispose).toHaveBeenCalled()
  expect(b.inputActions.notify).not.toHaveBeenCalled()
  expect(screen.queryByText('permission closed')).toBeNull()
})

it('keeps provider and language fixed and preserves conflicting text for explicit insertion', async () => {
  const b = fixture(); b.inputActions.insertText.mockReturnValue(false)
  await start()
  const state = b.readiness.getSnapshot()
  act(() => { b.readiness.set({ ...state, catalog: { ...state.catalog!, selection: { providerId: id, language: 'en' } } }) })
  stop()
  const insert = await screen.findByRole('button', { name: zh.insert })
  expect(b.transcribe).toHaveBeenCalledWith(expect.objectContaining({ language: 'auto' }), expect.any(AbortSignal))
  fireEvent.click(insert)
  expect(screen.getByRole('button', { name: zh.insert })).toBeTruthy()
  b.inputActions.insertText.mockReturnValue(true)
  fireEvent.click(insert)
  expect(screen.getByRole('button', { name: zh.start })).toBeTruthy()
  b.inputActions.insertText.mockReturnValue(false)
  await start(); stop()
  fireEvent.click(await screen.findByRole('button', { name: zh.discard }))
  expect(screen.queryByRole('button', { name: zh.insert })).toBeNull()
})

it.each(['transcription', 'conversion', 'failed conversion'])('discards late %s after switching Sessions', async (phase) => {
  const b = fixture(), result = Promise.withResolvers<RemoteResult<Transcript>>()
  const conversion = Promise.withResolvers<Uint8Array<ArrayBuffer>>()
  if (phase === 'transcription') b.transcribe.mockReturnValueOnce(result.promise)
  else b.capture.stop.mockReturnValueOnce(conversion.promise)
  await start(); stop()
  await act(async () => {})
  b.view.rerender(<VoiceInput {...b.props} sessionId={'two' as SessionId} />)
  if (phase === 'transcription') result.resolve({ ok: true, value: transcript })
  else if (phase === 'conversion') conversion.resolve(new Uint8Array(48))
  else conversion.reject(new Error('cancelled'))
  await act(async () => {})
  expect(b.inputActions.insertText).not.toHaveBeenCalled()
  expect(b.inputActions.notify).not.toHaveBeenCalled()
})

it('keeps empty-speech and service errors inside the toolbar with retry and dismissal', async () => {
  const b = fixture()
  b.transcribe.mockResolvedValueOnce({ ok: true, value: { ...transcript, text: '' } })
  await start(); stop()
  expect((await screen.findByRole('status')).textContent).toBe(zh.empty)
  expect(b.inputActions.notify).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.retryRecording }))
  await screen.findByRole('button', { name: zh.stop })
  b.transcribe.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
  stop()
  await screen.findByText('语音识别失败：offline')
  fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
  expect(screen.getByRole('button', { name: zh.start })).toBeTruthy()
})

it.each([new RecordingError('permission'), new Error('device lost'), 'device lost'])('handles capture failure locally (%s)', async (failure) => {
  const b = fixture(); b.capture.start.mockRejectedValueOnce(failure)
  fireEvent.click(screen.getByRole('button', { name: zh.start }))
  await screen.findByText(failure instanceof RecordingError ? zh.permission : '语音识别失败：device lost')
  expect(b.inputActions.notify).not.toHaveBeenCalled()
})

it.each([new RecordingError('empty'), new Error('decode failed'), 'decode failed'])('handles conversion failure locally (%s)', async (failure) => {
  const b = fixture(); b.capture.stop.mockRejectedValueOnce(failure)
  await start(); stop()
  await screen.findByText(failure instanceof RecordingError ? zh.empty : '语音识别失败：decode failed')
  expect(b.capture.dispose).toHaveBeenCalledOnce()
  expect(b.inputActions.insertText).not.toHaveBeenCalled()
})

it('bounds recordings, indicates idle wake-up, and cancels an in-flight transcription', async () => {
  const b = fixture(), result = Promise.withResolvers<RemoteResult<Transcript>>()
  b.transcribe.mockReturnValueOnce(result.promise)
  vi.useFakeTimers()
  fireEvent.click(screen.getByRole('button', { name: zh.start })); await act(async () => {})
  await act(async () => { await vi.advanceTimersByTimeAsync(120000) })
  expect(b.capture.stop).toHaveBeenCalledWith(120)
  fireEvent.blur(window)
  const state = b.readiness.getSnapshot()
  act(() => { b.readiness.set({ ...state, catalog: { ...state.catalog!, providers: [
    { ...state.catalog!.providers[0]!, preparation: { phase: 'waking', startedAt: Date.now() } },
  ] } }) })
  expect(screen.getByRole('status').textContent).toBe(zh.wakingShort)
  expect(b.transcribe.mock.calls[0]?.[1].aborted).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
  expect(b.transcribe.mock.calls[0]?.[1].aborted).toBe(true)
  result.resolve({ ok: true, value: transcript }); await act(async () => {})
  expect(b.inputActions.insertText).not.toHaveBeenCalled()
})

it('rejects excessive audio and keeps locked recognition disabled', async () => {
  const b = fixture(); b.capture.stop.mockResolvedValueOnce(new Uint8Array(101))
  await start(); stop(); await screen.findByText(zh.tooLarge)
  expect(b.transcribe).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
  act(() => { b.readiness.set({ catalog: null, connected: false, error: null }) })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['setupPrompt.trigger'] }).disabled).toBe(false)
  b.view.rerender(<VoiceInput {...b.props} locked />)
  const locked = screen.getByRole<HTMLButtonElement>('button', { name: zh['setupPrompt.trigger'] })
  expect(locked.disabled).toBe(true)
  fireEvent.click(locked)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(b.capture.start).toHaveBeenCalledOnce()
})

it('releases expansion and contains cleanup failures on unmount', async () => {
  const b = fixture()
  fireEvent.keyDown(document, { key: 'x' }); fireEvent.blur(window); fireEvent(document, new Event('visibilitychange'))
  await start()
  b.capture.dispose.mockRejectedValueOnce(new Error('already closed'))
  b.view.unmount(); await act(async () => {})
  expect(b.props.onActiveChange).toHaveBeenLastCalledWith(false)
  expect(b.capture.dispose).toHaveBeenCalledOnce()
})

it('coalesces repeated capture and stop clicks before the toolbar rerenders', async () => {
  const b = fixture(), microphone = screen.getByRole<HTMLButtonElement>('button', { name: zh.start })
  act(() => { microphone.click(); microphone.click() })
  const stopButton = await screen.findByRole<HTMLButtonElement>('button', { name: zh.stop })
  act(() => { stopButton.click(); stopButton.click() })
  await waitFor(() => { expect(b.inputActions.insertText).toHaveBeenCalledOnce() })
  expect(b.capture.start).toHaveBeenCalledOnce()
  expect(b.capture.stop).toHaveBeenCalledOnce()
})

it('ends the recording UI immediately on a device failure and clears automatic transcription', async () => {
  const devices = captureFixture(), b = fixture(devices.recording), closing = Promise.withResolvers<undefined>()
  devices.close.mockReturnValueOnce(closing.promise)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    fireEvent.click(screen.getByRole('button', { name: zh.start }))
    await act(async () => {})
    expect(screen.getByRole('button', { name: zh.stop })).toBeTruthy()
    act(() => { devices.failRecorder() })
    expect(screen.queryByRole('button', { name: zh.stop })).toBeNull()
    expect(screen.queryByRole('img', { name: zh.recording })).toBeNull()
    expect(screen.getByRole('status').textContent).toBe(zh.interrupted)
    expect(devices.disposed).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(120000) })
    expect(b.transcribe).not.toHaveBeenCalled()
    expect(b.inputActions.notify).not.toHaveBeenCalled()
  } finally { closing.resolve(undefined); await devices.recording.dispose() }
})

it.each(['cancel', 'session', 'unmount', 'finishing', 'finished'])('ignores interruption notifications after %s', async (action) => {
  const b = fixture()
  await start()
  const failed = b.capture.start.mock.calls[0]![0]!
  if (action === 'cancel') fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
  if (action === 'session') b.view.rerender(<VoiceInput {...b.props} sessionId={'two' as SessionId} />)
  if (action === 'unmount') b.view.unmount()
  const pending = Promise.withResolvers<RemoteResult<Transcript>>()
  if (action === 'finishing') b.transcribe.mockReturnValueOnce(pending.promise)
  if (action === 'finishing' || action === 'finished') { stop(); await act(async () => {}) }
  try {
    act(() => { failed(new RecordingError('interrupted')) })
    expect(screen.queryByText(zh.interrupted)).toBeNull()
    expect(b.inputActions.notify).not.toHaveBeenCalled()
  } finally { pending.resolve({ ok: true, value: transcript }); await act(async () => {}) }
})

it('does not restore recording when capture reports failure before start settles', async () => {
  const b = fixture()
  b.capture.start.mockImplementationOnce(async (failed) => { failed!(new RecordingError('interrupted')) })
  fireEvent.click(screen.getByRole('button', { name: zh.start }))
  await act(async () => {})
  expect(screen.getByRole('status').textContent).toBe(zh.interrupted)
  expect(screen.queryByRole('button', { name: zh.stop })).toBeNull()
  expect(b.transcribe).not.toHaveBeenCalled()
})

it('allows recording while verified local resources are waking', async () => {
  const b = fixture(), state = b.readiness.getSnapshot()
  act(() => { b.readiness.set({ ...state, catalog: { ...state.catalog!, providers: [
    { ...state.catalog!.providers[0]!, preparation: { phase: 'waking', startedAt: 0 } },
  ] } }) })
  await start()
  stop()
  await waitFor(() => { expect(b.inputActions.insertText).toHaveBeenCalledWith(transcript.text, expect.anything()) })
})

it('keeps the first recording after the permission prompt causes window blur', async () => {
  const b = fixture(), permission = Promise.withResolvers<undefined>()
  b.capture.start.mockReturnValueOnce(permission.promise)
  fireEvent.click(screen.getByRole('button', { name: zh.start }))
  fireEvent.blur(window)
  expect(screen.getByRole('status').textContent).toBe(zh.requesting)
  expect(b.capture.dispose).not.toHaveBeenCalled()
  permission.resolve(undefined)
  await screen.findByRole('button', { name: zh.stop })
  stop()
  await waitFor(() => { expect(b.inputActions.insertText).toHaveBeenCalledOnce() })
})

it.each(['escape', 'hidden', 'session'])('discards pending permission after %s', async (action) => {
  const b = fixture(), permission = Promise.withResolvers<undefined>()
  b.capture.start.mockReturnValueOnce(permission.promise)
  fireEvent.click(screen.getByRole('button', { name: zh.start }))
  if (action === 'escape') fireEvent.keyDown(document, { key: 'Escape' })
  if (action === 'session') b.view.rerender(<VoiceInput {...b.props} sessionId={'two' as SessionId} />)
  if (action === 'hidden') {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    try { fireEvent(document, new Event('visibilitychange')) } finally { delete (document as { hidden?: boolean }).hidden }
  }
  permission.resolve(undefined)
  await act(async () => {})
  expect(b.capture.dispose).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: zh.start })).toBeTruthy()
  expect(screen.queryByRole('button', { name: zh.stop })).toBeNull()
  expect(b.transcribe).not.toHaveBeenCalled()
})

it('offers installation on click without a preparation tooltip', () => {
  const b = fixture(), state = b.readiness.getSnapshot()
  act(() => { b.readiness.set({ ...state, catalog: { ...state.catalog!, providers: [
    { ...state.catalog!.providers[0]!, preparation: { phase: 'unprepared' } },
  ] } }) })
  const mic = screen.getByRole<HTMLButtonElement>('button', { name: zh['setupPrompt.trigger'] })
  expect(mic.disabled).toBe(false)
  expect(mic.getAttribute('aria-haspopup')).toBe('dialog')
  fireEvent.mouseEnter(mic.parentElement!)
  expect(screen.queryByRole('tooltip')).toBeNull()
  fireEvent.click(mic)
  expect(screen.getByRole('dialog').textContent).toContain(zh['setupPrompt.body'])
  expect(b.capture.start).not.toHaveBeenCalled()
  expect(b.props.prepare).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh['setupPrompt.open'] }))
  expect(b.props.openSettings).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each<SpeechPreparationState>([
  { phase: 'checking', step: 'check', startedAt: 0 },
  { phase: 'downloading', resource: 'model', completedBytes: 0 },
  { phase: 'failed', message: 'download failed' },
  { phase: 'cancelled' },
])('guides $phase recognition to its status page without starting recording or preparation', (preparation) => {
  const b = fixture(), state = b.readiness.getSnapshot()
  act(() => { b.readiness.set({ ...state, catalog: { ...state.catalog!, providers: [
    { ...state.catalog!.providers[0]!, preparation },
  ] } }) })
  fireEvent.click(screen.getByRole('button', { name: zh['setupPrompt.trigger'] }))
  expect(screen.getByRole('dialog').textContent).toContain(zh['setupPrompt.unavailableBody'])
  expect(screen.queryByText(zh['setupPrompt.body'])).toBeNull()
  expect(b.capture.start).not.toHaveBeenCalled()
  expect(b.props.prepare).not.toHaveBeenCalled()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: zh['setupPrompt.details'] }))
  expect(b.props.openSettings).toHaveBeenCalledOnce()
})

it('moves focus into setup guidance, contains Tab traversal, and restores the draft focus on dismissal', () => {
  const b = fixture()
  render(<textarea aria-label="draft" defaultValue="Keep this draft" />)
  const draft = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'draft' })
  act(() => { b.readiness.set({ catalog: null, connected: false, error: 'offline' }) })
  draft.focus()
  const mic = screen.getByRole('button', { name: zh['setupPrompt.trigger'] })
  fireEvent.mouseDown(mic)
  fireEvent.click(mic)
  const dialog = screen.getByRole('dialog')
  const details = within(dialog).getByRole('button', { name: zh['setupPrompt.details'] })
  const close = within(dialog).getByRole('button', { name: zh.cancel })
  expect(document.activeElement).toBe(details)
  fireEvent.keyDown(details, { key: 'Tab' })
  expect(document.activeElement).toBe(close)
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(details)
  fireEvent.keyDown(details, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(draft)
  expect(draft.value).toBe('Keep this draft')
  expect(b.inputActions.submit).not.toHaveBeenCalled()
  expect(b.props.openSettings).not.toHaveBeenCalled()
})

it.each(['later', 'escape', 'ready', 'session'])('dismisses unavailable recognition guidance on %s without changing the draft', (reason) => {
  const b = fixture(), ready = b.readiness.getSnapshot()
  act(() => { b.readiness.set({ catalog: null, connected: false, error: 'offline' }) })
  const open = () => { fireEvent.click(screen.getByRole('button', { name: zh['setupPrompt.trigger'] })) }
  open()
  expect(screen.getByRole('dialog').textContent).toContain(zh['setupPrompt.unavailableTitle'])
  if (reason === 'later') fireEvent.click(screen.getByRole('button', { name: zh['setupPrompt.later'] }))
  if (reason === 'escape') fireEvent.keyDown(document, { key: 'Escape' })
  if (reason === 'ready') act(() => { b.readiness.set(ready) })
  if (reason === 'session') b.view.rerender(<VoiceInput {...b.props} sessionId={'two' as SessionId} />)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(b.props.openSettings).not.toHaveBeenCalled()
  expect(b.capture.start).not.toHaveBeenCalled()
  expect(b.inputActions.setDraft).not.toHaveBeenCalled()
  expect(b.inputActions.insertText).not.toHaveBeenCalled()
  if (reason === 'ready') {
    act(() => { b.readiness.set({ ...ready, connected: false }) })
    expect(screen.queryByRole('dialog')).toBeNull()
  } else {
    open()
    expect(screen.getByRole('dialog')).toBeTruthy()
  }
})
