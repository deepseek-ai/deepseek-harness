// @vitest-environment jsdom
/**
 * The Relay address this dialog treats as in force, and what it may state about connectivity.
 *
 * The header action reads the address from the host in its own request and mounts this dialog before
 * that answer lands, so the field starts empty and the header's answer only prefills it. An address is
 * in force once this dialog's own `relay` read names it, and only then is the host asked whether it
 * answers or the sign-in that would open there offered.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState, type ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '../src/client/index.ts'
import { LiveshareShareDialog, type LiveshareShareDialogProps } from '../src/client/ShareDialog.tsx'
import { en } from '../src/client/locales.ts'
import type {
  OwnerIdentityStatus, OwnerRelayState, RelayConnectivityView,
} from '../src/share-api-types.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import {
  accepted, DOUBLE_RELAY, ownerSharesDouble, requestOf, type OwnerSharesDouble,
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

/** The address this deployment's host names, and the one the account is verified on. */
const RELAY = DOUBLE_RELAY
const OTHER = 'https://other.example.test'
const UNSAVED = 'This address is not saved yet; save it to put it in force.'
const UNREACHABLE = 'Cannot reach the DSH Liveshare share service.'

type MaybeAsync<T> = T | Promise<T>

interface DialogOptions {
  /** The address the header action already read; it prefills the field but names nothing in force. */
  readonly defaultRelay?: string
  /** The host's own `relay` answer, or a promise that never settles while the dialog is open. */
  readonly relay?: MaybeAsync<RemoteResult<OwnerRelayState>>
  /** What the host answers a save with; the default keeps the address in force. */
  readonly relayPost?: OwnerRelayState
  /** The connectivity check's answer, or a promise the case settles itself. */
  readonly connectivity?: MaybeAsync<RelayConnectivityView>
  readonly identity?: OwnerIdentityStatus
}

/** One dialog mounted over a scripted Remote, with the address its host named, or none yet. */
async function showDialog(options: DialogOptions = {}): Promise<OwnerSharesDouble> {
  const host = installShares(options)
  await act(async () => {
    render(<LiveshareShareDialog
      sessionId={'session' as SessionId}
      sessionTitle="Relay address session"
      defaultRelay={options.defaultRelay ?? ''}
      shares={host.shares}
      onClose={() => {}}
      t={translate}
    />)
  })
  return host
}

/**
 * Render the dialog behind a parent that names the address, as the header action does.
 *
 * The action mounts this dialog with no address and re-renders it once its own read answers, so the
 * dialog's field is already mounted when the address arrives; this harness is that order.
 * @returns The scripted Remote and the setter that stands in for the action's answer.
 */
async function showDialogBeforeAddressArrives(options: DialogOptions = {}): Promise<{
  readonly host: OwnerSharesDouble
  readonly announce: (relay: string) => Promise<void>
}> {
  const host = installShares(options)
  let announce!: (relay: string) => void
  const shares = host.shares
  await act(async () => {
    render(<AddressSource shares={shares} onRender={(set) => { announce = set }} />)
  })
  return {
    host,
    announce: async (relay) => { await act(async () => { announce(relay) }) },
  }
}

/** A parent that decides the dialog's address prop, like the header action's own read does. */
function AddressSource({ shares, onRender }: {
  readonly shares: OwnerSharesDouble['shares']
  readonly onRender: (set: (relay: string) => void) => void
}): ReactNode {
  const [relay, setRelay] = useState('')
  // Handing the setter out during render keeps this harness free of effect ordering of its own.
  onRender(setRelay)
  return <LiveshareShareDialog
    sessionId={'session' as SessionId}
    sessionTitle="Relay address session"
    defaultRelay={relay}
    shares={shares}
    onClose={() => {}}
    t={translate}
  />
}

/** Script the share-management Remote with the answers one case needs. */
function installShares(options: DialogOptions): OwnerSharesDouble {
  const inForce = { override: RELAY, effective: RELAY }
  return ownerSharesDouble({
    relay: async () => await (options.relay ?? accepted(inForce)),
    setRelay: async request => accepted(options.relayPost
      ?? { override: request.relayUrl ?? RELAY, effective: request.relayUrl ?? RELAY }),
    identity: async () => accepted(options.identity
      ?? { state: 'verified', relay: RELAY, displayName: 'Owner' }),
    testPublish: async () => accepted({ ok: true, blocking: false }),
    testRelay: async () => accepted(await (options.connectivity ?? { ok: true, httpReachable: true, blocking: false })),
  })
}

/** How many connectivity checks this dialog sent to its own host. */
function probes(host: OwnerSharesDouble): number {
  return host.calls.filter(call => call.method === 'testRelay').length
}

/** Save the field by leaving it, which is the dialog's only save action. */
async function saveAddress(): Promise<void> {
  await act(async () => { fireEvent.blur(screen.getByLabelText('Share service address')) })
}

