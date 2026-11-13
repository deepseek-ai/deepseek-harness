/** Controlled provider loss compared with composer-only disposal through the real Loader. */
import { readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

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
          const report = JSON.parse(await readFile(join(cwd, 'source-composite-lifecycle.json'), 'utf8'))
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
