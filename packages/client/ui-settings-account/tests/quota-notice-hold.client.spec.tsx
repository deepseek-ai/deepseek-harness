// @vitest-environment jsdom
/**
 * The account takeover inside the shipped composition: the frame-wide notice
 * chain, the account settings page, and the one shared native Platform host.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen } from '@testing-library/react'
import { SlotTestRuntime, stubConfigForm, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionLiveEventEntry, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { AccountView } from '@deepseek-ai/dsh-deepseek-account/types'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import {
  apply as applyConversation, inject as injectConversation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply as applyChat, inject as injectChat } from '@deepseek-ai/dsh-client-ui-chat/client'
import { AccountPlatformHost, type AccountPlatformHostInjected } from '../src/client/AccountPlatformHost.tsx'
import { AccountQuotaNotice, type AccountQuotaNoticeInjected } from '../src/client/AccountQuotaNotice.tsx'
import { AccountSection, type AccountSectionInjected, type AccountSnapshot } from '../src/client/AccountSection.tsx'
import { DesktopOnboardingEntry, type DesktopOnboardingInjected } from '../src/client/DesktopOnboardingEntry.tsx'
import type { DesktopOnboardingState } from '../src/client/onboarding-contract.ts'
import { createPlatformPages, type PlatformPages } from '../src/client/platform-pages.ts'
import type { PlatformBridge } from '../src/client/PlatformOverlay.tsx'
import { en, zh } from '../src/client/locales.ts'

usePinnedBrowserLanguages('en')

const SID = 'session-1' as SessionId
const NOTICE = 'Request quota exhausted.'
const disposers: Array<() => Promise<void>> = []
const references: SessionReference[] = []

afterEach(async () => {
  for (const reference of references.splice(0)) reference.release()
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  vi.unstubAllGlobals()
})

/** One live `turn/end` failure entry for a session event window. */
const quotaEntry = (seq: number, code: string): SessionLiveEventEntry => ({
  type: 'event', event: {
    type: 'turn/end', seq: seq as SessionSeq, time: seq,
    data: { turn: 0, reason: { kind: 'error', error: { code, message: 'balance' } } },
  },
})

const storedView: AccountView = {
  status: 'credential-stored', attempt: null,
  links: { usageUrl: 'http://localhost:8081/usage', topUpUrl: 'http://localhost:8081/top_up' },
}
const theme: ThemeSnapshot = {
  preference: 'light', fontSize: 14, active: { id: 'light', colorScheme: 'light', tokens: {} }, themes: [], revision: 0,
}

/** The account settings commands, trimmed to what this composition renders. */
function sectionOperations(account: AccountSnapshot, pages: PlatformPages): AccountSectionInjected {
  return {
    hooks: {
      account: { getSnapshot: () => account, subscribe: () => () => {} },
      theme: { getSnapshot: () => theme, subscribe: () => () => {} },
    },
    openPlatformPage: pages.open,
    refreshAccount: async () => {},
    bonusNoticeShown: () => {}, bonusNoticeDismissed: () => {},
    hasRunningAccountTasks: async () => false,
    contactUs: () => {}, showLogin: () => {}, setOnboarding: () => {},
    start: async () => {}, cancel: async () => {}, signOut: async () => {},
  }
}

/**
 * Mount the real Chat quota host, this package's own shared Platform host, and
 * the account settings page, registered as the account plugin registers them.
 * @returns the runtime, the live account store, the page channel, and the bridge.
 */
