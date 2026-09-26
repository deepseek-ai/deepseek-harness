/** Upload one validated Desktop release to its Tencent COS update directory. */

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { DesktopPackageTargetName } from './package-target.ts'
import { createDesktopCos } from './desktop-cos.ts'
import { resolveDesktopUploadConfig } from './desktop-auto-update-environment.mjs'
import { loadDesktopPackageEnvironment } from './desktop-package-environment.mjs'
import { createDesktopUploadPlan, type DesktopUploadPlan } from './desktop-upload-plan.ts'
import { desktopReleaseTag, tagDesktopRelease } from './desktop-release-tag.ts'
import { uploadDesktopRelease } from './desktop-upload-run.ts'

const SUPPORTED_TARGETS = new Set<DesktopPackageTargetName>(['mac-arm64', 'mac-x64', 'win-x64'])

function targetName(value: string): DesktopPackageTargetName {
  if (!SUPPORTED_TARGETS.has(value as DesktopPackageTargetName)) {
    throw new Error(`desktop upload: unsupported target ${JSON.stringify(value)}; expected ${[...SUPPORTED_TARGETS].join(', ')}`)
  }
  return value as DesktopPackageTargetName
}

function requiredEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim()
  if (value === undefined || value === '') {
    throw new Error(`desktop upload: ${name} must be set to a non-empty value`)
  }
  return value
}

/**
 * Use the credential launcher's selected deployment only when it matches the packaged release destination.
 * @param fileEnvironment Target dotenv settings that own the release destination.
 * @param injectedEnvironment Child environment containing the DPAPI-decrypted credential pair.
 * @param selected Deployment authorized by the launcher operator.
 * @param bucket Bucket authorized by the launcher operator.
 * @param target Packaged target being uploaded.
 * @returns Release settings with only the selected credential pair replaced.
 */
export function resolveCredentialUploadEnvironment(
  fileEnvironment: NodeJS.ProcessEnv, injectedEnvironment: NodeJS.ProcessEnv,
  selected: 'test' | 'production', bucket: string,
  target: DesktopPackageTargetName,
): NodeJS.ProcessEnv {
  const platform = target === 'win-x64' ? 'win32' : 'darwin'
  const arch = target === 'mac-arm64' ? 'arm64' : 'x64'
  const destination = resolveDesktopUploadConfig(fileEnvironment, platform, arch)
  if (destination.environment !== selected || destination.bucket !== bucket) {
    throw new Error('desktop upload: credential launcher deployment or bucket differs from the packaged release destination')
  }
  if (injectedEnvironment.DSH_DESKTOP_AUTO_UPDATE_ENV !== selected
    || injectedEnvironment[`${selected === 'test' ? 'DOWNLOAD_TEST' : 'DOWNLOAD_PROD'}_COS_BUCKET`] !== bucket) {
    throw new Error('desktop upload: credential launcher environment differs from its explicit arguments')
  }
  return {
    ...fileEnvironment,
    [destination.secretIdEnvName]: requiredEnvironmentValue(injectedEnvironment, destination.secretIdEnvName),
    [destination.secretKeyEnvName]: requiredEnvironmentValue(injectedEnvironment, destination.secretKeyEnvName),
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: {
    'credential-launcher': { type: 'boolean' }, environment: { type: 'string' }, bucket: { type: 'string' },
  } })
  const target = positionals[0]
  if (target === undefined || positionals.length !== 1) {
    throw new Error('desktop upload: expected exactly one target')
  }
  const name = targetName(target)
  const fileEnvironment = loadDesktopPackageEnvironment(name === 'win-x64' ? 'win32' : 'darwin')
  const launcher = values['credential-launcher'] === true
  if (launcher ? values.environment === undefined || values.bucket === undefined
    : values.environment !== undefined || values.bucket !== undefined) {
    throw new Error('desktop upload: credential launcher requires an explicit environment and bucket')
  }
  if (values.environment !== undefined && values.environment !== 'test' && values.environment !== 'production') {
    throw new Error('desktop upload: credential launcher environment must be test or production')
  }
  const environment = launcher
    ? resolveCredentialUploadEnvironment(fileEnvironment, process.env, values.environment as 'test' | 'production', values.bucket!, name)
    : fileEnvironment
  const plan = await createDesktopUploadPlan(name, { environment })
  const cos = createDesktopCos({
    secretId: requiredEnvironmentValue(environment, plan.secretIdEnvName),
    secretKey: requiredEnvironmentValue(environment, plan.secretKeyEnvName),
  })
  process.stdout.write(`desktop upload: ${plan.target} ${plan.version} -> ${plan.publicUrl}\n`)
  await uploadDesktopRelease(plan, cos, resolve(import.meta.dirname, '../.desktop-build/upload-records'))
  if (plan.environment === 'production') recordProductionRelease(plan)
}

/**
 * Tag the commit an external release was packaged from, after its artifacts are public.
 * @param plan Completed production upload.
 */
function recordProductionRelease(plan: DesktopUploadPlan): void {
  const tag = desktopReleaseTag(plan.version)
  if (plan.commit === undefined) {
    process.stdout.write(`desktop upload: this package was built before builds recorded their commit; tag it by hand as ${tag}\n`)
    return
  }
  if (plan.dirty === true) {
    // A tag would name a commit whose tree is not what the users received.
    process.stderr.write(`desktop upload: packaged from ${plan.commit} with uncommitted changes, so ${tag} was not created\n`)
    return
  }
  const result = tagDesktopRelease({ version: plan.version, commit: plan.commit, repositoryRoot: resolve(import.meta.dirname, '../../..') })
  if (result.status === 'failed') {
    process.stderr.write(`desktop upload: the release is published but ${result.tag} was not recorded: ${result.detail ?? 'unknown error'}\n`)
    if (result.recovery !== undefined) {
      process.stderr.write(`desktop upload: record it with: ${result.recovery.join(' && ')}\n`)
    }
    return
  }
  process.stdout.write(`desktop upload: ${result.tag} ${result.status === 'created' ? 'records' : 'already recorded'} ${plan.commit}\n`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  main().catch(() => {
    process.stderr.write('desktop upload: failed; inspect the printed record directory if allocated. No automatic retry; reconcile remote state before another upload.\n')
    process.exitCode = 1
  })
}
