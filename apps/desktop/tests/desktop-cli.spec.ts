/** The installed CLI uses the shared pnpm distribution with Electron's package-operation environment. */

import { delimiter, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runCli } from '@deepseek-ai/dsh/lib/bin.js'
import { runDesktopCli, runtimeArchivePath } from '../../desktop-host/src/cli.ts'

vi.mock('@deepseek-ai/dsh/lib/bin.js', () => ({ runCli: vi.fn() }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

it.each(['system-bin', undefined])('dispatches with bundled pnpm when PATH is %s', async (path) => {
  vi.stubEnv('PATH', path)
  const support = join('Application 中文 with spaces', 'resources', 'runtime')

  await runDesktopCli(support)

  expect(runCli).toHaveBeenCalledExactlyOnceWith({
    manageDesktopProfile: true,
    packageManager: {
      command: process.execPath,
      args: ['--expose-internals', join(support, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
        PATH: `${join(support, 'bin')}${delimiter}${path ?? ''}`,
      },
    },
  })
})

it('locates the archive of an ASAR-contained runtime and leaves a prepared runtime without one', () => {
  const resources = join('Application 中文', 'resources')
  expect(runtimeArchivePath(join(resources, 'app.asar', 'dsh'))).toBe(join(resources, 'app.asar'))
  expect(runtimeArchivePath(join(resources, 'app.asar.unpacked', 'dsh'))).toBeUndefined()
  expect(runtimeArchivePath(join(resources, 'dsh'))).toBeUndefined()
})
