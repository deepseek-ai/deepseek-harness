/** Host-run checks for ordered async Inspector cleanup. */

import { expect, it, vi } from 'vitest'
import { disposeInspectorResources } from '../src/shared/dispose.ts'

it('waits for each registration before releasing its predecessor and source', async () => {
  const released = Promise.withResolvers<undefined>()
  const order: string[] = []
  const disposed = disposeInspectorResources([
    () => { order.push('first') },
    async () => { order.push('second'); await released.promise },
  ], () => { order.push('source') }, 'failed')
  try {
    expect(order).toEqual(['second'])
  } finally { released.resolve(undefined) }
  await disposed
  expect(order).toEqual(['second', 'first', 'source'])
})

it('collects both registration and transport failures after attempting every action', async () => {
  const earlier = new Error('registration')
  const later = new Error('transport')
  const retained = vi.fn()
  const disposed = disposeInspectorResources([retained, async () => { throw earlier }], () => { throw later }, 'cleanup failed')
  await expect(disposed).rejects.toMatchObject({ message: 'cleanup failed', errors: [earlier, later] })
  expect(retained).toHaveBeenCalledOnce()
})
