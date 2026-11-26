/** Source delivery preserves file policy through the shipped CLI and real write executor. */
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SESSION_FORMAT_VERSION, type SessionId } from '@deepseek-ai/dsh-session'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleMode, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { assertPersistedSessionVersion, latestPersistedSessionPaths, materializeProfilePatch } from '@deepseek-ai/dsh-session-snapshot'
import { assertSourceWriteDenied, observeSourceWrite } from '../fixtures/source-task-input-confinement/verify.ts'

const root = new URL('../../../../../', import.meta.url)
const overlay = fileURLToPath(new URL('../fixtures/source-task-input-confinement/cordis.yml', import.meta.url))
const headerSchema = z.object({ id: z.string().min(1).transform(brandString<SessionId>) })

it.each(['read-only', 'workspace-write'] as const)(
  'Source task input preserves %s through the real write executor',
  async (permission) => {
    await runLoaderSmoke({
      label: `Source input file policy ${permission}`,
      tempDirPrefix: 'dsh-source-input-policy-',
      mode: resolveExampleMode(),
      binScript: fileURLToPath(new URL('apps/cli/src/bin.ts', root)),
      sourceImport: 'tsx/esm',
      tsconfigPath: fileURLToPath(new URL('tsconfig.base.json', root)),
      configPath: overlay,
      binArgs: [
        '--profile', 'headless', '--patch', '.patches/0-cordis.yml',
        'Wait for both source observations, then attempt to write source-confinement-sentinel.txt once.',
      ],
      env: { DSH_PERMISSION_MODE: permission, DSH_TELEMETRY_DISABLED: '1' },
      prepare: async (cwd) => {
        const patches = join(cwd, '.patches')
        await mkdir(patches)
        materializeProfilePatch(overlay, cwd, 'headless', patches, 0)
      },
      inspect: async (cwd) => {
        const sessions = join(cwd, '.dsh/sessions')
        const files = latestPersistedSessionPaths(await readdir(sessions, { recursive: true }))
        assert.equal(files.length, 1, 'exactly one private destination Session must persist')
        const file = files[0]!
        const log = await readFile(join(sessions, file), 'utf8')
        assert.equal(assertPersistedSessionVersion(basename(file), log), SESSION_FORMAT_VERSION)
        const header = headerSchema.parse(JSON.parse(log.split('\n')[0]!))
        const observation = await observeSourceWrite(log, header.id, cwd)
        if (permission === 'read-only') {
          assertSourceWriteDenied(observation)
          return
        }
        assert.deepEqual(observation, {
          isError: false, errorName: undefined, errorCode: undefined, fileExists: true,
        }, 'the permission-only control must execute the real write successfully')
        assert.equal(await readFile(join(cwd, 'source-confinement-sentinel.txt'), 'utf8'), 'Source write reached the filesystem.\n')
        assert.throws(() => { assertSourceWriteDenied(observation) }, {
          name: 'AssertionError', code: 'ERR_ASSERTION',
          message: /Source-triggered write must be denied by the filesystem policy without creating a file/u,
        })
      },
    })
  },
  LOADER_SMOKE_TEST_TIMEOUT_MS,
)
