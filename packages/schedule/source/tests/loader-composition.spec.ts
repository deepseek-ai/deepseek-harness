/** Real Loader/app composition with an owner-local, keyless expected model-input record. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/loader/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/loader/cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.base.json', import.meta.url))
const expectedPath = new URL('./expected/source-input.txt', import.meta.url)

describe('source instances through app boot and Loader', () => {
  it('combines typed observations into logged task input and releases the Loader-owned subscriptions', async () => {
    const expected = await readFile(expectedPath, 'utf8')
    await runLoaderSmoke({
      label: 'source instance composition',
      tempDirPrefix: 'dsh-source-composition-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath,
      inspect: async (cwd) => {
        expect(await readFile(join(cwd, 'source-input.txt'), 'utf8')).toBe(expected)
      },
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
