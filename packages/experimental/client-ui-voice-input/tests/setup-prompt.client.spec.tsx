// @vitest-environment jsdom
/** Activation guidance waits for cache inspection and leaves installation to the detail page. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SpeechPreparationState, SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { afterEach, expect, it, vi } from 'vitest'
import { VoiceSetupPrompt, type VoiceSetupPromptProps } from '../src/client/VoiceSetupPrompt.tsx'
import type { SpeechReadiness } from '../src/client/readiness.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

function fixture() {
  const state = createSnapshotStore<SpeechReadiness>({ catalog: null, connected: false, error: null })
  const onDismiss = vi.fn(), onOpenDetails = vi.fn(), providerId = 'local' as SpeechProviderId
  const props = { packageName: 'voice-bundle', t: makeTranslate(zh), onDismiss, onOpenDetails,
    useSpeechReadiness: bindSnapshotSelector(state) } as VoiceSetupPromptProps
  render(<VoiceSetupPrompt {...props} />)
  return { onDismiss, onOpenDetails, publish(preparation: SpeechPreparationState, location: 'host-local' | 'cloud' = 'host-local') {
    act(() => { state.set({ connected: true, error: null, catalog: {
      selection: { providerId, language: 'auto' }, maxAudioBytes: 1000, maxDurationSeconds: 120,
      providers: [{ id: providerId, name: 'SenseVoice', location, languages: ['auto'], preparation }],
    } }) })
  } }
}

it('waits for inspection, then offers the installation page without starting preparation', () => {
  const b = fixture()
  expect(screen.queryByText(zh['setupPrompt.title'])).toBeNull()
  b.publish({ phase: 'checking', step: 'check', startedAt: 0 })
  expect(screen.queryByText(zh['setupPrompt.title'])).toBeNull()
  expect(b.onDismiss).not.toHaveBeenCalled()
  b.publish({ phase: 'unprepared' })
  expect(screen.getByText(zh['setupPrompt.body'])).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh['setupPrompt.open'] }))
  expect(b.onOpenDetails).toHaveBeenCalledOnce()
  expect(b.onDismiss).not.toHaveBeenCalled()
})

it('allows postponing installation while leaving the plugin enabled', () => {
  const b = fixture()
  b.publish({ phase: 'unprepared' })
  fireEvent.click(screen.getByRole('button', { name: zh['setupPrompt.later'] }))
  expect(b.onDismiss).toHaveBeenCalledOnce()
  expect(b.onOpenDetails).not.toHaveBeenCalled()
})

it.each(['standby', 'ready', 'failed'] as const)('does not offer installation for %s resources', (phase) => {
  const b = fixture()
  b.publish(phase === 'failed' ? { phase, message: 'cache unreadable' } : { phase })
  expect(screen.queryByText(zh['setupPrompt.title'])).toBeNull()
  expect(b.onDismiss).toHaveBeenCalledOnce()
})

it('does not describe cloud-provider setup as a local model installation', () => {
  const b = fixture()
  b.publish({ phase: 'unprepared' }, 'cloud')
  expect(screen.queryByText(zh['setupPrompt.title'])).toBeNull()
  expect(b.onDismiss).toHaveBeenCalledOnce()
})
