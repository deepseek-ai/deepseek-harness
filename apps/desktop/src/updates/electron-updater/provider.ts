/** Generic-provider extension attaching source-identification headers only to feed metadata requests. */
import type { OutgoingHttpHeaders } from 'node:http'
import type { URL } from 'node:url'
import type { AppUpdater, UpdateCheckResult } from 'electron-updater'
import { GenericProvider } from 'electron-updater/out/providers/GenericProvider.js'
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider.js'
import type { DesktopUpdateChannel } from '../../update-channel.ts'
import type { DesktopUpdateConfigVersion } from '../../update-settings.ts'

/** Origin of the active update channel: locked default stable vs unlocked explicit user selection. */
export type DesktopChannelSource = 'default' | 'explicit'
/** Platform identifier sent on feed metadata requests, matching Platform client headers. */
export type DesktopFeedPlatform = 'desktop-mac' | 'desktop-win'
/** CPU architecture identifier sent on feed metadata requests. */
export type DesktopFeedArch = 'arm64' | 'x64'
/** Generic server options consumed by electron-updater's GenericProvider. */
export type GenericProviderConfiguration = ConstructorParameters<typeof GenericProvider>[0]

/** Runtime metadata sampled for each feed YAML request. */
export interface DesktopFeedMetadata {
  readonly configVersion: DesktopUpdateConfigVersion
  readonly channel: DesktopUpdateChannel
  readonly channelSource: DesktopChannelSource
  readonly clientVersion: string
  readonly bundledDshVersion: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
}

type DiskPublishConfiguration = GenericProviderConfiguration | { readonly provider?: string } | null

type DesktopProviderUpdater = {
  readonly app: { whenReady(): Promise<void> }
  clientPromise: Promise<GenericProvider> | null
  readonly configOnDisk: { readonly value: Promise<DiskPublishConfiguration> }
  readonly stagingUserIdPromise: { readonly value: Promise<string> }
  createProviderRuntimeOptions(): ProviderRuntimeOptions
  getUpdateInfoAndProvider(): Promise<{ info: unknown; provider: unknown }>
}

/**
 * Map a Node platform name to the Desktop feed wire identifier.
 * @param platform - Host OS identifier, defaulting to process.platform.
 * @returns Wire platform string for feed metadata headers.
 */
export function resolveDesktopFeedPlatform(platform: NodeJS.Platform = process.platform): DesktopFeedPlatform {
  if (platform === 'darwin') return 'desktop-mac'
  if (platform === 'win32') return 'desktop-win'
  throw new Error(`desktop update: unsupported feed platform ${platform}`)
}

/**
 * Validate a CPU architecture name for Desktop feed metadata headers.
 * @param arch - Host CPU architecture, defaulting to process.arch.
 * @returns Validated Desktop feed architecture.
 */
export function resolveDesktopFeedArch(arch: string = process.arch): DesktopFeedArch {
  if (arch === 'arm64' || arch === 'x64') return arch
  throw new Error(`desktop update: unsupported feed architecture ${arch}`)
}

/**
 * Build non-secret source-identification headers for feed YAML queries.
 * @param metadata - Current shell channel, config generation, version, and platform identity.
 * @param deviceId - Persistent staging UUID from `.updaterId`.
 * @returns Header map attached exclusively to `.yml` metadata requests.
 */
export function buildDesktopFeedHeaders(
  metadata: DesktopFeedMetadata,
  deviceId: string,
): Record<string, string> {
  return {
    'x-dsh-config-version': metadata.configVersion,
    'x-client-update-channel': metadata.channel,
    'x-client-channel-source': metadata.channelSource,
    'x-client-version': metadata.clientVersion,
    'x-client-bundled-dsh-version': metadata.bundledDshVersion,
    'x-client-platform': resolveDesktopFeedPlatform(metadata.platform),
    'x-client-arch': resolveDesktopFeedArch(metadata.arch),
    'x-client-device-id': deviceId,
  }
}

/** Sends source-identification headers on `.yml` requests while leaving binary downloads header-clean. */
export class DesktopUpdateProvider extends GenericProvider {
  /**
   * @param configuration - Generic feed URL and optional default channel from app-update.yml.
   * @param updater - Owning Electron AppUpdater instance.
   * @param runtimeOptions - Executor and range-request options from AppUpdater.
   * @param readMetadata - Samples current channel, unlock source, and config generation per check.
   * @param readDeviceId - Resolves the persistent `.updaterId` staging UUID.
   */
  constructor(
    configuration: GenericProviderConfiguration,
    updater: AppUpdater,
    runtimeOptions: ProviderRuntimeOptions,
    private readonly readMetadata: () => DesktopFeedMetadata,
    private readonly readDeviceId: () => Promise<string>,
  ) {
    super(configuration, updater, runtimeOptions)
  }

  protected override async httpRequest(
    url: URL,
    headers?: OutgoingHttpHeaders | null,
    cancellationToken?: UpdateCheckResult['cancellationToken'],
  ): Promise<string | null> {
    const deviceId = await this.readDeviceId()
    const feedHeaders = buildDesktopFeedHeaders(this.readMetadata(), deviceId)
    return super.httpRequest(url, { ...headers, ...feedHeaders }, cancellationToken)
  }
}

/**
 * Install DesktopUpdateProvider on an AppUpdater without reading app-update.yml until an active check runs.
 * @param updater - Target AppUpdater whose httpExecutor is already configured.
 * @param readMetadata - Samples current channel, unlock source, and config generation per check.
 */
export function installDesktopUpdateProvider(
  updater: AppUpdater,
  readMetadata: () => DesktopFeedMetadata,
): void {
  // electron-updater declares clientPromise and runtime option construction private on AppUpdater.
  const owner = updater as object as DesktopProviderUpdater
  const create = (configuration: DiskPublishConfiguration): DesktopUpdateProvider => {
    if (configuration === null || configuration.provider !== 'generic' || !('url' in configuration)) {
      throw new Error(`desktop update: expected generic provider, got ${String(configuration?.provider)}`)
    }
    return new DesktopUpdateProvider(
      configuration,
      updater,
      owner.createProviderRuntimeOptions(),
      readMetadata,
      () => owner.stagingUserIdPromise.value,
    )
  }
  const baseGetUpdateInfoAndProvider = owner.getUpdateInfoAndProvider.bind(owner)
  owner.getUpdateInfoAndProvider = async () => {
    await owner.app.whenReady()
    owner.clientPromise ??= owner.configOnDisk.value.then(create, (error: unknown) => {
      owner.clientPromise = null
      throw error
    })
    return baseGetUpdateInfoAndProvider()
  }
}
