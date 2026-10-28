// @vitest-environment jsdom
/** Owner-facing feedback and safe defaults, with only the share-management Remote substituted. */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '../src/client/index.ts'
import { LiveshareShareDialog, type LiveshareShareDialogProps } from '../src/client/ShareDialog.tsx'
import { en, zh } from '../src/client/locales.ts'
import css from '../src/client/ShareDialog.module.css'
import type {
  CreatedShare, OwnerIdentityStatus, OwnerRelayState, RelayConnectivityView, RelayPublishView, SharePermissions,
} from '../src/share-api-types.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import {
  accepted, ownerSharesDouble, refused, requestOf, type OwnerSharesDouble, type OwnerSharesOverrides,
} from './owner-shares-double.client.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const translate: LiveshareShareDialogProps['t'] = (key, params) => {
  let result: string = (en as Readonly<Record<string, string>>)[key] ?? key
  for (const [name, value] of Object.entries(params ?? {})) result = result.replace(`{${name}}`, String(value))
  return result
}
const existing = {
  shareId: 'existing', sessionId: 'session', sessionTitle: 'Acceptance session',
  link: 'https://relay.example.test/?shareId=existing', createdAt: '2026-09-05T00:00:00Z', online: true,
  sessionMode: 'view',
  allowsFork: false,
  viewerCapabilities: [],
  access: {
    mode: 'selected',
    selected: [{ providerId: 'feishu', tenantId: 'tenant', subjectId: 'viewer' }],
    deploymentAllowedSubjectIds: ['deployment-viewer'],
  },
}

/** The Relay address this fixture's host names. */
const RELAY = 'https://relay.example.test'

/** How many shares this dialog asked its host to create. */
function shareCreates(host: OwnerSharesDouble): number {
  return host.calls.filter(call => call.method === 'create').length
}

/** The create request the dialog sent, or undefined when it sent none. */
function shareRequest(host: OwnerSharesDouble) {
  return requestOf(host.calls, 'create')
}

/** How many identity reads this dialog sent. */
function identityReads(host: OwnerSharesDouble): number {
  return host.calls.filter(call => call.method === 'identity').length
}

/** How many connectivity checks this dialog sent. */
function probes(host: OwnerSharesDouble): number {
  return host.calls.filter(call => call.method === 'testRelay').length
}

/**
 * Render the real dialog against a Host whose share-management Remote is scripted.
 * @param _stopStatus - Retained for the call sites that name it; the Remote decides its own failures.
 * @param existingShare - Whether the host lists an existing share for this Session.
 * @param onClose - Close callback.
 * @param existingItem - The listed record.
 * @param onManage - Manager opener.
 * @param identity - What the host reports about the owner.
 * @param identityPending - A pending identity answer this case resolves itself.
 * @param shareExtra - Fields overlaid on the create answer.
 * @param relayExtra - Connectivity and permission answers.
 * @returns The scripted Remote and the calls it recorded.
 */
async function showDialog(
  _stopStatus = 200,
  existingShare = true,
  onClose = () => {},
  existingItem: Record<string, unknown> = existing,
  onManage?: () => void,
  identity: OwnerIdentityStatus | Promise<OwnerIdentityStatus> = {
    state: 'verified', relay: RELAY, displayName: '许翰翔',
  },
  identityPending?: Promise<OwnerIdentityStatus>,
  shareExtra?: Partial<CreatedShare>,
  relayExtra?: { readonly connectivity?: RelayConnectivityView; readonly permission?: RelayPublishView },
): Promise<OwnerSharesDouble> {
  const host = ownerSharesDouble({
    list: async () => accepted({ shares: (existingShare ? [existingItem] : []) as never }),
    identity: async () => accepted(await (identityPending ?? identity)),
    relay: async () => accepted({ effective: RELAY }),
    testRelay: async () => accepted(relayExtra?.connectivity ?? { ok: true, httpReachable: true, blocking: false }),
    testPublish: async () => accepted(relayExtra?.permission ?? { ok: true, blocking: false }),
    create: async request => accepted({
      link: existing.link,
      shareId: 'existing',
      sessionId: 'session',
      sessionMode: request.sessionMode ?? 'view',
      access: {
        mode: 'open',
        selected: [],
        deploymentAllowedSubjectIds: ['deployment-viewer'],
        shareAllowedSubjectIds: [],
        broadenedByDeploymentSubjects: false,
        identityKeyAcl: true,
      },
      ...shareExtra,
    }),
  })
  await act(async () => {
    render(<LiveshareShareDialog
      sessionId={'session' as SessionId}
      sessionTitle="Acceptance session"
      defaultRelay={RELAY}
      shares={host.shares}
      onClose={onClose}
      {...(onManage === undefined ? {} : { onManage })}
      t={translate}
    />)
  })
  return host
}

/** Save the address by leaving its field; the dialog has no save button. */
async function saveAddress(): Promise<void> {
  await act(async () => { fireEvent.blur(screen.getByRole('textbox', { name: 'Share service address' })) })
}

/** The selected session permission of the one dialog on screen. */
function selectedMode(): 'view' | 'write' | undefined {
  const tablist = screen.queryByRole('tablist', { name: 'Session permission' })
  const selected = tablist?.querySelector<HTMLElement>('[aria-selected="true"]')
  if (selected?.textContent === 'Read only') return 'view'
  if (selected?.textContent === 'Workspace write') return 'write'
  return undefined
}

/** The dialog's enabled controls in document order, the list its modal layer wraps Tab through. */
function enabledFocusables(): HTMLElement[] {
  const dialog = screen.getByRole('dialog')
  return Array.from(dialog.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]',
  )).filter(element => !element.closest('[inert], [hidden]'))
}

