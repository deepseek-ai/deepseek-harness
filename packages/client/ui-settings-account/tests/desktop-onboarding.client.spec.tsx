// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopOnboarding } from '../src/client/DesktopOnboarding.tsx'
import type { DesktopOnboardingProps, DesktopOnboardingState } from '../src/client/onboarding-contract.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function mount(step: DesktopOnboardingState['progress']['step'] = 'welcome', balance: 'zero' | 'positive' | 'bonus' | 'failed' | 'loading' = 'positive', status: DesktopOnboardingState['status'] = 'ready', copy: typeof zh = zh, creditFunded = false) {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const complete = vi.fn(async () => true)
  const retry = vi.fn(async () => true)
  // The shared host owns the native view; this flow only requests a page from it.
  const release = vi.fn()
  let returnFromPage: (() => void) | undefined
  const openPlatformPage = vi.fn((_page: 'usage' | 'top-up', onClose: () => void) => {
    returnFromPage = onClose
    return release
  })
  const update = vi.fn(async (_change: Parameters<DesktopOnboardingProps['update']>[0]) => true)
  function App() {
    const [state, setState] = useState<DesktopOnboardingState>({
      status, visible: true, error: status === 'error' ? 'settings' : null, creditFunded,
      progress: { version: 1, step, purpose: null, process: null, completion: null, usage: 'compact', developerTools: false },
    })
    return <DesktopOnboarding locale={copy === zh ? 'zh' : 'en'} state={state} t={key => copy[key]} complete={complete} retry={retry}
      update={async (change) => {
        setState(current => ({ ...current, status: 'saving' }))
        const saved = await update(change)
        setState(current => ({ ...current, status: 'ready', progress: saved ? { ...current.progress, ...change } : current.progress }))
        return saved
      }}
      account={{ view: { status: 'credential-stored', attempt: null, links: { usageUrl: 'https://example.com/usage', topUpUrl: 'https://example.com/top_up' } },
        failed: false, details: balance === 'loading' ? {} : { balance: balance === 'failed' ? { status: 'failed' } : { status: 'ready', bonusWallets: balance === 'bonus' ? [{ currency: 'CNY', balance: '1' }] : [], value: [{ currency: 'CNY', balance: balance === 'zero' || balance === 'bonus' ? '0E-16' : '12.34' }] } } }}
      openPlatformPage={openPlatformPage} />
  }
  render(<App />)
  return {
    complete, openPlatformPage, release, update, retry,
    /** The viewer returning through the shared host's Back action. */
    back: () => { returnFromPage?.() },
  }
}

it('keeps welcome mandatory and enters credit only through Start', async () => {
  const operations = mount()
  expect(screen.queryByRole('button', { name: zh.onboardingSkip })).toBeNull()
  expect(screen.queryByRole('button', { name: zh.onboardingBack })).toBeNull()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(operations.complete).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingStart })) })
  expect(screen.getByRole('heading', { name: zh.onboardingCredit })).toBeTruthy()
  expect(operations.update).toHaveBeenCalledWith({ step: 'credit' })
})

it('covers the application without showing an unfinished step while durable settings load', () => {
  mount('welcome', 'positive', 'loading')
  expect(screen.getByRole('status').textContent).toBe(zh.onboardingLoading)
  expect(screen.queryByRole('button', { name: zh.onboardingStart })).toBeNull()
  expect(document.querySelector('[data-desktop-onboarding]')).toBeNull()
})

it.each(['zero', 'positive', 'bonus', 'failed', 'loading'] as const)('always offers recharge with %s balance and only confirms known unavailable credit', async (balance) => {
  const operations = mount('credit', balance)
  expect(screen.getByRole('button', { name: zh.onboardingTopUp })).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingLater })) })
  if (balance === 'zero') {
    expect(screen.getByRole('dialog', { name: zh.onboardingNoCreditTitle })).toBeTruthy()
    expect(operations.update).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingUnderstood })) })
  }
  expect(operations.update).toHaveBeenCalledWith({ step: 'purpose' })
})

