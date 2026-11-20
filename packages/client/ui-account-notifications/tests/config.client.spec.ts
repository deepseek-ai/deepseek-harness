/** Notification polling configuration declared on the Host and synced to the browser. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { apply, Config } from '../src/index.ts'

it('registers no Host behavior', () => {
  expect(() => { apply(new Context(), Config({})) }).not.toThrow()
})

it('defaults to ten minutes and rejects intervals outside browser timer limits', () => {
  expect(Config({}).notificationPollIntervalMs.get()).toBe(600_000)
  expect(Config({ notificationPollIntervalMs: 2_147_483_647 }).notificationPollIntervalMs.get()).toBe(2_147_483_647)
  for (const notificationPollIntervalMs of [0, -1, 1.5, 2_147_483_648]) {
    expect(() => Config({ notificationPollIntervalMs })).toThrow()
  }
})
