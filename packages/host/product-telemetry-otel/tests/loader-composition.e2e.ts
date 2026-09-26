import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

it('exports the explicitly submitted event through the headless Loader composition', async () => {
  let captures: unknown
  const driver = resolve(import.meta.dirname, 'fixtures/driver.ts')
  await runLoaderSmoke({
    label: 'product telemetry composition',
    tempDirPrefix: 'product-telemetry-',
    binScript: driver,
    libBinScript: driver,
    configPath: resolve(import.meta.dirname, 'fixtures/telemetry.patch.yml'),
    tsconfigPath: resolve(import.meta.dirname, '../../../../tsconfig.base.json'),
    inspect: async (cwd) => { captures = JSON.parse(await readFile(resolve(cwd, 'captures.json'), 'utf8')) },
  })
  expect(captures).toMatchObject([{
    channel: 'dsh_otel_report', compression: 'gzip',
    body: { resourceLogs: [{ scopeLogs: [{ logRecords: [{ eventName: 'telemetry.synthetic', body: { stringValue: 'Synthetic test' } }] }] }] },
  }])
  expect(JSON.stringify(captures).match(/"eventName"/g)).toHaveLength(1)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
