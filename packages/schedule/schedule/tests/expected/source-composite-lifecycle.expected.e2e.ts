/** Controlled provider loss compared with composer-only disposal through the real Loader. */
import { readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const countsSchema = z.looseObject({
  messages: z.number(), inbox: z.number(), receipts: z.number(), requests: z.number(),
})
const reportSchema = z.looseObject({
  outcome: z.looseObject({ status: z.string() }),
  beforeRelease: z.looseObject({
    receiverCleanup: z.boolean(), disposalDone: z.boolean(), providerActive: z.boolean(), worldActive: z.boolean(),
  }),
  events: z.array(z.string()),
  primary: countsSchema,
  replacement: countsSchema.optional(),
})

const sampleReport = {
  outcome: { status: 'fulfilled' },
  beforeRelease: { receiverCleanup: false, disposalDone: false, providerActive: false, worldActive: true },
  events: ['composite-drained', 'receiver-cleanup', 'sender-fulfilled', 'disposal-done'],
  primary: { messages: 1, inbox: 1, receipts: 1, requests: 1 },
  replacement: { messages: 2, inbox: 2, receipts: 2, requests: 2 },
}

it('source composite report schema rejects missing or mistyped events and counts', () => {
  expect(reportSchema.parse(JSON.parse(JSON.stringify(sampleReport)))).toEqual(sampleReport)
  const changes = [
    { events: undefined },
    { events: 'composite-drained' },
    { events: [1] },
    { primary: undefined },
    { primary: { inbox: 1, receipts: 1, requests: 1 } },
    { primary: { ...sampleReport.primary, messages: '1' } },
    { replacement: { ...sampleReport.replacement, receipts: '2' } },
  ]
  for (const change of changes) {
    const json = JSON.stringify({ ...sampleReport, ...change })
    expect(() => reportSchema.parse(JSON.parse(json)), json).toThrow(z.ZodError)
  }
})

it.each(['outcome', 'beforeRelease', 'primary', 'replacement'] as const)(
  'source composite report schema retains extra fields in %s for exact comparison',
  (field) => {
    const json = JSON.stringify({ ...sampleReport, [field]: { ...sampleReport[field], extra: 'retained' } })
    const parsed = reportSchema.parse(JSON.parse(json))
    expect(parsed[field]).toHaveProperty('extra', 'retained')
    expect(parsed[field]).not.toEqual(sampleReport[field])
  },
)

const driver = fileURLToPath(new URL('../fixtures/source-composite-lifecycle/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../fixtures/source/cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../../tsconfig.base.json', import.meta.url))

it('compares accepted composite delivery during provider and composer teardown', async () => {
  const authoredConfig = await readFile(configPath)
  const modes = ['provider', 'composer']
  try {
    for (const mode of modes) {
      await runLoaderSmoke({
        label: `source composite lifecycle ${mode}`,
        tempDirPrefix: 'dsh-source-composite-lifecycle-',
        binScript: driver,
        libBinScript: driver,
        configPath,
        binArgs: ['./cordis.yml', mode],
        tsconfigPath,
        prepare: async (cwd) => {
          let config = authoredConfig.toString('utf8')
          config = config.replace('name: ./schedule-provider.ts',
            `name: ${JSON.stringify(join(dirname(configPath), 'schedule-provider.ts'))}`)
          config = config.replace('- name: ./world.ts',
            `- id: lifecycle-world\n  name: ${JSON.stringify(join(dirname(driver), 'world.ts'))}`)
          config = config.replace('name: ./source-owner.ts',
            `name: ${JSON.stringify(join(dirname(driver), 'owner.ts'))}\n  disabled: true`)
          await writeFile(join(cwd, 'cordis.yml'), config)
          await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), join(cwd, 'node_modules'),
            process.platform === 'win32' ? 'junction' : 'dir')
        },
        inspect: async (cwd) => {
          const report = reportSchema.parse(JSON.parse(await readFile(join(cwd, 'source-composite-lifecycle.json'), 'utf8')))
          console.info(JSON.stringify(report))
          expect.soft(report.outcome).toEqual({ status: 'fulfilled' })
          expect.soft(report.beforeRelease).toEqual({
            receiverCleanup: false,
            disposalDone: false,
            providerActive: mode === 'composer',
            worldActive: true,
          })
          expect.soft(report.events).toContain('composite-drained')
          expect.soft(report.events.indexOf('receiver-cleanup')).toBeGreaterThan(report.events.indexOf('composite-drained'))
          expect.soft(report.events.indexOf('disposal-done')).toBeGreaterThan(report.events.indexOf('sender-fulfilled'))
          expect.soft(report.primary).toEqual({ messages: 1, inbox: 1, receipts: 1, requests: 1 })
          if (mode !== 'composer') {
            expect.soft(report.replacement).toEqual({ messages: report.primary.messages + 1,
              inbox: report.primary.inbox + 1, receipts: report.primary.receipts + 1, requests: report.primary.requests + 1 })
          }
        },
      })
    }
  } finally {
    expect(await readFile(configPath)).toEqual(authoredConfig)
  }
}, 2 * LOADER_SMOKE_TEST_TIMEOUT_MS)
