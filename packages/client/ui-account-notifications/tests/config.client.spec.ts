/** Notification configuration reaches the client without account secrets. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import type { IndexInjection, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { apply, Config } from '../src/index.ts'
import { NOTIFICATIONS_CONFIG_GLOBAL } from '../src/config.ts'

it('publishes polling configuration and removes the publisher on disposal', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin({ apply, Config }, { notificationPollIntervalMs: 250 })
  const table: IndexInjection[] = []
  const peer = { principal: { kind: 'owner' } } as Parameters<WebServer['renderIndex']>[1]
  ctx.emit('webserver/index-inject', table, peer)
  expect(table).toEqual([{ kind: 'global', name: NOTIFICATIONS_CONFIG_GLOBAL, value: { notificationPollIntervalMs: 250 } }])
  await ctx.fiber.dispose()
  table.length = 0
  ctx.emit('webserver/index-inject', table, peer)
  expect(table).toEqual([])
})

it('defaults to ten minutes and rejects intervals outside browser timer limits', () => {
  expect(Config({}).notificationPollIntervalMs).toBe(600_000)
  for (const notificationPollIntervalMs of [0, -1, 1.5, 2_147_483_648]) {
    expect(() => Config({ notificationPollIntervalMs })).toThrow()
  }
})
