// @vitest-environment jsdom
/** What the Remote connection panel exposes during each login-code outcome. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RemoteConnectionSection, type RemoteConnectionSectionProps } from '../src/client/RemoteConnectionSection.tsx'
import type { RemoteConnectionState } from '../src/client/remote-connection-controller.ts'
import type { LoginLinkState } from '../src/client/login-link-controller.ts'
import type { RemoteLoginId } from '../src/types.ts'
import { en, zh } from '../src/client/locales.ts'
import type {} from '../src/client/index.ts'
import { PairingApproval } from '../src/client/pairing-approval.ts'

afterEach(cleanup)

const ready: RemoteConnectionState = {
  deployment: { url: 'https://host.example/app/', availability: 'available', loginUrlAllowed: true, ticket: 'none', pollIntervalMs: 1000 },
  phase: 'ready', ticket: null, error: null, remainingSeconds: 120, retainDetails: false,
}
const ticket = { id: 'code-a' as RemoteLoginId, url: 'https://host.example/app/?login=qr#token=private', lifetimeMs: 120_000 }

function panel(overrides: Partial<RemoteConnectionState> = {}, language: 'en' | 'zh' = 'en', linkOverrides: Partial<LoginLinkState> = {}, pairingAvailable = false) {
  const state = createSnapshotStore({ ...ready, ...overrides })
  const linkState = createSnapshotStore<LoginLinkState>({ url: 'https://host.example/app/?token=private-login-token', phase: 'ready', copied: false, notice: null, sequence: 0, ...linkOverrides })
  const actions = { create: vi.fn(), cancel: vi.fn(), reload: vi.fn(), copyLink: vi.fn(), reloadLink: vi.fn(), dismissCopyNotice: vi.fn() }
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const locale = new LocaleRuntime(ctx)
  locale.register('remoteConnection', { en, zh })
  locale.setLocale(language)
  const t = locale.bind('remoteConnection')
  const approval = new PairingApproval({ decidePairing: vi.fn() }, async () => {})
  if (pairingAvailable) approval.activate()
  onTestFinished(() => { approval.dispose() })
  const useResource = vi.fn(() => ({ status: 'live', value: { requests: [], pollIntervalMs: 1000 }, failure: undefined }))
  const props = {
    ...actions, t, useRemoteConnection: bindSnapshotSelector(state), useLoginLink: bindSnapshotSelector(linkState),
    useApproval: bindSnapshotSelector(approval.state), useResource, decide: vi.fn(), dismiss: vi.fn(),
  } as RemoteConnectionSectionProps
  render(<RemoteConnectionSection {...props} />)
  return { ...actions, state, linkState, useResource }
}

describe('Remote connection section', () => {
  const additionsCases: readonly { label: string; state: Partial<RemoteConnectionState> }[] = [
    { label: 'ready', state: {} },
    { label: 'loading', state: { phase: 'loading', deployment: null } },
    { label: 'unreachable', state: { deployment: { ...ready.deployment!, availability: 'unreachable-host' } } },
    { label: 'failed', state: { phase: 'error', deployment: null, error: 'loadFailed' } },
  ]

  it.each(additionsCases)('keeps pairing approvals visible when QR state is $label', ({ state }) => {
    const { useResource } = panel(state, 'en', {}, true)
    expect(screen.getByRole('region', { name: 'Pairing requests' })).toBeTruthy()
    expect(useResource).toHaveBeenCalledExactlyOnceWith('dsh-resource://device-pairing/requests?retry=0')
  })

  it.each(['en', 'zh'] as const)('introduces the access address before QR login and pairing approvals in %s', (language) => {
    const copy = language === 'en' ? en : zh
    panel({}, language, {}, true)
    const section = screen.getByRole('region', { name: copy.title })
    expect(within(section).getAllByRole('heading', { level: 3 }).map(heading => heading.textContent))
      .toEqual([copy.addressTitle, copy.qrTitle, copy['pairing.title']])
    expect(within(section).getAllByRole('region')).toHaveLength(3)
    const description = within(section).getByText(copy.addressDescription)
    for (const card of within(section).getAllByRole('region')) {
      expect(within(card).queryByText(copy.addressDescription)).toBeNull()
      expect(description.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })

  it('separates QR and link login and shows no credential warnings before either action', () => {
    const { create, copyLink } = panel()
    expect(screen.getByRole('region', { name: en.title })).toBeTruthy()
    expect(screen.queryByText(en.warningTitle)).toBeNull()
    expect(screen.queryByText(en.linkWarningTitle)).toBeNull()
    expect(screen.queryByText(en.httpWarning)).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
    const qr = screen.getByRole('region', { name: en.qrTitle })
    const link = screen.getByRole('region', { name: en.addressTitle })
    expect(within(qr).queryByRole('button', { name: en.copyLink })).toBeNull()
    expect(within(link).queryByRole('button', { name: en.generate })).toBeNull()
    expect(within(qr).queryByText('https://host.example/app/')).toBeNull()
    expect(within(qr).queryByRole('code')).toBeNull()
    expect(within(link).getByText('https://host.example/app/?token=private-login-token')).toBeTruthy()
    fireEvent.click(within(qr).getByRole('button', { name: en.generate }))
    fireEvent.click(within(link).getByRole('button', { name: en.copyLink }))
    expect(create).toHaveBeenCalledOnce()
    expect(copyLink).toHaveBeenCalledOnce()
  })

  it('renders a scannable SVG and countdown without printing or linking the secret URL', () => {
    const { create, cancel } = panel({ phase: 'pending', ticket })
    const qr = screen.getByRole('img', { name: en.qr })
    expect(qr.tagName.toLowerCase()).toBe('svg')
    expect(qr.querySelector('path')).not.toBeNull()
    expect(screen.getByRole('timer').textContent).toBe('Expires in 120s')
    expect(screen.getByText(en.warning)).toBeTruthy()
    expect(screen.queryByText(en.linkWarning)).toBeNull()
    expect(document.body.textContent).not.toContain(ticket.url)
    expect(document.querySelector('a[href*="token="]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.regenerate }))
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(create).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each([
    ['en', 'unreachable-host'], ['en', 'untrusted-host'],
    ['zh', 'unreachable-host'], ['zh', 'untrusted-host'],
  ] as const)('shows %s guidance for %s before the address and keeps pairing available', (language, availability) => {
    const copy = language === 'en' ? en : zh
    const url = availability === 'unreachable-host' ? 'http://127.0.0.1:5432/' : 'https://untrusted.example/app/'
    const deployment = { ...ready.deployment!, url, availability, loginUrlAllowed: false }
    const { copyLink } = panel({ deployment }, language, { copied: true }, true)
    const section = screen.getByRole('region', { name: copy.title })
    const message = copy[availability].split('\n')[0]!
    const notice = within(section).getByText(message)
    expect(notice.closest('[role="status"]')).not.toBeNull()
    for (const card of within(section).getAllByRole('region')) {
      expect(within(card).queryByText(message)).toBeNull()
      expect(notice.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    const address = within(section).getByRole('region', { name: copy.addressTitle })
    expect(within(address).getByText(url)).toBeTruthy()
    const copyAddress = within(address).getByRole('button', { name: copy.copyLink })
    expect(copyAddress).toHaveProperty('disabled', false)
    fireEvent.click(copyAddress)
    expect(copyLink).toHaveBeenCalledOnce()
    expect(within(section).queryByRole('region', { name: copy.qrTitle })).toBeNull()
    expect(within(section).getByRole('region', { name: copy['pairing.title'] })).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByText(copy.addressDescription)).toBeNull()
    expect(screen.queryByText(copy.warning)).toBeNull()
    expect(screen.queryByText(copy.linkWarning)).toBeNull()
    expect(document.body.textContent).not.toContain('private-login-token')
  })

  it.each(['en', 'zh'] as const)('allows HTTP code creation with a plaintext reminder in %s', (language) => {
    const copy = language === 'en' ? en : zh
    const { create } = panel({ deployment: { ...ready.deployment!, url: 'http://host.example/app/' } }, language)
    expect(screen.queryByText(copy.httpWarning)).toBeNull()
    expect(screen.queryByText(copy.warning)).toBeNull()
    const generate = screen.getByRole('button', { name: copy.generate })
    expect(generate).toHaveProperty('disabled', false)
    fireEvent.click(generate)
    expect(create).toHaveBeenCalledOnce()
    cleanup()
    panel({ deployment: { ...ready.deployment!, url: 'http://host.example/app/' }, phase: 'pending', ticket }, language)
    expect(screen.getByText(copy.httpWarning)).toBeTruthy()
    expect(screen.getByText(copy.warning)).toBeTruthy()
  })

  it.each(['loading', 'creating', 'cancelling'] as const)('hides the QR and prevents duplicate gestures while %s', (phase) => {
    panel({ phase, ticket })
    expect(screen.getByRole('status', { name: en[phase] })).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByRole('button', { name: en.regenerate })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.cancel })).toHaveProperty('disabled', true)
  })

  it.each(['loading', 'creating'] as const)('keeps the generation label while %s without a previous QR', (phase) => {
    panel({ phase })
    const qr = screen.getByRole('region', { name: en.qrTitle })
    expect(within(qr).getByRole('button', { name: en.generate })).toHaveProperty('disabled', true)
  })

  it('keeps the link card and its focus while the QR is generated or refreshed', () => {
    const { state, copyLink } = panel({ phase: 'pending', ticket }, 'en', { copied: true })
    const qr = screen.getByRole('region', { name: en.qrTitle })
    const link = screen.getByRole('region', { name: en.addressTitle })
    const copy = within(link).getByRole('button', { name: en.copyLink })
    copy.focus()
    for (const phase of ['creating', 'loading'] as const) {
      act(() => { state.update((value) => { value.phase = phase; value.ticket = null }) })
      expect(screen.getByRole('region', { name: en.qrTitle })).toBe(qr)
      expect(within(qr).getByRole('status', { name: en[phase] })).toBeTruthy()
      expect(within(qr).queryByRole('img')).toBeNull()
      expect(within(qr).queryByRole('timer')).toBeNull()
      expect(screen.getByRole('region', { name: en.addressTitle })).toBe(link)
      expect(within(link).getByRole('button', { name: en.copyLink })).toBe(copy)
      expect(copy).toHaveProperty('disabled', false)
      expect(document.activeElement).toBe(copy)
      expect(within(link).getByText(en.linkWarning)).toBeTruthy()
    }
    fireEvent.click(copy)
    expect(copyLink).toHaveBeenCalledOnce()
    act(() => { state.update((value) => { value.phase = 'pending'; value.ticket = ticket; value.remainingSeconds = 90 }) })
    expect(within(qr).getByRole('img', { name: en.qr })).toBeTruthy()
    expect(within(qr).getByRole('timer').textContent).toBe('Expires in 90s')
  })

  it('retains the countdown and warning while only the QR is replaced', () => {
    const { state } = panel({ phase: 'pending', ticket })
    const qr = screen.getByRole('region', { name: en.qrTitle })
    const timer = within(qr).getByRole('timer')
    const warning = within(qr).getByText(en.warning)
    act(() => { state.update((value) => { value.phase = 'creating'; value.ticket = null; value.retainDetails = true }) })
    expect(within(qr).queryByRole('img')).toBeNull()
    expect(within(qr).getByRole('status', { name: en.creating })).toBeTruthy()
    expect(within(qr).getByRole('button', { name: en.regenerate })).toHaveProperty('disabled', true)
    expect(within(qr).getByRole('timer')).toBe(timer)
    expect(within(qr).getByText(en.warning)).toBe(warning)
    expect(timer.textContent).toBe('Expires in 120s')
    expect(document.body.textContent).not.toContain(ticket.url)
    act(() => { state.update((value) => { value.phase = 'pending'; value.ticket = ticket; value.remainingSeconds = 90; value.retainDetails = false }) })
    expect(within(qr).getByRole('img', { name: en.qr })).toBeTruthy()
    expect(within(qr).getByRole('timer')).toBe(timer)
    expect(timer.textContent).toBe('Expires in 90s')
    expect(within(qr).getByText(en.warning)).toBe(warning)
  })

  it.each(['used', 'expired', 'replaced'] as const)('shows %s as a settled outcome with no QR', (phase) => {
    panel({ phase })
    expect(screen.getByRole('status').textContent).toBe(en[phase])
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByRole('button', { name: en.regenerate })).toBeTruthy()
  })

  it.each(['en', 'zh'] as const)('offers QR generation after cancellation without a success message in %s', (language) => {
    const copy = language === 'en' ? en : zh
    const { create } = panel({ phase: 'cancelled' }, language)
    const qr = screen.getByRole('region', { name: copy.qrTitle })
    expect(within(qr).queryByRole('img')).toBeNull()
    expect(within(qr).queryByRole('timer')).toBeNull()
    expect(within(qr).queryByRole('status')).toBeNull()
    expect(within(qr).queryByText(copy.warning)).toBeNull()
    expect(within(qr).queryByRole('button', { name: copy.cancel })).toBeNull()
    expect(within(qr).queryByRole('button', { name: copy.regenerate })).toBeNull()
    const generate = within(qr).getByRole('button', { name: copy.generate })
    expect(generate).toHaveProperty('disabled', false)
    fireEvent.click(generate)
    expect(create).toHaveBeenCalledOnce()
  })

  it('keeps an uncertain code hidden and offers status recovery and cancellation', () => {
    const { reload, cancel } = panel({ phase: 'error', error: 'statusFailed', ticket })
    expect(screen.getByRole('alert').textContent).toBe(en.statusFailed)
    expect(screen.queryByRole('img')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(reload).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each([
    { language: 'en', cached: false }, { language: 'zh', cached: false },
    { language: 'en', cached: true }, { language: 'zh', cached: true },
  ] as const)('keeps a failed address read recoverable in $language (cached address: $cached)', ({ language, cached }) => {
    const copy = language === 'en' ? en : zh
    const deployment = cached ? { ...ready.deployment!, availability: 'untrusted-host' as const, loginUrlAllowed: false } : null
    const { reload } = panel({ phase: 'error', deployment, error: 'loadFailed' }, language)
    const address = screen.getByRole('region', { name: copy.addressTitle })
    expect(within(address).getByRole('alert').textContent).toBe(copy.loadFailed)
    if (deployment !== null) expect(within(address).getByText(deployment.url)).toBeTruthy()
    expect(screen.queryByRole('region', { name: copy.qrTitle })).toBeNull()
    expect(screen.queryByText(copy.addressDescription)).toBeNull()
    fireEvent.click(within(address).getByRole('button', { name: copy.retry }))
    expect(reload).toHaveBeenCalledOnce()
    cleanup()
    panel({ phase: 'loading', deployment: null }, language)
    expect(screen.getByRole('status', { name: copy.loading })).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it.each([
    ['en', 'Expires in 0s', 'Scan to sign in directly.'],
    ['zh', '0 秒后过期', '扫码后直接登录'],
  ] as const)('shows the localized countdown without a separate scan instruction in %s', (language, countdown, scanInstruction) => {
    const copy = language === 'en' ? en : zh
    panel({ phase: 'pending', ticket, remainingSeconds: 0 }, language)
    expect(screen.getByRole('region', { name: copy.title })).toBeTruthy()
    expect(screen.getByRole('img', { name: copy.qr })).toBeTruthy()
    expect(screen.getByRole('timer').textContent).toBe(countdown)
    expect(screen.getByText(copy.warningTitle)).toBeTruthy()
    expect(screen.queryByText(scanInstruction)).toBeNull()
  })

  it.each(['en', 'zh'] as const)('keeps the copy label while showing credential warnings only after success in %s', (language) => {
    const copy = language === 'en' ? en : zh
    const { linkState } = panel({}, language)
    const button = within(screen.getByRole('region', { name: copy.addressTitle })).getByRole('button', { name: copy.copyLink })
    expect(screen.queryByText(copy.linkWarning)).toBeNull()
    act(() => { linkState.update((state) => { state.phase = 'copying' }) })
    expect(screen.getByRole('button', { name: copy.copyLink })).toBe(button)
    expect(button).toHaveProperty('disabled', true)
    expect(screen.queryByText(copy.linkWarning)).toBeNull()
    act(() => { linkState.update((state) => { state.phase = 'ready'; state.copied = true }) })
    expect(screen.getByRole('button', { name: copy.copyLink })).toBe(button)
    expect(button).toHaveProperty('disabled', false)
    expect(screen.getByText(copy.linkWarning)).toBeTruthy()
    expect(screen.queryByText(copy.warning)).toBeNull()
    expect(screen.getByText('https://host.example/app/?token=private-login-token')).toBeTruthy()
  })

  it.each([
    ['en', 'loading'], ['zh', 'loading'],
    ['en', 'error'], ['zh', 'error'],
  ] as const)('copies the plain address in %s while the credential read is %s without a warning or retry', (language, phase) => {
    const copy = language === 'en' ? en : zh
    const { reloadLink, copyLink, linkState } = panel({}, language, { phase, url: null, copied: phase === 'loading' })
    const link = screen.getByRole('region', { name: copy.addressTitle })
    expect(within(link).getByText(ready.deployment!.url)).toBeTruthy()
    expect(within(link).getAllByRole('button')).toHaveLength(1)
    expect(within(link).queryByRole('alert')).toBeNull()
    expect(within(link).queryByRole('button', { name: copy.retry })).toBeNull()
    const action = within(link).getByRole('button', { name: copy.copyLink })
    expect(action).toHaveProperty('disabled', false)
    fireEvent.click(action)
    expect(copyLink).toHaveBeenCalledOnce()
    expect(reloadLink).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: copy.generate })).toHaveProperty('disabled', false)
    expect(screen.queryByText(copy.linkWarning)).toBeNull()
    act(() => { linkState.update((state) => { state.phase = 'copying'; state.copied = false }) })
    expect(within(link).getByRole('button', { name: copy.copyLink })).toBe(action)
    expect(action).toHaveProperty('disabled', true)
    act(() => { linkState.update((state) => { state.phase = 'ready'; state.url = 'https://host.example/app/?token=retry-token' }) })
    expect(within(link).getByRole('button', { name: copy.copyLink })).toBe(action)
    expect(within(link).getAllByRole('button')).toHaveLength(1)
    expect(within(link).queryByRole('alert')).toBeNull()
    expect(action).toHaveProperty('disabled', false)
    fireEvent.click(action)
    expect(copyLink).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(copy.linkWarning)).toBeNull()
  })
})
