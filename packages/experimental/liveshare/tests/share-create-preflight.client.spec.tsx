// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { useShareCreateForm } from '../src/client/ShareCreateForm.tsx'
import { DOUBLE_RELAY, ownerSharesDouble } from './owner-shares-double.client.ts'

afterEach(cleanup)

it.each(['connectivity', 'permission'] as const)('does not create a share when %s is refused', async (refused) => {
  const host = ownerSharesDouble()
  const connectivity = Promise.withResolvers<boolean>()
  const testConnectivity = vi.fn(() => connectivity.promise)
  const testPermission = vi.fn(async () => false)
  const { result } = renderHook(() => useShareCreateForm({
    shares: host.shares,
    sessionId: 'session' as SessionId,
    sessionTitle: 'Test session',
    ownerIdentity: { state: 'verified', relay: DOUBLE_RELAY },
    connectivity: 'idle',
    permission: 'idle',
    offered: [],
    testConnectivity,
    testPermission,
    onError: vi.fn(),
    onCreated: vi.fn(),
    identityStateLine: () => '',
    t: key => key,
  }))

  let attempt: Promise<void>
  act(() => { attempt = result.current.create() })
  expect(result.current.busy).toBe(true)
  expect(testConnectivity).toHaveBeenCalledTimes(1)
  expect(testPermission).not.toHaveBeenCalled()

  await act(async () => {
    connectivity.resolve(refused === 'permission')
    await attempt
  })
  expect(testPermission).toHaveBeenCalledTimes(refused === 'permission' ? 1 : 0)
  expect(host.calls).toEqual([])
  expect(result.current.busy).toBe(false)
  expect(result.current.isCreating()).toBe(false)
})