async function bench() {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const runtime = await SlotTestRuntime.create()
  disposers.push(() => runtime.dispose())
  const forms = new Map<string, ReturnType<typeof stubConfigForm>['scope']>()
  const formFor = (namespace: string) => {
    let scope = forms.get(namespace)
    if (scope === undefined) {
      scope = stubConfigForm().scope
      forms.set(namespace, scope)
    }
    return scope
  }
  runtime.ctx.provide('configForms', {
    developerTools: { enabled: createSnapshotStore(true) },
    get: formFor,
  } as never)
  runtime.ctx.provide('layout', { openRightbar: () => {}, closeRightbar: () => {} } as never)
  runtime.ctx.provide('sidebarRight', { openResource: () => {}, openTab: () => {} } as never)
  runtime.ctx.provide('sidebarRightTabs', {
    register: () => () => {}, get: () => ({}), subscribe: () => () => {},
  } as never)
  runtime.ctx.provide('resources', { register: () => () => {} } as never)
  runtime.ctx.provide('uiWorkspace', {
    openWorkspace: async (_workspaceId: WorkspaceId, beforeOpen: (id: SessionId) => void) => { beforeOpen(SID) },
    openSession: () => {},
  } as never)
  runtime.remote.provideNamespaces({ session: { openWorkspacePath: async () => ({ ok: true, value: { opened: true } }) } })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.ctx.effect(() => locale.register('settings.account', { en, zh }), 'spec: account dictionaries')
  await runtime.declare({
    'shell.overlay': { kind: 'list', scope: 'root' },
    'settings.section': { kind: 'list', scope: 'root' },
    'conversation.approval.detail': { kind: 'single', scope: 'session' },
  })
  await runtime.mount({ inject: [...injectConversation], apply: applyConversation })
  let descriptor: Parameters<typeof runtime.ctx.uiSession.provide>[0] | undefined
  const provide = runtime.ctx.uiSession.provide.bind(runtime.ctx.uiSession)
  runtime.ctx.uiSession.provide = (next) => { descriptor ??= next; return provide(next) }
  await runtime.mount({ inject: [...injectChat], apply: applyChat })
  if (descriptor === undefined) throw new Error('ui-chat did not provide its standard source')
  const accountSnapshot = createSnapshotStore<AccountSnapshot>({ view: storedView, details: undefined, failed: false })
  const account = {
    getSnapshot: () => accountSnapshot.getSnapshot(),
    subscribe: (listener: () => void) => accountSnapshot.subscribe(listener),
  }
  const platform = {
    open: vi.fn<PlatformBridge['open']>(async () => {}),
    setBounds: vi.fn<PlatformBridge['setBounds']>(async () => {}),
    close: vi.fn<PlatformBridge['close']>(async () => {}),
  }
  const pages = createPlatformPages()
  disposers.push(async () => { pages.dispose() })
  // The onboarding recharge flow is a third caller of the same page channel.
  const onboarding = createSnapshotStore<DesktopOnboardingState>({
    status: 'ready', visible: false, creditFunded: false, error: null,
    progress: { version: 1, step: 'welcome', purpose: null, process: null, completion: null, usage: 'compact', developerTools: false },
  })
  let unregisterNotice: (() => void) | undefined
  runtime.ctx.slots.inject('shell.overlay', () => runtime.ctx.slots.register({
    name: 'shell.overlay', id: 'account.platform-page', locale: 'settings.account',
    inject: (): AccountPlatformHostInjected => ({
      platform, hooks: { page: pages }, closePage: () => { pages.close() },
    }),
  }, AccountPlatformHost))
  runtime.ctx.slots.inject('shell.quota-notice', () => {
    const dispose = runtime.ctx.slots.register({
      name: 'shell.quota-notice', locale: 'settings.account',
      select: owner => owner.code === 'ACCOUNT_QUOTA' ? owner : null,
      inject: (): AccountQuotaNoticeInjected => ({ hooks: { account, platformPage: pages }, openPlatformPage: pages.open }),
    }, AccountQuotaNotice)
    unregisterNotice = dispose
    return dispose
  })
  runtime.ctx.slots.inject('settings.section', () => runtime.ctx.slots.register({
    name: 'settings.section', id: 'account', locale: 'settings.account',
    inject: () => sectionOperations(accountSnapshot.getSnapshot(), pages),
  }, AccountSection))
  runtime.ctx.slots.inject('shell.overlay', () => runtime.ctx.slots.register({
    name: 'shell.overlay', id: 'desktop-onboarding', locale: 'settings.account',
    inject: (): DesktopOnboardingInjected => ({
      hooks: { onboarding, account },
      openPlatformPage: pages.open,
      update: async () => true, complete: async () => true, retry: async () => true,
    }),
  }, DesktopOnboardingEntry))
  // Retaining the Session subscribes the Chat source, so live failures publish.
  await runtime.sessions.add({ id: SID })
  const reference = runtime.sessions.retain(SID)
  references.push(reference)
  descriptor.resolve(reference.binding)
  runtime.renderSlot('shell.overlay', {})
  runtime.renderSlot('settings.section', { close: () => {} })
  return {
    runtime,
    pages,
    platform,
    account: accountSnapshot,
    onboarding,
    /** Drop the claiming account entry the way a higher-priority one would replace it. */
    removeNoticeEntry: () => { unregisterNotice?.(); unregisterNotice = undefined },
  }
}

/** Publish one live quota failure and flush the resulting React work. */
async function fail(runtime: SlotTestRuntime, seq: number, code: string): Promise<void> {
  await act(async () => { await runtime.sessions.appendEvent(SID, quotaEntry(seq, code)) })
}

/** The account settings card's top-up link, which requests the shared page. */
function settingsTopUp() {
  return screen.getAllByRole('link', { name: en.topUp }).at(-1)!
}
/** The account settings card's usage link, which requests the shared page. */
function settingsUsage() {
  return screen.getAllByRole('link', { name: en.usage }).at(-1)!
}

