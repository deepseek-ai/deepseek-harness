import { expect, it, vi } from 'vitest'
import { refreshAfterReturn } from '../src/client/account-refresh.ts'

it('starts a new query after the pre-return balance query settles', async () => {
  const old = Promise.withResolvers<undefined>()
  const refresh = vi.fn(async () => {})
  const returned = refreshAfterReturn(old.promise, refresh)
  expect(refresh).not.toHaveBeenCalled()
  old.resolve(undefined)
  await returned
  expect(refresh).toHaveBeenCalledOnce()
})

it('requests fresh account details even when the pre-return query failed', async () => {
  const refresh = vi.fn(async () => {})
  await refreshAfterReturn(Promise.reject(new Error('previous read failed')), refresh)
  expect(refresh).toHaveBeenCalledOnce()
})

it('refreshes directly when no earlier query is active and preserves the new failure', async () => {
  const refresh = vi.fn(async () => { throw new Error('new read failed') })
  await expect(refreshAfterReturn(undefined, refresh)).rejects.toThrow('new read failed')
  expect(refresh).toHaveBeenCalledOnce()
})