it('stays on credit after the viewer returns from the shared recharge page', async () => {
  const operations = mount('credit')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingTopUp })) })
  expect(operations.openPlatformPage).toHaveBeenCalledWith('top-up', expect.any(Function))
  // The shared host owns Back and the post-top-up read; this flow keeps the
  // credit page available through the return.
  await act(async () => { operations.back() })
  expect(document.querySelector('[data-desktop-onboarding="credit"]')).toBeTruthy()
})

it('allows both purposes and retains choices across back navigation', async () => {
  const operations = mount('purpose')
  expect(screen.queryByRole('button', { name: zh.onboardingContinue })).toBeNull()
  await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: zh.onboardingOffice })) })
  await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: zh.onboardingDevelopment })) })
  expect(operations.update).toHaveBeenLastCalledWith({ purpose: 'both' })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingContinue })) })
  expect(screen.getAllByRole('radio')).toHaveLength(3)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingBack })) })
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: zh.onboardingOffice }).checked).toBe(true)
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: zh.onboardingDevelopment }).checked).toBe(true)
})

it('finishes the office path without asking for process detail', async () => {
  const operations = mount('purpose')
  await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: zh.onboardingOffice })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingContinue })) })
  expect(operations.complete).toHaveBeenCalledWith('completed')
  expect(screen.queryByRole('radiogroup')).toBeNull()
})

it('supports radio arrow keys and requires a process choice before finishing', async () => {
  const operations = mount('process')
  expect(screen.queryByRole('button', { name: zh.onboardingEnter })).toBeNull()
  await act(async () => { fireEvent.keyDown(screen.getAllByRole('radio')[0]!, { key: 'ArrowRight' }) })
  expect(operations.update).toHaveBeenCalledWith({ process: 'standard' })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingEnter })) })
  expect(operations.complete).toHaveBeenCalledWith('completed')
})

it.each(['purpose', 'process'] as const)('keeps the %s action mounted without native disabled dimming while a choice saves', async (step) => {
  const operations = mount(step)
  const choices = screen.getAllByRole(step === 'purpose' ? 'checkbox' : 'radio')
  await act(async () => { fireEvent.click(choices[0]!) })
  const button = screen.getByRole('button', { name: step === 'purpose' ? zh.onboardingContinue : zh.onboardingEnter })
  let finish!: (saved: boolean) => void
  operations.update.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve }))
  fireEvent.click(choices[1]!)
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(button.hasAttribute('disabled')).toBe(false)
  const writes = operations.update.mock.calls.length
  fireEvent.click(button)
  expect(operations.update).toHaveBeenCalledTimes(writes)
  expect(operations.complete).not.toHaveBeenCalled()
  await act(async () => { finish(true) })
  expect(screen.getByRole('button', { name: button.textContent })).toBe(button)
  expect(button.getAttribute('aria-disabled')).toBe('false')
})

it('requires explicit skip confirmation and Escape only closes that dialog', async () => {
  const operations = mount('purpose')
  fireEvent.click(screen.getByRole('button', { name: zh.onboardingSkip }))
  expect(screen.getByRole('dialog', { name: zh.onboardingSkipTitle })).toBeTruthy()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(operations.complete).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.onboardingSkip }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingEnter })) })
  expect(operations.complete).toHaveBeenCalledWith('skipped')
})

it.each(['welcome', 'credit', 'purpose', 'process'] as const)('records the %s page copy', async (step) => {
  mount(step)
  document.querySelectorAll('[data-desktop-onboarding] [aria-hidden="true"]').forEach((element) => { element.remove() })
  await expect(`${document.querySelector('[data-desktop-onboarding]')?.textContent}\n`)
    .toMatchFileSnapshot(`./expected/onboarding-${step}.txt`)
})

