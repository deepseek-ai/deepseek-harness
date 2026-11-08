/** Host operating-system admission for optional bundle layers. */
import { isWsl, type HostEnvironmentFacts } from '@deepseek-ai/dsh-native-command'

const NODE_PLATFORMS: readonly string[] = Object.freeze([
  'aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd',
] satisfies NodeJS.Platform[])

/** A valid bundle declaration excludes the operating system running DSH. */
export class UnsupportedBundlePlatformError extends Error {
  /**
   * @param platforms Node platform names or `wsl` supported by the bundle.
   * @param platform Operating system of the DSH Host.
   */
  constructor(platforms: readonly string[], platform: string) {
    super(`Bundle supports Host platforms ${platforms.join(', ')}; the DSH Host is running ${platform}`)
    this.name = 'UnsupportedBundlePlatformError'
  }
}

/**
 * Validate package metadata and reject an unsupported Host before selecting or composing a bundle.
 * @param platforms The optional `dsh.bundle.platforms` field read from package.json.
 * @param platform Operating system of the DSH Host, from Node's `process.platform`.
 * @param facts Environment and kernel facts used to admit `wsl` on a Linux Host.
 * @throws When the declaration is malformed or excludes the Host; omission allows every platform.
 */
export function assertBundlePlatform(platforms: unknown, platform: string, facts: Omit<HostEnvironmentFacts, 'platform'> = {}): void {
  if (platforms === undefined) return
  if (!Array.isArray(platforms) || platforms.length === 0
    || !platforms.every((value): value is string => typeof value === 'string' && (value === 'wsl' || NODE_PLATFORMS.includes(value)))) {
    throw new Error('dsh.bundle.platforms must be a nonempty list of Node platform names or wsl')
  }
  if (!platforms.includes(platform) && !(platforms.includes('wsl') && isWsl({ ...facts, platform })))
    throw new UnsupportedBundlePlatformError(platforms, platform)
}