describe('Liveshare dialog product acceptance', () => {
  /**
   * Render the real dialog against a host that must verify its owner first, with the sign-in routes
   * and the Relay's popup substituted.
   * @param initialIdentity - What the host first reports about the owner.
   * @returns The fetch double for the sign-in routes, the scripted Remote, the popup, and the ticket.
   */
  async function showLoginDialog(
    initialIdentity: OwnerIdentityStatus = { state: 'unverified', relay: RELAY },
    options: {
      /** Leave the browser refusing the popup, as a blocked-window browser does. */
      readonly noPopup?: boolean
      /** Deadline the host names for the transaction. */
      readonly expiresAt?: string
      /** Answer one redemption POST; the default verifies the owner. */
      readonly redeem?: (code: string, state: string) => Response | Promise<Response>
      /** Capture the attempt's polling timer instead of waiting for it. */
      readonly interceptInterval?: boolean
    } = {},
  ) {
    const intervals: (() => void)[] = []
    if (options.interceptInterval === true) {
      vi.stubGlobal('setInterval', (callback: () => void) => { intervals.push(callback); return 0 })
    }
    const popup = {
      closed: false,
      location: { href: '' },
      postMessage: vi.fn((_message: unknown, _origin: string) => {}),
      close: vi.fn(() => { popup.closed = true }),
    }
    const open = vi.fn((_url: string, _name: string, _features: string) => options.noPopup === true ? null : popup)
    vi.stubGlobal('open', open)
    /** What the host reports about the owner; the redemption is what verifies it. */
    let identity: OwnerIdentityStatus = initialIdentity
    const host = ownerSharesDouble({
      list: async () => accepted({ shares: [] }),
      relay: async () => accepted({ effective: RELAY }),
      identity: async () => accepted(identity),
      testRelay: async () => accepted({ ok: true, httpReachable: true, blocking: false }),
      testPublish: async () => accepted({ ok: true, blocking: false }),
    })
    const fetcher = vi.fn((input: string, _init?: RequestInit) => {
      if (input === 'api/liveshare.ownerLoginStart') {
        return Promise.resolve(Response.json({
          authorizeUrl: 'https://relay.example.test/__liveshare/auth/start?state=s1',
          state: 's1',
          messageOrigin: RELAY,
          expiresAt: options.expiresAt ?? '2099-01-01T00:00:00Z',
        }))
      }
      if (input === 'api/liveshare.ownerLoginRedeem') {
        if (options.redeem !== undefined) {
          const body = typeof _init?.body === 'string'
            ? JSON.parse(_init.body) as { readonly code?: string; readonly state?: string }
            : {}
          return Promise.resolve(options.redeem(body.code ?? '', body.state ?? ''))
        }
        identity = { state: 'verified', relay: RELAY, displayName: '许翰翔' }
        return Promise.resolve(Response.json(identity))
      }
      if (input === 'api/liveshare.ownerLoginCancel') return Promise.resolve(Response.json({ ok: true }))
      throw new Error(`Unexpected request: ${input}`)
    })
    vi.stubGlobal('fetch', fetcher)
    await act(async () => {
      render(<LiveshareShareDialog
        sessionId={'session' as SessionId}
        sessionTitle="liveshare-verify-ok check"
        defaultRelay={RELAY}
        shares={host.shares}
        onClose={() => {}}
        t={translate}
      />)
    })
    /** The body this page submitted to redeem a code, when it submitted one. */
    const redeemed = (): Record<string, unknown> | undefined => {
      const call = fetcher.mock.calls.find(([input]) => input === 'api/liveshare.ownerLoginRedeem')
      const body = call?.[1]?.body
      return typeof body !== 'string'
        ? undefined
        : JSON.parse(body) as Record<string, unknown>
    }
    return { fetcher, host, popup, open, redeemed, intervals }
  }

  /**
   * Deliver one window message the way the Relay's sign-in page would.
   * @param options - Where the message says it came from, and what it carries.
   */
  function deliverMessage(options: {
    readonly origin: string
    readonly source: unknown
    readonly data: unknown
  }): void {
    const event = new MessageEvent('message', { data: options.data, origin: options.origin })
    Object.defineProperty(event, 'source', { value: options.source })
    act(() => { window.dispatchEvent(event) })
  }

  it('[P1] verifies the owner through the Relay popup, and submits only the code it handed back', async () => {
    const { popup, open, redeemed } = await showLoginDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    // The window is reserved inside the gesture, then navigated to exactly the sign-in the host named.
    await screen.findByText('Finish signing in in the window that opened.')
    expect(open).toHaveBeenCalledWith('', 'liveshare-owner-login', 'popup=yes,width=520,height=720')
    expect(popup.location.href).toBe('https://relay.example.test/__liveshare/auth/start?state=s1')
    // A message from another origin and another window is not this attempt's answer: it is dropped,
    // nothing is submitted, and the dialog keeps waiting.
    deliverMessage({
      origin: 'https://evil.example.test',
      source: popup,
      data: { type: 'liveshare-auth-code', code: 'stolen', state: 's1' },
    })
    deliverMessage({
      origin: RELAY,
      source: {},
      data: { type: 'liveshare-auth-code', code: 'stolen', state: 's1' },
    })
    deliverMessage({
      origin: RELAY,
      source: popup,
      data: { type: 'liveshare-auth-code', code: 'stolen', state: 'stale' },
    })
    expect(redeemed()).toBeUndefined()
    expect(screen.getByText('Finish signing in in the window that opened.')).toBeDefined()
    // The popup's own message for the state the host minted is submitted, with its state, and the
    // sign-in page is acknowledged on the origin the host bound.
    deliverMessage({
      origin: RELAY,
      source: popup,
      data: { type: 'liveshare-auth-code', code: 'one-time-code', state: 's1' },
    })
    await vi.waitFor(() => { expect(redeemed()).toEqual({ code: 'one-time-code', state: 's1' }) })
    expect(popup.postMessage).toHaveBeenCalledWith(
      { type: 'liveshare-auth-ack', state: 's1' }, RELAY,
    )
    // What the row states afterwards is the host's own answer, read back rather than assumed from the
    // popup's message.
    expect(await screen.findByText('许翰翔')).toBeDefined()
  })

  it('[P1] lets a verified owner verify again, and never re-issues a credential on its own', async () => {
    const { fetcher, popup, open } = await showLoginDialog({
      state: 'verified', relay: RELAY, displayName: '许翰翔',
    })
    // A verified owner keeps the credential in force and is not signed in again behind their back.
    expect(await screen.findByText('许翰翔')).toBeDefined()
    expect(fetcher.mock.calls.some(([input]) => input === 'api/liveshare.ownerLoginStart')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    // The same transaction an unverified owner gets, and the row still states the identity in force
    // until the host redeems the new credential.
    await screen.findByText('Finish signing in in the window that opened.')
    expect(open).toHaveBeenCalledOnce()
    expect(popup.location.href).toBe('https://relay.example.test/__liveshare/auth/start?state=s1')
    expect(screen.getByText('许翰翔')).toBeDefined()
  })

  it('states a verification window the browser refused to open', async () => {
    const { open } = await showLoginDialog(undefined, { noPopup: true })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent', en['dialog.identity.loginBlocked'],
    )
    expect(open).toHaveBeenCalledOnce()
  })

  it.each([
    ['mismatch', 'dialog.identity.loginMismatch', () => new Response(
      JSON.stringify({ error: 'owner-login-mismatch' }), { status: 403 })],
    ['replayed', 'dialog.identity.loginReplayed', () => new Response(
      JSON.stringify({ error: 'owner-login-replayed' }), { status: 409 })],
    ['failed', 'dialog.identity.loginFailed', () => Response.json({ state: 'unverified', relay: RELAY })],
    ['unavailable', 'dialog.identity.loginUnavailable', () => Promise.reject(new Error('offline'))],
  ] as const)('states a %s verification answer', async (_name, copy, redeem) => {
    const { popup } = await showLoginDialog(undefined, { redeem })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText(en['dialog.identity.loginWaiting'])
    deliverMessage({
      origin: RELAY,
      source: popup,
      data: { type: 'liveshare-auth-code', code: 'one-time-code', state: 's1' },
    })

    expect(await screen.findByText(en[copy])).toBeDefined()
  })

  it('states a verification the owner cancelled, and one whose transaction expired', async () => {
    const cancelled = await showLoginDialog(undefined, { interceptInterval: true })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText(en['dialog.identity.loginWaiting'])
    cancelled.popup.closed = true
    for (const fire of cancelled.intervals) fire()
    expect(await screen.findByText(en['dialog.identity.loginCancelled'])).toBeDefined()
    cleanup()

    const expired = await showLoginDialog(undefined, {
      interceptInterval: true,
      expiresAt: '2000-01-01T00:00:00Z',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText(en['dialog.identity.loginWaiting'])
    for (const fire of expired.intervals) fire()
    expect(await screen.findByText(en['dialog.identity.loginExpired'])).toBeDefined()
  })

  it('[P1] both locales define the same copy and the Chinese flow renders it', async () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    const zhTranslate: LiveshareShareDialogProps['t'] = (key, params) => {
      let result: string = (zh as Readonly<Record<string, string>>)[key] ?? key
      for (const [name, value] of Object.entries(params ?? {})) result = result.replace(`{${name}}`, String(value))
      return result
    }
    const host = ownerSharesDouble()
    await act(async () => {
      render(<LiveshareShareDialog
        sessionId={'session' as SessionId}
        sessionTitle="验收会话"
        defaultRelay={RELAY}
        shares={host.shares}
        onClose={() => {}}
        t={zhTranslate}
      />)
    })
    expect(screen.getByText('分享会话')).toBeDefined()
    // The dialog states the tier it will grant, not a fixed description of what a share shows.
    expect(screen.getByText(/^仅可查看：/u)).toBeDefined()
    expect(document.body.textContent).not.toContain('历史消息、工具输出、文件路径与附件')
    expect(screen.getByRole('button', { name: '创建分享' })).toBeDefined()
  })

  it('[P1] opens global share management as a separate owner flow', async () => {
    const onManage = vi.fn()
    await showDialog(200, false, () => {}, existing, onManage)
    fireEvent.click(screen.getByRole('button', { name: 'Manage shares' }))
    expect(onManage).toHaveBeenCalledOnce()
  })

  it('[P1] names the Session this dialog shares', async () => {
    await showDialog(200, false)
    expect(document.body.textContent).toContain('Acceptance session')
  })

  it('[P1] offers the session permission and still searches nobody', async () => {
    const host = await showDialog(200, false)
    expect(document.body.textContent).not.toContain('Only people I approve')
    const permission = screen.getByRole('tablist', { name: 'Session permission' })
    expect(within(permission).getAllByRole('tab').map(tab => tab.textContent))
      .toEqual(['Read only', 'Workspace write'])
    expect(screen.getByRole('switch', { name: 'Allow viewers to fork the session' })).toBeDefined()
    // No share-management call searches people: new shares are organization links.
    expect(host.calls.some(call => call.method.toLowerCase().includes('search'))).toBe(false)
  })

  it('[P1] shows the owner avatar with its name, and the name alone without one', async () => {
    await showDialog(200, false, () => {}, existing, undefined, {
      state: 'verified',
      relay: RELAY,
      displayName: '许翰翔',
      avatarUrl: 'https://avatar.example.test/owner.png',
    })
    expect(await screen.findByText('许翰翔')).toBeDefined()
    expect(document.querySelector('img')?.getAttribute('src')).toBe('https://avatar.example.test/owner.png')

    cleanup()
    await showDialog(200, false, () => {}, existing, undefined, {
      state: 'verified', relay: RELAY, displayName: '许翰翔',
    })
    expect(await screen.findByText('许翰翔')).toBeDefined()
    expect(document.querySelector('img')).toBeNull()
  })

  it('[P1] states the verified owner identity and its expiry before creating', async () => {
    await showDialog(200, false, () => {}, existing, undefined, {
      state: 'verified',
      relay: RELAY,
      displayName: '许翰翔',
      subjectId: 'feishu:tenant:ou_9f2c4d',
      expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      renewed: true,
    })
    expect(await screen.findByText('许翰翔')).toBeDefined()
    // The credential detail is a tooltip on the name rather than a stacked line in the panel.
    expect(screen.getByText('许翰翔').getAttribute('title')).toContain('Valid until ')
    expect(screen.getByRole('button', { name: 'Create share' })).toHaveProperty('disabled', false)
  })

  it('[P1] refuses to create a share on an expired sign-in and points at the login path', async () => {
    await showDialog(200, false, () => {}, existing, undefined, {
      state: 'expired', relay: RELAY, subjectId: 'feishu:tenant:ou_9f2c4d',
    })
    expect(await screen.findByText('Your sign-in has expired. Sign in again before creating a share.')).toBeDefined()
    const create = screen.getByRole('button', { name: 'Create share' })
    expect(create).toHaveProperty('disabled', true)
    // The disabled action states the same reason the row does, in the identity's own words.
    expect(create.getAttribute('title')).toBe('Your sign-in has expired. Sign in again before creating a share.')
    // The control starts the host's own transaction rather than naming a Relay entry from here.
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDefined()
  })

  it('[P1] refuses a status that belongs to another Relay', async () => {
    await showDialog(200, false, () => {}, existing, undefined, {
      state: 'verified',
      relay: 'https://other.example.test',
      displayName: '许翰翔',
    })
    expect(await screen.findByText(
      'The current sign-in belongs to another Relay address. Sign in again on this address.',
    )).toBeDefined()
    expect(screen.getByRole('button', { name: 'Create share' })).toHaveProperty('disabled', true)
  })

  it('[P1] labels a verified subject that has no display name from the identity itself', async () => {
    await showDialog(200, false, () => {}, existing, undefined, {
      state: 'verified', relay: RELAY, subjectId: 'feishu:tenant:ou_9f2c4d',
    })
    expect(await screen.findByText('ou_9f2c4d')).toBeDefined()
    // The signed-in viewer's own name is not pasted onto the share's owner.
    expect(document.body.textContent).not.toContain('Shared by')
  })

  it('states the identity as unread until the answer for the address in force lands', async () => {
    const pending = Promise.withResolvers<OwnerIdentityStatus>()
    await showDialog(200, false, () => {}, existing, undefined, undefined, pending.promise)
    expect(await screen.findByText(
      'Sign-in status is unavailable right now. Try again later; no share is created before you sign in.',
    )).toBeDefined()
    // Nothing may submit on an unread status, and the handler refuses even if the button is reached.
    expect(screen.getByRole('button', { name: 'Create share' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
    // The verified answer replaces it for the same address; the row never kept a status silently.
    await act(async () => {
      pending.resolve({ state: 'verified', relay: RELAY, displayName: '许翰翔' })
    })
    expect(await screen.findByText('许翰翔')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Create share' })).toHaveProperty('disabled', false)
  })

  it('[P1] asks for a Relay upgrade instead of creating an anonymous share', async () => {
    await showDialog(200, false, () => {}, existing, undefined, {
      state: 'relay-unsupported', relay: RELAY,
    })
    expect(await screen.findByText(
      'The Relay at this address does not verify identities yet. Upgrade it before creating a share; this page will not create an anonymous one.',
    )).toBeDefined()
    expect(screen.getByRole('button', { name: 'Create share' })).toHaveProperty('disabled', true)
    // Verification cannot succeed against a Relay that does not support it, so no such call to action.
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull()
  })

  it('[P1] submits a share only under a verified identity', async () => {
    const verified = await showDialog(200, false)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create share' })) })
    expect(shareCreates(verified)).toBe(1)

    // Every other state refuses in the page as well as in the host: no request leaves the dialog.
    for (const identity of [
      { state: 'unknown', relay: RELAY },
      { state: 'unverified', relay: RELAY },
      { state: 'relay-unsupported', relay: RELAY },
    ]) {
      const host = await showDialog(200, false, () => {}, existing, undefined, identity as never)
      const create = screen.getByRole('button', { name: 'Create share' })
      expect(create).toHaveProperty('disabled', true)
      await act(async () => { fireEvent.click(create) })
      expect(shareCreates(host)).toBe(0)
      cleanup()
    }
  })

  it('[P1] opens the sign-in the host minted, never this page\'s own address', async () => {
    history.replaceState(null, '', '/session?shareId=s1&ownerStartupToken=secret#/tab')
    try {
      const { open, popup } = await showLoginDialog()
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
      await screen.findByText('Finish signing in in the window that opened.')
      // The window this page reserved carries nothing of its own, and the sign-in it navigates to is
      // the one the host named: neither this page's address, its parameters, nor an Owner startup
      // token travels to the Relay.
      expect(open.mock.calls[0]?.[0]).toBe('')
      expect(popup.location.href).toBe('https://relay.example.test/__liveshare/auth/start?state=s1')
      expect(popup.location.href).not.toContain('ownerStartupToken')
      expect(popup.location.href).not.toContain('secret')
      expect(popup.location.href).not.toContain('shareId')
      popup.close()
    } finally {
      history.replaceState(null, '', '/')
    }
  })

  it('re-reads the host identity when the page is focused again after a login round trip', async () => {
    const host = await showDialog(200, false)
    const before = identityReads(host)
    fireEvent.focus(window)
    await vi.waitFor(() => { expect(identityReads(host)).toBeGreaterThan(before) })
  })

  it('creates an open share by default without recipients', async () => {
    const host = await showDialog(200, false)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create share' })) })
    const payload = shareRequest(host)
    if (payload === undefined) throw new Error('Expected the share request')
    expect(payload.sessionMode).toBe('view')
    for (const gone of ['recipients', 'mode', 'permission']) {
      expect(payload, gone).not.toHaveProperty(gone)
    }
  })

  it('sends the session permission with the share, read-only until the owner widens it', async () => {
    const host = await showDialog(200, false, () => {}, existing, undefined, undefined, undefined,
      { sessionMode: 'view' })
    // The field always travels, so a Host that cannot store it can say so instead of the page dropping
    // it silently; leaving the selector alone asks for nothing beyond the read-only share.
    expect(selectedMode()).toBe('view')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create share' })) })

    expect(shareRequest(host)?.sessionMode).toBe('view')
    expect(screen.queryByText(/did not report the session permission/u)).toBeNull()
  })

  it('states what the Host stored when the owner picks a wider session permission', async () => {
    cleanup()
    const granted = await showDialog(200, false, () => {}, existing, undefined, undefined, undefined,
      { sessionMode: 'write' })
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Workspace write' }))
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create share' })) })
    expect(shareRequest(granted)).toMatchObject({ sessionMode: 'write' })
    expect(screen.queryByText(/did not report the session permission/u)).toBeNull()

    // A Host that stored another tier than the one asked for did not grant it: the dialog says an
    // upgrade is needed rather than presenting the choice as granted.
    cleanup()
    await showDialog(200, false, () => {}, existing, undefined, undefined, undefined,
      { sessionMode: 'view' })
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Workspace write' }))
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create share' })) })
    expect(screen.getByText(/did not report the session permission/u)).toBeDefined()
  })

  it('[P1] states a refused registration verbatim and withholds creation until it is settled', async () => {
    const refusal = 'https://relay.example.test: this address did not accept this host\'s owner credential '
      + '(relay refused registration status=401)'
    await showDialog(200, false, () => {}, existing, undefined, undefined, undefined, undefined, {
      permission: { ok: false, blocking: true, error: refusal },
    })

    // The Host owns the wording and the severity; this page prints both unchanged.
    expect(await screen.findByText(refusal)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Create share' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Create share' }).getAttribute('title')).toBe(refusal)
    // The next step is on the address row, next to the refusal it answers.
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeDefined()
  })

  it('[P1] keeps creation available when the Relay did not decide the registration', async () => {
    const transient = 'https://relay.example.test: relay answered registration status=500'
    const host = await showDialog(200, false, () => {}, existing, undefined, undefined, undefined, undefined, {
      permission: { ok: false, blocking: false, error: transient },
    })

    expect(await screen.findByText(transient)).toBeDefined()
    // A failure the Relay did not decide keeps the ordinary retry, so the share is still creatable.
    const create = screen.getByRole('button', { name: 'Create share' })
    expect(create).toHaveProperty('disabled', false)
    await act(async () => { fireEvent.click(create) })
    expect(shareCreates(host)).toBe(1)
  })

  it('[P1] withholds creation and verification while the address does not answer', async () => {
    const unreachable = 'https://relay.example.test: ENOTFOUND: getaddrinfo ENOTFOUND relay.example.test'
    await showDialog(200, false, () => {}, existing, undefined, undefined, undefined, undefined, {
      connectivity: { ok: false, httpReachable: false, blocking: true, error: unreachable },
    })

    expect(await screen.findByText(unreachable)).toBeDefined()
    // An address that does not answer cannot be verified on, and its share cannot be created either.
    expect(screen.getByRole('button', { name: 'Sign in again' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Create share' })).toHaveProperty('disabled', true)
  })

  it('[P1] describes the chosen tier and nothing else about access', async () => {
    // The read-only sentence belongs to the view tier, so a wider share must not carry it, and the dialog
    // states no tier-independent description of what a share shows.
    await showDialog(200, false)
    expect(screen.getByText(/Read only: viewers read files/u)).toBeDefined()
    expect(document.body.textContent).not.toContain('earlier messages, tool output, file paths, and attachments')
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Workspace write' }))
    })
    expect(screen.getByText(/Workspace write: the viewer works in a bounded writable sandbox/u)).toBeDefined()
    expect(screen.queryByText(/cannot send messages or run tools/u)).toBeNull()
  })

  it('[P1] offers only the never-expiring lifetime and omits it from creation', async () => {
    const host = await showDialog(200, false)
    expect(screen.queryByText('In 24 hours')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create share' })) })
    expect(shareRequest(host)).not.toHaveProperty('ttlMinutes')
  })

  it('restores an existing session share and keeps its link available after clipboard denial', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    await showDialog()
    expect(screen.queryByRole('button', { name: 'Create share' })).toBeNull()
    const primaryCopy = screen.getAllByRole('button', { name: 'Copy link' }).filter(button => button.closest('details') === null)
    expect(primaryCopy).toHaveLength(1)
    await act(async () => { fireEvent.click(primaryCopy[0]!) })
    expect(screen.getByRole('alert').textContent).toContain('copy it manually')
    expect(screen.getByRole('textbox', { name: 'Share link' })).toHaveProperty('value', existing.link)
    expect(screen.getByText('Selected people confirmed: 1.')).toBeDefined()
    // A share that still carries the retired scope keeps it, and says so: nothing widens it to the
    // open link.
    expect(screen.getByText('Deployment-authorized identities: 1. Selection is not the only access rule.')).toBeDefined()
  })

  it('honestly marks a legacy share whose access summary was never persisted', async () => {
    await showDialog(200, true, () => {}, { ...existing, access: undefined })
    expect(screen.getByText('Access details for this share are unavailable. Existing permissions are unchanged.')).toBeDefined()
  })

  it('traps dialog focus and closes candidates before the modal on Escape', async () => {
    const onClose = vi.fn()
    await showDialog(200, false, onClose)
    // Focus lands on the panel's first control: the help affordance beside the title.
    const help = screen.getByRole('button', { name: /Shares this Session only/u })
    expect(document.activeElement).toBe(help)
    const focusable = enabledFocusables()
    expect(document.activeElement).toBe(focusable[0])
    fireEvent.keyDown(help, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(focusable.at(-1))
    // The dialog keeps the session permission and nothing that searches people.
    const permission = screen.getByRole('tablist', { name: 'Session permission' })
    expect(permission.querySelectorAll('[role="tab"]').length).toBeGreaterThan(0)
    expect(screen.queryByPlaceholderText('Search colleagues by name')).toBeNull()
    fireEvent.keyDown(permission, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('[P1] wraps Tab in both directions and keeps the dialog body scrollable', async () => {
    await showDialog(200, false)
    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector(`.${css.panel}`)).not.toBeNull()
    expect(dialog.className).toContain(css.modal)

    const focusable = enabledFocusables()
    const first = focusable[0]!
    const last = focusable.at(-1)!
    expect(document.activeElement).toBe(first)

    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('ignores a repeated create click while the first share is being prepared', async () => {
    const host = await showDialog(200, false)
    const create = screen.getByRole('button', { name: 'Create share' })
    await act(async () => { fireEvent.click(create); fireEvent.click(create) })
    expect(shareCreates(host)).toBe(1)
    expect(probes(host)).toBe(1)
  })
})

/** One offer a plugin makes to this host's viewers. */
const OFFERED = [{ plugin: 'mekGit', readable: ['mekGit/getGraph'], writable: ['mekGit/commit'] }]

/** An access record every endpoint of the open link uses. */
const OPEN_ACCESS = {
  mode: 'open',
  selected: [],
  deploymentAllowedSubjectIds: [],
  shareAllowedSubjectIds: [],
  broadenedByDeploymentSubjects: false,
  identityKeyAcl: true,
} as const

/**
 * Render the dialog over a Host whose record-management answers this case scripts.
 * @param control - Rows the Host lists, the offer it reports, and the methods this case replaces.
 * @returns The scripted Remote and its recorded calls.
 */
async function showControlled(control: {
  readonly rows?: readonly Record<string, unknown>[]
  readonly defaultRelay?: string
  readonly relayEffective?: string
  readonly identity?: OwnerIdentityStatus
  readonly onClose?: () => void
  readonly overrides?: OwnerSharesOverrides
} = {}): Promise<OwnerSharesDouble> {
  const effective = control.relayEffective ?? control.defaultRelay ?? RELAY
  const host = ownerSharesDouble({
    list: async () => accepted({ shares: (control.rows ?? []) as never }),
    relay: async () => accepted({ effective }),
    identity: async () => accepted(control.identity ?? { state: 'verified', relay: effective, displayName: '许翰翔' }),
    ...control.overrides,
  })
  await act(async () => {
    render(<LiveshareShareDialog
      sessionId={'session' as SessionId}
      sessionTitle="Acceptance session"
      defaultRelay={control.defaultRelay ?? RELAY}
      shares={host.shares}
      onClose={control.onClose ?? (() => {})}
      t={translate}
    />)
  })
  return host
}

/** The identity a Host reports per Relay address this case saved. */
function identityFor(relay: string) {
  return async (request: { readonly relay?: string }) => accepted(
    request.relay === relay
      ? { state: 'verified' as const, relay, displayName: '许翰翔' }
      : { state: 'unverified' as const, relay: request.relay ?? '' },
  )
}

describe('Liveshare dialog stored-record branches', () => {
  it('saves the narrowest endpoint tier as no endpoint at all', async () => {
    const setCapabilities = vi.fn(async () => accepted({ shareId: 'existing', viewerCapabilities: [] }))
    await showControlled({
      rows: [{ ...existing, viewerCapabilities: OFFERED }],
      overrides: {
        capabilities: async () => accepted({ capabilities: OFFERED }),
        setCapabilities,
      },
    })

    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Unavailable' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })) })
    expect(setCapabilities).toHaveBeenCalledWith({ shareId: 'existing', capabilities: [] })
  })

  it('saves a fork change for a record that names no session permission', async () => {
    const updatePermissions = vi.fn(async (): Promise<RemoteResult<SharePermissions>> =>
      accepted({ shareId: 'existing', sessionMode: 'view', allowsFork: true }))
    const setCapabilities = vi.fn(async () => accepted({ shareId: 'existing', viewerCapabilities: [] }))
    let calls = 0
    await showControlled({
      rows: [{ ...existing, sessionMode: undefined }],
      overrides: {
        list: async () => {
          calls += 1
          return accepted({ shares: [calls === 1
            ? { ...existing, sessionMode: undefined, allowsFork: false }
            : {
              ...existing, sessionMode: undefined, allowsFork: true,
              link: 'https://relay.example.test/?shareId=renamed',
            }] as never })
        },
        updatePermissions,
        setCapabilities,
      },
    })

    expect(await screen.findByText(en['dialog.permissions.modeUnsupported'])).toBeDefined()
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Allow viewers to fork the session' }))
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })) })
    // The Host named no permission for this record, so only the field this page holds travels.
    expect(updatePermissions).toHaveBeenCalledWith({ shareId: 'existing', allowsFork: true })
    expect(setCapabilities).not.toHaveBeenCalled()
    // The confirming read names a renamed link; the link this dialog already showed stays.
    expect(screen.getByRole('textbox', { name: 'Share link' })).toHaveProperty('value', existing.link)
  })

  it('clears the lifetime of an existing share', async () => {
    const updatePermissions = vi.fn(async (): Promise<RemoteResult<SharePermissions>> =>
      accepted({ shareId: 'existing', sessionMode: 'view', allowsFork: false }))
    await showControlled({
      rows: [{ ...existing, expiresAt: '2026-10-30T00:00:00.000Z' }],
      overrides: {
        updatePermissions,
        list: async () => accepted({ shares: [{ ...existing, expiresAt: '2026-10-30T00:00:00.000Z' }] as never }),
      },
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Never expires' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })) })
    expect(updatePermissions).toHaveBeenCalledWith({
      shareId: 'existing', sessionMode: 'view', allowsFork: false, ttlMinutes: null,
    })
  })

  it('states a refused permission save and ignores a second click while it runs', async () => {
    const pending = Promise.withResolvers<RemoteResult<SharePermissions>>()
    const updatePermissions = vi.fn(() => pending.promise)
    await showControlled({
      rows: [existing],
      overrides: { updatePermissions },
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Allow viewers to fork the session' }))
    })
    const save = screen.getByRole('button', { name: 'Save changes' })
    await act(async () => { fireEvent.click(save) })
    await act(async () => { fireEvent.click(save) })
    expect(updatePermissions).toHaveBeenCalledTimes(1)
    pending.resolve(refused('gateway/internal', {}))
    await act(async () => { await pending.promise })
    expect(screen.getByRole('alert').textContent).toBe(en['dialog.permissions.failed'])
  })

  it('states a half-saved permission save and adopts what the Host stored', async () => {
    let calls = 0
    const updatePermissions = vi.fn(async (): Promise<RemoteResult<SharePermissions>> =>
      accepted({ shareId: 'existing', sessionMode: 'view', allowsFork: true }))
    const setCapabilities = vi.fn(async () => refused('gateway/internal', {}))
    await showControlled({
      rows: [{ ...existing, viewerCapabilities: OFFERED }],
      overrides: {
        capabilities: async () => accepted({ capabilities: OFFERED }),
        list: async () => {
          calls += 1
          return accepted({ shares: [calls === 1
            ? { ...existing, viewerCapabilities: OFFERED }
            : { ...existing, viewerCapabilities: OFFERED, allowsFork: true }] as never })
        },
        updatePermissions,
        setCapabilities,
      },
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Allow viewers to fork the session' }))
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })) })
    expect(screen.getByRole('alert').textContent).toBe(en['dialog.permissions.partial'])
    // The permission write landed, and the Host's own record is what the switch states afterwards.
    expect(screen.getByRole('switch', { name: 'Allow viewers to fork the session' }).getAttribute('aria-checked'))
      .toBe('true')
  })

  it('saves without a confirming read the Host refused or could not answer', async () => {
    for (const answer of [
      async () => refused('gateway/internal', {}),
      async () => { throw new Error('host lost') },
    ]) {
      let calls = 0
      await showControlled({
        rows: [existing],
        overrides: {
          updatePermissions: async (): Promise<RemoteResult<SharePermissions>> =>
            accepted({ shareId: 'existing', sessionMode: 'view', allowsFork: true }),
          list: async () => {
            calls += 1
            return calls === 1 ? accepted({ shares: [existing] as never }) : answer()
          },
        },
      })
      await act(async () => {
        fireEvent.click(screen.getByRole('switch', { name: 'Allow viewers to fork the session' }))
      })
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })) })
      expect(screen.getByText(en['dialog.permissions.saved'])).toBeDefined()
      expect(screen.queryByRole('alert')).toBeNull()
      cleanup()
    }
  })

  it('keeps its create form when the Host refuses the list', async () => {
    await showControlled({ overrides: { list: async () => refused('gateway/internal', {}) } })

    // Nothing was listed, and no error is stated: the polling read keeps the last known list.
    expect(screen.queryByRole('textbox', { name: 'Share link' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Create share' })).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('hides the endpoint control when the Host cannot report its offer', async () => {
    await showControlled({
      rows: [existing],
      overrides: { capabilities: async () => refused('gateway/internal', {}) },
    })

    expect(screen.queryByRole('tablist', { name: 'Plugin endpoints' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDefined()
  })

  it('states an identity it could not read and retries it on request', async () => {
    const identity = vi.fn(async () => { throw new Error('identity lost') })
    await showControlled({ overrides: { identity } })

    expect(await screen.findByText(en['dialog.identity.unknown'])).toBeDefined()
    const before = identity.mock.calls.length
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })) })
    expect(identity.mock.calls.length).toBeGreaterThan(before)
  })

  it('drops an identity answer that lands after the dialog closed', async () => {
    const pending = Promise.withResolvers<OwnerIdentityStatus>()
    const identity = vi.fn(async () => accepted(await pending.promise))
    await showControlled({ overrides: { identity } })
    cleanup()
    await act(async () => { pending.resolve({ state: 'verified', relay: RELAY, displayName: '许翰翔' }) })
    expect(identity).toHaveBeenCalled()
  })

  it('ignores a focus while the page is hidden', async () => {
    const identity = vi.fn(async () => accepted({ state: 'verified' as const, relay: RELAY, displayName: '许翰翔' }))
    await showControlled({ overrides: { identity } })
    await vi.waitFor(() => { expect(identity).toHaveBeenCalledTimes(1) })
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    try {
      fireEvent.focus(window)
      await Promise.resolve()
      expect(identity).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    }
  })

  it('states an unreachable Relay and lets the owner test again', async () => {
    const testRelay = vi.fn(async () => refused('gateway/internal', {}))
    await showControlled({ overrides: { testRelay } })

    expect(await screen.findByText(en['dialog.hostUnavailable'])).toBeDefined()
    // Re-saving the address is the retry; there is no separate connectivity action.
    expect(screen.queryByRole('button', { name: 'Save and check' })).toBeNull()
  })

  it('states an unreachable Relay with no cause, and one this page could not ask', async () => {
    await showControlled({
      overrides: { testRelay: async () => accepted({ ok: false, httpReachable: false, blocking: false }) },
    })
    expect(await screen.findByText(en['dialog.testFail'])).toBeDefined()
    cleanup()

    await showControlled({
      overrides: { testRelay: async () => { throw new Error('host lost') } },
    })
    expect(await screen.findByText(en['dialog.hostUnavailable'])).toBeDefined()
  })

  it('states a permission check the Host could not answer, and retries it', async () => {
    const testPublish = vi.fn(async () => refused('gateway/internal', {}))
    await showControlled({ overrides: { testPublish } })

    expect(await screen.findByText(en['dialog.hostUnavailable'])).toBeDefined()
    // The permission check follows sign-in automatically; the create action records it in its title.
    expect(screen.getByRole('button', { name: 'Create share' })).toBeDefined()
  })

  it('states a refused registration with and without the Host naming a cause', async () => {
    await showControlled({
      overrides: { testPublish: async () => accepted({ ok: false, blocking: true }) },
    })
    expect(await screen.findByText(en['dialog.permissionFailed'])).toBeDefined()
    cleanup()

    await showControlled({
      overrides: { testPublish: async () => accepted({ ok: false, blocking: false }) },
    })
    expect(await screen.findByText(en['dialog.testWarn'])).toBeDefined()
  })

  it('keeps creation available when the permission check could not reach the Host', async () => {
    await showControlled({
      overrides: { testPublish: async () => { throw new Error('host lost') } },
    })

    expect(await screen.findByText(en['dialog.hostUnavailable'])).toBeDefined()
    expect(screen.getByRole('button', { name: 'Create share' })).toHaveProperty('disabled', false)
  })

  it('ignores a second address save while the first is in flight', async () => {
    const pending = Promise.withResolvers<RemoteResult<OwnerRelayState>>()
    const setRelay = vi.fn(() => pending.promise)
    await showControlled({ overrides: { setRelay } })

    fireEvent.change(screen.getByRole('textbox', { name: 'Share service address' }), {
      target: { value: 'https://relay2.example.test' },
    })
    const input = screen.getByRole('textbox', { name: 'Share service address' })
    await act(async () => { fireEvent.blur(input) })
    await act(async () => { fireEvent.blur(input) })
    expect(setRelay).toHaveBeenCalledTimes(1)
    pending.resolve(accepted({ effective: 'https://relay2.example.test' }))
    await act(async () => { await pending.promise })
  })

  it('distinguishes a refused address from an unreachable Host, and survives a lost one', async () => {
    const cases = [
      [async () => refused('liveshareShares/invalid-relay-url', {}) as RemoteResult<OwnerRelayState>, en['dialog.relayInvalid']],
      [async () => refused('gateway/internal', {}) as RemoteResult<OwnerRelayState>, en['dialog.hostUnavailable']],
      [async () => { throw new Error('host lost') }, en['dialog.hostUnavailable']],
    ] as const
    for (const [answer, copy] of cases) {
      await showControlled({ overrides: { setRelay: answer } })
      fireEvent.change(screen.getByRole('textbox', { name: 'Share service address' }), {
        target: { value: 'https://relay2.example.test' },
      })
      await saveAddress()
      expect(screen.getByRole('alert').textContent).toBe(copy)
      cleanup()
    }
  })

  it('saves the address on Enter', async () => {
    const setRelay = vi.fn(async () => accepted({ effective: RELAY }))
    await showControlled({ overrides: { setRelay } })

    const input = screen.getByRole('textbox', { name: 'Share service address' })
    fireEvent.change(input, { target: { value: 'https://relay2.example.test' } })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(setRelay).toHaveBeenCalledWith({ relayUrl: 'https://relay2.example.test' })
  })

  it('rechecks the address before creating when the Host names one after mount', async () => {
    // The address the Host names arrives after the dialog mounted, so saving it starts the flow with
    // the address the render before it held: connectivity stays idle until the create action asks.
    const host = await showControlled({
      defaultRelay: '',
      relayEffective: '',
      identity: { state: 'unverified', relay: '' },
      overrides: {
        relay: async () => accepted({}),
        setRelay: async () => accepted({ effective: 'https://relay2.example.test' }),
        identity: identityFor('https://relay2.example.test'),
        testRelay: async () => refused('gateway/internal', {}),
      },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Share service address' }), {
      target: { value: 'https://relay2.example.test' },
    })
    await saveAddress()

    const create = screen.getByRole('button', { name: 'Create share' }) as HTMLButtonElement
    await vi.waitFor(() => { expect(create.disabled).toBe(false) })
    await act(async () => { fireEvent.click(create) })
    // The address did not answer when the action re-checked it, so nothing was created.
    expect(host.calls.some(call => call.method === 'create')).toBe(false)
    expect(screen.getByText(en['dialog.hostUnavailable'])).toBeDefined()
  })

  it('withholds creation when the permission check refuses after the address answers', async () => {
    const host = await showControlled({
      defaultRelay: '',
      relayEffective: '',
      identity: { state: 'unverified', relay: '' },
      overrides: {
        relay: async () => accepted({}),
        setRelay: async () => accepted({ effective: 'https://relay2.example.test' }),
        identity: identityFor('https://relay2.example.test'),
        testPublish: async () => accepted({ ok: false, blocking: true }),
      },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Share service address' }), {
      target: { value: 'https://relay2.example.test' },
    })
    await saveAddress()
    const create = screen.getByRole('button', { name: 'Create share' })
    await vi.waitFor(() => { expect(create).toHaveProperty('disabled', false) })
    await act(async () => { fireEvent.click(create) })

    expect(host.calls.some(call => call.method === 'create')).toBe(false)
    expect(screen.getByText(en['dialog.permissionFailed'])).toBeDefined()
  })

  it('states a refused create and one the Host could not answer', async () => {
    for (const create of [
      async () => refused('gateway/internal', {}),
      async () => { throw new Error('host lost') },
    ]) {
      await showControlled({ overrides: { create } })
      const button = screen.getByRole('button', { name: 'Create share' })
      await vi.waitFor(() => { expect(button).toHaveProperty('disabled', false) })
      await act(async () => { fireEvent.click(button) })
      expect(screen.getByRole('alert').textContent).toBe(en['dialog.hostUnavailable'])
      cleanup()
    }
  })

  it('adopts a created share whose Host reported no session permission', async () => {
    await showControlled({
      overrides: {
        create: async () => {
          // A Host that predates the permission field answers without it; the dialog must state that
          // rather than assume the narrowest tier.
          const answer: CreatedShare = {
            link: existing.link, shareId: 'existing', sessionId: 'session', sessionMode: 'view', access: OPEN_ACCESS,
          }
          delete (answer as { sessionMode?: CreatedShare['sessionMode'] }).sessionMode
          return accepted(answer)
        },
      },
    })

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create share' })) })
    // The Link exists, and the permission field the Host never reported is stated as unset.
    expect(await screen.findByText(en['dialog.permissions.modeUnsupported'])).toBeDefined()
  })

  it('does not close the dialog while a create is in flight', async () => {
    const pending = Promise.withResolvers<RemoteResult<CreatedShare>>()
    const onClose = vi.fn()
    await showControlled({ onClose, overrides: { create: () => pending.promise } })

    const create = screen.getByRole('button', { name: 'Create share' })
    await vi.waitFor(() => { expect(create).toHaveProperty('disabled', false) })
    await act(async () => { fireEvent.click(create) })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    pending.resolve(accepted({
      link: existing.link, shareId: 'existing', sessionId: 'session', sessionMode: 'view', access: OPEN_ACCESS,
    }))
    await act(async () => { await pending.promise })
  })

  it('states a copied link the clipboard accepted', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    await showControlled({ rows: [existing] })

    const copy = screen.getAllByRole('button', { name: 'Copy link' })
      .find(button => button.closest('details') === null)
    if (copy === undefined) throw new Error('the dialog offers no primary copy control')
    await act(async () => { fireEvent.click(copy) })
    expect(screen.getByRole('button', { name: 'Copied' })).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('adopts the listed link when a created share answered with none', async () => {
    let calls = 0
    await showControlled({
      overrides: {
        create: async () => accepted({
          link: '', shareId: 'existing', sessionId: 'session', sessionMode: 'view', access: OPEN_ACCESS,
        }),
        list: async () => {
          calls += 1
          return accepted({ shares: (calls === 1 ? [] : [{ ...existing }]) as never })
        },
      },
    })

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create share' })) })
    // The Host's own record supplies the link its create answer left empty.
    expect(await screen.findByRole('textbox', { name: 'Share link' })).toHaveProperty('value', existing.link)
  })

  it('keeps the dialog default when the Host refuses to report its Relay', async () => {
    await showControlled({
      overrides: { relay: async () => refused('gateway/internal', {}) },
    })

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Create share' })).toBeDefined()
    expect(screen.getByRole('textbox', { name: 'Share service address' })).toHaveProperty('value', RELAY)
  })

  it('drops a rejected identity answer that lands after the dialog closed', async () => {
    const pending = Promise.withResolvers<RemoteResult<OwnerIdentityStatus>>()
    const identity = vi.fn(() => pending.promise)
    await showControlled({ overrides: { identity } })
    cleanup()
    pending.reject(new Error('identity lost'))
    await act(async () => { await pending.promise.catch(() => undefined) })
    expect(identity).toHaveBeenCalled()
  })

  it('states a half-saved permission save even when the re-read names another share', async () => {
    let calls = 0
    await showControlled({
      rows: [{ ...existing, viewerCapabilities: OFFERED }],
      overrides: {
        capabilities: async () => accepted({ capabilities: OFFERED }),
        updatePermissions: async (): Promise<RemoteResult<SharePermissions>> =>
          accepted({ shareId: 'existing', sessionMode: 'view', allowsFork: true }),
        setCapabilities: async () => refused('gateway/internal', {}),
        list: async () => {
          calls += 1
          return accepted({ shares: [calls === 1
            ? { ...existing, viewerCapabilities: OFFERED }
            : { ...existing, shareId: 'another', viewerCapabilities: OFFERED }] as never })
        },
      },
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Allow viewers to fork the session' }))
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })) })
    expect(screen.getByRole('alert').textContent).toBe(en['dialog.permissions.partial'])
  })

  it('states an expiry without claiming a renewal', async () => {
    await showControlled({
      identity: {
        state: 'verified', relay: RELAY, displayName: '许翰翔',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    })

    expect(await screen.findByText('许翰翔')).toBeDefined()
    const title = screen.getByText('许翰翔').getAttribute('title') ?? ''
    expect(title).toContain('Valid until ')
    expect(title).not.toContain(en['dialog.identity.renewed'])
  })

  it('lets the owner choose the fork switch before the share exists', async () => {
    await showControlled()

    const fork = screen.getByRole('switch', { name: 'Allow viewers to fork the session' })
    await act(async () => { fireEvent.click(fork) })
    expect(fork.getAttribute('aria-checked')).toBe('true')
  })

  it('selects the whole share link when its field is focused', async () => {
    await showControlled({ rows: [existing] })

    const link = screen.getByRole('textbox', { name: 'Share link' }) as HTMLInputElement
    fireEvent.focus(link)
    expect(link.selectionStart).toBe(0)
    expect(link.selectionEnd).toBe(existing.link.length)
  })
})
