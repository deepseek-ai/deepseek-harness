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

afterEach(cleanup)

const ready: RemoteConnectionState = {
  deployment: { url: 'https://host.example/app/', availability: 'available', ticket: 'none', pollIntervalMs: 1000 },
  phase: 'ready', ticket: null, error: null, remainingSeconds: 120, retainDetails: false,
}
const ticket = { id: 'code-a' as RemoteLoginId, url: 'https://host.example/app/?login=qr#token=private', lifetimeMs: 120_000 }

function panel(overrides: Partial<RemoteConnectionState> = {}, language: 'en' | 'zh' = 'en', linkOverrides: Partial<LoginLinkState> = {}) {
  const state = createSnapshotStore({ ...ready, ...overrides })
  const linkState = createSnapshotStore<LoginLinkState>({ url: 'https://host.example/app/?token=private-login-token', phase: 'ready', copied: false, notice: null, sequence: 0, ...linkOverrides })
  const actions = { create: vi.fn(), cancel: vi.fn(), reload: vi.fn(), copyLink: vi.fn(), reloadLink: vi.fn(), dismissCopyNotice: vi.fn() }
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const locale = new LocaleRuntime(ctx)
  locale.register('remoteConnection', { en, zh })
  locale.setLocale(language)
  const t = locale.bind('remoteConnection')
  const props = {
    ...actions, t, useRemoteConnection: bindSnapshotSelector(state), useLoginLink: bindSnapshotSelector(linkState),
  } as RemoteConnectionSectionProps
  render(<RemoteConnectionSection {...props} />)
  return { ...actions, state, linkState }
}

