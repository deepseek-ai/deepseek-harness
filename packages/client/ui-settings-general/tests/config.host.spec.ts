/** Onboarding state uses live Config fields. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import * as HostPlugin from '../src/index.ts'
import { liveConfig, omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'
import { plainConfig } from '../../../settings/settings/src/schema.ts'
import * as General from '../src/index.ts'

it('validates and updates onboarding preferences without remounting', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const configuration = await liveConfig(ctx, General)
  await configuration.update({ welcomeNoticeVersion: 'v1' })
  expect(plainConfig(configuration.fiber.config)).toMatchObject({ welcomeNoticeVersion: 'v1' })
  expect(configuration.entry.fiber).toBe(configuration.fiber)
})

it('keeps its own instance off the generated Settings pages', () => omitsGeneratedPage(ctx => ctx.plugin(HostPlugin)))
