/** Latest-wins readiness inspections, failure publication, and disposal. */
import { expect, it } from 'vitest'
import type { SpeechPreparationState } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { CloudReadiness } from '../src/availability.ts'

it('publishes only the latest inspection and nothing after disposal', async () => {
  const pending: ((state: SpeechPreparationState) => void)[] = []
  const readiness = new CloudReadiness(() => new Promise((resolve) => { pending.push(resolve) }))
  const seen: SpeechPreparationState[] = []
  const unsubscribe = readiness.subscribe(() => { seen.push(readiness.snapshot()) })
  expect(readiness.snapshot()).toEqual({ phase: 'unavailable', reason: 'sign-in-required' })
  const first = readiness.refresh(), second = readiness.refresh()
  pending[1]!({ phase: 'ready' }); await second
  pending[0]!({ phase: 'failed', message: 'stale' }); await first
  expect(seen).toEqual([{ phase: 'ready' }])
  unsubscribe()
  const third = readiness.refresh()
  pending[2]!({ phase: 'unavailable', reason: 'sign-in-required' }); await third
  expect(seen).toHaveLength(1)
  readiness.dispose()
  const fourth = readiness.refresh()
  pending[3]!({ phase: 'failed', message: 'late' }); await fourth
  expect(readiness.snapshot()).toEqual({ phase: 'unavailable', reason: 'sign-in-required' })
})

it('publishes inspection failures as failed readiness and re-inspects on prepare', async () => {
  const errors = [new Error('credential store locked'), 'store offline']
  let inspections = 0
  const readiness = new CloudReadiness(async () => { inspections++; throw errors.shift() })
  await readiness.refresh()
  expect(readiness.snapshot()).toEqual({ phase: 'failed', message: 'credential store locked' })
  readiness.prepare()
  await readiness.cancel()
  await Promise.resolve()
  expect(inspections).toBe(2)
  expect(readiness.snapshot()).toEqual({ phase: 'failed', message: 'store offline' })
})
