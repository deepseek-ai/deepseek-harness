// @vitest-environment jsdom
/** Owner-facing Relay URL override field, with only the share-management Remote substituted. */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LiveshareShareDialog, type LiveshareShareDialogProps } from '../src/client/ShareDialog.tsx'
import { en } from '../src/client/locales.ts'
import type {
  OwnerIdentityStatus, OwnerRelayState, RelayConnectivityView, RelayPublishView,
} from '../src/share-api-types.ts'
import {
  accepted, DOUBLE_RELAY, ownerSharesDouble, refused, type OwnerSharesCall, type OwnerSharesDouble,
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

interface RelayResponses {
  readonly state?: OwnerRelayState
  /** The state a saved address answers with; the default echoes the saved address. */
  readonly postBody?: OwnerRelayState
  /** What the Host reports about the owner for one requested Relay address; absent reports nothing. */
  readonly identity?: (relay: string) => OwnerIdentityStatus
  /** What the connectivity check answers; the default is an address that answers. */
  readonly connectivity?: RelayConnectivityView
  /** What the permission check answers; the default is a registration the Relay accepts. */
  readonly permission?: RelayPublishView
}

/** One recorded request, read by method. */
function callsOf(host: OwnerSharesDouble, method: OwnerSharesCall['method']): readonly unknown[] {
  return host.calls.filter(call => call.method === method).map(call => call.argument)
}

/** Save the field by leaving it, which is the dialog's only save action. */
async function saveAddress(): Promise<void> {
  await act(async () => { fireEvent.blur(screen.getByLabelText('Share service address')) })
}

/** State one saved address reports: `null` clears it, which also clears the effective address. */
function savedRelayState(state: OwnerRelayState, relay: string | null): OwnerRelayState {
  const { configured } = state
  const base = configured === undefined ? {} : { configured }
  return relay === null ? base : { ...base, override: relay, effective: relay }
}

async function showDialog(relay: RelayResponses = {}, defaultRelay = DOUBLE_RELAY): Promise<OwnerSharesDouble> {
  const state: OwnerRelayState = relay.state
    ?? { effective: DOUBLE_RELAY }
  const host = ownerSharesDouble({
    relay: async () => accepted(state),
    setRelay: async request => accepted(relay.postBody ?? savedRelayState(state, request.relayUrl)),
    // A host this case did not script answers nothing this page can read.
    identity: async (request) => {
      const identity = relay.identity
      return identity === undefined
        ? refused('gateway/internal', {})
        : accepted(identity(request.relay ?? ''))
    },
    testRelay: async () => accepted(relay.connectivity ?? { ok: true, httpReachable: true, blocking: false }),
    testPublish: async () => accepted(relay.permission ?? { ok: true, blocking: false }),
  })
  await act(async () => {
    render(<LiveshareShareDialog
      sessionId={'session' as SessionId}
      sessionTitle="Session"
      defaultRelay={defaultRelay}
      shares={host.shares}
      onClose={() => {}}
      t={translate}
    />)
  })
  return host
}

describe('Liveshare relay URL field', () => {
  it('shows the effective relay address', async () => {
    await showDialog({
      state: {
        override: 'https://override.example.test',
        effective: 'https://override.example.test',
      },
    })

    expect(screen.getByLabelText('Share service address')).toHaveProperty('value', 'https://override.example.test')
  })

  it('states that no address is set before the owner saves one', async () => {
    const host = await showDialog({ state: {} }, '')

    // A page that has no address to show says so in the field and in the address row, and starts the
    // owner on the step that puts one in force; nothing is asked of the Host about an absent address.
    const field = screen.getByLabelText('Share service address')
    expect(field).toHaveProperty('value', '')
    expect(field.getAttribute('placeholder')).toBe('No address set')
    expect(screen.getByText(en['dialog.addressHint'])).toBeDefined()
    expect(screen.getByRole('button', { name: 'Create share' })).toHaveProperty('disabled', true)
    expect(callsOf(host, 'identity')).toHaveLength(0)
  })

  it('saves a new relay URL and reports success', async () => {
    const host = await showDialog()
    fireEvent.change(screen.getByLabelText('Share service address'), { target: { value: 'https://new.example.test' } })
    await saveAddress()

    expect(callsOf(host, 'setRelay')).toEqual([{ relayUrl: 'https://new.example.test' }])
    // Saving and checking is one action: the save itself probes the address it put in force.
    expect(callsOf(host, 'testRelay').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Test connectivity' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save and check' })).toBeNull()
    expect(screen.getByLabelText('Share service address')).toHaveProperty('value', 'https://new.example.test')
  })

  it('keeps the saved address in the field when the Host reports none back', async () => {
    const host = await showDialog({ state: {}, postBody: {} }, '')
    const field = screen.getByLabelText('Share service address')
    fireEvent.change(field, { target: { value: 'https://new.example.test' } })
    await saveAddress()

    // The address the owner just saved is what the field states, even if the answer omits the field.
    expect(field).toHaveProperty('value', 'https://new.example.test')
    expect(callsOf(host, 'setRelay')).toEqual([{ relayUrl: 'https://new.example.test' }])
  })

  it('rejects an invalid relay URL without saving', async () => {
    const host = await showDialog()
    fireEvent.change(screen.getByLabelText('Share service address'), { target: { value: 'not-a-url' } })
    await saveAddress()

    expect(callsOf(host, 'setRelay')).toHaveLength(0)
    expect(screen.getByRole('alert').textContent).toContain('starting with http:// or https://')
  })

  it('saves the address the owner fills in, with no action that restores a default', async () => {
    const host = await showDialog({
      state: {
        override: 'https://override.example.test',
        effective: 'https://override.example.test',
      },
    })
    // The address is the owner's to type and save; nothing offers to clear it back to a default.
    expect(screen.queryByRole('button', { name: 'Use default' })).toBeNull()

    fireEvent.change(screen.getByLabelText('Share service address'), {
      target: { value: 'https://configured.example.test' },
    })
    await saveAddress()

    expect(callsOf(host, 'setRelay')).toEqual([{ relayUrl: 'https://configured.example.test' }])
  })

  it('puts the address before the sign-in action it gates', async () => {
    await showDialog({ identity: relay => ({ state: 'unverified', relay }) })
    const field = screen.getByLabelText('Share service address')
    const verify = await screen.findByRole('button', { name: 'Sign in' })
    // The owner sets the address first; the control that opens a sign-in at it comes after.
    expect(field.compareDocumentPosition(verify) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('requires the address to be saved before it may be verified', async () => {
    await showDialog({
      identity: relay => ({ state: 'unverified', relay }),
    })
    // The saved address answers, so its own verification is the step the owner may act on.
    const verify = await screen.findByRole('button', { name: 'Sign in' })
    expect(verify).toHaveProperty('disabled', false)

    fireEvent.change(screen.getByLabelText('Share service address'), { target: { value: 'https://new.example.test' } })
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Sign in' }).getAttribute('title'))
      .toBe(en['dialog.identity.verifyBlocked'])
    expect(screen.getByRole('button', { name: 'Create share' })).toHaveProperty('disabled', true)
    // Sign-in gates the share configuration: every choice below the address is unavailable, not just
    // the create action.
    expect(screen.getByRole('tab', { name: 'Read only' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('switch', { name: en['dialog.allowsFork'] })).toHaveProperty('disabled', true)
    expect(screen.getByText(en['dialog.expiry.never'])).toBeDefined()
    // The flow states the address step and why it blocks, rather than a reason this page invented.
    expect(screen.getByRole('status').textContent).toBe('This address is not saved yet; save it to put it in force.')
  })

  it('lets verification resume once the saved address answers', async () => {
    const host = await showDialog({
      identity: relay => ({ state: 'unverified', relay }),
      postBody: { effective: 'https://new.example.test' },
    })
    fireEvent.change(screen.getByLabelText('Share service address'), { target: { value: 'https://new.example.test' } })
    await saveAddress()

    // Saving puts the new address in force, asks whether it answers, and re-reads its identity.
    expect(screen.getByLabelText('Share service address')).toHaveProperty('value', 'https://new.example.test')
    await vi.waitFor(() => { expect(screen.getByRole('button', { name: 'Sign in' })).toHaveProperty('disabled', false) })
    const identityReads = callsOf(host, 'identity').filter(argument =>
      typeof argument === 'object' && argument !== null
      && (argument as { readonly relay?: unknown }).relay === 'https://new.example.test')
    expect(identityReads.length).toBeGreaterThan(0)
  })

  it('warns that a changed address has to be verified again before creating', async () => {
    await showDialog({
      identity: relay => ({ state: 'verified', relay, displayName: '许翰翔' }),
      postBody: { effective: 'https://new.example.test' },
    })
    expect(await screen.findByText('许翰翔')).toBeDefined()
    fireEvent.change(screen.getByLabelText('Share service address'), { target: { value: 'https://new.example.test' } })
    await saveAddress()

    // A credential belongs to the address that issued it, so the save states what happens next.
    expect(screen.getByText(en['dialog.relayReverify'])).toBeDefined()
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeDefined()
  })

  it('withholds verification and creation while the address does not answer', async () => {
    const error = 'https://relay.example.test: ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:8443'
    await showDialog({
      identity: relay => ({ state: 'unverified', relay }),
      connectivity: { ok: false, httpReachable: false, blocking: true, error },
    })

    // The Host's own diagnosis is printed unchanged, and the step it belongs to is the current one.
    expect(await screen.findByText(error)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Create share' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Create share' }).getAttribute('title')).toBe(error)
  })

  it('offers to verify again on the address in force for a verified owner', async () => {
    await showDialog({
      identity: relay => ({ state: 'verified', relay, displayName: '许翰翔' }),
    })
    expect(await screen.findByText('许翰翔')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Sign in again' })).toHaveProperty('disabled', false)
    expect(screen.getByRole('tab', { name: 'Read only' })).toHaveProperty('disabled', false)
    expect(screen.getByRole('switch', { name: en['dialog.allowsFork'] })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: 'Sign in again' })).toHaveProperty('disabled', false)
  })
})
