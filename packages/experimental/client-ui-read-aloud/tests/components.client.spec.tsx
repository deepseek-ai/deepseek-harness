// @vitest-environment jsdom
/** The message control, the Session notice, and the bundle details with the voice preference as the user sees them. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { MessageId } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ReadAloudStatus } from '@deepseek-ai/dsh-read-aloud/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, expect, it, vi } from 'vitest'
import { ReadAloudAction, type ReadAloudActionProps } from '../src/client/ReadAloudAction.tsx'
import { ReadAloudNotice, type ReadAloudNoticeProps } from '../src/client/ReadAloudNotice.tsx'
import { ReadAloudSettings, type ReadAloudSettingsProps } from '../src/client/ReadAloudSettings.tsx'
import { zh } from '../src/client/locales.ts'
import type { ReaderState } from '../src/client/reader.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

const sessionId = 's1' as SessionId, messageId = 'm1' as MessageId
const mine = { sessionId, messageId }
const IDLE: ReaderState = { reading: null, notice: null, sample: null, sampleNotice: null }
const SYNTHESIS = { voices: ['stella', 'tide'], voice: 'stella', sampleRate: 24_000 }

function action(access = true) {
  const reader = createSnapshotStore<ReaderState>(IDLE, { flush: 'sync' })
  const status = createSnapshotStore<ReadAloudStatus>({ state: 'ready', synthesis: SYNTHESIS }, { flush: 'sync' })
  const toggle = vi.fn()
  const props = {
    sessionId, messageId, toggle, t: makeTranslate(zh), useAccess: () => access,
    useReader: bindSnapshotSelector(reader), useReadAloudStatus: bindSnapshotSelector(status),
  } as Partial<ReadAloudActionProps> as ReadAloudActionProps
  const view = render(<ReadAloudAction {...props} />)
  return {
    toggle, view,
    read: (state: ReaderState) => { act(() => { reader.set(state) }) },
    report: (state: ReadAloudStatus['state']) => { act(() => { status.set({ state, synthesis: SYNTHESIS }) }) },
  }
}

it('offers a speaker while idle and hands the message to the reader on click', () => {
  const b = action()
  const button = screen.getByRole('button', { name: '朗读' })
  expect(button.dataset['readAloud']).toBe('idle')
  expect(button.hasAttribute('data-action-ongoing')).toBe(false)
  expect(button.querySelector('svg')).not.toBeNull()
  fireEvent.click(button)
  expect(b.toggle).toHaveBeenCalledExactlyOnceWith(messageId)
})

it('shows four bars while loading and a five-bar waveform while playing, both marked as an action in progress', () => {
  const b = action()
  b.read({ ...IDLE, reading: { ...mine, phase: 'loading' } })
  const button = screen.getByRole('button', { name: '停止朗读' })
  expect([button.dataset['readAloud'], button.getAttribute('data-action-ongoing'), button.querySelectorAll('i').length])
    .toEqual(['loading', '', 4])
  expect(button.querySelector('svg')).toBeNull()
  b.read({ ...IDLE, reading: { ...mine, phase: 'playing' } })
  expect([button.dataset['readAloud'], button.querySelectorAll('i').length]).toEqual(['playing', 5])
  b.read({ ...IDLE, reading: { sessionId, messageId: 'm2' as MessageId, phase: 'playing' } })
  expect(screen.getByRole('button', { name: '朗读' }).dataset['readAloud']).toBe('idle')
  b.read({ ...IDLE, reading: { sessionId: 's2' as SessionId, messageId, phase: 'playing' } })
  expect(screen.getByRole('button', { name: '朗读' }).dataset['readAloud']).toBe('idle')
})

it('hides while a reading cannot start, yet stays while this message is being read', () => {
  const b = action()
  b.report('sign-in-required')
  expect(screen.queryByRole('button')).toBeNull()
  b.report('unavailable')
  expect(screen.queryByRole('button')).toBeNull()
  b.read({ ...IDLE, reading: { ...mine, phase: 'playing' } })
  expect(screen.getByRole('button', { name: '停止朗读' })).toBeTruthy()
  cleanup()
  action(false)
  expect(screen.queryByRole('button')).toBeNull()
})

function notice(initial: ReaderState = IDLE) {
  const reader = createSnapshotStore<ReaderState>(initial, { flush: 'sync' })
  const leave = vi.fn(), dismissNotice = vi.fn()
  const useReader = bindSnapshotSelector(reader)
  const partial: Partial<ReadAloudNoticeProps> = { sessionId, leave, dismissNotice, t: makeTranslate(zh), useReader }
  const props = partial as ReadAloudNoticeProps
  const view = render(<div data-composer-card=""><ReadAloudNotice {...props} /></div>)
  return { leave, dismissNotice, view, publish: (state: ReaderState) => { act(() => { reader.set(state) }) } }
}

it('shows the notice of its own Session as a toast and retires it after it faded', () => {
  vi.useFakeTimers()
  const b = notice()
  expect(screen.queryByRole('alert')).toBeNull()
  b.publish({ ...IDLE, notice: { sessionId: 's2' as SessionId, messageId, seq: 1, kind: 'failed' } })
  expect(screen.queryByRole('alert')).toBeNull()
  b.publish({ ...IDLE, notice: { ...mine, seq: 2, kind: 'no-text' } })
  expect(screen.getByRole('alert').textContent).toBe('这条回复没有可朗读的文字')
  act(() => { vi.advanceTimersByTime(6999) })
  expect(b.dismissNotice).not.toHaveBeenCalled()
  act(() => { vi.advanceTimersByTime(1) })
  expect(b.dismissNotice).toHaveBeenCalledExactlyOnceWith(2)
})

it('has a sentence for every notice kind and ends the Session reading when it leaves the screen', () => {
  const b = notice()
  const kinds = ['failed', 'rate-limited', 'service-unavailable', 'timeout', 'service-error', 'sign-in-required', 'api-key-invalid',
    'quota-exceeded', 'text-rejected'] as const
  for (const [index, kind] of kinds.entries()) {
    b.publish({ ...IDLE, notice: { ...mine, seq: index + 1, kind } })
    expect(screen.getByRole('alert').textContent).toBe(zh[`notice.${kind}`])
  }
  expect(b.leave).not.toHaveBeenCalled()
  b.view.unmount()
  expect(b.leave).toHaveBeenCalledOnce()
})

function settings(initial: ReadAloudStatus, account = true) {
  const status = createSnapshotStore<ReadAloudStatus>(initial, { flush: 'sync' })
  const reader = createSnapshotStore<ReaderState>(IDLE, { flush: 'sync' })
  const signIn = vi.fn(), toggleSample = vi.fn(), stopSample = vi.fn(), dismissSampleNotice = vi.fn()
  let settle = Promise.withResolvers<undefined>()
  const configure = vi.fn(() => { settle = Promise.withResolvers<undefined>(); return settle.promise.then(() => {}) })
  const props: ReadAloudSettingsProps = {
    signIn, configure, toggleSample, stopSample, dismissSampleNotice, t: makeTranslate(zh),
    useReadAloudStatus: bindSnapshotSelector(status), useReader: bindSnapshotSelector(reader),
    useAccountSignIn: bindSnapshotSelector(createSnapshotStore(account, { flush: 'sync' })),
  }
  const view = render(<ReadAloudSettings {...props} />)
  return {
    signIn, configure, toggleSample, stopSample, dismissSampleNotice, view,
    report: (next: ReadAloudStatus) => { act(() => { status.set(next) }) },
    read: (next: ReaderState) => { act(() => { reader.set(next) }) },
    saved: async () => { await act(async () => { settle.resolve(undefined); await settle.promise }) },
    refused: async () => { await act(async () => { settle.reject(new Error('Host unreachable')); await settle.promise.catch(() => {}) }) },
  }
}

it('states the billing and the supported languages and links the speech synthesis guide when reading is available', () => {
  settings({ state: 'ready', synthesis: SYNTHESIS })
  expect(screen.getByText(zh['settings.billing'])).toBeTruthy()
  expect(screen.getByText(zh['settings.languages'])).toBeTruthy()
  const link = screen.getByRole('link', { name: '语音合成指南' })
  expect([link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')])
    .toEqual(['https://api-docs.deepseek.com/zh-cn/guides/tts', '_blank', 'noopener noreferrer'])
  expect(screen.queryByRole('status')).toBeNull()
})

it('explains a hidden control and offers sign-in only while the account entry exists', () => {
  const signedOut = settings({ state: 'sign-in-required', synthesis: SYNTHESIS })
  expect(screen.getByRole('status').textContent).toContain(zh['settings.signInRequired'])
  fireEvent.click(screen.getByRole('button', { name: '登录 DeepSeek' }))
  expect(signedOut.signIn).toHaveBeenCalledOnce()
  // The voice can be chosen before a credential exists; hearing it cannot.
  expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '音色' }).disabled).toBe(false)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '试听' }).disabled).toBe(true)
  cleanup()
  settings({ state: 'sign-in-required', synthesis: SYNTHESIS }, false)
  expect(screen.queryByRole('button', { name: '登录 DeepSeek' })).toBeNull()
  cleanup()
  settings({ state: 'unavailable' })
  expect(screen.getByRole('status').textContent).toBe(zh['settings.unavailable'])
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.queryByRole('combobox')).toBeNull()
})

it('lists the voices by name, saves a choice, and says when a choice was not saved', async () => {
  const b = settings({ state: 'ready', synthesis: { ...SYNTHESIS, voices: ['stella', 'tide', 'nova'] } })
  const select = screen.getByRole<HTMLSelectElement>('combobox', { name: '音色' })
  expect([...select.options].map(option => [option.value, option.textContent])).toEqual([
    ['stella', '海星（女声）'], ['tide', '暗潮（男声）'], ['nova', 'nova'],
  ])
  expect(select.value).toBe('stella')
  fireEvent.change(select, { target: { value: 'tide' } })
  expect(b.configure).toHaveBeenCalledExactlyOnceWith('tide')
  expect(select.disabled).toBe(true)
  await b.saved()
  expect(select.disabled).toBe(false)
  expect(screen.queryByRole('alert')).toBeNull()
  // The Host reports the saved voice; the field shows what the Host holds.
  b.report({ state: 'ready', synthesis: { ...SYNTHESIS, voice: 'tide' } })
  expect(select.value).toBe('tide')
  fireEvent.change(select, { target: { value: 'stella' } })
  await b.refused()
  expect(screen.getByRole('alert').textContent).toBe('音色没有保存，请稍后再试')
  expect([select.disabled, select.value]).toEqual([false, 'tide'])
  fireEvent.change(select, { target: { value: 'stella' } })
  expect(screen.queryByRole('alert')).toBeNull()
  await b.saved()
})

it('auditions the saved voice with the three states of the control and stops when the details leave the screen', () => {
  const b = settings({ state: 'ready', synthesis: SYNTHESIS })
  const button = screen.getByRole('button', { name: '试听' })
  expect(button.dataset['readAloud']).toBe('idle')
  fireEvent.click(button)
  expect(b.toggleSample).toHaveBeenCalledExactlyOnceWith({ voice: 'stella', language: 'zh', sampleRate: 24_000 })
  b.read({ ...IDLE, sample: { voice: 'stella', phase: 'loading' } })
  expect([button.getAttribute('aria-label'), button.dataset['readAloud'], button.querySelectorAll('i').length]).toEqual(['停止试听', 'loading', 4])
  b.read({ ...IDLE, sample: { voice: 'stella', phase: 'playing' } })
  expect([button.dataset['readAloud'], button.querySelectorAll('i').length]).toEqual(['playing', 5])
  expect(b.stopSample).not.toHaveBeenCalled()
  b.view.unmount()
  expect(b.stopSample).toHaveBeenCalledOnce()
})

it('reports an audition failure as a toast that names what to check and retires it after it faded', () => {
  vi.useFakeTimers()
  const b = settings({ state: 'ready', synthesis: SYNTHESIS })
  expect(screen.queryByRole('alert')).toBeNull()
  for (const [index, kind] of (['sign-in-required', 'api-key-invalid', 'quota-exceeded'] as const).entries()) {
    b.read({ ...IDLE, sampleNotice: { seq: index + 1, kind } })
    expect(screen.getByRole('alert').textContent).toBe(zh['sample.credential'])
  }
  for (const [index, kind] of (['failed', 'rate-limited', 'service-unavailable', 'timeout', 'service-error', 'text-rejected'] as const).entries()) {
    b.read({ ...IDLE, sampleNotice: { seq: index + 4, kind } })
    expect(screen.getByRole('alert').textContent).toBe(zh['sample.unavailable'])
  }
  act(() => { vi.advanceTimersByTime(6999) })
  expect(b.dismissSampleNotice).not.toHaveBeenCalled()
  act(() => { vi.advanceTimersByTime(1) })
  expect(b.dismissSampleNotice).toHaveBeenCalledExactlyOnceWith(9)
})
