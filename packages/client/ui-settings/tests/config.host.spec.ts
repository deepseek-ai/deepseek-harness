import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import * as HostPlugin from '../src/index.ts'
import { liveConfig, omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'
import { plainConfig } from '../../../settings/settings/src/schema.ts'
import { Config, apply } from '../src/index.ts'

it('defaults on, persists valid choices and removes its schema on disposal', async () => {
  const ctx = new Context()
  const configuration = await liveConfig(ctx, { Config, apply })
  onTestFinished(() => ctx.fiber.dispose())
  expect(plainConfig(configuration.fiber.config)).toEqual({ enabled: true })
  await configuration.update({ enabled: false })
  expect(plainConfig(configuration.fiber.config)).toEqual({ enabled: false })
  await expect(configuration.update({ enabled: 'yes' })).rejects.toThrow()
  await configuration.fiber.dispose()
})

it('keeps its own instance off the generated Settings pages', () => omitsGeneratedPage(ctx => ctx.plugin(HostPlugin)))
