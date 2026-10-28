import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { platform } from 'node:os'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

it('adds real system metadata to the existing event through Loader and OTLP', async () => {
  const driver = resolve(import.meta.dirname, 'fixtures/environment.host.ts')
  let captured: unknown
  const attribute = z.object({ key: z.string(), value: z.object({
    stringValue: z.string().optional(), intValue: z.number().optional(),
  }).strict() })
  const record = z.object({ eventName: z.string(), attributes: z.array(attribute) })
  const batch = z.object({ resourceLogs: z.array(z.object({ scopeLogs: z.array(z.object({ logRecords: z.array(record) })) })) })
  const schema = z.object({ captures: z.array(batch), reference: z.record(z.string(), z.union([z.string(), z.number()])) })
  await runLoaderSmoke({
    label: 'Desktop environment attributes', tempDirPrefix: 'product-environment-',
    binScript: driver, libBinScript: driver,
    configPath: resolve(import.meta.dirname, 'fixtures/environment.patch.yml'),
    tsconfigPath: resolve(import.meta.dirname, '../../../../tsconfig.base.json'),
    inspect: async (cwd) => { captured = JSON.parse(await readFile(resolve(cwd, 'captures.json'), 'utf8')) },
  })
  const result = schema.parse(captured)
  const records = result.captures.flatMap(batch => batch.resourceLogs
    .flatMap(resource => resource.scopeLogs.flatMap(scope => scope.logRecords)))
  expect(records).toHaveLength(1)
  expect(records[0]!.eventName).toBe('desktop_app_launch')
  const fields = Object.fromEntries(records[0]!.attributes.map(attribute => [attribute.key, attribute.value]))
  for (const [key, value] of Object.entries(result.reference)) {
    expect(fields[key]).toEqual(typeof value === 'number' ? { intValue: value } : { stringValue: value })
  }
  if (platform() === 'win32' || platform() === 'darwin') {
    expect(fields).not.toHaveProperty('missing_fields')
    expect(fields.cpu_model?.stringValue).toBeTruthy()
  }
  if (platform() === 'win32') expect(fields.os_version_full?.stringValue).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
  expect(fields.app_version).toEqual({ stringValue: 'synthetic-release' })
  expect(fields).not.toHaveProperty('device_id')
  expect(fields).not.toHaveProperty('user_id')
  expect(JSON.stringify(result.captures)).not.toMatch(/serial_number|hostname|device_uuid|environment_schema_version/)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
