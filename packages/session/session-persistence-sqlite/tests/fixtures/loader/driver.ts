#!/usr/bin/env node
/** Test driver that sends one turn through the Headless Loader composition with the SQLite provider. */

import { resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import { bootProductionProfile } from '../../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('event-rows driver requires a config path')

const ctx = await bootProductionProfile({
  binName: 'sqlite-event-rows-e2e',
  profile: 'headless',
  overlayPaths: [resolveConfigPath(configPath, undefined)],
})
try {
  await runFixtureTurn(ctx, { task: 'run the shell tool once' })
} finally {
  await ctx.fiber.dispose()
}
