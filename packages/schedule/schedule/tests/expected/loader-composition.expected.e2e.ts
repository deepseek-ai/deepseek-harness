/** Real Loader/app composition with an owner-local, keyless expected model-input record. */
import { readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('../fixtures/source/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../fixtures/source/cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../../tsconfig.base.json', import.meta.url))
const expectedPath = new URL('./source-input.txt', import.meta.url)

describe('source instances through app boot and Loader', () => {
  it('submits two ordinary source instances to logged tasks and rejects submissions after their Loader owner closes', async () => {
    const expected = await readFile(expectedPath, 'utf8')
    const authoredConfig = await readFile(configPath)
    try {
      await runLoaderSmoke({
        label: 'source instance composition',
        tempDirPrefix: 'dsh-source-composition-',
        binScript: driver,
        libBinScript: driver,
        configPath,
        binArgs: ['./cordis.yml'],
        tsconfigPath,
        prepare: async (cwd) => {
          const fixtureDir = dirname(configPath)
          let config = authoredConfig.toString('utf8')
          for (const name of ['schedule-provider.ts', 'world.ts', 'source-owner.ts']) {
            config = config.replace(`name: ./${name}`, `name: ${JSON.stringify(join(fixtureDir, name))}`)
          }
          await writeFile(join(cwd, 'cordis.yml'), config)
          // Bare Loader plugins retain this package's declared dependencies in src and lib modes.
          await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), join(cwd, 'node_modules'),
            process.platform === 'win32' ? 'junction' : 'dir')
        },
        inspect: async (cwd) => {
          expect(await readFile(join(cwd, 'source-input.txt'), 'utf8')).toBe(expected)
        },
      })
    } finally {
      expect(await readFile(configPath), 'Loader teardown must not rewrite the authored fixture').toEqual(authoredConfig)
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
