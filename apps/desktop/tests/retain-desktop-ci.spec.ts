import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { desktopReleasesRoot, retainDesktopCi } from '../scripts/retain-desktop-ci.ts'
import { verifyRetainedDesktopRelease } from '../scripts/desktop-release-store.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it.each(['mac-arm64', 'win-x64'] as const)('retains the complete %s release without signing or upload credentials', async (target) => {
  const root = await mkdtemp(join(tmpdir(), 'retain-ci-'))
  roots.push(root)
  const appRoot = join(root, 'checkout')
  const config = join(root, 'packaging')
  const artifacts = join(appRoot, '.desktop-build', 'targets', target, 'artifacts')
  await mkdir(artifacts, { recursive: true })
  await mkdir(join(config, 'presets'), { recursive: true })
  await writeFile(join(appRoot, 'package.json'), '{"version":"1.0.0"}')
  await writeFile(join(config, 'presets/test.env'), `DSH_DESKTOP_AUTO_UPDATE_ENV=test\nDOWNLOAD_TEST_RELEASE_ID=${'a'.repeat(32)}\n`)
  const names = target === 'win-x64'
    ? ['deepseek-harness-1.0.0-win-x64.exe', 'deepseek-harness-1.0.0-win-x64.exe.blockmap', 'win-x64-release.json', 'nightly.yml']
    : ['deepseek-harness-1.0.0-mac-arm64.dmg', 'deepseek-harness-1.0.0-mac-arm64.zip', 'deepseek-harness-1.0.0-mac-arm64.zip.blockmap', 'mac-arm64-release.json', 'nightly-mac.yml']
  await Promise.all(names.map(name => writeFile(join(artifacts, name), 'fixture')))
  const env = {
    DSH_PACKAGING_CONFIG_DIR: config, DSH_PACKAGING_PRESET: 'test', DSH_DESKTOP_TARGET_PLATFORM: target === 'win-x64' ? 'win32' : 'darwin',
    DSH_DESKTOP_TARGET_ARCH: target === 'win-x64' ? 'x64' : 'arm64', PACKAGE_SOURCE_REF: 'master', PACKAGE_SOURCE_SHA: 'b'.repeat(40), PACKAGE_VERSION: '1.0.0', PACKAGE_PUBLISH: 'true',
    PACKAGE_SIGNING: 'signed', PACKAGE_SKIP_NOTARIZATION: 'false', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2',
    GITHUB_REPOSITORY: 'owner/repository', GITHUB_SHA: 'b'.repeat(40), RUNNER_NAME: 'dedicated',
  }
  await retainDesktopCi(env, appRoot)
  const manifest = await verifyRetainedDesktopRelease(desktopReleasesRoot(env), '123', '2')
  expect(manifest.files.map(file => file.name)).toEqual(names)
  expect(manifest.source).toMatchObject({ target, publishRequested: true, qualification: target === 'win-x64' ? 'signed' : 'notarized' })
  await expect(retainDesktopCi({ ...env, PACKAGE_SIGNING: 'unsigned', PACKAGE_SKIP_NOTARIZATION: 'true' }, appRoot))
    .rejects.toThrow(/publishing requires/u)
})
