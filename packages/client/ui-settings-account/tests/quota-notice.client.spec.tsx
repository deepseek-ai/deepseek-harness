// @vitest-environment jsdom
/** Account take-over of the frame-wide quota notice, and its generic fallback. */
import { act, cleanup, render, fireEvent, screen } from '@testing-library/react'
import { afterEach, expect, it, vi, type Mock } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { QuotaNoticeOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { AccountView } from '@deepseek-ai/dsh-deepseek-account/types'
import type { AccountSnapshot } from '../src/client/AccountSection.tsx'
import type {} from '../src/client/index.ts'
import { AccountQuotaNotice } from '../src/client/AccountQuotaNotice.tsx'
import { createPlatformPages, type PlatformPages } from '../src/client/platform-pages.ts'
import { en, zh, type AccountKey } from '../src/client/locales.ts'

/** Subscriptions opened by one mounted entry, released with the entry. */
const mountedSubscriptions: Array<() => void> = []

afterEach(() => {
  for (const unsubscribe of mountedSubscriptions.splice(0)) unsubscribe()
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** Notice copy supplied by the Chat-owned host; this entry never restates it. */
const noticeMessage = 'Request quota exhausted.'

function snapshot(status?: 'signed-out' | 'credential-stored'): AccountSnapshot {
  const view: AccountView = { status: status ?? 'signed-out', attempt: null, links: { usageUrl: '', topUpUrl: '' } }
  return { view: status === undefined ? undefined : view, details: undefined, failed: false }
}

/** The live page request channel with its acquisition order retained for ordering assertions. */
interface PageSpies {
  readonly pages: PlatformPages
  readonly open: Mock<PlatformPages['open']>
}

function pageSpies(): PageSpies {
  const pages = createPlatformPages()
  const open = vi.spyOn(pages, 'open')
  return { pages, open }
}

/** Recorded call position of one spy, matching the ui-workspace row-action pattern. */
function callOrder(fn: { mock: { invocationCallOrder: readonly number[] } }, nth = 0): number {
  return fn.mock.invocationCallOrder[nth] ?? Number.POSITIVE_INFINITY
}

/**
 * Mount the entry the way the quota chain does: claiming owner, live account
 * snapshot, the narrow page callback, and the page observable its host serves.
 * Page changes re-render through the channel's own subscription, standing in
 * for the renderer's framework hook.
 */
function mount(options: { account?: 'unloaded' | 'signed-out' | 'credential-stored'; pages?: PlatformPages; copy?: typeof en | typeof zh } = {}) {
  const copy = options.copy ?? en
  const pages = options.pages
  const initial = options.account ?? 'credential-stored'
  let account = snapshot(initial === 'unloaded' ? undefined : initial)
  let live = true
  let rerender = () => {}
  const dismiss = vi.fn(() => { live = false; rerender() })
  const releaseHold = vi.fn()
  const keepOpen = vi.fn(() => releaseHold)
  // The chain renderer passes the owner share and the selector's match, which
  // here is that same owner, so the entry receives both.
  const owner: QuotaNoticeOwnerProps = { code: 'ACCOUNT_QUOTA', message: noticeMessage, dismiss, keepOpen }
  const element = () => live
    ? <AccountQuotaNotice {...({} as GlobalStandardProps)} {...owner} matched={owner}
      {...pages === undefined ? {} : { openPlatformPage: pages.open }}
      useAccount={selector => selector(account)}
      usePlatformPage={selector => selector(pages?.getSnapshot() ?? null)}
      t={key => copy[key as AccountKey]} />
    : null
  const rendered = render(element())
  rerender = () => { rendered.rerender(element()) }
  // Page changes re-render through the channel's subscription, the way the
  // renderer's framework hook does; release it so no callback reaches an
  // unmounted instance.
  if (pages !== undefined) mountedSubscriptions.push(pages.subscribe(rerender))
  return {
    dismiss,
    keepOpen,
    releaseHold,
    rendered,
    setStatus: (status: 'signed-out' | 'credential-stored') => { account = snapshot(status); rerender() },
    failStream: () => { account = { ...account, failed: true }; rerender() },
  }
}

it.each([en, zh])('requests the shared top-up page for the claimed account notice', async (copy) => {
  const spies = pageSpies()
  const { dismiss, keepOpen, releaseHold } = mount({ pages: spies.pages, copy })
  expect(screen.getByRole('dialog', { name: copy.quotaTitle }).textContent).toContain(copy.quotaDescription)
  expect(keepOpen).not.toHaveBeenCalled()
  expect(spies.pages.getSnapshot()).toBeNull()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: copy.quotaTopUp })) })
  // The notice must be retained before its page mounts: a later failure that
  // replaced the notice would otherwise remount this entry and drop the page.
  expect(keepOpen).toHaveBeenCalledOnce()
  expect(callOrder(keepOpen)).toBeLessThan(callOrder(spies.open))
  expect(spies.open).toHaveBeenCalledWith('top-up', expect.any(Function))
  expect(spies.pages.getSnapshot()).toEqual({ page: 'top-up' })
  expect(dismiss).not.toHaveBeenCalled()
  expect(releaseHold).not.toHaveBeenCalled()
  // The page hides this entry's surface; the shared host owns the container.
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each([en, zh])('dismisses the account notice without requesting a page', (copy) => {
  const spies = pageSpies()
  const { dismiss } = mount({ pages: spies.pages, copy })
  fireEvent.click(screen.getByRole('button', { name: copy.cancel }))
  expect(dismiss).toHaveBeenCalledOnce()
  expect(spies.open).not.toHaveBeenCalled()
  expect(spies.pages.getSnapshot()).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each([en, zh])('dismisses the account notice through its close button', (copy) => {
  const spies = pageSpies()
  const { dismiss } = mount({ pages: spies.pages, copy })
  fireEvent.click(screen.getByRole('button', { name: copy.close }))
  expect(dismiss).toHaveBeenCalledOnce()
  expect(spies.pages.getSnapshot()).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each([en, zh])('defers the balance Modal while any Platform page is showing', async (copy) => {
  const spies = pageSpies()
  const { dismiss } = mount({ pages: spies.pages, copy })
  expect(screen.getByRole('dialog', { name: copy.quotaTitle })).toBeTruthy()
  // Another surface already shows a native page: its opaque view covers this
  // document, so the notice must not paint a Modal the user cannot see or click.
  await act(async () => { spies.pages.open('usage', () => {}) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button', { name: copy.quotaTopUp })).toBeNull()
  expect(dismiss).not.toHaveBeenCalled()
  // Returning from the page reveals the still-live notice.
  await act(async () => { spies.pages.close() })
  expect(screen.getByRole('dialog', { name: copy.quotaTitle })).toBeTruthy()
  expect(dismiss).not.toHaveBeenCalled()
})

it.each(['credential-stored', 'signed-out'] as const)('waits beyond the Toast lifetime for the first account snapshot: %s', (status) => {
  vi.useFakeTimers()
  const spies = pageSpies()
  const { dismiss, setStatus } = mount({ account: 'unloaded', pages: spies.pages })
  act(() => { vi.advanceTimersByTime(10_000) })
  expect(dismiss).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
  act(() => { setStatus(status) })
  if (status === 'credential-stored') {
    expect(screen.getByRole('dialog', { name: en.quotaTitle })).toBeTruthy()
    expect(dismiss).not.toHaveBeenCalled()
  } else {
    expect(screen.getByRole('alert').textContent).toBe(noticeMessage)
    act(() => { vi.runAllTimers() })
    expect(dismiss).toHaveBeenCalledOnce()
  }
})

it('shows a timed Toast when the account stream fails before its first snapshot', () => {
  vi.useFakeTimers()
  const { dismiss, failStream, keepOpen } = mount({ account: 'unloaded', pages: createPlatformPages() })
  act(() => { vi.advanceTimersByTime(10_000) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(dismiss).not.toHaveBeenCalled()
  act(() => { failStream() })
  expect(screen.getByRole('alert').textContent).toBe(noticeMessage)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(keepOpen).not.toHaveBeenCalled()
  act(() => { vi.runAllTimers() })
  expect(dismiss).toHaveBeenCalledOnce()
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['signed-out', 'unloaded'] as const)('uses a timed Toast without the shared page host: %s', (account) => {
  vi.useFakeTimers()
  const { dismiss } = mount({ account })
  expect(screen.getByRole('alert').textContent).toBe(noticeMessage)
  expect(screen.queryByRole('button')).toBeNull()
  act(() => { vi.runAllTimers() })
  expect(dismiss).toHaveBeenCalledOnce()
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each([en, zh])('takes the balance Modal down when the account signs out', (copy) => {
  const spies = pageSpies()
  const { dismiss, setStatus } = mount({ pages: spies.pages, copy })
  expect(screen.getByRole('dialog', { name: copy.quotaTitle })).toBeTruthy()
  act(() => { setStatus('signed-out') })
  expect(dismiss).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(spies.open).not.toHaveBeenCalled()
})

it('releases the shared page and its hold when the account signs out mid-page', async () => {
  const spies = pageSpies()
  const { dismiss, releaseHold, setStatus } = mount({ pages: spies.pages })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.quotaTopUp })) })
  expect(spies.pages.getSnapshot()).toEqual({ page: 'top-up' })
  act(() => { setStatus('signed-out') })
  expect(dismiss).toHaveBeenCalledOnce()
  expect(spies.pages.getSnapshot()).toBeNull()
  expect(releaseHold).toHaveBeenCalledOnce()
})

it('releases the hold when a higher-priority entry unmounts this one', async () => {
  const spies = pageSpies()
  const { releaseHold, rendered } = mount({ pages: spies.pages })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.quotaTopUp })) })
  rendered.unmount()
  // An unmount the notice never asked for must not strand the hold, or later
  // failures would publish nothing.
  expect(releaseHold).toHaveBeenCalledOnce()
  expect(spies.pages.getSnapshot()).toBeNull()
})
