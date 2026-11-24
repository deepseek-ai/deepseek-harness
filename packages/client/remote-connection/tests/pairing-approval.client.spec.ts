/** Decision outcomes stay ordered and stop publishing when owner access ends. */
import { expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { PairingDecisionResult, PairingRequestId } from '../src/types.ts'
import { PairingApproval } from '../src/client/pairing-approval.ts'

const id = 'request-one' as PairingRequestId

it.each([
  { decision: 'allow', value: 'approved' },
  { decision: 'allow', value: 'denied' },
  { decision: 'allow', value: 'unavailable' },
  { decision: 'deny', value: 'approved' },
  { decision: 'deny', value: 'denied' },
  { decision: 'deny', value: 'unavailable' },
] as const)('announces the committed $value after $decision and list publication', async ({ decision, value }) => {
  const decide = vi.fn(async () => ({ ok: true as const, value }))
  const published = Promise.withResolvers<undefined>()
  const confirmed = vi.fn(() => published.promise)
  const approval = new PairingApproval({ decidePairing: decide }, confirmed)
  approval.activate()
  try {
    const operation = approval.decide(id, decision)
    await vi.waitFor(() => { expect(confirmed).toHaveBeenCalledExactlyOnceWith(id) })
    expect(approval.state.getSnapshot()).toMatchObject({ busy: true, notice: null, sequence: 0 })
    await approval.decide(id, decision === 'allow' ? 'deny' : 'allow')
    expect(decide).toHaveBeenCalledOnce()
    published.resolve(undefined)
    await operation
    expect(decide).toHaveBeenCalledWith(id, decision, expect.any(AbortSignal))
    expect(approval.state.getSnapshot()).toEqual({ available: true, busy: false, notice: value, sequence: 1 })
    approval.dismiss()
    expect(approval.state.getSnapshot().notice).toBeNull()
  } finally { published.resolve(undefined); approval.dispose() }
})

it.each(['refused', 'disconnected'] as const)('reports an unknown outcome after a %s operation', async (failure) => {
  const decide = vi.fn<() => Promise<RemoteResult<PairingDecisionResult>>>()
  if (failure === 'refused') decide.mockResolvedValue({ ok: false, error: new RemoteError('remote-connection/owner-required', 'Owner required.', {}) })
  else decide.mockRejectedValue(new Error('disconnected'))
  const confirmed = vi.fn(async () => {})
  const approval = new PairingApproval({ decidePairing: decide }, confirmed)
  approval.activate()
  try {
    await approval.decide(id, 'deny')
    expect(approval.state.getSnapshot()).toMatchObject({ busy: false, notice: 'failed' })
    expect(confirmed).not.toHaveBeenCalled()
  } finally { approval.dispose() }
})

it('submits one decision at a time and ignores a result after access is revoked', async () => {
  const pending = Promise.withResolvers<RemoteResult<PairingDecisionResult>>()
  const decide = vi.fn(() => pending.promise)
  const confirmed = vi.fn(async () => {})
  const approval = new PairingApproval({ decidePairing: decide }, confirmed)
  approval.activate()
  const operation = approval.decide(id, 'allow')
  expect(approval.state.getSnapshot().busy).toBe(true)
  await approval.decide(id, 'deny')
  expect(decide).toHaveBeenCalledOnce()
  approval.dispose()
  pending.resolve({ ok: true, value: 'approved' })
  await operation
  expect(approval.state.getSnapshot()).toEqual({ available: false, busy: false, notice: null, sequence: 0 })
  expect(confirmed).not.toHaveBeenCalled()
  await approval.decide(id, 'allow')
  expect(decide).toHaveBeenCalledOnce()
})

it('does not announce a decision after access ends during list publication', async () => {
  const published = Promise.withResolvers<undefined>()
  const confirmed = vi.fn(() => published.promise)
  const approval = new PairingApproval({ decidePairing: async () => ({ ok: true, value: 'denied' }) }, confirmed)
  approval.activate()
  const operation = approval.decide(id, 'deny')
  await vi.waitFor(() => { expect(confirmed).toHaveBeenCalledOnce() })
  approval.dispose()
  published.resolve(undefined)
  await operation
  expect(approval.state.getSnapshot()).toEqual({ available: false, busy: false, notice: null, sequence: 0 })
})

it.each(['response', 'rejection'] as const)('ignores an old %s after owner access is restored and a new decision completes', async (outcome) => {
  const previous = Promise.withResolvers<RemoteResult<PairingDecisionResult>>()
  const nextId = 'request-two' as PairingRequestId
  const decide = vi.fn<() => Promise<RemoteResult<PairingDecisionResult>>>()
    .mockReturnValueOnce(previous.promise).mockResolvedValueOnce({ ok: true, value: 'denied' })
  const confirmed = vi.fn(async () => {})
  const approval = new PairingApproval({ decidePairing: decide }, confirmed)
  approval.activate()
  const oldOperation = approval.decide(id, 'allow')
  approval.dispose()
  approval.activate()
  try {
    await approval.decide(nextId, 'deny')
    const current = approval.state.getSnapshot()
    expect(current).toMatchObject({ busy: false, notice: 'denied', sequence: 1 })
    if (outcome === 'response') previous.resolve({ ok: true, value: 'approved' })
    else previous.reject(new Error('old connection closed'))
    await oldOperation
    expect(approval.state.getSnapshot()).toBe(current)
    expect(confirmed).toHaveBeenCalledExactlyOnceWith(nextId)
  } finally {
    previous.resolve({ ok: true, value: 'unavailable' })
    approval.dispose()
    await oldOperation
  }
})
