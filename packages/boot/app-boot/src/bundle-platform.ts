/** Host operating-system admission for optional bundle layers. */

const NODE_PLATFORMS: readonly string[] = Object.freeze([
  'aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd',
] satisfies NodeJS.Platform[])

/** A valid bundle declaration excludes the operating system running DSH. */
export class UnsupportedBundlePlatformError extends Error {
  /**
   * @param platforms Node platform names supported by the bundle.
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
 * @throws When the declaration is malformed or excludes the Host; omission allows every platform.
 */
export function assertBundlePlatform(platforms: unknown, platform: string): void {
  if (platforms === undefined) return
  if (!Array.isArray(platforms) || platforms.length === 0
    || !platforms.every((value): value is string => typeof value === 'string' && NODE_PLATFORMS.includes(value))) {
    throw new Error('dsh.bundle.platforms must be a nonempty list of Node platform names')
  }
  if (!platforms.includes(platform)) throw new UnsupportedBundlePlatformError(platforms, platform)
}
