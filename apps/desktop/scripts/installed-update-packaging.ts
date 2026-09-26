/** Supervise one explicitly confirmed qualification build; checks never launch a child or clear a signing interlock. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readInstalledUpdateRun } from './installed-update-qualification.ts'
import { createInstalledUpdateBuilderConfig } from './installed-update-builder.ts'
import { loadDesktopPackageEnvironment } from './desktop-package-environment.mjs'
import { desktopElectronBuilderEnvironment } from './package-target.ts'
import { createPackagingRun, recordPackagingEvent } from './packaging-run.mjs'
import { planInstalledUpdateDistribution } from './installed-update-distribution.ts'

const APP_ROOT = resolve(import.meta.dirname, '..')
const REPOSITORY = resolve(APP_ROOT, '../..')
const SIGNING_FIELDS = new Set(['DSH_DESKTOP_WINDOWS_CER_FILE', 'DSH_DESKTOP_WINDOWS_SIGNTOOL',
  'DSH_DESKTOP_WINDOWS_KEY_CONTAINER', 'DSH_DESKTOP_WINDOWS_TOKEN_PIN'])

/** Public refusal without credential values or contents of the incident record. */
export class InstalledUpdateSigningHoldError extends Error {
  constructor() {
    super('installed update: signing interlock exists; administrator-reviewed recovery is required; do not clear it or retry automatically')
  }
}

async function absent(path: string): Promise<boolean> {
  try { await lstat(path); return false }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

/**
 * Reject a retained or active hardware attempt without reading its contents or changing it.
 * @param stateFile Per-user signing interlock; an isolated file may be supplied by tests, not the CLI.
 * @returns Nothing when absent; an inaccessible or existing file rejects before credentials are loaded.
 */
export async function assertInstalledUpdateSigningClear(stateFile = join(homedir(), '.dsh-desktop-signing', 'attempt.json')): Promise<void> {
  if (!await absent(stateFile)) throw new InstalledUpdateSigningHoldError()
}

/**
 * Restrict builder children to ordinary tool settings and the four file-owned signing inputs.
 * @param environment Loaded .env.windows settings, never raw log data.
 * @returns A new environment without upload/LLM credentials or Node preload overrides.
 */
export function installedUpdatePackagingEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return desktopElectronBuilderEnvironment(Object.fromEntries(Object.entries(environment)
    .filter(([name]) => SIGNING_FIELDS.has(name) || !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^NODE_PATH$/iu.test(name))), false)
}

async function inputHashes(manifest: string, version: string, environment: NodeJS.ProcessEnv): Promise<object> {
  const run = await readInstalledUpdateRun(manifest)
  const paths = [manifest, join(run.root, 'application/result.json'), join(run.root, version, 'dsh/desktop-runtime.json'),
    join(REPOSITORY, 'pnpm-lock.yaml'), join(APP_ROOT, 'package.json'),
    ...['electron-builder-config.mjs', 'installed-update-builder.ts', 'build-installed-update-worker.mjs',
      'windows-sign.mjs', 'windows-sign.cmd', 'windows-signing-state.mjs', 'windows-timestamp.mjs', 'windows-directory-installer.mjs',
      'installer.nsh', 'prepare-windows-installer.ps1'].map(path => join(import.meta.dirname, path)),
    environment.DSH_DESKTOP_WINDOWS_CER_FILE!, environment.DSH_DESKTOP_WINDOWS_SIGNTOOL!]
  const files = []
  for (const path of paths) {
    files.push({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') })
  }
  const git = (args: string[]): string => execFileSync('git', args, { cwd: REPOSITORY, windowsHide: true, encoding: 'utf8' }).trim()
  return { files, sourceCommit: git(['rev-parse', 'HEAD']),
    dirtyFiles: git(['status', '--porcelain=v1', '--untracked-files=normal']).split('\n').filter(Boolean),
    dependenciesByteFrozen: false }
}

/**
 * Check, or after explicit confirmation build, exactly one version with retained fail-stop records.
 * @param manifest Existing test-only run manifest.
 * @param version One exact run version; an existing packaging attempt or installer refuses reuse.
 * @param options Execute selection and operator confirmation; the CLI has no noninteractive approval shortcut.
 * @returns Check/build observations only. A successful builder is not package verification or installation acceptance.
 */
export async function packageInstalledUpdate(
  manifest: string, version: string, options: { execute: boolean; confirm: (id: string, version: string) => Promise<boolean> },
): Promise<object> {
  const run = await readInstalledUpdateRun(manifest)
  if (!run.versions.includes(version)) throw new Error('installed update: package version is outside the run')
  await assertInstalledUpdateSigningClear()
  const preparation = join(run.root, version, 'packaging')
  const output = join(run.root, version, 'installer')
  if (!await absent(preparation) || !await absent(output)) throw new Error('installed update: existing packaging attempt or output requires a new run')
  const environment = installedUpdatePackagingEnvironment({ ...loadDesktopPackageEnvironment('win32'),
    DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64' })
  await createInstalledUpdateBuilderConfig(manifest, version, environment)
  const before = await inputHashes(manifest, version, environment)
  if (!options.execute) return { mode: 'check', version, childLaunched: false, signed: false, publicationAuthorized: false }
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('installed update: execution requires Windows x64')
  if (!await options.confirm(run.id, version)) throw new Error('installed update: operator did not confirm this version')
  await assertInstalledUpdateSigningClear()
  await mkdir(preparation)
  const record = createPackagingRun(preparation, { mode: 'operator-authorized-single-version', id: run.id, version })
  console.log(`INSTALLED_UPDATE_PACKAGING_RECORD ${record.directory}`)
  let success = false
  try {
    await mkdir(output)
    await writeFile(join(record.directory, 'inputs.json'), `${JSON.stringify(before, null, 2)}\n`, { flag: 'wx', flush: true })
    if (JSON.stringify(await inputHashes(manifest, version, environment)) !== JSON.stringify(before)) {
      throw new Error('installed update: recorded source or tool inputs changed before packaging')
    }
    await record.run('signed-installer', process.execPath,
      ['--import', 'tsx', join(import.meta.dirname, 'build-installed-update-worker.mjs'), resolve(manifest), version],
      { cwd: REPOSITORY, env: environment, timeoutMs: 15 * 60_000 })
    await createInstalledUpdateBuilderConfig(manifest, version, environment)
    if (JSON.stringify(await inputHashes(manifest, version, environment)) !== JSON.stringify(before)) {
      throw new Error('installed update: recorded source or tool inputs changed during packaging')
    }
    const files = await planInstalledUpdateDistribution(manifest, version)
    await writeFile(join(record.directory, 'artifact-files.json'), `${JSON.stringify(files, null, 2)}\n`, { flag: 'wx', flush: true })
    const result = { version, builderCompleted: true, packageVerification: 'pending', installerExecuted: false, published: false }
    await writeFile(join(record.directory, 'builder-result.json'), `${JSON.stringify(result)}\n`, { flag: 'wx', flush: true })
    success = true
    return result
  } catch (error) {
    recordPackagingEvent(record.directory, { type: 'qualification-failed', retryAllowed: false })
    throw error
  } finally { record.finish(success) }
}
