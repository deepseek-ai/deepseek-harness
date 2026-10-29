/** Submit one production fixed-installer cache purge to EdgeOne. */
import type { teo } from 'tencentcloud-sdk-nodejs-teo'
import type { DesktopPackageTargetName } from './package-target.ts'
import { desktopLatestInstallerFilename, requiredEnvironmentValue, resolveDesktopAutoUpdateEnvironment, resolveDesktopUploadConfig } from './desktop-auto-update-environment.mjs'
import { desktopTargetPlatform } from './desktop-build-paths.mjs'

/** Validated production destination and credentials; never serialize this value. */
export interface DesktopPurgeConfig {
  readonly zoneId: string
  readonly publicUrl: string
  readonly secretId: string
  readonly secretKey: string
}

/** The single SDK operation needed to submit a purge. */
export type DesktopPurgeClient = Pick<InstanceType<typeof teo.v20220901.Client>, 'CreatePurgeTask'>

/**
 * Resolve production purge settings before uploading.
 * @param env Target dotenv settings, including any credential-launcher replacement.
 * @param target Fixed installer selected by the operator.
 * @param publicUrl Uploaded object URL; omitted derives the URL for a cache-only submission.
 * @returns Validated destination and credentials.
 */
export function resolveDesktopPurgeConfig(
  env: NodeJS.ProcessEnv, target: DesktopPackageTargetName, publicUrl?: string,
): DesktopPurgeConfig {
  if (resolveDesktopAutoUpdateEnvironment(env) !== 'production') throw new DesktopPurgeError('desktop purge: production is required')
  const { platform, arch } = desktopTargetPlatform(target)
  const update = resolveDesktopUploadConfig(env, platform, arch)
  const zoneId = requiredEnvironmentValue(env, 'DOWNLOAD_PROD_EO_ZONE_ID')
  if (!/^zone-[a-z0-9]+$/u.test(zoneId)) throw new DesktopPurgeError('desktop purge: DOWNLOAD_PROD_EO_ZONE_ID must name one EO zone')
  return {
    zoneId, publicUrl: publicUrl ?? `${update.origin}/desktop/${desktopLatestInstallerFilename(target)}`,
    secretId: requiredEnvironmentValue(env, update.secretIdEnvName), secretKey: requiredEnvironmentValue(env, update.secretKeyEnvName),
  }
}

/** A purge submission failure containing only safe CLI diagnostics. */
export class DesktopPurgeError extends Error {}

function safeField(value: unknown, config: DesktopPurgeConfig): string | undefined {
  if (typeof value !== 'string' || !/^[\w.-]{1,128}$/u.test(value)
    || value.includes(config.secretId) || value.includes(config.secretKey)) return undefined
  return value
}

/**
 * Submit once and report the accepted task ID, without querying cache completion.
 * @param config Validated production destination and credentials.
 * @param client Optional caller-owned SDK client; omitted lazily creates one with a 30-second request timeout.
 * @returns Resolves when EO accepts the submission; this does not confirm cache completion.
 * @throws DesktopPurgeError on rejection or an unconfirmed submission; never retries or changes uploaded bytes.
 */
export async function purgeDesktopInstaller(config: DesktopPurgeConfig, client?: DesktopPurgeClient): Promise<void> {
  let response: Awaited<ReturnType<DesktopPurgeClient['CreatePurgeTask']>>
  try {
    client ??= new (await import('tencentcloud-sdk-nodejs-teo')).teo.v20220901.Client({
      credential: { secretId: config.secretId, secretKey: config.secretKey }, region: '',
      profile: { httpProfile: { endpoint: 'teo.tencentcloudapi.com', reqTimeout: 30 } },
    })
    response = await client.CreatePurgeTask({ ZoneId: config.zoneId, Type: 'purge_url', Targets: [config.publicUrl] })
  } catch (error) {
    const code = safeField(typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined, config)
    throw new DesktopPurgeError(`desktop purge: submission not confirmed (${code ?? 'request failed'}); check EO task history and teo:CreatePurgeTask permission before submitting again.`)
  }
  if ((response.FailedList?.length ?? 0) > 0) {
    throw new DesktopPurgeError('desktop purge: EO rejected the URL; inspect EO before submitting again.')
  }
  const jobId = safeField(response.JobId, config)
  if (!jobId) throw new DesktopPurgeError('desktop purge: EO returned no task ID; check EO task history before submitting again.')
  process.stdout.write(`desktop purge: submitted ${config.publicUrl}; task ${jobId}. Cache completion is not checked.\n`)
}
