/** Published/source Loader composition preserves old projection plugins and bounded diagnostics. */
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

it('loads a legacy projection plugin, reads Session state, and warns once for its deprecated keyed read', async () => {
  const driver = fileURLToPath(new URL('./fixtures/driver.ts', import.meta.url))
  const { stdout } = await runLoaderSmoke({
    label: 'legacy projection registration',
    tempDirPrefix: 'dsh-projection-compatibility-',
    binScript: driver,
    libBinScript: driver,
    configPath: fileURLToPath(new URL('./fixtures/cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
  })
  expect(stdout.trim()).toBe(JSON.stringify({
    first: 1,
    second: 2,
    values: { 'fixture/legacy-projection': 2 },
    released: null,
    warnings: ['sessionProjections.stateOf(session, "fixture/legacy-projection") is deprecated; read handle.stateOf(session) from an awaited registration, or use the owning domain service'],
  }))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
