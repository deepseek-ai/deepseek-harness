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
  shareId: 'existing', sessionIds: ['session'], sessionTitle: 'Acceptance session',
  link: 'https://relay.example.test/?shareId=existing', createdAt: '2026-09-05T00:00:00Z', online: true,
  sessionMode: 'view',
  allowsFork: false,
  viewerPlugins: [],
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
      sessionIds: ['session'],
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

/** The Relay authorization address the host mints for a sign-in. */
const SIGN_IN_ADDRESS = 'https://relay.example.test/__liveshare/owner-authorize?state=s1&mode=poll'

describe('Liveshare dialog product acceptance', () => {
  /**
   * Render the real dialog against a host that must verify its owner first, with the sign-in routes
   * and the browser window substituted.
   * @param initialIdentity - What the host first reports about the owner.
   * @returns The fetch double for the sign-in routes, the scripted Remote, the window, and the timers.
   */
  async function showLoginDialog(
    initialIdentity: OwnerIdentityStatus = { state: 'unverified', relay: RELAY },
    options: {
      /** Leave the page without a window, as the Desktop shell does. */
      readonly noWindow?: boolean
      /** Deadline the host names for the transaction. */
      readonly expiresAt?: string
      /** Answer one status POST; the default reports the transaction as pending. */
      readonly status?: () => Response | Promise<Response>
    } = {},
  ) {
    const intervals: (() => void)[] = []
    vi.stubGlobal('setInterval', (callback: () => void) => { intervals.push(callback); return 0 })
    const browserWindow = {
      location: { href: '' },
      close: vi.fn(() => {}),
    }
    const open = vi.fn((_url: string, _name: string, _features?: string) =>
      options.noWindow === true ? null : browserWindow)
    vi.stubGlobal('open', open)
    /** What the host reports about the owner; a verified settlement is what changes it. */
    let identity: OwnerIdentityStatus = initialIdentity
    const host = ownerSharesDouble({
      list: async () => accepted({ shares: [] }),
      relay: async () => accepted({ effective: RELAY }),
      identity: async () => accepted(identity),
      testRelay: async () => accepted({ ok: true, httpReachable: true, blocking: false }),
      testPublish: async () => accepted({ ok: true, blocking: false }),
    })
    const fetcher = vi.fn(async (input: string, _init?: RequestInit) => {
      if (input === 'api/liveshare.ownerLoginStart') {
        return Response.json({
          authorizeUrl: SIGN_IN_ADDRESS,
          state: 's1',
          expiresAt: options.expiresAt ?? '2099-01-01T00:00:00Z',
        })
      }
      if (input === 'api/liveshare.ownerLoginStatus') {
        const answer = await (options.status?.() ?? Response.json({ status: 'pending' }))
        const body = await answer.clone().json() as { readonly status?: string; readonly identity?: OwnerIdentityStatus }
        if (body.status === 'verified' && body.identity !== undefined) identity = body.identity
        return answer
      }
      if (input === 'api/liveshare.ownerLoginCancel') return Response.json({ ok: true })
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
    /** Fire every timer the attempt armed, and let the answers it asked for land. */
    const tick = async (): Promise<void> => {
      await act(async () => { for (const fire of intervals) fire() })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    }
    return { fetcher, host, browserWindow, open, tick }
  }

  /** A status answer that settles the transaction with this verified owner. */
  const settledAs = (displayName: string) => () => Response.json({
    status: 'verified', identity: { state: 'verified', relay: RELAY, displayName },
  })

  it('[P1] signs the owner in through a browser and states the identity the host settled', async () => {
    let settled = false
    const { browserWindow, open, tick } = await showLoginDialog(undefined, {
      status: () => settled ? settledAs('许翰翔')() : Response.json({ status: 'pending' }),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText(en['dialog.identity.loginWaiting'])
    // The window is reserved inside the gesture, then navigated to exactly the sign-in the host named.
    expect(open.mock.calls[0]).toEqual(['', '_blank'])
    expect(browserWindow.location.href).toBe(SIGN_IN_ADDRESS)
    expect(screen.getByRole('textbox', { name: 'Sign-in link' })).toHaveProperty('value', SIGN_IN_ADDRESS)
    expect(screen.getByText(en['dialog.identity.loginManual'])).toBeDefined()

    await tick()
    expect(screen.getByRole('textbox', { name: 'Sign-in link' })).toBeDefined()
    settled = true
    await tick()
    // What the row states afterwards is the host's own answer, read back after the settlement.
    expect(await screen.findByText('许翰翔')).toBeDefined()
    expect(screen.queryByRole('textbox', { name: 'Sign-in link' })).toBeNull()
  })

  it('opens the address directly for a page that got no window, and offers it to copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    // The Desktop shell denies this page a window and opens the address in the system browser instead.
    const { open } = await showLoginDialog(undefined, { noWindow: true })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    const field = await screen.findByRole('textbox', { name: 'Sign-in link' })
    expect(open).toHaveBeenCalledWith(SIGN_IN_ADDRESS, '_blank', 'noopener')
    expect(field).toHaveProperty('value', SIGN_IN_ADDRESS)
    await act(async () => { fireEvent.focus(field) })
    expect((field as HTMLInputElement).selectionEnd).toBe(SIGN_IN_ADDRESS.length)

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy link' })) })
    expect(writeText).toHaveBeenCalledWith(SIGN_IN_ADDRESS)
    expect(screen.getByRole('button', { name: 'Copied' })).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not mark a fresh sign-in link as copied after copying the previous one', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    const { fetcher, tick } = await showLoginDialog(undefined, { status: settledAs('Owner') })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Copy link' }))
    await screen.findByRole('button', { name: 'Copied' })
    await tick()

    const next = SIGN_IN_ADDRESS.replace('s1', 's2')
    fetcher.mockResolvedValueOnce(Response.json({ authorizeUrl: next, state: 's2', expiresAt: '2099-01-01T00:00:00Z' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in again' }))
    expect(await screen.findByRole('textbox', { name: 'Sign-in link' })).toHaveProperty('value', next)
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeDefined()
  })

  it('states a copy the clipboard refused on the sign-in address, and keeps the address', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    await showLoginDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByRole('textbox', { name: 'Sign-in link' })

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy link' })) })
    // The share link keeps its own copy control, so the sign-in field states its own answer here.
    expect(screen.getByRole('alert').textContent).toBe(en['dialog.copyFailed'])
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeDefined()
    expect(screen.getByRole('textbox', { name: 'Sign-in link' })).toHaveProperty('value', SIGN_IN_ADDRESS)
  })

  it('[P1] lets a verified owner sign in again, and waits until the host settles that transaction', async () => {
    // The credential already in force is verified, so only this transaction's settlement can end the
    // new attempt: reading the identity alone would call it done before the owner signed in.
    let settled = false
    const { fetcher, browserWindow, tick } = await showLoginDialog(
      { state: 'verified', relay: RELAY, displayName: '许翰翔' },
      { status: () => settled ? settledAs('新账号')() : Response.json({ status: 'pending' }) },
    )
    // A verified owner keeps the credential in force and is not signed in again behind their back.
    expect(await screen.findByText('许翰翔')).toBeDefined()
    expect(fetcher.mock.calls.some(([input]) => input === 'api/liveshare.ownerLoginStart')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    await screen.findByRole('textbox', { name: 'Sign-in link' })
    expect(browserWindow.location.href).toBe(SIGN_IN_ADDRESS)
    await tick()
    // The row still states the identity in force until the host settles the new one.
    expect(screen.getByRole('textbox', { name: 'Sign-in link' })).toBeDefined()
    expect(screen.getByText('许翰翔')).toBeDefined()

    settled = true
    await tick()
    expect(await screen.findByText('新账号')).toBeDefined()
    expect(screen.queryByRole('textbox', { name: 'Sign-in link' })).toBeNull()
  })

  it.each([
    ['mismatch', 'dialog.identity.loginMismatch', 'owner-login-mismatch'],
    ['replayed', 'dialog.identity.loginReplayed', 'owner-login-replayed'],
    ['failed', 'dialog.identity.loginFailed', 'owner-login-failed'],
    ['unavailable', 'dialog.identity.loginUnavailable', 'owner-login-unavailable'],
  ] as const)('states a %s settlement', async (_name, copy, error) => {
    const { tick } = await showLoginDialog(undefined, { status: () => Response.json({ status: 'failed', error }) })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText(en['dialog.identity.loginWaiting'])
    await tick()
    expect(await screen.findByText(en[copy])).toBeDefined()
  })

  it('states a sign-in whose transaction expired', async () => {
    const { tick } = await showLoginDialog(undefined, { expiresAt: '2000-01-01T00:00:00Z' })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText(en['dialog.identity.loginWaiting'])
    await tick()
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
      const { open, browserWindow } = await showLoginDialog()
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
      await screen.findByText(en['dialog.identity.loginWaiting'])
      // The window this page reserved carries nothing of its own, and the sign-in it navigates to is
      // the one the host named: neither this page's address, its parameters, nor an Owner startup
      // token travels to the Relay.
      expect(open.mock.calls[0]?.[0]).toBe('')
      expect(browserWindow.location.href).toBe(SIGN_IN_ADDRESS)
      expect(browserWindow.location.href).not.toContain('ownerStartupToken')
      expect(browserWindow.location.href).not.toContain('secret')
      expect(browserWindow.location.href).not.toContain('shareId')
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
const OFFERED = [{ plugin: 'mekGit', endpoints: ['mekGit/commit', 'mekGit/getGraph'] }]
const STORED = [{ plugin: 'mekGit', mode: 'all' }]

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
  it('clears the per-plugin selection when the global switch closes every method', async () => {
    const setCapabilities = vi.fn(async () => accepted({ shareId: 'existing', viewerPluginAccess: 'none' as const, viewerPlugins: [] }))
    await showControlled({
      rows: [{ ...existing, viewerPluginAccess: 'all' as const, viewerPlugins: STORED }],
      overrides: {
        capabilities: async () => accepted({ capabilities: OFFERED }),
        setCapabilities,
      },
    })

    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Deny all' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })) })
    expect(setCapabilities).toHaveBeenCalledWith({ shareId: 'existing', viewerPluginAccess: 'none' as const, viewerPlugins: [] })
  })

  it('opens every installed plugin method through the global switch', async () => {
    const setCapabilities = vi.fn(async () => accepted({
      shareId: 'existing', viewerPluginAccess: 'all' as const, viewerPlugins: [],
    }))
    await showControlled({
      rows: [{ ...existing, viewerPlugins: [] }],
      overrides: {
        capabilities: async () => accepted({ capabilities: OFFERED }),
        setCapabilities,
      },
    })

    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Allow all' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })) })
    expect(setCapabilities).toHaveBeenCalledWith({
      shareId: 'existing', viewerPluginAccess: 'all' as const, viewerPlugins: [],
    })
  })

  it('opens the per-plugin list and stores a custom policy', async () => {
    const setCapabilities = vi.fn(async () => accepted({
      shareId: 'existing', viewerPluginAccess: 'custom' as const,
      viewerPlugins: [{ plugin: 'mekGit', mode: 'all' as const }],
    }))
    await showControlled({
      rows: [{ ...existing, viewerPluginAccess: 'none' as const, viewerPlugins: [] }],
      overrides: {
        capabilities: async () => accepted({ capabilities: OFFERED }),
        setCapabilities,
      },
    })

    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Custom' })) })
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'All methods' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })) })
    expect(setCapabilities).toHaveBeenCalledWith({
      shareId: 'existing', viewerPluginAccess: 'custom' as const,
      viewerPlugins: [{ plugin: 'mekGit', mode: 'all' as const }],
    })
  })

  it('states unsaved changes when the owner adds a method the share does not expose', async () => {
    await showControlled({
      rows: [{
        ...existing,
        viewerPluginAccess: 'custom' as const,
        viewerPlugins: [{ plugin: 'mekGit', mode: 'selected' as const, endpoints: ['mekGit/commit'] }],
      }],
      overrides: { capabilities: async () => accepted({ capabilities: OFFERED }) },
    })

    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true)
    await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'getGraph' })) })
    expect(screen.getByText(en['dialog.permissions.unsaved'])).toBeDefined()
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', false)
  })

  it('warns before a second Done discards the picks', async () => {
    const onClose = vi.fn()
    await showControlled({
      rows: [existing],
      onClose,
      overrides: { capabilities: async () => accepted({ capabilities: OFFERED }) },
    })

    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Allow all' })) })
    expect(screen.getByText(en['dialog.permissions.unsaved'])).toBeDefined()
    await act(async () => { fireEvent.click(screen.getByText('Done')) })
    expect(screen.getByText(en['dialog.permissions.discard'])).toBeDefined()
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByText('Done')) })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('saves a fork change for a record that names no session permission', async () => {
    const updatePermissions = vi.fn(async (): Promise<RemoteResult<SharePermissions>> =>
      accepted({ shareId: 'existing', sessionMode: 'view', allowsFork: true }))
    const setCapabilities = vi.fn(async () => accepted({ shareId: 'existing', viewerPluginAccess: 'none' as const, viewerPlugins: [] }))
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
      rows: [{ ...existing, viewerPlugins: STORED }],
      overrides: {
        capabilities: async () => accepted({ capabilities: OFFERED }),
        list: async () => {
          calls += 1
          return accepted({ shares: [calls === 1
            ? { ...existing, viewerPlugins: STORED }
            : { ...existing, viewerPlugins: STORED, allowsFork: true }] as never })
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

  it('keeps its create form when the list read fails', async () => {
    await showControlled({ overrides: { list: async () => { throw new Error('host unreachable') } } })

    expect(screen.queryByRole('textbox', { name: 'Share link' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Create share' })).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('hides the endpoint control when the offer read fails', async () => {
    await showControlled({
      rows: [existing],
      overrides: { capabilities: async () => { throw new Error('host unreachable') } },
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
    const testRelay = vi.fn(async () => accepted({ ok: true, httpReachable: true, blocking: false }))
      .mockResolvedValueOnce(refused('gateway/internal', {}))
    await showControlled({ overrides: { testRelay } })

    expect(await screen.findByText(en['dialog.hostUnavailable'])).toBeDefined()
    const signIn = screen.getByRole('button', { name: 'Sign in again' })
    expect(signIn).toHaveProperty('disabled', true)
    const input = screen.getByRole('textbox', { name: 'Share service address' })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(testRelay).toHaveBeenCalledTimes(2)
    expect(signIn).toHaveProperty('disabled', false)
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

  it('enables sign-in only after the first saved Relay answers', async () => {
    const probe = Promise.withResolvers<RelayConnectivityView>()
    const host = await showControlled({
      defaultRelay: '',
      identity: { state: 'unverified', relay: RELAY },
      overrides: {
        relay: async () => accepted({}),
        testRelay: async () => accepted(await probe.promise),
      },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Share service address' }), { target: { value: RELAY } })
    expect(probes(host)).toBe(0)
    expect(screen.getByTitle(en['dialog.identity.verifyBlocked'])).toHaveProperty('disabled', true)

    await saveAddress()
    expect(host.calls.filter(call => call.method === 'setRelay' || call.method === 'testRelay')).toEqual([
      { method: 'setRelay', argument: { relayUrl: RELAY } }, { method: 'testRelay' },
    ])
    const signIn = screen.getByRole('button', { name: 'Sign in' })
    expect(signIn).toHaveProperty('disabled', true)
    await act(async () => { probe.resolve({ ok: true, httpReachable: true, blocking: false }) })
    expect(signIn).toHaveProperty('disabled', false)
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
    expect(await screen.findByText(en['dialog.permissionFailed'])).toBeDefined()
    expect(screen.getByRole('button', { name: 'Create share' })).toHaveProperty('disabled', true)
    expect(host.calls.some(call => call.method === 'create')).toBe(false)
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

  it('states a create the holder of the share state refused, not an unreachable Host', async () => {
    await showControlled({ overrides: { create: async () => refused('liveshareShares/owner-state-held', {}) } })
    const button = screen.getByRole('button', { name: 'Create share' })
    await vi.waitFor(() => { expect(button).toHaveProperty('disabled', false) })
    await act(async () => { fireEvent.click(button) })

    expect(screen.getByRole('alert').textContent).toBe(en['dialog.ownerStateHeld'])
  })

  it('adopts a created share whose Host reported no session permission', async () => {
    await showControlled({
      overrides: {
        create: async () => {
          // A Host that predates the permission field answers without it; the dialog must state that
          // rather than assume the narrowest tier.
          const answer: CreatedShare = {
            link: existing.link, shareId: 'existing', sessionId: 'session', sessionIds: ['session'], sessionMode: 'view', access: OPEN_ACCESS,
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
      link: existing.link, shareId: 'existing', sessionId: 'session', sessionIds: ['session'], sessionMode: 'view', access: OPEN_ACCESS,
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
          link: '', shareId: 'existing', sessionId: 'session', sessionIds: ['session'], sessionMode: 'view', access: OPEN_ACCESS,
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
      rows: [{ ...existing, viewerPlugins: STORED }],
      overrides: {
        capabilities: async () => accepted({ capabilities: OFFERED }),
        updatePermissions: async (): Promise<RemoteResult<SharePermissions>> =>
          accepted({ shareId: 'existing', sessionMode: 'view', allowsFork: true }),
        setCapabilities: async () => refused('gateway/internal', {}),
        list: async () => {
          calls += 1
          return accepted({ shares: [calls === 1
            ? { ...existing, viewerPlugins: STORED }
            : { ...existing, shareId: 'another', viewerPlugins: STORED }] as never })
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