/** The address field's text. */
function address(): string {
  return screen.getByLabelText('Share service address').getAttribute('value') ?? ''
}

describe('the Relay address the dialog treats as in force', () => {
  it('asks its host instead of reporting a failure it never probed', async () => {
    // The header action has not answered yet, and this dialog's own read is the only address source.
    const host = await showDialog({ defaultRelay: '' })
    await vi.waitFor(() => { expect(probes(host)).toBe(1) })

    expect(address()).toBe(RELAY)
    expect(screen.queryByText(UNSAVED)).toBeNull()
    expect(screen.queryByText(UNREACHABLE)).toBeNull()
    // The host named this address, so the flow is past the address step and creation is not blocked.
    await vi.waitFor(() => { expect(screen.getByRole('button', { name: 'Create share' })).toHaveProperty('disabled', false) })
  })

  it('treats an address only the header action named as a prefill, not as one in force', async () => {
    // The action's read is the only answer: this host's own `relay` read never returns in this case.
    const { host, announce } = await showDialogBeforeAddressArrives({
      relay: new Promise<RemoteResult<OwnerRelayState>>(() => { /* stays open for this case */ }),
    })
    expect(address()).toBe('')

    await announce(RELAY)
    expect(address()).toBe(RELAY)
    expect(screen.queryByText(UNSAVED)).toBeNull()
    // The host has not named the address, so the flow stays on the address step: nothing asks the host
    // about it, and the sign-in that would open there is withheld rather than offered on a prefill.
    expect(probes(host)).toBe(0)
    expect(screen.getByTitle(en['dialog.identity.verifyBlocked']))
      .toHaveProperty('disabled', true)

    // Saving it is what puts it in force, and the flow then asks about it and offers the sign-in.
    await saveAddress()
    expect(requestOf(host.calls, 'setRelay')).toEqual({ relayUrl: RELAY })
    await vi.waitFor(() => { expect(probes(host)).toBe(1) })
    await vi.waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sign in again' })).toHaveProperty('disabled', false)
    })
    expect(screen.queryByText(UNREACHABLE)).toBeNull()
  })

  it('requires a save only for an address the owner changed, and asks about it only after that save', async () => {
    const host = await showDialog({ relayPost: { override: OTHER, effective: OTHER } })
    await vi.waitFor(() => { expect(probes(host)).toBe(1) })

    fireEvent.change(screen.getByLabelText('Share service address'), { target: { value: OTHER } })
    expect(screen.getByRole('status').textContent).toBe(UNSAVED)
    expect(screen.getByRole('button', { name: 'Create share' })).toHaveProperty('disabled', true)
    // The unsaved address is not probed: this host would ask about its own address, not the draft.
    expect(probes(host)).toBe(1)

    await saveAddress()
    await vi.waitFor(() => { expect(address()).toBe(OTHER) })
    expect(screen.queryByText(UNSAVED)).toBeNull()
    await vi.waitFor(() => { expect(probes(host)).toBe(2) })
  })

  it('treats an address typed back to the one in force as saved, before and after saving it again', async () => {
    const host = await showDialog()
    await vi.waitFor(() => { expect(probes(host)).toBe(1) })

    fireEvent.change(screen.getByLabelText('Share service address'), { target: { value: OTHER } })
    expect(screen.getByRole('status').textContent).toBe(UNSAVED)
    fireEvent.change(screen.getByLabelText('Share service address'), { target: { value: RELAY } })
    // Equal to the address in force, whatever its source, so nothing is left to save.
    expect(screen.queryByText(UNSAVED)).toBeNull()

    await saveAddress()
    // Leaving the field after typing the address in force back changes nothing, so no save is sent.
    expect(requestOf(host.calls, 'setRelay')).toBeUndefined()
    expect(screen.queryByText(UNSAVED)).toBeNull()
    expect(address()).toBe(RELAY)
  })

  it('states the host\u2019s own connectivity answer only after a probe returns it', async () => {
    const probe = Promise.withResolvers<RelayConnectivityView>()
    const host = await showDialog({ connectivity: probe.promise })
    const error = 'https://relay.example.test: ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:8443'
    await vi.waitFor(() => { expect(probes(host)).toBe(1) })

    // The probe is in flight, which is not a failure: the step states what it is doing.
    expect(screen.getByText('Testing whether the share service address answers…')).toBeDefined()
    expect(screen.queryByText(UNREACHABLE)).toBeNull()
    expect(screen.queryByText(error)).toBeNull()

    await act(async () => {
      probe.resolve({ ok: false, httpReachable: false, blocking: true, error })
    })
    // The host's own diagnosis is printed unchanged; re-saving the address is what probes it again.
    expect(screen.getByText(error)).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Save and check' })).toBeNull()
  })
})
