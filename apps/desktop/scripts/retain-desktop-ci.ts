/** Retain completed CI packages for later manual publication. */
import { appendFile, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { desktopTargetBuildPaths, resolveDesktopBuildTarget } from './desktop-build-paths.mjs'
import { desktopBuildRecordFilename, desktopUpdateMetadataFilename, resolveDesktopUpdateChannel } from './desktop-auto-update-environment.mjs'
import { loadDesktopPackageEnvironment } from './desktop-package-environment.mjs'
import { retainDesktopRelease, type DesktopRetainedSource } from './desktop-release-store.ts'
import { validateDesktopBuildVersion } from './desktop-build-version.mjs'
import { desktopPublishRunnersSchema } from './desktop-publish-targets.ts'
import { desktopPublishQualificationError } from './desktop-publish-qualification.mjs'

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`desktop retention: ${name} is required`)
  return value
}

/**
 * Resolve the persistent release root without assuming a particular user's home directory.
 * @param env Machine packaging configuration; an explicit releases directory overrides its sibling default.
 * @returns Absolute directory outside the disposable checkout.
 */
export function desktopReleasesRoot(env: NodeJS.ProcessEnv): string {
  const configured = required(env, 'DSH_PACKAGING_CONFIG_DIR')
  const root = env.DSH_DESKTOP_RELEASES_DIR || join(dirname(configured), 'releases')
  if (!isAbsolute(configured) || !isAbsolute(root)) throw new Error('desktop retention: machine directories must be absolute')
  return root
}

/**
 * Resolve the original machine's unique label before expensive packaging work.
 * @param env Machine identity, target and administrator-owned runner mapping.
 * @returns The exact label used by the later GitHub archival job.
 */
export function resolveDesktopRetentionRunner(env: NodeJS.ProcessEnv): string {
  const target = resolveDesktopBuildTarget(env)
  const routes = desktopPublishRunnersSchema.parse(JSON.parse(required(env, 'DESKTOP_PUBLISH_RUNNERS')))
  const route = routes[required(env, 'RUNNER_NAME')]
  if (!route || !route.target.includes(target)
    || new Set(Object.values(routes).map(item => item.label)).size !== Object.keys(routes).length) {
    throw new Error('desktop retention: original machine requires a unique artifact routing label')
  }
  return route.label
}

/**
 * Save the complete installer inventory for a successful package job, without reading signing secrets.
 * @param env Actions identity, resolved package version and machine preset selection.
 * @param appRoot Desktop checkout directory; defaults to this script's owning app.
 * @returns Retained directory, including explicitly qualified debugging packages.
 */
export async function retainDesktopCi(env: NodeJS.ProcessEnv, appRoot = resolve(import.meta.dirname, '..')): Promise<string> {
  const target = resolveDesktopBuildTarget(env)
  const runnerLabel = resolveDesktopRetentionRunner(env)
  const windows = target === 'win-x64'
  const platform = windows ? 'win32' : 'darwin'
  const settings = loadDesktopPackageEnvironment(platform, env, appRoot, { unsigned: true })
  const preset = settings.DSH_PACKAGING_PRESET
  if (preset !== 'test' && preset !== 'production') throw new Error('desktop retention: a machine preset is required')
  if (windows && !['signed', 'unsigned'].includes(env.PACKAGE_SIGNING ?? '')) throw new Error('desktop retention: invalid signing selection')
  if (!windows && !['true', 'false'].includes(env.PACKAGE_SKIP_NOTARIZATION ?? '')) throw new Error('desktop retention: invalid notarization selection')
  const qualification = windows ? (env.PACKAGE_SIGNING === 'signed' ? 'signed' : 'unsigned')
    : (env.PACKAGE_SKIP_NOTARIZATION === 'true' ? 'unnotarized' : 'notarized')
  const product: { version: string } = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'))
  const version = validateDesktopBuildVersion(required(env, 'PACKAGE_VERSION'), product.version)
  const source: DesktopRetainedSource = {
    repository: required(env, 'GITHUB_REPOSITORY'), runId: required(env, 'GITHUB_RUN_ID'),
    attempt: required(env, 'GITHUB_RUN_ATTEMPT'), commit: required(env, 'PACKAGE_SOURCE_SHA'),
    workflowCommit: required(env, 'GITHUB_SHA'), sourceRef: required(env, 'PACKAGE_SOURCE_REF'),
    channel: resolveDesktopUpdateChannel(settings),
    runnerName: required(env, 'RUNNER_NAME'), target, preset, productVersion: product.version, version,
    testReleaseId: preset === 'test' ? (settings.DOWNLOAD_TEST_RELEASE_ID || null) : null,
    qualification,
  }
  const paths = desktopTargetBuildPaths(target)
  // The CLI's checkout owns these paths; alternate app roots are used by fixtures.
  const mode = qualification === 'unsigned' ? 'unsigned-artifacts' : qualification === 'unnotarized' ? 'unnotarized-artifacts' : 'artifacts'
  const artifacts = appRoot === resolve(import.meta.dirname, '..')
    ? join(paths.root, mode) : join(appRoot, '.desktop-build', 'targets', target, mode)
  const base = `deepseek-harness-${version}-${windows ? 'win-x64' : target}`
  const debugSuffix = qualification === 'unnotarized' ? '-unnotarized' : qualification === 'unsigned' ? '-unsigned' : ''
  const names = windows ? [`${base}${debugSuffix}.exe`] : [`${base}${debugSuffix}.dmg`, `${base}${debugSuffix}.zip`]
  if (qualification === 'signed' || qualification === 'notarized') {
    names.push(`${base}.${windows ? 'exe' : 'zip'}.blockmap`, desktopBuildRecordFilename(target), desktopUpdateMetadataFilename(version, platform, source.channel))
  }
  const retained = await retainDesktopRelease(desktopReleasesRoot(env), source, names.map(name => join(artifacts, name)))
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `directory=${retained}\nrunner=${runnerLabel}\nrunner-name=${source.runnerName}\nattempt=${source.attempt}\n`)
  const nextStep = desktopPublishQualificationError(qualification)
    ?? `Publish separately with package_run_id=${env.GITHUB_RUN_ID} and package_run_attempt=${env.GITHUB_RUN_ATTEMPT}`
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY,
    `\nRetained package: ${env.GITHUB_RUN_ID}/${env.GITHUB_RUN_ATTEMPT}\n\n${nextStep}\n`)
  return retained
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  if (process.argv[2] === '--check-runner' && process.argv.length === 3) resolveDesktopRetentionRunner(process.env)
  else if (process.argv.length === 2) await retainDesktopCi(process.env)
  else throw new Error('Usage: retain-desktop-ci.ts [--check-runner]')
}