describe('shared Platform page ownership', () => {
  it('defers the notice while a settings page is open, then reveals it after Back', async () => {
    const b = await bench()
    await act(async () => { settingsUsage().click() })
    expect(b.platform.open).toHaveBeenLastCalledWith('usage', { x: 0, y: 0, width: 0, height: 0 })

    // The opaque native view covers this document, so the arriving notice must
    // not paint a Modal the user could neither see nor click.
    await fail(b.runtime, 0, 'ACCOUNT_QUOTA')
    expect(screen.queryByRole('dialog', { name: en.quotaTitle })).toBeNull()
    expect(screen.queryByRole('button', { name: en.quotaTopUp })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    // Deferring the notice neither reloads the page nor tears it down.
    expect(b.platform.open).toHaveBeenCalledOnce()
    expect(b.platform.close).not.toHaveBeenCalled()

    // Returning closes the page, and the still-live notice reveals itself.
    await act(async () => { screen.getByRole('button', { name: en.backToHarness }).click() })
    expect(b.platform.close).toHaveBeenCalledOnce()
    expect(screen.getByRole('dialog', { name: en.quotaTitle })).toBeTruthy()
    expect(b.pages.getSnapshot()).toBeNull()

    // Top up then takes the shared page over, once.
    await act(async () => { screen.getByRole('button', { name: en.quotaTopUp }).click() })
    expect(b.platform.open.mock.calls.map(([page]) => page)).toEqual(['usage', 'top-up'])
    expect(b.pages.getSnapshot()).toEqual({ page: 'top-up' })
  })

  it('hands focus to the revealed notice Modal when Back closes the settings page', async () => {
    const b = await bench()
    const usage = settingsUsage()
    // The user is on the Settings card when they open the page, so the link is
    // the focus the page records for its own return.
    act(() => { usage.focus() })
    expect(document.activeElement).toBe(usage)
    await act(async () => { usage.click() })
    expect(screen.getByRole('button', { name: en.backToHarness })).toBeTruthy()
    // The deferred notice paints nothing while the opaque page covers Settings.
    await fail(b.runtime, 0, 'ACCOUNT_QUOTA')
    expect(screen.queryByRole('dialog', { name: en.quotaTitle })).toBeNull()

    // Back mounts the Modal in the same commit that removes the page, so the
    // page's focus restore must run before the Modal takes the focus it owns.
    await act(async () => { screen.getByRole('button', { name: en.backToHarness }).click() })
    const modal = screen.getByRole('dialog', { name: en.quotaTitle })
    expect(document.activeElement).not.toBe(usage)
    expect(modal.contains(document.activeElement)).toBe(true)
    expect(b.pages.getSnapshot()).toBeNull()
  })

  it('defers the notice behind the onboarding recharge page and focuses it on return', async () => {
    const b = await bench()
    // Onboarding is the third caller of the shared channel, here on the credit
    // step that offers recharge.
    await act(async () => {
      b.onboarding.set({
        status: 'ready', visible: true, creditFunded: false, error: null,
        progress: { version: 1, step: 'credit', purpose: null, process: null, completion: null, usage: 'compact', developerTools: false },
      })
    })
    const recharge = screen.getByRole('button', { name: en.onboardingTopUp })
    act(() => { recharge.focus() })
    await act(async () => { fireEvent.click(recharge) })
    // One native owner: onboarding asked the shared channel, so the bridge opens
    // exactly one page and no second overlay exists.
    expect(b.platform.open.mock.calls.map(([page]) => page)).toEqual(['top-up'])
    expect(b.pages.getSnapshot()).toEqual({ page: 'top-up' })

    // A background account failure arriving behind that page is deferred rather
    // than painted under the opaque native view.
    await fail(b.runtime, 0, 'ACCOUNT_QUOTA')
    expect(screen.queryByRole('dialog', { name: en.quotaTitle })).toBeNull()

    // Back closes the shared page and hands focus to the revealed Modal.
    await act(async () => { screen.getByRole('button', { name: en.backToHarness }).click() })
    expect(b.pages.getSnapshot()).toBeNull()
    const modal = screen.getByRole('dialog', { name: en.quotaTitle })
    expect(document.activeElement).not.toBe(recharge)
    expect(modal.contains(document.activeElement)).toBe(true)
  })

  it('leaves an already-showing settings top-up page intact behind the deferred notice', async () => {
    const b = await bench()
    await act(async () => { settingsTopUp().click() })
    expect(b.platform.open).toHaveBeenLastCalledWith('top-up', { x: 0, y: 0, width: 0, height: 0 })

    // The settings card remains mounted behind the shared overlay, and the
    // notice adds neither a hidden Modal nor a second native page.
    await fail(b.runtime, 0, 'ACCOUNT_QUOTA')
    expect(screen.queryByRole('dialog', { name: en.quotaTitle })).toBeNull()
    expect(settingsTopUp()).toBeTruthy()
    expect(b.platform.open).toHaveBeenCalledOnce()
    expect(b.platform.close).not.toHaveBeenCalled()

    // Returning reveals the notice; Top up reopens the destination it names.
    await act(async () => { screen.getByRole('button', { name: en.backToHarness }).click() })
    expect(screen.getByRole('dialog', { name: en.quotaTitle })).toBeTruthy()
    await act(async () => { screen.getByRole('button', { name: en.quotaTopUp }).click() })
    expect(b.platform.open.mock.calls.map(([page]) => page)).toEqual(['top-up', 'top-up'])
  })

  it('replaces a deferred account notice with the newest failure behind a settings page', async () => {
    const b = await bench()
    await act(async () => { settingsUsage().click() })
    expect(b.platform.open).toHaveBeenLastCalledWith('usage', { x: 0, y: 0, width: 0, height: 0 })

    // No hold exists yet, so the deferred account notice is not retained: a
    // later generic quota failure replaces it as the live notice.
    await fail(b.runtime, 0, 'ACCOUNT_QUOTA')
    await fail(b.runtime, 1, 'QUOTA')
    expect(screen.queryByRole('dialog', { name: en.quotaTitle })).toBeNull()
    // The page itself is untouched by either failure.
    expect(b.platform.open).toHaveBeenCalledOnce()
    expect(b.platform.close).not.toHaveBeenCalled()

    // Back never revives the replaced account Modal; the newest failure owns the
    // notice, and here that is the host fallback Toast.
    await act(async () => { screen.getByRole('button', { name: en.backToHarness }).click() })
    expect(b.pages.getSnapshot()).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe(NOTICE)
  })

  it('keeps the open page across later account and generic quota failures', async () => {
    const b = await bench()
    await fail(b.runtime, 0, 'ACCOUNT_QUOTA')
    expect(screen.getByRole('dialog', { name: en.quotaTitle })).toBeTruthy()
    await act(async () => { screen.getByRole('button', { name: en.quotaTopUp }).click() })
    expect(b.platform.open).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: en.backToHarness })).toBeTruthy()

    // The hold drops later notifications before they publish, so the chain
    // neither swaps to the fallback nor remounts this entry, and the page stays.
    await fail(b.runtime, 1, 'QUOTA')
    await fail(b.runtime, 2, 'ACCOUNT_QUOTA')
    expect(b.platform.close).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: en.backToHarness })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()

    // Leaving the page dismisses, so a later failure surfaces again.
    await act(async () => { screen.getByRole('button', { name: en.backToHarness }).click() })
    expect(b.platform.close).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
    await fail(b.runtime, 3, 'QUOTA')
    expect(screen.getByRole('alert').textContent).toBe(NOTICE)
  })

  it('releases the hold with its entry, so a later failure publishes again', async () => {
    const b = await bench()
    await fail(b.runtime, 0, 'ACCOUNT_QUOTA')
    await act(async () => { screen.getByRole('button', { name: en.quotaTopUp }).click() })
    expect(b.platform.open).toHaveBeenCalledOnce()

    // A claiming entry can disappear without dismissing: a higher-priority
    // entry, a plugin reload, or a chain crash. Its hold must go with it, or
    // every later failure would publish nothing.
    await act(async () => { b.removeNoticeEntry() })
    expect(b.pages.getSnapshot()).toBeNull()
    expect(b.platform.close).toHaveBeenCalledOnce()
    await fail(b.runtime, 1, 'ACCOUNT_QUOTA')
    expect(screen.getByRole('alert').textContent).toBe(NOTICE)
  })

  it('resumes fresh notices after signing out releases the hold', async () => {
    const b = await bench()
    await fail(b.runtime, 0, 'ACCOUNT_QUOTA')
    await act(async () => { screen.getByRole('button', { name: en.quotaTopUp }).click() })
    expect(b.platform.open).toHaveBeenCalledOnce()

    act(() => { b.account.set({ view: { ...storedView, status: 'signed-out' }, details: undefined, failed: false }) })
    expect(b.platform.close).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: en.backToHarness })).toBeNull()

    // The hold ended with the dismissal, so the next failure publishes anew.
    await fail(b.runtime, 1, 'ACCOUNT_QUOTA')
    expect(screen.getByRole('alert').textContent).toBe(NOTICE)
  })
})