it.each(['welcome', 'credit', 'purpose', 'process'] as const)('records English %s page copy', async (step) => {
  mount(step, 'zero', 'ready', en)
  document.querySelectorAll('[data-desktop-onboarding] [aria-hidden="true"]').forEach((element) => { element.remove() })
  await expect(`${document.querySelector('[data-desktop-onboarding]')?.textContent}\n`)
    .toMatchFileSnapshot(`./expected/onboarding-${step}-en.txt`)
})

it.each([zh, en])('offers Continue and recharge for a balance confirmed before entry', async (copy) => {
  const operations = mount('credit', 'positive', 'ready', copy, true)
  expect(screen.queryByRole('button', { name: copy.onboardingLater })).toBeNull()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: copy.onboardingFundedTopUp })) })
  expect(operations.openPlatformPage).toHaveBeenCalledWith('top-up', expect.any(Function))
  await act(async () => { operations.back() })
  expect(operations.update).not.toHaveBeenCalled()
  expect(document.querySelector('[data-desktop-onboarding="credit"]')).toBeTruthy()
})

it('continues directly from funded credit', async () => {
  const operations = mount('credit', 'positive', 'ready', zh, true)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingContinue })) })
  expect(operations.update).toHaveBeenCalledWith({ step: 'purpose' })
  expect(operations.openPlatformPage).not.toHaveBeenCalled()
})

it.each([zh, en])('keeps purpose descriptions unchanged when selecting and deselecting cards', async (copy) => {
  mount('purpose', 'zero', 'ready', copy)
  for (const name of [copy.onboardingOffice, copy.onboardingDevelopment]) {
    for (let click = 0; click < 2; click++) {
      await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name })) })
      expect(screen.getByText(copy.onboardingOfficeDescription)).toBeTruthy()
      expect(screen.getByText(copy.onboardingDevelopmentDescription)).toBeTruthy()
    }
  }
})

it('keeps the recharge request releasable so the flow can still leave credit', async () => {
  const operations = mount('credit')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingTopUp })) })
  expect(operations.openPlatformPage).toHaveBeenCalledWith('top-up', expect.any(Function))
  await act(async () => { operations.back() })
  expect(document.querySelector('[data-desktop-onboarding="credit"]')).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingBack })) })
  expect(document.querySelector('[data-desktop-onboarding="welcome"]')).toBeTruthy()
})

it('closes skip confirmation when saving fails so the page can show retry', async () => {
  const operations = mount('purpose')
  operations.complete.mockResolvedValueOnce(false)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingSkip })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingEnter })) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.querySelector('[data-desktop-onboarding="purpose"]')).toBeTruthy()
})

it.each(['zero', 'positive', 'bonus', 'failed', 'loading'] as const)('confirms skipping the credit page with %s balance before completion', async (balance) => {
  const operations = mount('credit', balance)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingSkip })) })
  expect(screen.getByRole('dialog', { name: zh.onboardingNoCreditTitle })).toBeTruthy()
  expect(screen.queryByRole('dialog', { name: zh.onboardingSkipTitle })).toBeNull()
  expect(operations.complete).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingUnderstood })) })
  expect(operations.complete).toHaveBeenCalledWith('skipped')
  expect(operations.update).not.toHaveBeenCalled()
})

it('retries a rejected settings write from the page alert', async () => {
  const h = mount('purpose', 'positive', 'error')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingRetry })) })
  expect(h.retry).toHaveBeenCalledOnce()
})

it('keeps selection unchanged while a purpose write is pending', async () => {
  const h = mount('purpose')
  const pending = Promise.withResolvers<boolean>()
  h.update.mockReturnValueOnce(pending.promise)
  fireEvent.click(screen.getByRole('checkbox', { name: zh.onboardingOffice }))
  fireEvent.click(screen.getByRole('checkbox', { name: zh.onboardingDevelopment }))
  expect(h.update).toHaveBeenCalledOnce()
  await act(async () => { pending.resolve(true) })
})

