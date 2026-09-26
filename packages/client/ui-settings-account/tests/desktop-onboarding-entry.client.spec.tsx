// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AccountSnapshot } from '../src/client/AccountSection.tsx'
import { DesktopOnboardingEntry } from '../src/client/DesktopOnboardingEntry.tsx'
import type { DesktopOnboardingState } from '../src/client/onboarding-contract.ts'
import { zh, type AccountKey } from '../src/client/locales.ts'

let appRoot: HTMLDivElement

it.each([false, true])('resizes only after eligibility resolves (completed=%s)', (done) => {
  const setActive = vi.fn()
  vi.stubGlobal('dshOnboarding', { setActive })
  const view = mount(done, true)
  expect(setActive).not.toHaveBeenCalled()
  view.resolve()
  if (done) expect(setActive).not.toHaveBeenCalled()
  else {
    expect(setActive).toHaveBeenCalledExactlyOnceWith(true)
    view.finish()
    expect(setActive).toHaveBeenLastCalledWith(false)
  }
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
  appRoot = document.createElement('div')
  appRoot.id = 'root'
  appRoot.inert = false
  document.body.append(appRoot)
})

afterEach(() => {
  cleanup()
  appRoot.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function mount(initiallyDone = false, initiallyLoading = false) {
  let state: DesktopOnboardingState = {
    creditFunded: false,
    visible: !initiallyDone && !initiallyLoading, status: initiallyLoading ? 'loading' : 'ready', error: null,
    progress: { version: 1, step: initiallyDone ? 'done' : 'welcome', purpose: null, process: null,
      completion: initiallyDone ? 'completed' : null, usage: 'compact', developerTools: false },
  }
  let account: AccountSnapshot = {
    view: { status: 'credential-stored', attempt: null, links: { usageUrl: 'https://example.com/usage', topUpUrl: 'https://example.com/top_up' } },
    failed: false, details: undefined,
  }
  // This entry consumes only its injected selectors; the shell owns the global hooks.
  const globals = {} as GlobalStandardProps
  const element = () => <DesktopOnboardingEntry {...globals}
    useOnboarding={select => select(state)} useAccount={select => select(account)}
    update={async () => true} complete={async () => true} retry={async () => true}
    t={key => key in zh ? zh[key as AccountKey] : key} />
  const view = render(element())
  act(() => { vi.runOnlyPendingTimers() })
  return {
    unmount: view.unmount,
    resolve() {
      state = { ...state, status: 'ready', visible: !initiallyDone }
      view.rerender(element())
    },
    finish(status: DesktopOnboardingState['status'] = 'ready') {
      state = { ...state, visible: false, status, progress: { ...state.progress, step: 'done', completion: 'completed' } }
      view.rerender(element())
    },
    fail() {
      state = { ...state, status: 'error', error: 'settings' }
      view.rerender(element())
    },
    signOut() {
      account = { ...account, view: { ...account.view!, status: 'signed-out' } }
      state = { ...state, visible: false }
      view.rerender(element())
    },
  }
}

it('retains the last page while successful completion reveals the workspace', () => {
  const view = mount()
  expect(appRoot.style.opacity).toBe('0')
  view.finish()
  expect(screen.getByRole('heading', { name: `${zh.onboardingWelcome} ${zh.onboardingBrand}` })).toBeTruthy()
  expect(document.querySelector('[data-exiting]')).not.toBeNull()
  expect(appRoot.style.opacity).toBe('')
  expect(appRoot.inert).toBe(true)
  act(() => { vi.advanceTimersByTime(179) })
  expect(document.querySelector('[data-exiting]')).not.toBeNull()
  act(() => { vi.advanceTimersByTime(1) })
  expect(document.querySelector('[data-exiting]')).toBeNull()
  expect(appRoot.inert).toBe(false)
})

it('keeps a failed completion visible and the workspace hidden', () => {
  const view = mount()
  view.fail()
  act(() => { vi.advanceTimersByTime(200) })
  expect(screen.getByRole('heading', { name: `${zh.onboardingWelcome} ${zh.onboardingBrand}` })).toBeTruthy()
  expect(document.querySelector('[data-exiting]')).toBeNull()
  expect(appRoot.inert).toBe(true)
  expect(appRoot.style.opacity).toBe('0')
})

it('waits for completion confirmation after the settings stream first reports done', () => {
  const view = mount()
  view.finish('saving')
  expect(screen.getByRole('heading')).toBeTruthy()
  expect(screen.getByRole('button', { name: zh.onboardingStart }).hasAttribute('disabled')).toBe(true)
  expect(document.querySelector('[data-exiting]')).toBeNull()
  expect(appRoot.style.opacity).toBe('0')
  act(() => { vi.advanceTimersByTime(200) })
  expect(appRoot.inert).toBe(true)
  view.finish()
  expect(document.querySelector('[data-exiting]')).not.toBeNull()
  act(() => { vi.advanceTimersByTime(180) })
  expect(screen.queryByRole('heading')).toBeNull()
  expect(appRoot.inert).toBe(false)
})

it('removes the completed page immediately when motion is reduced', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
  const view = mount()
  view.finish()
  expect(screen.queryByRole('heading')).toBeNull()
  expect(appRoot.inert).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it('does not replay an exit when an already completed installation mounts', () => {
  mount(true)
  expect(screen.queryByRole('heading')).toBeNull()
  expect(appRoot.inert).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it.each([false, true])('removes onboarding immediately on sign-out, including during exit=%s', (exiting) => {
  const view = mount()
  if (exiting) view.finish()
  view.signOut()
  expect(screen.queryByRole('heading')).toBeNull()
  expect(appRoot.inert).toBe(false)
  expect(appRoot.style.opacity).toBe('')
  expect(vi.getTimerCount()).toBe(0)
})

it('cancels pending completion teardown when the entry unmounts', () => {
  const view = mount()
  view.finish()
  expect(vi.getTimerCount()).toBe(1)
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
  expect(appRoot.inert).toBe(false)
  expect(appRoot.style.opacity).toBe('')
})

it.each([false, true])('covers the workspace until initial onboarding eligibility resolves (completed=%s)', (done) => {
  const view = mount(done, true)
  expect(appRoot.inert).toBe(true)
  expect(appRoot.style.opacity).toBe('0')
  expect(screen.getByRole('status').textContent).toBe(zh.onboardingLoading)
  view.resolve()
  expect(screen.queryByRole('status')).toBeNull()
  expect(appRoot.inert).toBe(!done)
  if (!done) expect(screen.getByRole('button', { name: zh.onboardingStart })).toBeTruthy()
})
