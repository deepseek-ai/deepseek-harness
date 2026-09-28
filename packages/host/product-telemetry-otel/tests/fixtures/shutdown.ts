/** Product telemetry disposal must leave the Host free to exit naturally. */
import type {} from '@deepseek-ai/dsh-host-product-telemetry-otel'
import { bootProductionProfile } from '../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'
import { createProcessShutdown } from '../../../../../apps/cli/src/process-shutdown.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('product telemetry fixture requires an overlay')
const ctx = await bootProductionProfile({ binName: 'product-telemetry-shutdown-test', profile: 'headless', overlayPaths: [configPath] })
const telemetry = ctx.get('productTelemetry')
if (telemetry === undefined) throw new Error('product telemetry did not activate')
telemetry.emit({ eventName: 'telemetry.synthetic', timestamp: 1_800_000_000_000, body: 'Synthetic test' })
await createProcessShutdown(() => ctx.fiber.dispose(), () => { process.exit(2) }).shutdown(0)