describe('Remote connection section', () => {
  it.each(['en', 'zh'] as const)('introduces the access address before QR login in %s', (language) => {
    const copy = language === 'en' ? en : zh
    panel({}, language)
    const section = screen.getByRole('region', { name: copy.title })
    expect(within(section).getAllByRole('heading', { level: 3 }).map(heading => heading.textContent))
      .toEqual([copy.addressTitle, copy.qrTitle])
    expect(within(section).getAllByRole('region')).toHaveLength(2)
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
    expect(screen.getByText(en.scan)).toBeTruthy()
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
  ] as const)('shows %s guidance for %s before the address', (language, availability) => {
    const copy = language === 'en' ? en : zh
    const url = availability === 'unreachable-host' ? 'http://127.0.0.1:5432/' : 'https://untrusted.example/app/'
    panel({ deployment: { ...ready.deployment!, url, availability } }, language, { copied: true })
    const section = screen.getByRole('region', { name: copy.title })
    const notice = within(section).getByText(copy[availability])
    expect(notice.closest('[role="status"]')).not.toBeNull()
    for (const card of within(section).getAllByRole('region')) {
      expect(within(card).queryByText(copy[availability])).toBeNull()
      expect(notice.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    const address = within(section).getByRole('region', { name: copy.addressTitle })
    expect(within(address).getByText(url)).toBeTruthy()
    expect(within(address).queryByRole('button')).toBeNull()
    expect(within(section).queryByRole('region', { name: copy.qrTitle })).toBeNull()
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

  it('keeps the link card and its focus while the QR is generated or refreshed', () => {
    const { state, copyLink } = panel({ phase: 'pending', ticket }, 'en', { copied: true })
    const qr = screen.getByRole('region', { name: en.qrTitle })
    const link = screen.getByRole('region', { name: en.addressTitle })
    const copy = within(link).getByRole('button', { name: en.copied })
    copy.focus()
    for (const phase of ['creating', 'loading'] as const) {
      act(() => { state.update((value) => { value.phase = phase; value.ticket = null }) })
      expect(screen.getByRole('region', { name: en.qrTitle })).toBe(qr)
      expect(within(qr).getByRole('status', { name: en[phase] })).toBeTruthy()
      expect(within(qr).queryByRole('img')).toBeNull()
      expect(within(qr).queryByRole('timer')).toBeNull()
      expect(screen.getByRole('region', { name: en.addressTitle })).toBe(link)
      expect(within(link).getByRole('button', { name: en.copied })).toBe(copy)
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

  it('retains the scan line, countdown, and warning while only the QR is replaced', () => {
    const { state } = panel({ phase: 'pending', ticket })
    const qr = screen.getByRole('region', { name: en.qrTitle })
    const scan = within(qr).getByText(en.scan)
    const timer = within(qr).getByRole('timer')
    const warning = within(qr).getByText(en.warning)
    act(() => { state.update((value) => { value.phase = 'creating'; value.ticket = null; value.retainDetails = true }) })
    expect(within(qr).queryByRole('img')).toBeNull()
    expect(within(qr).getByRole('status', { name: en.creating })).toBeTruthy()
    expect(within(qr).getByText(en.scan)).toBe(scan)
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

  it('closes the QR preview after cancellation without a success message', () => {
    panel({ phase: 'cancelled' })
    const qr = screen.getByRole('region', { name: en.qrTitle })
    expect(within(qr).queryByRole('img')).toBeNull()
    expect(within(qr).queryByRole('timer')).toBeNull()
    expect(within(qr).queryByRole('status')).toBeNull()
    expect(within(qr).queryByText(en.warning)).toBeNull()
    expect(within(qr).queryByRole('button', { name: en.cancel })).toBeNull()
    expect(within(qr).getByRole('button', { name: en.regenerate })).toHaveProperty('disabled', false)
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
    const deployment = cached ? { ...ready.deployment!, availability: 'untrusted-host' as const } : null
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

  it('localizes the panel and its countdown', () => {
    panel({ phase: 'pending', ticket, remainingSeconds: 0 }, 'zh')
    expect(screen.getByRole('region', { name: zh.title })).toBeTruthy()
    expect(screen.getByRole('img', { name: zh.qr })).toBeTruthy()
    expect(screen.getByRole('timer').textContent).toBe('0 秒后过期')
    expect(screen.getByText(zh.warningTitle)).toBeTruthy()
  })

  it('shows link feedback and its warning only after copying succeeds, independently of QR login', () => {
    const { linkState } = panel()
    expect(screen.queryByText(en.linkWarning)).toBeNull()
    act(() => { linkState.update((state) => { state.phase = 'copying' }) })
    expect(screen.getByRole('button', { name: en.copying })).toHaveProperty('disabled', true)
    expect(screen.queryByText(en.linkWarning)).toBeNull()
    act(() => { linkState.update((state) => { state.phase = 'ready'; state.copied = true }) })
    expect(screen.getByRole('button', { name: en.copied })).toHaveProperty('disabled', false)
    expect(screen.getByText(en.linkWarning)).toBeTruthy()
    expect(screen.queryByText(en.warning)).toBeNull()
    expect(screen.getByText('https://host.example/app/?token=private-login-token')).toBeTruthy()
  })

  it('reuses the copy button to retry a failed link read while QR creation remains available', () => {
    const { reloadLink, copyLink, linkState } = panel({}, 'en', { phase: 'error', url: null })
    const link = screen.getByRole('region', { name: en.addressTitle })
    expect(within(link).getByRole('alert').textContent).toBe(en.linkFailed)
    expect(within(link).getAllByRole('button')).toHaveLength(1)
    const action = within(link).getByRole('button', { name: en.retry })
    expect(action).toHaveProperty('disabled', false)
    fireEvent.click(action)
    expect(reloadLink).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: en.generate })).toHaveProperty('disabled', false)
    expect(screen.queryByText(en.linkWarning)).toBeNull()
    act(() => { linkState.update((state) => { state.phase = 'loading' }) })
    expect(within(link).getByRole('button', { name: en.copyLink })).toBe(action)
    expect(action).toHaveProperty('disabled', true)
    act(() => { linkState.update((state) => { state.phase = 'ready'; state.url = 'https://host.example/app/?token=retry-token' }) })
    expect(within(link).getByRole('button', { name: en.copyLink })).toBe(action)
    expect(within(link).getAllByRole('button')).toHaveLength(1)
    expect(within(link).queryByRole('alert')).toBeNull()
    expect(action).toHaveProperty('disabled', false)
    fireEvent.click(action)
    expect(copyLink).toHaveBeenCalledOnce()
  })
})
