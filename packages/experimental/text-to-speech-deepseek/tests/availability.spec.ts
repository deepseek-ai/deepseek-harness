/** Publication order and shutdown of the credential-derived availability. */
import type { SynthesisAvailability } from '@deepseek-ai/dsh-text-to-speech/types'
import { expect, it } from 'vitest'
import { CredentialAvailability } from '../src/availability.ts'

it('starts unavailable, publishes each inspection, and reports a rejected inspection as failed', async () => {
  const results: (() => Promise<SynthesisAvailability>)[] = [
    async () => ({ phase: 'ready' }),
    async () => { throw new Error('keychain locked') },
    async () => { throw 'offline' },
  ]
  const availability = new CredentialAvailability(() => results.shift()!())
  let notified = 0
  const unsubscribe = availability.subscribe(() => { notified++ })
  expect(availability.snapshot()).toEqual({ phase: 'unavailable', reason: 'sign-in-required' })
  await availability.refresh()
  expect(availability.snapshot()).toEqual({ phase: 'ready' })
  await availability.refresh()
  expect(availability.snapshot()).toEqual({ phase: 'failed', message: 'keychain locked' })
  await availability.refresh()
  expect(availability.snapshot()).toEqual({ phase: 'failed', message: 'offline' })
  expect(notified).toBe(3)
  unsubscribe()
})

it('discards an inspection that a newer one replaced and publishes nothing once stopped', async () => {
  const first = Promise.withResolvers<SynthesisAvailability>()
  const settled = (state: SynthesisAvailability): Promise<SynthesisAvailability> => Promise.resolve(state)
  const pending = [first.promise, settled({ phase: 'ready' }), settled({ phase: 'failed', message: 'late' })]
  const availability = new CredentialAvailability(() => pending.shift()!)
  let notified = 0
  availability.subscribe(() => { notified++ })
  const stale = availability.refresh()
  await availability.refresh()
  first.resolve({ phase: 'failed', message: 'stale' })
  await stale
  expect(availability.snapshot()).toEqual({ phase: 'ready' })
  availability.stop()
  await availability.refresh()
  expect(availability.snapshot()).toEqual({ phase: 'ready' })
  expect(notified).toBe(1)
})
