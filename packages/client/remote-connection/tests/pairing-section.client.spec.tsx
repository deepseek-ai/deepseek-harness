// @vitest-environment jsdom
/** Owner decisions remain visible outside Settings; the approval card shows only live requests. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { allowAllAccess, bindSnapshotSelector, contextMenuHook, makeTranslate, responsiveHooks, themeHooks } from '@deepseek-ai/dsh-client-test-runtime'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { PairingDecisionResult, PairingRequestId, PairingRequestsValue } from '../src/types.ts'
import { PairingApproval } from '../src/client/pairing-approval.ts'
import { PairingRequests, PairingToast } from '../src/client/PairingRequests.tsx'
import { en, zh, ja, es, fr, de, ru, pt } from '../src/client/locales.ts'

afterEach(cleanup)

function fixture(sourceIp: string | null = '192.0.2.17') {
  const decide = vi.fn<() => Promise<RemoteResult<PairingDecisionResult>>>().mockResolvedValue({ ok: true, value: 'approved' })
  const approval = new PairingApproval({ decidePairing: decide }, async () => {})
  approval.activate()
  const value: PairingRequestsValue = {
    requests: [{ id: 'request-one' as PairingRequestId, code: 'ABCD2345', authority: 'https://host.example', sourceIp, expiresInMs: 60000 }],
    pollIntervalMs: 1000,
  }
  const snapshot: ResourceSnapshot<PairingRequestsValue> = { status: 'live', failure: undefined, value }
  const useResource = vi.fn(() => snapshot)
  const props = {
    useResource, useApproval: bindSnapshotSelector(approval.state),
    decide: (id: PairingRequestId, decision: 'allow' | 'deny') => approval.decide(id, decision),
    dismiss: () => { approval.dismiss() }, t: makeTranslate(en),
  } as ComponentProps<typeof PairingRequests>
  const unusedHook = (): never => { throw new Error('Pairing toast does not read global state') }
  const toastProps = {
    ...props, ...allowAllAccess, useContextMenu: contextMenuHook(), ...responsiveHooks(), ...themeHooks(),
    usePanelInfo: unusedHook, useWorkspaces: unusedHook, useSessions: unusedHook,
    useSessionStatus: unusedHook, useSessionRetainInfo: unusedHook,
  } satisfies ComponentProps<typeof PairingToast>
  return { decide, approval, snapshot, value, useResource, props, toastProps }
}

it('shows the code and source IP, then announces the decision after Settings closes during submission', async () => {
  const { props, toastProps, decide, approval } = fixture()
  const pending = Promise.withResolvers<RemoteResult<PairingDecisionResult>>()
  decide.mockReturnValueOnce(pending.promise)
  try {
    const section = render(<PairingRequests {...props} />)
    render(<PairingToast {...toastProps} />)
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull()
    expect(screen.getByRole('heading', { level: 3, name: en['pairing.title'] })).toBeTruthy()
    expect(screen.getByRole('region', { name: en['pairing.title'] })).toBeTruthy()
    expect(screen.getByRole('note').textContent).toBe(en['pairing.permission'])
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([en['pairing.approve'], en['pairing.deny']])
    expect(screen.getByText('ABCD 2345')).toBeTruthy()
    expect(screen.getByText(en['pairing.sourceIp'])).toBeTruthy()
    expect(screen.getByText('192.0.2.17')).toBeTruthy()
    expect(screen.queryByText('https://host.example')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['pairing.approve'] }))
    section.unmount()
    await act(async () => { pending.resolve({ ok: true, value: 'approved' }) })
    await screen.findByText(en['pairing.approved'])
    expect(decide).toHaveBeenCalledWith('request-one', 'allow', expect.any(AbortSignal))
    expect(screen.getByText(en['pairing.approved'])).toBeTruthy()
  } finally { pending.resolve({ ok: true, value: 'unavailable' }); approval.dispose() }
})

it.each(Object.entries({ en, zh, ja, es, fr, de, ru, pt }))('labels the source IP in %s and renders unknown or the full IPv6 address', (_language, dictionary) => {
  const { props, approval, snapshot, value, useResource } = fixture(null)
  const ipv6 = '2001:0db8:1234:5678:90ab:cdef:1234:5678'
  try {
    const view = render(<PairingRequests {...props} t={makeTranslate(dictionary)} />)
    expect(screen.getByText(dictionary['pairing.sourceIp'])).toBeTruthy()
    expect(screen.getByText(dictionary['pairing.sourceIpUnknown'])).toBeTruthy()
    expect(screen.queryByText('https://host.example')).toBeNull()
    useResource.mockReturnValue({
      ...snapshot, value: { ...value, requests: value.requests.map(row => ({ ...row, sourceIp: ipv6 })) },
    })
    view.rerender(<PairingRequests {...props} t={makeTranslate(dictionary)} />)
    expect(screen.getByText(ipv6, { exact: true })).toBeTruthy()
    expect(screen.queryByText(dictionary['pairing.sourceIpUnknown'])).toBeNull()
    expect(screen.queryByText('https://host.example')).toBeNull()
  } finally { approval.dispose() }
})

it('keeps a failed operation row visible and serializes decisions', async () => {
  const { props, toastProps, decide, approval } = fixture()
  const pending = Promise.withResolvers<RemoteResult<PairingDecisionResult>>()
  decide.mockReturnValueOnce(pending.promise)
  try {
    render(<><PairingRequests {...props} /><PairingToast {...toastProps} /></>)
    fireEvent.click(screen.getByRole('button', { name: en['pairing.deny'] }))
    expect(screen.getByRole('button', { name: en['pairing.approve'] }).hasAttribute('disabled')).toBe(true)
    await act(async () => {
      pending.reject(new Error('response lost'))
      await pending.promise.catch(() => undefined)
    })
    await screen.findByText(en['pairing.failed'])
    expect(screen.getByText('ABCD 2345')).toBeTruthy()
    expect(screen.getByRole('button', { name: en['pairing.approve'] }).hasAttribute('disabled')).toBe(false)
  } finally { approval.dispose() }
})

it('hides stalled requests during a read failure and shows the latest requests after retry', () => {
  const { props, approval, snapshot, value, useResource } = fixture()
  try {
    const view = render(<PairingRequests {...props} />)
    expect(screen.getByText('ABCD 2345')).toBeTruthy()
    expect(screen.getByRole('note').textContent).toBe(en['pairing.permission'])

    useResource.mockReturnValue({ ...snapshot, status: 'failed' })
    view.rerender(<PairingRequests {...props} />)
    expect(screen.getByRole('alert').textContent).toBe(en['pairing.readFailed'])
    expect(screen.queryByText('ABCD 2345')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([en['pairing.retry']])

    useResource.mockReturnValue({ status: 'loading', value: undefined, failure: undefined })
    fireEvent.click(screen.getByRole('button', { name: en['pairing.retry'] }))
    expect(useResource).toHaveBeenLastCalledWith('dsh-resource://device-pairing/requests?retry=1')
    expect(screen.getByRole('status', { name: en['pairing.loading'] })).toBeTruthy()
    expect(screen.queryByRole('note')).toBeNull()

    useResource.mockReturnValue({
      ...snapshot,
      value: { ...value, requests: value.requests.map(row => ({ ...row, code: 'WXYZ6789' })) },
    })
    view.rerender(<PairingRequests {...props} />)
    expect(screen.getByText('WXYZ 6789')).toBeTruthy()
    expect(screen.queryByText('ABCD 2345')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('note').textContent).toBe(en['pairing.permission'])
    expect(screen.getByRole('button', { name: en['pairing.approve'] }).hasAttribute('disabled')).toBe(false)
  } finally { approval.dispose() }
})

it('shows only pairing instructions once an empty list loads', () => {
  const { props, approval, snapshot, useResource } = fixture()
  useResource.mockReturnValue({ status: 'loading', value: undefined, failure: undefined })
  try {
    const view = render(<PairingRequests {...props} />)
    expect(screen.getByRole('status', { name: en['pairing.loading'] })).toBeTruthy()
    expect(screen.queryByText(en['pairing.permission'])).toBeNull()
    useResource.mockReturnValue({ ...snapshot, value: { requests: [], pollIntervalMs: 1000 } })
    view.rerender(<PairingRequests {...props} t={makeTranslate(zh)} />)
    expect(screen.getByRole('heading', { level: 3, name: zh['pairing.title'] })).toBeTruthy()
    expect(screen.getByText(zh['pairing.description'])).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    useResource.mockReturnValue({ ...snapshot, status: 'failed', value: { requests: [], pollIntervalMs: 1000 } })
    view.rerender(<PairingRequests {...props} t={makeTranslate(zh)} />)
    expect(screen.getByRole('alert').textContent).toBe(zh['pairing.readFailed'])
    expect(screen.queryByRole('status')).toBeNull()
  } finally { approval.dispose() }
})

it('removes the permission warning when the last pending request leaves the list', () => {
  const { props, approval, snapshot, useResource } = fixture()
  try {
    const view = render(<PairingRequests {...props} />)
    expect(screen.getByRole('note').textContent).toBe(en['pairing.permission'])
    useResource.mockReturnValue({ ...snapshot, value: { requests: [], pollIntervalMs: 1000 } })
    view.rerender(<PairingRequests {...props} />)
    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.queryByText('ABCD 2345')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  } finally { approval.dispose() }
})
