// @vitest-environment jsdom
/** Cloud recognition guidance, location cues, classified failures, and the automatic preference. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SpeechCatalog, TranscriptionRequest } from '@deepseek-ai/dsh-experimental-api-speech-to-text/types'
import type { SpeechFailureCode, SpeechPreparationState, SpeechProviderId, SpeechProviderView, Transcript } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { VoiceInput, type VoiceInputProps } from '../src/client/VoiceInput.tsx'
import { VoicePreparation } from '../src/client/PreparationCard.tsx'
import { VoiceSetupPrompt, type VoiceSetupPromptProps } from '../src/client/VoiceSetupPrompt.tsx'
import { offeredLanguages, providerLabel, voiceGuidance } from '../src/client/guidance.ts'
import { Recording } from '../src/client/audio.ts'
import type { SpeechReadiness } from '../src/client/readiness.ts'
import { zh } from '../src/client/locales.ts'

beforeEach(() => { vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn()) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const t = makeTranslate(zh, commonZh)
const CLOUD = 'deepseek-asr' as SpeechProviderId, LOCAL = 'sensevoice-local' as SpeechProviderId
const signedOut: SpeechPreparationState = { phase: 'unavailable', reason: 'sign-in-required' }

function catalog(options: { cloud?: SpeechPreparationState; local?: SpeechPreparationState; mode?: 'auto' | 'explicit'; selected?: SpeechProviderId; language?: string }): SpeechCatalog {
  const providers: SpeechProviderView[] = []
  if (options.local) providers.push({ id: LOCAL, name: 'SenseVoiceSmall (INT8)', location: 'host-local', languages: ['auto', 'zh', 'en', 'yue', 'ja', 'ko'], preparation: options.local,
    setupEstimate: { recommendedDiskBytes: 1e9, expectedMemoryBytes: 1e9, minimumMinutes: 1, maximumMinutes: 10 } })
  if (options.cloud) providers.push({ id: CLOUD, name: 'DeepSeek', location: 'cloud', languages: ['auto'], preparation: options.cloud })
  return { providers, maxAudioBytes: 1000, maxDurationSeconds: 120,
    selection: { mode: options.mode ?? 'auto', providerId: options.selected ?? CLOUD, language: options.language ?? 'zh' } }
}

describe('guidance', () => {
  it('derives the microphone guidance from the selected provider', () => {
    expect(voiceGuidance(null, true)).toBe('unavailable')
    expect(voiceGuidance(catalog({ cloud: { phase: 'ready' } }), false)).toBe('unavailable')
    expect(voiceGuidance(catalog({ cloud: { phase: 'ready' } }), true)).toBeNull()
    expect(voiceGuidance(catalog({ cloud: signedOut, mode: 'explicit' }), true)).toBe('sign-in')
    expect(voiceGuidance(catalog({ cloud: { phase: 'failed', message: 'no token' } }), true)).toBe('unavailable')
    expect(voiceGuidance(catalog({ cloud: signedOut, local: { phase: 'unprepared' }, selected: LOCAL }), true)).toBe('install-or-sign-in')
    expect(voiceGuidance(catalog({ cloud: signedOut, local: { phase: 'unprepared' }, selected: LOCAL, mode: 'explicit' }), true)).toBe('install')
    expect(voiceGuidance(catalog({ cloud: { phase: 'ready' }, local: { phase: 'unprepared' }, selected: LOCAL }), true)).toBe('install')
    expect(voiceGuidance(catalog({ local: { phase: 'checking', startedAt: 0 }, selected: LOCAL }), true)).toBe('unavailable')
  })

  it('labels providers by processing location and offers every listed language in menu order', () => {
    const both = catalog({ cloud: { phase: 'ready' }, local: { phase: 'ready' } })
    expect(both.providers.map(row => providerLabel(row, t))).toEqual(['SenseVoiceSmall (INT8) 本地识别', 'DeepSeek 云端识别'])
    expect(offeredLanguages(both, ['auto', 'zh', 'en', 'ja', 'es'])).toEqual(['auto', 'zh', 'en', 'ja', 'yue', 'ko'])
    expect(offeredLanguages(catalog({ local: { phase: 'ready' }, selected: LOCAL }), ['auto', 'es', 'zh'])).toEqual(['auto', 'zh', 'en', 'yue', 'ja', 'ko'])
    expect(offeredLanguages(null, ['auto'])).toEqual([])
  })
})

function composer(initial: SpeechCatalog, options: { signIn?: boolean; navigable?: boolean } = {}) {
  const capture = Object.assign(new Recording(() => {}), { start: vi.fn<Recording['start']>(async () => {}), stop: vi.fn(async () => new Uint8Array(48)),
    amplitude: () => 0, dispose: vi.fn(async () => {}) })
  const inputActions = { notify: vi.fn(), insertQuote: () => false, captureInsertion: vi.fn(() => ({ start: 0, end: 0, draftRev: 1 })),
    insertText: vi.fn(() => true), setDraft: vi.fn(), persistDraft: vi.fn(), addAttachments: vi.fn(() => true), removeAttachment: vi.fn(),
    pruneAttachments: vi.fn(), submit: vi.fn() }
  const readiness = createSnapshotStore<SpeechReadiness>({ connected: true, error: null, catalog: initial })
  const settle = Promise.withResolvers<RemoteResult<Transcript>>()
  const transcribe = vi.fn<(request: TranscriptionRequest, signal: AbortSignal) => Promise<RemoteResult<Transcript>>>(() => settle.promise)
  const props: VoiceInputProps = { sessionId: 'one' as SessionId, inputActions, transcribe, locked: false, onActiveChange: vi.fn(),
    openSettings: vi.fn(), prepare: vi.fn(async () => {}), cancelPreparation: vi.fn(async () => {}), configure: vi.fn(async () => {}),
    selectMicrophone: vi.fn(), useMicrophoneDevice: bindSnapshotSelector(createSnapshotStore({ id: '', label: '' })),
    useSpeechReadiness: bindSnapshotSelector(readiness), createRecording: () => capture,
    usePluginNavigation: bindSnapshotSelector(createSnapshotStore(options.navigable ?? true)),
    useAccountSignIn: bindSnapshotSelector(createSnapshotStore(options.signIn ?? true)), signIn: vi.fn(), t }
  render(<VoiceInput {...props} />)
  return { props, settle, transcribe, inputActions, readiness }
}

async function record(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: zh.start }))
  await screen.findByRole('button', { name: zh.stop })
}

describe('composer', () => {
  it('marks cloud recognition in the tooltip and transcription status without a recording badge', async () => {
    const b = composer(catalog({ cloud: { phase: 'ready' }, local: { phase: 'unprepared' } }))
    fireEvent.pointerEnter(screen.getByRole('button', { name: zh.start }).parentElement!)
    expect((await screen.findByRole('tooltip')).textContent).toBe(zh.dictateCloud)
    await record()
    expect(screen.getByRole('img', { name: zh.recording })).toBeTruthy()
    expect(screen.queryByText('云端')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.stop }))
    expect(await screen.findByText(zh.transcribingCloud)).toBeTruthy()
    // The status follows the provider this recording was sent to, not a selection that changed meanwhile.
    act(() => { b.readiness.set({ connected: true, error: null, catalog: catalog({ cloud: signedOut, local: { phase: 'ready' }, selected: LOCAL }) }) })
    expect(screen.getByText(zh.transcribingCloud)).toBeTruthy()
    const [sent] = b.transcribe.mock.calls[0]!
    expect(Object.keys(sent).sort()).toEqual(['audioBase64', 'language', 'providerId'])
    expect([sent.providerId, sent.language]).toEqual([CLOUD, 'zh'])
    act(() => { b.settle.resolve({ ok: true, value: { text: '你好', audioSeconds: 1, inferenceSeconds: 1 } }) })
    await waitFor(() => { expect(b.inputActions.insertText).toHaveBeenCalledWith('你好', { start: 0, end: 0, draftRev: 1 }) })
  })

  async function fail(b: ReturnType<typeof composer>, code: SpeechFailureCode | undefined): Promise<void> {
    await record()
    fireEvent.click(screen.getByRole('button', { name: zh.stop }))
    await waitFor(() => { expect(b.transcribe).toHaveBeenCalledOnce() })
    act(() => { b.settle.resolve({ ok: false, error: new RemoteError('speech/transcription-failed', 'HTTP 503',
      code === undefined ? { reason: 'HTTP 503' } : { reason: 'HTTP 503', code }) }) })
  }

  it('localizes classified failures and offers sign-in after an expired account', async () => {
    const b = composer(catalog({ cloud: { phase: 'ready' } }))
    await fail(b, 'sign-in-required')
    expect(await screen.findByText(zh['failure.sign-in-required'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.signIn }))
    expect(b.props.signIn).toHaveBeenCalledOnce()
    expect(screen.queryByText(zh['failure.sign-in-required'])).toBeNull()
  })

  it('omits sign-in recovery while the account UI offers no entry and keeps unclassified messages', async () => {
    const b = composer(catalog({ cloud: { phase: 'ready' } }), { signIn: false })
    await fail(b, 'sign-in-required')
    expect(await screen.findByText(zh['failure.sign-in-required'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh.signIn })).toBeNull()
    cleanup()
    const plain = composer(catalog({ cloud: { phase: 'ready' } }))
    await fail(plain, undefined)
    expect(await screen.findByText('语音识别失败：HTTP 503')).toBeTruthy()
  })

  it('reports a rejected API key without a recovery action', async () => {
    const b = composer(catalog({ cloud: { phase: 'ready' }, local: { phase: 'ready' } }))
    await fail(b, 'api-key-invalid')
    expect(await screen.findByText(zh['failure.api-key-invalid'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh.signIn })).toBeNull()
    expect(screen.queryByRole('button', { name: zh.useLocal })).toBeNull()
  })

  it('keeps the microphone from recording until the switch to local recognition reaches the catalog', async () => {
    const b = composer(catalog({ cloud: { phase: 'ready' }, local: { phase: 'ready' } }))
    await fail(b, 'service-unavailable')
    fireEvent.click(await screen.findByRole('button', { name: zh.useLocal }))
    await waitFor(() => { expect(b.props.configure).toHaveBeenCalledWith({ providerId: LOCAL }) })
    expect(screen.queryByRole('button', { name: zh.start })).toBeNull()
    expect(screen.getByRole('button', { name: zh['setupPrompt.trigger'] })).toBeTruthy()
    act(() => { b.readiness.set({ connected: true, error: null, catalog: catalog({ cloud: { phase: 'ready' }, local: { phase: 'ready' }, mode: 'explicit', selected: LOCAL }) }) })
    expect(await screen.findByRole('button', { name: zh.start })).toBeTruthy()
  })

  it('switches to local recognition after a cloud outage and opens setup for an unprepared model', async () => {
    const b = composer(catalog({ cloud: { phase: 'ready' }, local: { phase: 'unprepared' } }))
    await fail(b, 'service-unavailable')
    expect(await screen.findByText(zh['failure.service-unavailable'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.useLocal }))
    await waitFor(() => { expect(b.props.openSettings).toHaveBeenCalledOnce() })
    expect(b.props.configure).toHaveBeenCalledWith({ providerId: LOCAL })
  })

  it('switches to a prepared local model without leaving the composer', async () => {
    const b = composer(catalog({ cloud: signedOut, local: { phase: 'standby' }, mode: 'explicit' }))
    fireEvent.click(screen.getByRole('button', { name: zh['setupPrompt.trigger'] }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: zh.useLocal }))
    await waitFor(() => { expect(b.props.configure).toHaveBeenCalledWith({ providerId: LOCAL }) })
    expect(b.props.openSettings).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('offers local recognition once the daily cloud allowance is used up', async () => {
    const b = composer(catalog({ cloud: { phase: 'ready' }, local: { phase: 'standby' } }))
    await fail(b, 'quota-exceeded')
    expect(await screen.findByText(zh['failure.quota-exceeded'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.useLocal }))
    await waitFor(() => { expect(b.props.configure).toHaveBeenCalledWith({ providerId: LOCAL }) })
    expect(b.props.openSettings).not.toHaveBeenCalled()
    cleanup()
    const cloudOnly = composer(catalog({ cloud: { phase: 'ready' } }))
    await fail(cloudOnly, 'quota-exceeded')
    expect(await screen.findByText(zh['failure.quota-exceeded'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh.useLocal })).toBeNull()
  })

  it('reports a failed switch to local recognition in the toolbar', async () => {
    const b = composer(catalog({ cloud: signedOut, local: { phase: 'ready' }, mode: 'explicit' }))
    vi.mocked(b.props.configure).mockRejectedValueOnce(new Error('settings are read-only'))
    fireEvent.click(screen.getByRole('button', { name: zh['setupPrompt.trigger'] }))
    const dialog = screen.getByRole('dialog', { name: zh['signInPrompt.title'] })
    fireEvent.click(within(dialog).getByRole('button', { name: zh.useLocal }))
    expect(await screen.findByText('语音识别失败：settings are read-only')).toBeTruthy()
    expect(b.props.openSettings).not.toHaveBeenCalled()
  })

  it('asks a signed-out user of explicit cloud recognition to sign in before recording', () => {
    const b = composer(catalog({ cloud: signedOut, local: { phase: 'ready' }, mode: 'explicit' }))
    fireEvent.click(screen.getByRole('button', { name: zh['setupPrompt.trigger'] }))
    const dialog = screen.getByRole('dialog', { name: zh['signInPrompt.title'] })
    expect(within(dialog).getByText(zh['signInPrompt.body'])).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: zh.useLocal })).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: zh.signIn }))
    expect(b.props.signIn).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.transcribe).not.toHaveBeenCalled()
  })

  it('omits the sign-in button without a sign-in entry and offers both paths for automatic selection', () => {
    composer(catalog({ cloud: signedOut, mode: 'explicit' }), { signIn: false })
    fireEvent.click(screen.getByRole('button', { name: zh['setupPrompt.trigger'] }))
    let dialog = screen.getByRole('dialog', { name: zh['signInPrompt.title'] })
    expect(within(dialog).getByText(zh['signInPrompt.body'])).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: zh.signIn })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: zh['setupPrompt.later'] }))
    cleanup()
    const b = composer(catalog({ cloud: signedOut, local: { phase: 'unprepared' }, selected: LOCAL }))
    fireEvent.click(screen.getByRole('button', { name: zh['setupPrompt.trigger'] }))
    dialog = screen.getByRole('dialog', { name: zh['choicePrompt.title'] })
    fireEvent.click(within(dialog).getByRole('button', { name: zh['choicePrompt.download'] }))
    expect(b.props.openSettings).toHaveBeenCalledOnce()
  })
})

function preferences(initial: SpeechCatalog, signIn = true) {
  const store = createSnapshotStore<SpeechReadiness>({ connected: true, error: null, catalog: initial })
  const props = { useSpeechReadiness: bindSnapshotSelector(store), configure: vi.fn(async () => {}), t,
    useMicrophoneDevice: bindSnapshotSelector(createSnapshotStore({ id: '', label: '' })), selectMicrophone: vi.fn(),
    createRecording: () => new Recording(() => {}), prepare: vi.fn(async () => {}), cancelPreparation: vi.fn(async () => {}),
    useAccountSignIn: bindSnapshotSelector(createSnapshotStore(signIn)), signIn: vi.fn() }
  render(<VoicePreparation {...props} />)
  return { props, store }
}

describe('preferences', () => {
  const cardIds = (): (string | null)[] => [...document.querySelectorAll('[data-speech-provider]')].map(card => card.getAttribute('data-speech-provider'))
  it('offers the automatic preference and explains its current choice, cost, and guide', async () => {
    const b = preferences(catalog({ cloud: signedOut, local: { phase: 'unprepared' }, selected: LOCAL }))
    const service = screen.getByLabelText<HTMLSelectElement>(zh.provider)
    expect(service.value).toBe('auto')
    expect(within(service).getAllByRole('option').map(option => option.textContent))
      .toEqual([zh.providerAuto, 'SenseVoiceSmall (INT8) 本地识别', 'DeepSeek 云端识别'])
    expect(screen.getByText('当前使用：SenseVoiceSmall (INT8) 本地识别')).toBeTruthy()
    expect(screen.getByText(zh.cloudBilling)).toBeTruthy()
    const guide = screen.getByRole<HTMLAnchorElement>('link', { name: zh.cloudGuide })
    expect([guide.href, guide.target, guide.rel]).toEqual(['https://api-docs.deepseek.com/zh-cn/guides/asr', '_blank', 'noopener noreferrer'])
    expect(screen.getByText(zh['selection.autoHelp'])).toBeTruthy()
    expect(screen.getAllByText(/本地识别$/).length).toBeGreaterThan(0)
    // Automatic lists cloud before local regardless of which one is in use.
    expect(cardIds()).toEqual([CLOUD, LOCAL])
    expect(screen.getByText(zh['unavailable.sign-in-required'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.signIn }))
    expect(b.props.signIn).toHaveBeenCalledOnce()
    fireEvent.change(service, { target: { value: CLOUD } })
    await waitFor(() => { expect(b.props.configure).toHaveBeenCalledWith({ providerId: CLOUD }) })
    fireEvent.change(service, { target: { value: 'auto' } })
    await waitFor(() => { expect(b.props.configure).toHaveBeenCalledWith({ providerId: 'auto' }) })
  })

  it('offers the languages some provider lists and notes that cloud recognition detects the language', async () => {
    const b = preferences(catalog({ cloud: { phase: 'ready' }, local: { phase: 'ready' }, language: 'zh' }))
    const language = screen.getByLabelText<HTMLSelectElement>(zh.language)
    expect(language.disabled).toBe(false)
    expect(language.value).toBe('zh')
    expect(within(language).getAllByRole('option').map(option => option.getAttribute('value'))).toEqual(['auto', 'zh', 'en', 'ja', 'yue', 'ko'])
    expect(within(language).getAllByRole('option').map(option => option.textContent).slice(0, 3)).toEqual([zh.auto, zh.zh, zh.en])
    expect(screen.getByText(zh['languageFallback.cloud'])).toBeTruthy()
    fireEvent.change(language, { target: { value: 'en' } })
    await waitFor(() => { expect(b.props.configure).toHaveBeenCalledWith({ language: 'en' }) })
    expect(cardIds()).toEqual([CLOUD, LOCAL])
    expect(screen.getByText(zh.cloudReady)).toBeTruthy()
    act(() => { b.store.set({ connected: true, error: null, catalog: catalog({ cloud: { phase: 'ready' }, local: { phase: 'ready' }, mode: 'explicit', selected: LOCAL, language: 'zh' }) }) })
    expect(screen.queryByText(zh['languageFallback.cloud'])).toBeNull()
    expect(screen.queryByText(zh.cloudBilling)).toBeNull()
    expect(cardIds()).toEqual([LOCAL])
    act(() => { b.store.set({ connected: true, error: null, catalog: catalog({ cloud: { phase: 'ready' }, local: { phase: 'ready' }, mode: 'explicit', selected: LOCAL, language: 'es' }) }) })
    expect(screen.getByText('本地识别不支持西班牙语，将自动识别')).toBeTruthy()
    act(() => { b.store.set({ connected: true, error: null, catalog: catalog({ cloud: { phase: 'ready' }, local: { phase: 'ready' }, mode: 'explicit', selected: CLOUD, language: 'auto' }) }) })
    expect(screen.queryByText(zh['languageFallback.cloud'])).toBeNull()
    expect(screen.getByText(zh.cloudBilling)).toBeTruthy()
    expect(cardIds()).toEqual([CLOUD])
  })

  it('hides sign-in without an account entry', () => {
    preferences(catalog({ cloud: signedOut, mode: 'explicit' }), false)
    expect(screen.queryByRole('button', { name: zh.signIn })).toBeNull()
  })
})

describe('activation prompt', () => {
  function prompt(initial: SpeechCatalog) {
    const onDismiss = vi.fn(), onOpenDetails = vi.fn(), signIn = vi.fn()
    const props = { packageName: 'voice-bundle', t, onDismiss, onOpenDetails, signIn,
      useSpeechReadiness: bindSnapshotSelector(createSnapshotStore<SpeechReadiness>({ connected: true, error: null, catalog: initial })),
      useAccountSignIn: bindSnapshotSelector(createSnapshotStore(true)) } as VoiceSetupPromptProps
    render(<VoiceSetupPrompt {...props} />)
    return { onDismiss, onOpenDetails, signIn }
  }

  it('enables a signed-in cloud selection without a prompt', () => {
    const b = prompt(catalog({ cloud: { phase: 'ready' }, local: { phase: 'unprepared' } }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.onDismiss).toHaveBeenCalled()
  })

  it('makes signing in the primary choice when automatic selection falls back to an unprepared model', () => {
    const b = prompt(catalog({ cloud: signedOut, local: { phase: 'unprepared' }, selected: LOCAL }))
    const dialog = screen.getByRole('dialog', { name: zh['choicePrompt.title'] })
    const primary = within(dialog).getByRole('button', { name: zh.signIn })
    expect(primary.hasAttribute('data-modal-autofocus')).toBe(true)
    fireEvent.click(primary)
    expect(b.onDismiss).toHaveBeenCalled()
    expect(b.signIn).toHaveBeenCalledOnce()
  })
})
