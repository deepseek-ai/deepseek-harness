/** Select isolated qualification inputs without weakening the ordinary Windows installer or signing hooks. */
import { join } from 'node:path'
import { createElectronBuilderConfig } from './electron-builder-config.mjs'
import { readInstalledUpdateRun } from './installed-update-qualification.ts'
import { verifyInstalledUpdateApplication } from './prepare-installed-update-application.ts'
import { verifyDesktopRuntime } from '../src/runtime-tree.ts'

/**
 * Validate one version and construct its signed-only, test-only builder configuration.
 * @param manifest Original run.json with prepared runtime and application files.
 * @param version One of the run's two versions.
 * @param environment File-owned .env.windows settings loaded by a supervised caller; never logged here.
 * @returns Configuration only. Calling builder hooks requires separate hardware authorization and supervision.
 */
export async function createInstalledUpdateBuilderConfig(manifest: string, version: string, environment: NodeJS.ProcessEnv) {
  const run = await readInstalledUpdateRun(manifest)
  if (!run.versions.includes(version)) throw new Error('installed update: package version is outside the qualification run')
  if (environment.DSH_DESKTOP_AUTO_UPDATE_ENV !== 'test' || environment.DSH_DESKTOP_UNSIGNED === '1'
    || environment.DOWNLOAD_TEST_ORIGIN !== run.origin || environment.DOWNLOAD_TEST_COS_BUCKET !== run.bucket) {
    throw new Error('installed update: signed ordinary-update qualification requires matching test deployment settings')
  }
  const application = await verifyInstalledUpdateApplication(run.root)
  const dsh = join(run.root, version, 'dsh')
  await verifyDesktopRuntime(dsh, version, { platform: 'win32', arch: 'x64' })
  const config = createElectronBuilderConfig({ ...environment, DSH_DESKTOP_APP_ID: run.appId,
    DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64', DSH_DESKTOP_UNSIGNED: '0' }, 'win32', 'x64', dsh, version)
  return { ...config,
    productName: run.productName,
    directories: { ...config.directories, output: join(run.root, version, 'installer') },
    extraMetadata: { ...config.extraMetadata, name: `dsh-update-test-${run.id}`, version, main: 'qualification-bootstrap.mjs' },
    files: [
      { from: application, to: '.', filter: ['lib/*.js', 'lib/*.cjs', 'renderer/**/*', 'qualification-bootstrap.mjs', 'installed-update-identity.mjs'] },
      'package.json',
      { from: dsh, to: 'dsh', filter: ['**/*'] },
      { from: join(dsh, 'node_modules'), to: 'dsh/node_modules', filter: ['**/*'] },
    ],
    publish: [{ provider: 'generic' as const, url: `${run.origin}/${run.feedKey.slice(0, -'nightly.yml'.length)}`, channel: 'nightly' }],
  }
}
