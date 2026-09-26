import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as HostPlugin from '../src/index.ts'
import { liveConfig, omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'
import { plainConfig } from '../../../settings/settings/src/schema.ts'
import {
  DEFAULT_TRANSCRIPT_VIEW_MODE, Config, apply,
} from '../src/index.ts'


describe('ui-chat Host settings', () => {
  it('registers, validates, and disposes the transcript-view namespace', async () => {
    const ctx = new Context()
    const configuration = await liveConfig(ctx, { Config, apply })
    const { fiber } = configuration

    expect(plainConfig(configuration.fiber.config)).toEqual({ transcriptView: DEFAULT_TRANSCRIPT_VIEW_MODE, performanceUsage: 'detailed', linkOpening: 'sidebar' })
    await configuration.update({ transcriptView: 'normal' })
    expect(plainConfig(configuration.fiber.config)).toEqual({ transcriptView: 'normal', performanceUsage: 'detailed', linkOpening: 'sidebar' })
    for (const mode of ['expanded', 'compact', 'standard', 'detailed', 'verbose']) {
      await configuration.update({ transcriptView: mode })
      expect(plainConfig(configuration.fiber.config)).toMatchObject({ transcriptView: mode })
    }
    for (const mode of ['dense', '', 42, false, {}, null, undefined]) {
      await configuration.update({ transcriptView: mode })
      expect(plainConfig(configuration.fiber.config)).toMatchObject({ transcriptView: 'standard' })
    }
    await configuration.update({ performanceUsage: 'compact' })
    expect(plainConfig(configuration.fiber.config)).toMatchObject({ performanceUsage: 'compact' })
    await expect(configuration.update({ performanceUsage: 'hidden' })).rejects.toThrow()
    await configuration.update({ linkOpening: 'new-tab' })
    expect(plainConfig(configuration.fiber.config)).toMatchObject({ linkOpening: 'new-tab' })
    await expect(configuration.update({ linkOpening: 'popup' })).rejects.toThrow()

    await fiber.dispose()
  })

  it('loads without a settings provider', async () => {
    const ctx = new Context()
    await expect(ctx.plugin({ Config, apply }).await()).resolves.toBeDefined()
  })
})

it('keeps its own instance off the generated Settings pages', () => omitsGeneratedPage(ctx => ctx.plugin(HostPlugin)))