it('supports both radio arrow directions, wraps around, and ignores other keys or pending writes', async () => {
  const h = mount('process')
  const radios = screen.getAllByRole('radio')
  for (const key of ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight']) {
    await act(async () => { fireEvent.keyDown(radios[0]!, { key }) })
    expect(h.update).toHaveBeenLastCalledWith({ process: key === 'ArrowLeft' || key === 'ArrowUp' ? 'detailed' : 'standard' })
  }
  const count = h.update.mock.calls.length
  fireEvent.keyDown(radios[0]!, { key: 'a' })
  expect(h.update).toHaveBeenCalledTimes(count)
  const pending = Promise.withResolvers<boolean>()
  h.update.mockReturnValueOnce(pending.promise)
  fireEvent.click(radios[0]!)
  fireEvent.keyDown(radios[1]!, { key: 'ArrowRight' })
  fireEvent.click(radios[1]!)
  expect(h.update).toHaveBeenCalledTimes(count + 1)
  await act(async () => { pending.resolve(true) })
})

it('traps Tab in confirmation, closes it, and keeps the selected page', async () => {
  mount('purpose')
  const trigger = screen.getByRole('button', { name: zh.onboardingSkip })
  trigger.focus()
  fireEvent.click(trigger)
  const dialog = screen.getByRole('dialog')
  const buttons = dialog.querySelectorAll('button')
  const first = buttons[0]!
  const last = buttons[buttons.length - 1]!
  expect(document.activeElement).toBe(first)
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(last)
  fireEvent.keyDown(last, { key: 'Tab' })
  expect(document.activeElement).toBe(first)
  fireEvent.keyDown(first, { key: 'Tab' })
  fireEvent.keyDown(last, { key: 'Tab', shiftKey: true })
  fireEvent.keyDown(first, { key: 'a' })
  fireEvent.click(screen.getByRole('button', { name: zh.onboardingKeepSetting }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('button', { name: zh.close }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('opens recharge directly from a credit warning', async () => {
  const h = mount('credit', 'zero')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingLater })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingGoTopUp })) })
  expect(h.openPlatformPage).toHaveBeenCalledWith('top-up', expect.any(Function))
  expect(screen.queryByRole('dialog', { name: zh.onboardingNoCreditTitle })).toBeNull()
})

it('does not render a finished flow', () => {
  mount('done')
  expect(document.querySelector('[data-desktop-onboarding]')).toBeNull()
})

it.each(['complete', 'cancel', 'reduced'] as const)('settles the page transition when motion is %s', async (mode) => {
  const animation = Promise.withResolvers<undefined>()
  const animate = vi.fn(() => ({ finished: animation.promise, cancel: vi.fn() }))
  vi.stubGlobal('matchMedia', () => ({ matches: mode === 'reduced' }))
  const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate')
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate })
  try {
    mount()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingStart })) })
    if (mode === 'reduced') expect(animate).not.toHaveBeenCalled()
    else {
      expect(animate).toHaveBeenCalledOnce()
      await act(async () => {
        if (mode === 'cancel') animation.reject(new Error('cancelled'))
        else animation.resolve(undefined)
      })
    }
    expect(document.querySelector(`[data-desktop-onboarding="${mode === 'cancel' ? 'welcome' : 'credit'}"]`)).not.toBeNull()
    cleanup()
  } finally {
    if (previous) Object.defineProperty(HTMLElement.prototype, 'animate', previous)
    else Reflect.deleteProperty(HTMLElement.prototype, 'animate')
  }
})

it('does not restore focus to a disconnected confirmation trigger', () => {
  mount('purpose')
  const trigger = screen.getByRole('button', { name: zh.onboardingSkip })
  trigger.focus()
  fireEvent.click(trigger)
  trigger.remove()
  fireEvent.click(screen.getByRole('button', { name: zh.close }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('returns from purpose to credit without dropping the selected purpose', async () => {
  const h = mount('purpose')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.onboardingBack })) })
  expect(h.update).toHaveBeenCalledWith({ step: 'credit' })
})
