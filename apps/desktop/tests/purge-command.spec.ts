import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { z } from 'zod'
import { afterEach, expect, it } from 'vitest'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../../..', import.meta.url))
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

it('forwards the documented pnpm purge command through both package scripts to the real argument parser', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-purge-command-'))
  roots.push(directory)
  const scripts = join(directory, 'apps/desktop/scripts')
  await mkdir(scripts, { recursive: true })
  const manifest = z.object({ name: z.string(), scripts: z.object({ 'purge:latest': z.string() }) })
  const repository = manifest.parse(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')))
  const desktop = manifest.parse(JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8')))
  await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { 'purge:latest': repository.scripts['purge:latest'] } }))
  await writeFile(join(directory, 'pnpm-workspace.yaml'), 'packages:\n  - apps/desktop\n')
  await writeFile(join(directory, 'apps/desktop/package.json'), JSON.stringify({ name: desktop.name, type: 'module', scripts: { 'purge:latest': desktop.scripts['purge:latest'] } }))
  await mkdir(join(directory, 'node_modules'))
  for (const dependency of ['.bin', 'pnpm', 'tsx', 'semver']) {
    await symlink(join(root, 'node_modules', dependency), join(directory, 'node_modules', dependency), 'junction')
  }
  await copyFile(join(root, 'apps/desktop/scripts/upload-target.ts'), join(scripts, 'upload-target.ts'))
  for (const filename of ['desktop-auto-update-environment.mjs', 'desktop-build-paths.mjs']) {
    await copyFile(join(root, 'apps/desktop/scripts', filename), join(scripts, filename))
  }
  // Only command forwarding and parsing are under test; all external work fails closed.
  const stubs = {
    'desktop-package-environment.mjs': "export const loadDesktopPackageEnvironment = () => ({ DSH_DESKTOP_AUTO_UPDATE_ENV: 'production' })",
    'desktop-cos.ts': "export const createDesktopCos = () => { throw new Error('unexpected COS') }",
    'desktop-upload-plan.ts': "export const createDesktopUploadPlan = () => { throw new Error('unexpected installer read') }",
    'desktop-upload-run.ts': "export const uploadDesktopRelease = () => { throw new Error('unexpected upload') }",
    'desktop-release-tag.ts': "export const desktopReleaseTag = () => { throw new Error('unexpected tag') }; export const tagDesktopRelease = desktopReleaseTag",
    'desktop-edgeone.ts': `
      import assert from 'node:assert/strict'
      export class DesktopPurgeError extends Error {}
      export const resolveDesktopPurgeConfig = (_env, target) => ({ target })
      export const purgeDesktopInstaller = async (config) => {
        assert.equal(config.target, 'mac-arm64')
        console.log('purge-submit: mac-arm64')
      }
    `,
  }
  await Promise.all(Object.entries(stubs).map(([name, contents]) => writeFile(join(scripts, name), contents)))
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^DSH_|^DOWNLOAD_|^PACKAGE_/iu.test(name)))
  const args = [join(root, 'node_modules/pnpm/bin/pnpm.mjs'), 'run', 'purge:latest', 'mac-arm64']
  const result = await execute(process.execPath, args, { cwd: directory, env, timeout: 30_000 }).catch((error: unknown) => {
    expect(error).not.toMatchObject({ killed: true })
    throw error
  })
  expect(result.stdout).toContain('purge-submit: mac-arm64')
})
